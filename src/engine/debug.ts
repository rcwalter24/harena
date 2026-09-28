import type { GameState } from './types.ts';

/** Debug-mode cheats. They go through here (and are recorded) so replays stay exact. */
export type CheatKind = 'arm' | 'heal';

export function applyCheat(state: GameState, playerId: number, kind: CheatKind): boolean {
  const p = state.players[playerId];
  if (!p || !p.alive) return false;
  const { player, gun, launcher, laser, mines } = state.config;
  if (kind === 'arm') {
    p.hasGun = true;
    p.ammo = gun.maxAmmo;
    p.hasLauncher = true;
    p.grenades = launcher.maxAmmo;
    // Replays from before the laser load with laser.maxAmmo 0: no laser, same state as then.
    if (laser.maxAmmo > 0) {
      p.hasLaser = true;
      p.laserShots = laser.maxAmmo;
    }
    p.mines = mines.maxCarry;
    // Zero for replays from before smoke and gas existed.
    p.smokes = state.config.smoke.maxCarry;
    p.gases = state.config.gas.maxCarry;
  } else {
    p.hp = player.maxHp;
    p.shield = player.maxShield;
  }
  return true;
}
