import { BufferTarget, CanvasSource, canEncodeVideo, Mp4OutputFormat, Output, WebMOutputFormat, type VideoCodec } from 'mediabunny';
import { ReplayPlayer, type Replay } from '../engine/replay.ts';
import { Renderer } from '../render/renderer.ts';
import { ARENA, drawGameFrame, drawIntro, drawOutro, feedLines, formatClock, VIDEO_H, VIDEO_W, type FeedEntry, type FrameInfo } from './frame.ts';
import { isActionEvent, planFrames, VIDEO_FPS } from './timeline.ts';
import { getLang, inLang, t, type Lang } from '../ui/i18n.ts';

const INTRO_SECONDS = 2;
const OUTRO_SECONDS = 4;
const BITRATE = 6_000_000;

export interface VideoExportOptions {
  /** Play stretches without hits at 4×. */
  fastForward: boolean;
  /** Language of the text in the video (defaults to the page's). */
  lang?: Lang;
  onProgress?: (framesDone: number, framesTotal: number) => void;
  signal?: AbortSignal;
}

export interface VideoFile {
  blob: Blob;
  extension: string;
  seconds: number;
}

interface Encoding {
  codec: VideoCodec;
  format: Mp4OutputFormat | WebMOutputFormat;
  extension: string;
}

/** H.264 in MP4 where the browser can encode it (plays everywhere), else VP9 in WebM, else null. */
export async function pickEncoding(): Promise<Encoding | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  const size = { width: VIDEO_W, height: VIDEO_H, bitrate: BITRATE };
  if (await canEncodeVideo('avc', size)) return { codec: 'avc', format: new Mp4OutputFormat({ fastStart: 'in-memory' }), extension: 'mp4' };
  if (await canEncodeVideo('vp9', size)) return { codec: 'vp9', format: new WebMOutputFormat(), extension: 'webm' };
  return null;
}

function makeCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** Ticks right after which something worth watching happened (first pass over the replay). */
function actionTicks(replay: Replay): { ticks: number[]; endTick: number } {
  const scout = new ReplayPlayer(replay);
  const ticks: number[] = [];
  while (!scout.done) {
    const events = scout.stepOnce();
    if (events.some(isActionEvent)) ticks.push(scout.state.tick);
  }
  return { ticks, endTick: scout.state.tick };
}

/**
 * Render a replay to a 1080p video entirely in the browser (WebCodecs), faster than
 * real time: a title card, the match (quiet stretches optionally at 4×), and a
 * results card. Deterministic: the same replay and options give the same frames.
 */
export async function exportReplayVideo(replay: Replay, opts: VideoExportOptions): Promise<VideoFile> {
  const encoding = await pickEncoding();
  if (!encoding) throw new Error(t('This browser cannot encode video. Use a recent Chrome, Edge or Safari.'));

  const tickRate = replay.config.tickRate;
  const { ticks, endTick } = actionTicks(replay);
  const frames = planFrames(endTick, ticks, tickRate, { fastForward: opts.fastForward });
  const introFrames = INTRO_SECONDS * VIDEO_FPS;
  const outroFrames = OUTRO_SECONDS * VIDEO_FPS;
  const total = introFrames + frames.length + outroFrames;

  const frameCanvas = makeCanvas(VIDEO_W, VIDEO_H);
  const ctx = frameCanvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('Canvas 2D is not supported');
  const arenaCanvas = makeCanvas(ARENA.w, ARENA.h);
  let now = 0; // video time in ms: drives effect animations
  const renderer = new Renderer(arenaCanvas, { size: { width: ARENA.w, height: ARENA.h }, clock: () => now });

  // Everything drawn into the video is in the video's language; the page keeps its own.
  const lang = opts.lang ?? getLang();
  const player = new ReplayPlayer(replay);
  const info: FrameInfo = inLang(lang, () => ({
    title: `${t(replay.map.name)} · ${t('seed {seed}', { seed: replay.seed })}`,
    sources: replay.players.map((p) => (p.kind === 'bot' ? p.source ?? 'bot' : p.kind === 'human' ? t('human player') : t('dummy: {kind}', { kind: t(p.source ?? '') }))),
    timeLimitTicks: player.state.timeLimitTicks,
  }));
  const feed: FeedEntry[] = [];

  const output = new Output({ format: encoding.format, target: new BufferTarget() });
  const source = new CanvasSource(frameCanvas, { codec: encoding.codec, bitrate: BITRATE, keyFrameInterval: 2 });
  output.addVideoTrack(source, { frameRate: VIDEO_FPS });
  await output.start();

  let index = 0;
  const emit = async (): Promise<void> => {
    if (opts.signal?.aborted) {
      await output.cancel();
      throw new DOMException('Video export cancelled', 'AbortError');
    }
    await source.add(index / VIDEO_FPS, 1 / VIDEO_FPS);
    index++;
    now = (index * 1000) / VIDEO_FPS;
    opts.onProgress?.(index, total);
    // Let the page repaint the progress bar now and then.
    if (index % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const renderArena = () => renderer.render(player.state, null, 1, { debug: false });

  inLang(lang, () => {
    const limit = replay.timeLimit > 0 ? t('{time} time limit', { time: formatClock(replay.timeLimit * tickRate, tickRate) }) : t('no time limit');
    renderArena();
    drawGameFrame(ctx, arenaCanvas, player.state, info, feed, now, false);
    drawIntro(ctx, player.state, info, `${t('seed {seed}', { seed: replay.seed })} · ${limit}`);
  });
  for (let i = 0; i < introFrames; i++) await emit();

  for (const frame of frames) {
    inLang(lang, () => {
      while (player.state.tick < frame.tick && !player.done) {
        const events = player.stepOnce();
        renderer.addEvents(events, player.state);
        for (const parts of feedLines(events, player.state)) feed.push({ parts, born: now });
      }
      renderArena();
      drawGameFrame(ctx, arenaCanvas, player.state, info, feed, now, frame.fast);
    });
    await emit();
  }

  inLang(lang, () => drawOutro(ctx, player.state));
  for (let i = 0; i < outroFrames; i++) await emit();

  await output.finalize();
  const buffer = (output.target as BufferTarget).buffer;
  if (!buffer) throw new Error('Video encoding produced no data');
  return { blob: new Blob([buffer], { type: encoding.format.mimeType }), extension: encoding.extension, seconds: total / VIDEO_FPS };
}
