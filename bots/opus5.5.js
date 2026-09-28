// opus5.5 — a Harena bot.
//
// Brain:   picks a goal every tick (fight / loot / retreat / zone) from the whole state, and
//          prefers fights it is winning: weak or busy targets, few enemies with a line on us.
// Legs:    grid Dijkstra for routes around walls, then a short-horizon planner that simulates
//          ~20 candidate moves with inertia and wall sliding for 0.8 s and scores each against
//          every known threat (bullets, likely next shots, grenades, mine chains, laser warning
//          lines incl. bounces, gas, knife rushers, the zone, open sight lines to extra enemies).
// Hands:   robust aiming: each shot is scored against several guesses of how the target will
//          move (keep going, stop, reverse, sidestep); fire only when enough of them are hit.
//          Laser: after the charge starts, the legs steer the beam onto the target.
//          Launcher: simulated grenade flight incl. wall bursts; never catches itself.
export const meta = { name: 'opus5.5', author: 'Claude Opus 5.5' };

const TAU = Math.PI * 2;
const DEBUG = false;
let _tp = [];
function _mark(l) { if (DEBUG) _tp.push(l, performance.now()); }
const H = 24; // planner horizon in ticks (0.8 s: covers a full laser charge)
const CS = 20; // navigation grid cell

let R = null;
let DT = 1 / 30;
let TURN = 0.314;
let RAD = 16;
let selfId = -1;
let walls = [];
let solids = [];
let mapW = 0;
let mapH = 0;

let GW = 0;
let GH = 0;
let blocked = null;
let gdist = null;
let gpar = null;
let heapN = null;
let heapK = null;
let heapSize = 0;
let popK = 0;
let startCell = -1;

// per tick
let me = null;
let now = 0;
let nearWalls = [];
let TH = null;
let zoneOn = true;
let ZX = 0;
let ZY = 0;
let ZONE = null;
let enemies = [];
let T0 = 0;
const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const pathBuf = new Float64Array(2 * H);
const bestPath = new Float64Array(2 * H);

// memory
let strafeSign = 1;
let strafeFlipAt = 0;
let targetId = -1;
let itemTargetId = -1;
let stuckTicks = 0;
let unstickUntil = -1;
let unstickDir = { x: 0, y: 0 };
let lastPos = null;
let lastCmd = { x: 0, y: 0 };
let laserTargetId = -1;
let prevWeapon = 'knife';
const lastHurtBy = new Map();
const lastBusy = new Map();

export function init(info) {
  R = info.rules;
  selfId = info.selfId;
  DT = 1 / (R.tickRate || 30);
  TURN = ((R.player.turnRateDegrees * Math.PI) / 180) * DT;
  RAD = R.player.radius;
  walls = info.map.walls;
  mapW = info.map.width;
  mapH = info.map.height;
  const t = 1000;
  solids = walls.concat([
    { x: -t, y: -t, w: mapW + 2 * t, h: t },
    { x: -t, y: mapH, w: mapW + 2 * t, h: t },
    { x: -t, y: 0, w: t, h: mapH },
    { x: mapW, y: 0, w: t, h: mapH },
  ]);
  buildGrid();
  warmup(info);
}

// Run decide() on synthetic states so the hot paths are compiled before tick 0.
function warmup(info) {
  const t0 = clock();
  const sp = info.map.spawns.length ? info.map.spawns : [{ x: mapW / 2, y: mapH / 2 }];
  const other = info.players.find((p) => p.id !== selfId);
  const oid = other ? other.id : selfId + 1;
  const mk = (id, x, y, w) => ({
    id, name: 'w', visible: true, seenAgo: 0, x, y, vx: 80, vy: -50, facing: 0.4, hp: 80, shield: 20, lives: 3,
    alive: true, eliminated: false, respawnIn: 0, hideLeft: 5, invulnerable: 0, weapon: w,
    hasGun: true, hasLauncher: true, hasLaser: true, ammo: { gun: 12, launcher: 3, laser: 3 }, laserCharge: 0,
    mines: 1, smokeGrenades: 1, gasGrenades: 1,
    cooldowns: { knife: 0, gun: 0, launcher: 0, laser: 0, mine: 0, throw: 0, switch: 0 },
  });
  const ws = ['gun', 'launcher', 'laser', 'knife'];
  for (let i = 0; i < 120; i++) {
    if (clock() - t0 > 400) break;
    const a = sp[i % sp.length];
    const b = sp[(i + 3) % sp.length];
    const self = mk(selfId, a.x, a.y, ws[i % 4]);
    if (i % 5 === 0) { self.hasGun = false; self.hasLauncher = false; self.hasLaser = false; self.weapon = 'knife'; }
    if (i % 7 === 3) self.laserCharge = 0.4;
    const e1 = mk(oid, Math.min(mapW - 20, a.x + 80 + (i % 5) * 60), Math.min(mapH - 20, a.y + 40), ws[(i + 1) % 4]);
    const players = [];
    players[selfId] = self;
    players[oid] = e1;
    for (let k = 0; k < players.length; k++) if (!players[k]) players[k] = { ...mk(k, b.x, b.y, 'gun'), alive: false };
    const zt = (i * 2) % 175;
    const st = {
      tick: i, time: zt, timeLeft: 180 - zt, self, players,
      bullets: [{ id: 1, ownerId: oid, x: a.x + 150, y: a.y, vx: -480, vy: 0, radius: 4 }],
      grenades: [{ id: 2, ownerId: oid, x: a.x + 200, y: a.y + 40, vx: -360, vy: 0, radius: 6, remainingRange: 500 }],
      mines: [{ id: 3, ownerId: oid, x: a.x + 40, y: a.y - 30, fuse: 1.2 }],
      lasers: [{ ownerId: oid, charge: 0.5, angle: Math.PI, path: [] }],
      thrown: [], clouds: [{ id: 5, ownerId: oid, kind: 'gas', x: a.x + 60, y: a.y, radius: 80, fullRadius: 100, timeLeft: 4, nextDamageIn: 0.5, holes: [] }],
      explosions: [], events: [{ type: 'hit', attackerId: oid, targetId: selfId, weapon: 'gun', damage: 20 }],
      items: [{ id: 4, type: 'gun', x: b.x, y: a.y }, { id: 5, type: 'health', x: a.x - 90, y: a.y + 50 }, { id: 6, type: 'laser', x: mapW / 2, y: mapH / 2 }],
      zone: zoneAtTime(zt),
    };
    try {
      decide(st);
    } catch (e) {
      break;
    }
  }
  strafeSign = 1; strafeFlipAt = 0; targetId = -1; itemTargetId = -1; stuckTicks = 0; unstickUntil = -1;
  lastPos = null; lastCmd = { x: 0, y: 0 }; laserTargetId = -1; prevWeapon = 'knife';
  lastHurtBy.clear(); lastBusy.clear();
}
function zoneAtTime(t) {
  return {
    x: mapW / 2, y: mapH / 2, radius: 900, finalRadius: 200,
    shrinkStartsIn: Math.max(0, 45 - t), shrinkEndsIn: Math.max(0, 150 - t),
    collapseStartsIn: Math.max(0, 165 - t), collapseEndsIn: Math.max(0, 180 - t), damagePerSecond: 10,
  };
}

// ======================================================================= geometry

function angleDiff(a, b) {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function norm(x, y) {
  const l = Math.hypot(x, y);
  return l > 1e-9 ? { x: x / l, y: y / l } : { x: 0, y: 0 };
}
function pointRectDist(px, py, r) {
  const dx = Math.max(r.x - px, 0, px - (r.x + r.w));
  const dy = Math.max(r.y - py, 0, py - (r.y + r.h));
  return Math.hypot(dx, dy);
}
function segHitsRect(x0, y0, x1, y1, r, pad) {
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lx = r.x - pad;
  const hx = r.x + r.w + pad;
  const ly = r.y - pad;
  const hy = r.y + r.h + pad;
  if (dx === 0) {
    if (x0 < lx || x0 > hx) return false;
  } else {
    let a = (lx - x0) / dx;
    let b = (hx - x0) / dx;
    if (a > b) { const s = a; a = b; b = s; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return false;
  }
  if (dy === 0) {
    if (y0 < ly || y0 > hy) return false;
  } else {
    let a = (ly - y0) / dy;
    let b = (hy - y0) / dy;
    if (a > b) { const s = a; a = b; b = s; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return false;
  }
  return true;
}
function losClear(ax, ay, bx, by, pad) {
  for (let i = 0; i < walls.length; i++) if (segHitsRect(ax, ay, bx, by, walls[i], pad)) return false;
  return true;
}
function walkable(ax, ay, bx, by) {
  return losClear(ax, ay, bx, by, RAD - 2);
}
// Distance along unit ray before a circle of radius `pad` touches a wall or the border.
function rayDist(x, y, ux, uy, pad, maxD) {
  let best = maxD;
  if (ux > 1e-9) best = Math.min(best, (mapW - pad - x) / ux);
  else if (ux < -1e-9) best = Math.min(best, (x - pad) / -ux);
  if (uy > 1e-9) best = Math.min(best, (mapH - pad - y) / uy);
  else if (uy < -1e-9) best = Math.min(best, (y - pad) / -uy);
  for (let i = 0; i < walls.length; i++) {
    const r = walls[i];
    let t0 = 0;
    let t1 = best;
    const lx = r.x - pad;
    const hx = r.x + r.w + pad;
    const ly = r.y - pad;
    const hy = r.y + r.h + pad;
    if (Math.abs(ux) < 1e-9) {
      if (x < lx || x > hx) continue;
    } else {
      let a = (lx - x) / ux;
      let b = (hx - x) / ux;
      if (a > b) { const s = a; a = b; b = s; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) continue;
    }
    if (Math.abs(uy) < 1e-9) {
      if (y < ly || y > hy) continue;
    } else {
      let a = (ly - y) / uy;
      let b = (hy - y) / uy;
      if (a > b) { const s = a; a = b; b = s; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) continue;
    }
    if (t0 < best) best = t0;
  }
  return Math.max(0, best);
}
function segPointDist2(ax, ay, bx, by, px, py) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + dx * t - px;
  const ey = ay + dy * t - py;
  return ex * ex + ey * ey;
}
// Beam path like the engine: straight segments with up to `bounces` reflections.
function beamSegments(x, y, ang) {
  let dx = Math.cos(ang);
  let dy = Math.sin(ang);
  let left = R.laser.range;
  const out = [];
  for (let bounce = 0; bounce <= R.laser.bounces && left > 1e-6; bounce++) {
    let bestT = 2;
    let axis = 'x';
    const ddx = dx * left;
    const ddy = dy * left;
    for (let i = 0; i < solids.length; i++) {
      const r = solids[i];
      let tMin = -Infinity;
      let tMax = Infinity;
      let ax = 'x';
      if (ddx === 0) {
        if (x <= r.x || x >= r.x + r.w) continue;
      } else {
        let t1 = (r.x - x) / ddx;
        let t2 = (r.x + r.w - x) / ddx;
        if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
        tMin = t1;
        tMax = t2;
      }
      if (ddy === 0) {
        if (y <= r.y || y >= r.y + r.h) continue;
      } else {
        let t1 = (r.y - y) / ddy;
        let t2 = (r.y + r.h - y) / ddy;
        if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
        if (t1 > tMin) { tMin = t1; ax = 'y'; }
        tMax = Math.min(tMax, t2);
      }
      if (tMin > tMax || tMin <= 1e-9 || tMin > 1) continue;
      if (tMin < bestT) { bestT = tMin; axis = ax; }
    }
    const t = bestT <= 1 ? bestT : 1;
    const x1 = x + ddx * t;
    const y1 = y + ddy * t;
    out.push(x, y, x1, y1);
    if (bestT > 1) break;
    left -= left * t;
    if (axis === 'x') dx = -dx;
    else dy = -dy;
    x = x1;
    y = y1;
  }
  return out;
}
// Smallest distance from (px,py) to a beam; `skipFirst` for the shooter itself.
function beamDist(segs, px, py, skipFirst) {
  let best = Infinity;
  for (let i = skipFirst ? 4 : 0; i < segs.length; i += 4) {
    const d = segPointDist2(segs[i], segs[i + 1], segs[i + 2], segs[i + 3], px, py);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

// ======================================================================= navigation grid

function buildGrid() {
  GW = Math.ceil(mapW / CS);
  GH = Math.ceil(mapH / CS);
  const n = GW * GH;
  blocked = new Uint8Array(n);
  for (let cy = 0; cy < GH; cy++) {
    for (let cx = 0; cx < GW; cx++) {
      const px = (cx + 0.5) * CS;
      const py = (cy + 0.5) * CS;
      let b = px < RAD || py < RAD || px > mapW - RAD || py > mapH - RAD;
      if (!b) {
        for (const w of walls) {
          if (pointRectDist(px, py, w) < RAD + 1) {
            b = true;
            break;
          }
        }
      }
      blocked[cy * GW + cx] = b ? 1 : 0;
    }
  }
  gdist = new Float32Array(n);
  gpar = new Int32Array(n);
  heapN = new Int32Array(8 * n + 8);
  heapK = new Float32Array(8 * n + 8);
}
function hpush(node, key) {
  let i = heapSize++;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (heapK[p] <= key) break;
    heapN[i] = heapN[p];
    heapK[i] = heapK[p];
    i = p;
  }
  heapN[i] = node;
  heapK[i] = key;
}
function hpop() {
  const node = heapN[0];
  popK = heapK[0];
  heapSize--;
  const ln = heapN[heapSize];
  const lk = heapK[heapSize];
  let i = 0;
  for (;;) {
    let c = 2 * i + 1;
    if (c >= heapSize) break;
    if (c + 1 < heapSize && heapK[c + 1] < heapK[c]) c++;
    if (heapK[c] >= lk) break;
    heapN[i] = heapN[c];
    heapK[i] = heapK[c];
    i = c;
  }
  heapN[i] = ln;
  heapK[i] = lk;
  return node;
}
function cellAt(x, y) {
  let cx = Math.floor(x / CS);
  let cy = Math.floor(y / CS);
  cx = cx < 0 ? 0 : cx >= GW ? GW - 1 : cx;
  cy = cy < 0 ? 0 : cy >= GH ? GH - 1 : cy;
  return cy * GW + cx;
}
function nearestFree(x, y) {
  const c = cellAt(x, y);
  if (!blocked[c]) return c;
  const cx = c % GW;
  const cy = (c / GW) | 0;
  for (let r = 1; r <= 6; r++) {
    let best = -1;
    let bd = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
        const nn = ny * GW + nx;
        if (blocked[nn]) continue;
        const d = ((nx + 0.5) * CS - x) ** 2 + ((ny + 0.5) * CS - y) ** 2;
        if (d < bd) {
          bd = d;
          best = nn;
        }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}
const cellX = (c) => ((c % GW) + 0.5) * CS;
const cellY = (c) => (((c / GW) | 0) + 0.5) * CS;

function dijkstra(sx, sy) {
  gdist.fill(1e9);
  gpar.fill(-1);
  const s = nearestFree(sx, sy);
  startCell = s;
  if (s < 0) return;
  gdist[s] = 0;
  heapSize = 0;
  hpush(s, 0);
  const D = CS * Math.SQRT2;
  while (heapSize > 0) {
    const u = hpop();
    const k = popK;
    if (k > gdist[u]) continue;
    const ux = u % GW;
    const uy = (u / GW) | 0;
    const l = ux > 0 && !blocked[u - 1];
    const r = ux < GW - 1 && !blocked[u + 1];
    const t = uy > 0 && !blocked[u - GW];
    const b = uy < GH - 1 && !blocked[u + GW];
    if (l && k + CS < gdist[u - 1]) { gdist[u - 1] = k + CS; gpar[u - 1] = u; hpush(u - 1, k + CS); }
    if (r && k + CS < gdist[u + 1]) { gdist[u + 1] = k + CS; gpar[u + 1] = u; hpush(u + 1, k + CS); }
    if (t && k + CS < gdist[u - GW]) { gdist[u - GW] = k + CS; gpar[u - GW] = u; hpush(u - GW, k + CS); }
    if (b && k + CS < gdist[u + GW]) { gdist[u + GW] = k + CS; gpar[u + GW] = u; hpush(u + GW, k + CS); }
    if (l && t && !blocked[u - GW - 1] && k + D < gdist[u - GW - 1]) { gdist[u - GW - 1] = k + D; gpar[u - GW - 1] = u; hpush(u - GW - 1, k + D); }
    if (r && t && !blocked[u - GW + 1] && k + D < gdist[u - GW + 1]) { gdist[u - GW + 1] = k + D; gpar[u - GW + 1] = u; hpush(u - GW + 1, k + D); }
    if (l && b && !blocked[u + GW - 1] && k + D < gdist[u + GW - 1]) { gdist[u + GW - 1] = k + D; gpar[u + GW - 1] = u; hpush(u + GW - 1, k + D); }
    if (r && b && !blocked[u + GW + 1] && k + D < gdist[u + GW + 1]) { gdist[u + GW + 1] = k + D; gpar[u + GW + 1] = u; hpush(u + GW + 1, k + D); }
  }
}
function pathLen(x, y) {
  if (walkable(me.x, me.y, x, y)) return Math.hypot(x - me.x, y - me.y);
  const c = nearestFree(x, y);
  if (c < 0 || gdist[c] >= 1e8) return Math.hypot(x - me.x, y - me.y) * 3 + 500;
  return gdist[c] + Math.hypot(cellX(c) - x, cellY(c) - y);
}
function steer(gx, gy) {
  if (walkable(me.x, me.y, gx, gy)) return norm(gx - me.x, gy - me.y);
  let c = nearestFree(gx, gy);
  if (c < 0 || startCell < 0 || gdist[c] >= 1e8) return norm(gx - me.x, gy - me.y);
  const path = [];
  while (c >= 0 && c !== startCell && path.length < 800) {
    path.push(c);
    c = gpar[c];
  }
  if (path.length === 0) return norm(gx - me.x, gy - me.y);
  let wx = null;
  let wy = 0;
  for (let i = path.length - 1, n = 0; i >= 0 && n < 50; i--, n++) {
    const px = cellX(path[i]);
    const py = cellY(path[i]);
    if (walkable(me.x, me.y, px, py)) {
      wx = px;
      wy = py;
    } else if (wx !== null) break;
  }
  if (wx === null) {
    wx = cellX(path[path.length - 1]);
    wy = cellY(path[path.length - 1]);
  }
  return norm(wx - me.x, wy - me.y);
}

// ======================================================================= zone

function zoneRadiusIn(zone, t) {
  if (zone.collapseStartsIn !== null && t >= zone.collapseStartsIn) {
    const collapseTime = zone.collapseEndsIn - zone.collapseStartsIn;
    const from = zone.collapseStartsIn > 0 ? zone.finalRadius : zone.radius;
    return collapseTime <= 0 || t >= zone.collapseEndsIn ? 0 : from * (1 - (t - zone.collapseStartsIn) / collapseTime);
  }
  const shrinkTime = zone.shrinkEndsIn - zone.shrinkStartsIn;
  if (shrinkTime <= 0) return zone.radius;
  const elapsed = Math.max(0, t - zone.shrinkStartsIn);
  return zone.radius - (zone.radius - zone.finalRadius) * Math.min(1, elapsed / shrinkTime);
}
let zoneSoonR = 1e9;
let zoneK0 = 1;
let zoneNowR = 1e9;
function zonePenalty(x, y) {
  if (!zoneOn) return 0;
  const d = Math.hypot(x - ZX, y - ZY);
  const safe = zoneSoonR - RAD - 10;
  if (d <= safe) return 0;
  let p = (d - safe) * 0.3;
  if (d > zoneNowR) p += 12;
  return p;
}

// ======================================================================= motion models

function topSpeed(w) {
  return w === 'gun' ? R.player.speedGun : w === 'launcher' ? R.player.speedLauncher : w === 'laser' ? R.player.speedLaser : R.player.speedKnife;
}
// Where a player starting at p with velocity v will be after t seconds if it steers toward
// velocity (hx, hy) with the engine's acceleration limit (walls ignored, map clamped).
function motionAt(px, py, vx, vy, hx, hy, top, t, out) {
  const A = R.player.accelTime > 0 ? top / R.player.accelTime : 1e9;
  const dvx = hx - vx;
  const dvy = hy - vy;
  const dv = Math.hypot(dvx, dvy);
  let x;
  let y;
  if (dv < 1e-6) {
    x = px + vx * t;
    y = py + vy * t;
  } else {
    const T = dv / A;
    const ax = (dvx / dv) * A;
    const ay = (dvy / dv) * A;
    if (t <= T) {
      x = px + vx * t + 0.5 * ax * t * t;
      y = py + vy * t + 0.5 * ay * t * t;
    } else {
      x = px + vx * T + 0.5 * ax * T * T + hx * (t - T);
      y = py + vy * T + 0.5 * ay * T * T + hy * (t - T);
    }
  }
  out.x = x < RAD ? RAD : x > mapW - RAD ? mapW - RAD : x;
  out.y = y < RAD ? RAD : y > mapH - RAD ? mapH - RAD : y;
  return out;
}
// Guesses of how an enemy will move next: keep going, stop, reverse, sidestep either way.
function hypotheses(e, fromX, fromY) {
  const top = topSpeed(e.weapon);
  const vx = e.visible ? e.vx : 0;
  const vy = e.visible ? e.vy : 0;
  const sp = Math.hypot(vx, vy);
  const lx = e.x - fromX;
  const ly = e.y - fromY;
  const l = Math.hypot(lx, ly) || 1;
  const px = -ly / l;
  const py = lx / l;
  const hs = [{ hx: vx, hy: vy, w: 0.4 }, { hx: 0, hy: 0, w: 0.15 }];
  if (sp > 40) hs.push({ hx: (-vx / sp) * top, hy: (-vy / sp) * top, w: 0.15 });
  else hs.push({ hx: (lx / l) * top * 0.7, hy: (ly / l) * top * 0.7, w: 0.15 });
  hs.push({ hx: px * top, hy: py * top, w: 0.15 }, { hx: -px * top, hy: -py * top, w: 0.15 });
  for (const h of hs) h.top = top;
  return hs;
}
const tmpP = { x: 0, y: 0 };

// ======================================================================= threats & planner

function blastAt(bx, by, px, py, radius, cdmg, edmg) {
  let d = Math.hypot(px - bx, py - by) - RAD;
  if (d < 0) d = 0;
  if (d > radius) return 0;
  if (!losClear(bx, by, px, py, 0)) {
    d += 45;
    if (d > radius) return 0;
  }
  return cdmg - ((cdmg - edmg) * d) / radius;
}

function buildThreats(state) {
  const T = { bullets: [], grenades: [], mines: [], lasers: [], gas: [], melee: [], watchers: [] };
  for (const b of state.bullets) {
    if (b.ownerId === selfId) continue;
    const sp = Math.hypot(b.vx, b.vy);
    if (sp < 1) continue;
    const ux = b.vx / sp;
    const uy = b.vy / sp;
    const rx = me.x - b.x;
    const ry = me.y - b.y;
    const along = rx * ux + ry * uy;
    if (along < -60 || along > sp * H * DT + 150) continue;
    if (Math.abs(rx * -uy + ry * ux) > 190) continue;
    const life = rayDist(b.x, b.y, ux, uy, b.radius, sp * H * DT + 60) / (sp * DT);
    const r = RAD + b.radius + 3;
    T.bullets.push({ x: b.x, y: b.y, vx: b.vx * DT, vy: b.vy * DT, life, r2: r * r, dmg: R.gun.damage, w: 1, k0: 0 });
  }
  // Likely next shots from armed enemies that can see us.
  for (const e of enemies) {
    if (!e.visible) continue;
    const d = dist(e, me);
    if (d > 700 || d < 30) continue;
    const toMe = Math.atan2(me.y - e.y, me.x - e.x);
    const off = Math.abs(angleDiff(toMe, e.facing));
    if (e.weapon === 'gun' && e.ammo.gun > 0) {
      const cdk = Math.round(Math.max(e.cooldowns.gun, e.cooldowns.switch) / DT);
      const turnK = Math.max(0, Math.ceil((off - 0.1) / TURN));
      const k0 = Math.max(cdk, turnK) + 1;
      if (k0 > H - 4) continue;
      if (!losClear(e.x, e.y, me.x, me.y, R.gun.bulletRadius)) continue;
      // They lead us assuming we keep our current velocity.
      const sp = R.gun.bulletSpeed;
      const ex = e.x + e.vx * DT * k0;
      const ey = e.y + e.vy * DT * k0;
      const mx = me.x + me.vx * DT * k0;
      const my = me.y + me.vy * DT * k0;
      const L = intercept(ex, ey, mx, my, me.vx, me.vy, sp);
      const ang = Math.atan2(L.y - ey, L.x - ex);
      const ux = Math.cos(ang);
      const uy = Math.sin(ang);
      const r = RAD + R.gun.bulletRadius + 3;
      const w = off < 0.5 ? 0.55 : 0.35;
      T.bullets.push({ x: ex - ux * sp * DT * k0, y: ey - uy * sp * DT * k0, vx: ux * sp * DT, vy: uy * sp * DT, life: H + 2, r2: r * r, dmg: R.gun.damage, w, k0 });
      // a follow-up shot one cooldown later
      const k1 = k0 + Math.round(R.gun.cooldown / DT);
      if (k1 < H - 3 && e.ammo.gun > 1) {
        T.bullets.push({ x: ex - ux * sp * DT * k1, y: ey - uy * sp * DT * k1, vx: ux * sp * DT, vy: uy * sp * DT, life: H + 2, r2: r * r, dmg: R.gun.damage, w: w * 0.5, k0: k1 });
      }
    } else if (e.weapon === 'launcher' && e.ammo.launcher > 0 && d > 110) {
      const cdk = Math.round(Math.max(e.cooldowns.launcher, e.cooldowns.switch) / DT);
      const turnK = Math.max(0, Math.ceil((off - 0.1) / TURN));
      const k0 = Math.max(cdk, turnK) + 1;
      if (k0 > H - 4) continue;
      if (!losClear(e.x, e.y, me.x, me.y, R.launcher.grenadeRadius)) continue;
      const sp = R.launcher.grenadeSpeed;
      const L = intercept(e.x, e.y, me.x + me.vx * DT * k0, me.y + me.vy * DT * k0, me.vx, me.vy, sp);
      const ang = Math.atan2(L.y - e.y, L.x - e.x);
      const ux = Math.cos(ang);
      const uy = Math.sin(ang);
      const travel = Math.min(R.launcher.range, rayDist(e.x, e.y, ux, uy, R.launcher.grenadeRadius, R.launcher.range));
      const r = RAD + R.launcher.grenadeRadius + 2;
      const gx = e.x - ux * sp * DT * k0;
      const gy = e.y - uy * sp * DT * k0;
      T.grenades.push({ x: gx, y: gy, vx: ux * sp * DT, vy: uy * sp * DT, life: k0 + travel / (sp * DT), r2: r * r, ex: e.x + ux * travel, ey: e.y + uy * travel, own: false, w: 0.45, k0 });
    }
  }
  for (const g of state.grenades) {
    const sp = Math.hypot(g.vx, g.vy);
    if (sp < 1) continue;
    if (Math.hypot(g.x - me.x, g.y - me.y) > 900) continue;
    const ux = g.vx / sp;
    const uy = g.vy / sp;
    const travel = Math.min(g.remainingRange, rayDist(g.x, g.y, ux, uy, g.radius, g.remainingRange));
    const r = RAD + g.radius + 3;
    T.grenades.push({
      x: g.x, y: g.y, vx: g.vx * DT, vy: g.vy * DT, life: Math.max(1, travel / (sp * DT)), r2: r * r,
      ex: g.x + ux * travel, ey: g.y + uy * travel, own: g.ownerId === selfId, w: 1, k0: 0,
    });
  }
  // Mines with chain reactions resolved.
  const ms = state.mines.map((m) => ({ x: m.x, y: m.y, t: Math.max(1, Math.round(m.fuse / DT)) }));
  ms.sort((a, b) => a.t - b.t);
  for (let it = 0; it < 3; it++) {
    for (let i = 0; i < ms.length; i++) {
      for (let j = 0; j < ms.length; j++) {
        if (ms[j].t > ms[i].t && Math.hypot(ms[i].x - ms[j].x, ms[i].y - ms[j].y) <= R.mines.blastRadius) ms[j].t = ms[i].t;
      }
    }
  }
  for (const m of ms) if (Math.hypot(m.x - me.x, m.y - me.y) < 330) T.mines.push(m);
  // Lasers charging: the beam fires from where the shooter will be.
  for (const L of state.lasers) {
    if (L.ownerId === selfId) continue;
    const o = state.players[L.ownerId];
    const kf = Math.max(1, Math.round(L.charge / DT));
    const ox = o ? o.x : L.path.length ? L.path[0].x : me.x;
    const oy = o ? o.y : L.path.length ? L.path[0].y : me.y;
    const ovx = o && o.visible ? o.vx : 0;
    const ovy = o && o.visible ? o.vy : 0;
    const segs = [];
    // possible shooter positions at fire time: keeps velocity / stops
    const t = kf * DT;
    segs.push(beamSegments(ox + ovx * Math.min(t, 0.3), oy + ovy * Math.min(t, 0.3), L.angle));
    segs.push(beamSegments(Math.min(mapW - RAD, Math.max(RAD, ox + ovx * t)), Math.min(mapH - RAD, Math.max(RAD, oy + ovy * t)), L.angle));
    T.lasers.push({ kf: Math.min(kf, H), segs, dmg: R.laser.damage });
  }
  // Enemies holding a laser that is ready and pointed near us: a charge may start soon.
  for (const c of state.clouds) {
    if (c.kind !== 'gas') continue;
    T.gas.push({ x: c.x, y: c.y, r: c.fullRadius, rNow: c.radius, next: c.nextDamageIn === null ? 1 : c.nextDamageIn, left: c.timeLeft });
  }
  for (const th of state.thrown) {
    if (th.kind !== 'gas') continue;
    const sp = Math.hypot(th.vx, th.vy);
    const s = (sp * sp) / (2 * R.throwing.deceleration);
    const ux = sp > 1e-6 ? th.vx / sp : 0;
    const uy = sp > 1e-6 ? th.vy / sp : 0;
    const dd = Math.min(s, rayDist(th.x, th.y, ux, uy, R.throwing.radius, s));
    const tStop = sp / R.throwing.deceleration;
    T.gas.push({ x: th.x + ux * dd, y: th.y + uy * dd, r: R.gas.radius, rNow: 0, next: tStop + 1, left: R.gas.duration + tStop, future: tStop });
  }
  for (const e of enemies) {
    if (e.weapon !== 'knife') continue;
    if (!e.visible && e.seenAgo > 0.6) continue;
    const d = dist(e, me);
    if (d > 260) continue;
    const ang = Math.atan2(me.y - e.y, me.x - e.x);
    const off = Math.max(0, Math.abs(angleDiff(ang, e.facing)) - (R.knife.arcDegrees * Math.PI) / 360);
    const readyK = Math.max(Math.round(Math.max(e.cooldowns.knife, e.cooldowns.switch) / DT), Math.ceil(off / TURN));
    T.melee.push({ id: e.id, x: e.x, y: e.y, close: R.player.speedKnife * DT * 0.95, reach: 2 * RAD + R.knife.reach + 6, readyK, dmg: R.knife.damage });
  }
  return T;
}

function simPath(dx, dy, top, out) {
  const acc = R.player.accelTime > 0 ? (top / R.player.accelTime) * DT : 1e9;
  let px = me.x;
  let py = me.y;
  let vx = me.vx;
  let vy = me.vy;
  const tx = dx * top;
  const ty = dy * top;
  for (let k = 0; k < H; k++) {
    let ax = tx - vx;
    let ay = ty - vy;
    const m = Math.hypot(ax, ay);
    if (m > acc) {
      ax *= acc / m;
      ay *= acc / m;
    }
    vx += ax;
    vy += ay;
    const ox = px;
    const oy = py;
    px += vx * DT;
    py += vy * DT;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < nearWalls.length; i++) {
        const w = nearWalls[i];
        const cx = px < w.x ? w.x : px > w.x + w.w ? w.x + w.w : px;
        const cy = py < w.y ? w.y : py > w.y + w.h ? w.y + w.h : py;
        let ex = px - cx;
        let ey = py - cy;
        const d2 = ex * ex + ey * ey;
        if (d2 >= RAD * RAD) continue;
        if (d2 > 1e-9) {
          const d = Math.sqrt(d2);
          px = cx + (ex / d) * RAD;
          py = cy + (ey / d) * RAD;
        } else {
          const l = px - w.x;
          const r = w.x + w.w - px;
          const t = py - w.y;
          const b = w.y + w.h - py;
          const mn = Math.min(l, r, t, b);
          if (mn === l) px = w.x - RAD;
          else if (mn === r) px = w.x + w.w + RAD;
          else if (mn === t) py = w.y - RAD;
          else py = w.y + w.h + RAD;
        }
      }
      if (px < RAD) px = RAD;
      if (px > mapW - RAD) px = mapW - RAD;
      if (py < RAD) py = RAD;
      if (py > mapH - RAD) py = mapH - RAD;
    }
    vx = (px - ox) / DT;
    vy = (py - oy) / DT;
    out[2 * k] = px;
    out[2 * k + 1] = py;
  }
}

function danger(path, ignoreMeleeId) {
  let dmg = 0;
  const invK = Math.round(me.invulnerable / DT);
  for (const b of TH.bullets) {
    const kmax = Math.min(H, Math.ceil(b.life));
    for (let k = Math.max(1, b.k0); k <= kmax; k++) {
      const px = path[2 * k - 2];
      const py = path[2 * k - 1];
      if (segPointDist2(b.x + b.vx * (k - 1), b.y + b.vy * (k - 1), b.x + b.vx * k, b.y + b.vy * k, px, py) < b.r2) {
        if (invK < k) dmg += b.dmg * b.w;
        break;
      }
    }
  }
  const G = R.launcher;
  for (const g of TH.grenades) {
    const kmax = Math.min(H, Math.ceil(g.life));
    let hit = false;
    if (!g.own) {
      for (let k = Math.max(1, g.k0); k <= kmax; k++) {
        const px = path[2 * k - 2];
        const py = path[2 * k - 1];
        const x1 = g.x + g.vx * k;
        const y1 = g.y + g.vy * k;
        if (segPointDist2(g.x + g.vx * (k - 1), g.y + g.vy * (k - 1), x1, y1, px, py) < g.r2) {
          if (invK < k) dmg += g.w * blastAt(x1, y1, px, py, G.blastRadius, G.centerDamage, G.edgeDamage);
          hit = true;
          break;
        }
      }
    }
    if (!hit) {
      const k = Math.min(H, Math.max(1, Math.ceil(g.life)));
      const w = g.life <= H ? 1 : 0.5;
      if (invK < k) dmg += g.w * w * blastAt(g.ex, g.ey, path[2 * k - 2], path[2 * k - 1], G.blastRadius + 6, G.centerDamage, G.edgeDamage);
    }
  }
  const M = R.mines;
  for (const m of TH.mines) {
    if (m.t <= H) {
      if (invK < m.t) dmg += blastAt(m.x, m.y, path[2 * m.t - 2], path[2 * m.t - 1], M.blastRadius + 6, M.centerDamage, M.edgeDamage);
    } else {
      const w = m.t <= H + 20 ? 0.8 : 0.4;
      dmg += w * blastAt(m.x, m.y, path[2 * H - 2], path[2 * H - 1], M.blastRadius + 14, M.centerDamage, M.edgeDamage);
    }
  }
  const hitR = RAD + R.laser.beamRadius;
  for (const L of TH.lasers) {
    const k = L.kf;
    const px = path[2 * k - 2];
    const py = path[2 * k - 1];
    let worst = 0;
    for (const segs of L.segs) {
      const d = beamDist(segs, px, py, false);
      const v = d < hitR + 4 ? 1 : d < hitR + 26 ? 1 - (d - hitR - 4) / 22 : 0;
      if (v > worst) worst = v;
    }
    if (invK < k) dmg += worst * L.dmg;
  }
  for (const g of TH.gas) {
    let first = Math.max(1, Math.round(g.next / DT));
    const last = Math.min(H, Math.round(g.left / DT));
    for (let k = first; k <= last; k += 30) {
      const px = path[2 * k - 2];
      const py = path[2 * k - 1];
      if (Math.hypot(px - g.x, py - g.y) < g.r + 6) dmg += R.gas.damagePerSecond;
    }
    // being in gas at the end of the horizon costs future ticks and slows us
    if (!g.future || g.future < H * DT) {
      const ex = path[2 * H - 2];
      const ey = path[2 * H - 1];
      if (Math.hypot(ex - g.x, ey - g.y) < g.r + 4 && g.left > H * DT + 0.3) dmg += 10;
    }
  }
  for (const e of TH.melee) {
    if (e.id === ignoreMeleeId) continue;
    for (let k = 1; k <= H; k++) {
      if (k <= e.readyK) continue;
      const d = Math.hypot(path[2 * k - 2] - e.x, path[2 * k - 1] - e.y) - e.close * k;
      if (d < e.reach) {
        if (invK < k) dmg += e.dmg;
        break;
      }
    }
  }
  if (zoneOn) {
    // exact zone damage on the whole-second ticks inside the horizon
    for (let k = zoneK0; k <= H; k += 30) {
      const r = zoneRadiusIn(ZONE, (k - 1) * DT);
      const dx = path[2 * k - 2] - ZX;
      const dy = path[2 * k - 1] - ZY;
      if (dx * dx + dy * dy > r * r && invK < k) dmg += R.zone.damagePerSecond;
    }
  }
  if (dmg >= me.hp + me.shield) dmg += 120;
  return dmg;
}

const CANDS = [];
for (let i = 0; i < 16; i++) CANDS.push({ x: Math.cos((i * TAU) / 16), y: Math.sin((i * TAU) / 16) });
CANDS.push({ x: 0, y: 0 });

// Laser alignment: reward paths whose beam (fired at tick kf from where we'll be) covers the target.
let aimLaser = null; // { kf, ang, e, hyps }
function laserScore(path) {
  if (!aimLaser) return 0;
  const k = aimLaser.kf;
  const px = path[2 * k - 2];
  const py = path[2 * k - 1];
  const segs = beamSegments(px, py, aimLaser.ang);
  const hitR = RAD + R.laser.beamRadius;
  let s = 0;
  for (const h of aimLaser.hyps) {
    motionAt(aimLaser.e.x, aimLaser.e.y, aimLaser.e.vx, aimLaser.e.vy, h.hx, h.hy, h.top, aimLaser.t, tmpP);
    const d = beamDist(segs, tmpP.x, tmpP.y, false);
    s += h.w * (d < hitR - 3 ? 1 : d < hitR + 30 ? Math.max(0, 1 - (d - hitR + 3) / 33) * 0.8 : 0);
  }
  // don't shoot ourselves on the bounce
  if (beamDist(segs, px, py, true) < hitR + 4) s -= 1.5;
  return s * 55;
}

let exposeList = [];
function exposure(x, y) {
  let c = 0;
  for (const w of exposeList) {
    if (Math.hypot(w.x - x, w.y - y) > w.range) continue;
    if (losClear(w.x, w.y, x, y, 2)) c += w.w;
  }
  return c;
}

function chooseMove(desired, gain, weapon, ignoreMeleeId) {
  const top = topSpeed(weapon);
  const span = top * H * DT;
  const cands = [];
  if (desired.x !== 0 || desired.y !== 0) cands.push(norm(desired.x, desired.y));
  if (lastCmd.x !== 0 || lastCmd.y !== 0) cands.push(lastCmd);
  for (let i = 0; i < CANDS.length; i++) cands.push(CANDS[i]);
  let best = null;
  let bestScore = -Infinity;
  for (let ci = 0; ci < cands.length; ci++) {
    const c = cands[ci];
    if (ci > 2 && best && clock() - T0 > 5.5) break;
    simPath(c.x, c.y, top, pathBuf);
    const ex = pathBuf[2 * H - 2];
    const ey = pathBuf[2 * H - 1];
    const mx = pathBuf[H - 2];
    const my = pathBuf[H - 1];
    const prog = ((ex - me.x) * desired.x + (ey - me.y) * desired.y) / span;
    let score = gain * prog - danger(pathBuf, ignoreMeleeId) - zonePenalty(ex, ey) - 0.5 * zonePenalty(mx, my);
    score += 0.5 * (c.x * lastCmd.x + c.y * lastCmd.y);
    if (exposeList.length) score -= exposure(ex, ey);
    if (aimLaser) score += laserScore(pathBuf);
    if (score > bestScore) {
      bestScore = score;
      best = c;
      bestPath.set(pathBuf);
    }
  }
  return best;
}

// ======================================================================= targeting

const eff = (p) => p.hp + p.shield;
const hasRanged = (p) => (p.hasGun && p.ammo.gun > 0) || (p.hasLauncher && p.ammo.launcher > 0) || (p.hasLaser && p.ammo.laser > 0);
function recently(map, id, s) {
  const t = map.get(id);
  return t !== undefined && now - t < s;
}

function intercept(sx, sy, tx, ty, vx, vy, speed) {
  const dx = tx - sx;
  const dy = ty - sy;
  const a = vx * vx + vy * vy - speed * speed;
  const b = 2 * (dx * vx + dy * vy);
  const c = dx * dx + dy * dy;
  let t;
  if (Math.abs(a) < 1e-6) t = b !== 0 ? -c / b : 0;
  else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) t = Math.sqrt(c) / speed;
    else {
      const s = Math.sqrt(disc);
      const t1 = (-b - s) / (2 * a);
      const t2 = (-b + s) / (2 * a);
      t = Math.min(t1, t2) > 0 ? Math.min(t1, t2) : Math.max(t1, t2);
    }
  }
  if (!(t > 0)) t = Math.sqrt(c) / speed;
  t = Math.min(t, 2);
  return { x: tx + vx * t, y: ty + vy * t, t };
}

// Fraction of motion guesses a bullet fired from (sx,sy) along `ang` hits.
function bulletProb(sx, sy, ang, e, hyps) {
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  const step = R.gun.bulletSpeed * DT;
  const maxD = Math.min(R.gun.range, rayDist(sx, sy, ux, uy, R.gun.bulletRadius, R.gun.range));
  const hr = RAD + R.gun.bulletRadius - 1;
  const hr2 = hr * hr;
  const n = Math.ceil(maxD / step);
  let p = 0;
  for (const h of hyps) {
    for (let j = 0; j < n; j++) {
      const a0 = step * j;
      const a1 = Math.min(maxD, step * (j + 1));
      motionAt(e.x, e.y, e.vx, e.vy, h.hx, h.hy, h.top, (j + 1) * DT, tmpP);
      if (segPointDist2(sx + ux * a0, sy + uy * a0, sx + ux * a1, sy + uy * a1, tmpP.x, tmpP.y) < hr2) {
        p += h.w;
        break;
      }
      // bullet already well past the target: stop
      if (a0 > Math.hypot(tmpP.x - sx, tmpP.y - sy) + 40) break;
    }
  }
  return p;
}

function planGun(S, target) {
  let best = null;
  let bs = -Infinity;
  for (const e of enemies) {
    if (best && clock() - T0 > 7) break;
    if (!e.visible && e.seenAgo > 0.3) continue;
    const d = Math.hypot(e.x - S.x, e.y - S.y);
    if (d > R.gun.range - 60) continue;
    if (e.invulnerable > d / R.gun.bulletSpeed + 2 * DT) continue;
    if (!losClear(S.x, S.y, e.x, e.y, R.gun.bulletRadius + 1) && d > 60) continue;
    const hyps = hypotheses(e, S.x, S.y);
    let bestA = 0;
    let bestP = -1;
    for (const h of hyps) {
      // aim at where this guess puts it
      let t = d / R.gun.bulletSpeed;
      for (let it = 0; it < 3; it++) {
        motionAt(e.x, e.y, e.vx, e.vy, h.hx, h.hy, h.top, t + DT, tmpP);
        t = Math.hypot(tmpP.x - S.x, tmpP.y - S.y) / R.gun.bulletSpeed;
      }
      const a = Math.atan2(tmpP.y - S.y, tmpP.x - S.x);
      const p = bulletProb(S.x, S.y, a, e, hyps);
      if (p > bestP) { bestP = p; bestA = a; }
    }
    let s = bestP * 100 - d * 0.05 - eff(e) * 0.08 - Math.abs(angleDiff(bestA, me.facing)) * 20;
    if (target && e.id === target.id) s += 15;
    if (s > bs) {
      bs = s;
      best = { aim: bestA, p: bestP, e, d };
    }
  }
  return best;
}

// Simulate a grenade; returns expected damage to e and the worst self damage.
function grenadeEval(S, ang, e, hyps, others) {
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  const G = R.launcher;
  const step = G.grenadeSpeed * DT;
  const maxD = Math.min(G.range, rayDist(S.x, S.y, ux, uy, G.grenadeRadius, G.range));
  const hr = RAD + G.grenadeRadius;
  const hr2 = hr * hr;
  const n = Math.ceil(maxD / step);
  let exp = 0;
  let selfWorst = 0;
  for (const h of hyps) {
    let bx = S.x + ux * maxD;
    let by = S.y + uy * maxD;
    let kHit = n;
    for (let j = 0; j < n; j++) {
      const a0 = step * j;
      const a1 = Math.min(maxD, step * (j + 1));
      const x0 = S.x + ux * a0;
      const y0 = S.y + uy * a0;
      const x1 = S.x + ux * a1;
      const y1 = S.y + uy * a1;
      motionAt(e.x, e.y, e.vx, e.vy, h.hx, h.hy, h.top, (j + 1) * DT, tmpP);
      let hit = segPointDist2(x0, y0, x1, y1, tmpP.x, tmpP.y) < hr2;
      if (!hit) {
        for (const o of others) {
          const ox = o.x + o.vx * (j + 1) * DT;
          const oy = o.y + o.vy * (j + 1) * DT;
          if (segPointDist2(x0, y0, x1, y1, ox, oy) < hr2) { hit = true; break; }
        }
      }
      if (hit) {
        // contact point ~ closest point along the step
        bx = x1;
        by = y1;
        kHit = j + 1;
        break;
      }
    }
    motionAt(e.x, e.y, e.vx, e.vy, h.hx, h.hy, h.top, kHit * DT, tmpP);
    exp += h.w * blastAt(bx, by, tmpP.x, tmpP.y, G.blastRadius, G.centerDamage, G.edgeDamage);
    // our own position then: assume we keep drifting
    const mx = S.x + me.vx * kHit * DT * 0.6;
    const my = S.y + me.vy * kHit * DT * 0.6;
    const sd = Math.hypot(bx - mx, by - my) - RAD;
    const sdmg = sd < G.blastRadius + 20 ? G.centerDamage : 0;
    if (sdmg > selfWorst) selfWorst = sdmg;
  }
  return { exp, selfWorst };
}

function planLauncher(S, target) {
  let best = null;
  let bs = 0;
  for (const e of enemies) {
    if (best && clock() - T0 > 7) break;
    if (!e.visible && e.seenAgo > 0.3) continue;
    const d = Math.hypot(e.x - S.x, e.y - S.y);
    if (d > R.launcher.range + 60 || d < 110) continue;
    if (e.invulnerable > d / R.launcher.grenadeSpeed + 3 * DT) continue;
    const hyps = hypotheses(e, S.x, S.y);
    const others = enemies.filter((o) => o !== e && o.visible && Math.hypot(o.x - S.x, o.y - S.y) < d + 60);
    const base = Math.atan2(e.y - S.y, e.x - S.x);
    const angs = [];
    for (const h of hyps) {
      let t = d / R.launcher.grenadeSpeed;
      for (let it = 0; it < 3; it++) {
        motionAt(e.x, e.y, e.vx, e.vy, h.hx, h.hy, h.top, t + DT, tmpP);
        t = Math.hypot(tmpP.x - S.x, tmpP.y - S.y) / R.launcher.grenadeSpeed;
      }
      angs.push(Math.atan2(tmpP.y - S.y, tmpP.x - S.x));
    }
    for (let k = -3; k <= 3; k++) angs.push(base + k * 0.12);
    for (const a of angs) {
      if (Math.abs(angleDiff(a, me.facing)) > 1.2) continue;
      const r = grenadeEval(S, a, e, hyps, others);
      if (r.selfWorst > 0) continue;
      let s = r.exp;
      if (target && e.id === target.id) s *= 1.15;
      s -= Math.abs(angleDiff(a, me.facing)) * 8;
      if (s > bs) {
        bs = s;
        best = { aim: a, exp: r.exp, e, d };
      }
    }
  }
  return best;
}

// Laser: probability the beam fired kf ticks from now from about S+drift covers e.
function planLaser(S, target) {
  const kf = Math.max(1, Math.round(R.laser.chargeTime / DT) - 1);
  const t = (kf + 1) * DT;
  let best = null;
  let bs = 0;
  const hitR = RAD + R.laser.beamRadius;
  for (const e of enemies) {
    if (best && clock() - T0 > 7) break;
    if (!e.visible && e.seenAgo > 0.2) continue;
    const d = Math.hypot(e.x - S.x, e.y - S.y);
    if (d > 950 || d < 70) continue;
    if (e.invulnerable > t + DT) continue;
    const hyps = hypotheses(e, S.x, S.y);
    // where we'll roughly be: slow down to half our speed
    const fx = S.x + me.vx * t * 0.5;
    const fy = S.y + me.vy * t * 0.5;
    for (const h of hyps) {
      motionAt(e.x, e.y, e.vx, e.vy, h.hx, h.hy, h.top, t, tmpP);
      const a = Math.atan2(tmpP.y - fy, tmpP.x - fx);
      if (Math.abs(angleDiff(a, me.facing)) > TURN * 3) continue;
      const segs = beamSegments(fx, fy, a);
      if (beamDist(segs, fx, fy, true) < hitR + 10) continue;
      let p = 0;
      for (const h2 of hyps) {
        motionAt(e.x, e.y, e.vx, e.vy, h2.hx, h2.hy, h2.top, t, tmpP);
        const dd = beamDist(segs, tmpP.x, tmpP.y, false);
        // we can steer the beam sideways a bit during the charge
        p += h2.w * (dd < hitR + 22 ? 1 : dd < hitR + 50 ? 0.4 : 0);
      }
      // any other enemy closer on the line takes it instead: fine, still a hit
      let s = p * 60 - d * 0.02;
      if (target && e.id === target.id) s += 6;
      if (s > bs) {
        bs = s;
        best = { aim: a, p, e, d };
      }
    }
  }
  return best;
}

function planKnife(S) {
  const reach = 2 * RAD + R.knife.reach - 2;
  let best = null;
  let bd = Infinity;
  for (const e of enemies) {
    if (!e.visible && e.seenAgo > 0.2) continue;
    if (e.invulnerable > DT) continue;
    const ex = e.x + e.vx * DT;
    const ey = e.y + e.vy * DT;
    const d = Math.hypot(ex - S.x, ey - S.y);
    if (d > reach + 30) continue;
    if (!losClear(S.x, S.y, ex, ey, 0)) continue;
    if (d < bd) {
      bd = d;
      best = { e, aim: Math.atan2(ey - S.y, ex - S.x), d };
    }
  }
  if (!best) return null;
  const diff = angleDiff(best.aim, me.facing);
  const nf = me.facing + Math.max(-TURN, Math.min(TURN, diff));
  best.inArc = best.d <= reach && Math.abs(angleDiff(best.aim, nf)) < ((R.knife.arcDegrees / 2 - 5) * Math.PI) / 180;
  return best;
}

// ======================================================================= items

function itemValue(it) {
  const hp = me.hp;
  switch (it.type) {
    case 'life': return me.lives < R.player.maxLives ? 150 : 0;
    case 'shield': return me.shield < R.player.maxShield ? Math.min(R.items.shieldAmount, R.player.maxShield - me.shield) * 1.2 + 8 : 0;
    case 'health': return hp < R.player.maxHp ? Math.min(R.items.healthAmount, R.player.maxHp - hp) * (hp < 50 ? 1.8 : 1.1) : 0;
    case 'gun':
      if (!me.hasGun) return hasAnyRanged() ? 60 : 110;
      return me.ammo.gun < R.gun.maxAmmo ? Math.min(R.gun.pickupAmmo, R.gun.maxAmmo - me.ammo.gun) * (me.ammo.gun < 8 ? 2.5 : 1) : 0;
    case 'ammo':
      if (!me.hasGun || me.ammo.gun >= R.gun.maxAmmo) return 0;
      return Math.min(R.items.ammoAmount, R.gun.maxAmmo - me.ammo.gun) * (me.ammo.gun < 8 ? 2.5 : 1);
    case 'launcher':
      if (!me.hasLauncher || me.ammo.launcher === 0) return hasAnyRanged() ? 95 : 120;
      return me.ammo.launcher < R.launcher.maxAmmo ? Math.min(R.launcher.pickupAmmo, R.launcher.maxAmmo - me.ammo.launcher) * 18 : 0;
    case 'laser':
      if (!me.hasLaser || me.ammo.laser === 0) return hasAnyRanged() ? 80 : 110;
      return me.ammo.laser < R.laser.maxAmmo ? Math.min(R.laser.pickupAmmo, R.laser.maxAmmo - me.ammo.laser) * 15 : 0;
    case 'mines': return me.mines < R.mines.maxCarry ? 16 : 0;
    case 'gas': return me.gasGrenades < R.gas.maxCarry ? 6 : 0;
    case 'smoke': return me.smokeGrenades < R.smoke.maxCarry ? 3 : 0;
    default: return 0;
  }
}
function hasAnyRanged() {
  return hasRanged(me);
}

function bestItem(state, top, filter) {
  let best = null;
  let bestU = 0;
  for (const it of state.items) {
    if (filter && !filter(it)) continue;
    let v = itemValue(it);
    if (v <= 0) continue;
    const pl = pathLen(it.x, it.y);
    const t = pl / top;
    if (zoneOn && Math.hypot(it.x - ZX, it.y - ZY) > zoneRadiusIn(ZONE, t + 0.5) - RAD - 8) continue;
    if (state.mines.some((m) => Math.hypot(m.x - it.x, m.y - it.y) < R.mines.blastRadius + RAD + 10 && m.fuse < t + 0.8)) continue;
    let bad = false;
    for (const c of state.clouds) if (c.kind === 'gas' && c.timeLeft > t && Math.hypot(c.x - it.x, c.y - it.y) < c.fullRadius) bad = true;
    if (bad) v *= 0.4;
    const myD = pl;
    for (const e of enemies) {
      if (!e.visible) continue;
      const ed = Math.hypot(it.x - e.x, it.y - e.y);
      if (ed < myD * 0.7 && ed < 280) {
        v *= 0.3;
        break;
      }
      if (hasRanged(e) && ed < 170 && me.invulnerable <= 0) v *= 0.75;
    }
    let u = v / (1 + t * 1.0);
    if (it.id === itemTargetId) u *= 1.25;
    if (u > bestU) {
      bestU = u;
      best = it;
    }
  }
  return best ? { item: best, u: bestU } : null;
}

function pickTarget() {
  let best = null;
  let bs = Infinity;
  for (const e of enemies) {
    if (!e.visible && e.seenAgo > 3) continue;
    let s = pathLen(e.x, e.y) + eff(e) * 2.0;
    if (!e.visible) s += 250 + e.seenAgo * 100;
    if (e.invulnerable > 0.4) s += 300;
    if (recently(lastHurtBy, e.id, 3)) s -= 160;
    if (recently(lastBusy, e.id, 1.5)) s -= 90;
    if (!hasRanged(e)) s -= 40;
    if (e.lives === 1) s -= 40;
    if (e.id === targetId) s -= 110;
    if (!losClear(me.x, me.y, e.x, e.y, R.gun.bulletRadius)) s += 110;
    if (s < bs) {
      bs = s;
      best = e;
    }
  }
  return best;
}

// ======================================================================= decide

export function decide(state) {
  T0 = clock();
  me = state.self;
  now = state.time;
  if (!me.alive) {
    lastPos = null;
    aimLaser = null;
    laserTargetId = -1;
    return null;
  }
  const zone = state.zone;
  ZONE = zone;
  zoneOn = zone.damagePerSecond > 0;
  ZX = zone.x;
  ZY = zone.y;
  zoneSoonR = zoneRadiusIn(zone, H * DT + 1.2);
  zoneNowR = zoneRadiusIn(zone, H * DT);
  zoneK0 = 1 + ((30 - (state.tick % 30)) % 30);

  for (const ev of state.events) {
    if (ev.type !== 'hit' || ev.weapon === 'zone') continue;
    if (ev.targetId === selfId && ev.attackerId !== selfId) lastHurtBy.set(ev.attackerId, now);
    else if (ev.attackerId !== ev.targetId && ev.attackerId !== selfId) lastBusy.set(ev.targetId, now);
  }

  _tp = []; _mark('start');
  enemies = [];
  for (const p of state.players) if (p.id !== selfId && p.alive) enemies.push(p);
  const reachW = topSpeed('knife') * H * DT + 60;
  nearWalls = walls.filter((w) => pointRectDist(me.x, me.y, w) < reachW);
  dijkstra(me.x, me.y);
  _mark('dij');
  TH = buildThreats(state);
  _mark('threats');

  const target = pickTarget();
  targetId = target ? target.id : -1;
  const tDist = target ? dist(target, me) : Infinity;
  const tVis = target && (target.visible || target.seenAgo < 0.3);
  const tLos = target ? losClear(me.x, me.y, target.x, target.y, 3) : false;

  // ----- weapon choice
  const own = {
    gun: me.hasGun && me.ammo.gun > 0,
    launcher: me.hasLauncher && me.ammo.launcher > 0,
    laser: me.hasLaser && (me.ammo.laser > 0 || me.laserCharge > 0),
  };
  let weapon = 'knife';
  const charging = me.laserCharge > 0;
  if (charging) weapon = 'laser';
  else if (own.gun || own.launcher || own.laser) {
    const sc = { knife: -50, gun: -1e9, launcher: -1e9, laser: -1e9 };
    const d = tVis ? tDist : 500;
    const slow = target && Math.hypot(target.vx, target.vy) < 60;
    if (own.gun) sc.gun = 70 + (d < 550 ? 0 : -25) + (me.ammo.gun < 4 ? -10 : 0);
    if (own.launcher) {
      sc.launcher = (d > 150 && d < 600 ? 95 : 20) + (slow ? 20 : 0) - 55 * Math.max(0, me.cooldowns.launcher - 0.3);
    }
    if (own.laser) {
      sc.laser = (d > 110 && d < 900 ? 92 : 25) - 60 * Math.max(0, me.cooldowns.laser - 0.3);
    }
    if (sc[me.weapon] !== undefined) sc[me.weapon] += 16;
    let bw = 'knife';
    for (const w of ['gun', 'launcher', 'laser']) if (sc[w] > sc[bw]) bw = w;
    weapon = bw;
    // Don't start a switch with an enemy in our face while the current weapon still works.
    const cur = me.weapon;
    if (weapon !== cur && cur !== 'knife' && own[cur] && tVis && tDist < 120 && !(cur === 'launcher')) weapon = cur;
    // Roaming with nobody around: the knife is fastest.
    if (!tVis || (!tLos && tDist > 650)) {
      const anyNear = enemies.some((e) => (e.visible || e.seenAgo < 1) && dist(e, me) < 650);
      if (!anyNear && me.weapon === 'knife') weapon = 'knife';
    }
  }
  prevWeapon = weapon;
  const top = topSpeed(weapon);
  const ranged = weapon !== 'knife' || own.gun || own.launcher || own.laser;

  // ----- goal
  let desired = { x: 0, y: 0 };
  let gain = 12;
  let meleeId = -1;
  const myEff = eff(me);
  const armedSeen = enemies.filter((e) => (e.visible || e.seenAgo < 0.5) && hasRanged(e));
  const threats = armedSeen.filter((e) => dist(e, me) < 520 && losClear(e.x, e.y, me.x, me.y, 4));
  const outside = zoneOn && dist(me, zone) > zoneRadiusIn(zone, 2.5) - RAD - 20;
  const lead = state.timeLeft !== null && state.timeLeft < 20 && enemies.every((e) => e.lives < me.lives || (e.lives === me.lives && eff(e) + 30 < myEff));

  let retreat = false;
  if (me.invulnerable <= 0.2) {
    if (myEff <= 40 && threats.some((e) => eff(e) > myEff + 10)) retreat = true;
    if (threats.length >= 2 && myEff < 80) retreat = true;
    if (!ranged && threats.length >= 1 && !(target && tDist < 110)) retreat = true;
    if (lead && threats.length >= 1) retreat = true;
  }

  // exposure: extra armed enemies with a line on us (not the one we fight)
  exposeList = [];
  for (const e of armedSeen) {
    if (target && e.id === target.id && !retreat) continue;
    exposeList.push({ x: e.x, y: e.y, range: 650, w: retreat ? 10 : 5 });
  }

  const itemPick = bestItem(state, top, null);
  itemTargetId = -1;
  const goItem = (it) => {
    itemTargetId = it.id;
    desired = steer(it.x, it.y);
  };

  if (outside) {
    desired = steer(zone.x, zone.y);
    gain = 30;
  } else if (!ranged) {
    let prey = null;
    for (const e of enemies) {
      if (!e.visible) continue;
      const d = dist(e, me);
      const ok =
        d < 110 ||
        (me.invulnerable > 0.5 && d < 230) ||
        (d < 380 && eff(e) <= R.knife.damage + 2 && e.invulnerable <= 0.2) ||
        (d < 300 && !hasRanged(e) && eff(e) + 25 < myEff && e.invulnerable <= 0.2);
      if (ok && (!prey || d < dist(prey, me))) prey = e;
    }
    const weaponItem = bestItem(state, top, (it) => it.type === 'gun' || it.type === 'launcher' || it.type === 'laser');
    if (prey && !(weaponItem && weaponItem.u > 40 && dist(prey, me) > 90)) {
      const pd = dist(prey, me);
      const theirCd = prey.weapon === 'knife' ? Math.max(prey.cooldowns.knife, prey.cooldowns.switch) : 9;
      const myCd = Math.max(me.cooldowns.knife, me.cooldowns.switch);
      const outReach = 2 * RAD + R.knife.reach + 22;
      if (me.invulnerable <= myCd && myCd > theirCd + 0.04 && pd < outReach + 40) {
        const away = norm(me.x - prey.x, me.y - prey.y);
        desired = pd < outReach ? away : { x: -away.y, y: away.x };
        gain = 6;
      } else {
        meleeId = prey.id;
        const lt = Math.min(0.25, pd / 400);
        desired = steer(prey.x + prey.vx * lt, prey.y + prey.vy * lt);
        gain = 18;
      }
    } else if (weaponItem && weaponItem.u > 8) goItem(weaponItem.item);
    else if (itemPick) goItem(itemPick.item);
    else {
      const away = fleeVector(threats.length ? threats : armedSeen.filter((e) => dist(e, me) < 350));
      const toC = norm(zone.x - me.x, zone.y - me.y);
      const edge = zoneOn ? Math.max(0, 1 - (zoneRadiusIn(zone, 3) - dist(me, zone)) / 250) : 0;
      desired = norm(away.x * 2 + toC.x * (0.4 + edge * 4), away.y * 2 + toC.y * (0.4 + edge * 4));
      if (away.x === 0 && away.y === 0 && dist(me, zone) > 150) desired = steer(zone.x, zone.y);
    }
  } else if (retreat) {
    const heal = bestItem(state, top, (it) => it.type === 'health' || it.type === 'shield' || it.type === 'life');
    if (heal && heal.u > 8 && !threats.some((e) => Math.hypot(e.x - heal.item.x, e.y - heal.item.y) < 150)) goItem(heal.item);
    else {
      const away = fleeVector(threats);
      const toC = norm(zone.x - me.x, zone.y - me.y);
      const edge = zoneOn ? Math.max(0, 1 - (zoneRadiusIn(zone, 3) - dist(me, zone)) / 250) : 0;
      desired = norm(away.x + toC.x * (0.3 + edge * 2), away.y + toC.y * (0.3 + edge * 2));
    }
    gain = 16;
  } else if (target) {
    const itemFirst = itemPick && (itemPick.u > 30 || (itemPick.u > 12 && tDist > 450));
    if (itemFirst) goItem(itemPick.item);
    else if (!tLos || !tVis) {
      desired = steer(target.x, target.y);
      gain = 14;
    } else {
      let lo = 200;
      let hi = 320;
      if (weapon === 'launcher') { lo = 200; hi = 380; }
      if (weapon === 'laser') { lo = 220; hi = 420; }
      if (target.weapon === 'knife') { lo = Math.max(lo, 240); hi = Math.max(hi, 380); }
      if (eff(target) < 45 && target.weapon !== 'knife' && weapon === 'gun') { lo = 140; hi = 260; }
      const d = tDist;
      const toward = norm(target.x - me.x, target.y - me.y);
      const radial = d > hi ? Math.min(1, (d - hi) / 80) : d < lo ? -Math.min(1, (lo - d) / 80) : 0;
      if (now >= strafeFlipAt) {
        strafeSign = Math.random() < 0.5 ? -1 : 1;
        strafeFlipAt = now + 0.4 + Math.random() * 0.8;
      }
      if (Math.hypot(me.vx, me.vy) < 30 && lastCmd.x * lastCmd.x + lastCmd.y * lastCmd.y > 0.25) strafeSign = -strafeSign;
      const strafe = { x: -toward.y * strafeSign, y: toward.x * strafeSign };
      desired = norm(toward.x * radial * 1.2 + strafe.x, toward.y * radial * 1.2 + strafe.y);
      if (itemPick && itemPick.u > 8 && dist(itemPick.item, me) < 140 && walkable(me.x, me.y, itemPick.item.x, itemPick.item.y)) {
        const di = norm(itemPick.item.x - me.x, itemPick.item.y - me.y);
        desired = norm(desired.x * 0.5 + di.x, desired.y * 0.5 + di.y);
        itemTargetId = itemPick.item.id;
      }
      gain = 10;
    }
  } else if (itemPick) goItem(itemPick.item);
  else if (zoneOn && dist(me, zone) > 120) desired = steer(zone.x, zone.y);

  // ----- stuck recovery
  if (lastPos && lastCmd.x * lastCmd.x + lastCmd.y * lastCmd.y > 0.5 && Math.hypot(me.x - lastPos.x, me.y - lastPos.y) < 1.2) stuckTicks++;
  else stuckTicks = Math.max(0, stuckTicks - 1);
  if (stuckTicks > 10) {
    stuckTicks = 0;
    const a = Math.random() * TAU;
    unstickDir = { x: Math.cos(a), y: Math.sin(a) };
    unstickUntil = now + 0.4;
  }
  if (now < unstickUntil) desired = norm(desired.x * 0.3 + unstickDir.x, desired.y * 0.3 + unstickDir.y);

  // ----- laser alignment while charging
  aimLaser = null;
  if (charging) {
    const lt = state.players[laserTargetId];
    const L = state.lasers.find((l) => l.ownerId === selfId);
    if (lt && lt.alive && L) {
      const kf = Math.max(1, Math.min(H, Math.round(me.laserCharge / DT)));
      aimLaser = { kf, ang: L.angle, e: lt, t: kf * DT, hyps: hypotheses(lt, me.x, me.y) };
      gain = Math.min(gain, 6);
    }
  }

  _mark('brain');
  const move = chooseMove(desired, gain, weapon, meleeId);
  _mark('move');
  lastCmd = move;
  lastPos = { x: me.x, y: me.y };
  const S = { x: bestPath[0], y: bestPath[1] };

  // ----- aim & attack
  let aim;
  let attack = false;
  const canAct = me.cooldowns.switch <= 0 && me.weapon === weapon;
  const holdFire = me.invulnerable > 0.3 && !threats.some((e) => dist(e, me) < 300);
  if (weapon === 'gun') {
    const shot = planGun(S, target);
    if (shot) {
      aim = shot.aim;
      const minP = me.ammo.gun > 25 ? 0.3 : me.ammo.gun > 10 ? 0.4 : 0.5;
      attack = canAct && me.cooldowns.gun <= 0 && Math.abs(angleDiff(aim, me.facing)) <= TURN * 0.98 && shot.p >= minP && !holdFire;
    } else if (target) {
      aim = Math.atan2(target.y - me.y, target.x - me.x);
    }
  } else if (weapon === 'launcher') {
    const shot = planLauncher(S, target);
    if (shot) {
      aim = shot.aim;
      attack = canAct && me.cooldowns.launcher <= 0 && Math.abs(angleDiff(aim, me.facing)) <= TURN * 0.98 && shot.exp >= 45 && !holdFire;
    } else if (target) aim = Math.atan2(target.y - me.y, target.x - me.x);
  } else if (weapon === 'laser') {
    if (!charging) {
      const shot = planLaser(S, target);
      if (shot) {
        aim = shot.aim;
        const ok = canAct && me.cooldowns.laser <= 0 && Math.abs(angleDiff(aim, me.facing)) <= TURN * 0.98 && shot.p >= 0.55 && !holdFire;
        if (ok) {
          attack = true;
          laserTargetId = shot.e.id;
        }
      } else if (target) {
        const L = intercept(me.x, me.y, target.x, target.y, target.vx * 0.5, target.vy * 0.5, 1200);
        aim = Math.atan2(L.y - me.y, L.x - me.x);
      }
    }
  } else {
    const k = planKnife(S);
    if (k) {
      aim = k.aim;
      attack = canAct && me.cooldowns.knife <= 0 && k.inArc;
    } else {
      let near = null;
      for (const e of enemies) if (e.visible && (!near || dist(e, me) < dist(near, me))) near = e;
      if (near && dist(near, me) < 220) aim = Math.atan2(near.y - me.y, near.x - me.x);
      else if (move.x || move.y) aim = Math.atan2(move.y, move.x);
    }
  }

  _mark('aim:' + weapon);
  if (DEBUG) { const tot = _tp[_tp.length - 1] - _tp[1]; if (tot > 4) { let s = 'slow ' + Math.round(tot) + 'ms:'; for (let i = 2; i < _tp.length; i += 2) s += ' ' + _tp[i] + '=' + Math.round(_tp[i + 1] - _tp[i - 1]); console.warn(s); } }
  // ----- mines: drop one on a close chaser while we move away from it
  let plantMine = false;
  if (me.mines > 0 && me.cooldowns.mine <= 0 && me.invulnerable <= 0) {
    for (const e of enemies) {
      if (!e.visible) continue;
      const d = dist(e, me);
      if (d > 130 || d < 30) continue;
      const closing = -((e.vx - me.vx) * (e.x - me.x) + (e.vy - me.vy) * (e.y - me.y)) / d;
      const awayFromIt = move.x * (me.x - e.x) + move.y * (me.y - e.y) > 0;
      if ((closing > 50 || e.weapon === 'knife') && awayFromIt && !state.mines.some((m) => dist(m, me) < 110)) {
        plantMine = true;
        break;
      }
    }
  }

  // ----- gas: late game, into a target that has little room to run
  let thr = null;
  let thrDist = 0;
  if (me.gasGrenades > 0 && me.cooldowns.throw <= 0 && target && tVis && !charging) {
    const zr = zoneOn ? zoneRadiusIn(zone, 1.5) : 1e9;
    const d = tDist;
    if (zr < 320 && d > 150 && d < R.throwing.maxDistance && losClear(me.x, me.y, target.x, target.y, 6)) {
      const tp = { x: target.x + target.vx * 0.6, y: target.y + target.vy * 0.6 };
      const a = Math.atan2(tp.y - me.y, tp.x - me.x);
      if (Math.abs(angleDiff(a, me.facing)) < 0.15 && !attack) {
        thr = 'gas';
        thrDist = Math.min(R.throwing.maxDistance, Math.hypot(tp.x - me.x, tp.y - me.y));
      }
    }
  }

  const out = { move: { x: move.x, y: move.y }, weapon, attack, plantMine };
  if (thr) {
    out.throw = thr;
    out.throwDistance = thrDist;
  }
  if (aim !== undefined && Number.isFinite(aim)) out.aim = aim;
  return out;
}

function fleeVector(list) {
  let x = 0;
  let y = 0;
  for (const e of list) {
    const d = Math.max(30, dist(e, me));
    x += (me.x - e.x) / (d * d);
    y += (me.y - e.y) / (d * d);
  }
  return norm(x, y);
}