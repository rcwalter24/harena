export function init() {}
export function decide() {
  const end = performance.now() + 60;
  while (performance.now() < end) { /* burn CPU */ }
  return { move: { x: 1, y: 0 } };
}
