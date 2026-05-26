# Gustav OS - STATUS

Sidst opdateret: 2026-05-26

## Hvor er vi
Fase 3 FÆRDIG. Den første rigtige synlige forbedring er leveret: en balance-rapport over de sidste 14 dage, ankret i din faktiske Google Calendar, skrevet i Gustav OS-stemmen. Koden regner præcise timer pr. kategori, Claude Sonnet 4.6 kategoriserer hvert event og skriver vurderingen + 1-2 konkrete justeringer. Levering: terminal eller direkte på Telegram. Næste milepæl: Fase 4 (auto-handlinger med Telegram-veto).

## Færdigt
- Milestone 0: Next.js 15 + TS + Tailwind, git, secrets gitignored, CLAUDE.md, memory.
- Fase 1: Supabase forbundet, schema kørt (6 tabeller + pgvector + RLS), round-trip verificeret.
- Nøgler: Anthropic + OpenAI + Telegram + Google service account valideret. Telegram-bot LÅST til Gustav (`TELEGRAM_CHAT_ID` sat).
- Fase 2 (tekst + voice): long-polling capture. Voice -> Whisper (whisper-1, dansk). Klassificering med Claude Haiku. Område: personlig/studie/arbejde. Type: opgave/note/ide/aftale. Capture er helligt: råindhold gemmes FØR klassificering.
- Fase 3 (kalender + balance): Google service account (kun læseadgang), primær kalender delt med robotten. `scripts/calendar.mjs` henter events via JWT-auth (`google-auth-library`). `scripts/balance.mjs` regner præcise timer pr. kategori i kode, Claude Sonnet 4.6 kategoriserer + skriver rapporten i personaen. Levering: terminal eller `--telegram`.
- scripts/: load-env, test-db, test-keys, list-models, telegram-poll, classify, transcribe, reclassify, show-captures, calendar, balance. Kør som `node scripts/<navn>.mjs`.
- Portable kontekst (arbejdsform, persona, profil, faldgruber): ligger i `AGENTS.md`. Læses af Claude Code (via `@AGENTS.md`-import i `CLAUDE.md`) OG andre værktøjer (Codex, Cursor osv.). Skifter du værktøj: bed det nye læse `STATUS.md` + `AGENTS.md` først.

## Sådan bruger du det nu
- Capture (tekst + voice): `node scripts/telegram-poll.mjs` (Ctrl+C stopper, `--once` for én runde).
- Se dine captures: `node scripts/show-captures.mjs`.
- Balance-rapport: `node scripts/balance.mjs` (eller `node scripts/balance.mjs --telegram` for at få den på telefonen).
- Efterklassificer ubehandlede captures: `node scripts/reclassify.mjs`.
- Polleren kører kun mens terminalen kører. Altid-online kommer ved deploy til Vercel (webhook).

## Næste: Fase 4 (auto-handlinger + Telegram-veto)
Mål: systemet udfører begrænsede handlinger på dine vegne (skrive aftaler i kalender, oprette opgaver, sende påmindelser) med et veto-vindue via Telegram. Hver handling logges i `audit_log`. Service account-permission opgraderes fra "See all event details" til "Make changes to events" når vi når dertil.

## Faser
0 Life Audit [done] | 0.5 Fundament [done] | 1 Supabase+schema [done] | 2 Capture pipeline [done] | 3 Calendar+balance [done] | 4 Auto-handlinger [næste] | 5 Memory/ask | 6 Dashboard | 7 Cron

## Noter / faldgruber
- VIGTIGT: Claude Code-shellen har en TOM `ANTHROPIC_API_KEY` der skygger for `.env.local`. Kør scripts som `node scripts/x.mjs` (bruger `load-env.mjs`). Kør dev-server som `env -u ANTHROPIC_API_KEY npm run dev` når Anthropic skal virke lokalt.
- npm cache: brug `npm_config_cache=/tmp/gustav-npm-cache` foran npm-installs (root-ejet `~/.npm`). Permanent: `sudo chown -R 501:20 ~/.npm`.
- Deploy senere: skift fra long-polling til webhook på Vercel for altid-online capture (`TELEGRAM_WEBHOOK_SECRET` ligger klar i `.env.local`).
- Whisper: ~95% nøjagtig på dansk. Råtekst gemmes altid, så intet går tabt.
- Google service account: nøgle ligger på én linje i `.env.local` med tekst-`\n`. Fold ud med `.replace(/\\n/g, '\n')` før brug (sker i `calendar.mjs`). Den løse JSON-nøglefil er slettet; værdierne lever kun i `.env.local`.
- git: Fase 1+2 committet (db1e152). Fase 3 committes lige efter denne STATUS-opdatering. Claude committer kun når Gustav beder om det.
