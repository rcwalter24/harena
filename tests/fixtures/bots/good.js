// Moves right, counts ticks in module state, and reports it via console.log.
let ticks = 0;
let selfId = -1;
export function init(info) {
  selfId = info.selfId;
}
export function decide(state) {
  ticks++;
  if (state.tick === 1) console.log('ticks', ticks, 'self', selfId, state.self.id, 'rand', Math.random());
  return { move: { x: 1, y: 0 }, aim: 0, attack: false };
}
