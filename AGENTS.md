# Gustav OS - delt kontekst for AI-agenter

Denne fil er den fælles, værktøjs-uafhængige kontekst for Gustav OS. Læs den FØRST, uanset om du er Claude Code, Codex, Cursor eller andet. Læs derefter `STATUS.md` for hvor projektet er lige nu.

Gustav OS er et personligt AI operating system. Det er en hobby-build Gustav selv ejer, ikke en karriere-forpligtelse.

## Hvor ligger tingene (dokument-kort)
- `AGENTS.md` (denne fil) = hvem Gustav er + hvordan man arbejder med ham + persona. Den ENE kilde til det. Ændrer sig sjældent.
- `STATUS.md` = hvor projektet er lige nu. Logbog, opdateres hver session. Læs den efter denne fil.
- `README.md` = hvordan man kører koden (kommandoer, arkitekturkort). Teknisk.
- `CLAUDE.md` = tynd pegepind der importerer denne fil (så Claude Code auto-loader den). Intet unikt indhold.
- Referencemateriale (roadmap, life audit, skematik, cheat sheet, /goal-skabelon) ligger i `../reference/`.
- Forældede handover-noter ligger i `../arkiv/`.
- Fuld byggeplan (Claude Code-specifik): `~/.claude/plans/nu-p-begynder-vi-personal-zippy-giraffe.md`.

## Om Gustav
- Gustav Bondebjerg Smith, 23 år (f. 24/04/2003), bor i Odense, opvokset i København.
- Medicinstuderende på SDU (4. semester). Sygeplejevikar (SPV) + forskningsassistent på Herlev.
- Non-programmer der lærer stacken. Forklar hvad/hvorfor/hvordan, så han selv kan fejlfinde og udvide.

## Strategisk profil (kort)
- Styrke: kognitiv hastighed, sprint-eksekvering under deadline.
- Blindspot: reaktivt engagement, undgår proaktiv initiering. Perfektionisme som forsvar mod tunge opgaver.
- Mål: konvertere medicin x AI til en proaktiv build han selv ejer.
- Behandl projektet som hobby og leg, ikke karriere-forpligtelse, for at modvirke perfektionisme-paralyse.
- Retention er designkriterie nr. 1: synlig værdi tidligt, lav friktion. Hans risiko er at sprinte og droppe projektet, ikke dovenskab.
- Fuld profil i `../reference/Life-Audit.docx`, sidste sektion.

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
- Proaktiv: briefings, påmindelser, flag når mønstre skrider. Auto-handlinger har altid Telegram-veto.

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
- `npm run lint`/eslint OG `npx tsc --noEmit` kan begge hænge (idle, ~0 CPU, minutter uden at fuldføre) på Gustavs maskine. 2026-06-02 viste den konkrete årsag sig som langsom/korrupt lokal dependency + macOS extended attributes på arbejdsfiler: `npm ci` fra lockfilen (`npm_config_cache=/tmp/gustav-npm-cache npm ci`) plus `xattr -cr .` fik en 312-byte TS-fil fra 16,8s read-tid til 2,7ms og gjorde `npx tsc --noEmit` + `npm run lint` rene. Hvis det gentager sig: stop hængende `tsc`/`eslint`, kør `npm ci`, kør `xattr -cr .`, og prøv checks igen. Vercel-build kan stadig bruges som fallback-typecheck, men lint er først bevist hvis `npm run lint` også køres.

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes. APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
