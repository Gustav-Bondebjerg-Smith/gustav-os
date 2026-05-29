// Client component: textarea + submit-knap til at gemme en capture.
// useActionState giver pending-state mens saveCapture kører (klassificering
// + embedding tager 1-2 sek). Formularen ryddes efter success.
'use client'

import { useActionState, useEffect, useRef } from 'react'
import { createCaptureAction } from './actions'
import { initialCreateCaptureState } from './state'

export function NewCaptureForm() {
  const [state, action, pending] = useActionState(createCaptureAction, initialCreateCaptureState)
  const formRef = useRef<HTMLFormElement>(null)

  // Ryd textarea efter en vellykket gem, så næste capture starter blankt.
  useEffect(() => {
    if (state.ok && formRef.current) {
      formRef.current.reset()
    }
  }, [state])

  return (
    <form ref={formRef} action={action} className="mb-6">
      <textarea
        name="content"
        rows={3}
        maxLength={5000}
        disabled={pending}
        placeholder="Ny capture - skriv eller paste tekst..."
        className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 disabled:opacity-50 resize-y"
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="text-xs flex-1 min-w-0">
          {state.ok && (
            <span className="text-green-700 dark:text-green-400">
              {state.message}
              {state.area && (
                <span className="text-zinc-500">
                  {' '}
                  ({state.area}
                  {state.type ? `, ${state.type}` : ''})
                </span>
              )}
            </span>
          )}
          {!state.ok && state.message && (
            <span className="text-red-600 dark:text-red-400">{state.message}</span>
          )}
        </p>
        <button
          type="submit"
          disabled={pending}
          className="px-3 py-1.5 text-sm rounded-lg bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 disabled:opacity-50 whitespace-nowrap"
        >
          {pending ? 'Gemmer...' : 'Gem capture'}
        </button>
      </div>
    </form>
  )
}
