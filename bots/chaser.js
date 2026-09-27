// Chaser: runs straight at the nearest living enemy and stabs it with the knife.
export const meta = { name: 'Chaser', author: 'Harena examples' };

let rules = null;
let sidestep = 0; // seconds of sidestepping left after getting stuck on a wall
let sideSign = 1;

export function init(info) {
  rules = info.rules;
}

function angleDiff(a, b) {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

export function decide(state) {
  const me = state.self;
  if (!me.alive) return null;

  let target = null;
  let best = Infinity;
  for (const p of state.players) {
    if (p.id === me.id || !p.alive) continue;
    const d = Math.hypot(p.x - me.x, p.y - me.y);
    if (d < best) {
      best = d;
      target = p;
    }
  }
  if (!target) return null;

  const dx = target.x - me.x;
  const dy = target.y - me.y;
  const angle = Math.atan2(dy, dx);
  let move = { x: dx / best, y: dy / best };

  // If we're pushing but barely moving, a wall is in the way: slide sideways for a moment.
  const dt = 1 / rules.tickRate;
  if (sidestep > 0) {
    sidestep -= dt;
    move = { x: -move.y * sideSign, y: move.x * sideSign };
  } else if (Math.hypot(me.vx, me.vy) < 30 && best > 60 && state.time > 0.3) {
    sidestep = 0.6;
    sideSign = Math.random() < 0.5 ? 1 : -1;
  }

  const reach = 2 * rules.player.radius + rules.knife.reach;
  const halfArc = (rules.knife.arcDegrees / 2) * (Math.PI / 180);
  const attack = best <= reach && Math.abs(angleDiff(angle, me.facing)) < halfArc;
  return { move, aim: angle, attack, weapon: 'knife' };
}
