import type { GameEvent, GameState, PlayerState } from '../engine/types.ts';
import { playerColor } from '../render/renderer.ts';
import { zoneStatus } from '../ui/hud.ts';
import { t } from '../ui/i18n.ts';

/** Layout of a 1080p video frame: the arena on the left, a player panel on the right. */
export const VIDEO_W = 1920;
export const VIDEO_H = 1080;
export const ARENA = { x: 24, y: 24, w: 1432, h: 1000 };
const PANEL = { x: 1480, y: 24, w: 416, h: 1032 };
const FEED_H = 250;

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const BG = '#12151b';
const TEXT = '#e8ecf3';
const MUTED = '#8a93a6';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Part = { text: string; color: string };

/** A kill-feed line with the video time (ms) it appeared at. */
export interface FeedEntry {
  parts: Part[];
  born: number;
}

export interface FrameInfo {
  title: string;
  /** Short label per seat, e.g. "gunner.js". */
  sources: string[];
  timeLimitTicks: number;
}

export function formatClock(ticks: number, tickRate: number): string {
  const s = Math.floor(ticks / tickRate);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
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

/** Draw text parts one after another from (x, y); returns the end x. */
function drawParts(ctx: Ctx, parts: Part[], x: number, y: number): number {
  ctx.textAlign = 'left';
  for (const p of parts) {
    ctx.fillStyle = p.color;
    ctx.fillText(p.text, x, y);
    x += ctx.measureText(p.text).width;
  }
  return x;
}

/** Kill-feed lines for this tick's events, matching the live HUD's wording. */
export function feedLines(events: readonly GameEvent[], state: GameState): Part[][] {
  const who = (id: number): Part => ({ text: state.players[id].name, color: playerColor(id) });
  const lines: Part[][] = [];
  for (const e of events) {
    if (e.type === 'death') {
      if (e.killerId >= 0) {
        const how = t(e.weapon === 'gun' ? ' shot ' : e.weapon === 'knife' ? ' knifed ' : e.weapon === 'laser' ? ' lasered '
          : e.weapon === 'gas' ? ' gassed ' : ' blew up ');
        lines.push([who(e.killerId), { text: how, color: MUTED }, who(e.playerId)]);
      } else {
        const how = t(e.weapon === 'launcher' || e.weapon === 'mine' ? ' blew themselves up' : e.weapon === 'laser' ? ' was hit by their own laser'
          : e.weapon === 'gas' ? ' choked on their own gas' : e.weapon === 'zone' ? ' was caught outside the zone' : ' died');
        lines.push([who(e.playerId), { text: how, color: MUTED }]);
      }
    } else if (e.type === 'eliminated') {
      lines.push([who(e.playerId), { text: t(' is eliminated'), color: '#ff8a80' }]);
    }
  }
  return lines;
}

/** Background, arena image, info bar and player panel: one gameplay frame. */
export function drawGameFrame(
  ctx: Ctx, arena: CanvasImageSource, state: GameState, info: FrameInfo, feed: FeedEntry[], now: number, fast: boolean,
): void {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, VIDEO_W, VIDEO_H);
  ctx.drawImage(arena, ARENA.x, ARENA.y);
  drawInfoBar(ctx, state, info, fast);
  drawPanel(ctx, state, info, feed, now);
}

function drawInfoBar(ctx: Ctx, state: GameState, info: FrameInfo, fast: boolean): void {
  const rate = state.config.tickRate;
  const clock = formatClock(state.tick, rate) + (info.timeLimitTicks > 0 ? ` / ${formatClock(info.timeLimitTicks, rate)}` : '');
  ctx.font = `600 22px ${FONT}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const y = ARENA.y + ARENA.h + 28;
  const end = drawParts(ctx, [{ text: clock, color: TEXT }], ARENA.x + 8, y);
  ctx.font = `20px ${FONT}`;
  drawParts(ctx, [{ text: zoneStatus(state), color: MUTED }], end + 4, y);
  if (fast) {
    // "4×" badge in the arena's top-right corner while a quiet stretch is sped up.
    const w = 92;
    const x = ARENA.x + ARENA.w - w - 20;
    const by = ARENA.y + 20;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    roundRect(ctx, x, by, w, 40, 10);
    ctx.fill();
    ctx.font = `700 22px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffd54f';
    ctx.fillText('▶▶ 4×', x + w / 2, by + 21);
  }
}

function drawPanel(ctx: Ctx, state: GameState, info: FrameInfo, feed: FeedEntry[], now: number): void {
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = TEXT;
  ctx.font = `700 30px ${FONT}`;
  ctx.fillText('Harena', PANEL.x, PANEL.y + 30);
  ctx.fillStyle = MUTED;
  ctx.font = `18px ${FONT}`;
  ctx.fillText(info.title, PANEL.x, PANEL.y + 58);

  const top = PANEL.y + 84;
  const n = state.players.length;
  const cardH = Math.min(112, Math.floor((PANEL.h - 84 - FEED_H - 16) / n));
  state.players.forEach((p, i) => drawCard(ctx, state, p, info.sources[i] ?? '', PANEL.x, top + i * cardH, PANEL.w, cardH - 10));

  // Kill feed: newest first, fading out after 5 s.
  const feedTop = PANEL.y + PANEL.h - FEED_H;
  ctx.textAlign = 'left';
  ctx.font = `600 16px ${FONT}`;
  ctx.fillStyle = MUTED;
  ctx.fillText(t('KILL FEED'), PANEL.x, feedTop + 16);
  ctx.font = `19px ${FONT}`;
  const visible = feed.filter((f) => now - f.born < 6000).slice(-6).reverse();
  visible.forEach((f, i) => {
    ctx.globalAlpha = Math.max(0, Math.min(1, (6000 - (now - f.born)) / 1000));
    drawParts(ctx, f.parts, PANEL.x, feedTop + 50 + i * 34);
    ctx.globalAlpha = 1;
  });
}

function drawCard(ctx: Ctx, state: GameState, p: PlayerState, source: string, x: number, y: number, w: number, h: number): void {
  const { player } = state.config;
  const color = playerColor(p.id);
  const compact = h < 90;
  ctx.globalAlpha = p.alive ? 1 : 0.5;
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  roundRect(ctx, x, y, w, h, 10);
  ctx.fill();
  ctx.fillStyle = color;
  roundRect(ctx, x, y, 6, h, 3);
  ctx.fill();

  const pad = 18;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = `700 ${compact ? 19 : 22}px ${FONT}`;
  ctx.fillStyle = TEXT;
  ctx.fillText(p.name, x + pad, y + (compact ? 24 : 30));
  const nameW = ctx.measureText(p.name).width;
  if (!compact) {
    ctx.font = `15px ${FONT}`;
    ctx.fillStyle = MUTED;
    ctx.fillText(source, x + pad + nameW + 10, y + 30);
  }
  ctx.textAlign = 'right';
  ctx.font = `600 ${compact ? 17 : 20}px ${FONT}`;
  ctx.fillStyle = '#f06292';
  ctx.fillText(`♥ ${p.lives}`, x + w - pad, y + (compact ? 24 : 30));

  const barY = y + (compact ? 34 : 44);
  const barW = w - 2 * pad;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(x + pad, barY, barW, 10);
  ctx.fillStyle = '#5ad16a';
  ctx.fillRect(x + pad, barY, (barW * Math.max(0, p.hp)) / player.maxHp, 10);
  if (p.shield > 0) {
    ctx.fillStyle = '#4a90e2';
    ctx.fillRect(x + pad, barY + 12, (barW * p.shield) / player.maxShield, 5);
  }

  const lineY = barY + (compact ? 34 : 40);
  ctx.font = `${compact ? 15 : 17}px ${FONT}`;
  ctx.textAlign = 'left';
  let status: Part[];
  if (p.eliminated) status = [{ text: t('eliminated'), color: '#ff8a80' }];
  else if (!p.alive) status = [{ text: t('respawn in {s}s', { s: (p.respawnTimer / state.config.tickRate).toFixed(1) }), color: MUTED }];
  else {
    const weapon = (name: 'knife' | 'gun' | 'launcher' | 'laser', detail = '') => ({ text: `${t(name)}${detail}`, color: p.weapon === name ? TEXT : MUTED });
    status = [weapon('knife')];
    if (p.hasGun) status.push({ text: ' · ', color: MUTED }, weapon('gun', ` ${p.ammo}`));
    if (p.hasLauncher) status.push({ text: ' · ', color: MUTED }, weapon('launcher', ` ${p.grenades}`));
    if (p.hasLaser) status.push({ text: ' · ', color: MUTED }, weapon('laser', ` ${p.laserShots}`));
    if (p.mines > 0) status.push({ text: ` · ${t('mines {n}', { n: p.mines })}`, color: MUTED });
    if (p.smokes > 0) status.push({ text: ` · ${t('smoke {n}', { n: p.smokes })}`, color: MUTED });
    if (p.gases > 0) status.push({ text: ` · ${t('gas {n}', { n: p.gases })}`, color: MUTED });
  }
  drawParts(ctx, status, x + pad, lineY);
  ctx.textAlign = 'right';
  ctx.fillStyle = MUTED;
  ctx.fillText(`${t('K')} ${p.stats.kills} · ${t('D')} ${p.stats.deaths}`, x + w - pad, lineY);
  ctx.globalAlpha = 1;
}

/** Darken the frame and draw a centred card of the given height; returns its top-left. */
function overlayCard(ctx: Ctx, w: number, h: number): { x: number; y: number } {
  ctx.fillStyle = 'rgba(10,12,16,0.78)';
  ctx.fillRect(0, 0, VIDEO_W, VIDEO_H);
  const x = (VIDEO_W - w) / 2;
  const y = (VIDEO_H - h) / 2;
  ctx.fillStyle = '#1b1f27';
  roundRect(ctx, x, y, w, h, 18);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 2;
  ctx.stroke();
  return { x, y };
}

/** Title card over the first frame: map, seed and the players. */
export function drawIntro(ctx: Ctx, state: GameState, info: FrameInfo, subtitle: string): void {
  const n = state.players.length;
  const w = 900;
  const h = 250 + n * 56;
  const { x, y } = overlayCard(ctx, w, h);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = MUTED;
  ctx.font = `600 22px ${FONT}`;
  ctx.fillText(t('HARENA · AI BOT ARENA'), VIDEO_W / 2, y + 60);
  ctx.fillStyle = TEXT;
  ctx.font = `700 54px ${FONT}`;
  ctx.fillText(t(state.map.name), VIDEO_W / 2, y + 128);
  ctx.fillStyle = MUTED;
  ctx.font = `20px ${FONT}`;
  ctx.fillText(subtitle, VIDEO_W / 2, y + 166);
  state.players.forEach((p, i) => {
    const rowY = y + 230 + i * 56;
    ctx.fillStyle = playerColor(p.id);
    ctx.beginPath();
    ctx.arc(x + 200, rowY - 9, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.textAlign = 'left';
    ctx.fillStyle = TEXT;
    ctx.font = `700 30px ${FONT}`;
    ctx.fillText(p.name, x + 230, rowY);
    ctx.textAlign = 'right';
    ctx.fillStyle = MUTED;
    ctx.font = `20px ${FONT}`;
    ctx.fillText(info.sources[i] ?? '', x + w - 200, rowY);
  });
}

const REASONS: Record<string, string> = {
  lastStanding: 'Last one standing',
  allEliminated: 'Everyone eliminated',
  timeLimit: 'Time limit',
};

/** Results card over the final frame: winner, ranking and key stats. */
export function drawOutro(ctx: Ctx, state: GameState): void {
  const result = state.result;
  if (!result) return;
  const rate = state.config.tickRate;
  const n = state.players.length;
  const w = 1100;
  const h = 250 + n * 52;
  const { x, y } = overlayCard(ctx, w, h);
  const winners = result.ranking.filter((r) => r.rank === 1).map((r) => state.players[r.playerId]);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = MUTED;
  ctx.font = `600 22px ${FONT}`;
  ctx.fillText(`${t(REASONS[result.reason] ?? result.reason)} · ${formatClock(result.endTick, rate)}`, VIDEO_W / 2, y + 56);
  ctx.font = `700 52px ${FONT}`;
  if (winners.length === 1) {
    drawCentred(ctx, [{ text: winners[0].name, color: playerColor(winners[0].id) }, { text: t(' wins'), color: TEXT }], y + 122);
  } else {
    ctx.fillStyle = TEXT;
    ctx.fillText(t('Draw'), VIDEO_W / 2, y + 122);
  }

  const cols = [x + 90, x + 150, x + 560, x + 760, x + 860, x + 1010];
  const headY = y + 184;
  ctx.font = `600 17px ${FONT}`;
  ctx.fillStyle = MUTED;
  ctx.textAlign = 'left';
  ctx.fillText('#', cols[0], headY);
  ctx.fillText(t('PLAYER'), cols[1], headY);
  ctx.fillText(t('RESULT'), cols[2], headY);
  ctx.textAlign = 'right';
  ctx.fillText(t('KILLS'), cols[3] + 40, headY);
  ctx.fillText(t('DEATHS'), cols[4] + 60, headY);
  ctx.fillText(t('DAMAGE'), cols[5], headY);
  result.ranking.forEach((r, i) => {
    const p = state.players[r.playerId];
    const rowY = headY + 46 + i * 52;
    ctx.font = `600 26px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = MUTED;
    ctx.fillText(String(r.rank), cols[0], rowY);
    ctx.fillStyle = playerColor(p.id);
    ctx.beginPath();
    ctx.arc(cols[1] + 10, rowY - 9, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = TEXT;
    ctx.fillText(p.name, cols[1] + 32, rowY);
    ctx.font = `22px ${FONT}`;
    ctx.fillStyle = p.eliminated ? MUTED : TEXT;
    ctx.fillText(
      p.eliminated ? t('out at {time}', { time: formatClock(p.eliminatedTick, rate) }) : t('♥ {lives} · {hp} hp', { lives: p.lives, hp: Math.ceil(p.hp + p.shield) }),
      cols[2],
      rowY,
    );
    ctx.textAlign = 'right';
    ctx.fillStyle = TEXT;
    ctx.fillText(String(p.stats.kills), cols[3] + 40, rowY);
    ctx.fillText(String(p.stats.deaths), cols[4] + 60, rowY);
    ctx.fillText(String(Math.round(p.stats.damageDealt)), cols[5], rowY);
  });
}

function drawCentred(ctx: Ctx, parts: Part[], y: number): void {
  ctx.textAlign = 'left';
  const width = parts.reduce((sum, p) => sum + ctx.measureText(p.text).width, 0);
  drawParts(ctx, parts, (VIDEO_W - width) / 2, y);
}
