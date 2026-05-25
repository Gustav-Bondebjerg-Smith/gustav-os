# Gustav OS - STATUS

Sidst opdateret: 2026-05-25

## Hvor er vi
Fase 2 FÆRDIG. Send tekst ELLER voicenote til @PersonalOSGustav_bot -> (voice transskriberes med Whisper) -> gemmes i `raw_captures` -> Claude Haiku sætter område + type -> botten svarer "Fanget og gemt. (område, type)". Kører lokalt via long-polling. Næste milepæl: Fase 3 (kalender + balance), den første rigtige synlige livsforbedring.

## Færdigt
- Milestone 0: Next.js 15 + TS + Tailwind, git, secrets gitignored, CLAUDE.md, memory.
- Fase 1: Supabase forbundet, schema kørt (6 tabeller + pgvector + RLS), round-trip verificeret.
- Nøgler: Anthropic + OpenAI + Telegram valideret. Bot = @PersonalOSGustav_bot, LÅST til Gustav (TELEGRAM_CHAT_ID sat).
- Fase 2 (tekst + voice): long-polling capture. Voice -> Whisper (whisper-1, dansk). Klassificering med Claude Haiku. Område: personlig/studie/arbejde. Type: opgave/note/ide/aftale. Capture er helligt: råindhold gemmes FØR klassificering, så data aldrig tabes hvis Claude/Whisper fejler.
- scripts/: load-env.mjs, test-db.mjs, test-keys.mjs, list-models.mjs, telegram-poll.mjs, classify.mjs, transcribe.mjs, reclassify.mjs, show-captures.mjs. Kør som `node scripts/<navn>.mjs`.

## Sådan bruger du det nu
- Lyt efter beskeder: `node scripts/telegram-poll.mjs` (Ctrl+C stopper). Én runde: tilføj `--once`.
- Se hvad hjernen har fanget: `node scripts/show-captures.mjs`.
- Efterklassificer ubehandlede captures: `node scripts/reclassify.mjs`.
- Bemærk: polleren kører kun mens terminalen kører. Altid-online kommer ved deploy til Vercel (webhook).

## Næste: Fase 3 (kalender + balance)
Mål: "hvordan ser min balance ud de sidste 14 dage?" -> konkret svar bygget på din faktiske Google Calendar + din profil. Første rigtige synlige forbedring.
Logistik Gustav skal gøre (jeg guider trin for trin): oprette en Google Cloud service account + dele din kalender med den. Det er den eneste nye konto-opsætning.
Trin: (1) Google service account + credentials i .env.local. (2) læs kalender-events for sidste 14 dage. (3) Claude-analyse -> balance-rapport (studie/arbejde/hvile/telefon-mønstre). (4) hent rapporten via Telegram eller terminal.

## Faser
0 Life Audit [done] | 0.5 Fundament [done] | 1 Supabase+schema [done] | 2 Capture pipeline [done: tekst+voice+klassificering] | 3 Calendar+balance [næste] | 4 Auto-handlinger | 5 Memory/ask | 6 Dashboard | 7 Cron

## Noter / faldgruber
- VIGTIGT: Claude Code-shellen har en TOM `ANTHROPIC_API_KEY` sat. Node's `--env-file` overskriver den ikke. Derfor: kør scripts som `node scripts/x.mjs` (bruger `load-env.mjs` der tvinger .env.local igennem). Kør dev-server som `env -u ANTHROPIC_API_KEY npm run dev` når Anthropic skal virke lokalt.
- npm cache: brug `npm_config_cache=/tmp/gustav-npm-cache` foran npm-installs (root-ejet ~/.npm). Permanent: `sudo chown -R 501:20 ~/.npm`.
- Deploy senere: skift fra long-polling til webhook på Vercel for altid-online capture (TELEGRAM_WEBHOOK_SECRET ligger klar i .env.local).
- Whisper: ~95% nøjagtig på dansk, enkelte ord kan blive forkerte. Råtekst gemmes altid, så intet går tabt.
- git: intet committet endnu (Claude committer kun når Gustav beder om det).
