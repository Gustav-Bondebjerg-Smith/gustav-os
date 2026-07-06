// Script-indgang til tool-calling-routeren: load-env + re-export af kernen.
//
// Hjernen (tools + system-prompt + routeMessage) ligger i lib/agent-router-core.mjs
// og deles med prod (lib/agent-router.ts). Denne fil sørger kun for at .env.local
// er loadet i node-scripts, og beholder CLI-testen nederst. Replay-harnessen
// (scripts/replay.mjs) importerer herfra og tester dermed præcis prod-routeren.
import './load-env.mjs'

export { ROUTER_MODEL, TOOLS, routeMessage } from '../lib/agent-router-core.mjs'
import { routeMessage } from '../lib/agent-router-core.mjs'

// Tillader direkte CLI-test: node scripts/agent-router.mjs "din besked"
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  // Flertur-test: node scripts/agent-router.mjs --convo "user 1" "assistant spørgsmål" "user svar"
  // (skiftevis user/assistant, starter med user). Ellers: enkelt besked som streng.
  const input =
    args[0] === '--convo'
      ? args.slice(1).map((content, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content }))
      : args.join(' ')
  const empty = Array.isArray(input) ? input.length === 0 : !input
  if (empty) {
    console.error('Brug: node scripts/agent-router.mjs "besked"  ELLER  --convo "user" "assistant" "user"')
    process.exit(1)
  }
  const out = await routeMessage(input)
  if (out.kind === 'tool') console.log(`TOOL: ${out.tool}\n`, JSON.stringify(out.input, null, 2))
  else if (out.kind === 'ask') console.log(`SPØRGER: ${out.askText}`)
  else console.log('INTET SVAR')
}
