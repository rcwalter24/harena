// Harena high-win-rate bot: "Survivor"
// Strategy: survival first, pick off weakened targets, multi-weapon synergy,
// never force fights, always stay inside the zone, dodge everything dodgeable.
export const meta = { name: 'doubao', author: 'Doubao' };

let rules = null;
let walls = [];
let bushes = [];
let mapSize = { w: 0, h: 0 };
let strafeSign = 1;
let strafeFlipAt = 0;
let lastRetreatDir = null;

// ---------- geometry helpers ----------

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const dist2 = (a, b) => { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; };

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

// Segment vs rect slab test, grown by pad.
function segmentHitsRect(x0, y0, x1, y1, r, pad) {
  let tMin = 0, tMax = 1;
  const d = [x1 - x0, y1 - y0], p = [x0, y0];
  const lo = [r.x - pad, r.y - pad], hi = [r.x + r.w + pad, r.y + r.h + pad];
  for (let i = 0; i < 2; i++) {
    if (d[i] === 0) {
      if (p[i] < lo[i] || p[i] > hi[i]) return false;
    } else {
      let t1 = (lo[i] - p[i]) / d[i], t2 = (hi[i] - p[i]) / d[i];
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) return false;
    }
  }
  return true;
}

function clearShot(a, b, pad) {
  for (const w of walls) if (segmentHitsRect(a.x, a.y, b.x, b.y, w, pad)) return false;
  return true;
}

function walkable(a, b) {
  for (const w of walls) if (segmentHitsRect(a.x, a.y, b.x, b.y, w, rules.player.radius - 2)) return false;
  return true;
}

// Simple wall-avoiding direction: head straight if clear, else go around the blocker's corner.
function pathTo(me, goal) {
  const straight = normalize({ x: goal.x - me.x, y: goal.y - me.y });
  if (walkable(me, goal)) return straight;
  const r = rules.player.radius;
  let blocker = null, bd = Infinity;
  for (const w of walls) {
    if (segmentHitsRect(me.x, me.y, goal.x, goal.y, w, r - 2)) {
      const c = { x: w.x + w.w / 2, y: w.y + w.h / 2 };
      const d = dist(me, c);
      if (d < bd) { bd = d; blocker = w; }
    }
  }
  if (!blocker) return straight;
  const m = r + 12;
  const corners = [
    { x: blocker.x - m, y: blocker.y - m },
    { x: blocker.x + blocker.w + m, y: blocker.y - m },
    { x: blocker.x - m, y: blocker.y + blocker.h + m },
    { x: blocker.x + blocker.w + m, y: blocker.y + blocker.h + m },
  ].filter(c => c.x > r && c.y > r && c.x < mapSize.w - r && c.y < mapSize.h - r);
  const onward = (c) => {
    if (walkable(c, goal)) return dist(c, goal);
    let best = 1e4;
    for (const c2 of corners) {
      if (c2 !== c && walkable(c, c2) && walkable(c2, goal)) best = Math.min(best, dist(c, c2) + dist(c2, goal));
    }
    return best;
  };
  let best = null, bestCost = Infinity;
  for (const c of corners) {
    if (dist(c, me) <= 8) continue;
    const cost = dist(me, c) + onward(c) + (walkable(me, c) ? 0 : 1e4);
    if (cost < bestCost) { bestCost = cost; best = c; }
  }
  return best ? normalize({ x: best.x - me.x, y: best.y - me.y }) : straight;
}

// ---------- zone ----------

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
  const zone = state.zone;
  if (zone.damagePerSecond === 0) return { x: 0, y: 0 };
  const d = dist(me, zone);
  // Pull 2.5 s ahead so we don't get caught by the shrink.
  const slack = zoneRadiusIn(zone, 2.5) - rules.player.radius - 40 - d;
  if (slack > 0 || d < 1e-6) return { x: 0, y: 0 };
  const k = Math.min(3, 0.6 - slack / 50);
  const dir = pathTo(me, zone);
  return { x: dir.x * k, y: dir.y * k };
}

// ---------- threat avoidance ----------

function dodgeVector(state, me) {
  let dx = 0, dy = 0;
  // Bullets
  for (const b of state.bullets) {
    if (b.ownerId === me.id) continue;
    const sp = Math.hypot(b.vx, b.vy) || 1;
    const ux = b.vx / sp, uy = b.vy / sp;
    const rx = me.x - b.x, ry = me.y - b.y;
    const along = rx * ux + ry * uy;
    if (along < 0 || along > sp * 1.2) continue;
    const side = rx * -uy + ry * ux;
    const danger = rules.player.radius + b.radius + 14;
    if (Math.abs(side) > danger) continue;
    const s = side >= 0 ? 1 : -1;
    const w = 1 - along / (sp * 1.2);
    dx += -uy * s * w * 1.5;
    dy += ux * s * w * 1.5;
  }
  // Grenades (will explode)
  for (const g of state.grenades) {
    if (g.ownerId === me.id) continue;
    const d = dist(g, me);
    const safe = rules.launcher.blastRadius + rules.player.radius + 30;
    if (d < safe) {
      const away = d > 1e-6 ? { x: (me.x - g.x) / d, y: (me.y - g.y) / d } : { x: 1, y: 0 };
      const urg = (safe - d) / safe;
      dx += away.x * urg * 3;
      dy += away.y * urg * 3;
    }
  }
  return { x: dx, y: dy };
}

function mineEscape(state, me) {
  let dx = 0, dy = 0;
  const reach = rules.mines.blastRadius + rules.player.radius + 25;
  for (const m of state.mines) {
    const d = dist(m, me);
    if (d > reach || m.fuse > 1.8) continue;
    const away = d > 1e-6 ? { x: (me.x - m.x) / d, y: (me.y - m.y) / d } : { x: 1, y: 0 };
    const urg = 1 + (1.8 - m.fuse) * 1.5;
    dx += away.x * urg * 2.5;
    dy += away.y * urg * 2.5;
  }
  return { x: dx, y: dy };
}

// Dodge charging lasers: get off the warning line early.
function laserDodge(state, me) {
  let dx = 0, dy = 0;
  for (const l of state.lasers) {
    if (l.ownerId === me.id) continue;
    // The path is a polyline from shooter; check distance from me to each segment.
    for (let i = 0; i + 1 < l.path.length; i++) {
      const a = l.path[i], b = l.path[i + 1];
      const abx = b.x - a.x, aby = b.y - a.y;
      const len2 = abx * abx + aby * aby;
      if (len2 < 1e-6) continue;
      const t = Math.max(0, Math.min(1, ((me.x - a.x) * abx + (me.y - a.y) * aby) / len2));
      const cx = a.x + t * abx, cy = a.y + t * aby;
      const d = Math.hypot(me.x - cx, me.y - cy);
      const danger = rules.player.radius + rules.laser.beamRadius + 10;
      if (d < danger + l.charge * 100) {
        // Push perpendicular off the line.
        const nx = -aby / Math.sqrt(len2), ny = abx / Math.sqrt(len2);
        const side = ((me.x - a.x) * ny - (me.y - a.y) * nx);
        const s = side >= 0 ? 1 : -1;
        const urg = (danger + l.charge * 100 - d) / danger;
        dx += nx * s * urg * 3;
        dy += ny * s * urg * 3;
      }
    }
  }
  return { x: dx, y: dy };
}

// ---------- target selection ----------

// Score a potential target: higher = better to attack.
function scoreTarget(state, me, t) {
  let s = 1000 / (dist(t, me) + 1);
  // Prefer weakened targets.
  const threat = t.hp + t.shield;
  s += (200 - threat) * 1.5;
  // Prefer fewer lives.
  s += (5 - t.lives) * 30;
  // Visible bonus.
  if (!t.visible) s -= 500;
  // Penalise targets that are far away or have cover.
  if (!clearShot(me, t, rules.gun.bulletRadius)) s -= 300;
  // Don't pick a target that another enemy is already shooting at (let them duel).
  for (const o of state.players) {
    if (o.id === me.id || o.id === t.id || !o.alive) continue;
    if (o.visible && dist(o, t) < 250 && dist(o, me) > 200) { s -= 80; break; }
  }
  // Don't attack someone who is already nearly dead to the zone (nobody gets the kill).
  return s;
}

function bestTarget(state, me) {
  let best = null, bs = -Infinity;
  for (const p of state.players) {
    if (p.id === me.id || !p.alive || p.eliminated) continue;
    const s = scoreTarget(state, me, p);
    if (s > bs) { bs = s; best = p; }
  }
  return best;
}

// Count how many alive enemies are near me.
function nearbyEnemies(state, me, radius) {
  let n = 0;
  for (const p of state.players) {
    if (p.id === me.id || !p.alive) continue;
    if (dist(p, me) < radius) n++;
  }
  return n;
}

// ---------- items ----------

function wantItem(me, it) {
  switch (it.type) {
    case 'health': return me.hp < rules.player.maxHp * 0.75;
    case 'shield': return me.shield < rules.player.maxShield * 0.8;
    case 'life': return me.lives < rules.player.maxLives;
    case 'gun': return !me.hasGun || me.ammo.gun < rules.gun.maxAmmo;
    case 'ammo': return me.hasGun && me.ammo.gun < rules.gun.maxAmmo;
    case 'launcher': return !me.hasLauncher || me.ammo.launcher < rules.launcher.maxAmmo;
    case 'laser': return !me.hasLaser || me.ammo.laser < rules.laser.maxAmmo;
    case 'mines': return me.mines < rules.mines.maxCarry;
    case 'smoke': return me.smokeGrenades < rules.smoke.maxCarry;
    case 'gas': return me.gasGrenades < rules.gas.maxCarry;
  }
  return false;
}

function bestItem(state, me) {
  const zoneSoon = zoneRadiusIn(state.zone, 2.5) - 20;
  let best = null, bs = -Infinity;
  for (const it of state.items) {
    if (!wantItem(me, it)) continue;
    if (state.zone.damagePerSecond > 0 && dist(it, state.zone) > zoneSoon) continue;
    const d = dist(it, me);
    // Weight by desirability.
    let w = 1000 / (d + 1);
    if (it.type === 'health' && me.hp < 40) w += 500;
    if (it.type === 'shield' && me.shield < 30) w += 300;
    if (it.type === 'gun' && !me.hasGun) w += 600;
    if (it.type === 'life') w += 200;
    if (w > bs) { bs = w; best = it; }
  }
  return best;
}

// ---------- init ----------

export function init(info) {
  rules = info.rules;
  walls = info.map.walls;
  bushes = info.map.bushes;
  mapSize = { w: info.map.width, h: info.map.height };
}

// ---------- decide ----------

export function decide(state) {
  const me = state.self;
  if (!me.alive) return null;

  const enemy = bestTarget(state, me);
  const dodge = dodgeVector(state, me);
  const escape = mineEscape(state, me);
  const lasDod = laserDodge(state, me);
  const zone = zonePull(state, me);
  const avoid = {
    x: dodge.x * 2 + escape.x * 2.5 + lasDod.x * 2.5 + zone.x,
    y: dodge.y * 2 + escape.y * 2.5 + lasDod.y * 2.5 + zone.y,
  };

  const item = bestItem(state, me);
  const nearCount = nearbyEnemies(state, me, 300);
  const lowHp = me.hp + me.shield < 50;
  const veryLowHp = me.hp < 30;

  // ---- Weapon selection ----
  const canGun = me.hasGun && me.ammo.gun > 0;
  const canLauncher = me.hasLauncher && me.ammo.launcher > 0;
  const canLaser = me.hasLaser && me.ammo.laser > 0 && me.cooldowns.laser <= 0;

  let weapon = 'knife';
  if (canGun) weapon = 'gun';
  if (canLauncher && enemy && dist(enemy, me) > 150 && dist(enemy, me) < 600 && me.ammo.gun <= 5) weapon = 'launcher';
  if (canLaser && enemy && dist(enemy, me) > 300 && dist(enemy, me) < 800 && !veryLowHp) weapon = 'laser';

  // ---- Retreatment logic ----
  // If very low HP and a gun enemy is nearby, disengage.
  if (veryLowHp && enemy && dist(enemy, me) < 350 && me.invulnerable <= 0) {
    // Run away from enemy, toward item or zone centre.
    const away = enemy ? normalize({ x: me.x - enemy.x, y: me.y - enemy.y }) : { x: 0, y: 0 };
    const goal = item && dist(item, me) < dist(enemy, me) ? item : state.zone;
    const toward = pathTo(me, goal);
    const move = normalize({
      x: away.x * 1.5 + toward.x * 0.8 + avoid.x,
      y: away.y * 1.5 + toward.y * 0.8 + avoid.y,
    });
    // Throw smoke to break line of sight if multiple enemies near.
    let throwSmoke = false;
    if (me.smokeGrenades > 0 && me.cooldowns.throw <= 0 && nearCount >= 2) throwSmoke = true;
    // Plant a mine behind us if chased.
    const plantMine = me.mines > 0 && dist(enemy, me) < 150 && me.cooldowns.mine <= 0 &&
      !state.mines.some(m => dist(m, me) < 120);
    // Knife anyone who gets on top of us while we run.
    const knifeReach = 2 * rules.player.radius + rules.knife.reach;
    const kAngle = Math.atan2(enemy.y - me.y, enemy.x - me.x);
    const knifeHit = dist(enemy, me) <= knifeReach && Math.abs(angleDiff(kAngle, me.facing)) < 0.6;
    return {
      move,
      aim: kAngle,
      attack: knifeHit,
      weapon: 'knife',
      throw: throwSmoke ? 'smoke' : undefined,
      throwDistance: throwSmoke ? 180 : undefined,
      plantMine,
    };
  }

  // ---- No enemy ----
  if (!enemy) {
    const goal = item || state.zone;
    const toward = pathTo(me, goal);
    return {
      move: normalize({ x: toward.x + avoid.x, y: toward.y + avoid.y }),
      weapon,
    };
  }

  // ---- Have enemy: engage or kite ----
  const d = dist(enemy, me);
  const toward = normalize({ x: enemy.x - me.x, y: enemy.y - me.y });

  // Desired range depends on weapon.
  let desiredMin = 260, desiredMax = 400;
  if (weapon === 'launcher') { desiredMin = 200; desiredMax = 600; }
  if (weapon === 'laser') { desiredMin = 350; desiredMax = 800; }
  if (weapon === 'knife') { desiredMin = 0; desiredMax = 70; }

  let radial = 0;
  if (d > desiredMax) radial = 1;
  else if (d < desiredMin) radial = -1;

  // Strafing.
  if (state.time >= strafeFlipAt) {
    strafeSign = Math.random() < 0.5 ? -1 : 1;
    strafeFlipAt = state.time + 0.7 + Math.random() * 0.6;
  }
  if (Math.hypot(me.vx, me.vy) < 40 && state.time > 0.3) strafeSign = -strafeSign;
  const strafe = { x: -toward.y * strafeSign, y: toward.x * strafeSign };

  // Grab a nearby item if it doesn't detour too much.
  let detour = { x: 0, y: 0 };
  if (item && dist(item, me) < 180 && walkable(me, item) && !lowHp) {
    detour = normalize({ x: item.x - me.x, y: item.y - me.y });
  }
  if (lowHp && item && (item.type === 'health' || item.type === 'shield')) {
    detour = normalize({ x: item.x - me.x, y: item.y - me.y });
    radial = -1; // run to item
  }

  // No line of sight: walk around wall.
  const inSight = clearShot(me, enemy, rules.gun.bulletRadius);
  let move;
  if (!inSight && weapon !== 'knife') {
    const around = pathTo(me, enemy);
    move = normalize({ x: around.x + avoid.x, y: around.y + avoid.y });
  } else {
    move = normalize({
      x: toward.x * radial + strafe.x * 0.7 + detour.x * 0.8 + avoid.x,
      y: toward.y * radial + strafe.y * 0.7 + detour.y * 0.8 + avoid.y,
    });
  }

  // ---- Aim with lead ----
  const bulletSpeed = weapon === 'gun' ? rules.gun.bulletSpeed : rules.launcher.grenadeSpeed;
  const flight = d / bulletSpeed;
  const lead = { x: enemy.x + enemy.vx * flight, y: enemy.y + enemy.vy * flight };
  const aim = Math.atan2(lead.y - me.y, lead.x - me.x);
  const onTarget = Math.abs(angleDiff(aim, me.facing)) < 0.1;
  const fresh = enemy.visible || enemy.seenAgo < 0.4;

  // ---- Attack ----
  let attack = false;
  if (me.weapon === weapon && me.cooldowns.switch <= 0 && onTarget && fresh) {
    if (weapon === 'gun') {
      attack = d < rules.gun.range * 0.85 && clearShot(me, lead, rules.gun.bulletRadius);
    } else if (weapon === 'launcher') {
      const safe = rules.launcher.blastRadius + rules.player.radius + 50;
      attack = d > safe && d < rules.launcher.range * 0.95 && clearShot(me, lead, rules.launcher.grenadeRadius);
    } else if (weapon === 'laser') {
      // Only fire if the target is roughly on a straight line and we won't suicide.
      attack = d < rules.laser.range && clearShot(me, lead, rules.laser.beamRadius + rules.player.radius);
    } else if (weapon === 'knife') {
      const reach = 2 * rules.player.radius + rules.knife.reach;
      attack = d <= reach;
    }
  }

  // ---- Tactical items ----
  let throwCmd = undefined;
  let throwDist = undefined;
  // Gas grenade: if enemy is fleeing and we have line, toss on their escape path.
  if (me.gasGrenades > 0 && me.cooldowns.throw <= 0 && enemy && d > 120 && d < 300 &&
      (enemy.hp + enemy.shield) < 80 && me.hp > 50) {
    throwCmd = 'gas';
    throwDist = Math.min(250, d);
  }
  // Smoke: if we're being swarmed and need to escape.
  if (me.smokeGrenades > 0 && me.cooldowns.throw <= 0 && nearCount >= 2 && lowHp) {
    throwCmd = 'smoke';
    throwDist = 150;
  }

  // Mine: if enemy is chasing us (they're close and we're kiting).
  const plantMine = me.mines > 0 && d < 130 && d > 60 && me.cooldowns.mine <= 0 &&
    !state.mines.some(m => dist(m, me) < 130) && enemy && enemy.weapon !== 'knife';

  return {
    move,
    aim,
    attack,
    weapon,
    throw: throwCmd,
    throwDistance: throwDist,
    plantMine,
  };
}
