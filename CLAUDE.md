# Harena – notes for AI assistants

Top-down 2D arena where AI-written bots fight. TypeScript + Vite, Canvas 2D, no engine/framework.
See README.md for commands and layout. The original phased plan (all 6 phases done) is in the
git history; this file lists the rules that must keep holding.

## Invariants (don't break these)

- **Engine is pure and deterministic** (`src/engine/`): no DOM, no Node APIs (checked by
  `tsconfig.engine.json`). Use only `+ - * / %`, `Math.sqrt/floor/round/min/max/abs` and the
  polynomial `sincos` in `dmath.ts` — never `Math.sin/cos/atan2/hypot` in engine code (they can
  differ between JS engines and break replays). All randomness via seeded `Rng` streams
  (`state.rng.spawns`, `state.rng.items`); bots get a seeded `Math.random` per seat.
- **Every rule number lives in `src/engine/config.ts`**, and every leaf needs a `CONFIG_DOCS`
  entry (a test enforces this).
- **`BOT_API.md` is generated** from `docs/BOT_API.template.md` + config + `src/engine/botApi.ts`
  + `bots/gunner.js`. Never edit it by hand; run `npm run docs`. A test fails when it is stale.
  Any rule/number/type change must also update the template prose.
- **Bot API is effectively frozen**: bots written by other AIs depend on `botApi.ts`. Only add
  optional fields; never rename/remove. Bot-visible timers are seconds; engine timers are ticks.
- **Replays record normalized actions**: `MatchRunner` passes every action through
  `normalizeAction` before `step()`. Anything that mutates state outside `step()` (e.g. debug
  cheats) must go through `engine/debug.ts` and be recorded (`ReplayRecorder.recordCheat`).
  `hashState` must cover all simulation state (add new fields to it). Visibility-only fields
  (`noiseTimer`, `bushTicks`, `outOfBushTicks`) are deliberately not hashed, so replays recorded
  before they existed still verify; new rules must load old replay configs with the rule off
  (see `validateReplay`).
- **Safe zone** (`systems/zone.ts`) is derived from the tick and config only, so it adds no
  state to hash. `zone.damagePerSecond: 0` turns it off (old replays without zone config are
  loaded that way); with it off, behaviour is identical to before the zone existed.
- **Tick order** is documented in `game.ts` `step()` and in BOT_API.md §4 — keep them in sync.
- **Visibility**: bots and a human player only see what `isVisibleTo` allows (bushes). The
  renderer takes `viewerId` for the human; spectators see everything. Scripted dummies also
  respect visibility. Don't leak hidden positions through events. Smoke clouds count as bushes
  (`bushAt`), so every bush rule applies to them.
- **Sandbox**: bots run in Web Workers (browser) / worker_threads (Node) via the shared
  `src/sandbox/harness.ts`; `BotController` (`src/match/supervisor.ts`) enforces budgets,
  failure streaks and hang → restart once → disable. This is isolation, not a hard security
  boundary.
- **Bot review**: `staticCheck` errors block a bot (UI, batch CLI); Jev (TypeSafe) findings are
  advisory only. The TypeSafe key is read at runtime from `TYPESAFE_API_KEY` or
  `~/.secrets/typesafe` in Node only — never log, copy or send it to the browser. Jev model is
  pinned to `jev-1.13.0`.

- **Bots pasted in the browser** (setup page → Add bot) live in localStorage
  (`harena.localBots.v1`) with ids `my/<slug>.js`; they get the static check only. A static
  build (`npm run build`, e.g. a hosted copy) has no dev-server API: it shows the reviews
  bundled from `bots/*.review.json` and no Review button.

- **Test kit** (`src/sim/cli.ts` → `dist/harena-sim.mjs` via `vite.sim.config.ts`): one Node file
  with the engine, maps, built-in bots and the real worker sandbox (it starts itself as the bot
  worker). It must play exactly the games `npm run batch` plays (`tests/sim.test.ts`), so it
  reuses the file-system-free game loop in `src/batch/games.ts`.

## Conventions

- Node 26 runs `.ts` directly (type stripping): use `.ts` import extensions and erasable syntax
  only (no enums/namespaces/parameter properties).
- Code, comments, docs and commit messages in English. UI text is written in English and wrapped
  in `t()` (`src/ui/i18n.ts`); add the Chinese to `ZH` there (a test checks every `t()` literal).
  Bot-facing text (static-check findings, bot log, the AI prompt) stays English.
- Commit messages: no `Co-Authored-By` or any AI attribution.
- Maps are JSON in `maps/` (one entity per line); tests check validity and reachability.
- Run `npm run typecheck && npm test` before committing; UI changes are verified in a real
  browser (headless Chrome screenshots), not just by tests.
