# Harena

A top-down 2D arena where bots written by different AIs fight each other.
The engine is pure TypeScript (no DOM) with a fixed 30 tick/s deterministic
simulation; the browser renders it on a canvas with interpolation.

## Commands

| Command | What it does |
|---|---|
| `npm install` | Install dev dependencies (Vite, Vitest, TypeScript) |
| `npm run dev` | Start the dev server (open the printed URL) |
| `npm test` | Run the engine unit tests |
| `npm run typecheck` | Type-check the app, and the engine without DOM typings |
| `npm run build` | Type-check and build a static bundle into `dist/` |
| `npm run docs` | Regenerate `BOT_API.md` from the template, config, types and example bot |
| `npm run docs:check` | Fail if `BOT_API.md` is out of date (also covered by `npm test`) |
| `npm run batch -- --bots a,b,…` | Headless batch matches in Node with win rates and stats (`-- --help` for options) |
| `npm run review` | Static check + Jev AI review of new/changed bots (`-- --all`, `-- file.js`, `-- --static-only`) |

## Adding a bot

1. Give an AI `BOT_API.md` and ask it for a bot.
2. Save the file as `bots/<name>.js`; it appears on the setup page automatically.
3. Review it with the **Review** button or `npm run review`. Static-check failures block the bot;
   Jev (TypeSafe AI) findings are warnings, and the choice is yours. Reviews are saved as
   `bots/<name>.review.json` and flagged as stale when the bot changes.
4. Optionally click its name on the setup page to rename it (e.g. after the AI that wrote it).
   The name is stored in this browser only; the bot file and its review are left untouched.
   Batch matches use file names.

The Jev API key is read at runtime from `TYPESAFE_API_KEY` or `~/.secrets/typesafe`
(override the path with `TYPESAFE_KEY_FILE`); it never reaches the browser.

## Batch matches

```bash
npm run batch -- --bots gunner,chaser,random --games 100 --map all --seed s1
npm run batch -- --bots gunner,gunner,chaser,chaser --games 50 --replays out/replays --json
```

Each game gets its own seed (`<seed>-<index>`) and shuffled seats; bots run in
`worker_threads` with the same sandbox rules as in the browser. Without timeouts the
same arguments reproduce the same results. Bots that fail the static check are refused.

## Replays

Every match is recorded: the seed, the map and rule config, and every action the engine
applied. After a match, the results screen offers **Watch replay** and **Download replay**
(a `.json` file); **Load replay…** on the setup page opens one again. Replays re-simulate the
match exactly (bots are not needed) and verify themselves against recorded checksums; the
viewer warns if the engine or rules changed since recording.

**Export video** (replay viewer and results screen) renders a replay to a 1920×1080 MP4
(H.264) in the browser, faster than real time: a title card, the match with player cards and
kill feed, and the final results. Quiet stretches can play at 4×. It needs WebCodecs (recent
Chrome, Edge or Safari); where H.264 encoding is missing it falls back to WebM (VP9). Batch
replays (`--replays`) can be opened and exported the same way.

## Layout

- `src/engine/` – simulation (config, geometry, systems, deterministic math/RNG)
- `src/video/` – replay → video export (frame layout, fast-forward timeline, encoding via `mediabunny`)
- `src/match/` – controllers, the match runner and the bot supervisor (budgets, failures, restarts)
- `src/sandbox/` – bot worker harness for the browser (Web Worker) and Node (worker_threads)
- `src/review/` – static check and Jev review
- `bots/` – bot files (+ their saved reviews)
- `src/render/` – canvas renderer
- `src/ui/` – pages, HUD and keyboard/mouse input
- `maps/` – map data (JSON)
- `cli/` – Node command-line tools (batch matches)
- `src/batch/` – headless batch runner
- `tests/` – Vitest tests

All rule numbers live in `src/engine/config.ts`.
