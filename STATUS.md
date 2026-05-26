# Gustav OS - STATUS

Sidst opdateret: 2026-05-26

## Hvor er vi
Fase 4 FÆRDIG. Systemet kan nu skrive aftaler i din kalender PÅ EGNE BEN, med veto-vindue. Flow: capture-besked klassificeres som type=aftale, Claude Haiku udleder titel + start + slut, du får et forslag på Telegram med 10 min til at vetoe ved at svare "nej" (eller "veto"/"stop"/"annuller"/"skip"). Vetoer du ikke, udfører watcheren det automatisk og bekræfter på Telegram. Alle vetoer og udførelser logges immutabelt i `audit_log`. Næste milepæl: Fase 5 (memory/ask - semantisk søgning i alt du har capturet, plus "spørg" assistenten om dit eget liv).

## Færdigt
- Milestone 0: Next.js 15 + TS + Tailwind, git, secrets gitignored, CLAUDE.md, memory.
- Fase 1: Supabase forbundet, schema kørt (6 tabeller + pgvector + RLS), round-trip verificeret.
- Nøgler: Anthropic + OpenAI + Telegram + Google service account valideret. Telegram-bot LÅST til Gustav (`TELEGRAM_CHAT_ID` sat).
- Fase 2 (tekst + voice): long-polling capture. Voice -> Whisper (whisper-1, dansk). Klassificering med Claude Haiku. Område: personlig/studie/arbejde. Type: opgave/note/ide/aftale. Capture er helligt: råindhold gemmes FØR klassificering.
- Fase 3 (kalender + balance): Google service account (kun læseadgang), primær kalender delt med robotten. `scripts/calendar.mjs` henter events via JWT-auth (`google-auth-library`). `scripts/balance.mjs` regner præcise timer pr. kategori i kode, Claude Sonnet 4.6 kategoriserer + skriver rapporten i personaen. Levering: terminal eller `--telegram`.
- Fase 4 (auto-handlinger + Telegram-veto): Google service account opgraderet til "Make changes to events". Ny `actions`-tabel (state machine: proposed/executed/vetoed/failed). `scripts/calendar-write.mjs` indsætter + sletter events (scope `calendar.events`). `scripts/propose.mjs` lader Haiku udlede {summary, start, end, location?} fra capture-tekst, eller returnere null hvis tiden er vag. `scripts/telegram-poll.mjs` udvidet: ved type=aftale sendes forslag, ved enkelt-veto-ord markeres nyeste proposed action som vetoed. `scripts/watch-actions.mjs` udfører forslag efter veto-vindue, opdaterer status, logger i `audit_log` med statusserne `applied`/`vetoed`/`failed`. Default veto-vindue 10 min, kan sættes lavere under test via `VETO_MINUTES` env.
- scripts/: load-env, test-db, test-keys, list-models, telegram-poll, classify, transcribe, reclassify, show-captures, calendar, balance, calendar-write, propose, watch-actions, show-actions. Kør som `node scripts/<navn>.mjs`.
- Portable kontekst (arbejdsform, persona, profil, faldgruber): ligger i `AGENTS.md`. Læses af Claude Code (via `@AGENTS.md`-import i `CLAUDE.md`) OG andre værktøjer (Codex, Cursor osv.). Skifter du værktøj: bed det nye læse `STATUS.md` + `AGENTS.md` først.

## Sådan bruger du det nu
- Capture (tekst + voice): `node scripts/telegram-poll.mjs` (Ctrl+C stopper, `--once` for én runde).
- Auto-skriv aftaler: kør polleren OG `node scripts/watch-actions.mjs` parallelt i to terminaler. Aftale-beskeder får et Telegram-forslag, og hvis du intet siger inden 10 min, skrives det i kalenderen. Veto med "nej". Hvis watcheren ikke kører, ophobes forslag som proposed og udføres næste gang du starter den.
- Se dine captures: `node scripts/show-captures.mjs`.
- Se dine actions (proposed/executed/vetoed/failed): `node scripts/show-actions.mjs`.
- Balance-rapport: `node scripts/balance.mjs` (eller `--telegram` for at få den på telefonen).
- Efterklassificer ubehandlede captures: `node scripts/reclassify.mjs`.
- Polleren + watcheren kører kun mens terminalen kører. Altid-online kommer ved deploy til Vercel (webhook + cron).

## Næste: Fase 5 (memory/ask)
Mål: alle captures, tasks og udvalgte calendar-events embeddes til `memory_chunks` (vector(1536), OpenAI text-embedding-3-small, klar fra Fase 1). Ny ask-funktion (CLI + Telegram-kommando): du spørger på dansk, systemet henter top-N relevante chunks via cosine similarity, Claude svarer kontekstualiseret med kilde-links. Tilføj ivfflat/hnsw-index når der er nok data. Forberedelse til Fase 6 (dashboard) og Fase 7 (cron med adaptive briefings).

## Faser
0 Life Audit [done] | 0.5 Fundament [done] | 1 Supabase+schema [done] | 2 Capture pipeline [done] | 3 Calendar+balance [done] | 4 Auto-handlinger [done] | 5 Memory/ask [næste] | 6 Dashboard | 7 Cron

## Noter / faldgruber
- VIGTIGT: Claude Code-shellen har en TOM `ANTHROPIC_API_KEY` der skygger for `.env.local`. Kør scripts som `node scripts/x.mjs` (bruger `load-env.mjs`). Kør dev-server som `env -u ANTHROPIC_API_KEY npm run dev` når Anthropic skal virke lokalt.
- npm cache: brug `npm_config_cache=/tmp/gustav-npm-cache` foran npm-installs (root-ejet `~/.npm`). Permanent: `sudo chown -R 501:20 ~/.npm`.
- Deploy senere: skift fra long-polling til webhook på Vercel for altid-online capture (`TELEGRAM_WEBHOOK_SECRET` ligger klar i `.env.local`). Watch-actions skal også flyttes til en serverless cron eller en vedvarende proces.
- Whisper: ~95% nøjagtig på dansk. Råtekst gemmes altid, så intet går tabt.
- Google service account: nøgle ligger på én linje i `.env.local` med tekst-`\n`. Fold ud med `.replace(/\\n/g, '\n')` før brug. Læse-scope (`calendar.readonly`) i `calendar.mjs`, skrive-scope (`calendar.events`) i `calendar-write.mjs` - hold dem adskilt.
- audit_log: gemmer kun terminal-states (`applied`/`vetoed`/`failed`). Forslag (proposed actions) bor kun i `actions`-tabellen. Hvis Supabase under setup ikke kender `actions.type` (eller andre kolonner mangler), kør `drop table actions cascade;` og derefter `0002_actions.sql` igen - tabellen er kun forslag, så det er sikkert.
- git: Fase 1+2 committet (db1e152). Fase 3 committet (0e5e466). Fase 4 committes lige efter denne STATUS-opdatering. Claude committer kun når Gustav beder om det.
