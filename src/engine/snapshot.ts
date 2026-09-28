import type { BotState, EventView, InitInfo, PlayerView, ZoneView } from './botApi.ts';
import { laserSegments, segmentPoints } from './systems/laser.ts';
import { hideLeft, isVisibleTo } from './systems/visibility.ts';
import { zoneAt, zoneEnabled } from './systems/zone.ts';
import type { GameState, PlayerState } from './types.ts';

/** Build the plain-data view of one player that bots see. */
export function playerView(state: GameState, p: PlayerState): PlayerView {
  const t = (ticks: number) => ticks / state.config.tickRate;
  return {
    id: p.id,
    name: p.name,
    visible: true,
    seenAgo: 0,
    x: p.x,
    y: p.y,
    vx: p.vx,
    vy: p.vy,
    facing: p.facing,
    hp: p.hp,
    shield: p.shield,
    lives: p.lives,
    alive: p.alive,
    eliminated: p.eliminated,
    respawnIn: p.alive || p.eliminated ? 0 : t(p.respawnTimer),
    hideLeft: Number.isFinite(hideLeft(state, p)) ? hideLeft(state, p) : null,
    invulnerable: p.alive ? t(p.invulnerableTimer) : 0,
    weapon: p.weapon,
    hasGun: p.hasGun,
    hasLauncher: p.hasLauncher,
    hasLaser: p.hasLaser,
    ammo: { gun: p.ammo, launcher: p.grenades, laser: p.laserShots },
    laserCharge: p.alive ? t(p.laserCharge) : 0,
    mines: p.mines,
    smokeGrenades: p.smokes,
    gasGrenades: p.gases,
    cooldowns: {
      knife: t(p.knifeCooldown),
      gun: t(p.gunCooldown),
      launcher: t(p.launcherCooldown),
      laser: t(p.laserCooldown),
      mine: t(p.mineCooldown),
      throw: t(p.throwCooldown),
      switch: t(p.switchTimer),
    },
  };
}

function toPoints(flat: readonly number[]): { x: number; y: number }[] {
  const pts = [];
  for (let i = 0; i + 1 < flat.length; i += 2) pts.push({ x: flat[i], y: flat[i + 1] });
  return pts;
}

function eventViews(state: GameState): EventView[] {
  const out: EventView[] = [];
  for (const e of state.events) {
    switch (e.type) {
      case 'shot': out.push({ type: 'shot', playerId: e.playerId }); break;
      case 'swing': out.push({ type: 'swing', playerId: e.playerId, hitIds: [...e.hitIds] }); break;
      case 'hit': {
        const weapon = e.weapon === 'knife' || e.weapon === 'gun' || e.weapon === 'laser' || e.weapon === 'zone' || e.weapon === 'gas' ? e.weapon : 'explosion';
        out.push({ type: 'hit', attackerId: e.attackerId, targetId: e.targetId, weapon, damage: e.damage });
        break;
      }
      case 'laser': out.push({ type: 'laser', playerId: e.playerId, path: toPoints(e.path), hitId: e.hitId >= 0 ? e.hitId : null }); break;
      case 'death': out.push({ type: 'death', playerId: e.playerId, killerId: e.killerId, livesLeft: e.livesLeft }); break;
      case 'eliminated': out.push({ type: 'eliminated', playerId: e.playerId }); break;
      case 'respawn': out.push({ type: 'respawn', playerId: e.playerId, x: e.x, y: e.y }); break;
      case 'pickup': out.push({ type: 'pickup', playerId: e.playerId, itemType: e.itemType }); break;
    }
  }
  return out;
}

/**
 * The state bots see for the upcoming tick, shared by all bots. `self` is filled
 * in per bot (the worker harness sets it to players[selfId]), so the same object
 * can be posted to every worker.
 */
export function buildBotState(state: GameState): Omit<BotState, 'self'> {
  const { config } = state;
  return {
    tick: state.tick,
    time: state.tick / config.tickRate,
    timeLeft: state.timeLimitTicks > 0 ? Math.max(0, state.timeLimitTicks - state.tick) / config.tickRate : null,
    players: state.players.map((p) => playerView(state, p)),
    bullets: state.bullets.map((b) => ({
      id: b.id, ownerId: b.ownerId, x: b.x, y: b.y, vx: b.vx, vy: b.vy, radius: config.gun.bulletRadius,
    })),
    grenades: state.grenades.map((g) => ({
      id: g.id, ownerId: g.ownerId, x: g.x, y: g.y, vx: g.vx, vy: g.vy,
      radius: config.launcher.grenadeRadius, remainingRange: Math.max(0, config.launcher.range - g.traveled),
    })),
    mines: state.mines.map((m) => ({ id: m.id, ownerId: m.ownerId, x: m.x, y: m.y, fuse: m.fuseTimer / config.tickRate })),
    lasers: state.players.filter((p) => p.alive && p.laserCharge > 0).map((p) => ({
      ownerId: p.id,
      charge: p.laserCharge / config.tickRate,
      angle: p.laserAim,
      path: toPoints(segmentPoints(laserSegments(state, p.x, p.y, p.laserAim))),
    })),
    thrown: state.throwables.map((g) => ({ id: g.id, ownerId: g.ownerId, kind: g.kind, x: g.x, y: g.y, vx: g.vx, vy: g.vy })),
    clouds: state.clouds.map((c) => ({
      id: c.id, ownerId: c.ownerId, kind: c.kind, x: c.x, y: c.y, radius: c.radius,
      timeLeft: c.ticksLeft / config.tickRate,
      nextDamageIn: c.kind === 'gas' ? (config.tickRate - (c.age % config.tickRate)) / config.tickRate : null,
    })),
    explosions: state.explosions.map((e) => ({ ownerId: e.ownerId, source: e.source, x: e.x, y: e.y, radius: e.radius })),
    items: state.items.map((it) => ({ id: it.id, type: it.type, x: it.x, y: it.y })),
    events: eventViews(state),
    zone: zoneView(state),
  };
}

function zoneView(state: GameState): ZoneView {
  const { config } = state;
  const zone = zoneAt(state);
  const on = zoneEnabled(config);
  return {
    x: zone.x,
    y: zone.y,
    radius: zone.radius,
    finalRadius: zone.finalRadius,
    shrinkStartsIn: on ? Math.max(0, zone.startTick - state.tick) / config.tickRate : 0,
    shrinkEndsIn: on ? Math.max(0, zone.endTick - state.tick) / config.tickRate : 0,
    collapseStartsIn: Number.isFinite(zone.collapseStartTick) ? Math.max(0, zone.collapseStartTick - state.tick) / config.tickRate : null,
    collapseEndsIn: Number.isFinite(zone.collapseEndTick) ? Math.max(0, zone.collapseEndTick - state.tick) / config.tickRate : null,
    damagePerSecond: on ? config.zone.damagePerSecond : 0,
  };
}

/**
 * The shared state as one player sees it: enemies hidden in bushes show their
 * last-seen position with visible: false, and events that would give their
 * position away (pickups) are removed.
 */
export function viewForPlayer(state: GameState, base: Omit<BotState, 'self'>, viewerId: number): Omit<BotState, 'self'> {
  const viewer = state.players[viewerId];
  const hidden = new Set<number>();
  for (const target of state.players) if (!isVisibleTo(state, viewer, target)) hidden.add(target.id);
  if (hidden.size === 0) return base;
  const seen = state.lastSeen[viewerId];
  return {
    ...base,
    players: base.players.map((v) => {
      if (!hidden.has(v.id)) return v;
      const s = seen[v.id];
      return { ...v, visible: false, seenAgo: (state.tick - s.tick) / state.config.tickRate, x: s.x, y: s.y, vx: s.vx, vy: s.vy, facing: s.facing };
    }),
    events: base.events.filter((e) => !(e.type === 'pickup' && hidden.has(e.playerId))),
  };
}

/** Attach `self` for one bot (used in-process and by the worker harness). */
export function withSelf(shared: Omit<BotState, 'self'>, selfId: number): BotState {
  return { ...shared, self: shared.players[selfId] };
}

export function buildInitInfo(state: GameState, selfId: number): InitInfo {
  const { map } = state;
  return {
    selfId,
    players: state.players.map((p) => ({ id: p.id, name: p.name })),
    map: {
      id: map.id,
      name: map.name,
      width: map.width,
      height: map.height,
      walls: map.walls.map((w) => ({ x: w.x, y: w.y, w: w.w, h: w.h })),
      spawns: map.spawns.map((s) => ({ x: s.x, y: s.y })),
      gunSpawns: map.gunSpawns.map((g) => ({ x: g.x, y: g.y })),
      bushes: (map.bushes ?? []).map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h })),
    },
    rules: JSON.parse(JSON.stringify(state.config)),
    timeLimit: state.timeLimitTicks / state.config.tickRate,
  };
}
