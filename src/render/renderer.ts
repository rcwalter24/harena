import type { ItemType } from '../engine/config.ts';
import { bushAt } from '../engine/systems/visibility.ts';
import type { GameEvent, GameState, MapData, PlayerState } from '../engine/types.ts';
import { Rng } from '../engine/rng.ts';

export const PLAYER_COLORS = ['#4fc3f7', '#ff7043', '#9ccc65', '#ba68c8', '#ffd54f', '#4db6ac', '#f06292', '#a1887f'];

export function playerColor(id: number): string {
  return PLAYER_COLORS[id % PLAYER_COLORS.length];
}

const ITEM_STYLE: Record<ItemType, { fill: string; label: string }> = {
  gun: { fill: '#e0823d', label: 'G' },
  ammo: { fill: '#e6c34a', label: 'A' },
  shield: { fill: '#4a90e2', label: 'S' },
  health: { fill: '#e05555', label: '+' },
  life: { fill: '#e36fb4', label: '♥' },
  launcher: { fill: '#8fae5a', label: 'L' },
  mines: { fill: '#c0563f', label: 'M' },
};

/** Positions from the previous tick, used to interpolate between ticks. */
export interface FrameCapture {
  players: { x: number; y: number; facing: number; alive: boolean }[];
  bullets: Map<number, { x: number; y: number }>;
  grenades: Map<number, { x: number; y: number }>;
}

export function captureFrame(state: GameState): FrameCapture {
  return {
    players: state.players.map((p) => ({ x: p.x, y: p.y, facing: p.facing, alive: p.alive })),
    bullets: new Map(state.bullets.map((b) => [b.id, { x: b.x, y: b.y }])),
    grenades: new Map(state.grenades.map((g) => [g.id, { x: g.x, y: g.y }])),
  };
}

interface Effect {
  kind: 'swing' | 'damage' | 'puff' | 'death' | 'explosion';
  x: number;
  y: number;
  angle: number;
  text: string;
  color: string;
  born: number;
  life: number;
  /** Swing: radius and half-angle of the knife wedge. */
  size?: number;
  spread?: number;
}

export interface RenderOptions {
  debug: boolean;
  /** Player whose card/marker gets highlighted (e.g. the human). */
  focusId?: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private effects: Effect[] = [];
  private foliage: { map: MapData; blobs: { x: number; y: number; r: number; shade: number }[] } | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not supported');
    this.ctx = ctx;
  }

  /** Convert a mouse position (CSS pixels relative to the canvas) to world coordinates. */
  screenToWorld(px: number, py: number): { x: number; y: number } {
    return { x: (px - this.offsetX) / this.scale, y: (py - this.offsetY) / this.scale };
  }

  /** Turn engine events into short-lived visual effects. */
  addEvents(events: readonly GameEvent[], state: GameState): void {
    const now = performance.now();
    for (const e of events) {
      switch (e.type) {
        case 'swing': {
          const p = state.players[e.playerId];
          const { player, knife } = state.config;
          this.effects.push({
            kind: 'swing', x: p.x, y: p.y, angle: p.facing, text: '', color: playerColor(p.id), born: now, life: 140,
            size: 2 * player.radius + knife.reach, spread: (knife.arcDegrees / 2) * (Math.PI / 180),
          });
          break;
        }
        case 'hit': {
          const t = state.players[e.targetId];
          const color = e.hpDamage > 0 ? '#ff6b6b' : '#6fb3ff';
          this.effects.push({ kind: 'damage', x: t.x, y: t.y - 24, angle: 0, text: String(e.damage), color, born: now, life: 800 });
          break;
        }
        case 'explosion':
          this.effects.push({ kind: 'explosion', x: e.x, y: e.y, angle: 0, text: '', color: playerColor(e.ownerId), born: now, life: 450, size: e.radius });
          break;
        case 'bulletEnd':
          this.effects.push({ kind: 'puff', x: e.x, y: e.y, angle: 0, text: '', color: '#ffe08a', born: now, life: 160 });
          break;
        case 'death': {
          const p = state.players[e.playerId];
          this.effects.push({ kind: 'death', x: p.x, y: p.y, angle: 0, text: '', color: playerColor(p.id), born: now, life: 600 });
          break;
        }
      }
    }
  }

  private fit(state: GameState): void {
    const dpr = window.devicePixelRatio || 1;
    const cssW = this.canvas.clientWidth;
    const cssH = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(cssW * dpr) || this.canvas.height !== Math.round(cssH * dpr)) {
      this.canvas.width = Math.round(cssW * dpr);
      this.canvas.height = Math.round(cssH * dpr);
    }
    const margin = 12;
    this.scale = Math.min((cssW - 2 * margin) / state.map.width, (cssH - 2 * margin) / state.map.height);
    this.offsetX = (cssW - state.map.width * this.scale) / 2;
    this.offsetY = (cssH - state.map.height * this.scale) / 2;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  render(state: GameState, prev: FrameCapture | null, alpha: number, opts: RenderOptions): void {
    const { ctx } = this;
    this.fit(state);
    ctx.fillStyle = '#12151b';
    ctx.fillRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);

    ctx.save();
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.scale, this.scale);

    this.drawArena(state);
    this.drawBushes(state);
    this.drawPads(state);
    this.drawItems(state);
    this.drawMines(state);
    this.drawBullets(state, prev, alpha);
    this.drawGrenades(state, prev, alpha);

    const positions = state.players.map((p) => {
      const q = prev?.players[p.id];
      if (!q || !q.alive || !p.alive || Math.hypot(q.x - p.x, q.y - p.y) > 60) return { x: p.x, y: p.y, facing: p.facing };
      return { x: lerp(q.x, p.x, alpha), y: lerp(q.y, p.y, alpha), facing: lerpAngle(q.facing, p.facing, alpha) };
    });
    if (opts.debug) this.drawDebugUnder(state, positions);
    for (const p of state.players) {
      if (!p.alive) continue;
      // Players hiding in a bush are drawn faded (spectators always see them).
      const hidden = bushAt(state, p.x, p.y) >= 0 && p.noiseTimer === 0;
      ctx.globalAlpha = hidden ? 0.45 : 1;
      this.drawPlayer(state, p, positions[p.id], p.id === opts.focusId);
      ctx.globalAlpha = 1;
    }
    this.drawEffects();
    if (opts.debug) this.drawDebugOver(state);
    ctx.restore();
  }

  private drawArena(state: GameState): void {
    const { ctx } = this;
    const { width, height, walls } = state.map;
    ctx.fillStyle = '#1b1f27';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 100; x < width; x += 100) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    for (let y = 100; y < height; y += 100) {
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();
    ctx.strokeStyle = '#4a5263';
    ctx.lineWidth = 4;
    ctx.strokeRect(-2, -2, width + 4, height + 4);
    for (const w of walls) {
      ctx.fillStyle = '#3a4150';
      ctx.fillRect(w.x, w.y, w.w, w.h);
      ctx.fillStyle = '#4b5366';
      ctx.fillRect(w.x, w.y, w.w, Math.min(4, w.h));
    }
  }

  /** Leafy blobs, generated once per map from a fixed seed so they don't flicker. */
  private drawBushes(state: GameState): void {
    const { ctx } = this;
    const bushes = state.map.bushes ?? [];
    if (bushes.length === 0) return;
    if (this.foliage?.map !== state.map) {
      const rng = new Rng(`foliage:${state.map.id}`);
      const blobs: { x: number; y: number; r: number; shade: number }[] = [];
      for (const b of bushes) {
        const count = Math.max(6, Math.round((b.w * b.h) / 700));
        for (let i = 0; i < count; i++) {
          const r = rng.range(9, 17);
          blobs.push({ x: rng.range(b.x + r * 0.6, b.x + b.w - r * 0.6), y: rng.range(b.y + r * 0.6, b.y + b.h - r * 0.6), r, shade: rng.next() });
        }
      }
      this.foliage = { map: state.map, blobs };
    }
    for (const b of bushes) {
      ctx.fillStyle = 'rgba(46, 94, 52, 0.55)';
      ctx.beginPath();
      ctx.roundRect(b.x, b.y, b.w, b.h, 10);
      ctx.fill();
    }
    for (const blob of this.foliage.blobs) {
      ctx.fillStyle = `rgba(${60 + blob.shade * 30}, ${120 + blob.shade * 40}, ${62 + blob.shade * 20}, 0.55)`;
      ctx.beginPath();
      ctx.arc(blob.x, blob.y, blob.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawPads(state: GameState): void {
    const { ctx } = this;
    const total = state.config.items.gunPadRespawn * state.config.tickRate;
    for (const pad of state.gunPads) {
      ctx.strokeStyle = 'rgba(224,130,61,0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pad.x, pad.y, 18, 0, Math.PI * 2);
      ctx.stroke();
      if (pad.itemId < 0 && total > 0) {
        ctx.strokeStyle = 'rgba(224,130,61,0.8)';
        ctx.beginPath();
        ctx.arc(pad.x, pad.y, 18, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - pad.refillTimer / total));
        ctx.stroke();
      }
    }
  }

  private drawItems(state: GameState): void {
    const { ctx } = this;
    const r = state.config.items.radius;
    for (const it of state.items) {
      const style = ITEM_STYLE[it.type];
      ctx.fillStyle = style.fill;
      ctx.beginPath();
      ctx.arc(it.x, it.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#10131a';
      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(style.label, it.x, it.y + 1);
    }
  }

  private drawBullets(state: GameState, prev: FrameCapture | null, alpha: number): void {
    const { ctx } = this;
    const r = state.config.gun.bulletRadius;
    for (const b of state.bullets) {
      const q = prev?.bullets.get(b.id);
      const x = q ? lerp(q.x, b.x, alpha) : b.x;
      const y = q ? lerp(q.y, b.y, alpha) : b.y;
      const color = playerColor(b.ownerId);

      // Soft glow in the shooter's colour so small bullets stay easy to spot.
      const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 3.5);
      glow.addColorStop(0, `${color}88`);
      glow.addColorStop(1, `${color}00`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, r * 3.5, 0, Math.PI * 2);
      ctx.fill();

      // Slug pointing along its velocity, sized close to the circular hitbox.
      const hl = r * 1.3;
      const hw = r * 0.8;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.atan2(b.vy, b.vx));
      ctx.beginPath();
      ctx.moveTo(-hl, -hw);
      ctx.lineTo(hl - hw, -hw);
      ctx.quadraticCurveTo(hl, -hw, hl, 0);
      ctx.quadraticCurveTo(hl, hw, hl - hw, hw);
      ctx.lineTo(-hl, hw);
      ctx.closePath();
      ctx.fillStyle = '#ffe9a8';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawGrenades(state: GameState, prev: FrameCapture | null, alpha: number): void {
    const { ctx } = this;
    // Drawn a little larger than the hitbox so it reads at small scales.
    const r = state.config.launcher.grenadeRadius * 1.4;
    for (const g of state.grenades) {
      const q = prev?.grenades.get(g.id);
      const x = q ? lerp(q.x, g.x, alpha) : g.x;
      const y = q ? lerp(q.y, g.y, alpha) : g.y;
      const color = playerColor(g.ownerId);
      const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 3.5);
      glow.addColorStop(0, `${color}99`);
      glow.addColorStop(1, `${color}00`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, r * 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#4b5a2e';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
      // Fuse spark at the back.
      const speed = Math.hypot(g.vx, g.vy) || 1;
      ctx.fillStyle = '#ffd166';
      ctx.beginPath();
      ctx.arc(x - (g.vx / speed) * r, y - (g.vy / speed) * r, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawMines(state: GameState): void {
    const { ctx } = this;
    const fuseTicks = state.config.mines.fuse * state.config.tickRate;
    const blast = state.config.mines.blastRadius;
    const now = performance.now();
    for (const m of state.mines) {
      const color = playerColor(m.ownerId);
      const left = m.fuseTimer / fuseTicks;
      const secondsLeft = m.fuseTimer / state.config.tickRate;
      // Danger zone fades in during the last second.
      if (secondsLeft < 1) {
        ctx.fillStyle = `rgba(255,77,77,${0.12 * (1 - secondsLeft)})`;
        ctx.strokeStyle = `rgba(255,77,77,${0.5 * (1 - secondsLeft)})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(m.x, m.y, blast, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.fillStyle = '#23262e';
      ctx.beginPath();
      ctx.arc(m.x, m.y, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.stroke();
      // Countdown ring: shrinks as the fuse burns.
      ctx.strokeStyle = '#ff4d4d';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(m.x, m.y, 16, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left);
      ctx.stroke();
      // Blinks faster as the fuse runs out.
      const period = 90 + 450 * left;
      const on = Math.floor(now / period) % 2 === 0;
      ctx.fillStyle = on ? '#ff4d4d' : '#6b2a2a';
      ctx.beginPath();
      ctx.arc(m.x, m.y, 4.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawPlayer(state: GameState, p: PlayerState, pos: { x: number; y: number; facing: number }, focus: boolean): void {
    const { ctx } = this;
    const r = state.config.player.radius;
    const color = playerColor(p.id);
    const fx = Math.cos(pos.facing);
    const fy = Math.sin(pos.facing);

    // Weapon.
    ctx.save();
    ctx.translate(pos.x, pos.y);
    ctx.rotate(pos.facing);
    if (p.weapon === 'launcher') {
      ctx.fillStyle = '#4b5a2e';
      ctx.fillRect(r - 4, -5.5, 20, 11);
      ctx.strokeStyle = '#8fae5a';
      ctx.lineWidth = 1;
      ctx.strokeRect(r - 4, -5.5, 20, 11);
    } else if (p.weapon === 'gun') {
      ctx.fillStyle = '#2b2f38';
      ctx.fillRect(r - 4, -3.5, 22, 7);
      ctx.strokeStyle = '#8a93a6';
      ctx.lineWidth = 1;
      ctx.strokeRect(r - 4, -3.5, 22, 7);
    } else {
      ctx.fillStyle = '#d9dee8';
      ctx.beginPath();
      ctx.moveTo(r - 2, -3);
      ctx.lineTo(r + 14, 0);
      ctx.lineTo(r - 2, 3);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // Body.
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = focus ? 3 : 2;
    ctx.strokeStyle = focus ? '#ffffff' : 'rgba(0,0,0,0.55)';
    ctx.stroke();
    // Eye, showing facing.
    ctx.fillStyle = '#10131a';
    ctx.beginPath();
    ctx.arc(pos.x + fx * r * 0.5, pos.y + fy * r * 0.5, 3.2, 0, Math.PI * 2);
    ctx.fill();

    if (p.invulnerableTimer > 0 && Math.floor(performance.now() / 120) % 2 === 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r + 5, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Name and bars.
    const barW = 40;
    const top = pos.y - r - 16;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(pos.x - barW / 2, top, barW, 5);
    ctx.fillStyle = '#5ad16a';
    ctx.fillRect(pos.x - barW / 2, top, (barW * p.hp) / state.config.player.maxHp, 5);
    if (p.shield > 0) {
      ctx.fillStyle = '#4a90e2';
      ctx.fillRect(pos.x - barW / 2, top - 4, (barW * p.shield) / state.config.player.maxShield, 3);
    }
    ctx.fillStyle = '#e8ecf3';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(p.name, pos.x, top - 6);
  }

  private drawEffects(): void {
    const { ctx } = this;
    const now = performance.now();
    this.effects = this.effects.filter((e) => now - e.born < e.life);
    for (const e of this.effects) {
      const t = (now - e.born) / e.life;
      ctx.globalAlpha = 1 - t;
      switch (e.kind) {
        case 'swing': {
          ctx.fillStyle = e.color;
          ctx.globalAlpha = 0.35 * (1 - t);
          ctx.beginPath();
          ctx.moveTo(e.x, e.y);
          ctx.arc(e.x, e.y, e.size ?? 0, e.angle - (e.spread ?? 0), e.angle + (e.spread ?? 0));
          ctx.closePath();
          ctx.fill();
          break;
        }
        case 'damage':
          ctx.fillStyle = e.color;
          ctx.font = 'bold 15px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(e.text, e.x, e.y - t * 26);
          break;
        case 'puff':
          ctx.fillStyle = e.color;
          ctx.beginPath();
          ctx.arc(e.x, e.y, 3 + t * 8, 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'explosion': {
          const radius = e.size ?? 0;
          ctx.globalAlpha = 0.55 * (1 - t);
          const fill = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, radius);
          fill.addColorStop(0, '#fff3c4');
          fill.addColorStop(0.4, '#ffb347');
          fill.addColorStop(1, 'rgba(255,90,40,0)');
          ctx.fillStyle = fill;
          ctx.beginPath();
          ctx.arc(e.x, e.y, radius * (0.6 + 0.4 * Math.min(1, t * 3)), 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1 - t;
          ctx.strokeStyle = e.color;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(e.x, e.y, radius, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case 'death':
          ctx.strokeStyle = e.color;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(e.x, e.y, 16 + t * 40, 0, Math.PI * 2);
          ctx.stroke();
          break;
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawDebugUnder(state: GameState, positions: { x: number; y: number; facing: number }[]): void {
    const { ctx } = this;
    const { player, knife } = state.config;
    const half = (knife.arcDegrees / 2) * (Math.PI / 180);
    for (const p of state.players) {
      if (!p.alive || p.weapon !== 'knife') continue;
      const pos = positions[p.id];
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y);
      // Knife hits targets whose centre is within 2r + reach inside the arc.
      ctx.arc(pos.x, pos.y, 2 * player.radius + knife.reach, pos.facing - half, pos.facing + half);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  private drawDebugOver(state: GameState): void {
    const { ctx } = this;
    const { player, items } = state.config;
    ctx.lineWidth = 1;
    for (const s of state.map.spawns) {
      ctx.strokeStyle = 'rgba(120,255,120,0.4)';
      ctx.strokeRect(s.x - 4, s.y - 4, 8, 8);
    }
    for (const p of state.players) {
      if (!p.alive) continue;
      ctx.strokeStyle = 'rgba(255,80,80,0.9)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, player.radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(80,255,255,0.8)';
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + p.vx * 0.3, p.y + p.vy * 0.3);
      ctx.stroke();
    }
    ctx.setLineDash([4, 4]);
    for (const m of state.mines) {
      ctx.strokeStyle = 'rgba(255,107,107,0.6)';
      ctx.beginPath();
      ctx.arc(m.x, m.y, state.config.mines.blastRadius, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const g of state.grenades) {
      ctx.strokeStyle = 'rgba(255,179,71,0.6)';
      ctx.beginPath();
      ctx.arc(g.x, g.y, state.config.launcher.blastRadius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const it of state.items) {
      ctx.strokeStyle = 'rgba(255,255,120,0.4)';
      ctx.beginPath();
      ctx.arc(it.x, it.y, items.radius + player.radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const b of state.bullets) {
      ctx.strokeStyle = 'rgba(255,200,80,0.5)';
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x + b.vx, b.y + b.vy);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,80,80,0.9)';
      ctx.beginPath();
      ctx.arc(b.x, b.y, state.config.gun.bulletRadius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}
