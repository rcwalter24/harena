import type { GameState, MatchEndReason, PlayerState, RankEntry } from '../types.ts';

/**
 * Final ranking (standard competition ranking: 1, 1, 3, ...).
 *
 * Players still in the match rank above eliminated ones, ordered by lives left,
 * then hp + shield. Eliminated players are ordered by how late they were
 * eliminated. Players equal on every criterion share a rank.
 */
export function computeRanking(state: GameState): RankEntry[] {
  const key = (p: PlayerState): number[] =>
    p.eliminated ? [0, p.eliminatedTick, 0] : [1, p.lives, p.hp + p.shield];
  const compare = (a: PlayerState, b: PlayerState): number => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
    return 0;
  };
  const sorted = [...state.players].sort((a, b) => compare(a, b) || a.id - b.id);
  const ranking: RankEntry[] = [];
  sorted.forEach((p, i) => {
    const prev = sorted[i - 1];
    const rank = prev && compare(prev, p) === 0 ? ranking[i - 1].rank : i + 1;
    ranking.push({ playerId: p.id, rank });
  });
  return ranking;
}

/**
 * End the match if at most one player remains (in matches of 2+ players) or the
 * time limit is reached. Called at the very end of a tick.
 */
export function checkMatchEnd(state: GameState): void {
  if (state.over) return;
  let reason: MatchEndReason | null = null;
  const remaining = state.players.filter((p) => !p.eliminated).length;
  if (state.players.length >= 2 && remaining <= 1) reason = remaining === 1 ? 'lastStanding' : 'allEliminated';
  else if (state.players.length === 1 && remaining === 0) reason = 'allEliminated';
  else if (state.timeLimitTicks > 0 && state.tick >= state.timeLimitTicks) reason = 'timeLimit';
  if (!reason) return;
  state.over = true;
  state.result = { reason, endTick: state.tick, ranking: computeRanking(state) };
  state.events.push({ type: 'matchEnd', tick: state.tick, reason });
}
