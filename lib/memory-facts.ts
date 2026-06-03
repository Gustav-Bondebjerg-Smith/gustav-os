// Lærende fakta-lag for routeren. Små, atomare fakta/præferencer som routeren selv
// skriver i runtime (save_memory) og som loades ind i dens system-prompt. Adskilt
// fra memory_sources/memory_chunks (dokument-RAG): her er én række = ét faktum,
// overskrevet på (scope, key). Se supabase/migrations/0010_memory_facts.sql.
//
// Genbruger embedText (samme model/dim) i stedet for at duplikere embedding-laget.
import 'server-only'
import { getSupabase } from './supabase'
import { embedText } from './memory'

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

// Ét sted (handoff-krav): under tærsklen loades et scope i fuld, over den skifter
// recall til vektor-søgning. Global er stabilt lille og rammer den aldrig; kun
// store projekt-scopes gør. Groft token-estimat = tegn / 4.
export const FACTS_TOKEN_THRESHOLD = 6000

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

const FACT_COLUMNS = 'id, type, scope, key, content, why, updated_at'

// Skriv eller ret et faktum. Embedder content og upserter på (scope, key), så en
// korrektion overskriver den eksisterende række i stedet for at duplikere.
export async function saveMemory(args: {
  type: MemoryType
  scope?: string
  key: string
  content: string
  why?: string | null
}): Promise<MemoryFact> {
  const scope = (args.scope || 'global').trim() || 'global'
  const key = args.key?.trim()
  const content = args.content?.trim()
  if (!key) throw new Error('saveMemory: key er påkrævet')
  if (!content) throw new Error('saveMemory: content er påkrævet')

  const embedding = await embedText(content)
  const sb = getSupabase()
  const { data, error } = await sb
    .from('memory_facts')
    .upsert(
      {
        type: args.type,
        scope,
        key,
        content,
        why: args.why?.trim() || null,
        embedding,
      },
      { onConflict: 'scope,key' }
    )
    .select(FACT_COLUMNS)
    .single()

  if (error) throw new Error(`memory_facts upsert-fejl: ${error.message}`)
  return data as MemoryFact
}

async function loadAllForScope(scope: string): Promise<MemoryFact[]> {
  const sb = getSupabase()
  // Stabil ordning (type, key) er vigtig: prompt-blokken skal være byte-identisk
  // mellem beskeder når fakta er uændret, ellers ryger Anthropic-prompt-cachen.
  const { data, error } = await sb
    .from('memory_facts')
    .select(FACT_COLUMNS)
    .eq('scope', scope)
    .order('type', { ascending: true })
    .order('key', { ascending: true })
  if (error) throw new Error(`memory_facts select-fejl: ${error.message}`)
  return (data || []) as MemoryFact[]
}

// Semantisk søgning inden for ÉT scope (match_memory_facts RPC). Bruges når et
// scope er for stort til at loade i fuld.
export async function recallProject(args: {
  query: string
  scope: string
  match_count?: number
}): Promise<MemoryMatch[]> {
  const query = args.query?.trim()
  const scope = args.scope?.trim()
  if (!query) throw new Error('recallProject: query er påkrævet')
  if (!scope) throw new Error('recallProject: scope er påkrævet')

  const embedding = await embedText(query)
  const sb = getSupabase()
  const { data, error } = await sb.rpc('match_memory_facts', {
    query_embedding: embedding,
    match_scope: scope,
    match_count: args.match_count ?? 8,
  })
  if (error) throw new Error(`match_memory_facts RPC-fejl: ${error.message}`)
  return (data || []) as MemoryMatch[]
}

// Degrade-gracefully-reglen samlet ét sted: load alt mens scope'et er lille, skift
// til vektor-søgning forbi tærsklen. query er kun nødvendig i det store tilfælde.
export async function recallForScope(
  scope: string,
  query?: string,
  match_count = 8
): Promise<{ mode: 'all'; rows: MemoryFact[] } | { mode: 'search'; rows: MemoryMatch[] }> {
  const rows = await loadAllForScope(scope)
  const tokens = estimateTokens(rows.map((r) => `${r.content} ${r.why ?? ''}`).join('\n'))
  if (tokens < FACTS_TOKEN_THRESHOLD || !query) return { mode: 'all', rows }
  const matched = await recallProject({ query, scope, match_count })
  return { mode: 'search', rows: matched }
}

// Hele det globale identitets-lag, i fuld. Fejler blødt til tom liste, så en
// manglende tabel (migration ikke kørt) ikke vælter routeren - den opfører sig
// så præcis som før laget fandtes.
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
  if (!rows.length) return ''
  const lines = rows.map((r) => `- ${r.content}${r.why ? ` (hvorfor: ${r.why})` : ''}`)
  return [
    'Lærte fakta og præferencer om Gustav (selvlærte i runtime). De er sande og vægter over generelle antagelser; ved konflikt med en regel nedenfor, følg disse fakta:',
    ...lines,
  ].join('\n')
}
