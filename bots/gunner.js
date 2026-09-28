// Gunner: grabs weapons, keeps its distance, leads its shots and dodges projectiles.
// Uses the gun first, the grenade launcher when out of bullets, drops mines on chasers,
// falls back to the knife when unarmed and an enemy gets close, and stays inside the safe zone.
export const meta = { name: 'Gunner', author: 'Harena examples' };

let rules = null;
let walls = [];
let strafeSign = 1;
let strafeFlipAt = 0;

export function init(info) {
  rules = info.rules;
  walls = info.map.walls;
}

// ---------- geometry helpers ----------

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function angleDiff(a, b) {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

function normalize(v) {
  const len = Math.hypot(v.x, v.y);
  return len > 1e-9 ? { x: v.x / len, y: v.y / len } : { x: 0, y: 0 };
}

// Does the segment (x0,y0)→(x1,y1) cross the rectangle grown by `pad`? (slab test)
function segmentHitsRect(x0, y0, x1, y1, r, pad) {
  let tMin = 0;
  let tMax = 1;
  const d = [x1 - x0, y1 - y0];
  const p = [x0, y0];
  const lo = [r.x - pad, r.y - pad];
  const hi = [r.x + r.w + pad, r.y + r.h + pad];
  for (let i = 0; i < 2; i++) {
    if (d[i] === 0) {
      if (p[i] < lo[i] || p[i] > hi[i]) return false;
    } else {
      let t1 = (lo[i] - p[i]) / d[i];
      let t2 = (hi[i] - p[i]) / d[i];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) return false;
    }
  }
  return true;
}

function clearShot(a, b, pad) {
  return !walls.some((w) => segmentHitsRect(a.x, a.y, b.x, b.y, w, pad));
}

// ---------- threat avoidance ----------

// Sideways push away from bullets and grenades that will pass close to us within ~1 s.
function dodgeVector(state, me) {
  let dx = 0;
  let dy = 0;
  const projectiles = [
    ...state.bullets.map((b) => ({ ...b, danger: rules.player.radius + b.radius + 12 })),
    // Grenades explode on contact, so give them a much wider berth.
    ...state.grenades.map((g) => ({ ...g, danger: rules.launcher.blastRadius + rules.player.radius })),
  ];
  for (const b of projectiles) {
    if (b.ownerId === me.id) continue;
    const speed = Math.hypot(b.vx, b.vy) || 1;
    const ux = b.vx / speed;
    const uy = b.vy / speed;
    const rx = me.x - b.x;
    const ry = me.y - b.y;
    const along = rx * ux + ry * uy; // distance ahead of the projectile
    if (along < 0 || along > speed) continue;
    const side = rx * -uy + ry * ux; // signed perpendicular offset
    if (Math.abs(side) > b.danger) continue;
    const s = side >= 0 ? 1 : -1;
    const weight = 1 - along / speed;
    dx += -uy * s * weight;
    dy += ux * s * weight;
  }
  return { x: dx, y: dy };
}

// Push away from mines that will explode soon and would reach us (including our own).
function mineEscape(state, me) {
  let dx = 0;
  let dy = 0;
  const reach = rules.mines.blastRadius + rules.player.radius + 20;
  for (const m of state.mines) {
    const d = dist(m, me);
    if (d > reach || m.fuse > 1.5) continue;
    const away = d > 1e-6 ? { x: (me.x - m.x) / d, y: (me.y - m.y) / d } : { x: 1, y: 0 };
    const urgency = 1 + (1.5 - m.fuse);
    dx += away.x * urgency;
    dy += away.y * urgency;
  }
  return { x: dx, y: dy };
}

// Zone radius `t` seconds from now (it shrinks linearly between its start and end).
function zoneRadiusIn(zone, t) {
  const shrinkTime = zone.shrinkEndsIn - zone.shrinkStartsIn;
  if (shrinkTime <= 0) return zone.radius;
  const elapsed = Math.max(0, t - zone.shrinkStartsIn);
  return zone.radius - (zone.radius - zone.finalRadius) * Math.min(1, elapsed / shrinkTime);
}

// Pull toward the zone centre when we are outside the zone, or will be within 3 s.
function zonePull(state, me) {
  const zone = state.zone;
  if (zone.damagePerSecond === 0) return { x: 0, y: 0 };
  const d = dist(me, zone);
  const slack = zoneRadiusIn(zone, 3) - rules.player.radius - 30 - d;
  if (slack > 0 || d < 1e-6) return { x: 0, y: 0 };
  const k = Math.min(3, 0.5 - slack / 50);
  return { x: ((zone.x - me.x) / d) * k, y: ((zone.y - me.y) / d) * k };
}

// ---------- decision ----------

// Nearest living enemy, preferring ones we can see (hidden ones only have a stale position).
function nearestEnemy(state, me) {
  let best = null;
  let bestD = Infinity;
  for (const p of state.players) {
    if (p.id === me.id || !p.alive) continue;
    const d = dist(p, me) + (p.visible ? 0 : 400);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

// Items worth walking to right now, nearest first.
function wantedItems(state, me) {
  const useful = (it) =>
    (it.type === 'gun' && (!me.hasGun || me.ammo.gun < rules.gun.maxAmmo)) ||
    (it.type === 'ammo' && me.hasGun && me.ammo.gun < rules.gun.maxAmmo) ||
    (it.type === 'launcher' && (!me.hasLauncher || me.ammo.launcher < rules.launcher.maxAmmo)) ||
    (it.type === 'mines' && me.mines < rules.mines.maxCarry) ||
    (it.type === 'health' && me.hp < rules.player.maxHp * 0.7) ||
    (it.type === 'shield' && me.shield < rules.player.maxShield) ||
    (it.type === 'life' && me.lives < rules.player.maxLives);
  const zoneSoon = zoneRadiusIn(state.zone, 3) - 20;
  const safe = (it) => state.zone.damagePerSecond === 0 || dist(it, state.zone) < zoneSoon;
  return state.items.filter((it) => useful(it) && safe(it)).sort((a, b) => dist(a, me) - dist(b, me));
}

export function decide(state) {
  const me = state.self;
  if (!me.alive) return null;
  const enemy = nearestEnemy(state, me);
  const dodge = dodgeVector(state, me);
  const escape = mineEscape(state, me);
  const zone = zonePull(state, me);
  const avoid = { x: dodge.x * 2 + escape.x * 3 + zone.x, y: dodge.y * 2 + escape.y * 3 + zone.y };
  const items = wantedItems(state, me);

  const weapon = me.hasGun && me.ammo.gun > 0 ? 'gun' : me.hasLauncher && me.ammo.launcher > 0 ? 'launcher' : 'knife';

  // 1) Unarmed: go for items, knife anyone who gets close.
  if (weapon === 'knife') {
    const reach = 2 * rules.player.radius + rules.knife.reach;
    const wanted = items[0];
    if (enemy && (!wanted || dist(enemy, me) < reach + 30)) {
      const angle = Math.atan2(enemy.y - me.y, enemy.x - me.x);
      const toward = normalize({ x: enemy.x - me.x, y: enemy.y - me.y });
      return {
        move: normalize({ x: toward.x + avoid.x, y: toward.y + avoid.y }),
        aim: angle,
        attack: dist(enemy, me) <= reach && Math.abs(angleDiff(angle, me.facing)) < 0.6,
        weapon: 'knife',
      };
    }
    if (wanted) {
      const toward = normalize({ x: wanted.x - me.x, y: wanted.y - me.y });
      return { move: normalize({ x: toward.x + avoid.x, y: toward.y + avoid.y }), aim: Math.atan2(toward.y, toward.x), weapon: 'knife' };
    }
    return { move: normalize(avoid), weapon: 'knife' };
  }

  if (!enemy) {
    const wanted = items[0];
    const toward = wanted ? normalize({ x: wanted.x - me.x, y: wanted.y - me.y }) : { x: 0, y: 0 };
    return { move: normalize({ x: toward.x + avoid.x, y: toward.y + avoid.y }), weapon };
  }

  // 2) Armed: keep ~320 u away, strafe sideways, grab nearby items, and lead the target.
  const d = dist(enemy, me);
  const toward = normalize({ x: enemy.x - me.x, y: enemy.y - me.y });
  const radial = d > 380 ? 1 : d < 260 ? -1 : 0;
  if (state.time >= strafeFlipAt) {
    strafeSign = Math.random() < 0.5 ? -1 : 1;
    strafeFlipAt = state.time + 0.8 + Math.random();
  }
  // Bumped into something? Flip the strafe direction.
  if (Math.hypot(me.vx, me.vy) < 40 && state.time > 0.3) strafeSign = -strafeSign;
  const strafe = { x: -toward.y * strafeSign, y: toward.x * strafeSign };
  const nearbyItem = items.find((it) => dist(it, me) < 150);
  const detour = nearbyItem ? normalize({ x: nearbyItem.x - me.x, y: nearbyItem.y - me.y }) : { x: 0, y: 0 };

  const move = normalize({
    x: toward.x * radial + strafe.x * 0.7 + detour.x + avoid.x,
    y: toward.y * radial + strafe.y * 0.7 + detour.y + avoid.y,
  });

  // Aim where the enemy will be when the projectile arrives.
  const speed = weapon === 'gun' ? rules.gun.bulletSpeed : rules.launcher.grenadeSpeed;
  const flight = d / speed;
  const lead = { x: enemy.x + enemy.vx * flight, y: enemy.y + enemy.vy * flight };
  const aim = Math.atan2(lead.y - me.y, lead.x - me.x);
  const onTarget = Math.abs(angleDiff(aim, me.facing)) < 0.08;

  // Only shoot at hidden enemies we saw a moment ago; older positions are guesses.
  const fresh = enemy.visible || enemy.seenAgo < 0.5;
  let attack = false;
  if (me.weapon === weapon && onTarget && fresh) {
    if (weapon === 'gun') {
      attack = d < rules.gun.range * 0.8 && clearShot(me, lead, rules.gun.bulletRadius);
    } else {
      // Never fire a grenade close enough to catch ourselves in the blast.
      const safe = rules.launcher.blastRadius + rules.player.radius + 40;
      attack = d > safe && d < rules.launcher.range && clearShot(me, lead, rules.launcher.grenadeRadius);
    }
  }

  // An enemy is chasing us down: leave a mine behind (mineEscape then walks us away from it).
  const plantMine = me.mines > 0 && d < 120 && me.cooldowns.mine === 0 && !state.mines.some((m) => dist(m, me) < 150);

  return { move, aim, attack, weapon, plantMine };
}
