import 'server-only'

type TelegramApiResponse<T> =
  | { ok: true; result: T }
  | { ok: false; error_code?: number; description?: string }

type SentMessage = {
  message_id: number
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Mangler ${name} i env`)
  return value
}

export async function sendTelegramMessage(
  text: string,
  chatId = requireEnv('TELEGRAM_CHAT_ID')
): Promise<SentMessage> {
  const token = requireEnv('TELEGRAM_BOT_TOKEN')
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  })
  const json = (await r.json()) as TelegramApiResponse<SentMessage>
  if (!json.ok) {
    throw new Error(`Telegram sendMessage fejl: ${json.description || json.error_code || 'ukendt'}`)
  }
  return json.result
}
