export const meta = { name: 'Apex', author: 'Harena AI' };

let R = null;
let walls = [];
let mapW = 1600, mapH = 1000;
let gunSpawns = [];
let strafeDir = 1;
let strafeFlipAt = 0;
let lastUnstuck = 0;

export function init(info) {
  R = info.rules;
  walls = info.map.walls;
  mapW = info.map.width;
  mapH = info.map.height;
  gunSpawns = info.map.gunSpawns || [];
  strafeDir = Math.random() < 0.5 ? -1 : 1;
  strafeFlipAt = 0;
  lastUnstuck = 0;
}

const TAU = Math.PI * 2;
const PI = Math.PI;

function adiff(a, b) {
  let d = (a - b) % TAU;
  if (d > PI) d -= TAU;
  if (d <= -PI) d += TAU;
  return d;
}

function norm(v) {
  const l = Math.hypot(v.x, v.y);
  if (l < 1e-9) return { x: 0, y: 0 };
  return { x: v.x / l, y: v.y / l };
}

function segHitsRect(x0, y0, x1, y1, r, pad) {
  const dx = x1 - x0, dy = y1 - y0;
  const lox = r.x - pad, hix = r.x + r.w + pad;
  const loy = r.y - pad, hiy = r.y + r.h + pad;
  let tMin = 0, tMax = 1;
  if (Math.abs(dx) < 1e-9) {
    if (x0 < lox || x0 > hix) return false;
  } else {
    let a = (lox - x0) / dx, b = (hix - x0) / dx;
    if (a > b) { const t = a; a = b; b = t; }
    if (a > tMin) tMin = a;
    if (b < tMax) tMax = b;
    if (tMin > tMax) return false;
  }
  if (Math.abs(dy) < 1e-9) {
    if (y0 < loy || y0 > hiy) return false;
  } else {
    let a = (loy - y0) / dy, b = (hiy - y0) / dy;
    if (a > b) { const t = a; a = b; b = t; }
    if (a > tMin) tMin = a;
    if (b < tMax) tMax = b;
    if (tMin > tMax) return false;
  }
  return true;
}

function hasLOS(x0, y0, x1, y1) {
  for (let i = 0; i < walls.length; i++) {
    if (segHitsRect(x0, y0, x1, y1, walls[i], 0)) return false;
  }
  return true;
}

// 玩家直径减去一点余量，判断能否沿直线走过去。
function walkable(ax, ay, bx, by) {
  const pad = R.player.radius - 2;
  for (let i = 0; i < walls.length; i++) {
    if (segHitsRect(ax, ay, bx, by, walls[i], pad)) return false;
  }
  return true;
}

// 直线不通时，先朝最近的阻挡墙的一个外推角走。够了。
function pathTo(me, goal) {
  const dx = goal.x - me.x, dy = goal.y - me.y;
  const straight = norm({ x: dx, y: dy });
  if (walkable(me.x, me.y, goal.x, goal.y)) return straight;
  const r = R.player.radius;
  let blocker = null, blockerD = Infinity;
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i];
    if (!segHitsRect(me.x, me.y, goal.x, goal.y, w, r - 2)) continue;
    const cx = w.x + w.w / 2, cy = w.y + w.h / 2;
    const d = Math.hypot(cx - me.x, cy - me.y);
    if (d < blockerD) { blockerD = d; blocker = w; }
  }
  if (!blocker) return straight;
  const m = r + 10;
  const cs = [
    { x: blocker.x - m, y: blocker.y - m },
    { x: blocker.x + blocker.w + m, y: blocker.y - m },
    { x: blocker.x - m, y: blocker.y + blocker.h + m },
    { x: blocker.x + blocker.w + m, y: blocker.y + blocker.h + m },
  ];
  let best = null, bestCost = Infinity;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (c.x < r || c.y < r || c.x > mapW - r || c.y > mapH - r) continue;
    const dc = Math.hypot(c.x - me.x, c.y - me.y);
    if (dc < 8) continue;
    const canReach = walkable(me.x, me.y, c.x, c.y);
    const cost = dc + Math.hypot(goal.x - c.x, goal.y - c.y) + (canReach ? 0 : 1000);
    if (cost < bestCost) { bestCost = cost; best = c; }
  }
  if (!best) return straight;
  return norm({ x: best.x - me.x, y: best.y - me.y });
}

// ---------- 安全区（含坍缩） ----------

// 预测 dt 秒后的安全区半径。
// 阶段：shrink → hold → collapse。倒计时字段在 shrink/collapse 进行时会变 0。
function zoneRadiusIn(zone, dt) {
  if (zone.damagePerSecond === 0) return Infinity;

  const colStart = zone.collapseStartsIn;
  const colEnd = zone.collapseEndsIn;
  if (colStart !== null && colStart !== undefined && colEnd !== null && colEnd !== undefined) {
    if (dt >= colEnd) return 0;
    if (dt >= colStart) {
      const fromR = colStart > 0 ? zone.finalRadius : zone.radius;
      const dur = colEnd - colStart;
      if (dur <= 0) return 0;
      return fromR * (1 - (dt - colStart) / dur);
    }
  }

  if (dt >= zone.shrinkEndsIn) return zone.finalRadius;
  if (dt <= zone.shrinkStartsIn) return zone.radius;

  const dur = zone.shrinkEndsIn - zone.shrinkStartsIn;
  if (dur <= 0) return zone.finalRadius;
  const rate = (zone.radius - zone.finalRadius) / dur;
  return zone.radius - rate * (dt - zone.shrinkStartsIn);
}

// 坍缩阶段的判定：半径会一直缩到 0，无处可躲。转为"向心 + 保持机动"。
function inCollapse(zone) {
  return zone.collapseStartsIn !== null && zone.collapseStartsIn !== undefined && zone.collapseStartsIn <= 0;
}

function zonePressure(state, me) {
  const zone = state.zone;
  if (zone.damagePerSecond === 0) return { x: 0, y: 0 };
  const dx = zone.x - me.x, dy = zone.y - me.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return { x: 0, y: 0 };

  // 坍缩：向心但不过猛，保持缠斗机动力
  if (inCollapse(zone)) {
    const k = Math.min(2.0, 0.5 + d / 200);
    return { x: (dx / d) * k, y: (dy / d) * k };
  }

  const safeR = zoneRadiusIn(zone, 2.5) - R.player.radius - 25;
  if (d <= safeR) return { x: 0, y: 0 };
  const over = d - safeR;
  const urgency = Math.min(3.5, 0.6 + over / 30);
  return { x: (dx / d) * urgency, y: (dy / d) * urgency };
}

function pointSafeFromZone(zone, x, y, dt) {
  if (zone.damagePerSecond === 0) return true;
  const r = zoneRadiusIn(zone, dt) - 20;
  if (r <= 0) return false;
  const dx = x - zone.x, dy = y - zone.y;
  return dx * dx + dy * dy <= r * r;
}

// ---------- 物品 ----------

function itemValue(it, me, zone) {
  const inZone = pointSafeFromZone(zone, it.x, it.y, 3);
  switch (it.type) {
    case 'life':    return me.lives < R.player.maxLives ? 220 : 0;
    case 'health':  return me.hp >= R.player.maxHp ? 0 : (R.player.maxHp - me.hp) * 2.4;
    case 'shield':  return me.shield >= R.player.maxShield ? 0 : (R.player.maxShield - me.shield) * 1.2;
  }
  if (!inZone) return 0;
  switch (it.type) {
    case 'gun':      return !me.hasGun ? 170 : (me.ammo.gun < R.gun.maxAmmo ? 55 : 0);
    case 'ammo':     return me.hasGun && me.ammo.gun < R.gun.maxAmmo ? 55 : 0;
    case 'launcher': return !me.hasLauncher ? 75 : (me.ammo.launcher < R.launcher.maxAmmo ? 30 : 0);
    case 'mines':    return me.mines < R.mines.maxCarry ? 40 : 0;
  }
  return 0;
}

function pickItem(state, me) {
  let best = null, bestScore = 0;
  for (let i = 0; i < state.items.length; i++) {
    const it = state.items[i];
    const v = itemValue(it, me, state.zone);
    if (v <= 0) continue;
    const d = Math.hypot(it.x - me.x, it.y - me.y);
    const score = v / (d + 100);
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return best;
}

// ---------- 目标选择 ----------

function pickTarget(state, me) {
  let best = null, bestScore = -Infinity;
  const collapse = inCollapse(state.zone);
  for (let i = 0; i < state.players.length; i++) {
    const p = state.players[i];
    if (p.id === me.id || !p.alive) continue;
    const d = Math.hypot(p.x - me.x, p.y - me.y);
    let s = 4000 / (d + 120);
    s += (100 - p.hp) * 0.4;
    if (p.hasGun && p.ammo.gun > 0) s += 30;
    if (p.hasLauncher && p.ammo.launcher > 0) s += 15;
    if (!p.visible) s -= 35;
    // 优先打圈外/即将出圈的
    if (state.zone.damagePerSecond > 0 && !collapse) {
      const pOut = Math.hypot(p.x - state.zone.x, p.y - state.zone.y) - state.zone.radius;
      if (pOut > -20) s += 25;
    }
    // 对方灌木计时快耗尽 → 快要露头，值得等
    if (p.hideLeft !== null && p.hideLeft !== undefined && p.hideLeft > 0 && p.hideLeft < 1.2) s += 15;
    if (d < 500) {
      const angToMe = Math.atan2(me.y - p.y, me.x - p.x);
      if (Math.abs(adiff(angToMe, p.facing)) < 0.35) s += 25;
    }
    if (s > bestScore) { bestScore = s; best = p; }
  }
  return best;
}

// ---------- 闪避（惯性补偿） ----------

function computeAvoid(state, me) {
  let ax = 0, ay = 0;
  const myR = R.player.radius;
  // 惯性窗口：从当前速度到目标速度大约要 0.3s，所以看一眼稍远一点的子弹
  const lookAhead = 0.65;

  for (let i = 0; i < state.bullets.length; i++) {
    const b = state.bullets[i];
    if (b.ownerId === me.id) continue;
    const speed = Math.hypot(b.vx, b.vy);
    if (speed < 1e-6) continue;
    const ux = b.vx / speed, uy = b.vy / speed;
    const rx = me.x - b.x, ry = me.y - b.y;
    const along = rx * ux + ry * uy;
    const tImpact = along / speed;
    if (tImpact < -0.02 || tImpact > lookAhead) continue;
    const side = rx * (-uy) + ry * ux;
    const danger = myR + b.radius + 10;
    const sideAbs = Math.abs(side);
    if (sideAbs > danger) continue;
    const s = side >= 0 ? 1 : -1;
    const tw = 1 - Math.max(0, tImpact) / lookAhead;
    const sw = 1 - sideAbs / danger;
    const strength = 3.2 * tw * sw;
    ax += -uy * s * strength;
    ay += ux * s * strength;
  }

  for (let i = 0; i < state.grenades.length; i++) {
    const g = state.grenades[i];
    if (g.ownerId === me.id) continue;
    const dx = me.x - g.x, dy = me.y - g.y;
    const d = Math.hypot(dx, dy);
    const danger = R.launcher.blastRadius + myR + 25;
    if (d < danger && d > 1e-6) {
      const w = ((danger - d) / danger) * 3.0;
      ax += (dx / d) * w;
      ay += (dy / d) * w;
    }
  }

  for (let i = 0; i < state.mines.length; i++) {
    const m = state.mines[i];
    const dx = me.x - m.x, dy = me.y - m.y;
    const d = Math.hypot(dx, dy);
    const danger = R.mines.blastRadius + myR + 15;
    if (d < danger && d > 1e-6) {
      const fuseW = m.fuse < 0.8 ? 5 : m.fuse < 1.6 ? 2.4 : 1.0;
      const w = ((danger - d) / danger) * fuseW;
      ax += (dx / d) * w;
      ay += (dy / d) * w;
    }
  }

  return { x: ax, y: ay };
}

// ---------- 攻击判断 ----------

function shouldAttack(state, me, target, weapon, aim) {
  if (!target || !target.alive) return false;
  if (me.weapon !== weapon) return false;
  if (me.cooldowns[weapon] > 0) return false;
  if (me.cooldowns.switch > 0) return false;

  const dx = target.x - me.x, dy = target.y - me.y;
  const d = Math.hypot(dx, dy);
  const facingErr = Math.abs(adiff(aim, me.facing));
  const fresh = target.visible || target.seenAgo < 0.35;

  if (weapon === 'gun') {
    if (me.ammo.gun <= 0) return false;
    if (facingErr > 0.10) return false;
    if (d > 700) return false;
    if (!fresh) return false;
    return hasLOS(me.x, me.y, target.x, target.y);
  }
  if (weapon === 'launcher') {
    if (me.ammo.launcher <= 0) return false;
    if (facingErr > 0.20) return false;
    const safe = (R.launcher.blastRadius + R.player.radius) / 0.6;
    if (d < safe) return false;
    if (d > R.launcher.range * 0.9) return false;
    if (!fresh) return false;
    return hasLOS(me.x, me.y, target.x, target.y);
  }
  if (weapon === 'knife') {
    const reach = 2 * R.player.radius + R.knife.reach;
    if (d > reach - 2) return false;
    const arcHalf = (R.knife.arcDegrees * PI / 180) * 0.5;
    if (facingErr > arcHalf - 0.08) return false;
    return hasLOS(me.x, me.y, target.x, target.y);
  }
  return false;
}

// ---------- 主循环 ----------

export function decide(state) {
  const me = state.self;
  if (!me.alive) return null;

  const t = state.time;
  const collapse = inCollapse(state.zone);

  // strafe 换向（惯性下周期拉长）
  if (t >= strafeFlipAt) {
    strafeDir = Math.random() < 0.5 ? -1 : 1;
    strafeFlipAt = t + 1.0 + Math.random() * 0.8;
  }
  // 卡墙：速度被墙吃掉后反向 strafe
  if (t > 0.8 && t > lastUnstuck + 0.5 && Math.hypot(me.vx, me.vy) < 35) {
    strafeDir = -strafeDir;
    strafeFlipAt = t + 1.2;
    lastUnstuck = t;
  }

  const target = pickTarget(state, me);
  const avoid = computeAvoid(state, me);
  const zone = zonePressure(state, me);
  const itemTarget = pickItem(state, me);

  let weapon = 'knife';
  if (me.hasGun && me.ammo.gun > 0) weapon = 'gun';
  else if (me.hasLauncher && me.ammo.launcher > 0) weapon = 'launcher';

  // 瞄准（提前量按弹速）
  let aim = me.facing;
  if (target) {
    const dx = target.x - me.x, dy = target.y - me.y;
    const d = Math.hypot(dx, dy);
    const fresh = target.visible || target.seenAgo < 0.4;
    if (weapon === 'knife' || !fresh) {
      aim = Math.atan2(dy, dx);
    } else {
      const speed = weapon === 'gun' ? R.gun.bulletSpeed : R.launcher.grenadeSpeed;
      const flight = Math.min(d / speed, 0.35);
      const px = target.x + target.vx * flight;
      const py = target.y + target.vy * flight;
      aim = Math.atan2(py - me.y, px - me.x);
    }
  }

  // 位移
  let mx = 0, my = 0;

  // 1) 安全区压力（坍缩时也是）
  mx += zone.x;
  my += zone.y;

  // 2) 与目标的理想距离
  const zoneR = state.zone.damagePerSecond > 0 ? Math.max(0, state.zone.radius) : 9999;
  const rangeCap = collapse ? 120 : Math.max(140, zoneR * 0.75);

  if (target && target.alive) {
    const dx = target.x - me.x, dy = target.y - me.y;
    const d = Math.hypot(dx, dy);
    const tox = dx / (d + 1e-6), toy = dy / (d + 1e-6);

    let idealMin, idealMax, radialW, strafeW;
    if (weapon === 'gun') {
      idealMin = collapse ? 80 : 200;
      idealMax = Math.min(collapse ? 280 : 420, rangeCap);
      radialW = 1.0; strafeW = 0.95;
      if (target.weapon === 'knife') idealMax = Math.min(480, rangeCap);
    } else if (weapon === 'launcher') {
      idealMin = collapse ? 120 : 200;
      idealMax = Math.min(collapse ? 320 : 450, rangeCap);
      radialW = 1.0; strafeW = 0.8;
    } else {
      idealMin = 0; idealMax = 55; radialW = 1.7; strafeW = 0.25;
    }

    let radial = 0;
    if (d > idealMax) radial = 1;
    else if (d < idealMin) radial = -1;

    const perpX = -toy * strafeDir, perpY = tox * strafeDir;
    mx += tox * radial * radialW;
    my += toy * radial * radialW;
    const inBand = radial === 0 ? 1 : 0.4;
    mx += perpX * strafeW * inBand;
    my += perpY * strafeW * inBand;
  }

  // 3) 多敌散开（持远程武器时才用）
  if (weapon !== 'knife') {
    let sx = 0, sy = 0;
    for (let i = 0; i < state.players.length; i++) {
      const p = state.players[i];
      if (p.id === me.id || !p.alive || !p.visible) continue;
      const dx = me.x - p.x, dy = me.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d < 300 && d > 1e-6) {
        const w = (300 - d) / 300 * 0.7;
        sx += (dx / d) * w;
        sy += (dy / d) * w;
      }
    }
    mx += sx; my += sy;
  }

  // 4) 捡物品 / 无枪时冲枪点
  if (itemTarget) {
    const dir = pathTo(me, itemTarget);
    const d = Math.hypot(itemTarget.x - me.x, itemTarget.y - me.y);
    let w = 0.5;
    if (!target) w = 1.6;
    else if (d < 140) w = 1.0;
    if (itemTarget.type === 'health' && me.hp < 40) w = 2.4;
    if (itemTarget.type === 'life') w = 2.0;
    mx += dir.x * w;
    my += dir.y * w;
  } else if (!me.hasGun && gunSpawns.length > 0) {
    let best = null, bestD = Infinity;
    for (let i = 0; i < gunSpawns.length; i++) {
      const g = gunSpawns[i];
      if (!pointSafeFromZone(state.zone, g.x, g.y, 3)) continue;
      const d = Math.hypot(g.x - me.x, g.y - me.y);
      if (d < bestD) { bestD = d; best = g; }
    }
    if (best) {
      const dir = pathTo(me, best);
      mx += dir.x * 1.2;
      my += dir.y * 1.2;
    }
  }

  // 5) 闪避
  if (Math.hypot(avoid.x, avoid.y) > 0.001) {
    mx += avoid.x * 0.95;
    my += avoid.y * 0.95;
  }

  // 6) 没有视线时绕墙（不能朝墙直冲）
  if (target && target.alive && !hasLOS(me.x, me.y, target.x, target.y)) {
    const around = pathTo(me, target);
    if (Math.hypot(mx, my) < 1.0) {
      mx += around.x * 1.2;
      my += around.y * 1.2;
    }
  }

  const move = norm({ x: mx, y: my });
  const attack = shouldAttack(state, me, target, weapon, aim);

  // 7) 布雷
  let plantMine = false;
  if (me.mines > 0 && me.cooldowns.mine <= 0 && target && target.alive) {
    const d = Math.hypot(target.x - me.x, target.y - me.y);
    let mineNearby = false;
    for (let i = 0; i < state.mines.length; i++) {
      const m = state.mines[i];
      if (Math.hypot(m.x - me.x, m.y - me.y) < 90) { mineNearby = true; break; }
    }
    if (!mineNearby) {
      if (d < 130 && target.weapon === 'knife') plantMine = true;
      else if (d < 180 && me.mines >= 2 && Math.random() < 0.25) plantMine = true;
      else if (collapse && me.mines >= 1 && d < 260 && Math.random() < 0.5) plantMine = true;
      else if (state.zone.damagePerSecond > 0 && state.zone.radius < 400
               && d < 260 && Math.random() < 0.4) plantMine = true;
    }
  }

  return { move, aim, attack, weapon, plantMine };
}