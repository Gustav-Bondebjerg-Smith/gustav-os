// Fase 2: Telegram long-polling capture (tekst + voice).
// Henter beskeder sendt til botten, transskriberer voice, gemmer i raw_captures,
// klassificerer med Claude, og svarer tilbage.
// Kør løbende:  node scripts/telegram-poll.mjs
// Kør én runde: node scripts/telegram-poll.mjs --once
import './load-env.mjs'
import { createClient } from '@supabase/supabase-js'
import { classify, VALID_AREAS } from './classify.mjs'
import { transcribeAudio } from './transcribe.mjs'
import { proposeCalendarEvent, formatProposal } from './propose.mjs'
import { storeChunk } from './embed.mjs'
import { ask, formatSources } from './ask.mjs'

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
const ALLOWED = process.env.TELEGRAM_CHAT_ID // valgfri lås: kun denne chat accepteres
const API = `https://api.telegram.org/bot${TOKEN}`
const ONCE = process.argv.includes('--once')
// Veto-vindue. Default 10 min, men kan sættes lavere under test (fx VETO_MINUTES=1).
const VETO_MINUTES = Number(process.env.VETO_MINUTES) || 10

// Ord der tolkes som "veto" når de står ALENE i en besked (ellers er det normalt indhold).
const VETO_WORDS = new Set(['nej', 'veto', 'stop', 'annuller', 'annullér', 'cancel', 'skip', 'no'])
function isVetoMessage(text) {
  if (!text) return false
  const normalized = text.trim().toLowerCase().replace(/[.,!?]/g, '')
  return VETO_WORDS.has(normalized)
}

if (!TOKEN) { console.error('Mangler TELEGRAM_BOT_TOKEN i .env.local'); process.exit(1) }

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

async function tg(method, body) {
  const r = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return r.json()
}

// Find action der skal vetoes. Hvis besked er reply til en proposal-besked, match præcis. Ellers tag nyeste proposed inden for veto-deadline.
async function findVetoTarget(replyToMsgId) {
  const nowIso = new Date().toISOString()
  if (replyToMsgId) {
    const { data, error } = await supabase
      .from('actions')
      .select('id, payload, telegram_message_id')
      .eq('status', 'proposed')
      .eq('telegram_message_id', replyToMsgId)
      .limit(1)
    if (error) { console.error('findVetoTarget (reply) DB-fejl:', error.message); return null }
    if (data?.[0]) return data[0]
  }
  const { data, error } = await supabase
    .from('actions')
    .select('id, payload, telegram_message_id')
    .eq('status', 'proposed')
    .gte('veto_deadline', nowIso)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) { console.error('findVetoTarget DB-fejl:', error.message); return null }
  return data?.[0] || null
}

// Henter en voicenote fra Telegram og transskriberer den til tekst.
async function transcribeVoice(fileId) {
  const f = await tg('getFile', { file_id: fileId })
  if (!f.ok) throw new Error(`getFile fejlede: ${JSON.stringify(f)}`)
  const filePath = f.result.file_path // fx "voice/file_5.oga"
  const resp = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${filePath}`)
  if (!resp.ok) throw new Error(`Download fejlede: HTTP ${resp.status}`)
  const bytes = await resp.arrayBuffer()
  const name = filePath.split('/').pop() || 'voice.oga'
  return transcribeAudio(bytes, name)
}

async function handleMessage(msg) {
  const chatId = msg.chat.id

  // Lås til Gustav, hvis chat-id er sat
  if (ALLOWED && String(chatId) !== String(ALLOWED)) {
    console.log(`Ignorerer besked fra ukendt chat ${chatId}`)
    return
  }
  if (!ALLOWED) {
    console.log(`>> Din chat-id er ${chatId}. Sæt TELEGRAM_CHAT_ID=${chatId} i .env.local for at låse botten til dig.`)
  }

  // Veto: hvis beskeden er et enkelt veto-ord, ramt-trim "nej"/"stop"/... → vetoé nyeste proposed action.
  // Reply-to en specifik forslags-besked vetoer netop dén. Beskeden gemmes IKKE som capture.
  if (msg.text && isVetoMessage(msg.text)) {
    const target = await findVetoTarget(msg.reply_to_message?.message_id)
    if (!target) {
      await tg('sendMessage', { chat_id: chatId, text: 'Ingen forslag at vetoe lige nu.' })
      return
    }
    const { error: updErr } = await supabase
      .from('actions')
      .update({ status: 'vetoed', vetoed_at: new Date().toISOString() })
      .eq('id', target.id)
    if (updErr) { console.error('  veto-update fejl:', updErr.message) }
    await supabase.from('audit_log').insert({
      action: 'calendar_insert',
      payload: target.payload,
      status: 'vetoed',
      reason: `veto via Telegram: "${msg.text}"`,
    })
    await tg('sendMessage', { chat_id: chatId, text: `Vetoet: "${target.payload.summary}". Skrives ikke i kalenderen.` })
    console.log(`Vetoed action ${target.id}: ${target.payload.summary}`)
    return
  }

  // /ask <spørgsmål> -> semantisk søgning i second brain + Claude-svar med kilder.
  // Beskeden gemmes IKKE som capture (det er et query, ikke et input).
  if (msg.text && /^\/ask(\s|$)/i.test(msg.text)) {
    const question = msg.text.replace(/^\/ask\s*/i, '').trim()
    if (!question) {
      await tg('sendMessage', { chat_id: chatId, text: 'Brug: /ask <spørgsmål>. Fx: /ask hvad var jeg ved at glemme i går?' })
      return
    }
    await tg('sendChatAction', { chat_id: chatId, action: 'typing' })
    try {
      const { answer, sources } = await ask(question)
      const srcText = sources.length ? '\n\n' + formatSources(sources) : ''
      await tg('sendMessage', { chat_id: chatId, text: answer + srcText })
      console.log(`/ask: "${question}" -> ${sources.length} kilder`)
    } catch (e) {
      console.error('/ask fejlede:', e.message)
      await tg('sendMessage', { chat_id: chatId, text: `Kunne ikke svare lige nu: ${e.message}` })
    }
    return
  }

  // Kommandoer (fx /start) gemmes ikke
  if (msg.text && msg.text.startsWith('/')) {
    await tg('sendMessage', { chat_id: chatId, text: 'Hej Gustav. Send tekst eller voicenote til capture. Brug /ask <spørgsmål> til at spørge din second brain.' })
    return
  }

  // Find capture-indhold + kilde: tekst eller voice
  let content = null
  let source = null
  if (msg.text) {
    content = msg.text
    source = 'telegram_text'
  } else if (msg.voice) {
    try {
      await tg('sendChatAction', { chat_id: chatId, action: 'typing' })
      content = await transcribeVoice(msg.voice.file_id)
      source = 'telegram_voice'
    } catch (e) {
      console.error('Transskription fejlede:', e.message)
      await tg('sendMessage', { chat_id: chatId, text: 'Kunne ikke transskribere din voicenote. Prøv igen om lidt.' })
      return
    }
    if (!content) {
      await tg('sendMessage', { chat_id: chatId, text: 'Jeg fik ingen tekst ud af din voicenote. Prøv at tale lidt tydeligere.' })
      return
    }
  } else {
    await tg('sendMessage', { chat_id: chatId, text: 'Jeg kan tage tekst og voicenotes. Send en af delene.' })
    return
  }

  // Gem råindhold FØRST (capture er helligt)
  const { data, error } = await supabase
    .from('raw_captures')
    .insert({ source, content })
    .select('id')
    .single()

  if (error) {
    console.error('DB-fejl:', error.message)
    await tg('sendMessage', { chat_id: chatId, text: 'Kunne ikke gemme lige nu. Prøv igen om lidt.' })
    return
  }
  console.log(`Gemt raw_capture ${data.id} (${source}): "${content}"`)

  // Best-effort klassificering. Råindholdet er gemt ovenfor, så vi mister aldrig data hvis Claude fejler.
  const heard = source === 'telegram_voice' ? `Hørt: "${content}"\n` : ''
  let reply = heard + 'Fanget og gemt.'
  let classification = null
  let area = null
  try {
    classification = await classify(content)
    area = VALID_AREAS.includes(classification.area) ? classification.area : null
    await supabase
      .from('raw_captures')
      .update({ area, classification, processed: true })
      .eq('id', data.id)
    console.log(`  klassificeret: area=${area} type=${classification.type} - ${classification.summary}`)
    reply = heard + `Fanget og gemt. (${area || 'ukategoriseret'}, ${classification.type})`
  } catch (e) {
    console.error('  klassificering fejlede (ikke kritisk):', e.message)
  }

  // Auto-embed til memory_chunks. Best-effort: ved fejl logges og fortsættes - capture er stadig gemt.
  // Embeddes selv hvis klassificering fejlede, så indholdet er søgbart uanset.
  try {
    await storeChunk({
      content,
      source_type: 'raw_capture',
      source_id: data.id,
      area,
      metadata: {
        source,
        summary: classification?.summary || null,
        type: classification?.type || null,
      },
    })
    console.log('  embeddet til memory_chunks')
  } catch (e) {
    console.error('  embed fejlede (ikke kritisk):', e.message)
  }

  // Hvis det er en aftale, prøv at lave et kalender-forslag med veto-vindue.
  // Hvis forslag lykkes: erstat den almindelige bekræftelse med forslagsbeskeden.
  // Hvis ikke: send almindelig bekræftelse som før.
  let proposal = null
  if (classification?.type === 'aftale') {
    try {
      proposal = await proposeCalendarEvent(content)
    } catch (e) {
      console.error('  forslag fejlede (ikke kritisk):', e.message)
    }
  }

  if (proposal) {
    const proposalText = formatProposal(proposal, VETO_MINUTES)
    const sent = await tg('sendMessage', { chat_id: chatId, text: proposalText })
    if (sent.ok) {
      const deadline = new Date(Date.now() + VETO_MINUTES * 60 * 1000).toISOString()
      const { error: actErr } = await supabase.from('actions').insert({
        type: 'calendar_insert',
        payload: proposal,
        source_capture_id: data.id,
        telegram_message_id: sent.result.message_id,
        veto_deadline: deadline,
      })
      if (actErr) console.error('  forslag kunne ikke gemmes som action:', actErr.message)
      else console.log(`  forslag oprettet: ${proposal.summary} (veto til ${deadline})`)
    } else {
      console.error('  proposal-besked kunne ikke sendes:', JSON.stringify(sent))
      // Hvis Telegram-send fejlede, så send i det mindste den almindelige bekræftelse
      await tg('sendMessage', { chat_id: chatId, text: reply })
    }
  } else {
    await tg('sendMessage', { chat_id: chatId, text: reply })
  }
}

async function poll() {
  let offset = 0
  console.log(ONCE ? 'Henter ventende beskeder (én runde)...' : 'Lytter efter beskeder. Stop med Ctrl+C.')
  while (true) {
    const res = await tg('getUpdates', { offset, timeout: ONCE ? 0 : 25 })
    if (!res.ok) { console.error('getUpdates fejlede:', JSON.stringify(res)); break }
    for (const u of res.result) {
      offset = u.update_id + 1
      if (u.message) await handleMessage(u.message)
    }
    if (ONCE) {
      if (offset > 0) await tg('getUpdates', { offset, timeout: 0 }) // bekræft så de ikke gentages
      console.log(`Behandlede ${res.result.length} update(s).`)
      break
    }
  }
}

poll().catch(e => { console.error(e); process.exit(1) })
