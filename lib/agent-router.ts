// Tool-calling router (v1) - erstatter cascaden i telegram-webhook.ts.
//
// Én Sonnet-model får beskeden + tid + Gustavs verber (tools) og VÆLGER ét kald.
// Dette modul UDFØRER intet - det returnerer kun modellens valg. Webhooken
// (dispatchViaAgent) kobler valget til de eksisterende eksekverings-funktioner og
// bevarer veto/confirmation på det destruktive.
//
// Spejler scripts/agent-router.mjs, men server-only TS uden load-env (Vercel-env).
// Valideret mod golden-set: 23/25 korrekt, 0 forkert, 2 afklarende spørgsmål
// (begge reelt tvetydige beskeder). Se scripts/replay.mjs.
import 'server-only'

export const ROUTER_MODEL = 'claude-sonnet-4-6'

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Mangler ${name} i env`)
  return value
}

function nowInCopenhagen(value: Date = new Date()): string {
  return new Intl.DateTimeFormat('da-DK', {
    timeZone: 'Europe/Copenhagen',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value)
}

type AnthropicTool = {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

// Værktøjerne = Gustavs verber. Hvert navn mapper 1:1 til en handler i webhooken.
export const TOOLS: AnthropicTool[] = [
  {
    name: 'create_event',
    description:
      'Opret en NY kalenderbegivenhed. Brug når Gustav nævner en konkret fremtidig aftale med tidspunkt (fx "møde med Anna fredag kl 14", "lægetid i morgen kl 15", "arbejde i morgen 15-23").',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Kort titel, første bogstav stort' },
        start: { type: 'string', description: 'Naiv lokal tid YYYY-MM-DDTHH:MM:00 (ingen offset)' },
        end: { type: 'string', description: 'Naiv lokal tid; hvis kun starttid, sæt +1 time' },
      },
      required: ['summary', 'start', 'end'],
    },
  },
  {
    name: 'edit_event',
    description:
      'RET tiden på en eksisterende begivenhed (inkl. den faste daglige søvn-begivenhed). Brug ved "ret/ændre/flyt", "X gik til nu", "går i seng kl 2" (= ret søvn-start), "står op kl 7" (= ret søvn-slut).',
    input_schema: {
      type: 'object',
      properties: {
        event_hint: { type: 'string', description: 'Titel/søgeord på eventet, fx "uni" eller "søvn"' },
        edit_type: {
          type: 'string',
          enum: ['start', 'end', 'shift'],
          description: 'start=ret starttid, end=ret sluttid, shift=flyt hele eventet (bevar varighed)',
        },
        new_time: { type: 'string', description: '24-timers HH:MM, eller "nu"' },
      },
      required: ['event_hint', 'edit_type', 'new_time'],
    },
  },
  {
    name: 'delete_event',
    description: 'FJERN/aflys en eksisterende begivenhed. Brug ved "slet/fjern/aflys/drop aftalen X".',
    input_schema: {
      type: 'object',
      properties: {
        event_hint: { type: 'string', description: 'Titel/søgeord + evt. tidspunkt på eventet der skal slettes' },
      },
      required: ['event_hint'],
    },
  },
  {
    name: 'start_activity',
    description:
      'Start tidstagning af en aktivitet LIGE NU. Brug når Gustav siger han går i gang med noget nu, også i hverdagssprog: "starter testaktivitet", "begynder på læsning nu", "nu kaster jeg mig over anatomien", "i gang med frokost". KUN nutid.',
    input_schema: {
      type: 'object',
      properties: {
        activity_name: { type: 'string', description: 'Aktivitetens navn uden trigger-ord, første bogstav stort' },
      },
      required: ['activity_name'],
    },
  },
  {
    name: 'stop_activity',
    description:
      'Stop/pause den aktive tidstagning LIGE NU uden at starte en ny. Brug ved "slutter", "stopper", "afslutter", "holder pause", "færdig", "done", "det var det for i dag". KUN nutid.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'search_memory',
    description:
      'Slå op i Gustavs second brain (tidligere noter/captures/planer) og svar. Brug når han SPØRGER om noget han vil have at vide: "hvad skulle jeg nå i dag", "hvad havde jeg af opgaver", "hvornår skulle jeg ringe til mor".',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Spørgsmålet der skal slås op' },
      },
      required: ['query'],
    },
  },
  {
    name: 'save_note',
    description:
      'Gem beskeden som en note i second brain. Det RETTE valg for ægte noter, reminders ("husk at ..."), tanker, ideer, observationer og vage/ukonkrete fremtidsplaner. Det er IKKE en skraldespand: kun når der ikke er en konkret handling.',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Beskeden der gemmes (typisk uændret)' },
      },
      required: ['content'],
    },
  },
  {
    name: 'save_memory',
    description:
      'Gem et VARIGT faktum, en præference eller en korrektion om Gustav (eller et projekt), så assistenten husker det fremover og ændrer adfærd. Brug når Gustav RETTER dig eller fortæller noget der skal gælde varigt: "jeg træner om aftenen, ikke om morgenen", "kald mig Gustav", "foreslå ikke X mere". IKKE for noter, reminders, tanker eller engangsting (det er save_note).',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference'],
          description:
            'user=fakta/præference om Gustav, feedback=en korrektion/instruks til assistenten, project=projekt-viden, reference=peger på en ekstern kilde',
        },
        key: {
          type: 'string',
          description:
            'Kort kebab-case nøgle der identificerer faktummet, fx "traening-tidspunkt". Samme key overskriver et tidligere faktum.',
        },
        content: {
          type: 'string',
          description: 'Selve faktummet, kort og konkret, formuleret så det kan stå alene.',
        },
        why: {
          type: 'string',
          description: 'Kort begrundelse når det er en korrektion/feedback (hvorfor reglen gælder). Valgfri.',
        },
      },
      required: ['type', 'key', 'content'],
    },
  },
]

// System-prompten er delt i to: en STABIL del (identitet + lærte fakta + regler)
// og en VOLATIL del (kun tidspunktet). Den stabile del sendes som et cache-stabilt
// prefiks (cache_control i routeMessage), så Anthropic-prompt-cachen rammer på tværs
// af beskeder. Fakta-blokken skifter kun når Gustav lærer routeren noget nyt, så
// den buster først cachen ved en faktisk korrektion - ikke ved hver besked.
function buildStableSystem(globalFacts: string): string {
  const facts = globalFacts.trim()
  return [
    'Du er routeren i Gustavs personlige assistent. Gustav er medicinstuderende (SDU), sygeplejevikar og forskningsassistent.',
    ...(facts ? ['', facts] : []),
    '',
    'Du får én kort dansk besked (skrevet eller transskriberet fra tale). Afgør hvad Gustav vil, og kald PRÆCIS ét værktøj.',
    'Tal ikke i nøgleord - forstå intentionen i hverdagssprog. "nu kaster jeg mig over anatomien" = start_activity. "den frokost ryger ud" = delete_event.',
    '',
    'Regler:',
    '- Kald præcis ét værktøj. Beskriv ikke hvad du har tænkt dig - gør det.',
    '- start_activity/stop_activity KUN når handlingen sker NU (ikke "startede i morges", ikke "starter kl 15").',
    '- create_event er en NY aftale. edit_event/delete_event ændrer/fjerner noget der allerede findes.',
    '- save_note er for ægte noter/reminders/tanker - ikke en default-skraldespand for ting du ikke gad forstå.',
    '- save_memory gemmer et VARIGT faktum/præference/korrektion om Gustav eller et projekt, så assistenten husker det fremover. Brug det når Gustav retter dig eller fortæller noget der bør ændre fremtidig adfærd ("jeg træner om aftenen, ikke morgen", "kald mig Gustav"). IKKE for noter, reminders eller engangsting (det er save_note).',
    '- Rene høflighedsfraser, hilsner, små-ord eller transskriptions-fragmenter uden konkret handling ("god fornøjelse", "tak", "ok", "godmorgen") -> save_note. De er IKKE stop_activity eller andre handlinger.',
    '- stop_activity KUN når Gustav tydeligt afslutter/pauser noget han er i gang med - ikke ved en afsked eller et høfligt udtryk.',
    '- En aktivitet Gustav startede tidligere men STADIG er i gang ("startede kl 16, er stadig i gang") kan ikke bruge start_activity (kun nutid). Brug create_event: summary = aktiviteten, start = det nævnte tidspunkt i dag, end = nu. Så logges den faktiske tidsblok.',
    '- Er beskeden ægte tvetydig (du kan ikke afgøre hvilken handling, eller en slet/ret mangler hvilket event det gælder), så LAD VÆRE med at kalde et værktøj. Svar i stedet med ét kort dansk opklarende spørgsmål. Gem ALDRIG noget i stilhed du var i tvivl om.',
    '- Indeholder samtalen ovenfor et spørgsmål du selv har stillet, er Gustavs nye besked svaret på det. Brug HELE samtalen til at udføre den oprindelige handling - spørg ikke igen om noget der allerede er oplyst.',
    '- Skriv aldrig tankestreger (lange — eller korte –) i dine spørgsmål eller svar. Brug punktum eller almindelig bindestreg.',
  ].join('\n')
}

// Kun tidspunktet. Skilt ud i sin egen blok så det ikke buster cachen på resten.
function buildVolatileSystem(now: Date): string {
  return `Lige nu i København (Europe/Copenhagen): ${nowInCopenhagen(now)}.`
}

export type RouterResult =
  | { kind: 'tool'; tool: string; input: Record<string, unknown> }
  | { kind: 'ask'; askText: string }
  | { kind: 'none' }

// En tur i samtalen. routeMessage kan tage enten en enkelt streng (statsløst, ét
// kald) eller hele samtalen (flertur), så et svar på routerens eget spørgsmål
// vurderes MED kontekst i stedet for kontekstløst.
export type RouterTurn = { role: 'user' | 'assistant'; content: string }

type AnthropicContentBlock =
  | { type: 'tool_use'; name: string; input?: Record<string, unknown> }
  | { type: 'text'; text: string }
  | { type: string; [k: string]: unknown }

// Returnerer modellens valg uden at udføre det. input er enten Gustavs ene besked
// (statsløst) eller hele samtalen inkl. routerens tidligere spørgsmål (flertur).
export async function routeMessage(
  input: string | RouterTurn[],
  now: Date = new Date(),
  globalFacts: string = ''
): Promise<RouterResult> {
  const messages = typeof input === 'string' ? [{ role: 'user' as const, content: input }] : input
  // System sendes som to blokke: et stabilt prefiks (identitet + lærte fakta +
  // regler) med cache_control, og en volatil hale med tidspunktet. Cache-brudet
  // sidder på det stabile prefiks, så tools + den del genbruges fra prompt-cachen.
  const system = [
    {
      type: 'text' as const,
      text: buildStableSystem(globalFacts),
      cache_control: { type: 'ephemeral' as const },
    },
    { type: 'text' as const, text: buildVolatileSystem(now) },
  ]
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': requireEnv('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: ROUTER_MODEL,
      max_tokens: 400,
      temperature: 0,
      system,
      tools: TOOLS,
      messages,
    }),
  })
  if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}: ${await r.text()}`)

  const j = await r.json()
  const blocks: AnthropicContentBlock[] = j.content || []
  const toolBlock = blocks.find((b) => b.type === 'tool_use') as
    | { type: 'tool_use'; name: string; input?: Record<string, unknown> }
    | undefined
  if (toolBlock) {
    return { kind: 'tool', tool: toolBlock.name, input: toolBlock.input || {} }
  }
  const textBlock = blocks.find((b) => b.type === 'text') as
    | { type: 'text'; text: string }
    | undefined
  if (textBlock) return { kind: 'ask', askText: textBlock.text.trim() }
  return { kind: 'none' }
}
