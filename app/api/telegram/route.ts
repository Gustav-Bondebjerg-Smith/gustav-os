// Telegram webhook endpoint.
// Telegram sender secreten i X-Telegram-Bot-Api-Secret-Token når webhook'en
// er sat med secret_token. Alt tungt arbejde kører i after(), så Telegram får
// hurtigt 200 og ikke gensender samme update pga. timeout.
import { timingSafeEqual } from 'node:crypto'
import { after, type NextRequest } from 'next/server'
import {
  claimTelegramUpdate,
  handleTelegramUpdate,
  markTelegramUpdate,
  type TelegramUpdate,
} from '@/lib/telegram-webhook'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status })
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function verifyTelegramSecret(request: NextRequest): Response | null {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET?.trim()
  if (!expected) {
    return json({ ok: false, error: 'TELEGRAM_WEBHOOK_SECRET mangler i env' }, 500)
  }

  const actual = request.headers.get('x-telegram-bot-api-secret-token') || ''
  if (!actual || !safeEqual(actual, expected)) {
    return json({ ok: false, error: 'unauthorized' }, 401)
  }

  return null
}

export async function POST(request: NextRequest) {
  const secretError = verifyTelegramSecret(request)
  if (secretError) return secretError

  let update: TelegramUpdate
  try {
    update = (await request.json()) as TelegramUpdate
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400)
  }

  if (!update || !Number.isFinite(update.update_id)) {
    return json({ ok: false, error: 'missing_update_id' }, 400)
  }

  let claimed = false
  try {
    claimed = await claimTelegramUpdate(update)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return json({ ok: false, error: msg }, 500)
  }

  if (!claimed) {
    return json({ ok: true, duplicate: true })
  }

  after(async () => {
    try {
      const result = await handleTelegramUpdate(update)
      await markTelegramUpdate(update.update_id, result.status, { reason: result.reason })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('Telegram webhook fejlede:', msg)
      await markTelegramUpdate(update.update_id, 'failed', { error: msg }).catch((err) => {
        console.error('Kunne ikke markere Telegram update som failed:', err)
      })
    }
  })

  return json({ ok: true, accepted: true })
}
