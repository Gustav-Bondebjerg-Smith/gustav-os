# Gustav OS

Personligt AI operating system for Gustav. Appen er en Next.js 16 dashboard-flade oven på Supabase, Telegram capture, Google Calendar actions og en embeddet "second brain".

## Læs først

- `STATUS.md` er den aktuelle overdragelse. Start altid der.
- `AGENTS.md` er fælles kontekst for Claude, Codex, Cursor osv.
- `CLAUDE.md` importerer `AGENTS.md` og har Claude-specifik historik.
- Secrets ligger i `.env.local`. Den fil må ikke committes.

## Aktuel status

- Fase 7 led 2 er kodet: Telegram webhook på `/api/telegram`.
- Fase 7 led 3 er kodet: cron endpoints på `/api/cron/*`.
- Webhook og cron bliver først live efter migrations `0004_telegram_webhook.sql` + `0005_cron.sql`, Vercel deploy og `setWebhook`.
- Long-polling scriptet beholdes til lokal udvikling: `node scripts/telegram-poll.mjs`.
- Watcher kan stadig køres lokalt: `node scripts/watch-actions.mjs`.

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
node scripts/telegram-webhook.mjs get
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/actions
```

Til npm-installs på Gustavs maskine:

```bash
npm_config_cache=/tmp/gustav-npm-cache npm install
```

## Arkitekturkort

- `app/` - Next.js App Router dashboard: login, captures, actions, ask.
- `proxy.ts` - Next.js 16 proxy, refresh af Supabase cookies og auth-gating.
- `lib/supabase.ts` - service role client. Server-only. Kun interne flows.
- `lib/supabase-server.ts` - anon client med cookies. Bruges til bruger-sessioner.
- `lib/format.ts` og `lib/ask-types.ts` - client-sikre helpers/typer.
- `lib/memory.ts` - server-side embeddings + idempotent `memory_chunks` storage.
- `lib/ask.ts` - TypeScript-port af ask-flowet til dashboard server action.
- `lib/telegram-webhook.ts` - server-side webhook-flow for Telegram capture, veto og `/ask`.
- `lib/cron.ts` - `CRON_SECRET`-auth + DB-lock til serverless cron.
- `lib/calendar.ts` - server-side Google Calendar read/write helper.
- `lib/actions-runner.ts` - udfører due actions efter veto-vindue.
- `lib/proactive.ts` - morgenbrief, aften-refleksion og mønster-flag.
- `scripts/` - CLI og lokale workers til Telegram, embeddings, kalender og balance.
- `supabase/migrations/` - SQL schema, actions og memory search RPC.

## Supabase memory MCP

Migration `supabase/migrations/0008_memory_sources.sql` udvider memory til canonical Supabase-sources, audit-log og `search_memory_v2`, uden at ændre den gamle `search_memory`.

- Import dry-run: `npm run memory:import:dry`
- Import hele workspacet + `gustav-os`: `npm run memory:import`
- Eksportér lokal backup: `npm run memory:export`
- Start MCP server manuelt: `MEMORY_MCP_ACCESS=full npm run memory:mcp`

Repo-runtime ligger i `/Users/gustavbondebjergsmith/Developer/gustav-os`, så MCP-serveren starter uden for den iCloud-synkede `Documents`-mappe. `npm run memory:import` scanner både `/Users/gustavbondebjergsmith/Developer/AI assistent` og repo-runtime, hvor repo-filer gemmes med `gustav-os/...` source-keys. Codex projektkonfig ligger i `.codex/config.toml`; Claude Code projektkonfig ligger i `.mcp.json`. Global Codex og global Claude Code har full-access memory via user config. Backup skrives til `/Users/gustavbondebjergsmith/Developer/AI assistent/supabase-memory-backup/` og er ikke canonical source.

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

- `/api/cron/actions` - udfører kalender-actions efter veto-vindue.
- `/api/cron/morning` - sender morgenbrief på Telegram.
- `/api/cron/evening` - sender aften-refleksion på Telegram.
- `/api/cron/patterns` - sender kun mønster-flag hvis der er et konkret signal.

Alle kræver `Authorization: Bearer <CRON_SECRET>`.

`vercel.json` har daglige UTC-schedules som fallback (Vercel Hobby tillader kun daglig cron). Den sub-daglige cron kører via Supabase pg_cron + pg_net (migration `0007_pg_cron_actions.sql`): jobbet `gustav-os-actions` kalder `/api/cron/actions` hvert 10. minut, 24/7, direkte fra databasen. CRON_SECRET ligger krypteret i Supabase Vault. Status og afinstallation: se `STATUS.md` og migrationens BLOK 3/4.

## Handover-regel

Når en agent stopper, skal `STATUS.md` opdateres med:

- Hvad der blev ændret.
- Hvilke checks der blev kørt.
- Hvad næste agent skal gøre først.
- Eventuelle faldgruber eller halvfærdige ting.
