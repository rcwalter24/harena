// sentinel.js
// Harena bot — inertia-aware movement and short-horizon threat prediction.
// No dependencies. No asynchronous code.

export const meta = {
  name: "Sentinel Inertia",
  author: "Arena Bot",
};

let R, M, W;
let DT, PR, TURN;
let nodes, edges, route;
let lastMove, targetId, aliveBefore;
let orbitSign, orbitUntil;
let decisionStart;

const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function unit(x, y) {
  const d = Math.hypot(x, y);
  return d > 1e-9 ? { x: x / d, y: y / d } : { x: 0, y: 0 };
}

function diff(a, b) {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

function speedOf(weapon) {
  if (weapon === "gun") return R.player.speedGun;
  if (weapon === "launcher") return R.player.speedLauncher;
  return R.player.speedKnife;
}

// Entry fraction into a rectangle expanded by pad.
function rectEntry(a, b, w, pad) {
  let lo = 0, hi = 1;
  const dx = b.x - a.x, dy = b.y - a.y;

  if (Math.abs(dx) < 1e-10) {
    if (a.x < w.x - pad || a.x > w.x + w.w + pad) return Infinity;
  } else {
    let p = (w.x - pad - a.x) / dx;
    let q = (w.x + w.w + pad - a.x) / dx;
    if (p > q) [p, q] = [q, p];
    lo = Math.max(lo, p);
    hi = Math.min(hi, q);
    if (lo > hi) return Infinity;
  }

  if (Math.abs(dy) < 1e-10) {
    if (a.y < w.y - pad || a.y > w.y + w.h + pad) return Infinity;
  } else {
    let p = (w.y - pad - a.y) / dy;
    let q = (w.y + w.h + pad - a.y) / dy;
    if (p > q) [p, q] = [q, p];
    lo = Math.max(lo, p);
    hi = Math.min(hi, q);
    if (lo > hi) return Infinity;
  }

  return lo;
}

function wallEntry(a, b, pad = 0) {
  let t = Infinity;
  for (const w of W) t = Math.min(t, rectEntry(a, b, w, pad));
  return t;
}

function clear(a, b, pad = 0) {
  return wallEntry(a, b, pad) === Infinity;
}

function free(p, pad = PR) {
  if (
    p.x < pad || p.y < pad ||
    p.x > M.width - pad || p.y > M.height - pad
  ) return false;

  for (const w of W) {
    const x = clamp(p.x, w.x, w.x + w.w);
    const y = clamp(p.y, w.y, w.y + w.h);
    if (Math.hypot(p.x - x, p.y - y) < pad - 1e-6) return false;
  }
  return true;
}

function walkable(a, b) {
  return free(b, PR + 0.1) && clear(a, b, PR - 0.05);
}

// Approximate circle-wall resolution.
// The actual engine also resolves collisions between players.
function resolvePosition(x, y) {
  x = clamp(x, PR, M.width - PR);
  y = clamp(y, PR, M.height - PR);

  for (let pass = 0; pass < 2; pass++) {
    for (const w of W) {
      const nx = clamp(x, w.x, w.x + w.w);
      const ny = clamp(y, w.y, w.y + w.h);
      const dx = x - nx, dy = y - ny;
      const d = Math.hypot(dx, dy);

      if (d >= PR) continue;

      if (d > 1e-8) {
        x += dx * (PR - d) / d;
        y += dy * (PR - d) / d;
      } else {
        const sides = [
          [Math.abs(x - (w.x - PR)), w.x - PR, y],
          [Math.abs(x - (w.x + w.w + PR)), w.x + w.w + PR, y],
          [Math.abs(y - (w.y - PR)), x, w.y - PR],
          [Math.abs(y - (w.y + w.h + PR)), x, w.y + w.h + PR],
        ];
        sides.sort((a, b) => a[0] - b[0]);
        x = sides[0][1];
        y = sides[0][2];
      }
    }
    x = clamp(x, PR, M.width - PR);
    y = clamp(y, PR, M.height - PR);
  }

  return { x, y };
}

// One true tick of requested-velocity acceleration.
// Acceleration is limited by vector magnitude, not separately per axis.
function motionTick(q, command, weapon) {
  const speed = speedOf(weapon);
  const length = Math.hypot(command.x, command.y);
  const scale = length > 1 ? 1 / length : 1;
  const desiredVX = command.x * scale * speed;
  const desiredVY = command.y * scale * speed;
  const accelTime = R.player.accelTime ?? 0.3;

  let vx = desiredVX, vy = desiredVY;

  if (accelTime > 0) {
    const dx = desiredVX - q.vx;
    const dy = desiredVY - q.vy;
    const delta = Math.hypot(dx, dy);
    const maxDelta = speed / accelTime * DT;
    const fraction = delta > 1e-9 ? Math.min(1, maxDelta / delta) : 0;
    vx = q.vx + dx * fraction;
    vy = q.vy + dy * fraction;
  }

  const p = resolvePosition(q.x + vx * DT, q.y + vy * DT);

  return {
    x: p.x,
    y: p.y,
    vx: (p.x - q.x) / DT,
    vy: (p.y - q.y) / DT,
  };
}

function zoneRadius(z, t) {
  if (!z.damagePerSecond) return Infinity;

  if (z.collapseStartsIn !== null && t >= z.collapseStartsIn) {
    const duration = z.collapseEndsIn - z.collapseStartsIn;
    const from = z.collapseStartsIn > 0 ? z.finalRadius : z.radius;
    if (duration <= 0 || t >= z.collapseEndsIn) return 0;
    return from * (1 - (t - z.collapseStartsIn) / duration);
  }

  const duration = z.shrinkEndsIn - z.shrinkStartsIn;
  if (duration <= 0) return z.radius;
  const fraction = clamp((t - z.shrinkStartsIn) / duration, 0, 1);
  return z.radius + (z.finalRadius - z.radius) * fraction;
}

// Choose a reachable-looking free destination if the requested point is solid.
function freeGoal(goal) {
  const p = {
    x: clamp(goal.x, PR + 1, M.width - PR - 1),
    y: clamp(goal.y, PR + 1, M.height - PR - 1),
  };
  if (free(p, PR + 0.1)) return p;

  let best = null, cost = Infinity;

  for (let r = 24; r <= 192; r += 24) {
    for (let i = 0; i < 16; i++) {
      const a = i * TAU / 16;
      const q = { x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r };
      if (free(q, PR + 0.1)) return q;
    }
  }

  for (const n of nodes) {
    const d = dist(n, p);
    if (d < cost) {
      cost = d;
      best = n;
    }
  }

  return best || p;
}

export function init(info) {
  R = info.rules;
  M = info.map;
  W = M.walls;
  DT = 1 / R.tickRate;
  PR = R.player.radius;
  TURN = R.player.turnRateDegrees * Math.PI / 180 * DT;

  nodes = [];
  route = null;
  lastMove = { x: 0, y: 0 };
  targetId = null;
  aliveBefore = false;
  orbitSign = info.selfId % 2 ? -1 : 1;
  orbitUntil = 0;

  function add(p) {
    if (!free(p, PR + 0.1)) return;
    if (!nodes.some(n => dist(n, p) < 3)) nodes.push(p);
  }

  const margin = PR + 3;
  for (const w of W) {
    add({ x: w.x - margin, y: w.y - margin });
    add({ x: w.x + w.w + margin, y: w.y - margin });
    add({ x: w.x - margin, y: w.y + w.h + margin });
    add({ x: w.x + w.w + margin, y: w.y + w.h + margin });
  }

  for (const p of M.gunSpawns) add({ x: p.x, y: p.y });
  for (const p of M.spawns) add({ x: p.x, y: p.y });
  add({ x: M.width / 2, y: M.height / 2 });

  edges = nodes.map(() => []);
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (!walkable(nodes[i], nodes[j])) continue;
      const d = dist(nodes[i], nodes[j]);
      edges[i].push([j, d]);
      edges[j].push([i, d]);
    }
  }
}

// Cached reverse Dijkstra over wall-corner visibility graph.
function waypointTo(me, rawGoal, tick) {
  const goal = freeGoal(rawGoal);
  if (walkable(me, goal)) return goal;

  if (
    !route ||
    tick - route.tick > 12 ||
    dist(route.goal, goal) > 28
  ) {
    const costs = nodes.map(n => walkable(n, goal) ? dist(n, goal) : Infinity);
    const used = new Uint8Array(nodes.length);

    for (let k = 0; k < nodes.length; k++) {
      let selected = -1, best = Infinity;
      for (let i = 0; i < nodes.length; i++) {
        if (!used[i] && costs[i] < best) {
          best = costs[i];
          selected = i;
        }
      }
      if (selected < 0) break;
      used[selected] = 1;

      for (const [j, length] of edges[selected]) {
        costs[j] = Math.min(costs[j], best + length);
      }
    }
    route = { goal, tick, costs };
  }

  let best = Infinity, point = null;

  for (let i = 0; i < nodes.length; i++) {
    const d = dist(me, nodes[i]);
    if (d < 3 || !Number.isFinite(route.costs[i])) continue;
    const cost = d + route.costs[i];
    if (cost < best && walkable(me, nodes[i])) {
      best = cost;
      point = nodes[i];
    }
  }

  if (point) return point;

  // Local escape when wall contact prevents connection to the graph.
  let escape = goal, escapeCost = Infinity;
  for (let i = 0; i < 16; i++) {
    const a = i * TAU / 16;
    const p = { x: me.x + Math.cos(a) * 36, y: me.y + Math.sin(a) * 36 };
    if (!free(p, PR + 1)) continue;

    let valid = true;
    for (let k = 1; k <= 6; k++) {
      if (!free({
        x: me.x + (p.x - me.x) * k / 6,
        y: me.y + (p.y - me.y) * k / 6,
      }, PR - 0.1)) {
        valid = false;
        break;
      }
    }

    if (!valid) continue;
    let cost = dist(p, goal);
    if (walkable(p, goal)) cost -= 100;
    if (cost < escapeCost) {
      escapeCost = cost;
      escape = p;
    }
  }

  return escape;
}

// Enemy intent is unknown: predict continued velocity, clipping at walls.
// Inertia makes this a useful short-term model, not a guaranteed trajectory.
function predict(p, seconds) {
  const t = Math.max(0, seconds + (p.visible ? 0 : Math.min(p.seenAgo, 0.2)));
  const q = {
    x: clamp(p.x + p.vx * t, PR, M.width - PR),
    y: clamp(p.y + p.vy * t, PR, M.height - PR),
  };

  const hit = wallEntry(p, q, PR - 0.1);
  if (hit === Infinity) return q;

  const f = Math.max(0, hit - 0.002);
  return {
    x: p.x + (q.x - p.x) * f,
    y: p.y + (q.y - p.y) * f,
  };
}

function selectTarget(s) {
  const me = s.self;
  let selected = null, best = -Infinity;

  for (const p of s.players) {
    if (p.id === me.id || !p.alive) continue;
    if (!p.visible && p.seenAgo > 0.2) continue;

    const d = dist(me, p);
    let score = 250 - d * 0.42;
    if (clear(me, p, R.gun.bulletRadius)) score += 90;
    score += Math.max(0, 100 - p.hp - p.shield) * 0.7;
    if (p.id === targetId) score += 28;
    if (d < 110) score += 100;
    if (!p.visible) score -= 100;
    if (p.invulnerable > d / R.gun.bulletSpeed) score -= 160;

    if (score > best) {
      best = score;
      selected = p;
    }
  }

  targetId = selected ? selected.id : null;
  return selected;
}

function itemValue(item, p) {
  switch (item.type) {
    case "life":
      return p.lives < R.player.maxLives ? (p.lives <= 2 ? 350 : 250) : 0;
    case "gun":
      return !p.hasGun || p.ammo.gun === 0
        ? 310
        : p.ammo.gun < R.gun.maxAmmo
          ? 30 + 120 * (1 - p.ammo.gun / R.gun.maxAmmo) : 0;
    case "ammo":
      return p.hasGun && p.ammo.gun < R.gun.maxAmmo
        ? 20 + 140 * (1 - p.ammo.gun / R.gun.maxAmmo) : 0;
    case "health":
      return Math.max(0, Math.min(R.items.healthAmount, R.player.maxHp - p.hp))
        * (p.hp < 45 ? 4.5 : 2.5);
    case "shield":
      return Math.max(0, Math.min(R.items.shieldAmount, R.player.maxShield - p.shield))
        * 2.2;
    case "launcher":
      return !p.hasLauncher ? 100 : p.ammo.launcher < R.launcher.maxAmmo ? 50 : 0;
    case "mines":
      return p.mines < R.mines.maxCarry ? 15 : 0;
    default:
      return 0;
  }
}

function selectLoot(s) {
  const me = s.self;
  let selected = null, best = 0;

  for (const item of s.items) {
    const value = itemValue(item, me);
    if (value <= 0) continue;

    const d = dist(me, item);
    const travel = d * (walkable(me, item) ? 1 : 1.55) / speedOf(me.weapon) + 0.15;

    if (
      s.zone.damagePerSecond &&
      dist(item, s.zone) > zoneRadius(s.zone, travel + 1.5) - 12
    ) continue;

    let score = value / (0.85 + travel);

    for (const p of s.players) {
      if (p.id === me.id || !p.alive || !p.visible) continue;
      const pd = dist(p, item);

      if (pd + 50 < d && itemValue(item, p) > 0 && walkable(p, item)) {
        score *= 0.55;
      }

      if (pd < 160 && me.hp + me.shield < 65 && clear(p, item)) {
        score *= 0.65;
      }
    }

    if (score > best) {
      best = score;
      selected = item;
    }
  }

  return selected ? { item: selected, score: best } : null;
}

function selectWeapon(me, target) {
  const d = target ? dist(me, target) : Infinity;
  const reach = 2 * PR + R.knife.reach;

  // Avoid switching repeatedly between a loaded gun and knife.
  if (
    target && d < reach + (me.weapon === "knife" ? 16 : -8) &&
    (
      me.weapon === "knife" ||
      me.weapon === "launcher" ||
      (
        target.hp + target.shield <= R.knife.damage &&
        me.cooldowns.gun > R.player.switchTime
      )
    )
  ) return "knife";

  if (me.hasGun && me.ammo.gun > 0) return "gun";

  const launcherMargin = me.weapon === "launcher" ? 45 : 80;
  if (
    me.hasLauncher && me.ammo.launcher > 0 &&
    d > R.launcher.blastRadius + PR + launcherMargin
  ) return "launcher";

  return "knife";
}

// Earliest contact under constant relative velocity.
function contactTime(rx, ry, vx, vy, radius, limit) {
  const c = rx * rx + ry * ry - radius * radius;
  if (c <= 0) return 0;

  const a = vx * vx + vy * vy;
  if (a < 1e-9) return Infinity;

  const b = 2 * (rx * vx + ry * vy);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return Infinity;

  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= limit ? t : Infinity;
}

// Includes solid map border.
function projectileLife(p, maxTime) {
  const end = { x: p.x + p.vx * maxTime, y: p.y + p.vy * maxTime };
  const hit = wallEntry(p, end, p.radius);
  let t = hit === Infinity ? maxTime : hit * maxTime;

  if (p.vx > 0) t = Math.min(t, (M.width - p.radius - p.x) / p.vx);
  if (p.vx < 0) t = Math.min(t, (p.radius - p.x) / p.vx);
  if (p.vy > 0) t = Math.min(t, (M.height - p.radius - p.y) / p.vy);
  if (p.vy < 0) t = Math.min(t, (p.radius - p.y) / p.vy);

  return Math.max(0, t);
}

function buildThreats(s, horizon) {
  const me = s.self;

  const bullets = s.bullets
    .filter(b =>
      b.ownerId !== me.id &&
      dist(b, me) < Math.hypot(b.vx, b.vy) * horizon + 180
    )
    .map(b => ({ ...b, until: projectileLife(b, horizon) }));

  const grenades = [];
  const blasts = [];

  for (const g of s.grenades) {
    const speed = Math.hypot(g.vx, g.vy);
    if (speed < 1e-9) continue;

    let until = projectileLife(g, g.remainingRange / speed);

    for (const p of s.players) {
      if (!p.alive || !p.visible || p.id === me.id || p.id === g.ownerId) continue;
      until = Math.min(until, contactTime(
        g.x - p.x, g.y - p.y,
        g.vx - p.vx, g.vy - p.vy,
        PR + g.radius, until
      ));
    }

    grenades.push({ ...g, until });

    if (until <= 2.5) {
      blasts.push({
        x: g.x + g.vx * until,
        y: g.y + g.vy * until,
        time: until,
        radius: R.launcher.blastRadius,
        damage: R.launcher.centerDamage,
      });
    }
  }

  const fuse = s.mines.map(m => Math.max(0, m.fuse));

  for (let i = 0; i < s.mines.length; i++) {
    for (const b of blasts) {
      if (dist(s.mines[i], b) <= b.radius) {
        fuse[i] = Math.min(fuse[i], b.time);
      }
    }
  }

  // Explosion chains can bring forward other mine fuses.
  for (let pass = 0; pass < s.mines.length; pass++) {
    let changed = false;
    for (let i = 0; i < s.mines.length; i++) {
      for (let j = i + 1; j < s.mines.length; j++) {
        if (dist(s.mines[i], s.mines[j]) > R.mines.blastRadius) continue;
        const t = Math.min(fuse[i], fuse[j]);
        if (fuse[i] !== t || fuse[j] !== t) changed = true;
        fuse[i] = fuse[j] = t;
      }
    }
    if (!changed) break;
  }

  for (let i = 0; i < s.mines.length; i++) {
    blasts.push({
      x: s.mines[i].x,
      y: s.mines[i].y,
      time: fuse[i],
      radius: R.mines.blastRadius,
      damage: R.mines.centerDamage,
    });
  }

  return { bullets, grenades, blasts };
}

function nearDistance(rx, ry, vx, vy, duration) {
  const vv = vx * vx + vy * vy;
  const t = vv > 1e-9 ? clamp(-(rx * vx + ry * vy) / vv, 0, duration) : 0;
  return Math.hypot(rx + vx * t, ry + vy * t);
}

function evaluateMove(command, s, weapon, context) {
  const me = s.self;
  const { steps, hazard, enemyPaths, waypoint, desired, target } = context;
  let q = { x: me.x, y: me.y, vx: me.vx, vy: me.vy };
  let risk = 0;

  const bulletHit = new Uint8Array(hazard.bullets.length);
  const grenadeHit = new Uint8Array(hazard.grenades.length);

  for (let k = 0; k < steps; k++) {
    const prev = q;
    q = motionTick(q, command, weapon);
    const t0 = k * DT, t = (k + 1) * DT;

    for (let i = 0; i < hazard.bullets.length; i++) {
      const b = hazard.bullets[i];
      if (bulletHit[i] || b.until <= t0) continue;

      // Model collision against this tick's post-movement position,
      // matching the documented movement-before-projectiles order.
      const duration = Math.min(DT, b.until - t0);
      const miss = nearDistance(
        q.x - b.x - b.vx * t0,
        q.y - b.y - b.vy * t0,
        -b.vx, -b.vy, duration
      );

      const reach = PR + b.radius;
      if (miss <= reach + 1) {
        bulletHit[i] = 1;
        if (me.invulnerable < t) risk += R.gun.damage * 6;
      } else if (miss < reach + 13 && me.invulnerable < t) {
        risk += (reach + 13 - miss) * DT * 6;
      }
    }

    for (let i = 0; i < hazard.grenades.length; i++) {
      const g = hazard.grenades[i];
      if (grenadeHit[i] || g.ownerId === me.id || g.until <= t0) continue;

      const duration = Math.min(DT, g.until - t0);
      const miss = nearDistance(
        q.x - g.x - g.vx * t0,
        q.y - g.y - g.vy * t0,
        -g.vx, -g.vy, duration
      );

      if (miss <= PR + g.radius + 2) {
        grenadeHit[i] = 1;
        if (me.invulnerable < t) risk += R.launcher.centerDamage * 6;
      }
    }

    for (const b of hazard.blasts) {
      if (b.time > t || (k > 0 && b.time <= t0)) continue;
      if (me.invulnerable >= t) continue;

      const d = dist(q, b);
      const reach = b.radius + PR;
      if (d <= reach && clear(b, q)) {
        risk += b.damage * 6 * (1 - 0.65 * clamp((d - PR) / b.radius, 0, 1));
      }
    }

    if (s.zone.damagePerSecond && me.invulnerable < t) {
      const outside = dist(q, s.zone) - zoneRadius(s.zone, t);
      if (outside > 0) {
        risk += (16 + Math.min(outside, 200) * 0.25) * DT;
        if (Math.floor(s.time + t) > Math.floor(s.time + t0)) {
          risk += s.zone.damagePerSecond * 6;
        }
      }
    }

    for (const e of enemyPaths) {
      const p = e.player, ep = e.points[k];
      const d = dist(q, ep);

      if (d < 2 * PR + 3) risk += 80 * DT;

      if (
        p.weapon === "knife" &&
        d < 2 * PR + R.knife.reach + 5 &&
        p.cooldowns.knife <= t &&
        me.invulnerable < t &&
        clear(ep, q)
      ) {
        const a = Math.atan2(q.y - ep.y, q.x - ep.x);
        const turn = R.player.turnRateDegrees * Math.PI / 180 * t;
        if (
          Math.abs(diff(a, p.facing)) <
          R.knife.arcDegrees * Math.PI / 360 + turn
        ) {
          risk += (weapon === "knife" ? 70 : 230) * DT;
        }
      }
    }
  }

  const horizon = steps * DT;
  const speed = speedOf(weapon);

  // Keep an escape margin for explosions just beyond the rollout.
  for (const b of hazard.blasts) {
    if (b.time <= horizon || b.time > 2.5) continue;
    const remaining = b.time - horizon;
    const clearance = dist(q, b) - b.radius - PR;
    const deficit = -clearance - speed * Math.max(0, remaining - 0.15) * 0.7;

    if (deficit > 0 && clear(b, q)) risk += deficit * 2;
  }

  const dx = q.x - me.x, dy = q.y - me.y;
  let score =
    0.20 * (dist(me, waypoint) - dist(q, waypoint)) +
    0.12 * (dx * desired.x + dy * desired.y) -
    risk;

  score += 1.5 * (command.x * lastMove.x + command.y * lastMove.y);

  if (Math.hypot(command.x, command.y) > 0.7 && Math.hypot(dx, dy) < 8) {
    score -= 18;
  }

  if (target && target.visible && weapon !== "knife" && clear(q, target)) {
    const d = dist(q, predict(target, horizon));
    const preferred = target.weapon === "knife" ? 245 : 295;
    score -= Math.max(0, preferred - d) * 0.15;
  }

  return score;
}

function chooseMove(s, weapon, target, desired, waypoint) {
  const me = s.self;
  const steps = Math.max(1, Math.ceil(0.65 / DT));
  const speed = speedOf(weapon);
  const preserve = {
    x: me.vx / speed,
    y: me.vy / speed,
  };

  const candidates = [
    desired,
    preserve,
    { x: 0, y: 0 },
    lastMove,
  ];

  const base = Math.atan2(desired.y, desired.x);
  // Evaluate opposite/symmetric directions early if the time guard trips.
  const offsets = [4, -4, 8, 2, -2, 6, -6, 1, -1, 3, -3, 5, -5, 7, -7];

  for (const i of offsets) {
    const a = base + i * TAU / 16;
    candidates.push({ x: Math.cos(a), y: Math.sin(a) });
  }

  const enemyPaths = s.players
    .filter(p => p.id !== me.id && p.alive && p.visible)
    .map(player => ({
      player,
      points: Array.from({ length: steps }, (_, k) => predict(player, (k + 1) * DT)),
    }));

  const context = {
    steps,
    hazard: buildThreats(s, steps * DT),
    enemyPaths,
    waypoint,
    desired,
    target,
  };

  let best = desired, bestScore = -Infinity;

  for (let i = 0; i < candidates.length; i++) {
    const value = evaluateMove(candidates[i], s, weapon, context);
    if (value > bestScore) {
      bestScore = value;
      best = candidates[i];
    }

    // Soft guard only; performance still needs engine measurement.
    if (performance.now() - decisionStart > 5.5) break;
  }

  const length = Math.hypot(best.x, best.y);
  return length > 1 ? unit(best.x, best.y) : best;
}

function intercept(origin, target, speed) {
  const p = predict(target, DT);
  const rx = p.x - origin.x, ry = p.y - origin.y;
  const vx = target.vx, vy = target.vy;
  const a = vx * vx + vy * vy - speed * speed;
  const b = 2 * (rx * vx + ry * vy);
  const c = rx * rx + ry * ry;

  let time = Math.sqrt(c) / speed;

  if (Math.abs(a) < 1e-8) {
    if (Math.abs(b) > 1e-8 && -c / b > 0) time = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const root = Math.sqrt(disc);
      const t0 = (-b - root) / (2 * a);
      const t1 = (-b + root) / (2 * a);
      let best = Infinity;
      if (t0 > 0) best = t0;
      if (t1 > 0) best = Math.min(best, t1);
      if (Number.isFinite(best)) time = best;
    }
  }

  // Refine after clipping the enemy prediction at walls.
  let point = predict(target, Math.min(2.5, DT + time));
  for (let i = 0; i < 2; i++) {
    time = dist(origin, point) / speed;
    point = predict(target, Math.min(2.5, DT + time));
  }

  return { point, time };
}

function firing(s, weapon, target, move) {
  const me = s.self;
  const origin = motionTick(me, move, weapon);

  if (!target) {
    return {
      aim: Math.hypot(origin.vx, origin.vy) > 5
        ? Math.atan2(origin.vy, origin.vx)
        : me.facing,
      attack: false,
    };
  }

  const shot = weapon === "knife"
    ? { point: predict(target, DT), time: 0 }
    : intercept(
        origin, target,
        weapon === "gun" ? R.gun.bulletSpeed : R.launcher.grenadeSpeed
      );

  const aim = Math.atan2(shot.point.y - origin.y, shot.point.x - origin.x);
  const actualFacing = me.facing + clamp(diff(aim, me.facing), -TURN, TURN);
  let attack = false;

  if (
    me.weapon !== weapon ||
    me.cooldowns.switch > 0 ||
    me.cooldowns[weapon] > 0 ||
    (!target.visible && target.seenAgo > 0.1)
  ) return { aim, attack };

  const d = dist(origin, shot.point);
  const error = Math.abs(diff(aim, actualFacing));

  if (weapon === "knife") {
    attack =
      target.invulnerable <= 0 &&
      d <= 2 * PR + R.knife.reach - 1 &&
      error <= R.knife.arcDegrees * Math.PI / 360 - 0.02 &&
      clear(origin, shot.point);
  } else {
    const projectileRadius = weapon === "gun"
      ? R.gun.bulletRadius : R.launcher.grenadeRadius;
    const range = weapon === "gun" ? R.gun.range : R.launcher.range;
    const tolerance = Math.asin(clamp((PR + projectileRadius - 3) / Math.max(d, 1), 0, 1));

    const rayEnd = {
      x: origin.x + Math.cos(actualFacing) * d,
      y: origin.y + Math.sin(actualFacing) * d,
    };

    attack =
      d < range - 8 &&
      error <= tolerance &&
      target.invulnerable <= shot.time &&
      clear(origin, rayEnd, projectileRadius);

    if (weapon === "gun" && d > 620 && me.ammo.gun < 12) attack = false;

    if (weapon === "launcher") {
      const safe = R.launcher.blastRadius + PR + 55;
      if (d < safe) attack = false;

      // Reject a nearby player intercepting the grenade.
      for (const p of s.players) {
        if (!p.alive || !p.visible || p.id === me.id) continue;
        const pp = predict(p, DT);
        const dx = pp.x - origin.x, dy = pp.y - origin.y;
        const along = dx * Math.cos(actualFacing) + dy * Math.sin(actualFacing);
        const side = Math.abs(-dx * Math.sin(actualFacing) + dy * Math.cos(actualFacing));

        if (
          along > 0 && along < safe + PR &&
          side < PR + projectileRadius + 12
        ) attack = false;
      }
    }
  }

  // Movement selection treated spawn protection as active.
  // Keep it intact for this tick, including avoiding mine planting.
  if (me.invulnerable > 0) attack = false;

  return { aim, attack };
}

function canPlant(s, weapon, target, move) {
  const me = s.self;

  if (
    !target || !target.visible ||
    target.weapon !== "knife" ||
    me.mines <= 0 || me.cooldowns.mine > 0 ||
    me.invulnerable > 0 ||
    dist(me, target) < 70 || dist(me, target) > 155 ||
    s.mines.some(m => dist(m, me) < 190) ||
    s.grenades.some(g => dist(g, me) < 220)
  ) return false;

  const away = unit(me.x - target.x, me.y - target.y);
  if (move.x * away.x + move.y * away.y < 0.7) return false;

  const plantedAt = motionTick(me, move, weapon);
  let q = plantedAt;

  // Require a verified initial escape under current inertia.
  const ticks = Math.ceil(Math.min(1.3, R.mines.fuse * 0.75) / DT);
  for (let i = 0; i < ticks; i++) q = motionTick(q, move, weapon);

  if (dist(q, plantedAt) < R.mines.blastRadius + PR + 30) return false;

  return !s.zone.damagePerSecond ||
    dist(q, s.zone) < zoneRadius(s.zone, R.mines.fuse) - 20;
}

export function decide(s) {
  decisionStart = performance.now();
  const me = s.self;

  if (!me.alive) {
    aliveBefore = false;
    return null;
  }

  if (!aliveBefore) {
    aliveBefore = true;
    route = null;
    lastMove = { x: 0, y: 0 };
    targetId = null;
  }

  const target = selectTarget(s);
  const loot = selectLoot(s);
  const weapon = selectWeapon(me, target);
  const armed =
    (me.hasGun && me.ammo.gun > 0) ||
    (me.hasLauncher && me.ammo.launcher > 0);

  if (s.time >= orbitUntil) {
    orbitSign = Math.random() < 0.5 ? -1 : 1;
    orbitUntil = s.time + 1.3 + Math.random() * 1.2;
  }

  // Include current outward momentum in the zone margin.
  const fromCenter = unit(me.x - s.zone.x, me.y - s.zone.y);
  const outwardSpeed = Math.max(0, me.vx * fromCenter.x + me.vy * fromCenter.y);
  const brakingMargin = outwardSpeed * (R.player.accelTime ?? 0.3) * 0.5;

  const zoneDanger =
    s.zone.damagePerSecond > 0 &&
    dist(me, s.zone) >
      Math.max(0, zoneRadius(s.zone, 3.5) - 45 - brakingMargin);

  let goal = null;
  let desired = { x: 0, y: 0 };
  let waypoint = { x: me.x, y: me.y };

  if (zoneDanger) {
    goal = { x: s.zone.x, y: s.zone.y };
  } else if (
    loot &&
    (
      !armed || !target || loot.score > 65 ||
      (dist(me, loot.item) < 175 && dist(me, target) > 150)
    )
  ) {
    goal = loot.item;
  } else if (target) {
    const d = dist(me, target);
    const toward = unit(target.x - me.x, target.y - me.y);

    if (weapon === "knife") {
      const advantage =
        me.hp + me.shield >= target.hp + target.shield ||
        target.hp + target.shield <= R.knife.damage;

      if (loot && (d > 100 || !advantage)) {
        goal = loot.item;
      } else if (
        (advantage && target.weapon === "knife") ||
        d < 95 ||
        target.hp + target.shield <= R.knife.damage
      ) {
        goal = predict(target, 0.15);
      } else if (loot) {
        goal = loot.item;
      } else if (d > 500) {
        goal = { x: s.zone.x, y: s.zone.y };
      } else {
        desired = unit(
          -toward.x - toward.y * orbitSign * 0.4,
          -toward.y + toward.x * orbitSign * 0.4
        );
      }
    } else if (!clear(me, target, R.gun.bulletRadius)) {
      goal = loot && loot.score > 25 ? loot.item : target;
    } else {
      const preferred = target.weapon === "knife" ? 255 : 310;
      const radial = clamp((d - preferred) / 95, -1, 1);

      desired = unit(
        toward.x * radial - toward.y * orbitSign * 0.85,
        toward.y * radial + toward.x * orbitSign * 0.85
      );
    }
  } else if (loot) {
    goal = loot.item;
  } else {
    const center = freeGoal({ x: s.zone.x, y: s.zone.y });
    if (dist(me, center) > 80) goal = center;
  }

  if (goal) {
    waypoint = waypointTo(me, goal, s.tick);

    const dx = waypoint.x - me.x;
    const dy = waypoint.y - me.y;
    const d = Math.hypot(dx, dy);
    const heading = unit(dx, dy);

    // Slow near a final destination, but retain speed around navigation corners.
    const atFinal = dist(waypoint, goal) < 8;
    let throttle = 1;

    if (atFinal && d < 75) {
      const acceleration = speedOf(weapon) / Math.max(R.player.accelTime ?? 0.3, DT);
      const desiredSpeed = Math.sqrt(2 * acceleration * Math.max(0, d - 8));
      throttle = clamp(desiredSpeed / speedOf(weapon), 0, 1);
    }

    desired = { x: heading.x * throttle, y: heading.y * throttle };
  } else {
    waypoint = {
      x: me.x + desired.x * 180,
      y: me.y + desired.y * 180,
    };
  }

  const move = chooseMove(s, weapon, target, desired, waypoint);
  const shot = firing(s, weapon, target, move);

  // Planting is optional; reserve the remaining budget for returning the action.
  const plantMine = performance.now() - decisionStart < 7
    ? canPlant(s, weapon, target, move)
    : false;

  lastMove = move;

  return {
    move,
    aim: shot.aim,
    attack: shot.attack,
    weapon,
    plantMine,
  };
}