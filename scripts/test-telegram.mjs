// Simulér en INDKOMMENDE Telegram-besked til webhooken - så bot-flowet kan testes
// UDEN telefonen. POSTer en syntetisk Telegram-update med det rigtige secret +
// chat_id, præcis som Telegram selv ville.
//
// Brug:  node scripts/test-telegram.mjs "din besked" [local|prod]
//   fx:  node scripts/test-telegram.mjs "jeg skal nå at sende timeseddel" local
//   default target = local (http://localhost:3000)
//
// NB 1: Webhooken kører det tunge arbejde i after(), så svaret er {accepted:true}
//       med det samme. Selve handlingen (fx opret opgave) sker et øjeblik efter -
//       verificér resultatet i DB'en (Supabase) bagefter.
// NB 2: Bottens SVAR sendes til din rigtige Telegram-chat (side-effekt), fordi
//       webhooken kalder sendTelegramMessage til TELEGRAM_CHAT_ID. Det er forventet.
import './load-env.mjs'

const text = process.argv[2]
const target = (process.argv[3] || 'local').toLowerCase()
if (!text) {
  console.error('Brug: node scripts/test-telegram.mjs "besked" [local|prod]')
  process.exit(1)
}

const secret = process.env.TELEGRAM_WEBHOOK_SECRET
const chatId = Number(process.env.TELEGRAM_CHAT_ID)
if (!secret) {
  console.error('Mangler TELEGRAM_WEBHOOK_SECRET i .env.local')
  process.exit(1)
}
if (!Number.isFinite(chatId)) {
  console.error('Mangler/ugyldig TELEGRAM_CHAT_ID i .env.local')
  process.exit(1)
}

const base = target === 'prod' ? 'https://gustav-os.vercel.app' : 'http://localhost:3000'
const nowSec = Math.floor(Date.now() / 1000)
// Unikt id pr. kald -> undgår webhookens idempotens-dedup (telegram_updates).
const uid = Date.now()

const update = {
  update_id: uid,
  message: {
    message_id: uid % 1_000_000_000,
    date: nowSec,
    chat: { id: chatId, type: 'private', first_name: 'Gustav' },
    from: { id: chatId, is_bot: false, first_name: 'Gustav' },
    text,
  },
}

console.log(`-> POST ${base}/api/telegram`)
console.log(`   besked: "${text}"`)

let res
try {
  res = await fetch(`${base}/api/telegram`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secret,
    },
    body: JSON.stringify(update),
  })
} catch (e) {
  console.error(`Kunne ikke nå webhooken på ${base}. Kører dev-serveren? (${e instanceof Error ? e.message : e})`)
  process.exit(1)
}

const body = await res.text()
console.log(`<- HTTP ${res.status}: ${body}`)
if (!res.ok) process.exit(1)
console.log('OK - update accepteret. Handlingen kører nu i baggrunden; verificér i DB om et øjeblik.')
