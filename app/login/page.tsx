// /login - magic link form. Client component pga. useActionState så vi kan
// vise pending-state + "tjek din inbox"-besked uden en redirect.
'use client'

import { useActionState } from 'react'
import { loginAction } from './actions'
import { initialLoginState } from './state'

export default function LoginPage() {
  const [state, action, pending] = useActionState(loginAction, initialLoginState)

  if (state.sent) {
    return (
      <div className="max-w-md mx-auto pt-12">
        <h1 className="text-2xl font-semibold mb-2">Tjek din inbox</h1>
        <p className="text-sm text-zinc-500 mb-6">
          Hvis <span className="font-mono">{state.email}</span> har adgang, ligger der nu et magic link i indbakken.
          Klik på det for at logge ind. Linket virker i 1 time.
        </p>
        <p className="text-xs text-zinc-400">
          Intet link? Tjek spam-mappen, eller prøv igen om et øjeblik (Supabase rate-limiter).
        </p>
      </div>
    )
  }

  return (
    <div className="max-w-md mx-auto pt-12">
      <h1 className="text-2xl font-semibold mb-1">Log ind på Gustav OS</h1>
      <p className="text-sm text-zinc-500 mb-6">
        Skriv din email. Du får et engangs-link der logger dig ind.
      </p>

      <form action={action} className="space-y-3">
        <input
          type="email"
          name="email"
          placeholder="din@email.dk"
          required
          disabled={pending}
          className="w-full px-4 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 disabled:opacity-50"
          autoFocus
        />
        <button
          type="submit"
          disabled={pending}
          className="w-full px-4 py-2 rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 disabled:opacity-50"
        >
          {pending ? 'Sender...' : 'Send magic link'}
        </button>
      </form>

      {state.error && (
        <div className="mt-4 border border-red-300 bg-red-50 dark:bg-red-950 dark:border-red-800 rounded-lg p-3 text-sm text-red-700 dark:text-red-200">
          {state.error}
        </div>
      )}
    </div>
  )
}
