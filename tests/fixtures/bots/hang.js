export function init() {}
export function decide(state) {
  if (state.tick >= 1) while (true) { /* never returns */ }
  return { move: { x: 1, y: 0 } };
}
