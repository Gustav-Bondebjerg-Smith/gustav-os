// Fase 2: Telegram long-polling capture (tekst + voice).
// Henter beskeder sendt til botten, transskriberer voice, gemmer i raw_captures,
// klassificerer med Claude, og svarer tilbage.
// Kør løbende:  node scripts/telegram-poll.mjs
// Kør én runde: node scripts/telegram-poll.mjs --once
import './load-env.mjs'
import { createClient } from '@supabase/supabase-js'
import { classify, VALID_AREAS } from './classify.mjs'
import { transcribeAudio } from './transcribe.mjs'

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
const ALLOWED = process.env.TELEGRAM_CHAT_ID // valgfri lås: kun denne chat accepteres
const API = `https://api.telegram.org/bot${TOKEN}`
const ONCE = process.argv.includes('--once')

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

  // Kommandoer (fx /start) gemmes ikke
  if (msg.text && msg.text.startsWith('/')) {
    await tg('sendMessage', { chat_id: chatId, text: 'Hej Gustav. Send mig tekst eller en voicenote, så fanger jeg det i din second brain.' })
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
  try {
    const c = await classify(content)
    const area = VALID_AREAS.includes(c.area) ? c.area : null
    await supabase
      .from('raw_captures')
      .update({ area, classification: c, processed: true })
      .eq('id', data.id)
    console.log(`  klassificeret: area=${area} type=${c.type} - ${c.summary}`)
    reply = heard + `Fanget og gemt. (${area || 'ukategoriseret'}, ${c.type})`
  } catch (e) {
    console.error('  klassificering fejlede (ikke kritisk):', e.message)
  }
  await tg('sendMessage', { chat_id: chatId, text: reply })
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
