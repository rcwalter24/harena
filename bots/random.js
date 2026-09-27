// Random walker: wanders in random directions and swings the knife at anyone close.
export const meta = { name: 'Random', author: 'Harena examples' };

let dir = { x: 1, y: 0 };
let changeAt = 0;
let rules = null;

export function init(info) {
  rules = info.rules;
}

export function decide(state) {
  const me = state.self;
  if (!me.alive) return null;

  // Pick a new direction every 0.5–2 s, or right away when stuck against a wall.
  const stuck = Math.hypot(me.vx, me.vy) < 20 && state.time > 0.2;
  if (state.time >= changeAt || stuck) {
    const angle = Math.random() * Math.PI * 2;
    dir = { x: Math.cos(angle), y: Math.sin(angle) };
    changeAt = state.time + 0.5 + Math.random() * 1.5;
  }

  // Swing at the nearest enemy if it is within knife reach.
  let aim = Math.atan2(dir.y, dir.x);
  let attack = false;
  const reach = 2 * rules.player.radius + rules.knife.reach;
  for (const p of state.players) {
    if (p.id === me.id || !p.alive) continue;
    const d = Math.hypot(p.x - me.x, p.y - me.y);
    if (d < reach + 40) {
      aim = Math.atan2(p.y - me.y, p.x - me.x);
      attack = d < reach;
      break;
    }
  }
  return { move: dir, aim, attack, weapon: 'knife' };
}
