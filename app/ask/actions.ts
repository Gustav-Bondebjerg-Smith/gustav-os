// Server action for /ask. Kalder lib/ask.ts som er TS-port af scripts/ask.mjs.
// VIGTIGT: 'use server' i toppen betyder ALLE exports bliver server-funktioner.
// Derfor ligger AskState og initialAskState i en separat fil (./state.ts), så
// klient-komponenten kan importere dem som almindelig data uden serialisering.
'use server'

import { ask } from '@/lib/ask'
import type { AskState } from './state'

export async function askAction(_prev: AskState, formData: FormData): Promise<AskState> {
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
