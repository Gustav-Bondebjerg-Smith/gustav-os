// Lærende fakta-lag for routeren - tynd, typet facade over lib/memory-facts-core.mjs.
//
// Al logik (queries, upsert-nøgle, threshold-regel, prompt-formatering) ligger i
// kernen, som OGSÅ bruges af scripts/memory-facts-core.mjs (CLI + MCP-server).
// Rettelser laves ét sted. Denne fil binder kun Next.js-afhængighederne
// (getSupabase + embedText) og tilføjer TypeScript-typerne.
//
// Små, atomare fakta/præferencer som routeren selv skriver i runtime (save_memory)
// og som loades ind i dens system-prompt. Adskilt fra memory_sources/memory_chunks
// (dokument-RAG): én række = ét faktum, overskrevet på (scope, key). Se migration
// 0010_memory_facts.sql. Genbruger embedText (samme model/dim som scripts/embed.mjs).
import 'server-only'
import { getSupabase } from './supabase'
import { embedText } from './memory'
import {
  FACTS_TOKEN_THRESHOLD as CORE_FACTS_TOKEN_THRESHOLD,
  deleteMemoryCore,
  formatGlobalForPrompt as coreFormatGlobalForPrompt,
  recallForScopeCore,
  recallProjectCore,
  saveMemoryCore,
} from './memory-facts-core.mjs'

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

export interface MemoryFact {
  id: string
  type: MemoryType | null
  scope: string
  key: string
  content: string
  why: string | null
  updated_at: string
}

export interface MemoryMatch {
  key: string
  content: string
  why: string | null
  similarity: number
}

export const FACTS_TOKEN_THRESHOLD: number = CORE_FACTS_TOKEN_THRESHOLD

// Kernen tager deps eksplicit (dependency injection), så scripts kan binde deres
// egen supabase-klient og embed-implementation uden at duplikere logikken.
function deps() {
  return { sb: getSupabase(), embedText }
}

// Skriv eller ret et faktum. Embedder content og upserter på (scope, key), så en
// korrektion overskriver den eksisterende række i stedet for at duplikere.
export async function saveMemory(args: {
  type: MemoryType
  scope?: string
  key: string
  content: string
  why?: string | null
}): Promise<MemoryFact> {
  return (await saveMemoryCore(deps(), args)) as MemoryFact
}

// Slet ét faktum (scope+key). Bruges til at fjerne en brugerdefineret kategori.
// Idempotent: ingen fejl hvis rækken ikke findes.
export async function deleteMemory(args: { scope: string; key: string }): Promise<void> {
  await deleteMemoryCore(deps(), args)
}

// Semantisk søgning inden for ÉT scope (match_memory_facts RPC). Bruges når et
// scope er for stort til at loade i fuld.
export async function recallProject(args: {
  query: string
  scope: string
  match_count?: number
}): Promise<MemoryMatch[]> {
  return (await recallProjectCore(deps(), args)) as MemoryMatch[]
}

// Degrade-gracefully-reglen: load alt mens scope'et er lille, skift til
// vektor-søgning forbi tærsklen. query er kun nødvendig i det store tilfælde.
export async function recallForScope(
  scope: string,
  query?: string,
  match_count = 8
): Promise<{ mode: 'all'; rows: MemoryFact[] } | { mode: 'search'; rows: MemoryMatch[] }> {
  return (await recallForScopeCore(deps(), scope, query, match_count)) as
    | { mode: 'all'; rows: MemoryFact[] }
    | { mode: 'search'; rows: MemoryMatch[] }
}

// Hele det globale identitets-lag, i fuld. Fejler blødt til tom liste, så en
// manglende tabel (migration ikke kørt) ikke vælter routeren - den opfører sig
// så præcis som før laget fandtes. (Scripts-siden kaster i stedet; CLI/MCP vil
// se fejlen.)
export async function recallGlobal(): Promise<MemoryFact[]> {
  try {
    const res = await recallForScope('global')
    return res.mode === 'all' ? res.rows : []
  } catch (e) {
    console.error('recallGlobal fejlede (tom fallback):', e)
    return []
  }
}

// Renderer fakta til en kompakt, stabil tekstblok til routerens system-prompt.
// Tom streng når der intet er, så prompten er uændret indtil noget er lært.
export function formatGlobalForPrompt(
  rows: Array<Pick<MemoryFact, 'content' | 'why'>>
): string {
  return coreFormatGlobalForPrompt(rows)
}
