// Admin for Telegram webhook.
// Brug:
//   node scripts/telegram-webhook.mjs get
//   node scripts/telegram-webhook.mjs set https://dit-domain.dk/api/telegram
//   node scripts/telegram-webhook.mjs delete
import './load-env.mjs'

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET
const API = `https://api.telegram.org/bot${TOKEN}`

if (!TOKEN) {
  console.error('Mangler TELEGRAM_BOT_TOKEN i .env.local')
  process.exit(1)
}

async function tg(method, body = {}) {
  const r = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await r.json()
  if (!j.ok) throw new Error(`${method} fejlede: ${JSON.stringify(j)}`)
  return j.result
}

const cmd = process.argv[2]
const url = process.argv[3]

if (cmd === 'get') {
  const info = await tg('getWebhookInfo')
  console.log(JSON.stringify(info, null, 2))
} else if (cmd === 'set') {
  if (!url) {
    console.error('Brug: node scripts/telegram-webhook.mjs set https://dit-domain.dk/api/telegram')
    process.exit(1)
  }
  if (!SECRET) {
    console.error('Mangler TELEGRAM_WEBHOOK_SECRET i .env.local')
    process.exit(1)
  }
  const result = await tg('setWebhook', {
    url,
    secret_token: SECRET,
    allowed_updates: ['message'],
    drop_pending_updates: false,
  })
  console.log(`Webhook sat: ${result}`)
} else if (cmd === 'delete') {
  const result = await tg('deleteWebhook', { drop_pending_updates: false })
  console.log(`Webhook slettet: ${result}`)
} else {
  console.log('Brug:')
  console.log('  node scripts/telegram-webhook.mjs get')
  console.log('  node scripts/telegram-webhook.mjs set https://dit-domain.dk/api/telegram')
  console.log('  node scripts/telegram-webhook.mjs delete')
  process.exit(1)
}
