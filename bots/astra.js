export const meta = {
  name: 'Astra',
  author: 'Astra',
};

let R, M, walls, radius, dt;
let nodes, edges, graphDistance;
let navigation = null;
let previousMove = { x: 0, y: 0 };
let lastSwitch = -100;
let lastLife = -1;
let strafe = 1;
let nextStrafe = 0;

const TAU = Math.PI * 2;
const EPS = 1e-7;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sq = (v) => v * v;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function unit(x, y) {
  const n = Math.hypot(x, y);
  return n > EPS ? { x: x / n, y: y / n } : { x: 0, y: 0 };
}

function angleDiff(a, b) {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

function pointSegmentDistance2(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const den = dx * dx + dy * dy;
  const t = den > EPS
    ? clamp(((px - ax) * dx + (py - ay) * dy) / den, 0, 1)
    : 0;
  return sq(px - ax - dx * t) + sq(py - ay - dy * t);
}

function pointRectDistance2(p, w) {
  const dx = Math.max(w.x - p.x, 0, p.x - w.x - w.w);
  const dy = Math.max(w.y - p.y, 0, p.y - w.y - w.h);
  return dx * dx + dy * dy;
}

// Segment against an ordinary rectangle.
function intersectsRect(a, b, w) {
  let lo = 0;
  let hi = 1;

  for (let axis = 0; axis < 2; axis++) {
    const p = axis === 0 ? a.x : a.y;
    const d = axis === 0 ? b.x - a.x : b.y - a.y;
    const min = axis === 0 ? w.x : w.y;
    const max = min + (axis === 0 ? w.w : w.h);

    if (Math.abs(d) < EPS) {
      if (p < min || p > max) return false;
    } else {
      let t0 = (min - p) / d;
      let t1 = (max - p) / d;
      if (t0 > t1) [t0, t1] = [t1, t0];
      lo = Math.max(lo, t0);
      hi = Math.min(hi, t1);
      if (lo > hi) return false;
    }
  }
  return true;
}

// Exact minimum distance from a segment to an axis-aligned rectangle.
// This preserves rounded player clearance at wall corners.
function segmentRectDistance2(a, b, w) {
  if (intersectsRect(a, b, w)) return 0;

  let best = Math.min(
    pointRectDistance2(a, w),
    pointRectDistance2(b, w)
  );

  for (let i = 0; i < 4; i++) {
const x = w.x + ((i & 1) ? w.w : 0);
    const y = w.y + ((i & 2) ? w.h : 0);
    best = Math.min(
      best,
      pointSegmentDistance2(x, y, a.x, a.y, b.x, b.y)
    );
  }

  return best;
}

function freePoint(p, pad = radius) {
  if (
    p.x < pad || p.y < pad ||
    p.x > M.width - pad || p.y > M.height - pad
  ) return false;

  for (const w of walls) {
    if (pointRectDistance2(p, w) < pad * pad - EPS) return false;
  }
  return true;
}

function clearPath(a, b, pad = radius) {
  if (
    b.x < pad || b.y < pad ||
    b.x > M.width - pad || b.y > M.height - pad
  ) return false;

  const limit = pad * pad;
  for (const w of walls) {
    if (pad === 0) {
      if (intersectsRect(a, b, w)) return false;
    } else if (segmentRectDistance2(a, b, w) < limit - EPS) {
      return false;
    }
  }
  return true;
}

function zoneRadiusIn(z, t) {
  if (z.damagePerSecond === 0) return Infinity;

  if (z.collapseStartsIn != null && t >= z.collapseStartsIn) {
    const duration = z.collapseEndsIn - z.collapseStartsIn;
    const startRadius = z.collapseStartsIn > 0
      ? z.finalRadius
      : z.radius;

    if (duration <= 0 || t >= z.collapseEndsIn) return 0;

    return Math.max(
      0,
      startRadius * (1 - (t - z.collapseStartsIn) / duration)
    );
  }

  const duration = z.shrinkEndsIn - z.shrinkStartsIn;
  if (duration <= 0) return z.radius;

  return z.radius - (z.radius - z.finalRadius) *
    clamp((t - z.shrinkStartsIn) / duration, 0, 1);
}

function weaponSpeed(weapon) {
  if (weapon === 'gun') return R.player.speedGun;
  if (weapon === 'launcher') return R.player.speedLauncher;
  if (weapon === 'laser') return R.player.speedLaser;
  return R.player.speedKnife;
}

function hasAmmo(me, weapon) {
  if (weapon === 'knife') return true;
  if (weapon === 'gun') return me.hasGun && me.ammo.gun > 0;
  if (weapon === 'launcher') {
    return me.hasLauncher && me.ammo.launcher > 0;
  }
  return me.hasLaser && me.ammo.laser > 0;
}

// Static visibility graph. Waypoints have extra clearance so paths
// remain usable despite inertia and imperfect local steering.
function buildGraph() {
  nodes = [];
  const margin = radius + 7;

  function add(p) {
    if (!freePoint(p, radius + 1)) return;
    if (nodes.some((q) => distance(p, q) < 3)) return;
    nodes.push(p);
  }

  for (const w of walls) {
    add({ x: w.x - margin, y: w.y - margin });
    add({ x: w.x + w.w + margin, y: w.y - margin });
    add({ x: w.x - margin, y: w.y + w.h + margin });
    add({ x: w.x + w.w + margin, y: w.y + w.h + margin });
  }

  // Additional anchors help connect open areas.
  for (const p of M.spawns) add({ x: p.x, y: p.y });
  for (const p of M.gunSpawns) add({ x: p.x, y: p.y });
  add({ x: M.width / 2, y: M.height / 2 });

  const n = nodes.length;
  edges = Array.from({ length: n }, () => []);
  graphDistance = Array.from(
    { length: n },
    (_, i) => Array.from(
      { length: n },
      (_, j) => i === j ? 0 : Infinity
    )
  );

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!clearPath(nodes[i], nodes[j], radius + 1)) continue;
      const d = distance(nodes[i], nodes[j]);
      edges[i].push({ to: j, cost: d });
      edges[j].push({ to: i, cost: d });
      graphDistance[i][j] = d;
      graphDistance[j][i] = d;
    }
  }

  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(graphDistance[i][k])) continue;
      for (let j = 0; j < n; j++) {
        const d = graphDistance[i][k] + graphDistance[k][j];
        if (d < graphDistance[i][j]) graphDistance[i][j] = d;
      }
    }
  }
}

export function init(info) {
  R = info.rules;
  M = info.map;
  walls = M.walls;
  radius = R.player.radius;
  dt = 1 / R.tickRate;

  navigation = null;
  previousMove = { x: 0, y: 0 };
  lastSwitch = -100;
  lastLife = -1;
  strafe = info.selfId % 2 === 0 ? 1 : -1;
  nextStrafe = 0;

  buildGraph();
}

// Find a nearby valid destination if the requested point lies in a wall.
function validGoal(goal) {
  const base = {
    x: clamp(goal.x, radius + 1, M.width - radius - 1),
    y: clamp(goal.y, radius + 1, M.height - radius - 1),
  };

  if (freePoint(base, radius + 0.5)) return base;

  let best = null;
  let bestDistance = Infinity;

  for (const p of nodes) {
    const d = distance(base, p);
    if (d < bestDistance) {
      bestDistance = d;
      best = p;
    }
  }

  return best || base;
}

function routeTo(me, rawGoal, tick) {
  const goal = validGoal(rawGoal);

  if (clearPath(me, goal, radius)) {
    return { point: goal, length: distance(me, goal) };
  }

  if (
    !navigation ||
    distance(navigation.goal, goal) > 24 ||
    tick - navigation.tick > 20
  ) {
    const tail = nodes.map((p) =>
      clearPath(p, goal, radius)
        ? distance(p, goal)
        : Infinity
    );

    const costs = nodes.map((_, i) => {
      let best = Infinity;
      for (let j = 0; j < nodes.length; j++) {
        best = Math.min(best, graphDistance[i][j] + tail[j]);
      }
      return best;
    });

    navigation = { goal, costs, tick };
  }

  let bestPoint = null;
  let bestCost = Infinity;

  for (let i = 0; i < nodes.length; i++) {
    const first = distance(me, nodes[i]);
    const cost = first + navigation.costs[i];
    if (cost >= bestCost || first < 2) continue;
    if (!clearPath(me, nodes[i], radius)) continue;

    bestCost = cost;
    bestPoint = nodes[i];
  }

  // Local steering will still search for a free direction if the
  // graph cannot connect the current position.
  return {
    point: bestPoint || goal,
    length: bestPoint ? bestCost : distance(me, goal) * 3,
  };
}

function advance(p, move, weapon, seconds, speedFactor = 1) {
  const speed = weaponSpeed(weapon) * speedFactor;
  const desiredX = move.x * speed;
  const desiredY = move.y * speed;

  let dx = desiredX - p.vx;
  let dy = desiredY - p.vy;
  const difference = Math.hypot(dx, dy);
  const change = R.player.accelTime > 0
    ? speed * seconds / R.player.accelTime
    : Infinity;

  if (difference > change) {
    dx *= change / difference;
    dy *= change / difference;
  }

  let vx = p.vx + dx;
  let vy = p.vy + dy;
  let x = clamp(p.x + vx * seconds, radius, M.width - radius);
  let y = clamp(p.y + vy * seconds, radius, M.height - radius);
  let bumped = false;

  // Resolve circular player versus wall rectangle, including corners.
  for (let pass = 0; pass < 2; pass++) {
    for (const w of walls) {
      const nx = clamp(x, w.x, w.x + w.w);
      const ny = clamp(y, w.y, w.y + w.h);
      const rx = x - nx;
      const ry = y - ny;
      const d = Math.hypot(rx, ry);

      if (d >= radius) continue;
      bumped = true;

      if (d > EPS) {
        x = nx + rx * radius / d;
        y = ny + ry * radius / d;
      } else {
        const sides = [
          { d: Math.abs(x - w.x), x: w.x - radius, y },
          { d: Math.abs(x - w.x - w.w), x: w.x + w.w + radius, y },
          { d: Math.abs(y - w.y), x, y: w.y - radius },
          { d: Math.abs(y - w.y - w.h), x, y: w.y + w.h + radius },
        ];
        sides.sort((a, b) => a.d - b.d);
        x = sides[0].x;
        y = sides[0].y;
      }
    }
  }

  x = clamp(x, radius, M.width - radius);
  y = clamp(y, radius, M.height - radius);

  // Actual displacement is a better approximation after a collision.
  vx = (x - p.x) / seconds;
  vy = (y - p.y) / seconds;

  return { x, y, vx, vy, bumped };
}

function predictPlayer(p, seconds) {
  // Use constant velocity, but stop before crossing a wall.
  const result = {
    x: clamp(p.x + p.vx * seconds, radius, M.width - radius),
    y: clamp(p.y + p.vy * seconds, radius, M.height - radius),
  };

  if (clearPath(p, result, radius)) return result;

  let lo = 0;
  let hi = seconds;

  for (let i = 0; i < 7; i++) {
    const mid = (lo + hi) / 2;
    const q = {
      x: p.x + p.vx * mid,
      y: p.y + p.vy * mid,
    };
    if (clearPath(p, q, radius)) lo = mid;
    else hi = mid;
  }

  return {
    x: clamp(p.x + p.vx * lo, radius, M.width - radius),
    y: clamp(p.y + p.vy * lo, radius, M.height - radius),
  };
}

function intercept(origin, enemy, projectileSpeed) {
  const rx = enemy.x - origin.x;
  const ry = enemy.y - origin.y;
  const a = enemy.vx * enemy.vx + enemy.vy * enemy.vy -
    projectileSpeed * projectileSpeed;
  const b = 2 * (rx * enemy.vx + ry * enemy.vy);
  const c = rx * rx + ry * ry;

  let t = Math.sqrt(c) / projectileSpeed;

  if (Math.abs(a) < EPS) {
    if (Math.abs(b) > EPS && -c / b > 0) t = -c / b;
  } else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      const t1 = (-b - root) / (2 * a);
      const t2 = (-b + root) / (2 * a);
      const positive = [t1, t2].filter((v) => v > 0);
      if (positive.length) t = Math.min(...positive);
    }
  }

  // Long-range predictions are too uncertain to extrapolate forever.
  return predictPlayer(enemy, clamp(t + dt, 0, 1.5));
}

function chooseEnemy(state) {
  const me = state.self;
  let best = null;
  let bestScore = -Infinity;

  for (const p of state.players) {
    if (!p.alive || p.id === me.id) continue;

    const d = distance(me, p);
    const visible = p.visible || p.seenAgo < 0.2;
    const sight = visible && clearPath(me, p, R.gun.bulletRadius);

    let score = 250 - d * 0.36;
    if (sight) score += 100;
    if (!visible) score -= 260 + Math.min(180, p.seenAgo * 45);
    if (p.invulnerable > 0) score -= 120;
    score += (200 - p.hp - p.shield) * 0.3;
    if (d < 100) score += 100;

    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }

  return best;
}

function chooseWeapon(me, enemy, time) {
  if (me.laserCharge > 0 && me.hasLaser) return 'laser';

  const d = enemy ? distance(me, enemy) : Infinity;
  const reach = 2 * radius + R.knife.reach;
  let desired;

  if (d < reach - 6 && enemy && enemy.visible) {
    desired = 'knife';
  } else if (
    me.hasLauncher && me.ammo.launcher > 0 &&
    d > R.launcher.blastRadius + radius + 65 &&
    d < 440 &&
    me.cooldowns.launcher < 0.15
  ) {
    desired = 'launcher';
  } else if (me.hasGun && me.ammo.gun > 0) {
    desired = 'gun';
  } else if (me.hasLauncher && me.ammo.launcher > 0) {
    desired = 'launcher';
  } else if (me.hasLaser && me.ammo.laser > 0) {
    desired = 'laser';
  } else {
    desired = 'knife';
  }

  // Hold a useful weapon briefly to avoid repeated switch delays.
  if (
    desired !== me.weapon &&
    hasAmmo(me, me.weapon) &&
    time - lastSwitch < 0.95 &&
    !(desired === 'knife' && d < reach - 6) &&
    !(me.weapon === 'launcher' && d < 140)
  ) {
    desired = me.weapon;
  }

  if (desired !== me.weapon) lastSwitch = time;
  return desired;
}

function itemValue(item, me) {
  const armed = (
    me.hasGun && me.ammo.gun > 0 ||
    me.hasLauncher && me.ammo.launcher > 0 ||
    me.hasLaser && me.ammo.laser > 0
  );

  switch (item.type) {
    case 'life':
      return me.lives < R.player.maxLives ? 290 : 0;
    case 'health':
      return me.hp < R.player.maxHp
        ? Math.min(R.items.healthAmount, R.player.maxHp - me.hp) *
          (me.hp < 45 ? 4.5 : 2.1)
        : 0;
    case 'shield':
      return me.shield < R.player.maxShield
        ? Math.min(R.items.shieldAmount, R.player.maxShield - me.shield) * 2
        : 0;
    case 'gun':
      return !me.hasGun ? (armed ? 150 : 255)
        : me.ammo.gun < R.gun.maxAmmo
          ? 35 + (me.ammo.gun < 8 ? 105 : 30)
          : 0;
    case 'ammo':
      return me.hasGun && me.ammo.gun < R.gun.maxAmmo
        ? (me.ammo.gun < 8 ? 120 : 45) : 0;
    case 'launcher':
      return !me.hasLauncher ? (armed ? 155 : 225)
        : me.ammo.launcher < R.launcher.maxAmmo ? 110 : 0;
    case 'laser':
      return !me.hasLaser ? (armed ? 70 : 150)
        : me.ammo.laser < R.laser.maxAmmo ? 45 : 0;
    case 'mines':
      return me.mines < R.mines.maxCarry ? 30 : 0;
    case 'gas':
      return me.gasGrenades < R.gas.maxCarry ? 35 : 0;
    case 'smoke':
      return me.smokeGrenades < R.smoke.maxCarry ? 22 : 0;
    default:
      return 0;
  }
}

function chooseItem(state) {
  const me = state.self;
  let best = null;
  let bestScore = 0;

  for (const item of state.items) {
    const value = itemValue(item, me);
    if (!value) continue;

    const d = distance(me, item);
    const travelTime = d / 170 + 1;
    if (
      state.zone.damagePerSecond > 0 &&
      distance(item, state.zone) > zoneRadiusIn(state.zone, travelTime) - 12
    ) continue;

    let cost = d;
    if (!clearPath(me, item, radius)) cost = d * 1.55 + 100;

    let score = value / (1 + cost / 230);

    for (const p of state.players) {
      if (p.id === me.id || !p.alive || !p.visible) continue;
      const theirDistance = distance(p, item);
      if (theirDistance < 125 && theirDistance + 60 < d) {
        score *= item.type === 'life' ? 0.65 : 0.42;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  return best ? { item: best, score: bestScore } : null;
}

// Distance to the first wall/border along a projectile ray.
// Expanded rectangles are deliberately conservative here.
function rayWallDistance(origin, angle, maximum, pad) {
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  let best = maximum;

  if (ux > EPS) best = Math.min(best, (M.width - pad - origin.x) / ux);
  if (ux < -EPS) best = Math.min(best, (pad - origin.x) / ux);
  if (uy > EPS) best = Math.min(best, (M.height - pad - origin.y) / uy);
  if (uy < -EPS) best = Math.min(best, (pad - origin.y) / uy);

  for (const w of walls) {
    let lo = 0;
    let hi = best;

    for (let axis = 0; axis < 2; axis++) {
      const p = axis === 0 ? origin.x : origin.y;
      const v = axis === 0 ? ux : uy;
      const min = (axis === 0 ? w.x : w.y) - pad;
      const max = (axis === 0 ? w.x + w.w : w.y + w.h) + pad;

      if (Math.abs(v) < EPS) {
        if (p < min || p > max) {
          hi = -1;
          break;
        }
      } else {
        let a = (min - p) / v;
        let b = (max - p) / v;
        if (a > b) [a, b] = [b, a];
        lo = Math.max(lo, a);
        hi = Math.min(hi, b);
      }
    }

    if (lo <= hi && hi >= 0) best = Math.min(best, Math.max(0, lo));
  }

  return Math.max(0, best);
}

function prepareThreats(state) {
  const me = state.self;

  const bullets = state.bullets
    .filter((b) => b.ownerId !== me.id && distance(b, me) < 600)
    .sort((a, b) => distance(a, me) - distance(b, me))
    .slice(0, 24)
    .map((b) => {
      const speed = Math.hypot(b.vx, b.vy);
      const range = rayWallDistance(
        b,
        Math.atan2(b.vy, b.vx),
        speed * 1.1,
        b.radius
      );
      return { ...b, stopTime: range / Math.max(1, speed) };
    });

  const grenades = state.grenades
    .filter((g) => distance(g, me) < 650)
    .slice(0, 14)
    .map((g) => {
      const speed = Math.hypot(g.vx, g.vy);
      const range = rayWallDistance(
        g,
        Math.atan2(g.vy, g.vx),
        g.remainingRange,
        g.radius
      );
      const stopTime = range / Math.max(1, speed);
      return {
        ...g,
        stopTime,
        blastX: g.x + g.vx * stopTime,
        blastY: g.y + g.vy * stopTime,
      };
    });

  return {
    bullets,
    grenades,
    mines: state.mines.filter((m) => distance(m, me) < 420),
    lasers: state.lasers,
    gas: state.clouds.filter((c) =>
      c.kind === 'gas' && distance(c, me) < c.fullRadius + 220
    ),
    enemies: state.players.filter((p) =>
      p.id !== me.id && p.alive && p.visible && distance(p, me) < 650
    ),
  };
}

function inGas(p, threats, seconds = 0) {
  for (const c of threats.gas) {
    if (c.timeLeft <= seconds) continue;

    const spread = R.throwing.spreadTime > 0
      ? c.fullRadius * seconds / R.throwing.spreadTime
      : c.fullRadius;
    const size = Math.min(c.fullRadius, c.radius + spread);

    if (distance(p, c) >= size) continue;

    let inHole = false;
    for (const h of c.holes) {
      const remaining = R.explosions.clearTime > 0
        ? Math.max(0, h.radius - h.radius * seconds / R.explosions.clearTime)
        : 0;
      if (distance(p, h) < remaining) {
        inHole = true;
        break;
      }
    }
    if (inHole) continue;

    // Behind a wall this is uncertain because gas flows around corners.
    // Treat nearby gas conservatively for movement planning.
    return true;
  }
  return false;
}

function movingSeparation(a0, a1, b0, b1) {
  return Math.sqrt(pointSegmentDistance2(
    0, 0,
    a0.x - b0.x,
    a0.y - b0.y,
    a1.x - b1.x,
    a1.y - b1.y
  ));
}

function movementRisk(p, before, t, h, state, threats, weapon) {
  let risk = 0;
  const me = state.self;

  for (const b of threats.bullets) {
    if (t - h > b.stopTime) continue;
    const end = Math.min(t, b.stopTime);
    const start = Math.max(0, t - h);
    const fraction = clamp((end - start) / h, 0, 1);
    const playerEnd = {
      x: before.x + (p.x - before.x) * fraction,
      y: before.y + (p.y - before.y) * fraction,
    };

    const d = movingSeparation(
      before, playerEnd,
      { x: b.x + b.vx * start, y: b.y + b.vy * start },
      { x: b.x + b.vx * end, y: b.y + b.vy * end }
    );

    const reach = radius + b.radius;
    if (d < reach + 18) {
      risk += (d < reach ? 210 : 48) *
        (1 - clamp((d - reach) / 18, 0, 1));
    }
  }

  for (const g of threats.grenades) {
    if (g.stopTime >= t - h && g.stopTime <= t + 0.08) {
      const d = Math.hypot(p.x - g.blastX, p.y - g.blastY);
      const reach = R.launcher.blastRadius + radius + 18;
      if (d < reach) risk += 650 * (1 - d / reach);
    }

    if (t <= g.stopTime && g.ownerId !== me.id) {
      const d = movingSeparation(
        before, p,
        { x: g.x + g.vx * (t - h), y: g.y + g.vy * (t - h) },
        { x: g.x + g.vx * t, y: g.y + g.vy * t }
      );
      if (d < radius + g.radius + 32) {
        risk += 480 * (1 - d / (radius + g.radius + 32));
      }
    }
  }

  for (const mine of threats.mines) {
    const reach = R.mines.blastRadius + radius + 22;
    const d = distance(p, mine);
    if (d >= reach) continue;

    // Begin moving before the fuse becomes urgent.
    const urgency = clamp((1.7 - (mine.fuse - t)) / 1.7, 0, 1);
    risk += 170 * urgency * (1 - d / reach);
    if (Math.abs(mine.fuse - t) < h + 0.08) {
      risk += 600 * (1 - d / reach);
    }
  }

  for (const laser of threats.lasers) {
    if (laser.charge < t - h || laser.charge > t + 0.35) continue;
    const owner = state.players[laser.ownerId];
    const shiftX = owner && owner.visible ? owner.vx * t : 0;
    const shiftY = owner && owner.visible ? owner.vy * t : 0;

    for (let i = 1; i < laser.path.length; i++) {
      if (laser.ownerId === me.id && i === 1) continue;
      const a = laser.path[i - 1];
      const b = laser.path[i];
      const d = Math.sqrt(pointSegmentDistance2(
        p.x, p.y,
        a.x + shiftX, a.y + shiftY,
        b.x + shiftX, b.y + shiftY
      ));
      const reach = radius + R.laser.beamRadius + 20;
      if (d < reach) {
        risk += 240 * (1 - d / reach);
      }
    }
  }

  if (inGas(p, threats, t)) risk += 35;

  if (state.zone.damagePerSecond > 0) {
    const excess = distance(p, state.zone) - zoneRadiusIn(state.zone, t + 0.6);
    if (excess > -15) risk += 30 + Math.max(0, excess) * 1.3;
  }

  for (const enemy of threats.enemies) {
    const ex = enemy.x + enemy.vx * Math.min(t, 0.45);
    const ey = enemy.y + enemy.vy * Math.min(t, 0.45);
    const d = Math.hypot(p.x - ex, p.y - ey);

    if (d < radius * 2 + 5) risk += 75;

    if (enemy.weapon === 'knife' && weapon !== 'knife') {
      const danger = radius * 2 + R.knife.reach + 75;
      if (d < danger) risk += (danger - d) * 1.5;
    }

    if (weapon === 'launcher' && d < 140) {
      risk += (140 - d) * 0.8;
    }

    // Small anticipation penalty for a ready enemy gun aimed at us.
    if (
      enemy.weapon === 'gun' &&
      enemy.cooldowns.gun < t + 0.15 &&
      d < 500
    ) {
      const angle = Math.atan2(p.y - ey, p.x - ex);
      const error = Math.abs(angleDiff(angle, enemy.facing));
      if (error < 0.16) risk += (0.16 - error) * 70;
    }
  }

  return risk;
}

function selectMove(state, waypoint, weapon, enemy, threats) {
  const me = state.self;
  const toward = unit(waypoint.x - me.x, waypoint.y - me.y);
  const desiredAngle = Math.atan2(toward.y, toward.x);

  const candidates = [
    { x: 0, y: 0 },
    previousMove,
    toward,
    { x: toward.x * 0.45, y: toward.y * 0.45 },
  ];

  for (let i = 0; i < 16; i++) {
    const a = desiredAngle + i * TAU / 16;
    candidates.push({ x: Math.cos(a), y: Math.sin(a) });
  }

  const initialDistance = distance(me, waypoint);
  let best = candidates[0];
  let bestScore = -Infinity;

  for (const move of candidates) {
    let p = { x: me.x, y: me.y, vx: me.vx, vy: me.vy };
    let risk = 0;
    let bumps = 0;

    // 0.8-second receding horizon, with short inertia-aware steps.
    const h = 0.1;
    for (let step = 1; step <= 8; step++) {
      const t = step * h;
      const before = p;
      const factor = inGas(p, threats, t - h) ? 1 - R.gas.slow : 1;
      p = advance(p, move, weapon, h, factor);
      if (p.bumped) bumps++;

      risk += movementRisk(
        p, before, t, h, state, threats, weapon
      ) * (1.12 - step * 0.065);
    }

    const progress = initialDistance - distance(p, waypoint);
    let score = progress * 1.25 - risk - bumps * 5;

    score += (move.x * previousMove.x + move.y * previousMove.y) * 3;

    // While charging a laser, translate our origin to track the target
    // perpendicular to the locked beam direction.
    if (me.laserCharge > 0 && enemy && enemy.visible) {
      const target = predictPlayer(enemy, Math.min(me.laserCharge, 0.8));
      const ux = Math.cos(me.facing);
      const uy = Math.sin(me.facing);
      const sideways = Math.abs(
        (target.x - p.x) * -uy + (target.y - p.y) * ux
      );
      score -= sideways * 0.65;
    }

    if (score > bestScore) {
      bestScore = score;
      best = move;
    }
  }

  return { x: best.x, y: best.y };
}

function strategicGoal(state, enemy, weapon, itemChoice) {
  const me = state.self;
  const z = state.zone;

  if (
    z.damagePerSecond > 0 &&
    distance(me, z) > Math.max(0, zoneRadiusIn(z, 3.5) - 45)
  ) {
    return validGoal({ x: z.x, y: z.y });
  }

  const d = enemy ? distance(me, enemy) : Infinity;
  const unarmed = weapon === 'knife';
  const item = itemChoice && itemChoice.item;
  const urgentItem = item && (
    item.type === 'life' ||
    item.type === 'health' && me.hp < 50 ||
    unarmed && ['gun', 'launcher', 'laser'].includes(item.type)
  );

  if (
    item &&
    (
      !enemy ||
      !enemy.visible ||
      urgentItem && d > 110 ||
      itemChoice.score > 65 && d > 220 ||
      distance(me, item) < 110 && d > 120
    )
  ) return item;

  if (!enemy || !enemy.visible && enemy.seenAgo > 1.2) {
    if (item) return item;

    // Patrol reachable positions within the future safe area.
    let best = validGoal({ x: z.x, y: z.y });
    let bestScore = -Infinity;
    const safe = zoneRadiusIn(z, 4);

    for (const p of nodes) {
      if (z.damagePerSecond > 0 && distance(p, z) > safe - 30) continue;
      const d0 = distance(me, p);
      if (d0 < 70) continue;

      let separation = 500;
      for (const other of state.players) {
        if (other.id === me.id || !other.alive || !other.visible) continue;
        separation = Math.min(separation, distance(p, other));
      }

      const score = Math.min(separation, 350) - d0 * 0.35;
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best;
  }

  if (!clearPath(me, enemy, R.gun.bulletRadius)) {
    return item && itemChoice.score > 40 ? item : enemy;
  }

  const dir = unit(enemy.x - me.x, enemy.y - me.y);

  if (unarmed) {
    // Avoid chasing a healthy armed player when an upgrade exists.
    if (
      item &&
      enemy.weapon !== 'knife' &&
      d > 95 &&
      enemy.hp + enemy.shield > R.knife.damage
    ) return item;

    return predictPlayer(enemy, Math.min(0.25, d / 500));
  }

  const ideal = weapon === 'launcher' ? 310
    : weapon === 'laser' ? 360
    : enemy.weapon === 'knife' ? 330 : 285;

  const radial = clamp((d - ideal) / 95, -1.5, 1);
  const tangent = 0.85;

  return validGoal({
    x: me.x + (dir.x * radial - dir.y * strafe * tangent) * 160,
    y: me.y + (dir.y * radial + dir.x * strafe * tangent) * 160,
  });
}

function buildAttack(state, enemy, weapon, move, threats) {
  const me = state.self;
  const result = {
    aim: me.facing,
    attack: false,
  };

  if (!enemy) return result;

  const speedFactor = inGas(me, threats) ? 1 - R.gas.slow : 1;
  const origin = advance(me, move, weapon, dt, speedFactor);
  let target;

  if (weapon === 'knife') {
    target = predictPlayer(enemy, dt);
  } else if (weapon === 'laser') {
    target = predictPlayer(enemy, R.laser.chargeTime + dt);
  } else {
    const speed = weapon === 'gun'
      ? R.gun.bulletSpeed
      : R.launcher.grenadeSpeed;
    target = intercept(origin, enemy, speed);
  }

  const aim = Math.atan2(target.y - origin.y, target.x - origin.x);
  result.aim = aim;

  if (
    me.weapon !== weapon ||
    me.cooldowns.switch > EPS ||
    me.cooldowns[weapon] > EPS ||
    me.laserCharge > 0 ||
    !hasAmmo(me, weapon) ||
    !enemy.visible && enemy.seenAgo > 0.18
  ) return result;

  const turn = R.player.turnRateDegrees * Math.PI / 180 * dt;
  const facing = me.facing + clamp(angleDiff(aim, me.facing), -turn, turn);
  const error = Math.abs(angleDiff(aim, facing));
  const d = distance(origin, target);

  // Avoid wasting spawn protection for speculative long shots.
  if (me.invulnerable > 0.3 && d > 400) return result;

  if (weapon === 'knife') {
    result.attack =
      enemy.invulnerable <= dt &&
      d <= radius * 2 + R.knife.reach - 1 &&
      error < R.knife.arcDegrees * Math.PI / 360 - 0.03 &&
      clearPath(origin, target, 0);
    return result;
  }

  if (weapon === 'laser') {
    result.attack =
      enemy.invulnerable <= R.laser.chargeTime &&
      d < 700 &&
      error < 0.045 &&
      clearPath(origin, target, R.laser.beamRadius);
    return result;
  }

  const projectileSpeed = weapon === 'gun'
    ? R.gun.bulletSpeed
    : R.launcher.grenadeSpeed;
  const projectileRadius = weapon === 'gun'
    ? R.gun.bulletRadius
    : R.launcher.grenadeRadius;
  const maximumRange = weapon === 'gun' ? R.gun.range : R.launcher.range;

  if (enemy.invulnerable > d / projectileSpeed) return result;
  if (d > maximumRange * 0.88) return result;

  const tolerance = Math.min(
    0.16,
    Math.atan2(radius + projectileRadius - 3, Math.max(1, d))
  );
  if (error > tolerance) return result;

  const wallDistance = rayWallDistance(
    origin, facing, maximumRange, projectileRadius
  );
  if (wallDistance < d - radius) return result;
  if (!clearPath(origin, target, projectileRadius)) return result;

  if (weapon === 'launcher') {
    const safe = R.launcher.blastRadius + radius + 45;
    if (d < safe || wallDistance < safe) return result;

    // A nearby intervening player could detonate our grenade immediately.
    const ux = Math.cos(facing);
    const uy = Math.sin(facing);
    for (const p of state.players) {
      if (p.id === me.id || !p.alive || !p.visible) continue;
      const q = predictPlayer(p, dt);
      const rx = q.x - origin.x;
      const ry = q.y - origin.y;
      const along = rx * ux + ry * uy;
      const side = Math.abs(rx * -uy + ry * ux);
      if (
        along > 0 && along < safe &&
        side < radius + projectileRadius + 8
      ) return result;
    }
  }

  result.attack = true;
  return result;
}

export function decide(state) {
  const me = state.self;
  if (!me.alive) {
    navigation = null;
    previousMove = { x: 0, y: 0 };
    return null;
  }

  if (lastLife !== me.lives) {
    lastLife = me.lives;
    navigation = null;
    previousMove = { x: 0, y: 0 };
    lastSwitch = -100;
  }

  if (state.time >= nextStrafe) {
    strafe = Math.random() < 0.5 ? -1 : 1;
    nextStrafe = state.time + 1.3 + Math.random() * 1.3;
  }

  const enemy = chooseEnemy(state);
  const weapon = chooseWeapon(me, enemy, state.time);
  const itemChoice = chooseItem(state);
  const threats = prepareThreats(state);
  const goal = strategicGoal(state, enemy, weapon, itemChoice);
  const route = routeTo(me, goal, state.tick);
  const move = selectMove(state, route.point, weapon, enemy, threats);
  const shot = buildAttack(state, enemy, weapon, move, threats);

  previousMove = move;

  const action = {
    move,
    weapon,
    aim: shot.aim,
    attack: shot.attack,
  };

  if (!enemy) {
    action.aim = Math.atan2(move.y, move.x);
  }

  if (enemy && enemy.visible) {
    const d = distance(me, enemy);
    const away = unit(me.x - enemy.x, me.y - enemy.y);
    const retreating = move.x * away.x + move.y * away.y > 0.45;
    const moving = Math.hypot(me.vx, me.vy) > 90;

    // Plant only while already escaping, with a clear route ahead.
    if (
      me.mines > 0 &&
      me.cooldowns.mine <= EPS &&
      me.invulnerable <= EPS &&
      d > 65 && d < 180 &&
      retreating && moving &&
      !state.mines.some((m) => distance(me, m) < 180)
    ) {
      const escapePoint = {
        x: me.x + move.x * (R.mines.blastRadius + radius + 55),
        y: me.y + move.y * (R.mines.blastRadius + radius + 55),
      };

      if (
        clearPath(me, escapePoint, radius) &&
        (
          state.zone.damagePerSecond === 0 ||
          distance(escapePoint, state.zone) <
            zoneRadiusIn(state.zone, R.mines.fuse) - 10
        )
      ) action.plantMine = true;
    }

    // Throw gas toward a target only when we can stay clear of it.
    if (
      me.gasGrenades > 0 &&
      me.cooldowns.throw <= EPS &&
      me.invulnerable <= EPS &&
      me.laserCharge <= EPS &&
      d > R.gas.radius + radius + 75 &&
      d < R.throwing.maxDistance &&
      !state.clouds.some((c) =>
        c.kind === 'gas' && distance(c, enemy) < c.fullRadius
      ) &&
      !state.thrown.some((g) =>
        g.ownerId === me.id && g.kind === 'gas'
      )
    ) {
      const targetAngle = Math.atan2(enemy.y - me.y, enemy.x - me.x);
      const turn = R.player.turnRateDegrees * Math.PI / 180 * dt;
      const facing = me.facing +
        clamp(angleDiff(action.aim, me.facing), -turn, turn);

      if (
        Math.abs(angleDiff(targetAngle, facing)) < 0.15 &&
        clearPath(me, enemy, R.throwing.radius)
      ) {
        action.throw = 'gas';
        action.throwDistance = Math.min(d, R.throwing.maxDistance);
      }
    }

    // Smoke at our feet during a low-health retreat. Do not immediately
    // reveal ourselves by firing in the same action.
    if (
      !action.throw &&
      me.smokeGrenades > 0 &&
      me.cooldowns.throw <= EPS &&
      me.invulnerable <= EPS &&
      me.hp < 38 &&
      d > 150 && d < 500 &&
      retreating &&
      me.laserCharge <= EPS &&
      !state.clouds.some((c) =>
        c.kind === 'smoke' && distance(c, me) < c.radius
      )
    ) {
      action.throw = 'smoke';
      action.throwDistance = 0;
      action.attack = false;
      action.plantMine = false;
    }
  }

  return action;
}