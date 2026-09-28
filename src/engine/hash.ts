import type { GameState } from './types.ts';

/**
 * Checksum of the simulation-relevant state. Replays store it periodically to
 * detect desyncs; tests use it to assert determinism.
 */
export function hashState(state: GameState): string {
  let h1 = 0x9e3779b9;
  let h2 = 0x85ebca6b;
  const buf = new Float64Array(1);
  const words = new Uint32Array(buf.buffer);
  const mix = (v: number) => {
    buf[0] = v;
    for (let i = 0; i < 2; i++) {
      h1 = Math.imul(h1 ^ words[i], 0x01000193);
      h2 = Math.imul(h2 ^ words[i], 0x5bd1e995) ^ (h2 >>> 15);
    }
  };

  mix(state.tick);
  mix(state.nextEntityId);
  mix(state.itemSpawnTimer);
  for (const p of state.players) {
    mix(p.x); mix(p.y); mix(p.vx); mix(p.vy); mix(p.facing);
    mix(p.hp); mix(p.shield); mix(p.lives);
    mix(p.alive ? 1 : 0); mix(p.eliminated ? 1 : 0);
    mix(p.weapon === 'gun' ? 1 : p.weapon === 'launcher' ? 2 : 0); mix(p.hasGun ? 1 : 0); mix(p.ammo);
    mix(p.hasLauncher ? 1 : 0); mix(p.grenades); mix(p.mines);
    mix(p.knifeCooldown); mix(p.gunCooldown); mix(p.launcherCooldown); mix(p.mineCooldown); mix(p.switchTimer);
    mix(p.invulnerableTimer); mix(p.respawnTimer);
  }
  for (const b of state.bullets) {
    mix(b.id); mix(b.x); mix(b.y); mix(b.vx); mix(b.vy);
  }
  for (const g of state.grenades) {
    mix(g.id); mix(g.x); mix(g.y); mix(g.traveled);
  }
  for (const m of state.mines) {
    mix(m.id); mix(m.x); mix(m.y); mix(m.fuseTimer);
  }
  for (const it of state.items) {
    mix(it.id); mix(it.x); mix(it.y); mix(it.ammo);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}
