import { secondsToTicks } from '../engine/config.ts';
import { blastDamageMap } from '../engine/systems/explosives.ts';
import { laserSegments } from '../engine/systems/laser.ts';
import { pathsAroundWallsFrom } from '../engine/geometry.ts';
import { bushAt, hideLeft, isExposed, isVisibleTo } from '../engine/systems/visibility.ts';
import { zoneAt, zoneEnabled } from '../engine/systems/zone.ts';
import type { Cloud, CloudHole, GameEvent, GameState, PlayerState } from '../engine/types.ts';
import { drawItemIcon } from './icons.ts';

export const PLAYER_COLORS = ['#4fc3f7', '#ff7043', '#9ccc65', '#ba68c8', '#ffd54f', '#4db6ac', '#f06292', '#a1887f'];

export function playerColor(id: number): string {
  return PLAYER_COLORS[id % PLAYER_COLORS.length];
}


/** Positions from the previous tick, used to interpolate between ticks. */
export interface FrameCapture {
  players: { x: number; y: number; facing: number; alive: boolean }[];
  bullets: Map<number, { x: number; y: number }>;
  grenades: Map<number, { x: number; y: number }>;
  thrown: Map<number, { x: number; y: number }>;
}

export function captureFrame(state: GameState): FrameCapture {
  return {
    players: state.players.map((p) => ({ x: p.x, y: p.y, facing: p.facing, alive: p.alive })),
    bullets: new Map(state.bullets.map((b) => [b.id, { x: b.x, y: b.y }])),
    grenades: new Map(state.grenades.map((g) => [g.id, { x: g.x, y: g.y }])),
    thrown: new Map(state.throwables.map((g) => [g.id, { x: g.x, y: g.y }])),
  };
}

interface Effect {
  kind: 'swing' | 'damage' | 'puff' | 'death' | 'explosion' | 'laser';
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
  /** Laser: x0, y0, x1, y1, … of the beam. */
  points?: number[];
  /** Explosion: its damage map. */
  field?: BlastField;
}

/** A blast's damage map: darker where a player standing there would take more damage. */
interface BlastField {
  image: CanvasImageSource;
  x: number;
  y: number;
  size: number;
}

/** World units per cell of a blast damage map. */
const FIELD_CELL = 3;
/** Finer cells for cloud shapes, whose edges along walls stay on screen for seconds. */
const CLOUD_CELL = 2;
/** How far (world units) the soft edge of a cloud or a hole in it fades over. */
const CLOUD_FEATHER = 14;

type Canvas2D = OffscreenCanvas | HTMLCanvasElement;
type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function newCanvas(width: number, height: number): Canvas2D {
  return typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
}

/** Smooth 0 → 1 as t goes 0 → 1. */
function smoothstep(t: number): number {
  const u = Math.min(1, Math.max(0, t));
  return u * u * (3 - 2 * u);
}

/** A disc of radius r at (x, y), opaque inside and fading to nothing over its outer CLOUD_FEATHER. */
function softDisc(c: Context2D, x: number, y: number, r: number): CanvasGradient {
  const g = c.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, '#000');
  g.addColorStop(Math.max(0, 1 - CLOUD_FEATHER / r), '#000');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  return g;
}

/** Drifting puffs that give a cloud its texture: fixed per cloud, animated by its age. */
interface Puff {
  angle: number;
  orbit: number;
  size: number;
  spin: number;
  light: boolean;
}

function cloudPuffs(id: number): Puff[] {
  let seed = (id * 2654435761) >>> 0;
  const next = () => {
    seed = (Math.imul(seed ^ (seed >>> 15), 2246822519) + 0x9e3779b9) >>> 0;
    return seed / 4294967296;
  };
  return Array.from({ length: 11 }, (_, i) => ({
    angle: next() * Math.PI * 2,
    orbit: i === 0 ? 0 : 0.2 + 0.55 * next(),
    size: 0.3 + 0.25 * next(),
    spin: (next() < 0.5 ? -1 : 1) * (0.12 + 0.2 * next()),
    light: i % 2 === 0,
  }));
}

export interface RenderOptions {
  debug: boolean;
  /** Player whose card/marker gets highlighted (e.g. the human). */
  focusId?: number;
  /**
   * Draw the arena as this player sees it: enemies hidden in bushes are not
   * drawn (only a fading marker where they were last seen). Used when a human
   * plays, so they get exactly the information bots get. Omit for spectators.
   */
  viewerId?: number;
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

export interface RendererOptions {
  /**
   * Draw at this fixed pixel size instead of following the canvas's CSS size and the
   * device pixel ratio (used for offscreen video frames).
   */
  size?: { width: number; height: number };
  /** Milliseconds clock for effect animations; defaults to performance.now (video export uses video time). */
  clock?: () => number;
}

export class Renderer {
  private readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  private readonly ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private readonly size: { width: number; height: number } | null;
  private readonly clock: () => number;
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private effects: Effect[] = [];
  private fields = new Map<string, BlastField>();
  /** Scratch layers for composing a cloud, and a hole in it. */
  private cloudLayer: Canvas2D | null = null;
  private holeLayer: Canvas2D | null = null;
  private puffs = new Map<number, Puff[]>();
  /** How far between the previous tick and this one the current frame is (0..1). */
  private subTick = 1;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, options: RendererOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new Error('Canvas 2D is not supported');
    this.ctx = ctx;
    this.size = options.size ?? null;
    this.clock = options.clock ?? (() => performance.now());
  }

  /** Logical drawing size: the fixed size, or the canvas's CSS size. */
  private get viewSize(): { width: number; height: number } {
    if (this.size) return this.size;
    const c = this.canvas as HTMLCanvasElement;
    return { width: c.clientWidth, height: c.clientHeight };
  }

  /** Convert a mouse position (CSS pixels relative to the canvas) to world coordinates. */
  screenToWorld(px: number, py: number): { x: number; y: number } {
    return { x: (px - this.offsetX) / this.scale, y: (py - this.offsetY) / this.scale };
  }

  /**
   * A shaded map around (x, y): each cell gets `color` with opacity `shade(px, py)` (0..1; 0 =
   * nothing). Used for blast damage and for clouds, which both follow walls, so their true shape
   * shows. Cached by `key` (blasts and clouds don't move).
   */
  private shadedField(
    key: string, state: GameState, x: number, y: number, reach: number, color: [number, number, number],
    makeShade: () => (px: number, py: number) => number, cell = FIELD_CELL,
  ): BlastField {
    const cached = this.fields.get(key);
    if (cached) return cached;
    const shade = makeShade();
    const n = Math.ceil((2 * reach) / cell);
    const x0 = x - (n * cell) / 2;
    const y0 = y - (n * cell) / 2;
    const canvas = newCanvas(n, n);
    const cctx = canvas.getContext('2d') as Context2D;
    const img = cctx.createImageData(n, n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const px = x0 + (i + 0.5) * cell;
        const py = y0 + (j + 0.5) * cell;
        if (px < 0 || py < 0 || px > state.map.width || py > state.map.height) continue;
        const a = shade(px, py);
        if (a <= 0) continue;
        const k = 4 * (j * n + i);
        img.data[k] = color[0];
        img.data[k + 1] = color[1];
        img.data[k + 2] = color[2];
        img.data[k + 3] = Math.round(255 * Math.min(1, a));
      }
    }
    cctx.putImageData(img, 0, 0);
    const field = { image: canvas, x: x0, y: y0, size: n * cell };
    if (this.fields.size > 64) this.fields.clear();
    this.fields.set(key, field);
    return field;
  }

  /**
   * The damage map of a blast at (x, y): darker where a player whose centre stands there would
   * take more damage (the engine's own rule, so walls cast shadows and it wraps around corners).
   */
  private blastField(state: GameState, source: 'grenade' | 'mine', x: number, y: number): BlastField {
    const { centerDamage, blastRadius } = source === 'grenade' ? state.config.launcher : state.config.mines;
    const key = `${state.map.id}|${source}|${x}|${y}|${state.config.explosions.aroundCorners}`;
    return this.shadedField(key, state, x, y, blastRadius + state.config.player.radius, [255, 64, 48], () => {
      const damageAt = blastDamageMap(state, source, x, y);
      return (px, py) => {
        const damage = damageAt(px, py);
        return damage > 0 ? 0.12 + 0.78 * Math.min(1, damage / centerDamage) : 0;
      };
    });
  }

  /** Where a hole blown in a cloud is clear (the blast's reach around walls), at its full size. */
  private holeMask(state: GameState, h: CloudHole): BlastField {
    return this.shadedField(`${state.map.id}|hole|${h.x}|${h.y}|${h.radius}`, state, h.x, h.y, h.radius, [0, 0, 0], () => {
      const path = pathsAroundWallsFrom(h.x, h.y, state.map.walls, h.radius);
      return (px, py) => (path(px, py) === Infinity ? 0 : 1);
    }, CLOUD_CELL);
  }

  /**
   * A cloud's full-size shape (it flows around walls): densest at the centre, with a soft rim.
   * Its colour is only the base tint; drawClouds adds drifting puffs on top.
   */
  private cloudField(state: GameState, c: Cloud): BlastField {
    const aroundWalls = state.config.throwing.cloudsAroundCorners > 0;
    const color: [number, number, number] = c.kind === 'smoke' ? [196, 201, 210] : [132, 196, 58];
    const [inner, outer] = c.kind === 'smoke' ? [0.9, 0.62] : [0.6, 0.3];
    const key = `${state.map.id}|cloud|${c.id}|${c.x}|${c.y}|${c.radius}|${aroundWalls}`;
    return this.shadedField(key, state, c.x, c.y, c.radius, color, () => {
      const path = aroundWalls ? pathsAroundWallsFrom(c.x, c.y, state.map.walls, c.radius) : (px: number, py: number) => Math.hypot(px - c.x, py - c.y);
      return (px, py) => {
        const d = path(px, py);
        if (d > c.radius) return 0;
        return (inner - (inner - outer) * (d / c.radius)) * smoothstep((c.radius - d) / CLOUD_FEATHER);
      };
    }, CLOUD_CELL);
  }

  /** A scratch canvas at least width × height, cleared, with its context reset. */
  private scratch(which: 'cloudLayer' | 'holeLayer', width: number, height: number): Context2D {
    let layer = this[which];
    if (!layer || layer.width < width || layer.height < height) {
      layer = newCanvas(Math.max(width, layer?.width ?? 0), Math.max(height, layer?.height ?? 0));
      this[which] = layer;
    }
    const lctx = layer.getContext('2d') as Context2D;
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.globalCompositeOperation = 'source-over';
    lctx.globalAlpha = 1;
    lctx.clearRect(0, 0, width, height);
    return lctx;
  }

  /** Turn engine events into short-lived visual effects. */
  addEvents(events: readonly GameEvent[], state: GameState): void {
    const now = this.clock();
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
        case 'laser':
          this.effects.push({ kind: 'laser', x: 0, y: 0, angle: 0, text: '', color: playerColor(e.playerId), born: now, life: 550, points: e.path });
          break;
        case 'explosion':
          this.effects.push({
            kind: 'explosion', x: e.x, y: e.y, angle: 0, text: '', color: playerColor(e.ownerId), born: now, life: 600, size: e.radius,
            field: this.blastField(state, e.source, e.x, e.y),
          });
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
    const dpr = this.size ? 1 : window.devicePixelRatio || 1;
    const { width: cssW, height: cssH } = this.viewSize;
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
    this.subTick = prev ? Math.min(1, Math.max(0, alpha)) : 1;
    ctx.fillStyle = '#12151b';
    ctx.fillRect(0, 0, this.viewSize.width, this.viewSize.height);

    ctx.save();
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.scale, this.scale);

    this.drawArena(state);
    this.drawBushes(state);
    this.drawZone(state, alpha);
    this.drawPads(state);
    this.drawItems(state);
    this.drawMines(state);
    this.drawClouds(state, 'gas');
    this.drawBullets(state, prev, alpha);
    this.drawGrenades(state, prev, alpha);
    this.drawThrown(state, prev, alpha);

    const positions = state.players.map((p) => {
      const q = prev?.players[p.id];
      if (!q || !q.alive || !p.alive || Math.hypot(q.x - p.x, q.y - p.y) > 60) return { x: p.x, y: p.y, facing: p.facing };
      return { x: lerp(q.x, p.x, alpha), y: lerp(q.y, p.y, alpha), facing: lerpAngle(q.facing, p.facing, alpha) };
    });
    const viewer = opts.viewerId !== undefined ? state.players[opts.viewerId] : null;
    const shown = new Set(state.players.filter((p) => !viewer || isVisibleTo(state, viewer, p)).map((p) => p.id));
    if (viewer) this.drawLastSeen(state, viewer.id, shown);
    if (opts.debug) this.drawDebugUnder(state, positions, shown);
    this.drawLaserWarnings(state, shown);
    for (const p of state.players) {
      if (!p.alive || !shown.has(p.id)) continue;
      // Players inside a bush are drawn faded; a bit less so while revealed by noise or exposure.
      const inBush = bushAt(state, p.x, p.y) >= 0;
      ctx.globalAlpha = !inBush ? 1 : p.noiseTimer > 0 || isExposed(state, p) ? 0.75 : 0.45;
      this.drawPlayer(state, p, positions[p.id], p.id === opts.focusId);
      ctx.globalAlpha = 1;
    }
    this.drawClouds(state, 'smoke');
    this.drawEffects();
    if (opts.debug) this.drawDebugOver(state, shown);
    ctx.restore();
  }

  /** Warning lines of charging lasers: dashed, brightening as the shot gets close. */
  private drawLaserWarnings(state: GameState, shown: Set<number>): void {
    const { ctx } = this;
    const total = Math.max(1, secondsToTicks(state.config.laser.chargeTime, state.config));
    for (const p of state.players) {
      if (!p.alive || p.laserCharge <= 0 || !shown.has(p.id)) continue;
      const progress = 1 - p.laserCharge / total;
      const segments = laserSegments(state, p.x, p.y, p.laserAim);
      ctx.save();
      ctx.strokeStyle = playerColor(p.id);
      ctx.globalAlpha = 0.35 + 0.55 * progress;
      ctx.lineWidth = 1.5 + 2 * progress;
      ctx.setLineDash([10, 7]);
      ctx.lineDashOffset = -this.clock() / 30;
      ctx.beginPath();
      ctx.moveTo(segments[0].x0, segments[0].y0);
      for (const seg of segments) ctx.lineTo(seg.x1, seg.y1);
      ctx.stroke();
      ctx.restore();
    }
  }

  /** Fading "?" markers where hidden enemies were last seen (what a bot would know). */
  private drawLastSeen(state: GameState, viewerId: number, shown: Set<number>): void {
    const { ctx } = this;
    const r = state.config.player.radius;
    for (const p of state.players) {
      if (shown.has(p.id) || !p.alive) continue;
      const seen = state.lastSeen[viewerId][p.id];
      const age = (state.tick - seen.tick) / state.config.tickRate;
      if (age > 3) continue;
      const fade = 1 - age / 3;
      ctx.globalAlpha = 0.6 * fade;
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = playerColor(p.id);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(seen.x, seen.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = playerColor(p.id);
      ctx.font = 'bold 14px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('?', seen.x, seen.y + 1);
      ctx.globalAlpha = 1;
    }
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

  /** Safe zone: the area outside is tinted and the current edge is a solid line. */
  private drawZone(state: GameState, alpha: number): void {
    if (!zoneEnabled(state.config)) return;
    const { ctx } = this;
    const { width, height } = state.map;
    const zone = zoneAt(state);
    const r = lerp(zoneAt(state, Math.max(0, state.tick - 1)).radius, zone.radius, alpha);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    ctx.clip();
    if (r < zone.startRadius) {
      ctx.beginPath();
      ctx.rect(0, 0, width, height);
      ctx.arc(zone.x, zone.y, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(226, 103, 74, 0.14)';
      ctx.fill('evenodd');
      ctx.strokeStyle = '#e2674a';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(zone.x, zone.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Flat bushes in the same style as walls: rounded, hatched, with a crisp edge. */
  private drawBushes(state: GameState): void {
    const { ctx } = this;
    for (const b of state.map.bushes ?? []) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(b.x, b.y, b.w, b.h, 8);
      ctx.fillStyle = 'rgba(58, 122, 72, 0.42)';
      ctx.fill();
      ctx.clip();
      ctx.strokeStyle = 'rgba(120, 190, 130, 0.16)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let d = -b.h; d < b.w; d += 14) {
        ctx.moveTo(b.x + d, b.y + b.h);
        ctx.lineTo(b.x + d + b.h, b.y);
      }
      ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = 'rgba(110, 180, 120, 0.55)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(b.x, b.y, b.w, b.h, 8);
      ctx.stroke();
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
    const r = state.config.items.radius;
    for (const it of state.items) drawItemIcon(this.ctx, it.type, it.x, it.y, r);
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

  /** Smoke and gas grenades sliding to a stop: small canisters with a glow in the thrower's colour. */
  private drawThrown(state: GameState, prev: FrameCapture | null, alpha: number): void {
    const { ctx } = this;
    const r = state.config.throwing.radius * 1.5;
    for (const g of state.throwables) {
      const q = prev?.thrown.get(g.id);
      const x = q ? lerp(q.x, g.x, alpha) : g.x;
      const y = q ? lerp(q.y, g.y, alpha) : g.y;
      const color = playerColor(g.ownerId);
      const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
      glow.addColorStop(0, `${color}88`);
      glow.addColorStop(1, `${color}00`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, r * 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.save();
      ctx.translate(x, y);
      // Tumbling while it slides.
      ctx.rotate(this.clock() / 90 + g.id);
      ctx.fillStyle = g.kind === 'gas' ? '#7fa83a' : '#8c96a3';
      ctx.fillRect(-r, -r * 0.6, 2 * r, 1.2 * r);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(-r, -r * 0.6, 2 * r, 1.2 * r);
      ctx.restore();
    }
  }

  /**
   * Clouds. Gas is drawn under the players (a green haze that pulses on each damage second);
   * smoke over them, thick enough to read as cover. Each is composed on a scratch layer: the
   * wall-aware shape, tinted by slowly drifting puffs, cut to the radius it has spread to and
   * with its holes erased, all with soft edges. Ages are interpolated between ticks, so spreading,
   * closing holes and fading move smoothly at any frame rate.
   */
  private drawClouds(state: GameState, kind: Cloud['kind']): void {
    const { ctx, subTick } = this;
    const { config } = state;
    const rate = config.tickRate;
    const spread = secondsToTicks(config.throwing.spreadTime, config);
    const clearTicks = secondsToTicks(config.explosions.clearTime, config);
    for (const c of state.clouds) {
      if (c.kind !== kind) continue;
      // Age at the moment this frame shows (between the previous tick and this one).
      const age = c.age - 1 + subTick;
      const radius = spread > 0 ? c.radius * Math.min(1, (age + 1) / spread) : c.radius;
      const field = this.cloudField(state, c);
      const size = Math.ceil(field.size); // one world unit per layer pixel
      const lctx = this.scratch('cloudLayer', size, size);
      lctx.setTransform(1, 0, 0, 1, -field.x, -field.y);
      lctx.drawImage(field.image, field.x, field.y, field.size, field.size);

      // Texture: puffs recolour the cloud without changing how dense it is.
      lctx.globalCompositeOperation = 'source-atop';
      if (this.puffs.size > 64) this.puffs.clear();
      const puffs = this.puffs.get(c.id) ?? cloudPuffs(c.id);
      this.puffs.set(c.id, puffs);
      const seconds = age / rate;
      for (const p of puffs) {
        const a = p.angle + p.spin * seconds;
        const x = c.x + Math.cos(a) * p.orbit * radius;
        const y = c.y + Math.sin(a) * p.orbit * radius;
        const r = p.size * (0.4 * c.radius + 0.6 * radius) * (1 + 0.1 * Math.sin(seconds * 1.4 + p.angle * 3));
        const [cr, cg, cb, peak] = kind === 'smoke' ? (p.light ? [250, 251, 253, 0.55] : [118, 126, 140, 0.4]) : p.light ? [206, 248, 112, 0.5] : [62, 112, 30, 0.45];
        const g = lctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(${cr},${cg},${cb},${peak})`);
        g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
        lctx.fillStyle = g;
        lctx.beginPath();
        lctx.arc(x, y, r, 0, Math.PI * 2);
        lctx.fill();
      }

      // Spreading: only what lies within the current radius shows, fading out over the rim.
      if (radius < c.radius) {
        lctx.globalCompositeOperation = 'destination-in';
        lctx.fillStyle = softDisc(lctx, c.x, c.y, radius);
        lctx.fillRect(field.x, field.y, field.size, field.size);
      }

      // Holes blown by explosions, each shrinking back to its blast point.
      for (const h of c.holes) {
        const hr = clearTicks > 0 ? h.radius * Math.max(0, 1 - (h.age - 1 + subTick) / clearTicks) : 0;
        if (hr <= 0) continue;
        const mask = this.holeMask(state, h);
        const hsize = Math.ceil(mask.size);
        const hctx = this.scratch('holeLayer', hsize, hsize);
        hctx.setTransform(1, 0, 0, 1, -mask.x, -mask.y);
        hctx.drawImage(mask.image, mask.x, mask.y, mask.size, mask.size);
        hctx.globalCompositeOperation = 'destination-in';
        hctx.fillStyle = softDisc(hctx, h.x, h.y, hr);
        hctx.fillRect(mask.x, mask.y, mask.size, mask.size);
        lctx.globalCompositeOperation = 'destination-out';
        lctx.drawImage(this.holeLayer!, 0, 0, hsize, hsize, mask.x, mask.y, hsize, hsize);
      }

      // Gas throbs on each damage second; both fade out over their last second.
      const fade = Math.max(0, Math.min(1, (c.ticksLeft + 1 - subTick) / rate));
      const pulse = kind === 'gas' ? 0.8 + 0.2 * (1 - (((age % rate) + rate) % rate) / rate) ** 2 : 1;
      ctx.globalAlpha = fade * pulse;
      ctx.drawImage(this.cloudLayer!, 0, 0, size, size, field.x, field.y, size, size);
      ctx.globalAlpha = 1;
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
    const now = this.clock();
    for (const m of state.mines) {
      const color = playerColor(m.ownerId);
      const left = m.fuseTimer / fuseTicks;
      const secondsLeft = m.fuseTimer / state.config.tickRate;
      // Where it will hurt, shaded by damage: faint, a little stronger as the fuse runs out, so
      // the blast itself stands out.
      const field = this.blastField(state, 'mine', m.x, m.y);
      ctx.globalAlpha = 0.12 + 0.2 * (1 - left) + (secondsLeft < 1 ? 0.1 * (1 - secondsLeft) : 0);
      ctx.drawImage(field.image, field.x, field.y, field.size, field.size);
      ctx.globalAlpha = 1;
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
    if (p.weapon === 'laser') {
      ctx.fillStyle = '#3a2b45';
      ctx.fillRect(r - 4, -4, 22, 8);
      ctx.strokeStyle = '#e27bf0';
      ctx.lineWidth = 1;
      ctx.strokeRect(r - 4, -4, 22, 8);
      // The emitter glows while charging.
      const total = Math.max(1, secondsToTicks(state.config.laser.chargeTime, state.config));
      const glow = p.laserCharge > 0 ? 1 - p.laserCharge / total : 0;
      ctx.fillStyle = '#f5c6ff';
      ctx.beginPath();
      ctx.arc(r + 19, 0, 2.5 + 4 * glow, 0, Math.PI * 2);
      ctx.fill();
    } else if (p.weapon === 'launcher') {
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

    // Shield: a translucent blue halo that grows stronger with more shield.
    if (p.shield > 0) {
      const f = Math.min(1, p.shield / state.config.player.maxShield);
      ctx.fillStyle = `rgba(74,144,226,${0.12 + 0.2 * f})`;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r + 3 + 3 * f, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(120,180,255,${0.45 + 0.4 * f})`;
      ctx.lineWidth = 1.5 + f;
      ctx.stroke();
    }

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

    // Hiding time in a bush: a thin arc that runs out, then a dashed orange ring once exposed.
    const hide = hideLeft(state, p);
    if (Number.isFinite(hide) && bushAt(state, p.x, p.y) >= 0) {
      const ringR = r + 9;
      ctx.lineWidth = 2.5;
      if (hide <= 0) {
        ctx.strokeStyle = '#ffb74d';
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, ringR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        const f = hide / state.config.bushes.hideLimit;
        ctx.strokeStyle = '#c5e1a5';
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, ringR, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2);
        ctx.stroke();
      }
    }

    if (p.invulnerableTimer > 0 && Math.floor(this.clock() / 120) % 2 === 0) {
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
    const now = this.clock();
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
          // The blast takes the shape of its damage map (walls cast shadows), with a hot core.
          // It starts as a bright flash over the whole reach, then cools to red and fades.
          if (e.field) {
            ctx.globalAlpha = Math.min(1, 1.15 * (1 - t) ** 0.7);
            ctx.drawImage(e.field.image, e.field.x, e.field.y, e.field.size, e.field.size);
            if (t < 0.3) {
              ctx.globalCompositeOperation = 'lighter';
              ctx.globalAlpha = 1 - t / 0.3;
              ctx.drawImage(e.field.image, e.field.x, e.field.y, e.field.size, e.field.size);
              ctx.drawImage(e.field.image, e.field.x, e.field.y, e.field.size, e.field.size);
              ctx.globalCompositeOperation = 'source-over';
            }
          }
          const core = (e.size ?? 0) * (0.35 + 0.35 * Math.sqrt(t));
          ctx.globalAlpha = 1 - t;
          const fill = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, core);
          fill.addColorStop(0, '#ffffff');
          fill.addColorStop(0.35, '#fff3c4');
          fill.addColorStop(1, 'rgba(255,179,71,0)');
          ctx.fillStyle = fill;
          ctx.beginPath();
          ctx.arc(e.x, e.y, core, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'laser': {
          const pts = e.points ?? [];
          if (pts.length < 4) break;
          const trace = () => {
            ctx.beginPath();
            ctx.moveTo(pts[0], pts[1]);
            for (let i = 2; i + 1 < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
            ctx.stroke();
          };
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.strokeStyle = e.color;
          ctx.globalAlpha = 0.45 * (1 - t);
          ctx.lineWidth = 12 * (1 - t) + 2;
          trace();
          ctx.strokeStyle = '#ffffff';
          ctx.globalAlpha = 1 - t;
          ctx.lineWidth = 3.5 * (1 - t) + 0.5;
          trace();
          ctx.lineCap = 'butt';
          ctx.lineJoin = 'miter';
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

  private drawDebugUnder(state: GameState, positions: { x: number; y: number; facing: number }[], shown: Set<number>): void {
    const { ctx } = this;
    const { player, knife } = state.config;
    const half = (knife.arcDegrees / 2) * (Math.PI / 180);
    for (const p of state.players) {
      if (!p.alive || p.weapon !== 'knife' || !shown.has(p.id)) continue;
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

  private drawDebugOver(state: GameState, shown: Set<number>): void {
    const { ctx } = this;
    const { player, items } = state.config;
    ctx.lineWidth = 1;
    for (const s of state.map.spawns) {
      ctx.strokeStyle = 'rgba(120,255,120,0.4)';
      ctx.strokeRect(s.x - 4, s.y - 4, 8, 8);
    }
    for (const p of state.players) {
      if (!p.alive || !shown.has(p.id)) continue;
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
