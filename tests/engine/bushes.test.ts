import { describe, expect, it } from 'vitest';
import { createGame, step } from '../../src/engine/game.ts';
import { buildBotState, viewForPlayer } from '../../src/engine/snapshot.ts';
import { isVisibleTo } from '../../src/engine/systems/visibility.ts';
import type { GameState } from '../../src/engine/types.ts';
import { act, place, testMap } from '../helpers.ts';
import { DEFAULT_CONFIG, mergeConfig } from '../../src/engine/config.ts';

const BUSH = { x: 400, y: 400, w: 200, h: 200 };

function bushGame(players = 3): GameState {
  const map = { ...testMap(), bushes: [BUSH, { x: 800, y: 100, w: 100, h: 100 }] };
  return createGame({
    map, seed: 'b', timeLimit: 0, config: mergeConfig(DEFAULT_CONFIG, { items: { maxOnMap: 0 } }),
    players: Array.from({ length: players }, (_, i) => ({ name: `P${i}` })),
  });
}

const see = (s: GameState, viewer: number, target: number) => isVisibleTo(s, s.players[viewer], s.players[target]);

describe('bushes', () => {
  it('hide a player from distant enemies but not from close ones or those in the same bush', () => {
    const s = bushGame();
    place(s, 0, 500, 500); // in the bush
    place(s, 1, 100, 100); // far away
    place(s, 2, 500 + 85, 500); // within 90 u
    expect(see(s, 1, 0)).toBe(false);
    expect(see(s, 2, 0)).toBe(true);
    place(s, 2, 420, 420); // same bush, > 90 u away
    expect(see(s, 2, 0)).toBe(true);
    expect(see(s, 0, 0)).toBe(true); // always see yourself
  });

  it('a different bush does not help', () => {
    const s = bushGame();
    place(s, 0, 500, 500);
    place(s, 1, 850, 150); // in the other bush
    expect(see(s, 1, 0)).toBe(false);
  });

  it('attacking reveals for noiseRevealTime', () => {
    const s = bushGame(2);
    place(s, 0, 500, 500);
    place(s, 1, 100, 100);
    step(s, [act({ attack: true })]);
    expect(see(s, 1, 0)).toBe(true);
    for (let i = 0; i < 30; i++) step(s, []);
    expect(see(s, 1, 0)).toBe(false);
  });

  it('taking damage reveals', () => {
    const s = bushGame(3);
    place(s, 0, 500, 500, 0);
    place(s, 1, 100, 100);
    place(s, 2, 560, 500, Math.PI); // close attacker
    step(s, [act(), act(), act({ attack: true })]);
    place(s, 2, 900, 900);
    expect(see(s, 1, 0)).toBe(true);
    expect(s.players[0].hp).toBeLessThan(100);
  });

  it('hidden enemies show their last seen position, frozen, with seenAgo', () => {
    const s = bushGame(2);
    place(s, 0, 300, 500);
    place(s, 1, 100, 900);
    step(s, []); // seen outside the bush at (300, 500)
    for (let i = 0; i < 30; i++) step(s, [act({ moveX: 1 })]); // walks into the bush
    expect(s.players[0].x).toBeGreaterThan(400);
    const view = viewForPlayer(s, buildBotState(s), 1);
    const hidden = view.players[0];
    expect(hidden.visible).toBe(false);
    expect(hidden.x).toBeLessThan(420); // last seen near the bush edge, not the real position
    expect(hidden.seenAgo).toBeGreaterThan(0);
    expect(hidden.hp).toBe(100); // scoreboard data stays visible
    const own = viewForPlayer(s, buildBotState(s), 0);
    expect(own.players[0]).toMatchObject({ visible: true, seenAgo: 0, x: s.players[0].x });
  });

  it('dead viewers see nothing inside bushes; dead targets are not hidden', () => {
    const s = bushGame(2);
    place(s, 0, 500, 500);
    place(s, 1, 560, 500);
    s.players[1].alive = false;
    expect(see(s, 1, 0)).toBe(false);
    expect(see(s, 0, 1)).toBe(true);
  });
});

describe('bush hiding limit', () => {
  // Default: hideLimit 5 s (150 ticks), rehideTime 2 s (60 ticks).
  const idle = (s: GameState, ticks: number) => {
    for (let i = 0; i < ticks; i++) step(s, []);
  };

  it('exposes a player after 5 s in a bush without a break', () => {
    const s = bushGame(2);
    place(s, 0, 500, 500);
    place(s, 1, 100, 900);
    idle(s, 149);
    expect(see(s, 1, 0)).toBe(false);
    expect(buildBotState(s).players[0].hideLeft).toBeCloseTo(1 / 30);
    idle(s, 1);
    expect(see(s, 1, 0)).toBe(true);
    expect(buildBotState(s).players[0].hideLeft).toBe(0);
    idle(s, 100); // stays exposed while it stays in the bush
    expect(see(s, 1, 0)).toBe(true);
  });

  it('does not refill after a short step outside, only after rehideTime out of all bushes', () => {
    const s = bushGame(2);
    place(s, 1, 100, 900);
    place(s, 0, 500, 500);
    idle(s, 150);
    place(s, 0, 300, 300); // out for 1 s
    idle(s, 30);
    place(s, 0, 500, 500);
    idle(s, 1);
    expect(see(s, 1, 0)).toBe(true);
    place(s, 0, 300, 300); // out for 2 s
    idle(s, 60);
    place(s, 0, 500, 500);
    idle(s, 1);
    expect(see(s, 1, 0)).toBe(false);
  });

  it('counts time across different bushes', () => {
    const s = bushGame(2);
    place(s, 1, 100, 900);
    place(s, 0, 500, 500);
    idle(s, 100);
    place(s, 0, 850, 150); // the other bush
    idle(s, 50);
    expect(see(s, 1, 0)).toBe(true);
  });

  it('respawning refills it', () => {
    const s = bushGame(2);
    place(s, 1, 100, 900);
    place(s, 0, 500, 500);
    idle(s, 150);
    s.players[0].hp = 0;
    s.players[0].invulnerableTimer = 0;
    idle(s, 61);
    expect(s.players[0].alive).toBe(true);
    expect(buildBotState(s).players[0].hideLeft).toBe(5);
  });

  it('is off with hideLimit 0', () => {
    const map = { ...testMap(), bushes: [BUSH] };
    const s = createGame({
      map, seed: 'b', timeLimit: 0, players: [{ name: 'A' }, { name: 'B' }],
      config: mergeConfig(DEFAULT_CONFIG, { items: { maxOnMap: 0 }, bushes: { hideLimit: 0 } }),
    });
    place(s, 0, 500, 500);
    place(s, 1, 100, 900);
    idle(s, 600);
    expect(see(s, 1, 0)).toBe(false);
    expect(buildBotState(s).players[0].hideLeft).toBeNull();
  });
});
