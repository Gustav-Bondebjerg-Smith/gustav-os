// Delt kerne for det lærende fakta-lag (memory_facts) i .mjs-land. Bruges af
// CLI'en (memory-facts.mjs) OG MCP-serveren (memory-mcp-server.mjs), så Claude
// Code/Codex kan læse og skrive de samme fakta som Telegram-routeren.
//
// Spejler lib/memory-facts.ts (TS-versionen der kører i Next.js-routeren): samme
// tabel, samme upsert-nøgle (scope, key), samme match_memory_facts RPC, samme
// embedding-model via embed.mjs. Forskel: her KASTER funktionerne ved fejl (CLI/MCP
// vil se fejlen), mens TS-routerens recallGlobal fejler blødt (hot-path).
import './load-env.mjs'
import { createClient } from '@supabase/supabase-js'
import { embedText } from './embed.mjs'

export const VALID_FACT_TYPES = ['user', 'feedback', 'project', 'reference']
export const FACTS_TOKEN_THRESHOLD = 6000

const FACT_COLUMNS = 'id, type, scope, key, content, why, updated_at'

let _supabase = null
function getSupabase() {
  if (_supabase) return _supabase
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Mangler NEXT_PUBLIC_SUPABASE_URL eller SUPABASE_SERVICE_ROLE_KEY i .env.local')
  }
  _supabase = createClient(url, key, { auth: { persistSession: false } })
  return _supabase
}

// Skriv eller ret et faktum. Embedder content og upserter på (scope, key), så en
// korrektion overskriver i stedet for at duplikere.
export async function saveMemory({ type, scope = 'global', key, content, why = null }) {
  const cleanScope = (typeof scope === 'string' && scope.trim()) || 'global'
  const cleanKey = typeof key === 'string' ? key.trim() : ''
  const cleanContent = typeof content === 'string' ? content.trim() : ''
  const cleanWhy = why && String(why).trim() ? String(why).trim() : null
  if (!VALID_FACT_TYPES.includes(type)) throw new Error(`type skal være en af: ${VALID_FACT_TYPES.join(', ')}`)
  if (!cleanKey) throw new Error('key er påkrævet')
  if (!cleanContent) throw new Error('content er påkrævet')

  const embedding = await embedText(cleanContent)
  const sb = getSupabase()
  const { data, error } = await sb
    .from('memory_facts')
    .upsert(
      { type, scope: cleanScope, key: cleanKey, content: cleanContent, why: cleanWhy, embedding },
      { onConflict: 'scope,key' }
    )
    .select(FACT_COLUMNS)
    .single()
  if (error) throw new Error(`memory_facts upsert-fejl: ${error.message}`)
  return data
}

// Liste over fakta, evt. filtreret på scope. Stabil ordning (scope, type, key).
export async function listFacts({ scope = null } = {}) {
  const sb = getSupabase()
  let q = sb
    .from('memory_facts')
    .select(FACT_COLUMNS)
    .order('scope', { ascending: true })
    .order('type', { ascending: true })
    .order('key', { ascending: true })
  if (scope) q = q.eq('scope', scope)
  const { data, error } = await q
  if (error) throw new Error(`memory_facts list-fejl: ${error.message}`)
  return data || []
}

// Hele det globale lag i fuld (ingen vektor-søgning).
export async function recallGlobal() {
  const sb = getSupabase()
  const { data, error } = await sb
    .from('memory_facts')
    .select(FACT_COLUMNS)
    .eq('scope', 'global')
    .order('type', { ascending: true })
    .order('key', { ascending: true })
  if (error) throw new Error(`recallGlobal-fejl: ${error.message}`)
  return data || []
}

// Semantisk søgning inden for ÉT scope (match_memory_facts RPC).
export async function recallProject({ query, scope, match_count = 8 }) {
  const q = typeof query === 'string' ? query.trim() : ''
  const s = typeof scope === 'string' ? scope.trim() : ''
  if (!q) throw new Error('query er påkrævet')
  if (!s) throw new Error('scope er påkrævet')

  const embedding = await embedText(q)
  const sb = getSupabase()
  const { data, error } = await sb.rpc('match_memory_facts', {
    query_embedding: embedding,
    match_scope: s,
    match_count,
  })
  if (error) throw new Error(`match_memory_facts RPC-fejl: ${error.message}`)
  return data || []
}

// Manuel konsolidering (v1): returnerer en rapport over semantisk nære dublet-par
// + det ældste faktum. Sletter eller merger INTET - det foreslår kun.
export async function consolidateFacts({ scope = 'global', threshold = 0.85 } = {}) {
  const facts = await listFacts({ scope })
  const sb = getSupabase()
  const seen = new Set()
  const duplicate_pairs = []
  for (const row of facts) {
    const embedding = await embedText(row.content)
    const { data: matches, error } = await sb.rpc('match_memory_facts', {
      query_embedding: embedding,
      match_scope: scope,
      match_count: 5,
      min_similarity: threshold,
    })
    if (error) throw new Error(`match_memory_facts RPC-fejl: ${error.message}`)
    for (const m of matches || []) {
      if (m.key === row.key) continue
      const pairKey = [row.key, m.key].sort().join(' :: ')
      if (seen.has(pairKey)) continue
      seen.add(pairKey)
      duplicate_pairs.push({
        a_key: row.key,
        a_content: row.content,
        b_key: m.key,
        b_content: m.content,
        similarity: Number(m.similarity),
      })
    }
  }
  const oldest = facts.length
    ? facts.reduce((a, b) => (a.updated_at < b.updated_at ? a : b))
    : null
  return { scope, threshold, count: facts.length, duplicate_pairs, oldest }
}
