// Fælles Telegram-fundament: typer, API-kald, transskription og små utils.
// Splittet ud af lib/telegram-webhook.ts (2026-07-06) da den rundede 2200 linjer.
// Ingen domænelogik her - kun det de andre telegram-*-moduler står på:
//   telegram-calendar.ts  (propose/edit/delete + matching)
//   telegram-activity.ts  (tids-tracking start/stop)
//   telegram-capture.ts   (capture-flowet + auto-aftale/-opgave)
//   telegram-recall.ts    (/ask + recall via second brain)
//   telegram-agent.ts     (tool-calling-routerens dispatch)
//   telegram-webhook.ts   (indgangen: veto/kommandoer + routing-cascade)
import 'server-only'

export const WHISPER_MODEL = 'whisper-1'

export type TelegramChat = {
  id: number
}

export type TelegramVoice = {
  file_id: string
}

export type TelegramMessage = {
  message_id: number
  date?: number // unix-sekunder; hvornår beskeden blev sendt (bruges som aktivitets-tidsstempel)
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

export type TelegramApiResponse<T> =
  | { ok: true; result: T }
  | { ok: false; error_code?: number; description?: string }

export type SentMessage = {
  message_id: number
}

type TelegramFile = {
  file_path: string
}

export type HandleResult = {
  status: 'processed' | 'ignored'
  reason?: string
}

// Robust udtræk af det FØRSTE komplette JSON-objekt fra et LLM-svar. Haiku
// pakker svaret i ```json-fences OG tilføjer nogle gange forklarende prosa EFTER
// objektet ("Begrundelse: ..."). Den gamle strip (replace(/```$/)) fjernede kun
// en fence i selve enden, så trailing prosa fik JSON.parse til at kaste -> kaldet
// faldt stille til fallback (fx "kan ikke finde event"). Her scanner vi
// balancerede tuborg-klammer (respekterer strenge) og parser kun objektet.
export function extractJsonObject<T = Record<string, unknown>>(raw: string | null | undefined): T | null {
  if (!raw) return null
  const text = raw.replace(/```(?:json)?/gi, '')
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
    } else if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as T
        } catch {
          return null
        }
      }
    }
  }
  return null
}

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Mangler ${name} i env`)
  return value
}

export async function tg<T>(method: string, body: Record<string, unknown>): Promise<TelegramApiResponse<T>> {
  const token = requireEnv('TELEGRAM_BOT_TOKEN')
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await r.json()
  return json as TelegramApiResponse<T>
}

export async function sendMessage(chatId: number, text: string): Promise<SentMessage> {
  const sent = await tg<SentMessage>('sendMessage', { chat_id: chatId, text })
  if (!sent.ok) {
    throw new Error(`Telegram sendMessage fejl: ${sent.description || sent.error_code || 'ukendt'}`)
  }
  return sent.result
}

export async function sendChatAction(chatId: number): Promise<void> {
  try {
    await tg('sendChatAction', { chat_id: chatId, action: 'typing' })
  } catch {
    // Ikke kritisk. Chat action er kun UX.
  }
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

export async function transcribeVoice(fileId: string): Promise<string> {
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

export function nowInCopenhagen(value: Date = new Date()): string {
  return new Intl.DateTimeFormat('da-DK', {
    timeZone: 'Europe/Copenhagen',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value)
}

// "HH:MM" i Europe/Copenhagen. Bruger kolon (ikke punktum) fordi det er
// formatet for tids-tracking-bekræftelser.
export function fmtTimeColonCph(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Copenhagen',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23', // h23 (ikke hour12:false) garanterer 00-23, aldrig "24:00" ved midnat
  }).formatToParts(date)
  const h = parts.find((p) => p.type === 'hour')?.value ?? '00'
  const m = parts.find((p) => p.type === 'minute')?.value ?? '00'
  return `${h}:${m}`
}
