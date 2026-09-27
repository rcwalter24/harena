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

## Layout

- `src/engine/` – simulation (config, geometry, systems, deterministic math/RNG)
- `src/match/` – controllers and the match runner
- `src/render/` – canvas renderer
- `src/ui/` – pages, HUD and keyboard/mouse input
- `maps/` – map data (JSON)
- `tests/` – Vitest unit tests

All rule numbers live in `src/engine/config.ts`.
