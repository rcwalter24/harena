// Apex — a Harena bot.
//
// Brain:   picks a goal each tick (engage / loot / retreat / melee / roam) from the whole state.
// Legs:    grid Dijkstra from our position (paths around walls + real path distances to items),
//          then a short-horizon planner simulates ~17 candidate moves WITH inertia and wall sliding
//          over the next 0.6 s and scores them against every known threat (bullets, grenades,
//          mine fuses incl. chain reactions, knife rushers, likely next shots, the shrinking zone).
// Trigger: exact projectile intercept (accounts for tick order), fires only when the turn this
//          tick lands on target, ignores invulnerable targets, never grenades itself.
export const meta = { name: 'Opus 5.5', author: 'Claude' };

const H = 18; // look-ahead ticks for the movement planner (0.6 s)
const CS = 16; // navigation grid cell size (u)
const TAU = Math.PI * 2;

let R = null;
let DT = 1 / 30;
let TURN = 0.314;
let RAD = 16;
let selfId = -1;
let walls = [];
let mapW = 0;
let mapH = 0;

// navigation grid
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

// per-tick
let me = null;
let now = 0;
let nearWalls = [];
let TH = null;
const pathBuf = new Float64Array(2 * H);

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
let prevWeaponChoice = 'knife';
const lastHurtBy = new Map(); // attacker id -> time they last damaged us
const lastBusy = new Map(); // player id -> time someone else last damaged them

export function init(info) {
  R = info.rules;
  selfId = info.selfId;
  DT = 1 / (R.tickRate || 30);
  TURN = ((R.player.turnRateDegrees * Math.PI) / 180) * DT;
  RAD = R.player.radius;
  walls = info.map.walls;
  mapW = info.map.width;
  mapH = info.map.height;
  buildGrid();
  warmup(info);
}

// Run decide() on synthetic states so the JIT has compiled the hot paths before tick 0
// (a cold first decide can blow the 10 ms budget). Module memory is reset afterwards.
function warmup(info) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const sp = info.map.spawns.length ? info.map.spawns : [{ x: mapW / 2, y: mapH / 2 }];
  const mk = (id, x, y, w) => ({
    id, name: 'w', visible: true, seenAgo: 0, x, y, vx: 60, vy: -40, facing: 0.5, hp: 70, shield: 20, lives: 3,
    alive: true, eliminated: false, respawnIn: 0, hideLeft: 5, invulnerable: 0, weapon: w,
    hasGun: w === 'gun', hasLauncher: w === 'launcher', ammo: { gun: w === 'gun' ? 12 : 0, launcher: w === 'launcher' ? 3 : 0 },
    mines: 1, cooldowns: { knife: 0, gun: 0, launcher: 0, mine: 0, switch: 0 },
  });
  const zone = (t) => ({ x: mapW / 2, y: mapH / 2, radius: 900, finalRadius: 200, shrinkStartsIn: Math.max(0, 45 - t), shrinkEndsIn: Math.max(0, 150 - t), collapseStartsIn: Math.max(0, 165 - t), collapseEndsIn: Math.max(0, 180 - t), damagePerSecond: 10 });
  const weapons = ['knife', 'gun', 'launcher'];
  for (let i = 0; i < 90; i++) {
    if (clock() - t0 > 450) break;
    const a = sp[i % sp.length];
    const b = sp[(i + 3) % sp.length];
    const w = weapons[i % 3];
    const self = mk(selfId, a.x, a.y, w);
    const e1 = mk(selfId === 0 ? 1 : 0, a.x + 60 + (i % 5) * 40, a.y + 30, weapons[(i + 1) % 3]);
    const e2 = mk(selfId === 2 ? 3 : 2, b.x, b.y, 'gun');
    e2.visible = i % 4 !== 0;
    const players = [self, e1, e2];
    const st = {
      tick: 0, time: (i * 2) % 170, timeLeft: 100, self, players,
      bullets: [{ id: 1, ownerId: e2.id, x: a.x + 150, y: a.y, vx: -480, vy: 0, radius: 4 }],
      grenades: [{ id: 2, ownerId: e1.id, x: a.x + 200, y: a.y + 40, vx: -360, vy: 0, radius: 6, remainingRange: 500 }],
      mines: [{ id: 3, ownerId: e1.id, x: a.x + 40, y: a.y - 30, fuse: 1.2 }],
      explosions: [], events: [{ type: 'hit', attackerId: e1.id, targetId: selfId, weapon: 'gun', damage: 20 }],
      items: [{ id: 4, type: 'gun', x: b.x, y: a.y }, { id: 5, type: 'health', x: a.x - 90, y: a.y + 50 }, { id: 6, type: 'ammo', x: mapW / 2, y: mapH / 2 }],
      zone: zone((i * 2) % 170),
    };
    try {
      decide(st);
    } catch (e) {
      break;
    }
  }
  strafeSign = 1; strafeFlipAt = 0; targetId = -1; itemTargetId = -1; stuckTicks = 0; unstickUntil = -1;
  lastPos = null; lastCmd = { x: 0, y: 0 }; prevWeaponChoice = 'knife';
  lastHurtBy.clear(); lastBusy.clear();
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
    if (a > b) [a, b] = [b, a];
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return false;
  }
  if (dy === 0) {
    if (y0 < ly || y0 > hy) return false;
  } else {
    let a = (ly - y0) / dy;
    let b = (hy - y0) / dy;
    if (a > b) [a, b] = [b, a];
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
// Distance along unit ray (ux,uy) before a circle of radius `pad` touches a wall or the border.
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
      if (a > b) [a, b] = [b, a];
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) continue;
    }
    if (Math.abs(uy) < 1e-9) {
      if (y < ly || y > hy) continue;
    } else {
      let a = (ly - y) / uy;
      let b = (hy - y) / uy;
      if (a > b) [a, b] = [b, a];
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

// Earliest time t >= 0 at which a projectile of `speed` leaving (sx,sy) meets a target at
// (tx,ty) moving with (vx,vy).
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

// ======================================================================= navigation grid

function buildGrid() {
  GW = Math.ceil(mapW / CS);
  GH = Math.ceil(mapH / CS);
  const n = GW * GH;
  blocked = new Uint8Array(n);
  const clr = RAD;
  for (let cy = 0; cy < GH; cy++) {
    for (let cx = 0; cx < GW; cx++) {
      const px = (cx + 0.5) * CS;
      const py = (cy + 0.5) * CS;
      let b = px < clr || py < clr || px > mapW - clr || py > mapH - clr;
      if (!b) {
        for (const w of walls) {
          if (pointRectDist(px, py, w) < clr) {
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
// Walking distance from us to (x, y).
function pathLen(x, y) {
  if (walkable(me.x, me.y, x, y)) return Math.hypot(x - me.x, y - me.y);
  const c = nearestFree(x, y);
  if (c < 0 || gdist[c] >= 1e8) return Math.hypot(x - me.x, y - me.y) * 3 + 500;
  return gdist[c] + Math.hypot(cellX(c) - x, cellY(c) - y);
}
// Unit direction to walk toward (gx, gy), going around walls.
function steer(gx, gy) {
  if (walkable(me.x, me.y, gx, gy)) return norm(gx - me.x, gy - me.y);
  let c = nearestFree(gx, gy);
  if (c < 0 || startCell < 0 || gdist[c] >= 1e8) return norm(gx - me.x, gy - me.y);
  const path = [];
  while (c >= 0 && c !== startCell && path.length < 600) {
    path.push(c);
    c = gpar[c];
  }
  if (path.length === 0) return norm(gx - me.x, gy - me.y);
  let wx = null;
  let wy = 0;
  for (let i = path.length - 1, n = 0; i >= 0 && n < 60; i--, n++) {
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
let zoneOn = true;
let zoneSoonR = 1e9; // radius ~1.6 s from now
let zoneNowR = 1e9;
function zonePenalty(x, y) {
  if (!zoneOn) return 0;
  const d = Math.hypot(x - ZX, y - ZY);
  const safe = zoneSoonR - RAD - 12;
  if (d <= safe) return 0;
  let p = (d - safe) * 0.25;
  if (d > zoneNowR) p += 14;
  return p;
}
let ZX = 0;
let ZY = 0;

// ======================================================================= threats & motion planner

function topSpeed(w) {
  return w === 'gun' ? R.player.speedGun : w === 'launcher' ? R.player.speedLauncher : R.player.speedKnife;
}

function blastDmg(bx, by, px, py, radius, cdmg, edmg) {
  const d = Math.max(0, Math.hypot(px - bx, py - by) - RAD);
  if (d > radius) return 0;
  if (!losClear(bx, by, px, py, 0)) return 0;
  return cdmg - ((cdmg - edmg) * d) / radius;
}

function buildThreats(state, enemies) {
  const T = { bullets: [], grenades: [], mines: [], melee: [] };
  const reach = 520;
  for (const b of state.bullets) {
    if (b.ownerId === selfId) continue;
    const sp = Math.hypot(b.vx, b.vy);
    if (sp < 1) continue;
    const ux = b.vx / sp;
    const uy = b.vy / sp;
    const rx = me.x - b.x;
    const ry = me.y - b.y;
    const along = rx * ux + ry * uy;
    if (along < -60 || along > sp * H * DT + 120) continue;
    if (Math.abs(rx * -uy + ry * ux) > 160) continue;
    const life = rayDist(b.x, b.y, ux, uy, b.radius, sp * H * DT + 60) / (sp * DT);
    const r = RAD + b.radius + 4;
    T.bullets.push({ x: b.x, y: b.y, vx: b.vx * DT, vy: b.vy * DT, life, r2: r * r, dmg: R.gun.damage, w: 1 });
  }
  // Likely next shots: an armed enemy that is ready and roughly facing us.
  for (const e of enemies) {
    if (!e.visible) continue;
    const d = dist(e, me);
    if (d > 650 || d < 40) continue;
    const ang = Math.atan2(me.y - e.y, me.x - e.x);
    if (Math.abs(angleDiff(ang, e.facing)) > 0.45) continue;
    if (e.weapon === 'gun' && e.ammo.gun > 0 && e.cooldowns.gun <= 0.12 && e.cooldowns.switch <= 0.12) {
      if (!losClear(e.x, e.y, me.x, me.y, R.gun.bulletRadius)) continue;
      const sp = R.gun.bulletSpeed * DT;
      const ux = Math.cos(e.facing);
      const uy = Math.sin(e.facing);
      const r = RAD + R.gun.bulletRadius + 4;
      T.bullets.push({ x: e.x + e.vx * DT, y: e.y + e.vy * DT, vx: ux * sp, vy: uy * sp, life: H + 1 - 1, r2: r * r, dmg: R.gun.damage, w: 0.35 });
    }
  }
  for (const g of state.grenades) {
    if (g.ownerId === selfId && false) continue; // our own grenades can hurt us too
    const sp = Math.hypot(g.vx, g.vy);
    if (sp < 1) continue;
    if (Math.hypot(g.x - me.x, g.y - me.y) > reach + 200) continue;
    const ux = g.vx / sp;
    const uy = g.vy / sp;
    const travel = Math.min(g.remainingRange, rayDist(g.x, g.y, ux, uy, g.radius, g.remainingRange));
    const life = Math.max(1, travel / (sp * DT));
    const r = RAD + g.radius + 3;
    T.grenades.push({
      x: g.x, y: g.y, vx: g.vx * DT, vy: g.vy * DT, life, r2: r * r,
      ex: g.x + ux * travel, ey: g.y + uy * travel, own: g.ownerId === selfId,
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
  for (const m of ms) if (Math.hypot(m.x - me.x, m.y - me.y) < 300) T.mines.push(m);
  for (const e of enemies) {
    if (e.weapon !== 'knife') continue;
    if (!e.visible && e.seenAgo > 0.6) continue;
    const d = dist(e, me);
    if (d > 230) continue;
    const ang = Math.atan2(me.y - e.y, me.x - e.x);
    const off = Math.max(0, Math.abs(angleDiff(ang, e.facing)) - (R.knife.arcDegrees * Math.PI) / 360);
    const readyK = Math.max(Math.round(Math.max(e.cooldowns.knife, e.cooldowns.switch) / DT), Math.ceil(off / TURN));
    T.melee.push({
      id: e.id, x: e.x, y: e.y,
      close: R.player.speedKnife * DT * 0.9,
      reach: 2 * RAD + R.knife.reach + 5,
      readyK,
      dmg: R.knife.damage * 0.8,
    });
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
    px += vx * DT;
    py += vy * DT;
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
        ex /= d;
        ey /= d;
        px = cx + ex * RAD;
        py = cy + ey * RAD;
      } else {
        const l = px - w.x;
        const r = w.x + w.w - px;
        const t = py - w.y;
        const b = w.y + w.h - py;
        const mn = Math.min(l, r, t, b);
        if (mn === l) { px = w.x - RAD; ex = -1; ey = 0; } else if (mn === r) { px = w.x + w.w + RAD; ex = 1; ey = 0; } else if (mn === t) { py = w.y - RAD; ex = 0; ey = -1; } else { py = w.y + w.h + RAD; ex = 0; ey = 1; }
      }
      const vn = vx * ex + vy * ey;
      if (vn < 0) {
        vx -= vn * ex;
        vy -= vn * ey;
      }
    }
    if (px < RAD) { px = RAD; if (vx < 0) vx = 0; }
    if (px > mapW - RAD) { px = mapW - RAD; if (vx > 0) vx = 0; }
    if (py < RAD) { py = RAD; if (vy < 0) vy = 0; }
    if (py > mapH - RAD) { py = mapH - RAD; if (vy > 0) vy = 0; }
    out[2 * k] = px;
    out[2 * k + 1] = py;
  }
}

function danger(path, ignoreMeleeId) {
  let dmg = 0;
  const inv = me.invulnerable;
  for (const b of TH.bullets) {
    const kmax = Math.min(H, Math.ceil(b.life));
    for (let k = 1; k <= kmax; k++) {
      const px = path[2 * k - 2];
      const py = path[2 * k - 1];
      if (segPointDist2(b.x + b.vx * (k - 1), b.y + b.vy * (k - 1), b.x + b.vx * k, b.y + b.vy * k, px, py) < b.r2) {
        if (inv < k * DT) dmg += b.dmg * b.w;
        break;
      }
    }
  }
  const G = R.launcher;
  for (const g of TH.grenades) {
    const kmax = Math.min(H, Math.ceil(g.life));
    let hit = false;
    if (!g.own) {
      for (let k = 1; k <= kmax; k++) {
        const px = path[2 * k - 2];
        const py = path[2 * k - 1];
        const x1 = g.x + g.vx * k;
        const y1 = g.y + g.vy * k;
        if (segPointDist2(g.x + g.vx * (k - 1), g.y + g.vy * (k - 1), x1, y1, px, py) < g.r2) {
          if (inv < k * DT) dmg += blastDmg(x1, y1, px, py, G.blastRadius, G.centerDamage, G.edgeDamage);
          hit = true;
          break;
        }
      }
    }
    if (!hit) {
      const k = Math.min(H, Math.max(1, Math.ceil(g.life)));
      const w = g.life <= H ? 1 : 0.5;
      if (inv < k * DT) dmg += w * blastDmg(g.ex, g.ey, path[2 * k - 2], path[2 * k - 1], G.blastRadius, G.centerDamage, G.edgeDamage);
    }
  }
  const M = R.mines;
  for (const m of TH.mines) {
    if (m.t <= H) {
      if (inv < m.t * DT) dmg += blastDmg(m.x, m.y, path[2 * m.t - 2], path[2 * m.t - 1], M.blastRadius, M.centerDamage, M.edgeDamage);
    } else {
      const w = m.t <= H + 30 ? 0.7 : 0.35;
      dmg += w * blastDmg(m.x, m.y, path[2 * H - 2], path[2 * H - 1], M.blastRadius + 10, M.centerDamage, M.edgeDamage);
    }
  }
  for (const e of TH.melee) {
    if (e.id === ignoreMeleeId) continue;
    for (let k = 1; k <= H; k++) {
      if (k <= e.readyK) continue;
      const d = Math.hypot(path[2 * k - 2] - e.x, path[2 * k - 1] - e.y) - e.close * k;
      if (d < e.reach) {
        if (inv < k * DT) dmg += e.dmg;
        break;
      }
    }
  }
  return dmg;
}

const CANDS = [];
for (let i = 0; i < 16; i++) CANDS.push({ x: Math.cos((i * TAU) / 16), y: Math.sin((i * TAU) / 16) });
CANDS.push({ x: 0, y: 0 });

function chooseMove(desired, gain, weapon, ignoreMeleeId) {
  const top = topSpeed(weapon);
  const span = top * H * DT;
  const cands = CANDS.slice();
  if (desired.x !== 0 || desired.y !== 0) cands.push(norm(desired.x, desired.y));
  let best = null;
  let bestScore = -Infinity;
  for (const c of cands) {
    simPath(c.x, c.y, top, pathBuf);
    const ex = pathBuf[2 * H - 2];
    const ey = pathBuf[2 * H - 1];
    const prog = ((ex - me.x) * desired.x + (ey - me.y) * desired.y) / span;
    const score = gain * prog - danger(pathBuf, ignoreMeleeId) - zonePenalty(ex, ey) + 0.6 * (c.x * lastCmd.x + c.y * lastCmd.y);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

// ======================================================================= evaluation helpers

const eff = (p) => p.hp + p.shield;
const hasRanged = (p) => (p.hasGun && p.ammo.gun > 0) || (p.hasLauncher && p.ammo.launcher > 0);
function recently(map, id, s) {
  const t = map.get(id);
  return t !== undefined && now - t < s;
}
function knownPos(e) {
  if (e.visible) return { x: e.x, y: e.y };
  return { x: e.x, y: e.y };
}

function itemValue(it) {
  switch (it.type) {
    case 'life': return me.lives < R.player.maxLives ? 130 : 0;
    case 'shield': return me.shield < R.player.maxShield ? Math.min(R.items.shieldAmount, R.player.maxShield - me.shield) * 1.1 + 5 : 0;
    case 'health': return me.hp < R.player.maxHp ? Math.min(R.items.healthAmount, R.player.maxHp - me.hp) * (me.hp < 50 ? 1.6 : 1.1) : 0;
    case 'gun':
      if (!me.hasGun) return 110;
      return me.ammo.gun < R.gun.maxAmmo ? Math.min(R.gun.pickupAmmo, R.gun.maxAmmo - me.ammo.gun) * (me.ammo.gun < 8 ? 3 : 1.2) : 0;
    case 'ammo':
      if (!me.hasGun || me.ammo.gun >= R.gun.maxAmmo) return 0;
      return Math.min(R.items.ammoAmount, R.gun.maxAmmo - me.ammo.gun) * (me.ammo.gun < 8 ? 3 : 1.2);
    case 'launcher':
      if (!me.hasLauncher) return me.hasGun ? 45 : 80;
      return me.ammo.launcher < R.launcher.maxAmmo ? Math.min(R.launcher.pickupAmmo, R.launcher.maxAmmo - me.ammo.launcher) * 8 : 0;
    case 'mines': return me.mines < R.mines.maxCarry ? 14 : 0;
    default: return 0;
  }
}

function bestItem(state, enemies, top, filter) {
  let best = null;
  let bestU = 0;
  for (const it of state.items) {
    if (filter && !filter(it)) continue;
    let v = itemValue(it);
    if (v <= 0) continue;
    const pl = pathLen(it.x, it.y);
    const t = pl / top;
    if (zoneOn && Math.hypot(it.x - ZX, it.y - ZY) > zoneRadiusIn(TH_zone, t + 0.5) - RAD - 10) continue;
    if (state.mines.some((m) => Math.hypot(m.x - it.x, m.y - it.y) < R.mines.blastRadius + RAD && m.fuse < t + 0.6 && m.fuse > t - 0.3)) continue;
    const myD = Math.hypot(it.x - me.x, it.y - me.y);
    for (const e of enemies) {
      if (!e.visible) continue;
      const ed = Math.hypot(it.x - e.x, it.y - e.y);
      if (ed < myD * 0.75 && ed < 300) {
        v *= 0.3;
        break;
      }
      if (hasRanged(e) && ed < 160 && me.invulnerable <= 0) v *= 0.7;
    }
    let u = v / (1 + t * 1.1);
    if (it.id === itemTargetId) u *= 1.25;
    if (u > bestU) {
      bestU = u;
      best = it;
    }
  }
  return best ? { item: best, u: bestU } : null;
}
let TH_zone = null;

function pickTarget(enemies) {
  let best = null;
  let bs = Infinity;
  for (const e of enemies) {
    if (!e.visible && e.seenAgo > 4) continue;
    const pos = knownPos(e);
    let s = pathLen(pos.x, pos.y) + eff(e) * 2.2;
    if (!e.visible) s += 250 + e.seenAgo * 80;
    if (e.invulnerable > 0.3) s += 250;
    if (recently(lastHurtBy, e.id, 3)) s -= 180;
    if (recently(lastBusy, e.id, 1.5)) s -= 90;
    if (!hasRanged(e)) s -= 40;
    if (e.id === targetId) s -= 120;
    if (!losClear(me.x, me.y, pos.x, pos.y, R.gun.bulletRadius)) s += 120;
    if (s < bs) {
      bs = s;
      best = e;
    }
  }
  return best;
}

// ======================================================================= attacking

function planGun(enemies, target) {
  const sx = me.x + me.vx * DT;
  const sy = me.y + me.vy * DT;
  const speed = R.gun.bulletSpeed;
  const maxD = me.ammo.gun > 20 ? 520 : 400;
  let best = null;
  let bs = Infinity;
  for (const e of enemies) {
    if (!e.visible && e.seenAgo > 0.35) continue;
    const vx = e.visible ? e.vx : 0;
    const vy = e.visible ? e.vy : 0;
    const L = intercept(sx, sy, e.x, e.y, vx, vy, speed);
    const d = Math.hypot(L.x - sx, L.y - sy);
    if (d > R.gun.range - 40) continue;
    if (e.invulnerable > L.t + DT) continue;
    const slow = Math.hypot(e.vx, e.vy) < 45;
    if (d > (slow ? 750 : maxD)) continue;
    if (!losClear(sx, sy, L.x, L.y, R.gun.bulletRadius + 1)) continue;
    const aim = Math.atan2(L.y - sy, L.x - sx);
    let s = d + eff(e) + Math.abs(angleDiff(aim, me.facing)) * 200;
    if (target && e.id === target.id) s -= 250;
    if (s < bs) {
      bs = s;
      best = { aim, e, d };
    }
  }
  return best;
}

function planLauncher(enemies, target) {
  const sx = me.x + me.vx * DT;
  const sy = me.y + me.vy * DT;
  const speed = R.launcher.grenadeSpeed;
  const G = R.launcher;
  const safe = G.blastRadius + RAD + 35;
  let best = null;
  let bs = Infinity;
  for (const e of enemies) {
    if (!e.visible && e.seenAgo > 0.35) continue;
    const vx = e.visible ? e.vx : 0;
    const vy = e.visible ? e.vy : 0;
    const L = intercept(sx, sy, e.x, e.y, vx, vy, speed);
    const d = Math.hypot(L.x - sx, L.y - sy);
    if (d < safe || d > G.range - 30) continue;
    if (e.invulnerable > L.t + DT) continue;
    const ang = Math.atan2(L.y - sy, L.x - sx);
    const free = rayDist(sx, sy, Math.cos(ang), Math.sin(ang), G.grenadeRadius, d + 40);
    // Direct line, or it bursts on a wall right next to the target.
    let impactX = L.x;
    let impactY = L.y;
    if (free < d - 5) {
      impactX = sx + Math.cos(ang) * free;
      impactY = sy + Math.sin(ang) * free;
      if (Math.hypot(impactX - L.x, impactY - L.y) > G.blastRadius * 0.6) continue;
    }
    if (Math.hypot(impactX - sx, impactY - sy) < safe) continue;
    if (d > 480 && Math.hypot(e.vx, e.vy) > 60) continue;
    let s = d + eff(e) * 0.5;
    if (target && e.id === target.id) s -= 200;
    if (s < bs) {
      bs = s;
      best = { aim: ang, e, d };
    }
  }
  return best;
}

function planKnife(enemies, cmdV) {
  const mx = me.x + cmdV.x * DT;
  const my = me.y + cmdV.y * DT;
  const reach = 2 * RAD + R.knife.reach - 3;
  let best = null;
  let bd = Infinity;
  for (const e of enemies) {
    if (!e.visible) continue;
    if (e.invulnerable > DT) continue;
    const ex = e.x + e.vx * DT;
    const ey = e.y + e.vy * DT;
    const d = Math.hypot(ex - mx, ey - my);
    if (d > reach) continue;
    if (!losClear(mx, my, ex, ey, 0)) continue;
    if (d < bd) {
      bd = d;
      best = { e, aim: Math.atan2(ey - my, ex - mx) };
    }
  }
  if (!best) return null;
  const diff = angleDiff(best.aim, me.facing);
  const newFacing = me.facing + Math.max(-TURN, Math.min(TURN, diff));
  best.inArc = Math.abs(angleDiff(best.aim, newFacing)) < ((R.knife.arcDegrees / 2 - 6) * Math.PI) / 180;
  return best;
}

// ======================================================================= decide

export function decide(state) {
  me = state.self;
  now = state.time;
  if (!me.alive) {
    lastPos = null;
    return null;
  }
  const zone = state.zone;
  TH_zone = zone;
  zoneOn = zone.damagePerSecond > 0;
  ZX = zone.x;
  ZY = zone.y;
  zoneSoonR = zoneRadiusIn(zone, H * DT + 1.0);
  zoneNowR = zoneRadiusIn(zone, H * DT);

  for (const ev of state.events) {
    if (ev.type !== 'hit' || ev.weapon === 'zone') continue;
    if (ev.targetId === selfId && ev.attackerId !== selfId) lastHurtBy.set(ev.attackerId, now);
    else if (ev.attackerId !== ev.targetId && ev.attackerId !== selfId) lastBusy.set(ev.targetId, now);
  }

  const enemies = state.players.filter((p) => p.id !== selfId && p.alive);
  const reachW = topSpeed('knife') * H * DT + 60;
  nearWalls = walls.filter((w) => pointRectDist(me.x, me.y, w) < reachW);
  dijkstra(me.x, me.y);
  TH = buildThreats(state, enemies);

  // ----- weapon choice
  const target = pickTarget(enemies);
  targetId = target ? target.id : -1;
  const tDist = target ? dist(target, me) : Infinity;
  let weapon = 'knife';
  const gunOk = me.hasGun && me.ammo.gun > 0;
  const lnOk = me.hasLauncher && me.ammo.launcher > 0;
  if (gunOk) weapon = 'gun';
  else if (lnOk) weapon = 'launcher';
  if (gunOk && lnOk && target && target.visible) {
    // Grenades hit hard on slow targets or ones hugging a wall; hysteresis avoids flip-flopping.
    const slow = Math.hypot(target.vx, target.vy) < 50;
    const nearWall = walls.some((w) => pointRectDist(target.x, target.y, w) < RAD + 30);
    const want = (slow || nearWall || me.ammo.gun <= 3) && tDist > 170 && tDist < 460 && eff(target) > 40;
    if (want || (prevWeaponChoice === 'launcher' && tDist > 150 && tDist < 520 && me.cooldowns.launcher > 0.2)) weapon = 'launcher';
  }
  // Don't start a 0.3 s switch with an enemy in our face.
  if (weapon !== me.weapon && me.weapon !== 'knife' && tDist < 110 && ((me.weapon === 'gun' && gunOk) || (me.weapon === 'launcher' && false))) weapon = me.weapon;
  prevWeaponChoice = weapon;
  const top = topSpeed(weapon);
  const ranged = weapon !== 'knife';

  // ----- goal selection
  let desired = { x: 0, y: 0 };
  let gain = 12;
  let meleeId = -1;
  const myEff = eff(me);
  const visibleArmed = enemies.filter((e) => (e.visible || e.seenAgo < 0.5) && hasRanged(e));
  const threats = visibleArmed.filter((e) => dist(e, me) < 480 && losClear(e.x, e.y, me.x, me.y, 4));
  const outside = zoneOn && dist(me, zone) > zoneRadiusIn(zone, 2.5) - RAD - 20;
  const lead = state.timeLeft !== null && state.timeLeft < 25 && enemies.every((e) => e.lives < me.lives || (e.lives === me.lives && eff(e) + 40 < myEff));

  let retreat = false;
  if (me.invulnerable <= 0.2) {
    if (myEff <= 40 && threats.some((e) => eff(e) > myEff + 10)) retreat = true;
    if (threats.length >= 2 && myEff < 90) retreat = true;
    if (!ranged && threats.length >= 1 && !(target && tDist < 110)) retreat = true;
    if (lead && threats.length >= 1) retreat = true;
  }

  const itemPick = bestItem(state, enemies, top, null);
  itemTargetId = -1;
  const goItem = (it) => {
    itemTargetId = it.id;
    desired = steer(it.x, it.y);
  };

  if (outside) {
    desired = steer(zone.x, zone.y);
    gain = 30;
  } else if (!ranged) {
    // Knife: melee only when it's a good trade; otherwise arm up.
    let prey = null;
    for (const e of enemies) {
      if (!e.visible) continue;
      const d = dist(e, me);
      const ok =
        d < 120 ||
        (me.invulnerable > 0.4 && d < 220) ||
        (d < 380 && eff(e) <= R.knife.damage + 2 && e.invulnerable <= 0.2) ||
        (d < 300 && !hasRanged(e) && eff(e) + 25 < myEff && e.invulnerable <= 0.2);
      if (ok && (!prey || d < dist(prey, me))) prey = e;
    }
    const weaponItem = bestItem(state, enemies, top, (it) => it.type === 'gun' || it.type === 'launcher');
    if (prey && !(weaponItem && weaponItem.u > 40 && dist(prey, me) > 90)) {
      const pd = dist(prey, me);
      const theirCd = prey.weapon === 'knife' ? Math.max(prey.cooldowns.knife, prey.cooldowns.switch) : 9;
      const myCd = Math.max(me.cooldowns.knife, me.cooldowns.switch);
      const outReach = 2 * RAD + R.knife.reach + 22;
      if (me.invulnerable <= myCd && myCd > theirCd + 0.04 && pd < outReach + 40) {
        // They swing before we can: step out of reach and come back in when we're ready first.
        const away = norm(me.x - prey.x, me.y - prey.y);
        desired = pd < outReach ? away : { x: -away.y, y: away.x };
        gain = 6;
      } else {
        meleeId = prey.id;
        const lt = Math.min(0.25, pd / 400);
        desired = steer(prey.x + prey.vx * lt, prey.y + prey.vy * lt);
        gain = 18;
      }
    } else if (weaponItem && weaponItem.u > 10) goItem(weaponItem.item);
    else if (itemPick) goItem(itemPick.item);
    else {
      const away = fleeVector(threats.length ? threats : visibleArmed.filter((e) => dist(e, me) < 350));
      const toC = norm(zone.x - me.x, zone.y - me.y);
      desired = norm(away.x * 2 + toC.x * 0.4, away.y * 2 + toC.y * 0.4);
      if (away.x === 0 && away.y === 0 && dist(me, zone) > 150) desired = steer(zone.x, zone.y);
    }
  } else if (retreat) {
    const heal = bestItem(state, enemies, top, (it) => it.type === 'health' || it.type === 'shield' || it.type === 'life');
    if (heal && heal.u > 8 && !threats.some((e) => Math.hypot(e.x - heal.item.x, e.y - heal.item.y) < 150)) goItem(heal.item);
    else {
      const away = fleeVector(threats);
      const toC = norm(zone.x - me.x, zone.y - me.y);
      const edge = zoneOn ? Math.max(0, 1 - (zoneRadiusIn(zone, 3) - dist(me, zone)) / 250) : 0;
      desired = norm(away.x + toC.x * (0.3 + edge * 2), away.y + toC.y * (0.3 + edge * 2));
    }
    gain = 16;
  } else if (target) {
    const tp = knownPos(target);
    const los = losClear(me.x, me.y, tp.x, tp.y, R.gun.bulletRadius + 2);
    const itemFirst = itemPick && (itemPick.u > 28 || (itemPick.u > 12 && tDist > 450));
    if (itemFirst) goItem(itemPick.item);
    else if (!los) {
      desired = steer(tp.x, tp.y);
      gain = 14;
    } else {
      let lo = 210;
      let hi = 320;
      if (weapon === 'launcher') { lo = 200; hi = 360; }
      if (target.weapon === 'knife') { lo = 250; hi = 380; }
      if (eff(target) < 45 && target.weapon !== 'knife') { lo = 140; hi = 260; }
      const d = tDist;
      const toward = norm(tp.x - me.x, tp.y - me.y);
      const radial = d > hi ? Math.min(1, (d - hi) / 80) : d < lo ? -Math.min(1, (lo - d) / 80) : 0;
      if (now >= strafeFlipAt) {
        strafeSign = Math.random() < 0.5 ? -1 : 1;
        strafeFlipAt = now + 0.45 + Math.random() * 0.9;
      }
      if (Math.hypot(me.vx, me.vy) < 30 && lastCmd.x * lastCmd.x + lastCmd.y * lastCmd.y > 0.25) strafeSign = -strafeSign;
      const strafe = { x: -toward.y * strafeSign, y: toward.x * strafeSign };
      desired = norm(toward.x * radial * 1.2 + strafe.x, toward.y * radial * 1.2 + strafe.y);
      // grab something small on the way
      if (itemPick && itemPick.u > 8 && dist(itemPick.item, me) < 130 && walkable(me.x, me.y, itemPick.item.x, itemPick.item.y)) {
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

  const move = chooseMove(desired, gain, weapon, meleeId);
  lastCmd = move;
  lastPos = { x: me.x, y: me.y };

  // ----- aim & attack
  let aim;
  let attack = false;
  const canAct = me.cooldowns.switch <= 0 && me.weapon === weapon;
  const holdFire = me.invulnerable > 0.25 && !threats.some((e) => dist(e, me) < 320);
  if (weapon === 'gun') {
    const shot = planGun(enemies, target);
    if (shot) {
      aim = shot.aim;
      attack = canAct && me.cooldowns.gun <= 0 && Math.abs(angleDiff(aim, me.facing)) <= TURN * 0.98 && !holdFire;
    } else if (target) {
      const L = intercept(me.x, me.y, target.x, target.y, target.visible ? target.vx : 0, target.visible ? target.vy : 0, R.gun.bulletSpeed);
      aim = Math.atan2(L.y - me.y, L.x - me.x);
    }
  } else if (weapon === 'launcher') {
    const shot = planLauncher(enemies, target);
    if (shot) {
      aim = shot.aim;
      attack = canAct && me.cooldowns.launcher <= 0 && Math.abs(angleDiff(aim, me.facing)) <= TURN * 0.98 && !holdFire;
    } else if (target) aim = Math.atan2(target.y - me.y, target.x - me.x);
  } else {
    const cmdV = { x: move.x * top, y: move.y * top };
    const k = planKnife(enemies, cmdV);
    if (k) {
      aim = k.aim;
      attack = canAct && me.cooldowns.knife <= 0 && k.inArc && !(me.invulnerable > 0.6 && eff(k.e) > R.knife.damage && !hasRanged(k.e) && false);
    } else {
      const near = enemies.filter((e) => e.visible).sort((a, b) => dist(a, me) - dist(b, me))[0];
      if (near && dist(near, me) < 200) aim = Math.atan2(near.y - me.y, near.x - me.x);
      else if (move.x || move.y) aim = Math.atan2(move.y, move.x);
    }
  }
  // Point-blank knife when holding a gun on cooldown is not worth a switch; keep it simple.

  // ----- mines: drop one on a close chaser while we move away from it
  let plantMine = false;
  if (me.mines > 0 && me.cooldowns.mine <= 0 && me.invulnerable <= 0) {
    for (const e of enemies) {
      if (!e.visible) continue;
      const d = dist(e, me);
      if (d > 130 || d < 40) continue;
      const closing = -((e.vx - me.vx) * (e.x - me.x) + (e.vy - me.vy) * (e.y - me.y)) / d;
      const awayFromIt = move.x * (me.x - e.x) + move.y * (me.y - e.y) > 0;
      if ((closing > 60 || e.weapon === 'knife') && awayFromIt && !state.mines.some((m) => dist(m, me) < 110)) {
        plantMine = true;
        break;
      }
    }
  }

  const out = { move: { x: move.x, y: move.y }, weapon, attack, plantMine };
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
