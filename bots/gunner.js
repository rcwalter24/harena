// Gunner: grabs a gun, keeps its distance, leads its shots and dodges bullets.
// Falls back to the knife when it has no ammo and an enemy gets close.
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

// Does the segment (x0,y0)→(x1,y1) cross the rectangle? (slab test)
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

// ---------- decision ----------

function nearestEnemy(state, me) {
  let best = null;
  let bestD = Infinity;
  for (const p of state.players) {
    if (p.id === me.id || !p.alive) continue;
    const d = dist(p, me);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

// Sum of sideways pushes away from bullets that will pass close to us within ~1 s.
function dodgeVector(state, me) {
  let dx = 0;
  let dy = 0;
  const danger = rules.player.radius + rules.gun.bulletRadius + 12;
  for (const b of state.bullets) {
    if (b.ownerId === me.id) continue;
    const speed = Math.hypot(b.vx, b.vy) || 1;
    const ux = b.vx / speed;
    const uy = b.vy / speed;
    const rx = me.x - b.x;
    const ry = me.y - b.y;
    const along = rx * ux + ry * uy; // distance ahead of the bullet
    if (along < 0 || along > speed * 1.0) continue;
    const side = rx * -uy + ry * ux; // signed perpendicular offset
    if (Math.abs(side) > danger) continue;
    const s = side >= 0 ? 1 : -1;
    const weight = 1 - along / (speed * 1.0);
    dx += -uy * s * weight;
    dy += ux * s * weight;
  }
  return { x: dx, y: dy };
}

function normalize(v) {
  const len = Math.hypot(v.x, v.y);
  return len > 1e-9 ? { x: v.x / len, y: v.y / len } : { x: 0, y: 0 };
}

export function decide(state) {
  const me = state.self;
  if (!me.alive) return null;
  const enemy = nearestEnemy(state, me);
  const dodge = dodgeVector(state, me);

  // 1) No usable gun: go for the nearest gun (or ammo), knife anyone who gets close.
  const armed = me.hasGun && me.ammo.gun > 0;
  if (!armed) {
    const wanted = state.items
      .filter((it) => it.type === 'gun' || (me.hasGun && it.type === 'ammo'))
      .sort((a, b) => dist(a, me) - dist(b, me))[0];
    const reach = 2 * rules.player.radius + rules.knife.reach;
    if (enemy && (!wanted || dist(enemy, me) < reach + 30)) {
      const angle = Math.atan2(enemy.y - me.y, enemy.x - me.x);
      const toward = normalize({ x: enemy.x - me.x, y: enemy.y - me.y });
      return {
        move: normalize({ x: toward.x + dodge.x, y: toward.y + dodge.y }),
        aim: angle,
        attack: dist(enemy, me) <= reach && Math.abs(angleDiff(angle, me.facing)) < 0.6,
        weapon: 'knife',
      };
    }
    if (wanted) {
      const toward = normalize({ x: wanted.x - me.x, y: wanted.y - me.y });
      return {
        move: normalize({ x: toward.x + dodge.x * 1.5, y: toward.y + dodge.y * 1.5 }),
        aim: Math.atan2(toward.y, toward.x),
        weapon: 'knife',
      };
    }
    return { move: normalize(dodge), weapon: 'knife' };
  }

  if (!enemy) return { move: normalize(dodge), weapon: 'gun' };

  // 2) Armed: keep ~320 u away, strafe sideways, and lead the target.
  const d = dist(enemy, me);
  const toward = normalize({ x: enemy.x - me.x, y: enemy.y - me.y });
  const radial = d > 380 ? 1 : d < 260 ? -1 : 0;
  if (state.time >= strafeFlipAt) {
    strafeSign = Math.random() < 0.5 ? -1 : 1;
    strafeFlipAt = state.time + 0.8 + Math.random();
  }
  const strafe = { x: -toward.y * strafeSign, y: toward.x * strafeSign };
  // Bumped into something? Flip the strafe direction.
  if (Math.hypot(me.vx, me.vy) < 40 && state.time > 0.3) strafeSign = -strafeSign;

  const move = normalize({
    x: toward.x * radial + strafe.x * 0.7 + dodge.x * 2,
    y: toward.y * radial + strafe.y * 0.7 + dodge.y * 2,
  });

  // Aim where the enemy will be when the bullet arrives.
  const flight = d / rules.gun.bulletSpeed;
  const lead = { x: enemy.x + enemy.vx * flight, y: enemy.y + enemy.vy * flight };
  const aim = Math.atan2(lead.y - me.y, lead.x - me.x);
  const onTarget = Math.abs(angleDiff(aim, me.facing)) < 0.08;
  const attack = me.weapon === 'gun' && onTarget && d < rules.gun.range * 0.8 && clearShot(me, lead, rules.gun.bulletRadius);

  return { move, aim, attack, weapon: 'gun' };
}
