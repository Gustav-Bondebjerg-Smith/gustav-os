// CLI til det lærende fakta-lag (memory_facts). Tynd skal oven på den delte kerne
// scripts/memory-facts-core.mjs (samme kerne bruger MCP-serveren). Kør som:
//   node scripts/memory-facts.mjs ...
//
// Brug:
//   node scripts/memory-facts.mjs --list [--scope global]
//   node scripts/memory-facts.mjs --save --type feedback --key traening-tidspunkt \
//        --content "Træner om aftenen, ikke om morgenen" [--why "..."] [--scope global]
//   node scripts/memory-facts.mjs --consolidate [--scope global] [--threshold 0.85]
//
// --consolidate er manuel (v1): finder semantisk nære dublet-par + flagger det
// ældste faktum. Sletter eller merger INTET automatisk - det foreslår kun.
import { saveMemory, listFacts, consolidateFacts, VALID_FACT_TYPES } from './memory-facts-core.mjs'

// Mini flag-parser: "--navn værdi" eller boolean "--flag".
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const name = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out[name] = next
      i++
    } else {
      out[name] = true
    }
  }
  return out
}

function printFact(r) {
  console.log(`[${r.scope}] ${r.key} (${r.type})\n  ${r.content}${r.why ? `\n  hvorfor: ${r.why}` : ''}`)
}

async function runSave(args) {
  const why = args.why && args.why !== true ? String(args.why).trim() : null
  const scope = typeof args.scope === 'string' ? args.scope : 'global'
  const saved = await saveMemory({ type: args.type, scope, key: args.key, content: args.content, why })
  console.log('Gemt:')
  printFact(saved)
}

async function runList(args) {
  const scope = typeof args.scope === 'string' ? args.scope.trim() : ''
  const data = await listFacts({ scope: scope || null })
  if (!data.length) {
    console.log('Ingen fakta endnu.')
    return
  }
  data.forEach(printFact)
  console.log(`\n${data.length} fakta i alt.`)
}

async function runConsolidate(args) {
  const scope = (typeof args.scope === 'string' && args.scope.trim()) || 'global'
  const threshold = Number(args.threshold) || 0.85
  const report = await consolidateFacts({ scope, threshold })
  if (!report.count) {
    console.log(`Ingen fakta i scope '${scope}'.`)
    return
  }
  console.log(`Konsolidering af scope '${scope}' (${report.count} fakta, lighedstærskel ${threshold}):\n`)
  for (const p of report.duplicate_pairs) {
    console.log(
      `MULIG DUBLET (${p.similarity.toFixed(2)}):\n  - ${p.a_key}: ${p.a_content}\n  - ${p.b_key}: ${p.b_content}\n  -> merge manuelt: kør --save på det key du beholder, slet det andet i Supabase.\n`
    )
  }
  console.log(
    report.duplicate_pairs.length
      ? `${report.duplicate_pairs.length} mulige dublet-par. Ingen auto-sletning i v1 - merge manuelt.`
      : 'Ingen semantiske dubletter fundet.'
  )
  if (report.oldest) {
    console.log(`Ældste faktum: ${report.oldest.key} (opdateret ${report.oldest.updated_at}). Tjek om det stadig gælder.`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2))
  try {
    if (args.save) await runSave(args)
    else if (args.list) await runList(args)
    else if (args.consolidate) await runConsolidate(args)
    else {
      console.error(
        `Brug:\n  --list [--scope S]\n  --save --type T --key K --content C [--why W] [--scope S]   (T = ${VALID_FACT_TYPES.join('|')})\n  --consolidate [--scope S] [--threshold 0.85]`
      )
      process.exit(1)
    }
  } catch (e) {
    console.error('Fejl:', e.message)
    process.exit(1)
  }
}
