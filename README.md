# Gustav OS

Personligt AI operating system for Gustav. Appen er en Next.js 16 dashboard-flade oven på Supabase, Telegram capture, Google Calendar actions og en embeddet "second brain".

## Læs først

- `STATUS.md` er den aktuelle overdragelse. Start altid der.
- `AGENTS.md` er fælles kontekst for Claude, Codex, Cursor osv.
- `CLAUDE.md` importerer `AGENTS.md` og har Claude-specifik historik.
- Secrets ligger i `.env.local`. Den fil må ikke committes.

## Aktuel status

- Hele byggeplanen (Modul 1-5) er live på `https://gustav-os.vercel.app`: redesignet "I dag"-forside, opgave-board, mål, personlig finans (import + AI-kategorisering + nettoformue-kurve) og ugentlig review.
- Operatør-kortet viser ægte produktivitetstal (produktivitet + dækning) fra et dagligt nattecron.
- Telegram-webhook, magic-link-auth, kalender-write (udføres straks, intet veto), second brain og tids-tracking kører.
- Migrations til og med `0016_productivity_snapshots.sql` er kørt i prod. Seneste commit: 2e8711f (2026-06-05).
- Lokale workers beholdes til udvikling: `node scripts/telegram-poll.mjs`, `node scripts/watch-actions.mjs`.

## Lokal kørsel

Repoet bor nu lokalt uden for iCloud:

```bash
cd /Users/gustavbondebjergsmith/Developer/gustav-os
```

```bash
npm install
env -u ANTHROPIC_API_KEY npm run dev
```

Åbn `http://localhost:3000` og log ind med emailen fra `ALLOWED_EMAIL`.

Hvorfor `env -u ANTHROPIC_API_KEY`: Claude Code-shellen kan sætte en tom `ANTHROPIC_API_KEY`, som ellers skygger for `.env.local`.

## Nyttige kommandoer

```bash
npx tsc --noEmit
npm run lint
npm run build
node scripts/test-db.mjs
node scripts/show-captures.mjs
node scripts/show-actions.mjs
node scripts/embed-captures.mjs
node scripts/ask.mjs "hvad skal jeg huske?"
node scripts/memory-import-workspace.mjs --dry-run
node scripts/memory-import-workspace.mjs
node scripts/memory-export-backup.mjs
node scripts/memory-facts.mjs --list
node scripts/memory-facts.mjs --consolidate
node scripts/telegram-webhook.mjs get
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/actions
```

Til npm-installs på Gustavs maskine:

```bash
npm_config_cache=/tmp/gustav-npm-cache npm install
```

## Arkitekturkort

- `app/` - Next.js App Router dashboard: I dag (forside), opgaver, maal, finans, review, balance, captures, ask, login.
- `proxy.ts` - Next.js 16 proxy, refresh af Supabase cookies og auth-gating.
- `lib/supabase.ts` - service role client. Server-only. Kun interne flows.
- `lib/supabase-server.ts` - anon client med cookies. Bruges til bruger-sessioner.
- `lib/format.ts` og `lib/ask-types.ts` - client-sikre helpers/typer.
- `lib/memory.ts` - server-side embeddings + idempotent `memory_chunks` storage.
- `lib/memory-facts.ts` - lærende fakta-lag (`memory_facts`): save/recall af små, selvlærte fakta. Genbruger `embedText`.
- `lib/ask.ts` - TypeScript-port af ask-flowet til dashboard server action.
- `lib/agent-router-core.mjs` - routerens ENE hjerne (tools + prompt + routeMessage). Delt af `lib/agent-router.ts` (prod-facade) og `scripts/agent-router.mjs` (replay/CLI).
- `lib/telegram-webhook.ts` - webhook-INDGANGEN: claim/mark, veto, kommandoer, triage + routing-cascade. Splittet 2026-07-06; domænerne bor i `lib/telegram-shared.ts` (typer/API/transskription), `lib/telegram-calendar.ts`, `lib/telegram-activity.ts`, `lib/telegram-capture.ts`, `lib/telegram-recall.ts` og `lib/telegram-agent.ts` (router-dispatch).
- `lib/cron.ts` - `CRON_SECRET`-auth + DB-lock til serverless cron (+ puls til vagthunden i `cron_runs`).
- `lib/health.ts` - vagthunden: dagligt tjek af bankdata-friskhed (30 dage), kategoriseringskø og cron-puls. Flager kun på Telegram når noget er galt.
- `lib/calendar.ts` - server-side Google Calendar read/write helper.
- `lib/actions-runner.ts` - udfører due actions efter veto-vindue.
- `lib/proactive.ts` - ugentligt mønster-flag (morgen-/aftenbrief afskaffet 2026-06-03).
- `lib/tasks.ts` / `lib/goals.ts` - opgave-board + mål (server-only, med `-shared` klient-typer).
- `lib/finance.ts` - personlig finans: import, reconciliation, nettoformue, snapshots (+ `-shared`/`-csv`/`-storebox`/`-reconcile`/`-classify`).
- `lib/balance.ts` - tids-balance fra kalender (Sonnet-kategorisering, `unstable_cache`).
- `lib/weekly-review.ts` - ugentlig review (Sonnet, gemt + Telegram-leveret).
- `lib/productivity.ts` - dagligt produktivitets-snapshot (produktivitet + dækning, genbruger `getBalance`).
- `lib/capture.ts` - delt classify + saveCapture (Telegram + web).
- `scripts/` - CLI og lokale workers til Telegram, embeddings, kalender og balance.
- `supabase/migrations/` - SQL schema, actions og memory search RPC.

## Supabase memory MCP

Migration `supabase/migrations/0008_memory_sources.sql` udvider memory til canonical Supabase-sources, audit-log og `search_memory_v2`, uden at ændre den gamle `search_memory`.

- Import dry-run: `npm run memory:import:dry`
- Import hele workspacet + `gustav-os`: `npm run memory:import`
- Eksportér lokal backup: `npm run memory:export`
- Start MCP server manuelt: `MEMORY_MCP_ACCESS=full npm run memory:mcp`
- Fakta-lag MCP-tools (kræver migration `0010`): `memory_fact_recall_global`, `memory_fact_recall_project`, `memory_fact_list` (read) og `memory_fact_save` (kun full-access). Lader Claude Code/Codex læse Gustavs globale fakta og skrive projekt-scopede fakta. Se "Lærende fakta-lag" nedenfor.

Repo-runtime ligger i `/Users/gustavbondebjergsmith/Developer/gustav-os`, så MCP-serveren starter uden for den iCloud-synkede `Documents`-mappe. `npm run memory:import` scanner både `/Users/gustavbondebjergsmith/Developer/AI assistent` og repo-runtime, hvor repo-filer gemmes med `gustav-os/...` source-keys. Codex projektkonfig ligger i `.codex/config.toml`; Claude Code projektkonfig ligger i `.mcp.json`. Global Codex og global Claude Code har full-access memory via user config. Backup skrives til `/Users/gustavbondebjergsmith/Developer/AI assistent/supabase-memory-backup/` og er ikke canonical source.

## Lærende fakta-lag

Migration `supabase/migrations/0010_memory_facts.sql` tilføjer `memory_facts`: små, atomare fakta/præferencer som routeren selv skriver i runtime (save_memory) og som loades cache-stabilt ind i routerens prompt, så korrektioner ændrer adfærd uden kode-edit. Adskilt fra memory_sources (dok-RAG): én række = ét faktum, overskrevet på `(scope, key)`. Genbruger samme embedding-model via `lib/memory.ts`.

- Liste: `node scripts/memory-facts.mjs --list`
- Gem manuelt: `node scripts/memory-facts.mjs --save --type feedback --key traening-tidspunkt --content "Træner om aftenen" --why "..."`
- Konsolidér (foreslår dublet-merges, sletter intet): `node scripts/memory-facts.mjs --consolidate`

Routeren skriver scope `global` automatisk når Gustav retter den (svarer "🧠 Husket: ..."). Ligger bag `USE_AGENT_ROUTER`-flaget og kræver migration `0010`; uden tabellen falder save_memory blødt til en note og fakta-injektionen til tom streng.

Claude Code/Codex læser og skriver de samme fakta via MCP (`memory_fact_recall_global`, `memory_fact_recall_project`, `memory_fact_list`, `memory_fact_save`) - typisk projekt-scopede fakta om den repo de arbejder i. CLI og MCP deler kernen `scripts/memory-facts-core.mjs`, som spejler `lib/memory-facts.ts` (routerens TS-version).

## Telegram webhook

Efter deploy:

```bash
node scripts/telegram-webhook.mjs set https://dit-domain.dk/api/telegram
node scripts/telegram-webhook.mjs get
```

Webhook kræver:

- `TELEGRAM_WEBHOOK_SECRET` sat i lokal/Vercel env.
- `TELEGRAM_CHAT_ID` sat, ellers accepterer webhook'en ikke beskeder.
- Migration `supabase/migrations/0004_telegram_webhook.sql` kørt i Supabase.

## Cron

Cron endpoints:

- `/api/cron/actions` - udfører kalender-actions efter veto-vindue (dagligt + hvert 10. min via pg_cron).
- `/api/cron/patterns` - ugentligt mønster-flag (søndag), kun ved konkret signal.
- `/api/cron/finance-classify` - drainer finans-kategoriseringskøen + dagligt nettoformue-snapshot (dagligt + hvert kvarter via pg_cron, migration `0014`).
- `/api/cron/review` - ugentlig review søndag aften til Telegram + `/review`.
- `/api/cron/productivity` - dagligt produktivitets-snapshot (produktivitet + dækning over 30 dage) til operatør-kortet.
- `/api/cron/health` - vagthunden (dagligt 05:30 UTC via pg_cron, migration `0019`): flager forældet bankdata (>30 dage), ophobet kategoriseringskø og døde cron-jobs på Telegram. Grøn dag = stilhed.

Alle kræver `Authorization: Bearer <CRON_SECRET>`.

`vercel.json` har daglige UTC-schedules som fallback (Vercel Hobby tillader kun daglig cron). Den sub-daglige cron kører via Supabase pg_cron + pg_net (migration `0007_pg_cron_actions.sql`): jobbet `gustav-os-actions` kalder `/api/cron/actions` hvert 10. minut, 24/7, direkte fra databasen. CRON_SECRET ligger krypteret i Supabase Vault. Status og afinstallation: se `STATUS.md` og migrationens BLOK 3/4.

## Handover-regel

Når en agent stopper, skal `STATUS.md` opdateres med:

- Hvad der blev ændret.
- Hvilke checks der blev kørt.
- Hvad næste agent skal gøre først.
- Eventuelle faldgruber eller halvfærdige ting.
