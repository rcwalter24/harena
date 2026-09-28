import type { MapData } from '../engine/types.ts';
import { PLAYER_COLORS } from './renderer.ts';

/**
 * Small static thumbnail of a map: walls, bushes and gun pads, plus where each
 * player starts (`starts[i]` = player i's position, in player colours). Spawn
 * points nobody starts on are drawn as small grey dots.
 */
export function drawMapPreview(canvas: HTMLCanvasElement, map: MapData, starts: { x: number; y: number }[] = []): void {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 300;
  const cssH = Math.round((cssW * map.height) / map.width);
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const s = (cssW / map.width) * dpr;
  ctx.setTransform(s, 0, 0, s, 0, 0);
  ctx.fillStyle = '#1b1f27';
  ctx.fillRect(0, 0, map.width, map.height);
  ctx.fillStyle = 'rgba(58, 122, 72, 0.6)';
  for (const b of map.bushes ?? []) ctx.fillRect(b.x, b.y, b.w, b.h);
  ctx.fillStyle = '#4b5366';
  for (const w of map.walls) ctx.fillRect(w.x, w.y, w.w, w.h);
  ctx.strokeStyle = '#e0823d';
  ctx.lineWidth = 10;
  for (const g of map.gunSpawns) {
    ctx.beginPath();
    ctx.arc(g.x, g.y, 22, 0, Math.PI * 2);
    ctx.stroke();
  }
  const taken = (sp: { x: number; y: number }) => starts.some((p) => p.x === sp.x && p.y === sp.y);
  ctx.fillStyle = '#5c6578';
  for (const sp of map.spawns) {
    if (taken(sp)) continue;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 9, 0, Math.PI * 2);
    ctx.fill();
  }
  starts.forEach((p, i) => {
    ctx.fillStyle = PLAYER_COLORS[i % PLAYER_COLORS.length];
    ctx.beginPath();
    ctx.arc(p.x, p.y, 24, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#10131a';
    ctx.lineWidth = 5;
    ctx.stroke();
  });
  ctx.strokeStyle = '#4a5263';
  ctx.lineWidth = 12;
  ctx.strokeRect(0, 0, map.width, map.height);
}
