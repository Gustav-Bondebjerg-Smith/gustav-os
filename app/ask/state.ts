// State-typer for /ask. Adskilt fra actions.ts fordi 'use server'-filer kun må
// eksportere async funktioner. Klient-komponenten importerer initialAskState
// herfra som almindelig værdi.
import type { Chunk } from '@/lib/ask-types'

export type AskState = {
  question: string
  answer: string
  sources: Chunk[]
  error: string | null
}

export const initialAskState: AskState = {
  question: '',
  answer: '',
  sources: [],
  error: null,
}
