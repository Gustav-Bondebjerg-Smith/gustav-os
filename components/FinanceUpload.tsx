'use client'

// Upload på /finans (Modul 4): månedlig bank-CSV + Storebox receipts-*.json.
// Samme idempotente import-sti som CLI-bulkloaden. Efter import: router.refresh().
import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Upload, RefreshCw } from 'lucide-react'
import { importBankAction, importStoreboxAction, reconcileAction } from '@/app/finans/actions'

export function FinanceUpload() {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  async function handle(
    kind: 'bank' | 'storebox',
    e: FormEvent<HTMLFormElement>,
  ) {
    e.preventDefault()
    const form = e.currentTarget
    const fd = new FormData(form)
    setBusy(kind)
    setMsg(null)
    const res = kind === 'bank' ? await importBankAction(fd) : await importStoreboxAction(fd)
    setBusy(null)
    setMsg({ ok: res.ok, text: res.message ?? (res.ok ? 'Importeret.' : 'Fejl.') })
    if (res.ok) {
      form.reset()
      router.refresh()
    }
  }

  async function rerun() {
    setBusy('reconcile')
    setMsg(null)
    const res = await reconcileAction()
    setBusy(null)
    setMsg({ ok: res.ok, text: res.message ?? 'Færdig.' })
    if (res.ok) router.refresh()
  }

  return (
    <div className="upl">
      <form className="upl-row" onSubmit={(e) => handle('bank', e)}>
        <label className="upl-lbl">
          <span className="upl-k">Bank-CSV</span>
          <input type="file" name="file" accept=".csv,text/csv" disabled={!!busy} />
        </label>
        <button type="submit" className="upl-btn" disabled={!!busy}>
          <Upload size={14} aria-hidden="true" /> {busy === 'bank' ? 'Importerer…' : 'Importér'}
        </button>
      </form>

      <form className="upl-row" onSubmit={(e) => handle('storebox', e)}>
        <label className="upl-lbl">
          <span className="upl-k">Storebox receipts-*.json</span>
          <input type="file" name="file" accept=".json,application/json" disabled={!!busy} />
        </label>
        <button type="submit" className="upl-btn" disabled={!!busy}>
          <Upload size={14} aria-hidden="true" /> {busy === 'storebox' ? 'Importerer…' : 'Importér'}
        </button>
      </form>

      <div className="upl-foot">
        <button type="button" className="upl-link" onClick={rerun} disabled={!!busy}>
          <RefreshCw size={13} aria-hidden="true" /> {busy === 'reconcile' ? 'Matcher…' : 'Kør matchning igen'}
        </button>
        {msg && (
          <span className="upl-msg" style={{ color: msg.ok ? 'var(--color-pos)' : 'var(--color-neg)' }}>
            {msg.text}
          </span>
        )}
      </div>
    </div>
  )
}
