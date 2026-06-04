'use client'

// Mål-board (Modul 3). To grupper (Denne uge / Denne måned), hver med tilføj-felt
// + afkrydsning + fjern. Optimistiske mutationer via server actions. Mål bliver
// stående til de fjernes - ingen auto-nulstilling. Visuelt i Claude Design-stil
// (kort + fh-task-checkbokse). Den rigere "aktivt fokus + delmål"-hero er udskudt.
import { useState, type FormEvent } from 'react'
import Link from 'next/link'
import { Check, Plus, X } from 'lucide-react'
import { SCOPES, SCOPE_LABEL, type Goal, type GoalScope } from '@/lib/goals-shared'
import { addGoalAction, toggleGoalAction, removeGoalAction } from '@/app/maal/actions'

export function GoalsBoard({
  initialGoals,
  loadError,
}: {
  initialGoals: Goal[]
  loadError: string | null
}) {
  const [goals, setGoals] = useState<Goal[]>(initialGoals)
  const [error, setError] = useState<string | null>(null)

  const total = goals.length
  const doneTotal = goals.filter((g) => g.done).length

  function toggle(g: Goal) {
    const done = !g.done
    setGoals((prev) => prev.map((x) => (x.id === g.id ? { ...x, done } : x)))
    toggleGoalAction(g.id, done)
      .then((res) => {
        if (!res.ok) {
          setGoals((prev) => prev.map((x) => (x.id === g.id ? g : x)))
          setError(res.message ?? 'Kunne ikke opdatere målet.')
        }
      })
      .catch(() => setGoals((prev) => prev.map((x) => (x.id === g.id ? g : x))))
  }

  function remove(g: Goal) {
    setGoals((prev) => prev.filter((x) => x.id !== g.id))
    removeGoalAction(g.id)
      .then((res) => {
        if (!res.ok) {
          setGoals((prev) => [...prev, g])
          setError(res.message ?? 'Kunne ikke fjerne målet.')
        }
      })
      .catch(() => setGoals((prev) => [...prev, g]))
  }

  function add(goal: Goal) {
    setGoals((prev) => [...prev, goal])
  }

  return (
    <>
      <div className="vhead">
        <div className="vh-l">
          <span className="vh-no">06</span>
          <span className="vh-ttl">Mål</span>
        </div>
        <span className="vh-sub num">{total === 0 ? 'Ingen mål endnu' : `${doneTotal} / ${total} klar`}</span>
      </div>

      {loadError && <p className="empty">Kunne ikke hente mål: {loadError}</p>}
      {error && (
        <p className="ses-cap-msg" style={{ color: 'var(--color-neg)' }}>
          {error}
        </p>
      )}

      <div className="maal-grid">
        {SCOPES.map((scope, i) => (
          <GoalGroup
            key={scope}
            no={String(i + 1).padStart(2, '0')}
            scope={scope}
            goals={goals.filter((g) => g.scope === scope)}
            onToggle={toggle}
            onRemove={remove}
            onAdd={add}
            onError={setError}
          />
        ))}
      </div>

      <p className="board-foot">
        <Link href="/">← Tilbage til I dag</Link>
      </p>
    </>
  )
}

function GoalGroup({
  no,
  scope,
  goals,
  onToggle,
  onRemove,
  onAdd,
  onError,
}: {
  no: string
  scope: GoalScope
  goals: Goal[]
  onToggle: (g: Goal) => void
  onRemove: (g: Goal) => void
  onAdd: (g: Goal) => void
  onError: (m: string) => void
}) {
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const done = goals.filter((g) => g.done).length

  async function submit(e: FormEvent) {
    e.preventDefault()
    const t = draft.trim()
    if (!t || adding) return
    setAdding(true)
    try {
      const res = await addGoalAction(scope, t)
      if (res.ok && res.goal) {
        onAdd(res.goal)
        setDraft('')
      } else {
        onError(res.message ?? 'Kunne ikke tilføje målet.')
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setAdding(false)
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <div className="sect">
          <span className="no">{no}</span>
          <span className="ttl">{SCOPE_LABEL[scope]}</span>
        </div>
        <span className="tag">{done}/{goals.length} klar</span>
      </div>

      <div className="goal-list">
        {goals.length === 0 ? (
          <p className="empty">Ingen mål endnu.</p>
        ) : (
          goals.map((g) => (
            <div className={`fh-task ${g.done ? 'done' : ''}`} key={g.id}>
              <button
                type="button"
                className="fh-check"
                onClick={() => onToggle(g)}
                aria-label={g.done ? 'Markér ikke klar' : 'Markér klar'}
              >
                <Check aria-hidden="true" />
              </button>
              <span className="goal-text">{g.title}</span>
              <button type="button" className="t-del" onClick={() => onRemove(g)} aria-label="Fjern mål">
                <X aria-hidden="true" />
              </button>
            </div>
          ))
        )}
      </div>

      <form className="add-row goal-add" onSubmit={submit}>
        <Plus aria-hidden="true" />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={adding ? 'Tilføjer…' : `Nyt ${SCOPE_LABEL[scope].toLowerCase()}-mål…`}
          disabled={adding}
          maxLength={200}
          aria-label={`Tilføj mål (${SCOPE_LABEL[scope]})`}
        />
        <span className="pill type">{adding ? '…' : 'Enter'}</span>
      </form>
    </section>
  )
}
