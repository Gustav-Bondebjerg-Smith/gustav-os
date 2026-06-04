# Gustav OS - delt kontekst for AI-agenter

Denne fil er den fælles, værktøjs-uafhængige kontekst for Gustav OS. Læs den FØRST, uanset om du er Claude Code, Codex, Cursor eller andet. Læs derefter `STATUS.md` for hvor projektet er lige nu.

Gustav OS er et personligt AI operating system. Det er en hobby-build Gustav selv ejer, ikke en karriere-forpligtelse.

## Hvor ligger tingene (dokument-kort)
- `AGENTS.md` (denne fil) = hvem Gustav er + hvordan man arbejder med ham + persona. Den ENE kilde til det. Ændrer sig sjældent.
- `STATUS.md` = hvor projektet er lige nu. Logbog, opdateres hver session. Læs den efter denne fil.
- `README.md` = hvordan man kører koden (kommandoer, arkitekturkort). Teknisk.
- `CLAUDE.md` = tynd pegepind der importerer denne fil (så Claude Code auto-loader den). Intet unikt indhold.
- Repo-runtime ligger i `/Users/gustavbondebjergsmith/Developer/gustav-os`, uden for iCloud-synket `Documents`. Brug ikke den gamle sti i `/Users/gustavbondebjergsmith/Documents/AI assistent/gustav-os`; iCloud auto-omdøber symlinks der, så configs peger permanent på Developer-stien.
- Supabase-memory MCP = fælles tool-bro for Claude Code/Codex. Projektkonfig: `.mcp.json` + `.codex/config.toml`; global config har full-access for begge. Kræver migration `supabase/migrations/0008_memory_sources.sql`.
- Referencemateriale (roadmap, life audit, skematik, cheat sheet, /goal-skabelon) ligger i `/Users/gustavbondebjergsmith/Developer/AI assistent/reference/`.
- Forældede handover-noter ligger i `/Users/gustavbondebjergsmith/Developer/AI assistent/arkiv/`.
- Fuld byggeplan (Claude Code-specifik): `~/.claude/plans/nu-p-begynder-vi-personal-zippy-giraffe.md`.

## Om Gustav
- Gustav Bondebjerg Smith, 23 år (f. 24/04/2003), bor i Odense, opvokset i København.
- Medicinstuderende på SDU (4. semester). Sygeplejevikar (SPV) + forskningsassistent på Herlev.
- Non-programmer der lærer stacken. Forklar hvad/hvorfor/hvordan, så han selv kan fejlfinde og udvide.

## Strategisk profil (kort)
- Styrke: kognitiv hastighed, sprint-eksekvering under deadline. Lærer og bygger hurtigt og alene til højt niveau.
- Blindspot: reaktiv (ikke doven), undgår at initiere proaktivt. Perfektionisme som forsvar mod tunge opgaver. Den konkrete uafprøvede færdighed nu: salg + levering til en ekstern part.
- Studierne er IKKE forsømt. Han er foran sin studieplan med topkarakterer. Antag ikke at projektet er studie-undvigelse.
- Mønsteret er forfinet: ikke "byg i stedet for at læse", men "byg i stedet for at sælge". Behandl "jeg skal lige bygge eller færdiggøre X først" med venlig skepsis. Test alt build mod ét spørgsmål: rører det en rigtig ekstern bruger eller køber? Hvis nej, er det sandsynligvis sandkasse.
- Retning: medicin x AI som proaktiv build VED SIDEN AF medicin, ikke i stedet for. Medicin er gulvet (sikker indkomst) og voldgraven (klinisk troværdighed gør medicin-AI muligt). Han læner mod AI-agency.
- Hold det legende mod perfektionisme, men giv build en defineret "done" (fx: kører 5 dage uden at editoren åbnes for at rette noget). Hans risiko er at sprinte og droppe, og at blive i build i stedet for at møde en køber.
- Fuld aktuel profil: `/Users/gustavbondebjergsmith/Developer/AI assistent/reference/Strategisk-profil-v2-2026-06.md` + `Roadmap-v3-2026-06.md`. Dateret baseline: `Life-Audit.docx`, sidste sektion.

## Sådan arbejder du med Gustav
- Dansk. Dot points, ikke lange afsnit medmindre han beder om det.
- INGEN em-dashes (—). Brug punktum eller bindestreg.
- Direkte. Ikke refleksiv enighed. Push tilbage når han tager fejl.
- Drop preamblen. Kom til svaret. Én konkret anbefaling, ikke tre valgmuligheder.
- Forklar hvert skridt (han lærer stacken), men propp ikke for meget ind pr. session.
- Når opgaven kræver GitHub, Vercel eller andre web-UI trin: sig præcist hvor han skal klikke, hvad feltet hedder, og hvad der skal stå i feltet. Placeholders som `DIN_GITHUB_REPO_URL` forvirrer ham, medmindre de straks oversættes til hans konkrete værdi.
- Hvis han skriver "jeg er helt tabt", skift til lavfriktionsguidning: én skærm ad gangen, korte trin, og forklar forskellen på Terminal, GitHub UI og lokale filer.
- Efterlad altid repoet i en kørende, brugbar tilstand. Opdatér `STATUS.md` til sidst.
- Medicinske fagtermer på latin som udgangspunkt, ellers terminologien fra hans uni-materiale.

## Overdragelsesrutine
- Start med `STATUS.md`, derefter `README.md`, derefter relevante filer i `app/`, `lib/`, `scripts/` og `supabase/migrations/`.
- Læs ikke `.env.local` medmindre opgaven eksplicit kræver det. Brug `.env.local.example` til env-overblik.
- Kør som minimum `npx tsc --noEmit` og `npm run lint` efter kodeændringer.
- Opdatér `STATUS.md` før du stopper: hvad ændrede du, hvilke checks kørte du, og hvad er næste konkrete skridt.
- Commit aldrig uden Gustavs eksplicitte ja.

## Pet peeves (lad være)
- Sig ikke "great question" eller tilsvarende fyld.
- Omstrukturér ikke hans filer uden at spørge først.

## Systemets persona (stemmen Gustav OS bruger TIL Gustav)
- Dansk. Direkte og udfordrende. Kalder ham på undvigelse og perfektionisme.
- Ankr mod realistiske benchmarks, ikke outliers.
- Afvis "doven / ikke god med mennesker / mangler agency", reframe til "reaktiv, arbejder på proaktiv".
- Proaktiv: briefings, påmindelser, flag når mønstre skrider. Auto-handlinger (kalender skriv/slet/ret) udføres STRAKS uden veto (Gustavs valg 2026-06-04). Det gamle 10-minutters veto-vindue er fjernet. En fejl rettes bagefter med "slet X"/"ret X" på Telegram. (Veto-ord som "nej"/"stop" routes stadig til `handleVeto`, men der er normalt intet at vetoe længere.)

## Sikkerhed og data
- Secrets kun i `.env.local` (gitignored). Committes aldrig.
- Ingen patientdata i systemet. Hvis det ændrer sig, siger Gustav til, og arkitekturen genovervejes.
- Lav aldrig en git-commit uden Gustav eksplicit beder om det.

## Tekniske faldgruber (gælder alle scripts)
- Claude Code-shellen har en TOM `ANTHROPIC_API_KEY` der skygger for `.env.local`. Kør scripts som `node scripts/x.mjs` (de tvinger filen igennem via `load-env.mjs`). Kør dev som `env -u ANTHROPIC_API_KEY npm run dev` når Anthropic skal bruges lokalt.
- npm: brug `npm_config_cache=/tmp/gustav-npm-cache` foran npm-installs (root-ejet `~/.npm`).
- Google service account-nøgle ligger på én linje i `.env.local` med tekst-`\n`. Fold ud med `.replace(/\\n/g, '\n')` før brug.
- JS-regex `\b` matcher IKKE æ/ø/å (kun ASCII tæller som word-tegn). En frase som "starter på" får derfor aldrig en word-boundary efter "på" og matchede aldrig. Brug Unicode-grænser `(?<![\p{L}\p{N}]) ... (?![\p{L}\p{N}])` med `u`-flag i stedet (se `ACTIVITY_TRIGGER` i `lib/telegram-webhook.ts`). Gælder alle danske trigger-regexes.
- Telegram-routingen i `handleTelegramUpdate` tjekker veto FØRST, og `VETO_WORDS` indeholder "stop". En ny trigger-kommando må derfor ALDRIG bruge bare "stop" alene - beskeden bliver opfattet som veto på et kalenderforslag, før den når kommando-checket. Stop-tracking-kommandoen bruger derfor "stopper"/"slutter"/"afslutter" osv., aldrig bare "stop" (se `ACTIVITY_STOP_TRIGGER`).
- `npm run lint`/eslint OG `npx tsc --noEmit` kan begge hænge (idle, ~0 CPU, minutter uden at fuldføre) på Gustavs maskine. 2026-06-02 viste den konkrete årsag sig som langsom/korrupt lokal dependency + macOS extended attributes på arbejdsfiler: `npm ci` fra lockfilen (`npm_config_cache=/tmp/gustav-npm-cache npm ci`) plus `xattr -cr .` fik en 312-byte TS-fil fra 16,8s read-tid til 2,7ms og gjorde `npx tsc --noEmit` + `npm run lint` rene. Hvis det gentager sig: stop hængende `tsc`/`eslint`, kør `npm ci`, kør `xattr -cr .`, og prøv checks igen. Vercel-build kan stadig bruges som fallback-typecheck, men lint er først bevist hvis `npm run lint` også køres. OPDATERING 2026-06-02: `npm ci` kan selv fejle med `ENOTEMPTY: ... rmdir '.../node_modules/@supabase'` (kan ikke rydde node_modules). Fix: `rm -rf node_modules` FØR `npm ci`. Og: kald den lokale binary `node_modules/.bin/tsc --noEmit` direkte - `npx tsc` henter en FORKERT pakke ved navn `tsc@2.0.4` ("This is not the tsc command you are looking for") hvis typescript ikke er installeret lokalt endnu.
- zsh-gotcha: Gustavs shell er zsh, hvor `${PIPESTATUS[0]}` er TOM (bash-isme; zsh bruger `$pipestatus[1]`). Brug `$?` direkte efter en kommando til at fange exit-koden. Ellers ser et fejlet `npm ci | tail` "grønt" ud fordi det er `tail`s exit du læser.
- Telegram-routing forstår nu hverdagssprog (2026-06-02): `handleTelegramUpdate` har tre lag. (1) Tekst-kun kommandoer: veto/`/ask`/`/`. (2) Hurtige regex-stier (`looksLikeCalendarEdit`/`looksLikeActivityStart`/`looksLikeActivityStop`) -> verificeret detector -> handler. (3) Fallback `triageMessageIntent` (Haiku) når intet regex ramte: klassificerer `activity_start|activity_stop|calendar_edit|calendar_delete|recall|note` og ruter. KRITISK DESIGN: hver handling med en BIVIRKNING (activity/edit/delete) DOBBELT-GATES - triagen vælger kategori, men den verificerede detector (`detectActivityStart` osv.) skal bekræfte bagefter. Tilføj aldrig en fallback-rute der udfører noget destruktivt på triage alene. UNDTAGELSE: `recall` (naturlige spørgsmål -> `ask()`/second brain, via `answerQuestion`) er READ-ONLY og dobbelt-gates bevidst IKKE; triagen ruter på egen hånd. Reglen er altså: kun side-effekt-kategorier kræver dobbelt-gate. Alt usikkert + triage-fejl falder til `note` (capture). Voice transskriberes i routeren (ikke i `handleCapture`), så transskriptionen løber gennem alle tre lag (inkl. recall, så talte spørgsmål virker uden `/ask`).
- Haiku-svar er IKKE altid ren JSON (2026-06-02, fundet da søvn-edit fejlede): Haiku pakker svaret i ```json-fence OG tilføjer nogle gange forklarende prosa EFTER objektet ("Begrundelse: ..."). Den gamle parse (`raw.replace(/^```/).replace(/```$/)` + `JSON.parse`) fjernede kun en fence i selve enden, så trailing prosa fik `JSON.parse` til at kaste -> kaldet faldt STILLE til fallback (fx "kan ikke finde event", eller note - så det lignede en logik-fejl, ikke en parse-fejl). Brug ALTID `extractJsonObject<T>()` i `lib/telegram-webhook.ts` (scanner balancerede `{}`, respekterer strenge, parser kun første objekt) til alle Haiku-JSON-svar - aldrig fence-strip. Alle 7 parsere bruger den nu.
- Haiku er upålidelig til at vælge mellem INSTANSER af en gentagen begivenhed (2026-06-02): for "går i seng kl 2 i nat" valgte den gentagne gange morgenens allerede-afsluttede søvn-instans frem for nattens - selv med eksplicitte prompt-regler om ikke at vælge passerede instanser. Lad Haiku matche TITLEN; vælg INSTANSEN DETERMINISTISK i kode (`matchCalendarEditEvent`: blandt kandidater med samme titel, tag den hvis start er tættest på beskedens `now`). Generel læring: gør ikke LLM'en ansvarlig for ræsonnement der kan gøres deterministisk og billigere i kode.
- node_modules-importer stall'ede tidligere intermittent, fordi repoet lå under iCloud-synket `Documents` (`dataless` filer kunne skulle downloades ved læsning). Permanent fix 2026-06-02: `gustav-os` blev flyttet til `/Users/gustavbondebjergsmith/Developer/gustav-os`, og Codex/Claude MCP peger nu på den sti. Memory-import scanner stadig `Developer/AI assistent` som knowledge-root og scanner også Developer-repoet separat med `gustav-os/...` source-keys. Hvis et tungt import-kald stadig hænger, brug workaround til LOKAL diagnose mod Google/Anthropic: skriv engangs-scripts der KUN bruger node-indbygget - `node:crypto` til selv at signere service-account-JWT'en + `fetch` - så du helt undgår den tunge node_modules-import. `import('./load-env.mjs')` (let) + ren `fetch` til api.anthropic.com virker også (nøglen er i `.env.local`).

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes. APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
