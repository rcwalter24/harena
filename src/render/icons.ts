import type { ItemType } from '../engine/config.ts';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Disk colour of each item on the map; the pictogram is drawn on top in a dark ink. */
export const ITEM_COLORS: Record<ItemType, string> = {
  gun: '#e0823d',
  ammo: '#e6c34a',
  shield: '#4a90e2',
  health: '#e05555',
  life: '#e36fb4',
  launcher: '#8fae5a',
  mines: '#c0563f',
  laser: '#e27bf0',
  smoke: '#aab4c2',
  gas: '#9ccc4a',
};

const INK = '#10131a';

/**
 * Draw an item as a coloured disk of radius `r` with a pictogram, so types are told apart by
 * shape rather than by a letter. Pictograms are drawn in a -1..1 box scaled to the disk.
 */
export function drawItemIcon(ctx: Ctx, type: ItemType, x: number, y: number, r: number): void {
  ctx.save();
  ctx.fillStyle = ITEM_COLORS[type];
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 2;
  ctx.stroke();

  const s = r * 0.62;
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.fillStyle = INK;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 0.22;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  PICTOGRAMS[type](ctx);
  ctx.restore();
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function cloudPath(ctx: Ctx): void {
  ctx.beginPath();
  ctx.moveTo(-0.85, 0.45);
  ctx.arc(-0.45, 0.1, 0.4, Math.PI * 0.75, Math.PI * 1.55);
  ctx.arc(0.05, -0.25, 0.5, Math.PI * 1.1, Math.PI * 1.9);
  ctx.arc(0.5, 0.12, 0.38, Math.PI * 1.45, Math.PI * 0.4);
  ctx.closePath();
}

const PICTOGRAMS: Record<ItemType, (ctx: Ctx) => void> = {
  // Pistol: slide, barrel and grip.
  gun: (ctx) => {
    roundRect(ctx, -0.9, -0.5, 1.75, 0.45, 0.08);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-0.75, -0.1);
    ctx.lineTo(-0.3, -0.1);
    ctx.lineTo(-0.1, 0.75);
    ctx.lineTo(-0.6, 0.75);
    ctx.closePath();
    ctx.fill();
  },
  // Three cartridges.
  ammo: (ctx) => {
    for (const cx of [-0.5, 0, 0.5]) {
      ctx.beginPath();
      ctx.moveTo(cx - 0.17, 0.75);
      ctx.lineTo(cx - 0.17, -0.2);
      ctx.quadraticCurveTo(cx, -0.85, cx + 0.17, -0.2);
      ctx.lineTo(cx + 0.17, 0.75);
      ctx.closePath();
      ctx.fill();
    }
  },
  // Shield outline with a centre line.
  shield: (ctx) => {
    ctx.beginPath();
    ctx.moveTo(0, -0.85);
    ctx.lineTo(0.72, -0.55);
    ctx.quadraticCurveTo(0.7, 0.45, 0, 0.88);
    ctx.quadraticCurveTo(-0.7, 0.45, -0.72, -0.55);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -0.55);
    ctx.lineTo(0, 0.55);
    ctx.stroke();
  },
  // Medical cross.
  health: (ctx) => {
    ctx.fillRect(-0.22, -0.75, 0.44, 1.5);
    ctx.fillRect(-0.75, -0.22, 1.5, 0.44);
  },
  // Heart.
  life: (ctx) => {
    ctx.beginPath();
    ctx.moveTo(0, 0.8);
    ctx.bezierCurveTo(-1.1, 0.05, -0.6, -0.95, 0, -0.35);
    ctx.bezierCurveTo(0.6, -0.95, 1.1, 0.05, 0, 0.8);
    ctx.fill();
  },
  // Launcher tube with a round shell in front.
  launcher: (ctx) => {
    roundRect(ctx, -0.95, -0.28, 1.2, 0.56, 0.1);
    ctx.fill();
    ctx.fillRect(-0.7, 0.2, 0.25, 0.5);
    ctx.beginPath();
    ctx.arc(0.6, 0, 0.3, 0, Math.PI * 2);
    ctx.fill();
  },
  // Mine: a disk with four spikes.
  mines: (ctx) => {
    ctx.beginPath();
    ctx.arc(0, 0, 0.45, 0, Math.PI * 2);
    ctx.fill();
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2 + Math.PI / 4;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 0.35, Math.sin(a) * 0.35);
      ctx.lineTo(Math.cos(a) * 0.85, Math.sin(a) * 0.85);
      ctx.stroke();
    }
  },
  // Lightning bolt.
  laser: (ctx) => {
    ctx.beginPath();
    ctx.moveTo(0.2, -0.9);
    ctx.lineTo(-0.5, 0.1);
    ctx.lineTo(-0.02, 0.1);
    ctx.lineTo(-0.25, 0.9);
    ctx.lineTo(0.55, -0.15);
    ctx.lineTo(0.05, -0.15);
    ctx.closePath();
    ctx.fill();
  },
  // Cloud outline.
  smoke: (ctx) => {
    cloudPath(ctx);
    ctx.stroke();
  },
  // Skull: poison.
  gas: (ctx) => {
    ctx.beginPath();
    ctx.arc(0, -0.15, 0.62, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(-0.36, 0.3, 0.72, 0.45);
    ctx.fillStyle = ITEM_COLORS.gas;
    for (const ex of [-0.25, 0.25]) {
      ctx.beginPath();
      ctx.arc(ex, -0.15, 0.17, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillRect(-0.05, 0.45, 0.1, 0.3);
  },
};
