// Verifikation af Modul 2 (opgaver) + Modul 3 (mål) mod den rigtige DB.
// Læser via service_role (samme som lib/supabase.ts). Bekræfter at de nye
// kolonner/tabeller er forespørgbare og viser de seneste rækker.
// Brug:  node scripts/verify-modules.mjs
import './load-env.mjs'
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('Mangler NEXT_PUBLIC_SUPABASE_URL eller SUPABASE_SERVICE_ROLE_KEY i .env.local')
  process.exit(1)
}
const sb = createClient(url, key, { auth: { persistSession: false } })

const { data: tasks, error: te } = await sb
  .from('tasks')
  .select('title, urgency, key, priority_score, due_date, area, status, created_at')
  .order('created_at', { ascending: false })
  .limit(6)
if (te) {
  console.error('TASKS-FEJL:', te.message)
} else {
  console.log(`\nTASKS (seneste ${tasks.length}):`)
  console.table(
    tasks.map((t) => ({
      title: (t.title || '').slice(0, 42),
      urgency: t.urgency,
      vigtig: t.key,
      prio: t.priority_score,
      due: t.due_date ? String(t.due_date).slice(0, 10) : null,
      omr: t.area,
      status: t.status,
    })),
  )
}

const { data: goals, error: ge } = await sb
  .from('goals')
  .select('scope, title, done, created_at')
  .order('created_at', { ascending: false })
  .limit(6)
if (ge) {
  console.error('GOALS-FEJL:', ge.message)
} else {
  console.log(`\nGOALS (seneste ${goals.length}):`)
  console.table(goals.map((g) => ({ scope: g.scope, title: (g.title || '').slice(0, 42), done: g.done })))
}

if (!te && !ge) console.log('\nBegge tabeller forespørgbare med nyt skema. ✔')
