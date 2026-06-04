// Klient-sikre typer + konstanter for finans-modulet (Modul 4). INGEN server-only
// imports her, så server-libs, klient-komponenter OG test-scripts kan importere det
// samme. lib/finance.ts (server-only) re-eksporterer alt herfra.

// Faste kategorier (Haiku kategoriserer hver postering/varelinje til præcis én).
export const CATEGORIES = [
  'dagligvarer',
  'ude',
  'transport',
  'bolig',
  'abonnement',
  'helbred',
  'studie',
  'opsparing',
  'indkomst',
  'andet',
] as const
export type Category = (typeof CATEGORIES)[number]
export const CATEGORY_LABEL: Record<Category, string> = {
  dagligvarer: 'Dagligvarer',
  ude: 'Ude/restaurant',
  transport: 'Transport',
  bolig: 'Bolig',
  abonnement: 'Abonnement',
  helbred: 'Helbred',
  studie: 'Studie',
  opsparing: 'Opsparing/overførsel',
  indkomst: 'Indkomst',
  andet: 'Andet',
}
export function isCategory(v: unknown): v is Category {
  return typeof v === 'string' && (CATEGORIES as readonly string[]).includes(v)
}

// Syndeudgifter: altid-synlige dårlige vaner. Konfigurerbar liste. En postering/
// varelinje kan have et sin_tag UDEN at det ændrer kategorien (fx alkohol-linje i
// et dagligvarekøb).
export const SIN_TAGS = ['takeaway', 'alkohol', 'spil', 'sodavand', 'energidrik', 'snacks'] as const
export type SinTag = (typeof SIN_TAGS)[number]
export const SIN_LABEL: Record<SinTag, string> = {
  takeaway: 'Takeaway',
  alkohol: 'Alkohol',
  spil: 'Spil',
  sodavand: 'Sodavand',
  energidrik: 'Energidrik',
  snacks: 'Snacks & slik',
}
export function isSinTag(v: unknown): v is SinTag {
  return typeof v === 'string' && (SIN_TAGS as readonly string[]).includes(v)
}

export type TransactionStatus = 'classified' | 'needs_review'
export type CategorySource = 'ai' | 'manual' | 'rule' | 'storebox'

// --- Rå parse-output (før DB, endnu ukategoriseret) ---

// Én bank-postering parset fra CSV'en.
export type ParsedBankTx = {
  bookedDate: string // YYYY-MM-DD (konverteret fra DD-MM-YYYY)
  textRaw: string // kort tekst (kolonne 5)
  amount: number // negativ = udgift, positiv = indkomst (komma-decimal -> number)
  balance: number | null // kontosaldo efter posteringen (kolonne 7) - driver nettoformue
  counterparty: string // kolonne 8 (fx MobilePay-lokation), ofte tom
  detail: string // kolonne 9 (Forretning/By/Terminal/Kortnr) - rig tekst til matchning
  ref: string // kolonne 3 (reference/afstemnings-id), ofte tom
}

// Én varelinje fra en Storebox-kvittering.
export type ParsedReceiptLine = {
  name: string
  count: number
  amount: number // linjens totalpris (kan være negativ, fx "Rabat")
  productNumber: string | null
  storeboxCategory: string | null
}

// Én Storebox-kvittering, normaliseret fra eksportens JSON.
export type ParsedReceipt = {
  receiptId: string // stabil unik id fra Storebox -> idempotens (intet content-hash nødvendigt)
  purchaseDate: string // ISO med tidszone, fx 2026-05-11T15:22:09+02:00
  bookedDate: string // YYYY-MM-DD (lokal kalenderdag)
  merchantName: string
  merchantCity: string | null
  total: number // price.amount (positivt beløb)
  lines: ParsedReceiptLine[]
}

// --- DB-rækker (efter import + klassificering) ---

export type Transaction = {
  id: string
  booked_date: string // YYYY-MM-DD
  text_raw: string
  detail: string
  counterparty: string
  amount: number
  balance: number | null
  category: Category | null
  sin_tag: SinTag | null
  category_source: CategorySource
  status: TransactionStatus
  storebox_receipt_id: string | null
  note: string | null
  created_at: string
  updated_at: string
}

export type TransactionLine = {
  id: string
  transaction_id: string
  receipt_id: string | null
  line_number: number
  text: string
  amount: number
  category: Category | null
  sin_tag: SinTag | null
}

export type ManualBalance = {
  id: string
  label: string
  amount: number
  kind: 'asset' | 'liability'
  sort: number
}

// Aggregeret nettoformue til forside-kortet.
export type NetWorth = {
  netWorth: number
  checking: number // seneste konto-saldo fra CSV
  daySwing: number // Δ siden i går
  monthSwing: number // Δ siden sidste måned
  assets: ManualBalance[]
  liabilities: ManualBalance[]
}

export type SinSummary = {
  tag: SinTag
  amount: number // forbrug denne måned på dette sin_tag
}

// Renser tekstfelter før DB: fjerner kontroltegn (inkl. NUL 0x00, som Postgres'
// text-type ikke kan gemme - latin1-dekodning af en 0x00-byte giver U+0000) og
// kollapser whitespace. Regex bygges fra en streng, så kilden kun har printbar
// ASCII (ingen literal NUL-byte i .ts-filen). Bruges af begge parsere.
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F]', 'g')
export function cleanText(s: string | null | undefined): string {
  return (s ?? '').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim()
}
