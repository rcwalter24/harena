export const meta = { name: 'deepseek', author: 'deepseek' };

// ===========================================================================
//  deepseek - a Harena bot
//  Strategy: grab a gun fast, hold mid range, strafe + lead shots, dodge
//  bullets/grenades/mines/lasers, kite with mines, retreat with smoke,
//  and always stay ahead of the shrinking zone.
// ===========================================================================

let R = null;              // rules (from init)
let walls = [];            // map walls + border walls
let W = 0, H = 0;          // map size
let navNodes = [];         // waypoints (wall corners, pushed out)
let navAdj = [];           // adjacency (indices)
let strafeDir = 1;
let strafeFlipTime = 0;

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// geometry helpers
// ---------------------------------------------------------------------------

function angDiff(a, b) {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

function norm(v) {
  const l = Math.hypot(v.x, v.y);
  return l > 1e-9 ? { x: v.x / l, y: v.y / l } : { x: 0, y: 0 };
}

function d2(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
}

// Slab test: does segment (x0,y0)->(x1,y1) intersect rect r grown by `pad`?
function segRect(x0, y0, x1, y1, r, pad) {
  let tMin = 0, tMax = 1;
  const dx = x1 - x0, dy = y1 - y0;
  const lox = r.x - pad, hix = r.x + r.w + pad;
  const loy = r.y - pad, hiy = r.y + r.h + pad;

  if (dx === 0) {
    if (x0 < lox || x0 > hix) return false;
  } else {
    let a = (lox - x0) / dx, b = (hix - x0) / dx;
    if (a > b) { const s = a; a = b; b = s; }
    if (a > tMin) tMin = a;
    if (b < tMax) tMax = b;
    if (tMin > tMax) return false;
  }
  if (dy === 0) {
    if (y0 < loy || y0 > hiy) return false;
  } else {
    let a = (loy - y0) / dy, b = (hiy - y0) / dy;
    if (a > b) { const s = a; a = b; b = s; }
    if (a > tMin) tMin = a;
    if (b < tMax) tMax = b;
    if (tMin > tMax) return false;
  }
  return true;
}

function blocked(x0, y0, x1, y1, pad) {
  for (let i = 0; i < walls.length; i++) {
    if (segRect(x0, y0, x1, y1, walls[i], pad)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// init + navigation graph
// ---------------------------------------------------------------------------

export function init(info) {
  R = info.rules;
  W = info.map.width;
  H = info.map.height;

  walls = info.map.walls.slice();
  const T = 80;
  walls.push({ x: -T, y: -T, w: W + 2 * T, h: T });      // top
  walls.push({ x: -T, y: H, w: W + 2 * T, h: T });       // bottom
  walls.push({ x: -T, y: -T, w: T, h: H + 2 * T });      // left
  walls.push({ x: W, y: -T, w: T, h: H + 2 * T });       // right

  buildNav();
}

function buildNav() {
  const pr = R.player.radius;
  const m = pr + 10;
  const pts = [];

  for (let i = 0; i < walls.length; i++) {
    const w = walls[i];
    const cs = [
      { x: w.x - m, y: w.y - m },
      { x: w.x + w.w + m, y: w.y - m },
      { x: w.x - m, y: w.y + w.h + m },
      { x: w.x + w.w + m, y: w.y + w.h + m },
    ];
    for (let k = 0; k < 4; k++) {
      const c = cs[k];
      if (c.x < pr || c.y < pr || c.x > W - pr || c.y > H - pr) continue;
      let ok = true;
      for (let j = 0; j < walls.length; j++) {
        const w2 = walls[j];
        if (c.x > w2.x - pr && c.x < w2.x + w2.w + pr &&
            c.y > w2.y - pr && c.y < w2.y + w2.h + pr) { ok = false; break; }
      }
      if (!ok) continue;
      let dup = false;
      for (let j = 0; j < pts.length; j++) {
        if (Math.abs(pts[j].x - c.x) < 0.5 && Math.abs(pts[j].y - c.y) < 0.5) { dup = true; break; }
      }
      if (!dup) pts.push(c);
    }
  }

  navNodes = pts;
  navAdj = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) navAdj[i] = [];

  const pad = pr - 3;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      if (!blocked(pts[i].x, pts[i].y, pts[j].x, pts[j].y, pad)) {
        navAdj[i].push(j);
        navAdj[j].push(i);
      }
    }
  }
}

// Dijkstra over the waypoint graph, with `from` / `to` as virtual endpoints.
// Returns a unit direction to move.
function findPath(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const dd = Math.hypot(dx, dy);
  if (dd < 1e-6) return { x: 0, y: 0 };
  const direct = { x: dx / dd, y: dy / dd };

  const pad = R.player.radius - 3;
  if (!blocked(from.x, from.y, to.x, to.y, pad)) return direct;

  const n = navNodes.length;
  if (n === 0) return direct;

  const fromD = new Array(n);
  const goalD = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = navNodes[i];
    fromD[i] = blocked(from.x, from.y, p.x, p.y, pad) ? Infinity : Math.hypot(p.x - from.x, p.y - from.y);
    goalD[i] = blocked(to.x, to.y, p.x, p.y, pad) ? Infinity : Math.hypot(p.x - to.x, p.y - to.y);
  }

  const g = fromD.slice();
  const prev = new Array(n).fill(-1);
  const done = new Array(n).fill(false);

  let bestCost = Infinity, bestNode = -1;
  for (let i = 0; i < n; i++) {
    if (goalD[i] < Infinity && g[i] + goalD[i] < bestCost) {
      bestCost = g[i] + goalD[i];
      bestNode = i;
    }
  }
  if (bestNode === -1) return direct;

  for (let iter = 0; iter < n; iter++) {
    let u = -1, uc = Infinity;
    for (let i = 0; i < n; i++) {
      if (!done[i] && g[i] < uc) { uc = g[i]; u = i; }
    }
    if (u === -1 || uc >= bestCost) break;
    done[u] = true;

    const adj = navAdj[u];
    for (let k = 0; k < adj.length; k++) {
      const j = adj[k];
      if (done[j]) continue;
      const d = Math.hypot(navNodes[j].x - navNodes[u].x, navNodes[j].y - navNodes[u].y);
      const ng = uc + d;
      if (ng < g[j]) {
        g[j] = ng;
        prev[j] = u;
        if (goalD[j] < Infinity && ng + goalD[j] < bestCost) {
          bestCost = ng + goalD[j];
          bestNode = j;
        }
      }
    }
  }

  if (bestNode === -1 || g[bestNode] === Infinity) return direct;

  let cur = bestNode;
  while (prev[cur] !== -1) cur = prev[cur];
  return norm({ x: navNodes[cur].x - from.x, y: navNodes[cur].y - from.y });
}

// ---------------------------------------------------------------------------
// threat avoidance
// ---------------------------------------------------------------------------

function bulletDodge(state, me) {
  let ax = 0, ay = 0;
  const myR = R.player.radius;
  const bl = state.bullets;
  for (let i = 0; i < bl.length; i++) {
    const b = bl[i];
    if (b.ownerId === me.id) continue;
    const vv = b.vx * b.vx + b.vy * b.vy;
    if (vv < 1) continue;
    const rx = me.x - b.x, ry = me.y - b.y;
    let tt = (rx * b.vx + ry * b.vy) / vv;
    if (tt > 1.4 || tt < -0.15) continue;
    if (tt < 0) tt = 0;
    const cx = b.x + b.vx * tt - me.x;
    const cy = b.y + b.vy * tt - me.y;
    const cd = Math.hypot(cx, cy);
    const danger = myR + b.radius + 14;
    if (cd > danger) continue;
    const w = ((danger - cd + 6) * (1.4 - tt)) / 1.4;
    if (cd > 0.5) {
      ax += (cx / cd) * w * 1.4;
      ay += (cy / cd) * w * 1.4;
    } else {
      const s = 1 / Math.sqrt(vv);
      ax += -b.vy * s * w * 1.4;
      ay += b.vx * s * w * 1.4;
    }
  }
  return { x: ax, y: ay };
}

function grenadeDodge(state, me) {
  let ax = 0, ay = 0;
  const danger = R.launcher.blastRadius + R.player.radius + 30;
  const gr = state.grenades;
  for (let i = 0; i < gr.length; i++) {
    const g = gr[i];
    if (g.ownerId === me.id) continue;
    const dx = me.x - g.x, dy = me.y - g.y;
    const d = Math.hypot(dx, dy);
    if (d > danger || d < 0.5) continue;
    const closing = -(dx * g.vx + dy * g.vy) / d;
    const w = ((danger - d) / danger) * (closing > 0 ? 3.2 : 1.2);
    ax += (dx / d) * w;
    ay += (dy / d) * w;
  }
  return { x: ax, y: ay };
}

function mineDodge(state, me) {
  let ax = 0, ay = 0;
  const danger = R.mines.blastRadius + R.player.radius + 24;
  const mn = state.mines;
  for (let i = 0; i < mn.length; i++) {
    const m = mn[i];
    const dx = me.x - m.x, dy = me.y - m.y;
    const d = Math.hypot(dx, dy);
    if (d > danger || d < 0.5) continue;
    const urgency = Math.max(0, 1.7 - m.fuse) / 1.7;
    if (urgency <= 0) continue;
    const w = ((danger - d) / danger) * 5 * urgency;
    ax += (dx / d) * w;
    ay += (dy / d) * w;
  }
  return { x: ax, y: ay };
}

function laserDodge(state, me) {
  let ax = 0, ay = 0;
  const danger = R.player.radius + R.laser.beamRadius + 14;
  const ls = state.lasers;
  for (let i = 0; i < ls.length; i++) {
    const L = ls[i];
    if (L.ownerId === me.id) continue;
    const path = L.path;
    if (!path || path.length < 2) continue;
    for (let k = 0; k + 1 < path.length; k++) {
      const p = path[k], q = path[k + 1];
      const sx = q.x - p.x, sy = q.y - p.y;
      const vv = sx * sx + sy * sy;
      if (vv < 1e-6) continue;
      let tt = ((me.x - p.x) * sx + (me.y - p.y) * sy) / vv;
      if (tt < 0) tt = 0; else if (tt > 1) tt = 1;
      const cx = p.x + sx * tt, cy = p.y + sy * tt;
      const ox = me.x - cx, oy = me.y - cy;
      const od = Math.hypot(ox, oy);
      if (od > danger) continue;
      const s = 1 / Math.sqrt(vv);
      const px = -sy * s, py = sx * s;
      const side = (ox * px + oy * py) >= 0 ? 1 : -1;
      const w = ((danger - od) / danger) * 6;
      ax += px * side * w;
      ay += py * side * w;
      break;
    }
  }
  return { x: ax, y: ay };
}

function zoneRadiusAt(z, t) {
  if (z.collapseStartsIn !== null && z.collapseStartsIn <= 0 && z.collapseEndsIn !== null) {
    if (z.collapseEndsIn <= t) return 0;
    return Math.max(0, z.radius - (z.radius / z.collapseEndsIn) * t);
  }
  if (z.shrinkStartsIn <= 0 && z.shrinkEndsIn > 0) {
    const rate = (z.radius - z.finalRadius) / z.shrinkEndsIn;
    return Math.max(z.finalRadius, z.radius - rate * t);
  }
  return z.radius;
}

function zonePull(state, me) {
  const z = state.zone;
  if (z.damagePerSecond === 0) return { x: 0, y: 0 };
  const dx = me.x - z.x, dy = me.y - z.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return { x: 0, y: 0 };
  const rFuture = zoneRadiusAt(z, 2.5);
  const safeEdge = Math.min(z.radius, rFuture) - R.player.radius - 25;
  if (d <= safeEdge) return { x: 0, y: 0 };
  const over = d - safeEdge;
  const k = Math.min(3.5, 0.8 + over / 70);
  const dir = norm({ x: -dx, y: -dy });
  return { x: dir.x * k, y: dir.y * k };
}

// ---------------------------------------------------------------------------
// target + item selection
// ---------------------------------------------------------------------------

function pickTarget(state, me) {
  let best = null, bestScore = Infinity;
  const ps = state.players;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (p.id === me.id || !p.alive) continue;
    const d = Math.hypot(p.x - me.x, p.y - me.y);
    const hiddenPenalty = p.visible ? 0 : 350;
    const hpBonus = (p.hp + p.shield) * 0.25;
    const score = d + hiddenPenalty + hpBonus;
    if (score < bestScore) { bestScore = score; best = p; }
  }
  return best;
}

function usefulItems(state, me) {
  const zr = zoneRadiusAt(state.zone, 2);
  const out = [];
  const its = state.items;
  for (let i = 0; i < its.length; i++) {
    const it = its[i];

    if (state.zone.damagePerSecond > 0) {
      const dx = it.x - state.zone.x, dy = it.y - state.zone.y;
      if (Math.hypot(dx, dy) > Math.max(50, zr - 45)) continue;
    }

    let prio = 0;
    switch (it.type) {
      case 'gun':
        if (!me.hasGun) prio = 110;
        else if (me.ammo.gun < R.gun.maxAmmo) prio = 45;
        break;
      case 'ammo':
        if (me.hasGun && me.ammo.gun < R.gun.maxAmmo) prio = 50;
        break;
      case 'health':
        if (me.hp < R.player.maxHp - 10) prio = me.hp < 55 ? 100 : 35;
        break;
      case 'shield':
        if (me.shield < R.player.maxShield) prio = me.shield < 40 ? 55 : 25;
        break;
      case 'life':
        if (me.lives < R.player.maxLives) prio = 40;
        break;
      case 'launcher':
        if (!me.hasLauncher) prio = 65;
        else if (me.ammo.launcher < R.launcher.maxAmmo) prio = 22;
        break;
      case 'laser':
        if (!me.hasLaser) prio = 5; // we don't use the laser
        break;
      case 'mines':
        if (me.mines < R.mines.maxCarry) prio = 18;
        break;
      case 'smoke':
        if (me.smokeGrenades < 2) prio = 12;
        break;
      case 'gas':
        if (me.gasGrenades < 2) prio = 12;
        break;
    }
    if (prio > 0) {
      const dist = Math.hypot(it.x - me.x, it.y - me.y);
      out.push({ it, score: prio - dist * 0.25 });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out.map((o) => o.it);
}

// ---------------------------------------------------------------------------
// decide
// ---------------------------------------------------------------------------

export function decide(state) {
  const me = state.self;
  if (!me.alive) return null;

  const t = state.time;
  const zone = state.zone;

  // --- threat avoidance -----------------------------------------------------
  const bd = bulletDodge(state, me);
  const gd = grenadeDodge(state, me);
  const md = mineDodge(state, me);
  const ld = laserDodge(state, me);
  const zp = zonePull(state, me);

  let mx = bd.x * 1.3 + gd.x * 0.8 + md.x * 1.6 + ld.x * 1.5 + zp.x;
  let my = bd.y * 1.3 + gd.y * 0.8 + md.y * 1.6 + ld.y * 1.5 + zp.y;

  // --- weapon choice --------------------------------------------------------
  let desired = 'knife';
  if (me.hasGun && me.ammo.gun > 0) desired = 'gun';
  else if (me.hasLauncher && me.ammo.launcher > 0) desired = 'launcher';

  const enemy = pickTarget(state, me);
  const items = usefulItems(state, me);
  const lowHp = me.hp < 35;

  let aim = me.facing;
  let attack = false;
  let plantMine = false;
  let throwKind = null;
  let throwDist = 0;

  // =========================================================================
  //  no ranged weapon: go shopping, knife anyone who comes close
  // =========================================================================
  if (desired === 'knife') {
    const wanted = items[0];
    const eDist = enemy ? Math.hypot(enemy.x - me.x, enemy.y - me.y) : Infinity;
    const canSeeEnemy = enemy && (enemy.visible || enemy.seenAgo < 0.6);

    if (enemy && canSeeEnemy && eDist < 115) {
      const ang = Math.atan2(enemy.y - me.y, enemy.x - me.x);
      aim = ang;
      const reach = 2 * R.player.radius + R.knife.reach;
      if (eDist <= reach + 8 && Math.abs(angDiff(ang, me.facing)) < 0.7) attack = true;
      const ux = (enemy.x - me.x) / (eDist || 1);
      const uy = (enemy.y - me.y) / (eDist || 1);
      mx += ux * 2.2;
      my += uy * 2.2;
    } else if (wanted) {
      const dir = findPath(me, wanted);
      mx += dir.x * 2.4;
      my += dir.y * 2.4;
      aim = Math.atan2(dir.y, dir.x);
    }
  }
  // =========================================================================
  //  armed but nobody around: collect items / reposition
  // =========================================================================
  else if (!enemy) {
    const wanted = items[0];
    if (wanted) {
      const dir = findPath(me, wanted);
      mx += dir.x * 2.0;
      my += dir.y * 2.0;
      aim = Math.atan2(dir.y, dir.x);
    }
  }
  // =========================================================================
  //  armed and engaged
  // =========================================================================
  else {
    const dx = enemy.x - me.x, dy = enemy.y - me.y;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d, uy = dy / d;

    let ideal = desired === 'gun' ? 300 : 400;
    if (lowHp) ideal = 520;

    let radial = 0;
    if (d > ideal * 1.25) radial = 1;
    else if (d < ideal * 0.7) radial = -1;

    // strafe direction flips periodically, and when we get pinned
    if (t > strafeFlipTime) {
      strafeDir = Math.random() < 0.5 ? -1 : 1;
      strafeFlipTime = t + 0.6 + Math.random() * 0.9;
    }
    if (Math.hypot(me.vx, me.vy) < 25 && t > 0.6 && !lowHp) {
      strafeDir = -strafeDir;
      strafeFlipTime = t + 0.6;
    }

    const sx = -uy * strafeDir, sy = ux * strafeDir;
    const seen = !blocked(me.x, me.y, enemy.x, enemy.y, 4);

    if (seen) {
      mx += ux * radial * 2.0 + sx * 1.7;
      my += uy * radial * 2.0 + sy * 1.7;
    } else {
      const p = findPath(me, enemy);
      mx += p.x * 2.4;
      my += p.y * 2.4;
    }

    // opportunistic item pickup
    const wanted = items[0];
    if (wanted && d2(wanted, me) < 180 * 180) {
      const dir = findPath(me, wanted);
      mx += dir.x * 1.1;
      my += dir.y * 1.1;
    }

    // aim with lead
    const pspeed = desired === 'gun' ? R.gun.bulletSpeed : R.launcher.grenadeSpeed;
    const flight = d / pspeed;
    const lx = enemy.x + enemy.vx * flight;
    const ly = enemy.y + enemy.vy * flight;
    aim = Math.atan2(ly - me.y, lx - me.x);

    const facingOk = Math.abs(angDiff(aim, me.facing)) < 0.16;
    const fresh = enemy.visible || enemy.seenAgo < 0.45;

    if (fresh && facingOk && me.weapon === desired && me.cooldowns.switch === 0) {
      if (desired === 'gun') {
        if (d < R.gun.range * 0.85 && !blocked(me.x, me.y, lx, ly, R.gun.bulletRadius)) {
          attack = true;
        }
      } else {
        const minD = R.launcher.blastRadius + R.player.radius + 35;
        if (d > minD && d < R.launcher.range * 0.85 &&
            !blocked(me.x, me.y, lx, ly, R.launcher.grenadeRadius)) {
          attack = true;
        }
      }
    }

    // mine the chaser when we are backing off
    if (me.mines > 0 && me.cooldowns.mine === 0 && d < 135 && d > 30 && radial <= 0) {
      let tooClose = false;
      for (let i = 0; i < state.mines.length; i++) {
        if (d2(state.mines[i], me) < 140 * 140) { tooClose = true; break; }
      }
      if (!tooClose) plantMine = true;
    }

    // emergency smoke when badly hurt
    if (lowHp && me.smokeGrenades > 0 && me.cooldowns.throw === 0 && d < 320) {
      let hasSmoke = false;
      for (let i = 0; i < state.clouds.length; i++) {
        const c = state.clouds[i];
        if (c.ownerId === me.id && c.kind === 'smoke') { hasSmoke = true; break; }
      }
      if (!hasSmoke) {
        throwKind = 'smoke';
        throwDist = 25;
      }
    }
  }

  // --- build action ---------------------------------------------------------
  const action = {};
  const mv = norm({ x: mx, y: my });
  if (mv.x !== 0 || mv.y !== 0) action.move = mv;
  action.aim = aim;
  if (attack) action.attack = true;
  if (me.weapon !== desired) action.weapon = desired;
  if (plantMine) action.plantMine = true;
  if (throwKind) {
    action.throw = throwKind;
    action.throwDistance = throwDist;
  }
  return action;
}