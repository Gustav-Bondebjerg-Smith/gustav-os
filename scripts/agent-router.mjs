// Tool-calling router (v1) - erstatningen for cascaden.
//
// Én Sonnet-model får beskeden + tid + dine værktøjer og VÆLGER hvad der skal
// ske. Ingen regex, ingen triage, ingen double-gate. Det her er kernen i det nye
// design: oversæt sprog -> ét værktøjskald.
//
// VIGTIGT: dette modul UDFØRER ikke noget. Det returnerer kun modellens valg
// (værktøjsnavn + argumenter). Replay-harnessen og den senere webhook bestemmer
// selv om/hvordan kaldet eksekveres. Det gør den sikker at køre mod golden-set'et
// uden at røre din rigtige kalender eller DB.
import './load-env.mjs'

export const ROUTER_MODEL = 'claude-sonnet-4-6'

function nowInCopenhagen(value = new Date()) {
  return new Intl.DateTimeFormat('da-DK', {
    timeZone: 'Europe/Copenhagen',
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(value)
}

// Værktøjerne = dine verber. Hvert navn mapper 1:1 til en eksisterende funktion
// i lib/ (insertEvent, updateEvent, deleteEvent, pending_activity, ask, saveCapture).
// Skemaerne er bevidst MINIMALE - nok til at vælge rigtigt og udfylde slots.
export const TOOLS = [
  {
    name: 'create_event',
    description: 'Opret en NY kalenderbegivenhed. Brug når Gustav nævner en konkret fremtidig aftale med tidspunkt (fx "møde med Anna fredag kl 14", "lægetid i morgen kl 15", "arbejde i morgen 15-23").',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Kort titel, første bogstav stort' },
        start: { type: 'string', description: 'ISO naiv lokal tid YYYY-MM-DDTHH:MM:00' },
        end: { type: 'string', description: 'ISO naiv lokal tid; hvis kun starttid, sæt +1 time' },
      },
      required: ['summary', 'start', 'end'],
    },
  },
  {
    name: 'edit_event',
    description: 'RET tiden på en eksisterende begivenhed (inkl. den faste daglige søvn-begivenhed). Brug ved "ret/ændre/flyt", "X gik til nu", "går i seng kl 2" (= ret søvn-start), "står op kl 7" (= ret søvn-slut).',
    input_schema: {
      type: 'object',
      properties: {
        event_hint: { type: 'string', description: 'Titel/søgeord på eventet, fx "uni" eller "søvn"' },
        edit_type: { type: 'string', enum: ['start', 'end', 'shift'], description: 'start=ret starttid, end=ret sluttid, shift=flyt hele eventet' },
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
    description: 'Start tidstagning af en aktivitet LIGE NU. Brug når Gustav siger han går i gang med noget nu, også i hverdagssprog: "starter testaktivitet", "begynder på læsning nu", "nu kaster jeg mig over anatomien", "i gang med frokost". KUN nutid, ikke fortid/fremtid.',
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
    description: 'Stop/pause den aktive tidstagning LIGE NU uden at starte en ny. Brug ved "slutter", "stopper", "afslutter", "holder pause", "færdig", "done", "det var det for i dag". KUN nutid.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'search_memory',
    description: 'Slå op i Gustavs second brain (tidligere noter/captures/planer) og svar. Brug når han SPØRGER om noget han vil have at vide: "hvad skulle jeg nå i dag", "hvad havde jeg af opgaver", "hvornår skulle jeg ringe til mor".',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Spørgsmålet der skal slås op' },
      },
      required: ['query'],
    },
  },
  {
    name: 'suggest_meal',
    description: 'Foreslå hvad Gustav skal lave at spise (typisk aftensmad, men også frokost/morgenmad/snack). Brug når han SPØRGER om et mad-forslag eller en opskrift: "hvad foreslår du jeg laver til aftensmad", "find en opskrift med kylling", "noget hurtigt og proteinrigt i aften". Returnerer en konkret opskrift (fra kataloget eller nygenereret). Et mad-spørgsmål er ALDRIG search_memory.',
    input_schema: {
      type: 'object',
      properties: {
        meal: { type: 'string', enum: ['morgenmad', 'frokost', 'aftensmad', 'snack'], description: 'Hvilket måltid. Udelad hvis uklart (default aftensmad).' },
        constraints: { type: 'string', description: 'Gustavs egne ønsker ordret: ingrediens ("med kylling"), tid ("noget hurtigt"), stil ("ekstra protein"). Udelad hvis intet nævnt.' },
      },
      required: [],
    },
  },
  {
    name: 'save_note',
    description: 'Gem beskeden som en note i second brain. Det RETTE valg for IKKE-handlinger: tanker, ideer, observationer og fakta/info Gustav vil huske. Det er IKKE en skraldespand, og IKKE for ting Gustav skal GØRE - et konkret næste-skridt (også "husk at gøre X") er en opgave (create_task).',
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
    description: 'Gem et VARIGT faktum/præference/korrektion om Gustav (eller et projekt), så assistenten husker det fremover og ændrer adfærd. Brug når Gustav RETTER dig eller fortæller noget der skal gælde varigt: "jeg træner om aftenen, ikke om morgenen", "kald mig Gustav", "foreslå ikke X mere". IKKE for noter, reminders eller engangsting (det er save_note).',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'], description: 'user=fakta/præference om Gustav, feedback=korrektion/instruks, project=projekt-viden, reference=ekstern kilde' },
        key: { type: 'string', description: 'Kort kebab-case nøgle, fx "traening-tidspunkt". Samme key overskriver et tidligere faktum.' },
        content: { type: 'string', description: 'Selve faktummet, kort og konkret, så det kan stå alene.' },
        why: { type: 'string', description: 'Kort begrundelse ved korrektion/feedback. Valgfri.' },
      },
      required: ['type', 'key', 'content'],
    },
  },
  {
    name: 'create_task',
    description: 'Tilføj en NY opgave til Gustavs opgave-board (to-do). Brug når beskeden er et konkret NÆSTE-SKRIDT Gustav skal GØRE (handlingsverbum: ring, læs, køb, aftal, send, book, opdater...), også pakket som reminder: "husk at ringe til mor", "tilføj opgave: køb mælk", "jeg skal nå at læse kapitel 5". IKKE en aftale med klokkeslæt (create_event), og IKKE en ikke-handling som en tanke/observation/fakta (save_note).',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Opgaven som kort handling. Behold tids-ord ("i morgen", "på fredag") hvis nævnt - de sætter en frist. Drop kommando-ord som "tilføj opgave".' },
      },
      required: ['title'],
    },
  },
  {
    name: 'complete_task',
    description: 'Marker en eksisterende opgave på boardet som FÆRDIG/afkrydset. Brug ved "jeg er færdig med X", "X er klaret", "kryds X af", "done med X".',
    input_schema: {
      type: 'object',
      properties: {
        task_hint: { type: 'string', description: 'Søgeord fra opgavens titel, så den rette opgave kan findes.' },
      },
      required: ['task_hint'],
    },
  },
  {
    name: 'move_task',
    description: 'Flyt en eksisterende opgave til en anden hastigheds-bunke på boardet. Brug ved "ryk X til i dag", "flyt X til denne uge", "X kan vente til senere".',
    input_schema: {
      type: 'object',
      properties: {
        task_hint: { type: 'string', description: 'Søgeord fra opgavens titel.' },
        urgency: { type: 'string', enum: ['today', 'week', 'month', 'someday'], description: 'today=i dag, week=denne uge, month=denne måned, someday=senere.' },
      },
      required: ['task_hint', 'urgency'],
    },
  },
  {
    name: 'delete_task',
    description: 'Slet en eksisterende opgave HELT fra boardet (fjern den, ikke marker færdig). Brug ved "slet opgaven X", "fjern X fra listen", "drop opgaven X".',
    input_schema: {
      type: 'object',
      properties: {
        task_hint: { type: 'string', description: 'Søgeord fra opgavens titel.' },
      },
      required: ['task_hint'],
    },
  },
  {
    name: 'list_tasks',
    description: 'Vis Gustavs åbne opgaver fra boardet. Brug når han SPØRGER hvad han skal lave / hvad der står på listen: "hvilke opgaver har jeg", "hvad skal jeg nå i dag", "hvad står på min to-do". Dette er det STRUKTUREREDE opgave-board, ikke noter i second brain (search_memory).',
    input_schema: {
      type: 'object',
      properties: {
        urgency: { type: 'string', enum: ['today', 'week', 'month', 'someday'], description: 'Valgfrit filter. Udelad for alle åbne opgaver.' },
      },
      required: [],
    },
  },
]

// Spejler lib/agent-router.ts: stabil del (identitet + lærte fakta + regler) +
// volatil del (kun tidspunktet). Splittet så lib kan cache det stabile prefiks;
// her holder vi samme tekst/struktur så replay tester præcis prod-routeren.
function buildStableSystem(globalFacts = '') {
  const facts = String(globalFacts || '').trim()
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
    '- save_note er for ægte noter/tanker/observationer/fakta UDEN en handling - ikke en default-skraldespand, og ikke for ting Gustav skal gøre (det er create_task).',
    '- save_memory gemmer et VARIGT faktum/præference/korrektion om Gustav eller et projekt, så assistenten husker det fremover. Brug det når Gustav retter dig eller fortæller noget der bør ændre fremtidig adfærd ("jeg træner om aftenen, ikke morgen", "kald mig Gustav"). IKKE for noter, reminders eller engangsting (det er save_note).',
    '- Opgave vs note: er beskeden et konkret NÆSTE-SKRIDT Gustav skal GØRE (handlingsverbum: ring, læs, køb, aftal, send, opdater...), så create_task - også når den er pakket som "husk at ringe til mor". Er den en ikke-handling (tanke, idé, observation, fakta han vil huske, vag musing), så save_note.',
    '- Skel opgave fra aftale: et KLOKKESLÆT -> create_event (kalender); en handling UDEN tidspunkt -> create_task (board). "ring til mor på fredag" (intet klokkeslæt) = create_task; "møde fredag kl 14" = create_event.',
    '- complete_task markerer en opgave færdig, move_task flytter den til en anden bunke (today/week/month/someday), delete_task fjerner den helt. Alle tre finder opgaven ud fra et søgeord i titlen.',
    '- Spørger Gustav til sine OPGAVER / sin to-do ("hvilke opgaver har jeg", "hvad skal jeg nå i dag") -> list_tasks (det strukturerede board), ikke search_memory. search_memory er til noter/captures/planer.',
    '- suggest_meal er til MAD: når Gustav spørger hvad han skal spise eller beder om en opskrift ("hvad foreslår du til aftensmad", "en opskrift med kylling", "noget hurtigt i aften"). Et mad-spørgsmål er ALDRIG search_memory og ALDRIG save_note.',
    '- Retter Gustav en VARIG mad-præference/allergi/mål ("jeg spiser ikke svinekød", "foreslå mere protein", "allergisk mod nødder") -> save_memory, ikke suggest_meal. suggest_meal er kun selve forslaget; varige fakta hører i save_memory og bruges så af suggest_meal næste gang.',
    '- Rene høflighedsfraser, hilsner, små-ord eller transskriptions-fragmenter uden konkret handling ("god fornøjelse", "tak", "ok", "godmorgen") -> save_note. De er IKKE stop_activity eller andre handlinger.',
    '- stop_activity KUN når Gustav tydeligt afslutter/pauser noget han er i gang med - ikke ved en afsked eller et høfligt udtryk.',
    '- En aktivitet Gustav startede tidligere men STADIG er i gang ("startede kl 16, er stadig i gang") kan ikke bruge start_activity (kun nutid). Brug create_event: summary = aktiviteten, start = det nævnte tidspunkt i dag, end = nu. Så logges den faktiske tidsblok.',
    '- Er beskeden ægte tvetydig (du kan ikke afgøre hvilken handling, eller en slet/ret mangler hvilket event det gælder), så LAD VÆRE med at kalde et værktøj. Svar i stedet med ét kort dansk opklarende spørgsmål. Gem ALDRIG noget i stilhed du var i tvivl om.',
    '- Indeholder samtalen ovenfor et spørgsmål du selv har stillet, er Gustavs nye besked svaret på det. Brug HELE samtalen til at udføre den oprindelige handling - spørg ikke igen om noget der allerede er oplyst.',
    '- Skriv aldrig tankestreger (lange — eller korte –) i dine spørgsmål eller svar. Brug punktum eller almindelig bindestreg.',
  ].join('\n')
}

function buildVolatileSystem(now) {
  return `Lige nu i København (Europe/Copenhagen): ${nowInCopenhagen(now)}.`
}

// Returnerer { kind, tool, input, askText, raw }.
//   kind: 'tool'  -> modellen valgte et værktøj (tool/input udfyldt)
//   kind: 'ask'   -> modellen var i tvivl og stiller et spørgsmål (askText udfyldt)
//   kind: 'none'  -> intet brugbart svar
export async function routeMessage(input, now = new Date(), globalFacts = '') {
  const messages = typeof input === 'string' ? [{ role: 'user', content: input }] : input
  const system = [
    { type: 'text', text: buildStableSystem(globalFacts), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: buildVolatileSystem(now) },
  ]
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
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
  const blocks = j.content || []
  const toolBlock = blocks.find((b) => b.type === 'tool_use')
  if (toolBlock) {
    return { kind: 'tool', tool: toolBlock.name, input: toolBlock.input || {}, raw: j }
  }
  const textBlock = blocks.find((b) => b.type === 'text')
  if (textBlock) return { kind: 'ask', askText: textBlock.text.trim(), raw: j }
  return { kind: 'none', raw: j }
}

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
