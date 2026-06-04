'use client'

// Opgave-board (Modul 2). Klient-komponent: filtrering er ren klient-state, og
// mutationer er optimistiske (UI opdaterer straks, server action i baggrunden,
// revert ved fejl). Designet matcher Claude Design-prototypens Opgaver-fane
// (vhead + toolbar + add-row + 4 hastigheds-bunker), med flyt/slet oveni.
import { useMemo, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { Check, Plus, X } from 'lucide-react'
import {
  URGENCIES,
  URGENCY_LABEL,
  isUrgency,
  type Task,
  type Urgency,
} from '@/lib/tasks-shared'
import { isPastDayCph } from '@/lib/format'
import {
  addTaskAction,
  toggleTaskAction,
  moveTaskAction,
  deleteTaskAction,
} from '@/app/opgaver/actions'

const AREAS: { v: string; l: string }[] = [
  { v: 'alle', l: 'Alle' },
  { v: 'personlig', l: 'Personlig' },
  { v: 'studie', l: 'Studie' },
  { v: 'arbejde', l: 'Arbejde' },
]
const COL_NO = ['A', 'B', 'C', 'D']

export function TaskBoard({
  initialTasks,
  loadError,
}: {
  initialTasks: Task[]
  loadError: string | null
}) {
  const [tasks, setTasks] = useState<Task[]>(initialTasks)
  const [areaFilter, setAreaFilter] = useState('alle')
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const visible = useMemo(
    () => tasks.filter((t) => areaFilter === 'alle' || t.area === areaFilter),
    [tasks, areaFilter],
  )
  const openTasks = tasks.filter((t) => t.status === 'open')
  const openCount = openTasks.length
  const todayCount = openTasks.filter((t) => t.urgency === 'today' || t.key).length
  const overdueCount = openTasks.filter((t) => isPastDayCph(t.due_date)).length

  const replace = (id: string, next: Task) =>
    setTasks((prev) => prev.map((x) => (x.id === id ? next : x)))

  async function handleAdd(e: FormEvent) {
    e.preventDefault()
    const text = draft.trim()
    if (!text || adding) return
    setAdding(true)
    setError(null)
    try {
      const res = await addTaskAction(text)
      const created = res.task
      if (res.ok && created) {
        setTasks((prev) => [created, ...prev])
        setDraft('')
      } else {
        setError(res.message ?? 'Kunne ikke oprette opgaven.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAdding(false)
    }
  }

  function toggleDone(t: Task) {
    const done = t.status !== 'done'
    const updated: Task = {
      ...t,
      status: done ? 'done' : 'open',
      completed_at: done ? new Date().toISOString() : null,
    }
    replace(t.id, updated)
    toggleTaskAction(t.id, done)
      .then((res) => {
        if (!res.ok) {
          replace(t.id, t)
          setError(res.message ?? 'Kunne ikke opdatere opgaven.')
        }
      })
      .catch(() => replace(t.id, t))
  }

  function changeUrgency(t: Task, urgency: Urgency) {
    replace(t.id, { ...t, urgency })
    moveTaskAction(t.id, urgency)
      .then((res) => {
        if (!res.ok) {
          replace(t.id, t)
          setError(res.message ?? 'Kunne ikke flytte opgaven.')
        }
      })
      .catch(() => replace(t.id, t))
  }

  function removeTask(t: Task) {
    setTasks((prev) => prev.filter((x) => x.id !== t.id))
    deleteTaskAction(t.id)
      .then((res) => {
        if (!res.ok) {
          setTasks((prev) => [t, ...prev])
          setError(res.message ?? 'Kunne ikke slette opgaven.')
        }
      })
      .catch(() => setTasks((prev) => [t, ...prev]))
  }

  return (
    <>
      <div className="vhead">
        <div className="vh-l">
          <span className="vh-no">04</span>
          <span className="vh-ttl">Opgaver</span>
        </div>
        <span className="vh-sub num">
          {overdueCount ? `${overdueCount} forsinket · ` : ''}
          {openCount} åbne · {todayCount} i dag
        </span>
      </div>

      {loadError && <p className="empty">Kunne ikke hente opgaver: {loadError}</p>}

      <div className="toolbar">
        <div className="filter-grp">
          <span className="filter-lbl">Område</span>
          {AREAS.map((a) => (
            <button
              key={a.v}
              type="button"
              className={`chip ${areaFilter === a.v ? 'active' : ''}`}
              onClick={() => setAreaFilter(a.v)}
            >
              {a.l}
            </button>
          ))}
        </div>
      </div>

      <form className="add-row" onSubmit={handleAdd}>
        <Plus aria-hidden="true" />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={adding ? 'Prioriterer…' : 'Tilføj en opgave… (AI prioriterer)'}
          disabled={adding}
          maxLength={500}
          aria-label="Tilføj opgave"
        />
        <span className="pill type">{adding ? '…' : 'Enter'}</span>
      </form>

      {error && (
        <p className="ses-cap-msg" style={{ color: 'var(--color-neg)' }}>
          {error}
        </p>
      )}

      <div className="opg-grid">
        {URGENCIES.map((u, i) => {
          const items = visible.filter((t) => t.urgency === u)
          const left = items.filter((t) => t.status === 'open').length
          return (
            <section className="card" key={u}>
              <div className="card-head">
                <div className="sect">
                  <span className="no">{COL_NO[i]}</span>
                  <span className="ttl">{URGENCY_LABEL[u]}</span>
                </div>
                <span className="tag">{left} åbne</span>
              </div>
              <div className="tasks">
                {items.length === 0 ? (
                  <p className="empty">Ingen opgaver her.</p>
                ) : (
                  items.map((t) => (
                    <TaskRow
                      key={t.id}
                      t={t}
                      onToggle={() => toggleDone(t)}
                      onMove={(next) => changeUrgency(t, next)}
                      onRemove={() => removeTask(t)}
                    />
                  ))
                )}
              </div>
            </section>
          )
        })}
      </div>

      <p className="board-foot">
        <Link href="/">← Tilbage til I dag</Link>
      </p>
    </>
  )
}

function TaskRow({
  t,
  onToggle,
  onMove,
  onRemove,
}: {
  t: Task
  onToggle: () => void
  onMove: (u: Urgency) => void
  onRemove: () => void
}) {
  const overdue = t.status === 'open' && isPastDayCph(t.due_date)
  return (
    <div className={`task ${t.status === 'done' ? 'done' : ''}`}>
      <button
        type="button"
        className="check"
        onClick={onToggle}
        aria-label={t.status === 'done' ? 'Markér ikke-færdig' : 'Markér færdig'}
      >
        <Check aria-hidden="true" />
      </button>
      <div className="t-body">
        <div className="t-title">{t.title}</div>
        <div className="t-meta">
          {t.area ? <span className={`pill area-${t.area}`}>{t.area}</span> : null}
          {t.key ? <span className="pill vigtig">Vigtig</span> : null}
          {overdue ? <span className="pill over">Forsinket</span> : null}
        </div>
        <div className="t-side">
          <select
            className="t-move"
            value={t.urgency}
            onChange={(e) => {
              if (isUrgency(e.target.value)) onMove(e.target.value)
            }}
            aria-label="Flyt opgave til en anden bunke"
          >
            {URGENCIES.map((u) => (
              <option key={u} value={u}>
                {URGENCY_LABEL[u]}
              </option>
            ))}
          </select>
          <button type="button" className="t-del" onClick={onRemove} aria-label="Slet opgave">
            <X aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  )
}
