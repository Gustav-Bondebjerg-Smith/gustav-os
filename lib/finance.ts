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
  type SinSummary,
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

// Anvend en lært regel retroaktivt: sæt kategori/sin på ALLE endnu-usikre
// posteringer (needs_review / 'andet' / ukategoriseret) med samme forretnings-
// nøgle. Rører ALDRIG en sikkert klassificeret postering. Returnerer antal.
// Det er "OS'en bliver klogere": ret én Netto -> alle usikre Netto rettes med.
export async function applyLearnedCategory(
  token: string,
  category: Category,
  sin: SinTag | null,
): Promise<number> {
  if (!token) return 0
  const sb = getSupabase()
  const candidates: { id: string; text_raw: string }[] = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from('transactions')
      .select('id, text_raw')
      .or('status.eq.needs_review,category.eq.andet,category.is.null')
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`applyLearnedCategory hent-fejl: ${error.message}`)
    const page = (data ?? []) as Record<string, unknown>[]
    for (const r of page) candidates.push({ id: String(r.id), text_raw: String(r.text_raw ?? '') })
    if (page.length < PAGE) break
  }
  const ids = candidates.filter((c) => merchantToken(c.text_raw) === token).map((c) => c.id)
  let updated = 0
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200)
    const { error } = await sb
      .from('transactions')
      .update({
        category,
        sin_tag: sin,
        category_source: 'rule',
        status: 'classified',
        updated_at: nowIso(),
      })
      .in('id', slice)
    if (error) throw new Error(`applyLearnedCategory update-fejl: ${error.message}`)
    updated += slice.length
  }
  return updated
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

// =============================== NETTOFORMUE ===============================

const round2 = (n: number) => Math.round(n * 100) / 100

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
  if (txns.length === 0) return null
  if (txns.length === 1) return txns[0].balance

  const befores = new Set(txns.map((t) => round2(t.balance - t.amount)))
  const finals = txns.filter((t) => !befores.has(round2(t.balance)))
  if (finals.length === 1) return finals[0].balance
  // Fallback (uventet kæde, fx indsættelse + køb der nuller ud): laveste saldo.
  return finals[0]?.balance ?? txns.reduce((m, t) => Math.min(m, t.balance), txns[0].balance)
}

export async function getNetWorth(): Promise<NetWorth> {
  const today = todayCphYmd()
  const checking = (await closingBalanceOnOrBefore(today)) ?? 0
  const yestBal = (await closingBalanceOnOrBefore(addDaysYmd(today, -1))) ?? checking
  const monthBal = (await closingBalanceOnOrBefore(addMonthsYmd(today, -1))) ?? checking

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
