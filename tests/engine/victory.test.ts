import { describe, expect, it } from 'vitest';
import { step } from '../../src/engine/game.ts';
import { computeRanking } from '../../src/engine/systems/victory.ts';
import type { GameState } from '../../src/engine/types.ts';
import { act, place, testGame } from '../helpers.ts';

function eliminate(s: GameState, id: number, tick: number): void {
  Object.assign(s.players[id], { alive: false, eliminated: true, eliminatedTick: tick, lives: 0, hp: 0 });
}

describe('match end', () => {
  it('ends when one player is left, and ranks them first', () => {
    const s = testGame({ players: 3 });
    place(s, 0, 500, 500, 0);
    place(s, 1, 560, 500);
    place(s, 2, 900, 900);
    eliminate(s, 2, 0);
    step(s, []); // player 1 is eliminated on a later tick than player 2
    Object.assign(s.players[1], { lives: 1, hp: 10 });
    const events = step(s, [act({ attack: true })]);
    expect(s.over).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'matchEnd', reason: 'lastStanding' });
    expect(s.result!.ranking).toEqual([
      { playerId: 0, rank: 1 },
      { playerId: 1, rank: 2 }, // eliminated later than player 2
      { playerId: 2, rank: 3 },
    ]);
    expect(step(s, [])).toEqual([]); // no more ticks after the end
  });

  it('simultaneous last eliminations end in a shared rank', () => {
    const s = testGame({ players: 2 });
    place(s, 0, 500, 500, 0);
    place(s, 1, 560, 500, Math.PI);
    for (const p of s.players) Object.assign(p, { lives: 1, hp: 10 });
    step(s, [act({ attack: true }), act({ attack: true })]);
    expect(s.result).toMatchObject({ reason: 'allEliminated' });
    expect(s.result!.ranking).toEqual([{ playerId: 0, rank: 1 }, { playerId: 1, rank: 1 }]);
  });

  it('at the time limit ranks by lives, then hp + shield; exact ties share a rank', () => {
    const s = testGame({ players: 5, timeLimit: 1 });
    Object.assign(s.players[0], { lives: 2, hp: 100, shield: 0 });
    Object.assign(s.players[1], { lives: 3, hp: 20, shield: 0 });
    Object.assign(s.players[2], { lives: 2, hp: 60, shield: 50 });
    Object.assign(s.players[3], { lives: 2, hp: 100, shield: 0 });
    eliminate(s, 4, 3);
    for (let i = 0; i < 30; i++) step(s, []);
    expect(s.result!.reason).toBe('timeLimit');
    expect(s.result!.endTick).toBe(30);
    expect(s.result!.ranking).toEqual([
      { playerId: 1, rank: 1 },
      { playerId: 2, rank: 2 },
      { playerId: 0, rank: 3 },
      { playerId: 3, rank: 3 },
      { playerId: 4, rank: 5 },
    ]);
  });

  it('a player waiting to respawn still counts as in the match', () => {
    const s = testGame({ players: 2 });
    place(s, 0, 500, 500, 0);
    place(s, 1, 560, 500);
    Object.assign(s.players[1], { lives: 2, hp: 10 });
    step(s, [act({ attack: true })]);
    expect(s.players[1].alive).toBe(false);
    expect(s.over).toBe(false);
    expect(computeRanking(s)[0].playerId).toBe(0);
  });

  it('solo debug matches only end at the time limit or elimination', () => {
    const s = testGame({ players: 1 });
    for (let i = 0; i < 100; i++) step(s, []);
    expect(s.over).toBe(false);
  });
});
