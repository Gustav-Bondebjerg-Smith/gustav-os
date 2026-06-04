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
  getTransactionLines,
  getTransaction,
  applyLearnedCategory,
} from '@/lib/finance'
import { saveFinanceRule } from '@/lib/finance-classify'
import { isCategory, isSinTag, merchantToken, type TransactionLine } from '@/lib/finance-shared'
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

// Bank-CSV upload. Filen er ISO-8859-1 (dansk bank-eksport) -> dekod som latin1.
export async function importBankAction(formData: FormData): Promise<ImportResult> {
  if (!(await authedEmail())) return { ok: false, message: 'Ikke logget ind.' }
  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: 'Vælg en CSV-fil.' }
  try {
    const buf = Buffer.from(await file.arrayBuffer())
    const res = await importBankCsv(buf.toString('latin1'), file.name)
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
  const cat = isCategory(category) ? category : null
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
          alsoUpdated = await applyLearnedCategory(token, cat, sin)
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
