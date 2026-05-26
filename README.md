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

`vercel.json` er sat konservativt med daglige UTC-schedules, så Vercel Hobby ikke fejler deploy. Hvis actions skal udføres få minutter efter veto-deadline, skal `/api/cron/actions` rammes hvert 5. minut via Vercel Pro eller en ekstern scheduler.

## Handover-regel

Når en agent stopper, skal `STATUS.md` opdateres med:

- Hvad der blev ændret.
- Hvilke checks der blev kørt.
- Hvad næste agent skal gøre først.
- Eventuelle faldgruber eller halvfærdige ting.
