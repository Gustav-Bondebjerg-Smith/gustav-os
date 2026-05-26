# Gustav OS - STATUS

Sidst opdateret: 2026-05-26

## Hvor er vi
Fase 5 FÆRDIG. Din second brain er nu søgbar. Alle captures embeddes til `memory_chunks` (vector(1536), OpenAI text-embedding-3-small). Ny `/ask`-funktion: spørg på dansk i CLI (`node scripts/ask.mjs "..."`) eller på Telegram (`/ask <spørgsmål>`), systemet henter top-8 relevante chunks via cosine similarity, Claude Sonnet svarer i Gustav OS-personaen med citerede kilder. Auto-embed sker live når nye captures kommer ind. Verificeret: konkrete spørgsmål (aftaler) får brugbare svar med kilder, ukendt-svar-spørgsmål (søvn) afvises ærligt uden fabrikation. Næste milepæl: Fase 6 (dashboard) eller Fase 7 (cron med adaptive briefings).

## Færdigt
- Milestone 0: Next.js 15 + TS + Tailwind, git, secrets gitignored, CLAUDE.md, memory.
- Fase 1: Supabase forbundet, schema kørt (6 tabeller + pgvector + RLS), round-trip verificeret.
- Nøgler: Anthropic + OpenAI + Telegram + Google service account valideret. Telegram-bot LÅST til Gustav (`TELEGRAM_CHAT_ID` sat).
- Fase 2 (tekst + voice): long-polling capture. Voice -> Whisper (whisper-1, dansk). Klassificering med Claude Haiku. Område: personlig/studie/arbejde. Type: opgave/note/ide/aftale. Capture er helligt: råindhold gemmes FØR klassificering.
- Fase 3 (kalender + balance): Google service account (kun læseadgang), primær kalender delt med robotten. `scripts/calendar.mjs` henter events via JWT-auth (`google-auth-library`). `scripts/balance.mjs` regner præcise timer pr. kategori i kode, Claude Sonnet 4.6 kategoriserer + skriver rapporten i personaen. Levering: terminal eller `--telegram`.
- Fase 4 (auto-handlinger + Telegram-veto): Google service account opgraderet til "Make changes to events". Ny `actions`-tabel (state machine: proposed/executed/vetoed/failed). `scripts/calendar-write.mjs` indsætter + sletter events (scope `calendar.events`). `scripts/propose.mjs` lader Haiku udlede {summary, start, end, location?} fra capture-tekst, eller returnere null hvis tiden er vag. `scripts/telegram-poll.mjs` udvidet: ved type=aftale sendes forslag, ved enkelt-veto-ord markeres nyeste proposed action som vetoed. `scripts/watch-actions.mjs` udfører forslag efter veto-vindue, opdaterer status, logger i `audit_log` med statusserne `applied`/`vetoed`/`failed`. Default veto-vindue 10 min, kan sættes lavere under test via `VETO_MINUTES` env.
- Fase 5 (memory/ask): Ny migration `0003_memory_search.sql` med `search_memory(query_embedding, match_count, filter_area)` RPC. `scripts/embed.mjs` (delt modul: `embedText` + idempotent `storeChunk`, OpenAI text-embedding-3-small). `scripts/embed-captures.mjs` backfilder eksisterende raw_captures. `scripts/ask.mjs` embedder spørgsmål, kalder RPC, sender top-8 chunks + spørgsmål til Claude Sonnet 4.6 med Gustav OS-personaen, returnerer svar med citerede kilder. `telegram-poll.mjs` udvidet: `/ask <spørgsmål>` på Telegram + auto-embed efter hver capture (best-effort, blokerer ikke capture-gemning hvis OpenAI fejler). Idempotens via UNIQUE (source_type, source_id)-tjek i `storeChunk` så backfill kan køres flere gange.
- scripts/: load-env, test-db, test-keys, list-models, telegram-poll, classify, transcribe, reclassify, show-captures, calendar, balance, calendar-write, propose, watch-actions, show-actions, embed, embed-captures, ask. Kør som `node scripts/<navn>.mjs`.
- Portable kontekst (arbejdsform, persona, profil, faldgruber): ligger i `AGENTS.md`. Læses af Claude Code (via `@AGENTS.md`-import i `CLAUDE.md`) OG andre værktøjer (Codex, Cursor osv.). Skifter du værktøj: bed det nye læse `STATUS.md` + `AGENTS.md` først.

## Sådan bruger du det nu
- Capture (tekst + voice): `node scripts/telegram-poll.mjs` (Ctrl+C stopper, `--once` for én runde).
- Auto-skriv aftaler: kør polleren OG `node scripts/watch-actions.mjs` parallelt i to terminaler. Aftale-beskeder får et Telegram-forslag, og hvis du intet siger inden 10 min, skrives det i kalenderen. Veto med "nej". Hvis watcheren ikke kører, ophobes forslag som proposed og udføres næste gang du starter den.
- Se dine captures: `node scripts/show-captures.mjs`.
- Se dine actions (proposed/executed/vetoed/failed): `node scripts/show-actions.mjs`.
- Spørg din second brain: `node scripts/ask.mjs "spørgsmål"` eller send `/ask <spørgsmål>` på Telegram.
- Backfill embeddings hvis polleren har været nede: `node scripts/embed-captures.mjs` (idempotent, kun nye behandles).
- Balance-rapport: `node scripts/balance.mjs` (eller `--telegram` for at få den på telefonen).
- Efterklassificer ubehandlede captures: `node scripts/reclassify.mjs`.
- Polleren + watcheren kører kun mens terminalen kører. Altid-online kommer ved deploy til Vercel (webhook + cron).

## Næste: Fase 6 (dashboard) eller Fase 7 (cron)
Fase 6: Next.js-dashboard med login, oversigt over captures + actions + balance + ask-felt. Vejen til at få Gustav OS ud af terminalen og ind i en daglig flade.
Fase 7: Vercel-deploy + serverless cron med proaktive briefings (morgen-overblik, aften-refleksion, mønster-flag) bygget oven på ask + balance. Kræver Fase 6's deploy-fundament.
Sidenote: tasks-tabellen er stadig tom. Når der kommer faktisk taskhåndtering (måske som del af Fase 6), skal embed-captures udvides til også at embedde tasks + daily_logs + udvalgte calendar-events. Schema er klar (memory_chunks.source_type understøtter alt).

## Faser
0 Life Audit [done] | 0.5 Fundament [done] | 1 Supabase+schema [done] | 2 Capture pipeline [done] | 3 Calendar+balance [done] | 4 Auto-handlinger [done] | 5 Memory/ask [done] | 6 Dashboard [næste] | 7 Cron

## Noter / faldgruber
- VIGTIGT: Claude Code-shellen har en TOM `ANTHROPIC_API_KEY` der skygger for `.env.local`. Kør scripts som `node scripts/x.mjs` (bruger `load-env.mjs`). Kør dev-server som `env -u ANTHROPIC_API_KEY npm run dev` når Anthropic skal virke lokalt.
- npm cache: brug `npm_config_cache=/tmp/gustav-npm-cache` foran npm-installs (root-ejet `~/.npm`). Permanent: `sudo chown -R 501:20 ~/.npm`.
- Deploy senere: skift fra long-polling til webhook på Vercel for altid-online capture (`TELEGRAM_WEBHOOK_SECRET` ligger klar i `.env.local`). Watch-actions skal også flyttes til en serverless cron eller en vedvarende proces.
- Whisper: ~95% nøjagtig på dansk. Råtekst gemmes altid, så intet går tabt.
- Google service account: nøgle ligger på én linje i `.env.local` med tekst-`\n`. Fold ud med `.replace(/\\n/g, '\n')` før brug. Læse-scope (`calendar.readonly`) i `calendar.mjs`, skrive-scope (`calendar.events`) i `calendar-write.mjs` - hold dem adskilt.
- audit_log: gemmer kun terminal-states (`applied`/`vetoed`/`failed`). Forslag (proposed actions) bor kun i `actions`-tabellen. Hvis Supabase under setup ikke kender `actions.type` (eller andre kolonner mangler), kør `drop table actions cascade;` og derefter `0002_actions.sql` igen - tabellen er kun forslag, så det er sikkert.
- pgvector ivfflat-index: kræver mere `maintenance_work_mem` end Supabase's default 32MB. Først relevant ved tusinder af chunks. Når du tilføjer det, foranstil med `SET maintenance_work_mem = '128MB';` i samme SQL-blok. Indtil da er sequential scan hurtigt nok.
- PostgREST schema-cache: efter nye funktioner/tabeller skal cachen reloades. Kør `notify pgrst, 'reload schema';` i SQL Editor hvis du får PGRST202 ("Could not find the function...").
- Embed-modellen er `text-embedding-3-small` (1536 dim). Skifter du model, skal `memory_chunks.embedding`-kolonnen recreates med ny dimension OG alle eksisterende rækker re-embeddes. Lås modellen indtil det giver mening.
- git: Fase 1+2 committet (db1e152). Fase 3 committet (0e5e466). Fase 4 committet (00ad3f3 + polering 02f1736). Fase 5 committes lige efter denne STATUS-opdatering. Claude committer kun når Gustav beder om det.
