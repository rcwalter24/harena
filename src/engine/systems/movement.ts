import { secondsToTicks } from '../config.ts';
import { angleDiff, clamp, DEG, length, normalizeAngle } from '../dmath.ts';
import { resolveCircleWalls } from '../geometry.ts';
import type { ActionInput, GameState } from '../types.ts';
import { cancelLaserCharge } from './laser.ts';
import { inGas } from './throwables.ts';

export function applyWeaponSwitches(state: GameState, actions: readonly ActionInput[]): void {
  const switchTicks = secondsToTicks(state.config.player.switchTime, state.config);
  for (const p of state.players) {
    if (!p.alive) continue;
    const want = actions[p.id].weapon;
    if (!want || want === p.weapon) continue;
    if (want === 'gun' && !p.hasGun) continue;
    if (want === 'launcher' && !p.hasLauncher) continue;
    if (want === 'laser' && !p.hasLaser) continue;
    cancelLaserCharge(p);
    p.weapon = want;
    p.switchTimer = switchTicks;
    state.events.push({ type: 'switch', tick: state.tick, playerId: p.id, weapon: want });
  }
}

export function applyTurning(state: GameState, actions: readonly ActionInput[]): void {
  const maxTurn = (state.config.player.turnRateDegrees * DEG) / state.config.tickRate;
  for (const p of state.players) {
    if (!p.alive) continue;
    const aim = actions[p.id].aim;
    // A charging laser locks its direction, and the holder's facing with it.
    if (aim === null || p.laserCharge > 0) continue;
    const diff = angleDiff(aim, p.facing);
    p.facing = normalizeAngle(p.facing + clamp(diff, -maxTurn, maxTurn));
  }
}

export function applyMovement(state: GameState, actions: readonly ActionInput[]): void {
  const { config, map } = state;
  const r = config.player.radius;
  const dt = 1 / config.tickRate;
  const prev = state.players.map((p) => ({ x: p.x, y: p.y }));

  for (const p of state.players) {
    if (!p.alive) continue;
    const a = actions[p.id];
    let mx = a.moveX;
    let my = a.moveY;
    const len = length(mx, my);
    if (len > 1) {
      mx /= len;
      my /= len;
    }
    const weaponSpeed = p.weapon === 'gun' ? config.player.speedGun
      : p.weapon === 'launcher' ? config.player.speedLauncher
        : p.weapon === 'laser' ? config.player.speedLaser : config.player.speedKnife;
    const speed = state.clouds.length > 0 && inGas(state, p.x, p.y) ? weaponSpeed * (1 - config.gas.slow) : weaponSpeed;
    // Inertia: `move` asks for a velocity, and the actual velocity (last tick's, so walls
    // and collisions count) moves toward it by at most speed / accelTime per second.
    let vx = mx * speed;
    let vy = my * speed;
    if (config.player.accelTime > 0) {
      const maxDv = (speed / config.player.accelTime) * dt;
      const dvx = vx - p.vx;
      const dvy = vy - p.vy;
      const dv = length(dvx, dvy);
      if (dv > maxDv) {
        vx = p.vx + (dvx / dv) * maxDv;
        vy = p.vy + (dvy / dv) * maxDv;
      }
    }
    const pos = { x: p.x + vx * dt, y: p.y + vy * dt };
    resolveCircleWalls(pos, r, map.walls, map.width, map.height);
    p.x = pos.x;
    p.y = pos.y;
  }

  resolvePlayerOverlaps(state);

  for (const p of state.players) {
    if (!p.alive) {
      p.vx = 0;
      p.vy = 0;
      continue;
    }
    p.vx = (p.x - prev[p.id].x) * config.tickRate;
    p.vy = (p.y - prev[p.id].y) * config.tickRate;
  }
}

/** Push overlapping living players apart (equal split), then re-resolve walls. */
export function resolvePlayerOverlaps(state: GameState): void {
  const { config, map } = state;
  const r = config.player.radius;
  const minDist = 2 * r;
  const alive = state.players.filter((p) => p.alive);
  for (let pass = 0; pass < 4; pass++) {
    let any = false;
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i];
        const b = alive[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = length(dx, dy);
        if (d >= minDist) continue;
        any = true;
        if (d === 0) {
          // Perfectly stacked: separate along x, lower id to the left.
          dx = 1;
          dy = 0;
          d = 1;
        }
        const push = (minDist - d) / 2;
        const nx = dx / d;
        const ny = dy / d;
        const pa = resolveCircleWalls({ x: a.x - nx * push, y: a.y - ny * push }, r, map.walls, map.width, map.height);
        const pb = resolveCircleWalls({ x: b.x + nx * push, y: b.y + ny * push }, r, map.walls, map.width, map.height);
        a.x = pa.x;
        a.y = pa.y;
        b.x = pb.x;
        b.y = pb.y;
      }
    }
    if (!any) break;
  }
}
