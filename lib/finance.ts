// Personlig finans (Modul 4) - server-laget. Skriver/læser via service_role
// (getSupabase), som resten af lib/. Bygger på de rene parsere (finance-csv,
// finance-storebox) + matchningen (finance-reconcile) og lægger DB + AI ovenpå.
//
// Datakilder: bank-CSV = kanonisk transaktion + saldo. Storebox = kvitteringer
// hvis varelinjer HÆGTES PÅ den matchende bank-transaktion (ikke separate).
import 'server-only'
import { createHash } from 'node:crypto'
import { getSupabase } from './supabase'
import { parseBankCsv } from './finance-csv'
import { parseStoreboxReceipts } from './finance-storebox'
import { reconcile } from './finance-reconcile'
import {
  isCategory,
  isSinTag,
  merchantToken,
  type Category,
  type SinTag,
  type CategorySource,
  type TransactionStatus,
  type Transaction,
  type TransactionLine,
  type ManualBalance,
  type NetWorth,
  type NetWorthPoint,
  type SinSummary,
  type MerchantGroup,
  type ParsedBankTx,
  type ParsedReceipt,
  type ParsedReceiptLine,
} from './finance-shared'

// Re-eksportér det klient-sikre lag, så server-kode kan nøjes med ét import-sted.
export * from './finance-shared'

function nowIso(): string {
  return new Date().toISOString()
}

// I dag som YYYY-MM-DD i Copenhagen (aldrig server-UTC).
function todayCphYmd(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Copenhagen',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

// YMD-aritmetik via UTC (undgår DST-skred). Bruges til sving-sammenligninger.
function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
function addMonthsYmd(ymd: string, months: number): string {
  const d = new Date(`${ymd}T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + months)
  return d.toISOString().slice(0, 10)
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// Stabil idempotens-nøgle pr. bank-postering. Inkluderer saldo, så to ens køb
// samme dag (forskellig løbende saldo) ikke kolliderer.
function txImportHash(t: ParsedBankTx): string {
  return createHash('sha256')
    .update([t.bookedDate, t.textRaw, t.amount, t.balance ?? '', t.ref].join('|'))
    .digest('hex')
}

const TX_COLS =
  'id, booked_date, text_raw, detail, counterparty, amount, balance, category, sin_tag, category_source, status, storebox_receipt_id, note, created_at, updated_at'

function rowToTx(r: Record<string, unknown>): Transaction {
  return {
    id: String(r.id),
    booked_date: String(r.booked_date),
    text_raw: String(r.text_raw ?? ''),
    detail: String(r.detail ?? ''),
    counterparty: String(r.counterparty ?? ''),
    amount: Number(r.amount),
    balance: r.balance == null ? null : Number(r.balance),
    category: (r.category as Category) ?? null,
    sin_tag: (r.sin_tag as SinTag) ?? null,
    category_source: (r.category_source as CategorySource) ?? 'ai',
    status: (r.status as TransactionStatus) ?? 'classified',
    storebox_receipt_id: (r.storebox_receipt_id as string) ?? null,
    note: (r.note as string) ?? null,
    created_at: String(r.created_at ?? ''),
    updated_at: String(r.updated_at ?? ''),
  }
}

// =============================== IMPORT ===============================

export type BankImportResult = { parsed: number; inserted: number; importId: string }

// Idempotent bulk-import af bank-CSV. Tager en ALLEREDE-DEKODET streng (ISO-8859-1
// -> string sker ved I/O-grænsen i kalderen). ON CONFLICT (import_hash) DO NOTHING.
export async function importBankCsv(text: string, filename: string): Promise<BankImportResult> {
  const txs = parseBankCsv(text)
  const sb = getSupabase()
  const { data: imp, error: ie } = await sb
    .from('finance_imports')
    .insert({ kind: 'bank', filename, row_count: txs.length })
    .select('id')
    .single()
  if (ie) throw new Error(`finance_imports-fejl: ${ie.message}`)
  const importId = String((imp as Record<string, unknown>).id)

  const rows = txs.map((t) => ({
    booked_date: t.bookedDate,
    text_raw: t.textRaw,
    detail: t.detail,
    counterparty: t.counterparty,
    amount: t.amount,
    balance: t.balance,
    import_id: importId,
    import_hash: txImportHash(t),
  }))

  let inserted = 0
  for (const batch of chunk(rows, 500)) {
    const { data, error } = await sb
      .from('transactions')
      .upsert(batch, { onConflict: 'import_hash', ignoreDuplicates: true })
      .select('id')
    if (error) throw new Error(`transactions-import-fejl: ${error.message}`)
    inserted += data?.length ?? 0
  }
  return { parsed: txs.length, inserted, importId }
}

export type StoreboxImportResult = {
  parsed: number
  insertedReceipts: number
  matched: number
  linesInserted: number
}

// Idempotent import af hele Storebox-historikken + reconciliation mod bank.
export async function importStoreboxReceipts(
  input: unknown,
  filename: string,
): Promise<StoreboxImportResult> {
  const receipts = parseStoreboxReceipts(input)
  const sb = getSupabase()
  await sb.from('finance_imports').insert({ kind: 'storebox', filename, row_count: receipts.length })

  const rows = receipts.map((r) => ({
    receipt_id: r.receiptId,
    receipt_date: r.bookedDate,
    purchase_ts: r.purchaseDate || null,
    merchant: r.merchantName,
    merchant_city: r.merchantCity,
    total_amount: r.total,
    line_items: r.lines,
  }))

  let insertedReceipts = 0
  for (const batch of chunk(rows, 500)) {
    const { data, error } = await sb
      .from('storebox_receipts')
      .upsert(batch, { onConflict: 'receipt_id', ignoreDuplicates: true })
      .select('id')
    if (error) throw new Error(`storebox-import-fejl: ${error.message}`)
    insertedReceipts += data?.length ?? 0
  }

  const rec = await reconcileUnmatched()
  return { parsed: receipts.length, insertedReceipts, matched: rec.matched, linesInserted: rec.linesInserted }
}

export type ReconcileDbResult = { matched: number; linesInserted: number }

// Matcher endnu-umatchede Storebox-kvitteringer mod endnu-uhægtede bank-
// transaktioner og hægter varelinjerne på. Idempotent: kun rækker uden match
// behandles, så gentagne kald (fx efter mere bankdata) er sikre.
export async function reconcileUnmatched(): Promise<ReconcileDbResult> {
  const sb = getSupabase()

  // PostgREST returnerer højst ~1000 rækker pr. kald -> hent ALT i sider, ellers
  // får reconcile kun en delmængde og matcher næsten intet.
  const PAGE = 1000
  const txRows: Record<string, unknown>[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from('transactions')
      .select('id, booked_date, text_raw, detail, counterparty, amount, balance, storebox_receipt_id')
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`reconcile tx-fejl: ${error.message}`)
    txRows.push(...((data ?? []) as Record<string, unknown>[]))
    if (!data || data.length < PAGE) break
  }
  const freeTx = txRows.filter((r) => !r.storebox_receipt_id)
  const txIdByIndex: string[] = []
  const bankTxs: ParsedBankTx[] = freeTx.map((r, i) => {
    const row = r as Record<string, unknown>
    txIdByIndex[i] = String(row.id)
    return {
      bookedDate: String(row.booked_date),
      textRaw: String(row.text_raw ?? ''),
      amount: Number(row.amount),
      balance: row.balance == null ? null : Number(row.balance),
      counterparty: String(row.counterparty ?? ''),
      detail: String(row.detail ?? ''),
      ref: '',
    }
  })

  const rcRows: Record<string, unknown>[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from('storebox_receipts')
      .select('receipt_id, receipt_date, purchase_ts, merchant, merchant_city, total_amount, line_items')
      .is('matched_transaction_id', null)
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`reconcile receipts-fejl: ${error.message}`)
    rcRows.push(...((data ?? []) as Record<string, unknown>[]))
    if (!data || data.length < PAGE) break
  }
  const receipts: ParsedReceipt[] = rcRows.map((r) => {
    const row = r as Record<string, unknown>
    return {
      receiptId: String(row.receipt_id),
      purchaseDate: String(row.purchase_ts ?? ''),
      bookedDate: String(row.receipt_date),
      merchantName: String(row.merchant ?? ''),
      merchantCity: (row.merchant_city as string) ?? null,
      total: Number(row.total_amount),
      lines: Array.isArray(row.line_items) ? (row.line_items as ParsedReceiptLine[]) : [],
    }
  })

  const result = reconcile(bankTxs, receipts)
  let matched = 0
  let linesInserted = 0
  for (const m of result.matches) {
    if (!m.tx) continue
    const txId = txIdByIndex[m.txIndex]
    const receiptId = m.receipt.receiptId
    const { error: e1 } = await sb
      .from('storebox_receipts')
      .update({ matched_transaction_id: txId })
      .eq('receipt_id', receiptId)
    if (e1) continue
    await sb
      .from('transactions')
      .update({ storebox_receipt_id: receiptId, updated_at: nowIso() })
      .eq('id', txId)
    const lineRows = m.receipt.lines.map((l, i) => ({
      transaction_id: txId,
      receipt_id: receiptId,
      line_number: i,
      text: l.name,
      amount: l.amount,
    }))
    if (lineRows.length) {
      const { error: e2 } = await sb.from('transaction_lines').insert(lineRows)
      if (!e2) linesInserted += lineRows.length
    }
    matched++
  }
  return { matched, linesInserted }
}

// =============================== LÆSNING ===============================

export type TransactionFilter = { status?: TransactionStatus; limit?: number }

export async function listTransactions(filter: TransactionFilter = {}): Promise<Transaction[]> {
  const sb = getSupabase()
  let q = sb
    .from('transactions')
    .select(TX_COLS)
    .order('booked_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(filter.limit ?? 100)
  if (filter.status) q = q.eq('status', filter.status)
  const { data, error } = await q
  if (error) throw new Error(`listTransactions-fejl: ${error.message}`)
  return (data ?? []).map((r) => rowToTx(r as Record<string, unknown>))
}

// Review-kø: posteringer der trænger til Gustavs blik. Bredt: eksplicit
// needs_review (AI i tvivl) + 'andet'-fald-tilbage + endnu ukategoriseret.
// Nyeste først. Når Gustav giver en rigtig kategori, falder de ud af køen.
export async function listReviewQueue(limit = 40): Promise<Transaction[]> {
  const sb = getSupabase()
  const { data, error } = await sb
    .from('transactions')
    .select(TX_COLS)
    .or('status.eq.needs_review,category.eq.andet,category.is.null')
    .order('booked_date', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`listReviewQueue-fejl: ${error.message}`)
  return (data ?? []).map((r) => rowToTx(r as Record<string, unknown>))
}

export async function getTransaction(id: string): Promise<Transaction | null> {
  const sb = getSupabase()
  const { data, error } = await sb.from('transactions').select(TX_COLS).eq('id', id).maybeSingle()
  if (error) throw new Error(`getTransaction-fejl: ${error.message}`)
  return data ? rowToTx(data as Record<string, unknown>) : null
}

// Anvend en rettelse retroaktivt på ALLE posteringer med samme forretnings-nøgle -
// også dem der allerede var "sikkert" klassificeret. Ret én Hiper -> alle Hiper
// rettes med. Det er bevidst: en forkert AI-kategori (fx Hiper=takeaway) skal kunne
// fanges og fejes væk på tværs af hele historikken, ikke kun i gennemsyns-køen.
//
// Beskyttelse: med includeManual=false (default, fra per-postering-rettelsen)
// overskrives posteringer Gustav SELV har sat manuelt (category_source='manual')
// IKKE, så hans egne valg står. Med includeManual=true (fra forretnings-
// gennemgangen) er rettelsen en bevidst beslutning for hele forretningen og rammer
// også de manuelle. exceptId springer den netop-klikkede postering over.
// Returnerer antal rettede.
export async function applyLearnedCategory(
  token: string,
  category: Category,
  sin: SinTag | null,
  opts: { exceptId?: string; includeManual?: boolean; source?: CategorySource } = {},
): Promise<number> {
  if (!token) return 0
  const sb = getSupabase()
  const candidates: { id: string; text_raw: string }[] = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    let q = sb.from('transactions').select('id, text_raw').range(from, from + PAGE - 1)
    if (!opts.includeManual) q = q.neq('category_source', 'manual')
    const { data, error } = await q
    if (error) throw new Error(`applyLearnedCategory hent-fejl: ${error.message}`)
    const page = (data ?? []) as Record<string, unknown>[]
    for (const r of page) candidates.push({ id: String(r.id), text_raw: String(r.text_raw ?? '') })
    if (page.length < PAGE) break
  }
  const ids = candidates
    .filter((c) => c.id !== opts.exceptId && merchantToken(c.text_raw) === token)
    .map((c) => c.id)
  let updated = 0
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200)
    const { error } = await sb
      .from('transactions')
      .update({
        category,
        sin_tag: sin,
        category_source: opts.source ?? 'rule',
        status: 'classified',
        updated_at: nowIso(),
      })
      .in('id', slice)
    if (error) throw new Error(`applyLearnedCategory update-fejl: ${error.message}`)
    updated += slice.length
  }
  return updated
}

// Grupperer ALLE posteringer pr. forretnings-nøgle (merchantToken) til
// forretnings-gennemgangen. Én række pr. forretning, sorteret efter vægt (antal,
// dernæst samlet forbrug), så Gustav kan rette de tunge forretninger først og
// stoppe når halen er triviel. Viser dominerende kategori/sin + om gruppen er
// blandet, så fejl som "Hiper=takeaway" springer i øjnene. Læser kun (ingen skriv).
export async function listMerchantGroups(
  opts: { includeReviewed?: boolean } = {},
): Promise<MerchantGroup[]> {
  const sb = getSupabase()
  type Row = {
    text_raw: string
    amount: number
    category: string | null
    sin_tag: string | null
    source: string | null
  }
  const rows: Row[] = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from('transactions')
      .select('text_raw, amount, category, sin_tag, category_source')
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`listMerchantGroups-fejl: ${error.message}`)
    const page = (data ?? []) as Record<string, unknown>[]
    for (const r of page) {
      rows.push({
        text_raw: String(r.text_raw ?? ''),
        amount: Number(r.amount) || 0,
        category: (r.category as string) ?? null,
        sin_tag: (r.sin_tag as string) ?? null,
        source: (r.category_source as string) ?? null,
      })
    }
    if (page.length < PAGE) break
  }

  type Acc = {
    count: number
    manualCount: number
    total: number
    spend: number
    cat: Map<string, number>
    sin: Map<string, number>
    labels: Map<string, number>
  }
  const groups = new Map<string, Acc>()
  for (const r of rows) {
    const token = merchantToken(r.text_raw)
    if (!token) continue
    let g = groups.get(token)
    if (!g) {
      g = { count: 0, manualCount: 0, total: 0, spend: 0, cat: new Map(), sin: new Map(), labels: new Map() }
      groups.set(token, g)
    }
    g.count++
    if (r.source === 'manual') g.manualCount++
    g.total += r.amount
    g.spend += Math.abs(r.amount)
    if (r.category) g.cat.set(r.category, (g.cat.get(r.category) ?? 0) + 1)
    if (r.sin_tag) g.sin.set(r.sin_tag, (g.sin.get(r.sin_tag) ?? 0) + 1)
    const lab = r.text_raw.trim()
    if (lab) g.labels.set(lab, (g.labels.get(lab) ?? 0) + 1)
  }

  const topKey = (m: Map<string, number>): string | null => {
    let best: string | null = null
    let n = -1
    for (const [k, v] of m) if (v > n) { best = k; n = v }
    return best
  }

  const out: MerchantGroup[] = []
  for (const [token, g] of groups) {
    // "Gennemgaaet" = hver postering for forretningen er manuelt sat (kun
    // forretnings-Faerdig goer det). Skjules som standard; vis-faerdige tager dem med.
    const reviewed = g.count > 0 && g.manualCount === g.count
    if (reviewed && !opts.includeReviewed) continue
    const domCat = topKey(g.cat)
    const domSin = topKey(g.sin)
    out.push({
      token,
      label: topKey(g.labels) ?? token,
      count: g.count,
      total: Math.round(g.total),
      spend: g.spend,
      category: domCat && isCategory(domCat) ? (domCat as Category) : null,
      sin: domSin && isSinTag(domSin) ? (domSin as SinTag) : null,
      mixed: g.cat.size > 1,
      examples: [...g.labels.keys()].slice(0, 3),
      reviewed,
    })
  }
  out.sort((a, b) => b.count - a.count || b.spend - a.spend)
  return out
}

// Alle posteringer for EN forretning (token), til udfoldningen i forretnings-
// gennemgangen. Samme scan+filter som applyLearnedCategory (token udregnes i kode,
// ingen stored kolonne). Kvitteringer foerst (de har varelinjer at rette), saa
// nyeste; cap saa en tung forretning ikke henter hele historikken.
export async function getMerchantTransactions(
  token: string,
  opts: { limit?: number } = {},
): Promise<Transaction[]> {
  if (!token) return []
  const sb = getSupabase()
  const matched: Transaction[] = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from('transactions')
      .select(TX_COLS)
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`getMerchantTransactions-fejl: ${error.message}`)
    const page = (data ?? []) as Record<string, unknown>[]
    for (const r of page) {
      if (merchantToken(String(r.text_raw ?? '')) === token) matched.push(rowToTx(r))
    }
    if (page.length < PAGE) break
  }
  matched.sort(
    (a, b) =>
      Number(!!b.storebox_receipt_id) - Number(!!a.storebox_receipt_id) ||
      b.booked_date.localeCompare(a.booked_date),
  )
  return matched.slice(0, opts.limit ?? 60)
}

export async function getTransactionLines(transactionId: string): Promise<TransactionLine[]> {
  const sb = getSupabase()
  const { data, error } = await sb
    .from('transaction_lines')
    .select('id, transaction_id, receipt_id, line_number, text, amount, category, sin_tag')
    .eq('transaction_id', transactionId)
    .order('line_number', { ascending: true })
  if (error) throw new Error(`getTransactionLines-fejl: ${error.message}`)
  return (data ?? []).map((r) => {
    const row = r as Record<string, unknown>
    return {
      id: String(row.id),
      transaction_id: String(row.transaction_id),
      receipt_id: (row.receipt_id as string) ?? null,
      line_number: Number(row.line_number),
      text: String(row.text ?? ''),
      amount: Number(row.amount),
      category: (row.category as Category) ?? null,
      sin_tag: (row.sin_tag as SinTag) ?? null,
    }
  })
}

// Manuel rettelse af EN varelinje (fx "cola" -> sin sodavand). transaction_lines
// har hverken category_source, status eller updated_at - vi roerer kun category +
// sin_tag. Skriver bevidst INGEN forretnings-regel (en linje er et konkret koeb,
// ikke en regel for hele forretningen).
export async function setTransactionLineCategory(
  lineId: string,
  category: Category | null,
  sinTag: SinTag | null,
): Promise<void> {
  const sb = getSupabase()
  const { error } = await sb
    .from('transaction_lines')
    .update({ category, sin_tag: sinTag })
    .eq('id', lineId)
  if (error) throw new Error(`setTransactionLineCategory-fejl: ${error.message}`)
}

// =============================== NETTOFORMUE ===============================

const round2 = (n: number) => Math.round(n * 100) / 100

// Dagens luk-saldo ud fra dagens rækker: den saldo der ikke er nogen andens
// "før-saldo" (= balance - amount). Korrekt uden gemt sekvens og uafhængigt af
// import-rækkefølge. Delt af closingBalanceOnOrBefore + backfillNetWorthSnapshots.
function dayClosingBalance(txns: Array<{ balance: number; amount: number }>): number | null {
  if (txns.length === 0) return null
  if (txns.length === 1) return txns[0].balance
  const befores = new Set(txns.map((t) => round2(t.balance - t.amount)))
  const finals = txns.filter((t) => !befores.has(round2(t.balance)))
  if (finals.length === 1) return finals[0].balance
  // Fallback (uventet kæde, fx indsættelse + køb der nuller ud): laveste saldo.
  return finals[0]?.balance ?? txns.reduce((m, t) => Math.min(m, t.balance), txns[0].balance)
}

// Luk-saldo på den seneste dag med posteringer på/før en dato (YMD). Same-day-
// rækkefølge er IKKE gemt (bulk-insert bevarer den ikke), så vi rekonstruerer
// den deterministisk fra saldo-kæden: dagens luk-saldo er den saldo der ikke er
// nogen anden posterings "før-saldo" (= balance - amount). Korrekt uden at gemme
// en sekvens, og uafhængigt af import-rækkefølge.
async function closingBalanceOnOrBefore(dateYmd: string): Promise<number | null> {
  const sb = getSupabase()
  const { data: dayRows, error: de } = await sb
    .from('transactions')
    .select('booked_date')
    .lte('booked_date', dateYmd)
    .not('balance', 'is', null)
    .order('booked_date', { ascending: false })
    .limit(1)
  if (de) throw new Error(`closingBalance dag-fejl: ${de.message}`)
  const maxDate = (dayRows?.[0] as Record<string, unknown> | undefined)?.booked_date
  if (!maxDate) return null

  const { data: rows, error: re } = await sb
    .from('transactions')
    .select('balance, amount')
    .eq('booked_date', maxDate as string)
    .not('balance', 'is', null)
  if (re) throw new Error(`closingBalance rækker-fejl: ${re.message}`)
  const txns = (rows ?? []).map((r) => {
    const row = r as Record<string, unknown>
    return { balance: Number(row.balance), amount: Number(row.amount) }
  })
  return dayClosingBalance(txns)
}

export async function getNetWorth(): Promise<NetWorth> {
  const today = todayCphYmd()
  const checking = (await closingBalanceOnOrBefore(today)) ?? 0
  const yestBal = (await closingBalanceOnOrBefore(addDaysYmd(today, -1))) ?? checking
  const monthBal = (await closingBalanceOnOrBefore(addMonthsYmd(today, -1))) ?? checking
  const yearBal = (await closingBalanceOnOrBefore(addMonthsYmd(today, -12))) ?? checking

  const balances = await listManualBalances()
  const assets = balances.filter((b) => b.kind === 'asset')
  const liabilities = balances.filter((b) => b.kind === 'liability')
  const manualNet =
    assets.reduce((a, b) => a + b.amount, 0) - liabilities.reduce((a, b) => a + b.amount, 0)

  return {
    netWorth: checking + manualNet,
    checking,
    // Kun checking-saldoen ændrer sig dagligt; manuelle balancer antages konstante
    // mellem redigeringer, så svinget afspejler den daglige konto-bevægelse.
    daySwing: checking - yestBal,
    monthSwing: checking - monthBal,
    yearSwing: checking - yearBal,
    assets,
    liabilities,
  }
}

// =============================== SYNDEUDGIFTER ===============================

// Forbrug pr. sin_tag denne måned. Kombinerer forretnings-niveau (transaktioner
// uden varelinjer) og varelinje-niveau (præcist, fra matchede kvitteringer).
// Ingen dobbelttælling: en transaktion med varelinjer får sin_tag på LINJERNE,
// ikke på transaktionen (se classifyTransaction).
export async function getSinSummary(): Promise<SinSummary[]> {
  const sb = getSupabase()
  const monthStart = todayCphYmd().slice(0, 7) + '-01'
  const totals = new Map<SinTag, number>()

  const { data: txs, error: te } = await sb
    .from('transactions')
    .select('amount, sin_tag')
    .gte('booked_date', monthStart)
    .not('sin_tag', 'is', null)
  if (te) throw new Error(`getSinSummary tx-fejl: ${te.message}`)
  for (const r of txs ?? []) {
    const row = r as Record<string, unknown>
    if (isSinTag(row.sin_tag)) totals.set(row.sin_tag, (totals.get(row.sin_tag) ?? 0) + Math.abs(Number(row.amount)))
  }

  const { data: lines, error: le } = await sb
    .from('transaction_lines')
    .select('amount, sin_tag, transactions!inner(booked_date)')
    .not('sin_tag', 'is', null)
    .gte('transactions.booked_date', monthStart)
  if (le) throw new Error(`getSinSummary lines-fejl: ${le.message}`)
  for (const r of lines ?? []) {
    const row = r as Record<string, unknown>
    if (isSinTag(row.sin_tag)) totals.set(row.sin_tag, (totals.get(row.sin_tag) ?? 0) + Math.abs(Number(row.amount)))
  }

  return [...totals.entries()]
    .map(([tag, amount]) => ({ tag, amount: Math.round(amount) }))
    .sort((a, b) => b.amount - a.amount)
}

// Ugens finans-resumé til den ugentlige review (Modul 5): nettoformue, ugens
// konto-Δ (checking nu vs. 7 dage siden) + denne måneds syndeudgifter.
// Genbruger getNetWorth (checking + nettoformue) og closingBalanceOnOrBefore
// (saldo-kæden) i stedet for at duplikere logik.
export async function getWeeklyFinanceSummary(): Promise<{
  netWorth: number
  checking: number
  weekSwing: number
  sins: SinSummary[]
}> {
  const nw = await getNetWorth()
  const weekAgo = (await closingBalanceOnOrBefore(addDaysYmd(todayCphYmd(), -7))) ?? nw.checking
  const sins = await getSinSummary()
  return {
    netWorth: nw.netWorth,
    checking: nw.checking,
    weekSwing: round2(nw.checking - weekAgo),
    sins,
  }
}

// ============================ NETTOFORMUE-HISTORIK ============================

// Skriv (upsert) ét dagligt snapshot. checking = luk-saldo på/før datoen;
// manuelle balancer er dem der gælder NU (vi har ingen historik på dem, så
// kurvens FORM afspejler konto-saldoen). Idempotent pr. snapshot_date.
export async function snapshotNetWorth(dateYmd?: string): Promise<void> {
  const date = dateYmd ?? todayCphYmd()
  const checking = (await closingBalanceOnOrBefore(date)) ?? 0
  const balances = await listManualBalances()
  const assets = balances.filter((b) => b.kind === 'asset')
  const liabilities = balances.filter((b) => b.kind === 'liability')
  const manualNet =
    assets.reduce((a, b) => a + b.amount, 0) - liabilities.reduce((a, b) => a + b.amount, 0)
  const sb = getSupabase()
  const { error } = await sb.from('net_worth_snapshots').upsert(
    {
      snapshot_date: date,
      checking: round2(checking),
      other_assets: assets,
      liabilities,
      net_worth: round2(checking + manualNet),
    },
    { onConflict: 'snapshot_date' },
  )
  if (error) throw new Error(`snapshotNetWorth-fejl: ${error.message}`)
}

// Genopbyg HELE kurven fra bank-saldoens historik. Henter alle posteringer ÉN
// gang (pagineret - PostgREST capper på 1000), grupperer pr. dato, regner dagens
// luk-saldo, og bulk-upserter ét snapshot pr. transaktionsdag (saldoen ændrer
// sig kun på dage med posteringer). Manuelle balancer = nuværende for alle dage.
// Idempotent. Kaldes efter hver bank-import + kan køres manuelt.
export async function backfillNetWorthSnapshots(): Promise<number> {
  const sb = getSupabase()
  const PAGE = 1000
  const byDate = new Map<string, Array<{ balance: number; amount: number }>>()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from('transactions')
      .select('booked_date, balance, amount')
      .not('balance', 'is', null)
      .order('booked_date', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`backfill hent-fejl: ${error.message}`)
    const rows = data ?? []
    for (const r of rows) {
      const row = r as Record<string, unknown>
      const d = String(row.booked_date)
      const arr = byDate.get(d) ?? []
      arr.push({ balance: Number(row.balance), amount: Number(row.amount) })
      byDate.set(d, arr)
    }
    if (rows.length < PAGE) break
  }
  if (byDate.size === 0) return 0

  const balances = await listManualBalances()
  const assets = balances.filter((b) => b.kind === 'asset')
  const liabilities = balances.filter((b) => b.kind === 'liability')
  const manualNet =
    assets.reduce((a, b) => a + b.amount, 0) - liabilities.reduce((a, b) => a + b.amount, 0)

  const snapshots = [...byDate.entries()]
    .map(([date, txns]) => {
      const checking = dayClosingBalance(txns)
      if (checking === null) return null
      return {
        snapshot_date: date,
        checking: round2(checking),
        other_assets: assets,
        liabilities,
        net_worth: round2(checking + manualNet),
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)

  for (const part of chunk(snapshots, 500)) {
    const { error } = await sb.from('net_worth_snapshots').upsert(part, { onConflict: 'snapshot_date' })
    if (error) throw new Error(`backfill upsert-fejl: ${error.message}`)
  }
  return snapshots.length
}

// Nettoformue-kurven: snapshots i et vindue (default 180 dage), stigende dato.
export async function getNetWorthHistory(days = 180): Promise<NetWorthPoint[]> {
  const sb = getSupabase()
  const since = addDaysYmd(todayCphYmd(), -days)
  const { data, error } = await sb
    .from('net_worth_snapshots')
    .select('snapshot_date, checking, net_worth')
    .gte('snapshot_date', since)
    .order('snapshot_date', { ascending: true })
  if (error) throw new Error(`getNetWorthHistory-fejl: ${error.message}`)
  return (data ?? []).map((r) => {
    const row = r as Record<string, unknown>
    return {
      date: String(row.snapshot_date),
      netWorth: Number(row.net_worth ?? 0),
      checking: Number(row.checking ?? 0),
    }
  })
}

// =============================== MANUELLE BALANCER ===============================

export async function listManualBalances(): Promise<ManualBalance[]> {
  const sb = getSupabase()
  const { data, error } = await sb
    .from('manual_balances')
    .select('id, label, amount, kind, sort')
    .order('sort', { ascending: true })
    .order('label', { ascending: true })
  if (error) throw new Error(`listManualBalances-fejl: ${error.message}`)
  return (data ?? []).map((r) => {
    const row = r as Record<string, unknown>
    return {
      id: String(row.id),
      label: String(row.label ?? ''),
      amount: Number(row.amount),
      kind: row.kind === 'liability' ? 'liability' : 'asset',
      sort: Number(row.sort ?? 0),
    }
  })
}

export async function upsertManualBalance(input: {
  id?: string
  label: string
  amount: number
  kind: 'asset' | 'liability'
}): Promise<void> {
  const sb = getSupabase()
  const payload = {
    label: input.label.trim(),
    amount: input.amount,
    kind: input.kind,
    updated_at: nowIso(),
  }
  if (input.id) {
    const { error } = await sb.from('manual_balances').update(payload).eq('id', input.id)
    if (error) throw new Error(`upsertManualBalance-fejl: ${error.message}`)
  } else {
    const { error } = await sb.from('manual_balances').insert(payload)
    if (error) throw new Error(`upsertManualBalance-fejl: ${error.message}`)
  }
}

export async function deleteManualBalance(id: string): Promise<void> {
  const sb = getSupabase()
  const { error } = await sb.from('manual_balances').delete().eq('id', id)
  if (error) throw new Error(`deleteManualBalance-fejl: ${error.message}`)
}

// =============================== KATEGORI-REDIGERING ===============================

// Sætter kategori/sin manuelt (fra review-køen). Rydder needs_review.
export async function setTransactionCategory(
  id: string,
  category: Category | null,
  sinTag: SinTag | null,
  source: CategorySource = 'manual',
): Promise<void> {
  const sb = getSupabase()
  const { error } = await sb
    .from('transactions')
    .update({
      category,
      sin_tag: sinTag,
      category_source: source,
      status: 'classified',
      updated_at: nowIso(),
    })
    .eq('id', id)
  if (error) throw new Error(`setTransactionCategory-fejl: ${error.message}`)
}
