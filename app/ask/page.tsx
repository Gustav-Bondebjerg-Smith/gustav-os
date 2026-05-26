// /ask - spørg din second brain. Client component der bruger useActionState
// til at vise pending-state mens Claude tænker.
'use client'

import { useActionState } from 'react'
import { askAction } from './actions'
import { initialAskState } from './state'
import { fmtDate } from '@/lib/format'

export default function AskPage() {
  const [state, action, pending] = useActionState(askAction, initialAskState)

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-1">Ask</h1>
      <p className="text-sm text-zinc-500 mb-6">
        Spørg din second brain. Top-8 relevante chunks via cosine similarity, Claude Sonnet svarer med citerede kilder.
      </p>

      <form action={action} className="mb-8">
        <div className="flex gap-2">
          <input
            type="text"
            name="question"
            placeholder="Fx: hvilke aftaler har jeg snakket om?"
            defaultValue={state.question}
            disabled={pending}
            className="flex-1 px-4 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 disabled:opacity-50"
            autoFocus
          />
          <button
            type="submit"
            disabled={pending}
            className="px-4 py-2 rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 disabled:opacity-50"
          >
            {pending ? 'Tænker...' : 'Spørg'}
          </button>
        </div>
      </form>

      {state.error && (
        <div className="border border-red-300 bg-red-50 dark:bg-red-950 dark:border-red-800 rounded-lg p-4 mb-6 text-sm text-red-700 dark:text-red-200">
          {state.error}
        </div>
      )}

      {state.answer && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide mb-2">Svar</h2>
          <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 text-sm leading-relaxed whitespace-pre-wrap">
            {state.answer}
          </div>
        </div>
      )}

      {state.sources.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide mb-2">Kilder</h2>
          <ol className="space-y-2">
            {state.sources.map((c, i) => (
              <li
                key={c.id}
                className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-3 bg-white dark:bg-zinc-900 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2 mb-1 text-xs text-zinc-500">
                  <span className="font-mono">[{i + 1}]</span>
                  <span>{fmtDate(c.created_at)}</span>
                  <span className="text-zinc-400">·</span>
                  <span>{c.area || 'ukategoriseret'}</span>
                  <span className="text-zinc-400">·</span>
                  <span>sim={c.similarity.toFixed(2)}</span>
                </div>
                <p className="leading-relaxed">{c.content}</p>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}
