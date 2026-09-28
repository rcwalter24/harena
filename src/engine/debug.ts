import type { GameState } from './types.ts';

/** Debug-mode cheats. They go through here (and are recorded) so replays stay exact. */
export type CheatKind = 'arm' | 'heal';

export function applyCheat(state: GameState, playerId: number, kind: CheatKind): boolean {
  const p = state.players[playerId];
  if (!p || !p.alive) return false;
  const { player, gun, launcher, mines } = state.config;
  if (kind === 'arm') {
    p.hasGun = true;
    p.ammo = gun.maxAmmo;
    p.hasLauncher = true;
    p.grenades = launcher.maxAmmo;
    p.mines = mines.maxCarry;
  } else {
    p.hp = player.maxHp;
    p.shield = player.maxShield;
  }
  return true;
}
