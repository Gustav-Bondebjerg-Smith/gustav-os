// Replay-harness: kør golden-set'et gennem det nye tool-calling-loop og mål
// hvor godt det router, sammenlignet med dine labels. Udfører INTET (router
// returnerer kun det valgte værktøj), så det er sikkert at køre.
//
// Kør:  node scripts/replay.mjs
//
// Læser golden-set-labeling.csv (repo-roden), kalder routeMessage for hver
// besked med beskedens EGET tidsstempel som "nu" (så "i dag"/"i nat" passer),
// mapper værktøj -> label og scorer mod kolonnen "intended".
import './load-env.mjs'
import { readFileSync } from 'node:fs'
import { routeMessage } from './agent-router.mjs'

// Værktøj -> label (omvendt af verberne i routeren).
const TOOL_TO_LABEL = {
  create_event: 'opret_aftale',
  edit_event: 'ret_aftale',
  delete_event: 'slet_aftale',
  start_activity: 'start_aktivitet',
  stop_activity: 'stop_aktivitet',
  search_memory: 'opslag',
  save_note: 'note',
}

// Minimal men korrekt CSV-parser (håndterer citater, kommaer og newlines i felter).
function parseCsv(text) {
  const rows = []
  let row = [], field = '', inStr = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else inStr = false
      } else field += c
    } else if (c === '"') inStr = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c === '\r') { /* skip */ }
    else field += c
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows
}

const csvPath = new URL('../golden-set-labeling.csv', import.meta.url)
const raw = readFileSync(csvPath, 'utf8')
const rows = parseCsv(raw)
const header = rows[0]
const idx = Object.fromEntries(header.map((h, i) => [h, i]))
const data = rows.slice(1).filter((r) => r.length > 1 && r[idx.message])

let correct = 0, wrong = 0, asked = 0, scored = 0
let recovered = 0, recoverable = 0
const misses = []

console.log(`\nReplayer ${data.length} beskeder gennem tool-calling-routeren (${'claude-sonnet-4-6'})...\n`)

for (const r of data) {
  const message = r[idx.message]
  const intended = (r[idx.intended] || '').trim()
  const wasMisrouted = (r[idx.misrouted] || '').trim().toLowerCase() === 'y'
  const now = r[idx.timestamp] ? new Date(r[idx.timestamp]) : new Date()
  if (!intended || intended === 'flere') {
    console.log(`  -  (springer over, ingen entydig label)  "${message.slice(0, 50)}"`)
    continue
  }

  let out
  try {
    out = await routeMessage(message, now)
  } catch (e) {
    console.log(`  !  FEJL  "${message.slice(0, 50)}": ${e.message}`)
    continue
  }

  scored++
  if (wasMisrouted) recoverable++

  if (out.kind === 'ask') {
    asked++
    console.log(`  ?  SPØRGER  intended=${intended}  "${message.slice(0, 45)}"\n        -> ${out.askText.slice(0, 80)}`)
    continue
  }
  if (out.kind !== 'tool') {
    wrong++
    misses.push({ message, intended, got: '(intet)' })
    console.log(`  x  INTET  intended=${intended}  "${message.slice(0, 45)}"`)
    continue
  }

  const got = TOOL_TO_LABEL[out.tool] || out.tool
  if (got === intended) {
    correct++
    if (wasMisrouted) recovered++
    console.log(`  v  ${intended.padEnd(15)} "${message.slice(0, 45)}"`)
  } else {
    wrong++
    misses.push({ message, intended, got })
    console.log(`  x  intended=${intended} got=${got}  "${message.slice(0, 45)}"`)
  }
}

const pct = (n) => scored ? ((n / scored) * 100).toFixed(0) + '%' : '-'
console.log(`\n=== SCOREKORT ===`)
console.log(`scoret      : ${scored}`)
console.log(`korrekt     : ${correct}  (${pct(correct)})`)
console.log(`forkert     : ${wrong}  (${pct(wrong)})`)
console.log(`spurgte     : ${asked}  (${pct(asked)})   <- afklarende spørgsmål, ikke en tavs note`)
console.log(`\ngamle misroutes genvundet: ${recovered} / ${recoverable}`)
console.log(`(det er kerne-målet: de beskeder cascaden tavst gemte som note,`)
console.log(` som routeren nu håndterer rigtigt)`)

if (misses.length) {
  console.log(`\n=== STADIG FORKERT (kig her) ===`)
  for (const m of misses) console.log(`  intended=${m.intended} got=${m.got}  "${m.message.slice(0, 60)}"`)
}
console.log('')
