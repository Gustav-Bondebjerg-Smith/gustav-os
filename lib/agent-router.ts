// Tool-calling router (v2) - tynd, typet facade over lib/agent-router-core.mjs.
//
// Hjernen (tools + system-prompt + routeMessage) ligger i agent-router-core.mjs,
// som OGSÅ importeres af scripts/agent-router.mjs (replay/CLI). Rettelser laves
// derfor ét sted, og golden-set-replayet tester præcis prod-routeren. Denne fil
// tilføjer kun 'server-only'-gaten og TypeScript-typerne til webhooken.
//
// Valideret mod golden-set: se scripts/replay.mjs.
import 'server-only'
import {
  ROUTER_MODEL as CORE_ROUTER_MODEL,
  TOOLS as CORE_TOOLS,
  routeMessage as coreRouteMessage,
} from './agent-router-core.mjs'

export const ROUTER_MODEL: string = CORE_ROUTER_MODEL

export type AnthropicTool = {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export const TOOLS: AnthropicTool[] = CORE_TOOLS as AnthropicTool[]

export type RouterResult =
  | { kind: 'tool'; tool: string; input: Record<string, unknown> }
  | { kind: 'ask'; askText: string }
  | { kind: 'none' }

// En tur i samtalen. routeMessage kan tage enten en enkelt streng (statsløst, ét
// kald) eller hele samtalen (flertur), så et svar på routerens eget spørgsmål
// vurderes MED kontekst i stedet for kontekstløst.
export type RouterTurn = { role: 'user' | 'assistant'; content: string }

// Returnerer modellens valg uden at udføre det. input er enten Gustavs ene besked
// (statsløst) eller hele samtalen inkl. routerens tidligere spørgsmål (flertur).
export async function routeMessage(
  input: string | RouterTurn[],
  now: Date = new Date(),
  globalFacts: string = ''
): Promise<RouterResult> {
  return (await coreRouteMessage(input, now, globalFacts)) as RouterResult
}
