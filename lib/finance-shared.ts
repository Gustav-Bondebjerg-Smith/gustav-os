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
// En kategori-vaerdi er en fri streng (noegle). De faste staar i CATEGORIES ovenfor;
// Gustav kan tilfoeje egne via lib/finance-categories. Valideres i runtime (mod den
// merged liste), ikke i typen - derfor string og ikke et lukket union.
export type Category = string
export const CATEGORY_LABEL: Record<string, string> = {
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
// Er v en af de FASTE kategorier? (Brugerdefinerede valideres server-side mod den
// merged liste, ikke her - finance-shared er klient-sikker uden DB-adgang.)
export function isCategory(v: unknown): v is Category {
  return typeof v === 'string' && (CATEGORIES as readonly string[]).includes(v)
}

// En kategori i UI'et: noegle + visningsnavn + om den er fast (kan ikke slettes).
// Bygges server-side (faste + Gustavs egne) og sendes som prop til klient-selects.
export type CategoryDef = { key: string; label: string; builtin: boolean }

// Syndeudgifter: altid-synlige dårlige vaner. Konfigurerbar liste. En postering/
// varelinje kan have et sin_tag UDEN at det ændrer kategorien (fx alkohol-linje i
// et dagligvarekøb).
export const SIN_TAGS = ['takeaway', 'alkohol', 'spil', 'sodavand', 'energidrik', 'snacks'] as const
// SinTag er IKKE laengere en lukket union: Gustav kan tilfoeje egne synder (gemt i
// memory_facts, scope 'finance_sin' - se lib/finance-sins.ts). Valideres i RUNTIME mod
// den merged liste, ikke i typen. De faste noegler bliver staaende i SIN_TAGS (AI + data
// peger paa dem). Spejler hvordan Category blev loesnet til string.
export type SinTag = string
export const SIN_LABEL: Record<string, string> = {
  takeaway: 'Takeaway',
  alkohol: 'Alkohol',
  spil: 'Spil',
  sodavand: 'Sodavand',
  energidrik: 'Energidrik',
  snacks: 'Snacks & slik',
}
// KUN de FASTE synder (bruges hvor built-in-semantik er noedvendig). Brugerdefinerede
// synder valideres mod loadSins(), ikke her.
export function isSinTag(v: unknown): v is SinTag {
  return typeof v === 'string' && (SIN_TAGS as readonly string[]).includes(v)
}
// En synd i UI'et: noegle + visningsnavn + om den er fast (kan ikke slettes). Spejler
// CategoryDef. Bygges server-side (faste + Gustavs egne) og sendes som prop til selects.
export type SinDef = { key: string; label: string; builtin: boolean }

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
  yearSwing: number // Δ siden for 12 måneder siden
  assets: ManualBalance[]
  liabilities: ManualBalance[]
}

export type SinSummary = {
  tag: SinTag
  label: string // visningsnavn (fast eller brugerdefineret) - resolves i getSinSummary
  amount: number // forbrug denne måned på dette sin_tag
}

// Én forretning i "gennemgå pr. forretning"-viewet: alle posteringer med samme
// merchantToken foldet sammen. Klient-sikker (vist i FinanceMerchantReview).
export type MerchantGroup = {
  token: string
  label: string // hyppigste rå tekst, vist til Gustav
  count: number
  total: number // sum beløb (negativ = udgift)
  spend: number // sum |beløb|, til vægtning
  category: Category | null // dominerende kategori i gruppen
  sin: SinTag | null // dominerende sin i gruppen
  mixed: boolean // spænder over flere kategorier
  examples: string[] // op til 3 eksempel-tekster
  reviewed: boolean // alle posteringer er manuelt sat = forretningen er gennemgaaet
}

// Én vare i forretnings-udfoldningen: alle varelinjer med samme productKey foldet
// sammen (fx alle "Pepsi Max"-linjer). Klient-sikker. Vist i FinanceMerchantLines.
export type ProductGroup = {
  key: string
  label: string // hyppigste raa varenavn
  count: number
  total: number // sum beloeb for varen
  category: Category | null // dominerende kategori
  sin: SinTag | null // dominerende sin
  mixed: boolean // flere kategorier paa tvaers
}

// Ét punkt på nettoformue-kurven (et dagligt snapshot). checking = bank-saldo,
// netWorth = checking + manuelle balancer (historisk antaget = nuværende).
export type NetWorthPoint = {
  date: string // YYYY-MM-DD
  netWorth: number
  checking: number
}

// Renser tekstfelter før DB: fjerner kontroltegn (inkl. NUL 0x00, som Postgres'
// text-type ikke kan gemme - latin1-dekodning af en 0x00-byte giver U+0000) og
// kollapser whitespace. Regex bygges fra en streng, så kilden kun har printbar
// ASCII (ingen literal NUL-byte i .ts-filen). Bruges af begge parsere.
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F]', 'g')
export function cleanText(s: string | null | undefined): string {
  return (s ?? '').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim()
}

// --- Lærende kategori-regler (spørge-loop) ---

// Støj-ord i bank-tekst der ikke identificerer en forretning.
const MERCHANT_NOISE = new Set([
  'kob', 'kort', 'den', 'via', 'visa', 'mastercard', 'mobilepay', 'pay', 'paypal',
  'wallet', 'google', 'apple', 'samsung', 'oneplus', 'klarna', 'izettle', 'sumup', 'nan',
])
const DIACRITICS = new RegExp('[\\u0300-\\u036f]', 'g')

// Stabil forretnings-nøgle udledt af bank-teksten. Bruges som key for en lært
// regel, så en rettelse på fx "NETTO 7103" auto-anvendes på al fremtidig "NETTO".
// VIGTIGT: udledes ALTID fra bank-teksten (samme @-korruption af ø/å begge veje),
// så lært og anvendt nøgle matcher. Nøglen er intern, ikke vist til Gustav.
export function merchantToken(text: string): string {
  const norm = (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  for (const t of norm.split(' ')) {
    if (t.length >= 3 && !/^\d+$/.test(t) && !MERCHANT_NOISE.has(t)) return t
  }
  return norm.split(' ')[0] ?? ''
}

// Stabil vare-nøgle udledt af varelinjens tekst (fx "PEPSI MAX *" -> "pepsi max").
// Folder ens varer sammen på tværs af kvitteringer og bruges til global vare-
// rettelse. Beholder HELE det normaliserede navn (modsat merchantToken, der kun
// tager første ord), så forskellige varer ikke kollapser til samme nøgle.
export function productKey(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Lært regel <-> memory_facts.content (scope 'finance', key = merchantToken).
// Fast format jeg selv skriver + parser, så anvendelsen er deterministisk.
export function formatFinanceRule(category: Category, sin: SinTag | null): string {
  return `kategori=${category}; sin=${sin ?? 'ingen'}`
}
export function parseFinanceRule(content: string): { category: Category | null; sin: SinTag | null } {
  const cm = (content || '').match(/kategori=([a-zæøå]+)/i)
  const sm = (content || '').match(/sin=([a-zæøå]+)/i)
  return {
    // Kategori-noeglen kan vaere brugerdefineret -> valider IKKE mod de faste her.
    // Reglen blev skrevet med en gyldig noegle (saveFinanceRule), saa den er paalidelig.
    category: cm ? cm[1].toLowerCase() : null,
    // Sin-noeglen kan vaere brugerdefineret -> valider IKKE mod de faste. 'ingen' er
    // sentinel for "ingen synd" (jf. formatFinanceRule), saa den mappes til null.
    sin: sm && sm[1].toLowerCase() !== 'ingen' ? sm[1].toLowerCase() : null,
  }
}
