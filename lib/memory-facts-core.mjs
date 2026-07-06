// Fakta-lagets ENE kerne (memory_facts) - delt af Next.js-routeren og scripts.
//
// Historik: lib/memory-facts.ts (TS, router/finans) og scripts/memory-facts-core.mjs
// (CLI + MCP-server) var to håndholdte spejle af samme queries. Nu ligger al
// logik KUN her; begge sider binder deres egne afhængigheder og re-eksporterer.
// Samme mønster som lib/agent-router-core.mjs (2026-07-06).
//
// Dependency injection i stedet for imports: miljøerne har hver deres
// supabase-klient (lib/supabase.ts vs scripts' egen createClient) og hver deres
// embedText (lib/memory.ts vs scripts/embed.mjs - samme model/dim). Hver funktion
// tager derfor `deps = { sb, embedText }` som første argument. Ren JS med JSDoc,
// ingen 'server-only', ingen load-env.
//
// Én række = ét faktum, overskrevet på (scope, key). Se migration 0010.

export const VALID_FACT_TYPES = ['user', 'feedback', 'project', 'reference']

// Ét sted (handoff-krav): under tærsklen loades et scope i fuld, over den skifter
// recall til vektor-søgning. Global er stabilt lille og rammer den aldrig; kun
// store projekt-scopes gør. Groft token-estimat = tegn / 4.
export const FACTS_TOKEN_THRESHOLD = 6000

const FACT_COLUMNS = 'id, type, scope, key, content, why, updated_at'

function estimateTokens(text) {
  return Math.ceil(text.length / 4)
}

/** @typedef {{ sb: any, embedText: (text: string) => Promise<number[]> }} FactDeps */

// Skriv eller ret et faktum. Embedder content og upserter på (scope, key), så en
// korrektion overskriver den eksisterende række i stedet for at duplikere.
// Validerer type mod VALID_FACT_TYPES (beskytter MCP/CLI-stien; TS-callere er
// allerede typede).
/**
 * @param {FactDeps} deps
 * @param {{ type: string, scope?: string, key: string, content: string, why?: string | null }} args
 */
export async function saveMemoryCore(deps, { type, scope = 'global', key, content, why = null }) {
  const cleanScope = (typeof scope === 'string' && scope.trim()) || 'global'
  const cleanKey = typeof key === 'string' ? key.trim() : ''
  const cleanContent = typeof content === 'string' ? content.trim() : ''
  const cleanWhy = why && String(why).trim() ? String(why).trim() : null
  if (!VALID_FACT_TYPES.includes(type)) {
    throw new Error(`type skal være en af: ${VALID_FACT_TYPES.join(', ')}`)
  }
  if (!cleanKey) throw new Error('key er påkrævet')
  if (!cleanContent) throw new Error('content er påkrævet')

  const embedding = await deps.embedText(cleanContent)
  const { data, error } = await deps.sb
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

// Slet ét faktum (scope+key). Bruges til at fjerne en brugerdefineret kategori.
// Idempotent: ingen fejl hvis rækken ikke findes.
/** @param {FactDeps} deps */
export async function deleteMemoryCore(deps, { scope, key }) {
  const { error } = await deps.sb
    .from('memory_facts')
    .delete()
    .eq('scope', scope)
    .eq('key', key)
  if (error) throw new Error(`memory_facts delete-fejl: ${error.message}`)
}

// Alle fakta i ÉT scope. Stabil ordning (type, key) er vigtig: prompt-blokken
// skal være byte-identisk mellem beskeder når fakta er uændret, ellers ryger
// Anthropic-prompt-cachen.
/** @param {FactDeps} deps */
export async function loadAllForScopeCore(deps, scope) {
  const { data, error } = await deps.sb
    .from('memory_facts')
    .select(FACT_COLUMNS)
    .eq('scope', scope)
    .order('type', { ascending: true })
    .order('key', { ascending: true })
  if (error) throw new Error(`memory_facts select-fejl: ${error.message}`)
  return data || []
}

// Liste over fakta på tværs af scopes, evt. filtreret. Stabil ordning
// (scope, type, key). Bruges af CLI'ens --list og MCP'ens memory_fact_list.
/** @param {FactDeps} deps */
export async function listFactsCore(deps, { scope = null } = {}) {
  let q = deps.sb
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

// Semantisk søgning inden for ÉT scope (match_memory_facts RPC). Bruges når et
// scope er for stort til at loade i fuld.
/** @param {FactDeps} deps */
export async function recallProjectCore(deps, { query, scope, match_count = 8 }) {
  const q = typeof query === 'string' ? query.trim() : ''
  const s = typeof scope === 'string' ? scope.trim() : ''
  if (!q) throw new Error('recallProject: query er påkrævet')
  if (!s) throw new Error('recallProject: scope er påkrævet')

  const embedding = await deps.embedText(q)
  const { data, error } = await deps.sb.rpc('match_memory_facts', {
    query_embedding: embedding,
    match_scope: s,
    match_count,
  })
  if (error) throw new Error(`match_memory_facts RPC-fejl: ${error.message}`)
  return data || []
}

// Degrade-gracefully-reglen samlet ét sted: load alt mens scope'et er lille, skift
// til vektor-søgning forbi tærsklen. query er kun nødvendig i det store tilfælde.
/** @param {FactDeps} deps */
export async function recallForScopeCore(deps, scope, query, match_count = 8) {
  const rows = await loadAllForScopeCore(deps, scope)
  const tokens = estimateTokens(rows.map((r) => `${r.content} ${r.why ?? ''}`).join('\n'))
  if (tokens < FACTS_TOKEN_THRESHOLD || !query) return { mode: 'all', rows }
  const matched = await recallProjectCore(deps, { query, scope, match_count })
  return { mode: 'search', rows: matched }
}

// Manuel konsolidering (v1): returnerer en rapport over semantisk nære dublet-par
// + det ældste faktum. Sletter eller merger INTET - det foreslår kun.
/** @param {FactDeps} deps */
export async function consolidateFactsCore(deps, { scope = 'global', threshold = 0.85 } = {}) {
  const facts = await listFactsCore(deps, { scope })
  const seen = new Set()
  const duplicate_pairs = []
  for (const row of facts) {
    const embedding = await deps.embedText(row.content)
    const { data: matches, error } = await deps.sb.rpc('match_memory_facts', {
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

// Renderer fakta til en kompakt, stabil tekstblok til routerens system-prompt.
// Tom streng når der intet er, så prompten er uændret indtil noget er lært.
// Ren funktion - ingen deps.
export function formatGlobalForPrompt(rows) {
  if (!rows.length) return ''
  const lines = rows.map((r) => `- ${r.content}${r.why ? ` (hvorfor: ${r.why})` : ''}`)
  return [
    'Lærte fakta og præferencer om Gustav (selvlærte i runtime). De er sande og vægter over generelle antagelser; ved konflikt med en regel nedenfor, følg disse fakta:',
    ...lines,
  ].join('\n')
}
