import 'server-only'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { getSupabase } from './supabase'

function safeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a)
  const bBuffer = Buffer.from(b)
  if (aBuffer.length !== bBuffer.length) return false
  return timingSafeEqual(aBuffer, bBuffer)
}

export function validateCronRequest(request: Request): Response | null {
  const secret = process.env.CRON_SECRET?.trim()
  const authHeader = request.headers.get('authorization') || ''
  if (!secret) {
    return Response.json(
      { ok: false, error: 'CRON_SECRET mangler i env' },
      { status: 500 }
    )
  }
  if (!safeEqual(authHeader, `Bearer ${secret}`)) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

export async function withCronLock<T>(
  name: string,
  ttlSeconds: number,
  fn: () => Promise<T>
): Promise<{ locked: true; result: T } | { locked: false }> {
  const sb = getSupabase()
  const owner = randomUUID()
  const { data, error } = await sb.rpc('claim_cron_lock', {
    lock_name: name,
    ttl_seconds: ttlSeconds,
    lock_owner: owner,
  })

  if (error) throw new Error(`cron lock claim-fejl: ${error.message}`)
  if (!data) return { locked: false }

  try {
    return { locked: true, result: await fn() }
  } finally {
    const { error: releaseError } = await sb.rpc('release_cron_lock', {
      lock_name: name,
      lock_owner: owner,
    })
    if (releaseError) {
      console.error(`cron lock release-fejl (${name}):`, releaseError.message)
    }
  }
}
