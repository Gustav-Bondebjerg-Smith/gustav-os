// Server actions for finans-siden (Modul 4). Hver action auth-gater selv mod
// ALLOWED_EMAIL (server actions er ikke garanteret dækket af proxy-matcheren) og
// revaliderer /finans + forsiden. Selve skrivningen sker i lib/finance.ts.
'use server'
import { revalidatePath } from 'next/cache'
import { getServerSupabase } from '@/lib/supabase-server'
import {
  importBankCsv,
  importStoreboxReceipts,
  reconcileUnmatched,
  upsertManualBalance,
  deleteManualBalance,
  setTransactionCategory,
  setTransactionLineCategory,
  getTransactionLines,
  getTransaction,
  getMerchantLineGroups,
  setProductLineCategory,
  applyLearnedCategory,
  backfillNetWorthSnapshots,
} from '@/lib/finance'
import { saveFinanceRule } from '@/lib/finance-classify'
import { sendTelegramMessage } from '@/lib/telegram'
import { isSinTag, merchantToken, type TransactionLine, type ProductGroup } from '@/lib/finance-shared'
import { loadCategories, addCategory, deleteCategory } from '@/lib/finance-categories'
import type { FinanceActionResult, ImportResult } from './state'

async function authedEmail(): Promise<string | null> {
  const allowed = process.env.ALLOWED_EMAIL?.trim().toLowerCase()
  if (!allowed) return null
  const sb = await getServerSupabase()
  const { data } = await sb.auth.getUser()
  const email = data.user?.email?.toLowerCase()
  return email && email === allowed ? email : null
}

function revalidate(): void {
  revalidatePath('/finans')
  revalidatePath('/')
}

// Valider en kategori-noegle mod den merged liste (faste + Gustavs egne). Returnerer
// {key,label} eller null (tom/ukendt). Ét lille opslag pr. gem - fint interaktivt.
async function resolveCat(category: string): Promise<{ key: string; label: string } | null> {
  if (!category) return null
  const cats = await loadCategories()
  const hit = cats.find((c) => c.key === category)
  return hit ? { key: hit.key, label: hit.label } : null
}

// Kort proaktiv opsummering på Telegram. Best-effort - må aldrig vælte importen.
async function notify(text: string): Promise<void> {
  try {
    await sendTelegramMessage(text)
  } catch (e) {
    console.error('Telegram-opsummering fejlede:', e)
  }
}

// Bank-CSV upload. Filen er ISO-8859-1 (dansk bank-eksport) -> dekod som latin1.
export async function importBankAction(formData: FormData): Promise<ImportResult> {
  if (!(await authedEmail())) return { ok: false, message: 'Ikke logget ind.' }
  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: 'Vælg en CSV-fil.' }
  try {
    const buf = Buffer.from(await file.arrayBuffer())
    const res = await importBankCsv(buf.toString('latin1'), file.name)
    // Udvid nettoformue-kurven med de nye dage (best-effort - må ikke vælte importen).
    await backfillNetWorthSnapshots().catch((e) => console.error('backfill efter bank-import fejlede:', e))
    await notify(
      `💳 Bank importeret: ${res.inserted} nye posteringer (af ${res.parsed}).` +
        (res.inserted > 0 ? ' Kategoriseres i baggrunden.' : ''),
    )
    revalidate()
    return { ok: true, message: `${res.inserted} nye posteringer importeret (af ${res.parsed} i filen).` }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

// Storebox upload: vælg receipts-*.json fra eksport-mappen. UTF-8.
export async function importStoreboxAction(formData: FormData): Promise<ImportResult> {
  if (!(await authedEmail())) return { ok: false, message: 'Ikke logget ind.' }
  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: 'Vælg en receipts-*.json fil.' }
  try {
    const text = await file.text()
    const res = await importStoreboxReceipts(text, file.name)
    await notify(
      `🧾 Storebox importeret: ${res.insertedReceipts} nye kvitteringer, ${res.matched} matchet mod bank, ${res.linesInserted} varelinjer.`,
    )
    revalidate()
    return {
      ok: true,
      message: `${res.insertedReceipts} nye kvitteringer, ${res.matched} matchet mod bank, ${res.linesInserted} varelinjer hægtet på.`,
    }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

// Kør reconciliation igen (fx efter mere bankdata).
export async function reconcileAction(): Promise<ImportResult> {
  if (!(await authedEmail())) return { ok: false, message: 'Ikke logget ind.' }
  try {
    const res = await reconcileUnmatched()
    revalidate()
    return { ok: true, message: `${res.matched} nye kvitteringer matchet, ${res.linesInserted} varelinjer hægtet på.` }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

export async function addManualBalanceAction(
  label: string,
  amount: number,
  kind: 'asset' | 'liability',
): Promise<FinanceActionResult> {
  if (!(await authedEmail())) return { ok: false, message: 'Ikke logget ind.' }
  if (!label.trim()) return { ok: false, message: 'Skriv et navn.' }
  if (!Number.isFinite(amount)) return { ok: false, message: 'Ugyldigt beløb.' }
  if (kind !== 'asset' && kind !== 'liability') return { ok: false, message: 'Ugyldig type.' }
  try {
    await upsertManualBalance({ label: label.trim(), amount, kind })
    revalidate()
    return { ok: true }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

export async function deleteManualBalanceAction(id: string): Promise<FinanceActionResult> {
  if (!(await authedEmail())) return { ok: false, message: 'Ikke logget ind.' }
  try {
    await deleteManualBalance(id)
    revalidate()
    return { ok: true }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

// Manuel kategori/sin fra review-køen.
export async function setCategoryAction(
  id: string,
  category: string,
  sinTag: string | null,
): Promise<FinanceActionResult> {
  if (!(await authedEmail())) return { ok: false, message: 'Ikke logget ind.' }
  const hit = await resolveCat(category)
  const cat = hit?.key ?? null
  const sin = isSinTag(sinTag) ? sinTag : null
  try {
    await setTransactionCategory(id, cat, sin, 'manual')

    // Lær af rettelsen: gem en regel for forretningen + anvend den retroaktivt på
    // lignende usikre posteringer ("OS'en bliver klogere"). Best-effort - en
    // lærings-fejl må aldrig vælte selve kategori-rettelsen.
    let alsoUpdated = 0
    if (cat) {
      try {
        const tx = await getTransaction(id)
        const token = tx ? merchantToken(tx.text_raw) : ''
        if (token) {
          await saveFinanceRule(token, cat, sin)
          // Per-postering-rettelse: kaskadér til ALLE ens posteringer (også sikre),
          // men rør ikke Gustavs egne tidligere manuelle valg (includeManual=false).
          alsoUpdated = await applyLearnedCategory(token, cat, sin, { exceptId: id })
        }
      } catch (e) {
        console.error('finans-læring fejlede (kategori sat alligevel):', e)
      }
    }

    revalidate()
    return {
      ok: true,
      message:
        alsoUpdated > 0
          ? `Lært. ${alsoUpdated} lignende postering${alsoUpdated === 1 ? '' : 'er'} rettet med.`
          : undefined,
    }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

// Lazy-load varelinjer når en postering foldes ud.
export async function getLinesAction(transactionId: string): Promise<TransactionLine[]> {
  if (!(await authedEmail())) return []
  try {
    return await getTransactionLines(transactionId)
  } catch {
    return []
  }
}

// Forretnings-gennemgang: sæt kategori/sin for en HEL forretning (alle posteringer
// med samme merchantToken) i ét klik. Gemmer reglen + kaskaderer til hele gruppen,
// inkl. tidligere manuelle (includeManual=true) - her ER beslutningen forretnings-
// dækkende og bevidst. Returnerer hvor mange posteringer der blev rettet.
export async function setMerchantCategoryAction(
  token: string,
  category: string,
  sinTag: string | null,
): Promise<FinanceActionResult> {
  if (!(await authedEmail())) return { ok: false, message: 'Ikke logget ind.' }
  if (!token) return { ok: false, message: 'Ukendt forretning.' }
  const hit = await resolveCat(category)
  const cat = hit?.key ?? null
  const sin = isSinTag(sinTag) ? sinTag : null
  if (!cat) return { ok: false, message: 'Vælg en kategori.' }
  try {
    await saveFinanceRule(token, cat, sin)
    // source:'manual' paa HELE forretningen = den er gennemgaaet og forsvinder fra
    // listen (kun denne forretnings-handling saetter alle til manual).
    const n = await applyLearnedCategory(token, cat, sin, { includeManual: true, source: 'manual' })
    revalidate()
    return {
      ok: true,
      message: `Markeret færdig. ${n} postering${n === 1 ? '' : 'er'} sat til ${hit?.label ?? cat}${sin ? ' · ' + sin : ''}.`,
    }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

// Manuel rettelse af EN varelinje (fx cola -> sodavand). Skriver KUN linjen: ingen
// forretnings-regel, ingen kaskade (en linje er et konkret koeb). Synde-kortet
// opdateres af getSinSummary, som laeser varelinje-sin direkte.
export async function setLineCategoryAction(
  lineId: string,
  category: string,
  sinTag: string | null,
): Promise<FinanceActionResult> {
  if (!(await authedEmail())) return { ok: false, message: 'Ikke logget ind.' }
  const cat = (await resolveCat(category))?.key ?? null
  const sin = isSinTag(sinTag) ? sinTag : null
  try {
    await setTransactionLineCategory(lineId, cat, sin)
    revalidate()
    return { ok: true }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

// Lazy-load forretningens varer (foldet pr. vare) til udfoldningen. Read-only.
export async function getMerchantLineGroupsAction(token: string): Promise<ProductGroup[]> {
  if (!(await authedEmail())) return []
  try {
    return await getMerchantLineGroups(token)
  } catch {
    return []
  }
}

// Global vare-rettelse: sæt kategori/sin paa ALLE varelinjer med samme vare-noegle
// (uanset butik). Returnerer hvor mange linjer der blev rettet.
export async function setProductLineCategoryAction(
  key: string,
  category: string,
  sinTag: string | null,
): Promise<FinanceActionResult> {
  if (!(await authedEmail())) return { ok: false, message: 'Ikke logget ind.' }
  if (!key) return { ok: false, message: 'Ukendt vare.' }
  const cat = (await resolveCat(category))?.key ?? null
  const sin = isSinTag(sinTag) ? sinTag : null
  try {
    const n = await setProductLineCategory(key, cat, sin)
    revalidate()
    return { ok: true, message: `${n} varelinje${n === 1 ? '' : 'r'} rettet.` }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

// Brugerdefinerede kategorier: tilfoej / slet. Paavirker alle kategori-dropdowns OG
// AI-klassificeringen (nye kategorier puttes i Haiku-prompten). Skriver memory_facts.
export async function addCategoryAction(label: string): Promise<FinanceActionResult> {
  if (!(await authedEmail())) return { ok: false, message: 'Ikke logget ind.' }
  try {
    const res = await addCategory(label)
    if (!res.ok) return { ok: false, message: res.message }
    revalidate()
    return { ok: true, message: 'Kategori tilføjet.' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

export async function deleteCategoryAction(key: string): Promise<FinanceActionResult> {
  if (!(await authedEmail())) return { ok: false, message: 'Ikke logget ind.' }
  try {
    const res = await deleteCategory(key)
    if (!res.ok) return { ok: false, message: res.message }
    revalidate()
    return { ok: true }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}
