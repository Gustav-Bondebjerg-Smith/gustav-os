// AI-klassificering af finans (Modul 4). Haiku kategoriserer hver postering og
// varelinje til en fast kategori + et valgfrit sin_tag. Forstærkning, ikke
// erstatning: bygger på samme klassificerings-mønster som lib/capture.ts.
//
// To niveauer:
//  - Transaktions-niveau: posteringer UDEN matchet kvittering (forretnings-niveau).
//  - Varelinje-niveau: matchede kvitteringers linjer (præcist: "grønt vs øl").
// Matchede transaktioner får category='dagligvarer' (source='storebox') og BÆRER
// IKKE selv et sin_tag - synderne ligger på linjerne (ingen dobbelttælling).
import 'server-only'
import { getSupabase } from './supabase'
import { snapshotNetWorth } from './finance'
import { saveMemory, recallForScope } from './memory-facts'
import {
  CATEGORIES,
  merchantToken,
  parseFinanceRule,
  formatFinanceRule,
  type Category,
  type SinTag,
} from './finance-shared'
import { loadCategories } from './finance-categories'
import { loadSins } from './finance-sins'

const FINANCE_SCOPE = 'finance'

// De faste kategori-noegler. Bruges til at validere AI-svar paa VARELINJER (de bruger
// kun faste kategorier). Transaktioner valideres mod den merged liste i runtime.
const BUILTIN_CATEGORY_KEYS = new Set<string>(CATEGORIES as readonly string[])

const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001'

function requireEnv(name: string): string {
  const v = process.env[name]?.trim()
  if (!v) throw new Error(`Mangler ${name} i env`)
  return v
}
function nowIso(): string {
  return new Date().toISOString()
}
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// Kør en async-funktion over en liste med begrænset samtidighed.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker))
  return results
}

// Global takt-styring: org-grænsen er 50 Haiku-kald/min. Vi serialiserer KALD-START
// til ~1,35s fra hinanden (≈44/min) på tværs af al samtidighed. lastStart deles af
// alle workers. (Date.now() er fint her - Node-runtime, ikke workflow-sandkasse.)
const MIN_INTERVAL_MS = 1350
let lastStart = 0
async function pace(): Promise<void> {
  const now = Date.now()
  const scheduled = Math.max(now, lastStart + MIN_INTERVAL_MS)
  lastStart = scheduled
  const wait = scheduled - now
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
}

async function haiku(system: string, user: string, maxTokens: number): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    await pace()
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': requireEnv('ANTHROPIC_API_KEY'),
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: CLASSIFIER_MODEL,
        max_tokens: maxTokens,
        temperature: 0,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    })
    // 429 (rate limit) / 529 (overloaded): backoff og prøv igen.
    if (r.status === 429 || r.status === 529) {
      if (attempt >= 6) throw new Error(`Anthropic ${r.status} efter ${attempt} forsøg`)
      const retryAfter = Number(r.headers.get('retry-after'))
      const backoff =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(30000, 1500 * 2 ** attempt)
      await new Promise((res) => setTimeout(res, backoff))
      continue
    }
    if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}: ${await r.text()}`)
    const j = await r.json()
    return (j.content?.[0]?.text || '').trim()
  }
}

// Udtræk første balancerede JSON-array fra Haiku-svaret (Haiku tilføjer nogle
// gange prosa efter objektet - se AGENTS.md). Respekterer strenge.
function extractJsonArray(raw: string): unknown {
  const start = raw.indexOf('[')
  if (start === -1) throw new Error('intet JSON-array i svar')
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < raw.length; i++) {
    const c = raw[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
    } else if (c === '"') inStr = true
    else if (c === '[') depth++
    else if (c === ']') {
      depth--
      if (depth === 0) return JSON.parse(raw.slice(start, i + 1))
    }
  }
  throw new Error('ubalanceret JSON-array i svar')
}

type ClassOut = { category: Category; sin: SinTag | null; confidence: 'high' | 'low' }
type RawClass = { i?: number; category?: string; sin?: string | null; confidence?: string }

function coerce(
  arr: RawClass[],
  n: number,
  fallback: Category,
  validKeys: Set<string>,
  validSinKeys: Set<string>,
): ClassOut[] {
  const byI = new Map<number, RawClass>()
  arr.forEach((a, idx) => byI.set(typeof a.i === 'number' ? a.i : idx, a))
  const out: ClassOut[] = []
  for (let i = 0; i < n; i++) {
    const a = byI.get(i)
    out.push({
      category: typeof a?.category === 'string' && validKeys.has(a.category) ? a.category : fallback,
      // Synd valideres mod den merged liste (faste + Gustavs egne), ikke kun de faste.
      sin: typeof a?.sin === 'string' && validSinKeys.has(a.sin) ? a.sin : null,
      confidence: a?.confidence === 'low' ? 'low' : 'high',
    })
  }
  return out
}

// =============================== TRANSAKTIONER ===============================

const TX_SYSTEM_BASE = [
  'Du kategoriserer danske bank-posteringer for Gustav (medicinstuderende, Odense).',
  'Hver postering: text (kort), detail (forretning/by), amount (negativ=udgift, positiv=indkomst).',
  'Returnér KUN et JSON-array, ét objekt pr. input i SAMME rækkefølge:',
  '[{"i":0,"category":"dagligvarer","sin":null,"confidence":"high"}]',
  'category er PRÆCIS én af: dagligvarer, ude, transport, bolig, abonnement, helbred, studie, opsparing, indkomst, andet.',
  '- dagligvarer: supermarked (Netto, Føtex, MENY, Rema, Lidl, Aldi, Bilka, SPAR).',
  '- ude: restaurant, cafe, takeaway, bar, fastfood, bodega, kiosk-mad.',
  '- transport: tog, bus, DSB, rejsekort, taxa, benzin, parkering, billeje.',
  '- bolig: husleje, el, vand, varme, internet, forsikring.',
  '- abonnement: streaming, mobil, software, medlemskab (Spotify, Netflix, Anthropic, fitness, avis).',
  '- helbred: apotek, læge, tandlæge, optiker.',
  '- studie: bøger, studiematerialer, SDU, kompendier.',
  '- opsparing: overførsel til opsparing/investering, MobilePay til dig selv.',
  '- indkomst: løn, SU, indbetaling, refusion (typisk positivt beløb).',
  '- andet: alt der ikke passer ovenfor.',
  'sin er ét af: takeaway, alkohol, spil, sodavand, energidrik, snacks - ELLER null.',
  '- takeaway: fastfood/takeaway (McDonalds, burger, pizza, sushi, kebab, Wolt, Just Eat).',
  '- alkohol: bar, vinhandel, alkohol.',
  '- spil: betting, casino, lotto, Danske Spil, Unibet.',
  'Sæt KUN sin når posteringen TYDELIGT er en synd. Ellers null. De fleste posteringer har sin=null.',
  'confidence: "low" hvis du er i reel tvivl om kategorien (ukendt eller tvetydig forretning), ellers "high".',
].join('\n')

// Byg AI-prompten med Gustavs egne kategorier OG synder oven paa de faste, saa Haiku
// OGSAA kan auto-vaelge dem paa ukendte forretninger (Gustavs valg: "ogsaa AI'en").
// Uden egne (begge tomme) er prompten byte-identisk med foer -> uaendret adfaerd.
function buildTxSystem(
  customCats: { key: string; label: string }[],
  customSins: { key: string; label: string }[],
): string {
  if (customCats.length === 0 && customSins.length === 0) return TX_SYSTEM_BASE
  const parts = [TX_SYSTEM_BASE]
  if (customCats.length > 0) {
    parts.push(
      `Derudover er disse brugerdefinerede kategorier OGSAA gyldige: ${customCats.map((c) => c.key).join(', ')}.`,
    )
    for (const c of customCats) parts.push(`- ${c.key}: ${c.label} (brugerdefineret kategori).`)
    parts.push('Vaelg en brugerdefineret kategori naar den passer tydeligt bedre end de faste.')
  }
  if (customSins.length > 0) {
    parts.push(
      `Derudover er disse brugerdefinerede synder OGSAA gyldige sin-vaerdier: ${customSins.map((s) => s.key).join(', ')}.`,
    )
    for (const s of customSins) parts.push(`- ${s.key}: ${s.label} (brugerdefineret synd).`)
    parts.push('Saet KUN en brugerdefineret synd naar posteringen tydeligt er den synd; ellers null.')
  }
  return parts.join('\n')
}

async function classifyTransactionsBatch(
  items: { text: string; detail: string; amount: number }[],
  system: string,
  validKeys: Set<string>,
  validSinKeys: Set<string>,
): Promise<ClassOut[]> {
  if (items.length === 0) return []
  const user = JSON.stringify(
    items.map((it, i) => ({ i, text: it.text, detail: it.detail.slice(0, 100), amount: it.amount })),
  )
  const raw = await haiku(system, user, 3600)
  return coerce(extractJsonArray(raw) as RawClass[], items.length, 'andet', validKeys, validSinKeys)
}

type TxRow = { id: string; text_raw: string; detail: string; amount: number }

// Klassificér ALLE uklassificerede, umatchede transaktioner (category null +
// intet storebox_receipt_id). Idempotent: kan køres igen for nye posteringer.
export async function classifyUnmatchedTransactions(
  opts: { batchSize?: number; concurrency?: number; max?: number } = {},
): Promise<number> {
  const sb = getSupabase()
  const batchSize = opts.batchSize ?? 15

  const rows: TxRow[] = []
  const pushRows = (page: Record<string, unknown>[]) => {
    for (const r of page) {
      rows.push({ id: String(r.id), text_raw: String(r.text_raw ?? ''), detail: String(r.detail ?? ''), amount: Number(r.amount) })
    }
  }
  if (opts.max) {
    // Bundet kørsel (cron): hent kun max rækker, ingen paginering.
    const { data, error } = await sb
      .from('transactions')
      .select('id, text_raw, detail, amount')
      .is('category', null)
      .is('storebox_receipt_id', null)
      .limit(opts.max)
    if (error) throw new Error(`classify hent-fejl: ${error.message}`)
    pushRows((data ?? []) as Record<string, unknown>[])
  } else {
    const PAGE = 1000
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await sb
        .from('transactions')
        .select('id, text_raw, detail, amount')
        .is('category', null)
        .is('storebox_receipt_id', null)
        .range(from, from + PAGE - 1)
      if (error) throw new Error(`classify hent-fejl: ${error.message}`)
      const page = (data ?? []) as Record<string, unknown>[]
      pushRows(page)
      if (page.length < PAGE) break
    }
  }

  // Anvend lærte regler FØRST: kendte forretninger kategoriseres deterministisk
  // (ingen AI), så systemet bliver klogere af Gustavs tidligere rettelser.
  const rules = await loadFinanceRules()
  // Kategorier + synder (faste + Gustavs egne) -> dynamisk prompt + gyldige noegler til
  // validering af AI-svaret. Loades én gang pr. koersel.
  const cats = await loadCategories()
  const sins = await loadSins()
  const txSystem = buildTxSystem(
    cats.filter((c) => !c.builtin),
    sins.filter((s) => !s.builtin),
  )
  const txValidKeys = new Set(cats.map((c) => c.key))
  const txValidSinKeys = new Set(sins.map((s) => s.key))
  const ruleHits: { row: TxRow; category: Category; sin: SinTag | null }[] = []
  const aiRows: TxRow[] = []
  for (const r of rows) {
    const rule = rules.get(merchantToken(r.text_raw))
    if (rule) ruleHits.push({ row: r, category: rule.category, sin: rule.sin })
    else aiRows.push(r)
  }

  let classified = 0

  // Regel-ramte posteringer: deterministisk update.
  for (const slice of chunk(ruleHits, 200)) {
    await Promise.all(
      slice.map((h) =>
        sb
          .from('transactions')
          .update({
            category: h.category,
            sin_tag: h.sin,
            category_source: 'rule',
            status: 'classified',
            updated_at: nowIso(),
          })
          .eq('id', h.row.id),
      ),
    )
    classified += slice.length
  }

  // Resten: AI med konfidens. Lav konfidens -> needs_review (spørge-loop).
  const batches = chunk(aiRows, batchSize)
  await mapWithConcurrency(batches, opts.concurrency ?? 5, async (batch) => {
    try {
      const cls = await classifyTransactionsBatch(
        batch.map((r) => ({ text: r.text_raw, detail: r.detail, amount: r.amount })),
        txSystem,
        txValidKeys,
        txValidSinKeys,
      )
      await Promise.all(
        batch.map((r, i) =>
          sb
            .from('transactions')
            .update({
              category: cls[i].category,
              sin_tag: cls[i].sin,
              category_source: 'ai',
              status: cls[i].confidence === 'low' ? 'needs_review' : 'classified',
              updated_at: nowIso(),
            })
            .eq('id', r.id),
        ),
      )
      classified += batch.length
    } catch (e) {
      // Ét dårligt Haiku-svar (fx trunkeret JSON) må ikke dræbe hele kørslen.
      // Batchen forbliver uklassificeret og tages i næste (idempotente) kørsel.
      console.error(`  [classify-tx] batch sprunget over: ${e instanceof Error ? e.message : e}`)
    }
  })
  return classified
}

// Lærte regler: forretnings-nøgle -> {category, sin}, fra memory_facts (scope
// 'finance'). Finance-scope er lille -> recallForScope loader alt. Fejler blødt.
export async function loadFinanceRules(): Promise<Map<string, { category: Category; sin: SinTag | null }>> {
  const map = new Map<string, { category: Category; sin: SinTag | null }>()
  try {
    const res = await recallForScope(FINANCE_SCOPE)
    if (res.mode !== 'all') return map
    for (const r of res.rows) {
      const parsed = parseFinanceRule(r.content)
      if (parsed.category) map.set(r.key, { category: parsed.category, sin: parsed.sin })
    }
  } catch (e) {
    console.error('loadFinanceRules fejlede (tom fallback):', e)
  }
  return map
}

// Gem Gustavs rettelse som lært regel (memory_facts, upsert på scope+key).
export async function saveFinanceRule(
  token: string,
  category: Category,
  sin: SinTag | null,
): Promise<void> {
  if (!token) return
  await saveMemory({
    type: 'feedback',
    scope: FINANCE_SCOPE,
    key: token,
    content: formatFinanceRule(category, sin),
    why: 'Gustavs kategori-rettelse i finans-review',
  })
}

// Matchede transaktioner = dagligvarekøb. Sæt kategori uden AI (synder ligger på
// linjerne). Bulk-update.
export async function markMatchedTransactionsGrocery(): Promise<number> {
  const sb = getSupabase()
  const { data, error } = await sb
    .from('transactions')
    .update({ category: 'dagligvarer', category_source: 'storebox', updated_at: nowIso() })
    .not('storebox_receipt_id', 'is', null)
    .is('category', null)
    .select('id')
  if (error) throw new Error(`markMatchedGrocery-fejl: ${error.message}`)
  return data?.length ?? 0
}

// =============================== VARELINJER ===============================

const LINE_SYSTEM_BASE = [
  'Du kategoriserer varelinjer fra en dansk dagligvare-kvittering.',
  'Hver linje: name (varenavn), amount (pris).',
  'Returnér KUN et JSON-array, ét objekt pr. linje i SAMME rækkefølge:',
  '[{"i":0,"category":"dagligvarer","sin":null}]',
  'category: oftest "dagligvarer". Brug "andet" for pant, rabat, poser, gebyrer.',
  'sin er ét af: alkohol, sodavand, energidrik, snacks - ELLER null.',
  '- alkohol: øl, vin, spiritus, cider, breezer, shots.',
  '- sodavand: cola, fanta, sprite, sodavand, læskedrik (IKKE vand, IKKE juice, IKKE mælk).',
  '- energidrik: Red Bull, Monster, Booster, Cult, energidrik.',
  '- snacks: chips, slik, chokolade, kage, is, candy, popcorn.',
  'Mad, frugt, grønt, kød, fisk, mejeri, brød osv. = sin null.',
].join('\n')

// Linje-prompt med Gustavs egne synder oven paa de faste (varelinjer bruger kun FASTE
// kategorier, men synder kan vaere brugerdefinerede). Byte-identisk uden egne synder.
function buildLineSystem(customSins: { key: string; label: string }[]): string {
  if (customSins.length === 0) return LINE_SYSTEM_BASE
  return [
    LINE_SYSTEM_BASE,
    `Derudover er disse brugerdefinerede synder OGSAA gyldige sin-vaerdier: ${customSins.map((s) => s.key).join(', ')}.`,
    ...customSins.map((s) => `- ${s.key}: ${s.label} (brugerdefineret synd).`),
    'Saet KUN en brugerdefineret synd naar varen tydeligt er den synd; ellers null.',
  ].join('\n')
}

type LineRow = { id: string; text: string; amount: number }

async function classifyLinesBatch(
  merchant: string,
  lines: { text: string; amount: number }[],
  system: string,
  validSinKeys: Set<string>,
): Promise<ClassOut[]> {
  if (lines.length === 0) return []
  const user = JSON.stringify({
    merchant,
    linjer: lines.map((l, i) => ({ i, name: l.text, amount: l.amount })),
  })
  const raw = await haiku(system, user, 1500)
  return coerce(extractJsonArray(raw) as RawClass[], lines.length, 'dagligvarer', BUILTIN_CATEGORY_KEYS, validSinKeys)
}

// Klassificér alle uklassificerede varelinjer, grupperet pr. transaktion (så
// Haiku får forretnings-konteksten). Idempotent.
export async function classifyReceiptLines(
  opts: { concurrency?: number; max?: number } = {},
): Promise<number> {
  const sb = getSupabase()

  // Transaktioner med uklassificerede linjer.
  const { data: lineRows, error: le } = await sb
    .from('transaction_lines')
    .select('id, transaction_id, text, amount, category')
    .is('category', null)
    .limit(10000)
  if (le) throw new Error(`linje-hent-fejl: ${le.message}`)
  const byTx = new Map<string, LineRow[]>()
  for (const r of (lineRows ?? []) as Record<string, unknown>[]) {
    const txId = String(r.transaction_id)
    if (!byTx.has(txId)) byTx.set(txId, [])
    byTx.get(txId)!.push({ id: String(r.id), text: String(r.text ?? ''), amount: Number(r.amount) })
  }
  if (byTx.size === 0) return 0

  // Bundet kørsel (cron): behandl højst opts.max kvitteringer pr. kald.
  const entries = [...byTx.entries()].slice(0, opts.max ?? Infinity)

  // Forretningsnavn pr. transaktion (til kontekst).
  const txIds = entries.map(([id]) => id)
  const merchantByTx = new Map<string, string>()
  for (const ids of chunk(txIds, 200)) {
    const { data } = await sb
      .from('transactions')
      .select('id, storebox_receipt_id, text_raw')
      .in('id', ids)
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      merchantByTx.set(String(r.id), String(r.text_raw ?? ''))
    }
  }

  // Synder (faste + Gustavs egne) -> dynamisk linje-prompt + gyldige sin-noegler.
  const sins = await loadSins()
  const lineSystem = buildLineSystem(sins.filter((s) => !s.builtin))
  const lineValidSinKeys = new Set(sins.map((s) => s.key))

  let classified = 0
  await mapWithConcurrency(entries, opts.concurrency ?? 5, async ([txId, lines]) => {
    try {
      const merchant = merchantByTx.get(txId) ?? ''
      const cls = await classifyLinesBatch(
        merchant,
        lines.map((l) => ({ text: l.text, amount: l.amount })),
        lineSystem,
        lineValidSinKeys,
      )
      await Promise.all(
        lines.map((l, i) =>
          sb
            .from('transaction_lines')
            .update({ category: cls[i].category, sin_tag: cls[i].sin })
            .eq('id', l.id),
        ),
      )
      classified += lines.length
    } catch (e) {
      console.error(`  [classify-lines] kvittering sprunget over: ${e instanceof Error ? e.message : e}`)
    }
  })
  return classified
}

// =============================== CRON-BATCH ===============================

export type FinanceClassifyResult = {
  grocery: number // matchede -> dagligvarer (gratis)
  lines: number // varelinjer klassificeret
  transactions: number // umatchede transaktioner klassificeret
  snapshot: boolean // dagens nettoformue-snapshot skrevet
  remaining: number // uklassificerede transaktioner tilbage
}

// Én BUNDET portion til cron-endpointet. Holder sig under serverless-timeout (60s)
// og Haiku rate-limit: markMatched (0 kald) + få kvitteringer + ~maxTransactions
// posteringer (lærte regler absorberer en del uden AI). Idempotent + sikker at
// gentage, så cron'en dræner køen over et par kørsler efter en månedlig import.
export async function runFinanceClassifyBatch(
  opts: { maxTransactions?: number; maxReceipts?: number } = {},
): Promise<FinanceClassifyResult> {
  const grocery = await markMatchedTransactionsGrocery()
  const lines = await classifyReceiptLines({ max: opts.maxReceipts ?? 8, concurrency: 4 })
  const transactions = await classifyUnmatchedTransactions({
    max: opts.maxTransactions ?? 100,
    batchSize: 10,
    concurrency: 4,
  })

  // Dagligt nettoformue-snapshot (best-effort, idempotent pr. dato).
  let snapshot = false
  try {
    await snapshotNetWorth()
    snapshot = true
  } catch (e) {
    console.error('snapshotNetWorth i finans-cron fejlede:', e)
  }

  const sb = getSupabase()
  const { count } = await sb
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .is('category', null)
  return { grocery, lines, transactions, snapshot, remaining: count ?? 0 }
}
