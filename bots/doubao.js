// Apex: a survival-focused FFA arena bot for Harena.
// Strategy: grab a gun fast, pick off weakened enemies, dodge projectiles,
// manage the safe zone, disengage when outmatched, and finish the rest.
export const meta = { name: 'Apex', author: 'doubao' };

let rules = null;
let walls = [];
let mapW = 0, mapH = 0;
let strafeSign = 1;
let strafeFlipAt = 0;
let stuckTime = 0; // seconds we've been crawling (for wall-stuck detection)

export function init(info) {
  rules = info.rules;
  walls = info.map.walls || [];
  mapW = info.map.width;
  mapH = info.map.height;
}

// ---------- geometry helpers ----------
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function angleDiff(a, b) {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

function norm(v) {
  const l = Math.hypot(v.x, v.y);
  return l > 1e-9 ? { x: v.x / l, y: v.y / l } : { x: 0, y: 0 };
}

function segRect(x0, y0, x1, y1, r, pad) {
  let t0 = 0, t1 = 1;
  const d = [x1 - x0, y1 - y0];
  const p = [x0, y0];
  const lo = [r.x - pad, r.y - pad];
  const hi = [r.x + r.w + pad, r.y + r.h + pad];
  for (let i = 0; i < 2; i++) {
    if (d[i] === 0) {
      if (p[i] < lo[i] || p[i] > hi[i]) return false;
    } else {
      let a = (lo[i] - p[i]) / d[i];
      let b = (hi[i] - p[i]) / d[i];
      if (a > b) { const t = a; a = b; b = t; }
      t0 = Math.max(t0, a);
      t1 = Math.min(t1, b);
      if (t0 > t1) return false;
    }
  }
  return true;
}

function los(a, b, pad) {
  return !walls.some(w => segRect(a.x, a.y, b.x, b.y, w, pad || 0));
}

function walkable(a, b) {
  return !walls.some(w => segRect(a.x, a.y, b.x, b.y, w, rules.player.radius - 2));
}

function pathTo(me, goal) {
  const straight = norm({ x: goal.x - me.x, y: goal.y - me.y });
  if (walkable(me, goal)) return straight;
  const r = rules.player.radius;
  const blocker = walls
    .filter(w => segRect(me.x, me.y, goal.x, goal.y, w, r - 2))
    .sort((a, b) => dist(me, { x: a.x + a.w / 2, y: a.y + a.h / 2 }) - dist(me, { x: b.x + b.w / 2, y: b.y + b.h / 2 }))[0];
  if (!blocker) return straight;
  const m = r + 12;
  const corners = [
    { x: blocker.x - m, y: blocker.y - m },
    { x: blocker.x + blocker.w + m, y: blocker.y - m },
    { x: blocker.x - m, y: blocker.y + blocker.h + m },
    { x: blocker.x + blocker.w + m, y: blocker.y + blocker.h + m },
  ].filter(c => c.x > r && c.y > r && c.x < mapW - r && c.y < mapH - r && dist(c, me) > 8);
  let best = null, bestCost = Infinity;
  for (const c of corners) {
    const cost = dist(me, c) + dist(c, goal) + (walkable(me, c) ? 0 : 1000);
    if (cost < bestCost) { bestCost = cost; best = c; }
  }
  return best ? norm({ x: best.x - me.x, y: best.y - me.y }) : straight;
}

// ---------- threat avoidance ----------
function dodgeVec(state, me) {
  let dx = 0, dy = 0;
  for (const b of state.bullets) {
    if (b.ownerId === me.id) continue;
    const sp = Math.hypot(b.vx, b.vy) || 1;
    const ux = b.vx / sp, uy = b.vy / sp;
    const rx = me.x - b.x, ry = me.y - b.y;
    const along = rx * ux + ry * uy;
    // Inertia: we need ~0.4-0.5s of sidestep to clear a bullet, so react early.
    if (along < 0 || along > sp * 1.5) continue;
    const side = rx * -uy + ry * ux;
    const danger = rules.player.radius + b.radius + 16;
    if (Math.abs(side) > danger) continue;
    const s = side >= 0 ? 1 : -1;
    // Weight ramps up as the bullet closes in.
    const w = 1.5 - along / (sp * 1.5);
    dx += -uy * s * w;
    dy += ux * s * w;
  }
  for (const g of state.grenades) {
    if (g.ownerId === me.id) continue;
    const d = dist(g, me);
    if (d < rules.launcher.blastRadius + rules.player.radius + 60) {
      const away = d > 1e-6 ? norm({ x: me.x - g.x, y: me.y - g.y }) : { x: 1, y: 0 };
      dx += away.x * 1.5;
      dy += away.y * 1.5;
    }
  }
  return { x: dx, y: dy };
}

function mineEscape(state, me) {
  let dx = 0, dy = 0;
  const reach = rules.mines.blastRadius + rules.player.radius + 25;
  for (const m of state.mines) {
    const d = dist(m, me);
    if (d > reach || m.fuse > 1.6) continue;
    const away = d > 1e-6 ? norm({ x: me.x - m.x, y: me.y - m.y }) : { x: 1, y: 0 };
    const urg = 1 + (1.6 - m.fuse) * 1.5;
    dx += away.x * urg;
    dy += away.y * urg;
  }
  return { x: dx, y: dy };
}

function zoneRadiusIn(zone, t) {
  if (zone.collapseStartsIn !== null && t >= zone.collapseStartsIn) {
    const ct = zone.collapseEndsIn - zone.collapseStartsIn;
    const from = zone.collapseStartsIn > 0 ? zone.finalRadius : zone.radius;
    return ct <= 0 || t >= zone.collapseEndsIn ? 0 : from * (1 - (t - zone.collapseStartsIn) / ct);
  }
  const st = zone.shrinkEndsIn - zone.shrinkStartsIn;
  if (st <= 0) return zone.radius;
  const el = Math.max(0, t - zone.shrinkStartsIn);
  return zone.radius - (zone.radius - zone.finalRadius) * Math.min(1, el / st);
}

function zonePull(state, me) {
  const z = state.zone;
  if (z.damagePerSecond === 0) return { x: 0, y: 0 };
  const d = dist(me, z);
  const futureR = zoneRadiusIn(z, 3);
  const slack = futureR - rules.player.radius - 40 - d;
  if (slack > 0) return { x: 0, y: 0 };
  const k = Math.min(3.5, 0.8 - slack / 40);
  const dir = pathTo(me, z);
  return { x: dir.x * k, y: dir.y * k };
}

// ---------- target & item selection ----------
function pickTarget(state, me) {
  let best = null, bestScore = -Infinity;
  for (const p of state.players) {
    if (p.id === me.id || !p.alive) continue;
    const d = dist(p, me);
    let score = 0;
    score -= d * 0.5;
    if (!p.visible) score -= 600;
    if (p.invulnerable > 0) score -= 400;
    score -= (p.hp + p.shield) * 1.5;
    score -= p.lives * 15;
    if (p.hp <= 35) score += 250; // execute
    const canSee = p.visible && los(me, p, rules.player.radius);
    if (!canSee) score -= 150;
    if (d > 600) score -= (d - 600) * 0.5;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}

function itemScore(it, me) {
  switch (it.type) {
    case 'health': return me.hp < 40 ? 250 : me.hp < 70 ? 90 : 0;
    case 'shield': return me.shield < 30 ? 200 : me.shield < 70 ? 70 : 0;
    case 'life': return me.lives <= 1 ? 300 : me.lives < 3 ? 100 : 0;
    case 'gun': return !me.hasGun ? 350 : 0;
    case 'ammo': return me.hasGun && me.ammo.gun < 15 ? 120 : 0;
    case 'launcher': return !me.hasLauncher ? 70 : 0;
    case 'mines': return me.mines === 0 ? 50 : 0;
  }
  return 0;
}

function wantItems(state, me) {
  const useful = (it) => {
    if (it.type === 'health') return me.hp < 100;
    if (it.type === 'shield') return me.shield < 100;
    if (it.type === 'life') return me.lives < rules.player.maxLives;
    if (it.type === 'gun') return !me.hasGun || me.ammo.gun < rules.gun.maxAmmo;
    if (it.type === 'ammo') return me.hasGun && me.ammo.gun < rules.gun.maxAmmo;
    if (it.type === 'launcher') return !me.hasLauncher || me.ammo.launcher < rules.launcher.maxAmmo;
    if (it.type === 'mines') return me.mines < rules.mines.maxCarry;
    return false;
  };
  const futureR = zoneRadiusIn(state.zone, 3) - 20;
  const safe = (it) => state.zone.damagePerSecond === 0 || dist(it, state.zone) < futureR;
  return state.items
    .filter(it => useful(it) && safe(it))
    .sort((a, b) => (dist(a, me) - itemScore(a, me)) - (dist(b, me) - itemScore(b, me)));
}

// ---------- main decision ----------
export function decide(state) {
  const me = state.self;
  if (!me.alive) return null;

  const dodge = dodgeVec(state, me);
  const escape = mineEscape(state, me);
  const zpull = zonePull(state, me);
  const threat = {
    x: dodge.x * 2.8 + escape.x * 3 + zpull.x,
    y: dodge.y * 2.8 + escape.y * 3 + zpull.y,
  };

  const enemies = state.players.filter(p => p.id !== me.id && p.alive);
  const aliveCount = enemies.length + 1;
  const target = pickTarget(state, me);
  const items = wantItems(state, me);

  // choose weapon: gun primary, launcher when gun nearly dry, knife fallback
  let weapon = 'knife';
  if (me.hasGun && me.ammo.gun > 0) weapon = 'gun';
  if ((!me.hasGun || me.ammo.gun <= 3) && me.hasLauncher && me.ammo.launcher > 0) weapon = 'launcher';

  // Spawn invulnerability: reposition, do NOT attack (attack ends invuln early)
  if (me.invulnerable > 0.2) {
    const goal = items[0] || state.zone;
    const dir = pathTo(me, goal);
    return { move: norm({ x: dir.x + threat.x, y: dir.y + threat.y }), weapon: 'knife', attack: false };
  }

  // No enemies left alive: collect loot and sit in the zone.
  if (!target) {
    const goal = items[0] || state.zone;
    const dir = pathTo(me, goal);
    return { move: norm({ x: dir.x + threat.x, y: dir.y + threat.y }), weapon };
  }

  const d = dist(target, me);
  const toward = norm({ x: target.x - me.x, y: target.y - me.y });
  const knifeReach = 2 * rules.player.radius + rules.knife.reach; // 68

  const myTotal = me.hp + me.shield;
  const enemyTotal = target.hp + target.shield;

  // Unarmed: rush a gun, knife anyone who gets in our face.
  if (weapon === 'knife') {
    if (d < knifeReach + 25 && target.visible) {
      const aim = Math.atan2(target.y - me.y, target.x - me.x);
      const swing = d <= knifeReach && Math.abs(angleDiff(aim, me.facing)) < 0.9 && me.cooldowns.knife <= 0;
      return {
        move: norm({ x: toward.x + threat.x, y: toward.y + threat.y }),
        aim, attack: swing, weapon: 'knife',
      };
    }
    const goal = items[0] || state.zone;
    const dir = pathTo(me, goal);
    return { move: norm({ x: dir.x + threat.x, y: dir.y + threat.y }), weapon: 'knife' };
  }

  // Disengage when outmatched or low: heal up, don't trade 1-for-1.
  const needHeal = myTotal < 60;
  const unfavorable = myTotal < enemyTotal * 0.6 && myTotal < 90 && d > 150;
  if (needHeal || unfavorable) {
    const healItem = items.find(it => it.type === 'health' || it.type === 'shield' || it.type === 'life');
    if (healItem) {
      const dir = pathTo(me, healItem);
      return { move: norm({ x: dir.x + threat.x, y: dir.y + threat.y }), weapon };
    }
    const dir = pathTo(me, state.zone);
    return { move: norm({ x: dir.x + threat.x, y: dir.y + threat.y }), weapon };
  }

  // Armed combat: engagement ranges tighten late / 1v1.
  // Inertia means we can't instantly back off, so keep a bit more breathing room.
  const aggressive = aliveCount <= 2 || state.time > 130;
  const idealDist = weapon === 'gun' ? (aggressive ? 240 : 320) : 220;
  const minDist = weapon === 'gun' ? (aggressive ? 180 : 230) : 140;
  const maxDist = weapon === 'gun' ? 700 : 500;

  let radial = 0;
  if (d > maxDist) radial = 1;
  else if (d < minDist) radial = -1;

  // Strafe perpendicular to the line of fire.
  // Inertia costs ~0.3s to accelerate and ~0.6s to reverse, so hold a strafe
  // direction for a long time; flipping constantly leaves us a slow, easy target.
  if (state.time >= strafeFlipAt) {
    strafeSign = Math.random() < 0.5 ? -1 : 1;
    strafeFlipAt = state.time + 1.5 + Math.random() * 1.0;
    stuckTime = 0;
  }
  // Only treat low speed as "stuck on a wall" after it persists ~0.4s; right after
  // a strafe flip we're naturally slow while accelerating the other way.
  const spd = Math.hypot(me.vx, me.vy);
  if (spd < 50 && state.time > 0.3) {
    stuckTime += 1 / 30;
    if (stuckTime > 0.4) { strafeSign = -strafeSign; stuckTime = 0; }
  } else {
    stuckTime = 0;
  }
  const strafe = { x: -toward.y * strafeSign, y: toward.x * strafeSign };

  // Detour for a nearby useful item.
  const nearbyItem = items.find(it => dist(it, me) < 130 && walkable(me, it));
  const detour = nearbyItem ? norm({ x: nearbyItem.x - me.x, y: nearbyItem.y - me.y }) : { x: 0, y: 0 };

  const losPad = weapon === 'gun' ? rules.gun.bulletRadius : rules.launcher.grenadeRadius;
  const canSee = target.visible && los(me, target, losPad);

  let move;
  if (!canSee) {
    const around = pathTo(me, target);
    move = norm({ x: around.x + threat.x, y: around.y + threat.y });
  } else {
    move = norm({
      x: toward.x * radial + strafe.x * 0.8 + detour.x + threat.x,
      y: toward.y * radial + strafe.y * 0.8 + detour.y + threat.y,
    });
  }

  // Lead the target: aim where they will be when the projectile arrives.
  const speed = weapon === 'gun' ? rules.gun.bulletSpeed : rules.launcher.grenadeSpeed;
  const flight = d / speed;
  const lead = { x: target.x + target.vx * flight, y: target.y + target.vy * flight };
  const aim = Math.atan2(lead.y - me.y, lead.x - me.x);
  const onTarget = Math.abs(angleDiff(aim, me.facing)) < 0.12;

  let attack = false;
  const fresh = target.visible || target.seenAgo < 0.5;
  if (me.weapon === weapon && onTarget && fresh && target.invulnerable <= 0 && me.cooldowns.switch <= 0) {
    if (weapon === 'gun') {
      attack = d < rules.gun.range * 0.85 && los(me, lead, rules.gun.bulletRadius);
    } else {
      const safe = rules.launcher.blastRadius + rules.player.radius + 40;
      attack = d > safe && d < rules.launcher.range && los(me, lead, rules.launcher.grenadeRadius);
    }
  }

  // Drop a mine when someone is chasing us down.
  const plantMine = me.mines > 0 && d < 110 && me.cooldowns.mine <= 0 &&
    !state.mines.some(m => dist(m, me) < 150);

  return { move, aim, attack, weapon, plantMine };
}
