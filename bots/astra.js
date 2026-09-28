export const meta = {
  name: 'Astra',
  author: 'Astra',
};

let R, arena, walls, radius, dt;
let nodes = [];
let edges = [];
let routeCache = null;

let heldItem = -1;
let previousAlive = false;
let lastWeaponChange = -100;
let lastRequestedWeapon = 'knife';
let strafe = 1;
let nextStrafe = 0;

const TAU = Math.PI * 2;
const EPS = 1e-6;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function unit(x, y) {
  const d = Math.hypot(x, y);
  return d > 1e-9
    ? { x: x / d, y: y / d }
    : { x: 0, y: 0 };
}

function angleDiff(a, b) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

// ============================================================
// Geometry
// ============================================================

// Used for projectiles and line of sight, not player movement.
function rectHit(a, b, w, pad = 0) {
  let lo = 0;
  let hi = 1;

  for (let axis = 0; axis < 2; axis++) {
    const p = axis ? a.y : a.x;
    const d = axis ? b.y - a.y : b.x - a.x;
    const mn = (axis ? w.y : w.x) - pad;
    const mx = (axis ? w.y + w.h : w.x + w.w) + pad;

    if (Math.abs(d) < 1e-10) {
      if (p < mn || p > mx) return Infinity;
    } else {
      let t0 = (mn - p) / d;
      let t1 = (mx - p) / d;

      if (t0 > t1) [t0, t1] = [t1, t0];

      lo = Math.max(lo, t0);
      hi = Math.min(hi, t1);

      if (lo > hi) return Infinity;
    }
  }

  return lo;
}

function wallFraction(a, b, pad = 0) {
  let fraction = Infinity;

  for (const w of walls) {
    fraction = Math.min(fraction, rectHit(a, b, w, pad));
  }

  return fraction;
}

function shotClear(a, b, pad = 0) {
  return wallFraction(a, b, pad) === Infinity;
}

function pointSegmentDistanceSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const q = dx * dx + dy * dy;

  const t = q > 1e-12
    ? clamp(((px - ax) * dx + (py - ay) * dy) / q, 0, 1)
    : 0;

  const ex = px - ax - t * dx;
  const ey = py - ay - t * dy;

  return ex * ex + ey * ey;
}

function segmentDistance(p, a, b) {
  return Math.sqrt(pointSegmentDistanceSq(
    p.x, p.y, a.x, a.y, b.x, b.y
  ));
}

// Exact squared distance from a point to the solid rectangle.
function pointRectDistanceSq(p, w) {
  const dx = Math.max(w.x - p.x, 0, p.x - w.x - w.w);
  const dy = Math.max(w.y - p.y, 0, p.y - w.y - w.h);

  return dx * dx + dy * dy;
}

// Positive outside, zero on the surface, negative inside.
// For a circle centre, penetration depth is radius - clearance.
function rectClearance(p, w) {
  const q = pointRectDistanceSq(p, w);

  if (q > 0) return Math.sqrt(q);

  return -Math.min(
    p.x - w.x,
    w.x + w.w - p.x,
    p.y - w.y,
    w.y + w.h - p.y
  );
}

// Exact minimum squared distance between a segment and rectangle.
// If disjoint, the closest pair includes a segment endpoint
// or a rectangle corner.
function segmentRectDistanceSq(a, b, w) {
  if (rectHit(a, b, w, 0) !== Infinity) return 0;

  let best = Math.min(
    pointRectDistanceSq(a, w),
    pointRectDistanceSq(b, w)
  );

  const x0 = w.x;
  const x1 = w.x + w.w;
  const y0 = w.y;
  const y1 = w.y + w.h;

  best = Math.min(
    best,
    pointSegmentDistanceSq(x0, y0, a.x, a.y, b.x, b.y),
    pointSegmentDistanceSq(x1, y0, a.x, a.y, b.x, b.y),
    pointSegmentDistanceSq(x0, y1, a.x, a.y, b.x, b.y),
    pointSegmentDistanceSq(x1, y1, a.x, a.y, b.x, b.y)
  );

  return best;
}

// Exceptional recovery for a centre inside a rectangle.
//
// Signed distance inside the rectangle is the maximum of four
// affine face clearances. Permit a direction only when an active
// nearest face does not become deeper.
function canExitRectangle(a, b, w) {
  const values = [
    w.x - a.x,
    a.x - w.x - w.w,
    w.y - a.y,
    a.y - w.y - w.h,
  ];

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const slopes = [-dx, dx, -dy, dy];
  const active = Math.max(...values);

  for (let i = 0; i < 4; i++) {
    if (values[i] >= active - EPS && slopes[i] >= -EPS)
      return true;
  }

  return false;
}

// Exact circle-versus-wall sweep, with overlap recovery.
//
// If currently clear: the whole segment must remain >= radius away.
// If currently overlapping: the segment may preserve or reduce
// penetration, but may never increase it.
function circleWallMoveAllowed(a, b, w, r) {
  // Broad phase.
  if (
    Math.max(a.x, b.x) < w.x - r ||
    Math.min(a.x, b.x) > w.x + w.w + r ||
    Math.max(a.y, b.y) < w.y - r ||
    Math.min(a.y, b.y) > w.y + w.h + r
  ) {
    return true;
  }

  const start = rectClearance(a, w);

  if (start <= 0) {
    return canExitRectangle(a, b, w);
  }

  const required = Math.max(0, Math.min(r, start) - EPS);
  return segmentRectDistanceSq(a, b, w) >= required * required;
}

function borderMoveAllowed(a, b, r) {
  // Existing border penetration may stay equal or decrease.
  return (
    b.x >= Math.min(a.x, r) - EPS &&
    b.y >= Math.min(a.y, r) - EPS &&
    b.x <= Math.max(a.x, arena.width - r) + EPS &&
    b.y <= Math.max(a.y, arena.height - r) + EPS
  );
}

// Shared by navigation and movement prediction.
function walkClear(a, b, r = radius) {
  if (!borderMoveAllowed(a, b, r)) return false;

  for (const w of walls) {
    if (!circleWallMoveAllowed(a, b, w, r)) return false;
  }

  return true;
}

function free(p, r = radius) {
  if (
    p.x < r - EPS ||
    p.y < r - EPS ||
    p.x > arena.width - r + EPS ||
    p.y > arena.height - r + EPS
  ) {
    return false;
  }

  const minSq = Math.max(0, r - EPS) ** 2;

  for (const w of walls) {
    if (pointRectDistanceSq(p, w) < minSq) return false;
  }

  return true;
}

// ============================================================
// Initialization and navigation
// ============================================================

export function init(info) {
  R = info.rules;
  arena = info.map;
  walls = arena.walls;
  radius = R.player.radius;
  dt = 1 / R.tickRate;

  nodes = [];
  edges = [];
  routeCache = null;
  heldItem = -1;
  previousAlive = false;
  lastWeaponChange = -100;
  lastRequestedWeapon = 'knife';
  strafe = info.selfId % 2 ? 1 : -1;
  nextStrafe = 0;

  const margin = radius + 4;

  for (const w of walls) {
    for (const x of [w.x - margin, w.x + w.w + margin]) {
      for (const y of [w.y - margin, w.y + w.h + margin]) {
        const p = { x, y };

        if (free(p) && !nodes.some(n => distance(n, p) < 1))
          nodes.push(p);
      }
    }
  }

  edges = nodes.map(() => []);

  for (let i = 0; i < nodes.length; i++) {
    for (let j = 0; j < i; j++) {
      if (walkClear(nodes[i], nodes[j])) {
        const d = distance(nodes[i], nodes[j]);
        edges[i].push([j, d]);
        edges[j].push([i, d]);
      }
    }
  }
}

function recoveryPoint(me, goal) {
  let best = me;
  let bestScore = -Infinity;

  for (const step of [16, 40, 72]) {
    for (let i = 0; i < 24; i++) {
      const a = i * TAU / 24;

      const p = {
        x: me.x + Math.cos(a) * step,
        y: me.y + Math.sin(a) * step,
      };

      if (!walkClear(me, p)) continue;

      let clearance = Math.min(
        p.x,
        p.y,
        arena.width - p.x,
        arena.height - p.y
      );

      for (const w of walls)
        clearance = Math.min(clearance, rectClearance(p, w));

      const score =
        Math.min(clearance, radius + 15) * 4 -
        distance(p, goal) * 0.1;

      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
  }

  return best;
}

function waypoint(me, goal, tick) {
  if (walkClear(me, goal)) return goal;

  if (
    !routeCache ||
    distance(routeCache.goal, goal) > 25 ||
    tick - routeCache.tick >= 12
  ) {
    const n = nodes.length;
    const costs = new Array(n).fill(Infinity);
    const used = new Array(n).fill(false);

    for (let i = 0; i < n; i++) {
      if (walkClear(nodes[i], goal))
        costs[i] = distance(nodes[i], goal);
    }

    for (let k = 0; k < n; k++) {
      let best = -1;

      for (let i = 0; i < n; i++) {
        if (
          !used[i] &&
          Number.isFinite(costs[i]) &&
          (best < 0 || costs[i] < costs[best])
        ) {
          best = i;
        }
      }

      if (best < 0) break;

      used[best] = true;

      for (const [j, d] of edges[best])
        costs[j] = Math.min(costs[j], costs[best] + d);
    }

    routeCache = {
      goal: { x: goal.x, y: goal.y },
      tick,
      costs,
    };
  }

  let best = null;
  let bestCost = Infinity;

  for (let i = 0; i < nodes.length; i++) {
    const cost = distance(me, nodes[i]) + routeCache.costs[i];

    if (cost < bestCost && walkClear(me, nodes[i])) {
      bestCost = cost;
      best = nodes[i];
    }
  }

  return best || recoveryPoint(me, goal);
}

function zoneRadius(z, t) {
  if (!z.damagePerSecond) return Infinity;

  if (z.collapseStartsIn != null && t >= z.collapseStartsIn) {
    const duration = z.collapseEndsIn - z.collapseStartsIn;
    const start = z.collapseStartsIn > 0 ? z.finalRadius : z.radius;

    if (duration <= 0 || t >= z.collapseEndsIn) return 0;

    return start * (1 - (t - z.collapseStartsIn) / duration);
  }

  const duration = z.shrinkEndsIn - z.shrinkStartsIn;

  if (duration <= 0) return z.radius;

  return z.radius - (z.radius - z.finalRadius) *
    clamp((t - z.shrinkStartsIn) / duration, 0, 1);
}

function speedFor(weapon) {
  const key =
    weapon === 'knife' ? 'speedKnife' :
    weapon === 'launcher' ? 'speedLauncher' :
    weapon === 'laser' ? 'speedLaser' : 'speedGun';

  return R.player[key];
}

// ============================================================
// Movement prediction
// ============================================================

// Move along a displacement as far as allowed by the circle sweep.
function clippedMove(p, dx, dy) {
  const end = { x: p.x + dx, y: p.y + dy };

  if (walkClear(p, end)) return end;

  let lo = 0;
  let hi = 1;

  for (let i = 0; i < 9; i++) {
    const mid = (lo + hi) * 0.5;
    const q = { x: p.x + dx * mid, y: p.y + dy * mid };

    if (walkClear(p, q)) lo = mid;
    else hi = mid;
  }

  return { x: p.x + dx * lo, y: p.y + dy * lo };
}

// First try the actual diagonal movement.
// On collision, approach contact and then try axis sliding.
// Every accepted subsegment passes the same circle sweep.
function moveWithSliding(p, dx, dy) {
  const end = { x: p.x + dx, y: p.y + dy };

  if (walkClear(p, end)) return end;

  const contact = clippedMove(p, dx, dy);
  const rx = end.x - contact.x;
  const ry = end.y - contact.y;

  const xFirst = clippedMove(contact, rx, 0);
  const xy = clippedMove(xFirst, 0, ry);

  const yFirst = clippedMove(contact, 0, ry);
  const yx = clippedMove(yFirst, rx, 0);

  const scoreXY = (xy.x - p.x) * dx + (xy.y - p.y) * dy;
  const scoreYX = (yx.x - p.x) * dx + (yx.y - p.y) * dy;

  return scoreXY >= scoreYX ? xy : yx;
}

function advance(p, command, topSpeed, h) {
  const desiredVX = command.x * topSpeed;
  const desiredVY = command.y * topSpeed;

  const dx = desiredVX - p.vx;
  const dy = desiredVY - p.vy;
  const delta = Math.hypot(dx, dy);

  const maxDelta = R.player.accelTime > 0
    ? topSpeed * h / R.player.accelTime
    : Infinity;

  const k = delta > 0 ? Math.min(1, maxDelta / delta) : 0;

  const vx = p.vx + dx * k;
  const vy = p.vy + dy * k;

  const q = moveWithSliding(p, vx * h, vy * h);

  return {
    x: q.x,
    y: q.y,
    vx: (q.x - p.x) / h,
    vy: (q.y - p.y) / h,
  };
}

function predictPlayer(p, t) {
  return moveWithSliding(p, p.vx * t, p.vy * t);
}

// ============================================================
// Items, targets and weapons
// ============================================================

function itemValue(item, me) {
  switch (item.type) {
    case 'life':
      return me.lives < R.player.maxLives ? 260 : 0;

    case 'health':
      return me.hp < R.player.maxHp
        ? Math.min(R.items.healthAmount, R.player.maxHp - me.hp) *
          (me.hp < 45 ? 5 : 2.3)
        : 0;

    case 'shield':
      return Math.max(0,
        Math.min(R.items.shieldAmount, R.player.maxShield - me.shield) * 2
      );

    case 'gun':
      return !me.hasGun || me.ammo.gun === 0 ? 225 :
        me.ammo.gun < R.gun.maxAmmo
          ? (me.ammo.gun < 10 ? 105 : 48) : 0;

    case 'ammo':
      return me.hasGun && me.ammo.gun < R.gun.maxAmmo
        ? (me.ammo.gun < 8 ? 120 : 48) : 0;

    case 'launcher':
      return !me.hasLauncher || me.ammo.launcher < R.launcher.maxAmmo
        ? (me.ammo.launcher === 0 ? 135 : 75) : 0;

    case 'laser':
      return !me.hasLaser || me.ammo.laser < R.laser.maxAmmo
        ? (!me.ammo.gun && !me.ammo.launcher ? 140 : 65) : 0;

    case 'gas':
      return me.gasGrenades < R.gas.maxCarry ? 35 : 0;

    case 'smoke':
      return me.smokeGrenades < R.smoke.maxCarry ? 28 : 0;

    case 'mines':
      return me.mines < R.mines.maxCarry ? 24 : 0;

    default:
      return 0;
  }
}

function chooseItem(state, enemies) {
  const me = state.self;
  let best = null;
  let bestScore = 0.07;

  for (const item of state.items) {
    let value = itemValue(item, me);

    if (value <= 0) continue;

    const d = distance(me, item);
    const eta = d / Math.max(120, speedFor(me.weapon)) + 0.6;

    if (
      state.zone.damagePerSecond &&
      distance(item, state.zone) > zoneRadius(state.zone, eta + 1) - 12
    ) continue;

    const routeLength = d + (walkClear(me, item) ? 0 : 180);

    for (const e of enemies) {
      if (!e.visible) continue;

      const ed = distance(e, item);

      if (ed + 65 < d && ed < 230) value *= 0.55;
      if (ed < 110 && me.hp + me.shield < 70) value *= 0.5;
    }

    const score = value / (routeLength + 130) *
      (item.id === heldItem ? 1.18 : 1);

    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  heldItem = best ? best.id : -1;
  return best;
}

function chooseTarget(state, enemies) {
  let target = null;
  let best = Infinity;

  for (const e of enemies) {
    if (!e.visible && e.seenAgo > 1.2) continue;

    const score =
      distance(state.self, e) +
      (shotClear(state.self, e, 3) ? 0 : 240) +
      (e.visible ? 0 : 220) +
      (e.invulnerable > 0 ? 350 : 0) +
      0.6 * (e.hp + e.shield);

    if (score < best) {
      best = score;
      target = e;
    }
  }

  return target;
}

function chooseWeapon(state, target) {
  const me = state.self;
  const d = target ? distance(me, target) : Infinity;
  const reach = 2 * radius + R.knife.reach;

  let weapon;

  if (me.laserCharge > 0 && d > reach + 18) {
    weapon = 'laser';
  } else if (
    target && d < reach + 8 &&
    (
      me.weapon === 'knife' ||
      !me.ammo.gun ||
      target.hp + target.shield <= R.knife.damage
    )
  ) {
    weapon = 'knife';
  } else if (me.hasGun && me.ammo.gun > 0) {
    weapon = 'gun';
  } else if (
    me.hasLauncher && me.ammo.launcher > 0 &&
    d > R.launcher.blastRadius + radius + 55
  ) {
    weapon = 'launcher';
  } else if (me.hasLaser && me.ammo.laser > 0 && d > 130) {
    weapon = 'laser';
  } else {
    weapon = 'knife';
  }

  const usable = me.weapon === 'knife' || me.ammo[me.weapon] > 0;
  const unsafeLauncher = me.weapon === 'launcher' &&
    d < R.launcher.blastRadius + radius + 40;

  if (
    weapon !== me.weapon &&
    usable &&
    !unsafeLauncher &&
    state.time - lastWeaponChange < 0.65
  ) {
    weapon = me.weapon;
  }

  if (weapon !== lastRequestedWeapon) {
    lastRequestedWeapon = weapon;
    lastWeaponChange = state.time;
  }

  return weapon;
}

// ============================================================
// Threat preparation
// ============================================================

function threats(state) {
  const result = [];

  for (const explosive of [false, true]) {
    const list = explosive ? state.grenades : state.bullets;

    for (const p of list) {
      if (!explosive && p.ownerId === state.self.id) continue;
      if (distance(p, state.self) > 700) continue;

      const speed = Math.hypot(p.vx, p.vy);
      if (speed < 1) continue;

      const travel = explosive ? p.remainingRange : R.gun.range;
      let life = travel / speed;

      const end = {
        x: p.x + p.vx * life,
        y: p.y + p.vy * life,
      };

      const hit = wallFraction(p, end, p.radius);
      if (hit !== Infinity) life *= hit;

      if (p.vx > 0)
        life = Math.min(life, (arena.width - p.radius - p.x) / p.vx);
      if (p.vx < 0)
        life = Math.min(life, (p.radius - p.x) / p.vx);
      if (p.vy > 0)
        life = Math.min(life, (arena.height - p.radius - p.y) / p.vy);
      if (p.vy < 0)
        life = Math.min(life, (p.radius - p.y) / p.vy);

      life = Math.max(0, life);

      result.push({
        ...p,
        explosive,
        life,
        end: {
          x: p.x + p.vx * life,
          y: p.y + p.vy * life,
        },
      });
    }
  }

  return result;
}

function insideGas(p, cloud, t) {
  if (cloud.kind !== 'gas' || cloud.timeLeft <= t) return false;

  const r = Math.min(
    cloud.fullRadius,
    cloud.radius +
      t * cloud.fullRadius / Math.max(0.01, R.throwing.spreadTime)
  );

  if (distance(p, cloud) > r) return false;

  for (const hole of cloud.holes) {
    const remaining = hole.radius *
      Math.max(0, 1 - t / Math.max(0.01, R.explosions.clearTime));

    if (distance(p, hole) < remaining && shotClear(p, hole))
      return false;
  }

  // Conservative approximation of gas spreading around corners.
  return true;
}

// ============================================================
// Movement scoring
// ============================================================

function movement(
  state, target, weapon, goal, collecting, danger, enemies
) {
  const me = state.self;
  const point = waypoint(me, goal, state.tick);
  const toward = unit(point.x - me.x, point.y - me.y);

  let desired = toward;

  const fighting = target && target.visible &&
    walkClear(me, target) && !collecting;

  const ideal =
    weapon === 'knife' ? 43 :
    weapon === 'launcher' ? 320 :
    weapon === 'laser' ? 370 :
    target && target.weapon === 'knife' ? 300 : 250;

  if (fighting) {
    const u = unit(target.x - me.x, target.y - me.y);
    const radial = clamp((distance(me, target) - ideal) / 90, -1, 1);
    const side = weapon === 'knife' ? 0.2 : 0.85;

    desired = unit(
      u.x * radial - u.y * strafe * side,
      u.y * radial + u.x * strafe * side
    );
  }

  const candidates = [{ x: 0, y: 0 }, desired, toward];
  const base = Math.atan2(desired.y, desired.x);

  for (let i = 0; i < 16; i++) {
    const a = base + TAU * i / 16;
    candidates.push({ x: Math.cos(a), y: Math.sin(a) });
  }

  const steps = 10;
  const h = 1 / 15;
  const vulnerability = 1 + 65 / Math.max(25, me.hp + me.shield);

  // Compute enemy and laser predictions once, not per candidate.
  const forecasts = [];

  for (let k = 1; k <= steps; k++) {
    const t = k * h;
    forecasts.push(
      enemies.filter(e => e.visible).map(e => ({
        enemy: e,
        point: predictPlayer(e, t),
      }))
    );
  }

  const laserWarnings = [];

  for (const laser of state.lasers) {
    if (laser.charge > steps * h + h) continue;

    const shooter = state.players[laser.ownerId];
    const shift = shooter
      ? predictPlayer(shooter, laser.charge)
      : laser.path[0];

    laserWarnings.push({
      laser,
      sx: shift.x - laser.path[0].x,
      sy: shift.y - laser.path[0].y,
    });
  }

  const ownLaser = state.lasers.find(l => l.ownerId === me.id);
  const laserTarget = me.laserCharge > 0 && target && target.visible
    ? predictPlayer(target, me.laserCharge)
    : null;

  let best = desired;
  let bestScore = -Infinity;

  for (const command of candidates) {
    let p = { x: me.x, y: me.y, vx: me.vx, vy: me.vy };
    let score = 0;
    const hitProjectiles = new Set();

    for (let k = 1; k <= steps; k++) {
      const t = k * h;
      const t0 = (k - 1) * h;
      const old = p;

      let speed = speedFor(weapon);

      if (state.clouds.some(c => insideGas(p, c, t)))
        speed *= 1 - R.gas.slow;

      p = advance(p, command, speed, h);
      let risk = 0;

      for (let j = 0; j < danger.length; j++) {
        const b = danger[j];
        if (hitProjectiles.has(j)) continue;

        if (
          b.life >= t0 &&
          !(b.explosive && b.ownerId === me.id)
        ) {
          const endT = Math.min(t, b.life);
          const f = clamp((endT - t0) / h, 0, 1);

          const a = {
            x: b.x + b.vx * t0 - old.x,
            y: b.y + b.vy * t0 - old.y,
          };

          const c = {
            x: b.x + b.vx * endT - (old.x + (p.x - old.x) * f),
            y: b.y + b.vy * endT - (old.y + (p.y - old.y) * f),
          };

          const miss = segmentDistance({ x: 0, y: 0 }, a, c);

          if (miss < radius + b.radius + 7) {
            risk += b.explosive ? 180 : R.gun.damage;
            hitProjectiles.add(j);
          } else if (miss < radius + b.radius + 24) {
            risk += b.explosive ? 4 : 1;
          }
        }

        if (b.explosive && b.life >= t0 && b.life <= t) {
          const d = distance(p, b.end) - radius;

          if (d < R.launcher.blastRadius) {
            risk += R.launcher.edgeDamage +
              (R.launcher.centerDamage - R.launcher.edgeDamage) *
              (1 - Math.max(0, d) / R.launcher.blastRadius);
          }
        }
      }

      for (const mine of state.mines) {
        const reach = R.mines.blastRadius + radius + 12;
        const d = distance(p, mine);

        if (d >= reach) continue;

        const remaining = mine.fuse - t;

        if (remaining >= -h && remaining < 0.8) {
          risk += 18 * (1 - d / reach) /
            Math.max(0.12, remaining + 0.2);
        }

        if (k === steps && remaining > 0 && remaining < 1.6) {
          risk += 7 * Math.max(0, reach - d) /
            Math.max(20, speed * remaining);
        }
      }

      for (const warning of laserWarnings) {
        const { laser, sx, sy } = warning;

        if (Math.abs(laser.charge - t) > h * 1.1) continue;

        for (let j = 1; j < laser.path.length; j++) {
          if (laser.ownerId === me.id && j === 1) continue;

          // Translation after a reflection remains an approximation.
          const a = {
            x: laser.path[j - 1].x + sx,
            y: laser.path[j - 1].y + sy,
          };

          const b = {
            x: laser.path[j].x + sx,
            y: laser.path[j].y + sy,
          };

          if (
            segmentDistance(p, a, b) <
            radius + R.laser.beamRadius + 10
          ) risk += R.laser.damage;
        }
      }

      for (const c of state.clouds) {
        if (insideGas(p, c, t)) risk += 2.8;
      }

      for (const forecast of forecasts[k - 1]) {
        const e = forecast.enemy;
        const q = forecast.point;
        const d = distance(p, q);

        if (d > 150) continue;
        if (d < 2 * radius + 4) risk += 6;

        if (
          e.weapon === 'knife' &&
          weapon !== 'knife' &&
          d < 2 * radius + R.knife.reach + 25 &&
          shotClear(p, q)
        ) risk += 12;

        if (e.invulnerable > t && d < 110) risk += 8;
      }

      const outside =
        distance(p, state.zone) - zoneRadius(state.zone, t + 1);

      if (outside > -18 && state.zone.damagePerSecond) {
        score -= (Math.max(0, outside) * 0.13 + 2) / steps;
      }

      score -= risk * vulnerability * 1.7;

      if (fighting) {
        const forecast = forecasts[k - 1].find(
          f => f.enemy.id === target.id
        );

        if (forecast)
          score -= Math.abs(distance(p, forecast.point) - ideal) * 0.025;
      }
    }

    score += (
      (p.x - me.x) * desired.x +
      (p.y - me.y) * desired.y
    ) * 0.13;

    if (!fighting) {
      score += (
        distance(me, point) - distance(p, point)
      ) * 0.23;
    }

    if (ownLaser && laserTarget) {
      const ux = Math.cos(ownLaser.angle);
      const uy = Math.sin(ownLaser.angle);

      const side = Math.abs(
        (laserTarget.x - p.x) * uy -
        (laserTarget.y - p.y) * ux
      );

      score -= side * 0.2;
    }

    // Smooth penalty: small valid escapes are no longer punished
    // by the old abrupt "moved < 12 => -14" threshold.
    const moved = distance(p, me);
    const requested = Math.hypot(command.x, command.y);

    if (requested > 0.5 && moved < 2) {
      score -= 2 * (1 - moved / 2);
    }

    score += (command.x * me.vx + command.y * me.vy) * 0.004;

    if (score > bestScore) {
      bestScore = score;
      best = command;
    }
  }

  return best;
}

// ============================================================
// Aiming and attacks
// ============================================================

function intercept(origin, target, speed) {
  const rx = target.x - origin.x;
  const ry = target.y - origin.y;

  const a = target.vx * target.vx + target.vy * target.vy -
    speed * speed;
  const b = 2 * (rx * target.vx + ry * target.vy);
  const c = rx * rx + ry * ry;

  let t = Math.sqrt(c) / speed;
  const discriminant = b * b - 4 * a * c;

  if (Math.abs(a) > 1e-8 && discriminant >= 0) {
    const root = Math.sqrt(discriminant);
    const times = [
      (-b - root) / (2 * a),
      (-b + root) / (2 * a),
    ].filter(v => v > 0);

    if (times.length) t = Math.min(...times);
  } else if (Math.abs(b) > 1e-8 && -c / b > 0) {
    t = -c / b;
  }

  return {
    point: predictPlayer(target, Math.min(1.6, t)),
    time: t,
  };
}

function attackAction(state, target, weapon, move) {
  const me = state.self;
  const action = { move, weapon, attack: false };

  if (!target) return action;

  const origin = advance(me, move, speedFor(weapon), dt);

  let lead;
  let flight = 0;

  if (weapon === 'knife') {
    lead = predictPlayer(target, dt);
  } else if (weapon === 'laser') {
    flight = R.laser.chargeTime;
    lead = predictPlayer(target, flight);
  } else {
    const solution = intercept(
      origin,
      target,
      weapon === 'gun'
        ? R.gun.bulletSpeed
        : R.launcher.grenadeSpeed
    );

    lead = solution.point;
    flight = solution.time;
  }

  const aim = Math.atan2(lead.y - origin.y, lead.x - origin.x);
  action.aim = aim;

  const turn = R.player.turnRateDegrees * Math.PI / 180 * dt;
  const facing = me.laserCharge > 0
    ? me.facing
    : me.facing + clamp(angleDiff(aim, me.facing), -turn, turn);

  const error = Math.abs(angleDiff(aim, facing));
  const d = distance(origin, lead);

  const fresh = target.visible || target.seenAgo < 0.2;
  const ready =
    me.weapon === weapon &&
    me.cooldowns.switch <= 0 &&
    me.cooldowns[weapon] <= 0 &&
    me.laserCharge <= 0;

  if (fresh && ready && target.invulnerable <= flight) {
    if (weapon === 'knife') {
      action.attack =
        d <= 2 * radius + R.knife.reach - 2 &&
        error <= R.knife.arcDegrees * Math.PI / 360 - 0.04 &&
        shotClear(origin, lead);

    } else if (weapon === 'gun') {
      action.attack =
        d < R.gun.range * 0.82 &&
        error < Math.atan2(
          radius + R.gun.bulletRadius - 4,
          Math.max(1, d)
        ) &&
        shotClear(origin, lead, R.gun.bulletRadius);

    } else if (weapon === 'launcher') {
      const safety = R.launcher.blastRadius + radius + 60;
      const nearEnd = {
        x: origin.x + Math.cos(facing) * safety,
        y: origin.y + Math.sin(facing) * safety,
      };

      const nearPlayer = state.players.some(p =>
        p.alive &&
        p.id !== me.id &&
        p.visible &&
        distance(origin, p) < safety &&
        segmentDistance(p, origin, nearEnd) <
          radius + R.launcher.grenadeRadius
      );

      action.attack =
        d > safety &&
        d < R.launcher.range * 0.9 &&
        error < Math.atan2(
          radius + R.launcher.grenadeRadius - 3,
          Math.max(1, d)
        ) &&
        shotClear(origin, lead, R.launcher.grenadeRadius) &&
        shotClear(origin, nearEnd, R.launcher.grenadeRadius) &&
        !nearPlayer;

    } else {
      action.attack =
        d > 150 &&
        d < 900 &&
        error < 0.035 &&
        shotClear(origin, lead, R.laser.beamRadius);
    }
  }

  if (
    me.invulnerable > 0.25 &&
    weapon === 'knife' &&
    target.hp + target.shield > R.knife.damage &&
    target.weapon !== 'knife'
  ) {
    action.attack = false;
  }

  if (
    me.gasGrenades > 0 &&
    me.cooldowns.throw <= 0 &&
    me.invulnerable <= 0 &&
    target.visible &&
    d > 170 &&
    d < R.throwing.maxDistance &&
    error < 0.12 &&
    shotClear(origin, lead, R.throwing.radius)
  ) {
    action.throw = 'gas';
    action.throwDistance = Math.min(d, R.throwing.maxDistance);
  }

  const pursuing = target.visible &&
    (
      target.vx * (me.x - target.x) +
      target.vy * (me.y - target.y)
    ) > 0;

  if (
    me.mines > 0 &&
    me.cooldowns.mine <= 0 &&
    me.invulnerable <= 0 &&
    pursuing &&
    distance(me, target) < 150 &&
    Math.hypot(me.vx, me.vy) > 130 &&
    !state.mines.some(
      m => distance(me, m) < R.mines.blastRadius + 60
    )
  ) {
    const escapeDistance = R.mines.blastRadius + radius + 40;

    const escape = {
      x: me.x + move.x * escapeDistance,
      y: me.y + move.y * escapeDistance,
    };

    if (
      free(escape) &&
      walkClear(me, escape) &&
      distance(escape, state.zone) <
        zoneRadius(state.zone, R.mines.fuse)
    ) {
      action.plantMine = true;
    }
  }

  if (
    !action.throw &&
    !action.attack &&
    me.smokeGrenades > 0 &&
    me.cooldowns.throw <= 0 &&
    me.invulnerable <= 0 &&
    me.hp + me.shield < 55 &&
    distance(me, target) > 160 &&
    (me.hideLeft == null || me.hideLeft > 2) &&
    !state.clouds.some(
      c => c.kind === 'smoke' && distance(me, c) < c.radius
    )
  ) {
    action.throw = 'smoke';
    action.throwDistance = 0;
  }

  return action;
}

// ============================================================
// Main decision
// ============================================================

export function decide(state) {
  const me = state.self;

  if (!me.alive) {
    previousAlive = false;
    return null;
  }

  if (!previousAlive) {
    routeCache = null;
    heldItem = -1;
    lastWeaponChange = -100;
    lastRequestedWeapon = me.weapon;
    previousAlive = true;
  }

  const enemies = state.players.filter(
    p => p.id !== me.id && p.alive
  );

  const target = chooseTarget(state, enemies);
  const weapon = chooseWeapon(state, target);
  const item = chooseItem(state, enemies);

  if (state.time >= nextStrafe) {
    strafe = -strafe;
    nextStrafe = state.time + 1.1 + Math.random() * 1.4;
  }

  let goal = { x: state.zone.x, y: state.zone.y };
  let collecting = false;

  const armed =
    (me.hasGun && me.ammo.gun > 0) ||
    (me.hasLauncher && me.ammo.launcher > 0) ||
    (me.hasLaser && me.ammo.laser > 0);

  if (target) goal = target;

  if (item) {
    const d = distance(me, item);

    const urgent =
      item.type === 'life' ||
      (item.type === 'health' && me.hp < 65) ||
      !armed;

    if (
      urgent ||
      !target ||
      d < 260 ||
      !shotClear(me, target, R.gun.bulletRadius)
    ) {
      goal = item;
      collecting = true;
    }
  }

  if ((!target || !target.visible) && !collecting) {
    goal = { x: state.zone.x, y: state.zone.y };

    if (target && target.seenAgo < 0.7)
      goal = target;
  }

  const safeRadius = zoneRadius(state.zone, 3);

  if (
    state.zone.damagePerSecond &&
    distance(me, state.zone) > Math.max(0, safeRadius - 45)
  ) {
    goal = { x: state.zone.x, y: state.zone.y };
    collecting = true;
  }

  if (
    !free(goal) &&
    goal.x === state.zone.x &&
    goal.y === state.zone.y
  ) {
    let best = null;
    let bestCost = Infinity;

    for (const p of nodes) {
      const cost =
        distance(p, state.zone) * 3 +
        distance(me, p);

      if (cost < bestCost) {
        bestCost = cost;
        best = p;
      }
    }

    if (best) goal = best;
  }

  const danger = threats(state);

  const move = movement(
    state,
    target,
    weapon,
    goal,
    collecting,
    danger,
    enemies
  );

  return attackAction(state, target, weapon, move);
}