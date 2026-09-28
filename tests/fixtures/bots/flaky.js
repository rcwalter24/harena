// Slow for ticks 2..4, fine otherwise: tests fallback and recovery.
export function init() {}
export function decide(state) {
  if (state.tick >= 2 && state.tick <= 4) {
    const end = performance.now() + 150;
    while (performance.now() < end) { /* burn */ }
  }
  return { move: { x: 0, y: 1 }, attack: false };
}
