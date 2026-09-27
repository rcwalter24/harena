export function init() {}
export function decide(state) {
  if (state.tick === 0) return { move: { x: 0, y: 1 } };
  throw new Error('boom');
}
