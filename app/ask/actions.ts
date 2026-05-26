// Server action for /ask. Kalder lib/ask.ts som er TS-port af scripts/ask.mjs.
// VIGTIGT: 'use server' i toppen betyder ALLE exports bliver server-funktioner.
// Derfor ligger AskState og initialAskState i en separat fil (./state.ts), så
// klient-komponenten kan importere dem som almindelig data uden serialisering.
//
// AUTH: Next.js docs advarer om at proxy-matcher kan misse server actions
// hvis en route refaktoreres. Vi verificerer derfor session HER også, ikke
// kun i proxy.ts. Belt and suspenders.
'use server'

import { ask } from '@/lib/ask'
import { getServerSupabase } from '@/lib/supabase-server'
import type { AskState } from './state'

export async function askAction(_prev: AskState, formData: FormData): Promise<AskState> {
  // Guard: kun logget-ind whitelist-email må spørge.
  const sb = await getServerSupabase()
  const { data: { user } } = await sb.auth.getUser()
  const allowed = process.env.ALLOWED_EMAIL?.trim().toLowerCase()
  if (!user || !allowed || user.email?.trim().toLowerCase() !== allowed) {
    return { question: '', answer: '', sources: [], error: 'Ikke logget ind.' }
  }

  const question = (formData.get('question')?.toString() || '').trim()
  if (!question) {
    return { question: '', answer: '', sources: [], error: 'Skriv et spørgsmål.' }
  }
  try {
    const { answer, sources } = await ask(question)
    return { question, answer, sources, error: null }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { question, answer: '', sources: [], error: msg }
  }
}
