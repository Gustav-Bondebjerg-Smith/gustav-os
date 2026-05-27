// Server-only Telegram webhook flow.
// Spejler scripts/telegram-poll.mjs, men uden load-env.mjs så det virker på Vercel.
import 'server-only'
import { getSupabase } from './supabase'
import { ask } from './ask'
import { fmtDate, fmtRange, fmtDay } from './format'
import type { Chunk } from './ask-types'
import { storeChunk } from './memory'
import { getEvents, type GoogleCalendarEvent } from './calendar'

const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001'
const PROPOSAL_MODEL = 'claude-haiku-4-5-20251001'
const WHISPER_MODEL = 'whisper-1'
const VALID_AREAS = ['personlig', 'studie', 'arbejde'] as const
const VETO_WORDS = new Set(['nej', 'veto', 'stop', 'annuller', 'annullér', 'cancel', 'skip', 'no'])

type TelegramChat = {
  id: number
}

type TelegramVoice = {
  file_id: string
}

type TelegramMessage = {
  message_id: number
  chat: TelegramChat
  text?: string
  voice?: TelegramVoice
  reply_to_message?: {
    message_id: number
  }
}

export type TelegramUpdate = {
  update_id: number
  message?: TelegramMessage
}

type TelegramApiResponse<T> =
  | { ok: true; result: T }
  | { ok: false; error_code?: number; description?: string }

type SentMessage = {
  message_id: number
}

type TelegramFile = {
  file_path: string
}

type Classification = {
  area?: string
  type?: string
  summary?: string
}

type CalendarProposal = {
  summary: string
  start: string
  end: string
  location?: string
}

type CalendarDeletion = {
  event_id: string
  summary: string
  start: string
  end: string
  location?: string
}

// Slet-intent regex: matcher hele ord, ikke substrings, for at undgå false positives
// ("aftal" i "aftale" matcher fx ikke). Bruger word boundaries.
const DELETE_INTENT = /\b(slet|fjern|aflys|aflyse|aflyst|cancel|drop)\b/i

function hasDeleteIntent(text: string | null | undefined): boolean {
  if (!text) return false
  return DELETE_INTENT.test(text)
}

type HandleResult = {
  status: 'processed' | 'ignored'
  reason?: string
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Mangler ${name} i env`)
  return value
}

function isVetoMessage(text: string | undefined): boolean {
  if (!text) return false
  const normalized = text.trim().toLowerCase().replace(/[.,!?]/g, '')
  return VETO_WORDS.has(normalized)
}

async function tg<T>(method: string, body: Record<string, unknown>): Promise<TelegramApiResponse<T>> {
  const token = requireEnv('TELEGRAM_BOT_TOKEN')
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await r.json()
  return json as TelegramApiResponse<T>
}

async function sendMessage(chatId: number, text: string): Promise<SentMessage> {
  const sent = await tg<SentMessage>('sendMessage', { chat_id: chatId, text })
  if (!sent.ok) {
    throw new Error(`Telegram sendMessage fejl: ${sent.description || sent.error_code || 'ukendt'}`)
  }
  return sent.result
}

async function sendChatAction(chatId: number): Promise<void> {
  try {
    await tg('sendChatAction', { chat_id: chatId, action: 'typing' })
  } catch {
    // Ikke kritisk. Chat action er kun UX.
  }
}

export async function claimTelegramUpdate(update: TelegramUpdate): Promise<boolean> {
  const sb = getSupabase()
  const msg = update.message
  const { error } = await sb.from('telegram_updates').insert({
    update_id: update.update_id,
    status: 'processing',
    chat_id: msg?.chat.id ?? null,
    message_id: msg?.message_id ?? null,
  })

  if (!error) return true
  if (error.code === '23505') return false
  throw new Error(`telegram_updates insert-fejl: ${error.message}`)
}

export async function markTelegramUpdate(
  updateId: number,
  status: 'processed' | 'ignored' | 'failed',
  details: { reason?: string; error?: string } = {}
): Promise<void> {
  const sb = getSupabase()
  const { error } = await sb
    .from('telegram_updates')
    .update({
      status,
      reason: details.reason ?? null,
      error: details.error ?? null,
      processed_at: new Date().toISOString(),
    })
    .eq('update_id', updateId)

  if (error) throw new Error(`telegram_updates update-fejl: ${error.message}`)
}

async function findVetoTarget(replyToMsgId?: number) {
  const sb = getSupabase()
  const nowIso = new Date().toISOString()

  if (replyToMsgId) {
    const { data, error } = await sb
      .from('actions')
      .select('id, type, payload, telegram_message_id')
      .eq('status', 'proposed')
      .eq('telegram_message_id', replyToMsgId)
      .limit(1)
    if (error) throw new Error(`findVetoTarget reply-fejl: ${error.message}`)
    if (data?.[0]) return data[0]
  }

  const { data, error } = await sb
    .from('actions')
    .select('id, type, payload, telegram_message_id')
    .eq('status', 'proposed')
    .gte('veto_deadline', nowIso)
    .order('created_at', { ascending: false })
    .limit(1)

  if (error) throw new Error(`findVetoTarget DB-fejl: ${error.message}`)
  return data?.[0] || null
}

async function transcribeAudio(bytes: ArrayBuffer, filename = 'voice.oga'): Promise<string> {
  const key = requireEnv('OPENAI_API_KEY')
  const form = new FormData()
  form.append('file', new Blob([bytes]), filename)
  form.append('model', WHISPER_MODEL)
  form.append('language', 'da')

  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  })
  if (!r.ok) throw new Error(`Whisper HTTP ${r.status}: ${await r.text()}`)

  const j = await r.json()
  return (j.text || '').trim()
}

async function transcribeVoice(fileId: string): Promise<string> {
  const token = requireEnv('TELEGRAM_BOT_TOKEN')
  const file = await tg<TelegramFile>('getFile', { file_id: fileId })
  if (!file.ok) {
    throw new Error(`getFile fejlede: ${file.description || file.error_code || 'ukendt'}`)
  }

  const filePath = file.result.file_path
  const resp = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`)
  if (!resp.ok) throw new Error(`Download fejlede: HTTP ${resp.status}`)

  const bytes = await resp.arrayBuffer()
  const name = filePath.split('/').pop() || 'voice.oga'
  return transcribeAudio(bytes, name)
}

async function classify(text: string): Promise<Classification> {
  const system = [
    'Du klassificerer korte beskeder til Gustavs personlige second brain.',
    'Svar KUN med JSON, intet andet, på formen:',
    '{"area":"...","type":"...","summary":"..."}',
    '- area: præcis en af "personlig", "studie", "arbejde".',
    '- type: præcis en af "opgave", "note", "ide", "aftale".',
    '- summary: kort dansk resume, max 8 ord.',
    'Kontekst: Gustav er medicinstuderende (SDU), sygeplejevikar og forskningsassistent.',
    '"studie" = medicinstudiet. "arbejde" = vagter og forskning. "personlig" = alt andet (familie, venner, sundhed, fritid).',
  ].join('\n')

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': requireEnv('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLASSIFIER_MODEL,
      max_tokens: 200,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: text }],
    }),
  })
  if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}: ${await r.text()}`)

  const j = await r.json()
  const raw = (j.content?.[0]?.text || '').trim()
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  return JSON.parse(cleaned) as Classification
}

function nowInCopenhagen(): string {
  return new Intl.DateTimeFormat('da-DK', {
    timeZone: 'Europe/Copenhagen',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date())
}

async function proposeCalendarEvent(captureContent: string): Promise<CalendarProposal | null> {
  if (!captureContent || captureContent.trim().length < 3) return null

  const system = [
    'Du udleder en konkret kalender-aftale fra en kort dansk besked.',
    `Lige nu i København (Europe/Copenhagen): ${nowInCopenhagen()}.`,
    '',
    'Svar KUN med JSON, intet andet. To mulige svar:',
    '',
    'Hvis beskeden indeholder en KONKRET aftale med specifik tid:',
    '{"propose": true, "summary": "...", "start": "YYYY-MM-DDTHH:MM:00", "end": "YYYY-MM-DDTHH:MM:00", "location": "..."}',
    '',
    'Hvis IKKE (vag tid, blot en tanke, ingen tid, fortidig hændelse osv.):',
    '{"propose": false, "reason": "kort dansk forklaring"}',
    '',
    'Regler:',
    '- start/end er NAIVE datetime uden timezone-offset (kalenderen sætter Europe/Copenhagen).',
    '- summary: kort dansk titel, max 6 ord, første bogstav stort.',
    '- Hvis kun starttid og ingen sluttid: sæt end = start + 1 time.',
    '- "fredag" uden uge = den FØRSTKOMMENDE fredag fra nu.',
    '- "i morgen" = dagen efter dagens dato i København.',
    '- Hvis tiden er vag ("snart", "engang", "i næste uge" uden dag), eller hvis det er en ren tanke/note -> propose: false.',
    '- Hvis tiden allerede er passeret (fortidig) -> propose: false.',
    '- location: kun hvis den er nævnt eksplicit i beskeden. Ellers udelad feltet.',
  ].join('\n')

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': requireEnv('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: PROPOSAL_MODEL,
      max_tokens: 300,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: captureContent }],
    }),
  })
  if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}: ${await r.text()}`)

  const j = await r.json()
  const raw = (j.content?.[0]?.text || '').trim()
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  let parsed: {
    propose?: boolean
    summary?: string
    start?: string
    end?: string
    location?: string
  }

  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return null
  }

  if (!parsed.propose || !parsed.summary || !parsed.start || !parsed.end) return null
  return {
    summary: parsed.summary,
    start: parsed.start,
    end: parsed.end,
    ...(parsed.location ? { location: parsed.location } : {}),
  }
}

// Henter alle events i et vindue fra nu og N dage frem, returnerer en
// kompakt liste Haiku kan ræsonnere over for match-finding.
async function loadCandidateEvents(daysAhead: number): Promise<GoogleCalendarEvent[]> {
  const now = new Date()
  const to = new Date(now.getTime() + daysAhead * 24 * 3600 * 1000)
  const events = await getEvents(now, to)
  // Filtrér events uden id (kan ikke slettes alligevel).
  return events.filter((e): e is GoogleCalendarEvent & { id: string } => !!e.id)
}

// Lader Haiku finde et matchende kalender-event ud fra slet-beskeden.
// Returnerer fuld payload til en calendar_delete action, eller null hvis
// ingen entydig match findes.
async function proposeCalendarDelete(
  captureContent: string
): Promise<CalendarDeletion | null> {
  if (!captureContent || captureContent.trim().length < 3) return null

  // 14 dage frem dækker realistisk slet-scope. Hvis du vil slette noget
  // længere ude, må du nævne datoen i beskeden så Haiku kan løfte vinduet.
  let candidates: GoogleCalendarEvent[]
  try {
    candidates = await loadCandidateEvents(14)
  } catch (e) {
    console.error('Kunne ikke hente kalender-events til delete-forslag:', e)
    return null
  }
  if (candidates.length === 0) return null

  const list = candidates.slice(0, 50).map((ev, i) => ({
    idx: i,
    id: ev.id,
    summary: ev.summary || '(uden titel)',
    start: ev.start?.dateTime || ev.start?.date,
    end: ev.end?.dateTime || ev.end?.date,
    location: ev.location,
  }))

  const system = [
    'Du finder det ene kalender-event der matcher en kort dansk slet-besked.',
    `Lige nu i København: ${nowInCopenhagen()}.`,
    '',
    'Du får en JSON-liste af events. Vælg det BEDSTE match baseret på titel, tid og sted.',
    'Hvis intet event matcher tydeligt (ambiguitet, ingen overlap, vag besked): returner null.',
    '',
    'Svar KUN med JSON:',
    '{"idx": <tal fra listen>} hvis match findes',
    '{"idx": null, "reason": "kort dansk forklaring"} ellers',
    '',
    'Regler:',
    '- Match er stærkest hvis både titel OG tid stemmer overens med beskeden.',
    '- Kun titel-match (uden tid) er OK hvis kun ét event har den titel.',
    '- Hvis to events matcher lige godt, vælg det tætteste i tid.',
    '- "kl 19" matcher events der starter på XX:00 (typisk 19:00, ikke 18:30).',
  ].join('\n')

  const userPayload = JSON.stringify({
    besked: captureContent,
    events: list.map((e) => ({
      idx: e.idx,
      summary: e.summary,
      start: e.start,
      end: e.end,
      location: e.location ?? null,
    })),
  })

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': requireEnv('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: PROPOSAL_MODEL,
      max_tokens: 200,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: userPayload }],
    }),
  })
  if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}: ${await r.text()}`)

  const j = await r.json()
  const raw = (j.content?.[0]?.text || '').trim()
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  let parsed: { idx?: number | null }
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return null
  }
  if (parsed.idx === null || parsed.idx === undefined) return null
  const chosen = list[parsed.idx]
  if (!chosen || !chosen.id || !chosen.start || !chosen.end) return null

  return {
    event_id: chosen.id,
    summary: chosen.summary,
    start: chosen.start,
    end: chosen.end,
    ...(chosen.location ? { location: chosen.location } : {}),
  }
}

function formatProposal(p: CalendarProposal, vetoMinutes = 10): string {
  // p.start/end er naive CPH-strenge fra Haiku ("2026-05-29T14:00:00").
  // Suffix med korrekt offset for at få fmtRange/fmtDay til at vise CPH-tid
  // korrekt selv på Vercel (UTC).
  const sIso = withCphOffset(p.start)
  const eIso = withCphOffset(p.end)
  const day = fmtDay(sIso)
  const range = fmtRange(sIso, eIso)
  const loc = p.location ? `\nSted: ${p.location}` : ''
  return [
    `Forslag: ${p.summary}`,
    `Tid: ${day} kl. ${range}${loc}`,
    '',
    `Skriv "nej" inden ${vetoMinutes} min for at vetoe. Ellers skriver jeg den i kalenderen.`,
  ].join('\n')
}

// Slet-forslag. p.start/end kommer fra Google (absolute ISO med offset),
// så vi kan bruge fmtRange direkte uden offset-suffix.
function formatDeletion(p: CalendarDeletion, vetoMinutes = 10): string {
  const day = fmtDay(p.start)
  const range = fmtRange(p.start, p.end)
  const loc = p.location ? `\nSted: ${p.location}` : ''
  return [
    `Slet: ${p.summary}`,
    `Tid: ${day} kl. ${range}${loc}`,
    '',
    `Skriv "nej" inden ${vetoMinutes} min for at vetoe. Ellers slettes den fra kalenderen.`,
  ].join('\n')
}

// Vedhæfter Europe/Copenhagen-offset til en naive datetime-streng som
// "2026-05-29T14:00:00", så new Date() fortolker den korrekt på Vercel (UTC).
// Bruger Intl til at finde aktuel offset (1 om vinteren, 2 om sommeren).
function withCphOffset(naive: string): string {
  if (/[+-]\d\d:?\d\d$/.test(naive) || naive.endsWith('Z')) return naive
  // Find offset på den dato strengen beskriver.
  const datePart = naive.slice(0, 10) // "YYYY-MM-DD"
  const noonUtcMs = Date.UTC(
    Number(datePart.slice(0, 4)),
    Number(datePart.slice(5, 7)) - 1,
    Number(datePart.slice(8, 10)),
    12, 0, 0
  )
  const cphHour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Copenhagen',
      hour: 'numeric',
      hour12: false,
    }).format(new Date(noonUtcMs))
  )
  const offsetHours = cphHour - 12
  const sign = offsetHours >= 0 ? '+' : '-'
  const hh = String(Math.abs(offsetHours)).padStart(2, '0')
  return `${naive}${sign}${hh}:00`
}

function formatSources(sources: Chunk[]): string {
  if (!sources.length) return ''
  const lines = sources.map((c, i) => {
    const sim = c.similarity.toFixed(2)
    const preview = c.content.length > 80 ? c.content.slice(0, 80) + '...' : c.content
    return `[${i + 1}] ${fmtDate(c.created_at)} (sim=${sim}): ${preview}`
  })
  return 'Kilder:\n' + lines.join('\n')
}

async function handleVeto(msg: TelegramMessage): Promise<HandleResult> {
  const sb = getSupabase()
  const target = await findVetoTarget(msg.reply_to_message?.message_id)
  if (!target) {
    await sendMessage(msg.chat.id, 'Ingen forslag at vetoe lige nu.')
    return { status: 'processed', reason: 'veto_without_target' }
  }

  const { error: updErr } = await sb
    .from('actions')
    .update({ status: 'vetoed', vetoed_at: new Date().toISOString() })
    .eq('id', target.id)
  if (updErr) throw new Error(`veto-update fejl: ${updErr.message}`)

  await sb.from('audit_log').insert({
    action: target.type || 'calendar_insert',
    payload: target.payload,
    status: 'vetoed',
    reason: `veto via Telegram: "${msg.text}"`,
  })

  const summary = target.payload?.summary || 'forslag'
  const verb = target.type === 'calendar_delete' ? 'Slettes ikke fra' : 'Skrives ikke i'
  await sendMessage(msg.chat.id, `Vetoet: "${summary}". ${verb} kalenderen.`)
  return { status: 'processed', reason: 'vetoed_action' }
}

async function handleAsk(msg: TelegramMessage): Promise<HandleResult> {
  const question = (msg.text || '').replace(/^\/ask\s*/i, '').trim()
  if (!question) {
    await sendMessage(
      msg.chat.id,
      'Brug: /ask <spørgsmål>. Fx: /ask hvad var jeg ved at glemme i går?'
    )
    return { status: 'processed', reason: 'empty_ask' }
  }

  await sendChatAction(msg.chat.id)
  try {
    const { answer, sources } = await ask(question)
    const srcText = sources.length ? '\n\n' + formatSources(sources) : ''
    await sendMessage(msg.chat.id, answer + srcText)
    return { status: 'processed', reason: 'ask_answered' }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    await sendMessage(msg.chat.id, `Kunne ikke svare lige nu: ${error}`)
    return { status: 'processed', reason: 'ask_failed' }
  }
}

async function handleCapture(msg: TelegramMessage): Promise<HandleResult> {
  const sb = getSupabase()

  let content: string | null = null
  let source: 'telegram_text' | 'telegram_voice' | null = null

  if (msg.text) {
    content = msg.text
    source = 'telegram_text'
  } else if (msg.voice) {
    await sendChatAction(msg.chat.id)
    try {
      content = await transcribeVoice(msg.voice.file_id)
    } catch (e) {
      console.error('Transskription fejlede:', e)
      await sendMessage(msg.chat.id, 'Kunne ikke transskribere din voicenote. Prøv igen om lidt.')
      return { status: 'processed', reason: 'voice_transcription_failed' }
    }
    source = 'telegram_voice'
    if (!content) {
      await sendMessage(msg.chat.id, 'Jeg fik ingen tekst ud af din voicenote. Prøv at tale lidt tydeligere.')
      return { status: 'processed', reason: 'empty_voice_transcript' }
    }
  } else {
    await sendMessage(msg.chat.id, 'Jeg kan tage tekst og voicenotes. Send en af delene.')
    return { status: 'processed', reason: 'unsupported_message' }
  }

  const { data, error } = await sb
    .from('raw_captures')
    .insert({ source, content })
    .select('id')
    .single()

  if (error) throw new Error(`raw_captures insert-fejl: ${error.message}`)

  const captureId = String(data.id)
  const heard = source === 'telegram_voice' ? `Hørt: "${content}"\n` : ''
  let reply = heard + 'Fanget og gemt.'
  let classification: Classification | null = null
  let area: string | null = null

  try {
    classification = await classify(content)
    area = VALID_AREAS.includes(classification.area as (typeof VALID_AREAS)[number])
      ? classification.area || null
      : null
    await sb
      .from('raw_captures')
      .update({ area, classification, processed: true })
      .eq('id', captureId)
    reply = heard + `Fanget og gemt. (${area || 'ukategoriseret'}, ${classification.type})`
  } catch (e) {
    console.error('klassificering fejlede (ikke kritisk):', e)
  }

  try {
    await storeChunk({
      content,
      source_type: 'raw_capture',
      source_id: captureId,
      area,
      metadata: {
        source,
        summary: classification?.summary || null,
        type: classification?.type || null,
      },
    })
  } catch (e) {
    console.error('embed fejlede (ikke kritisk):', e)
  }

  // To grene: slet-intent (fjerner en eksisterende aftale) eller aftale-intent
  // (opretter en ny). Slet-intent har forrang, fordi en besked som "slet
  // aftalen med skat" ofte klassificeres som aftale.
  const vetoMinutes = Number(process.env.VETO_MINUTES) || 10
  const deadlineIso = new Date(Date.now() + vetoMinutes * 60 * 1000).toISOString()

  if (hasDeleteIntent(content)) {
    let deletion: CalendarDeletion | null = null
    try {
      deletion = await proposeCalendarDelete(content)
    } catch (e) {
      console.error('delete-forslag fejlede (ikke kritisk):', e)
    }
    if (deletion) {
      try {
        const sent = await sendMessage(msg.chat.id, formatDeletion(deletion, vetoMinutes))
        const { error: actErr } = await sb.from('actions').insert({
          type: 'calendar_delete',
          payload: deletion,
          source_capture_id: captureId,
          telegram_message_id: sent.message_id,
          veto_deadline: deadlineIso,
        })
        if (actErr) console.error('delete-forslag kunne ikke gemmes som action:', actErr.message)
      } catch (e) {
        console.error('delete-proposal-besked kunne ikke sendes:', e)
        await sendMessage(msg.chat.id, reply)
      }
      return { status: 'processed', reason: 'capture_saved_with_delete' }
    }
    // Kunne ikke finde matchende event - sig det åbent så Gustav ved hvorfor
    // intet forslag dukker op (uden delete-grenen ville beskeden bare blive
    // gemt som ordinær capture og virke død).
    await sendMessage(
      msg.chat.id,
      reply + '\n\nKunne ikke finde en aftale der matcher beskeden. Tjek titel/tid.'
    )
    return { status: 'processed', reason: 'capture_saved_no_delete_match' }
  }

  let proposal: CalendarProposal | null = null
  if (classification?.type === 'aftale') {
    try {
      proposal = await proposeCalendarEvent(content)
    } catch (e) {
      console.error('forslag fejlede (ikke kritisk):', e)
    }
  }

  if (proposal) {
    try {
      const sent = await sendMessage(msg.chat.id, formatProposal(proposal, vetoMinutes))
      const { error: actErr } = await sb.from('actions').insert({
        type: 'calendar_insert',
        payload: proposal,
        source_capture_id: captureId,
        telegram_message_id: sent.message_id,
        veto_deadline: deadlineIso,
      })
      if (actErr) console.error('forslag kunne ikke gemmes som action:', actErr.message)
    } catch (e) {
      console.error('proposal-besked kunne ikke sendes:', e)
      await sendMessage(msg.chat.id, reply)
    }
  } else {
    await sendMessage(msg.chat.id, reply)
  }

  return { status: 'processed', reason: 'capture_saved' }
}

export async function handleTelegramUpdate(update: TelegramUpdate): Promise<HandleResult> {
  const msg = update.message
  if (!msg) return { status: 'ignored', reason: 'no_message' }

  const allowedChat = requireEnv('TELEGRAM_CHAT_ID')
  if (String(msg.chat.id) !== String(allowedChat)) {
    console.warn(`Ignorerer Telegram-besked fra ukendt chat ${msg.chat.id}`)
    return { status: 'ignored', reason: 'unknown_chat' }
  }

  if (msg.text && isVetoMessage(msg.text)) return handleVeto(msg)
  if (msg.text && /^\/ask(\s|$)/i.test(msg.text)) return handleAsk(msg)
  if (msg.text && msg.text.startsWith('/')) {
    await sendMessage(
      msg.chat.id,
      'Hej Gustav. Send tekst eller voicenote til capture. Brug /ask <spørgsmål> til at spørge din second brain.'
    )
    return { status: 'processed', reason: 'command_help' }
  }

  return handleCapture(msg)
}
