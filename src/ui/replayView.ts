import { ReplayPlayer, type Replay } from '../engine/replay.ts';
import type { BotStats } from '../match/supervisor.ts';
import { playerColor } from '../render/renderer.ts';
import { ArenaShell } from './arenaShell.ts';
import { zoneStatus } from './hud.ts';
import { openVideoExport } from './videoDialog.ts';
import { replayFileName } from './matchView.ts';
import { downloadJson, escapeHtml, showResults } from './results.ts';

function formatTime(ticks: number, tickRate: number): string {
  const s = Math.floor(ticks / tickRate);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Replay viewer: re-simulates the recorded actions with the same engine, with
 * pause / step / speed, a seek bar (seeking re-simulates from the start), and a
 * desync warning if the re-simulation diverges from the recorded checksums.
 */
export function mountReplay(app: HTMLElement, replay: Replay, callbacks: { onExit: () => void }): () => void {
  const player = new ReplayPlayer(replay);
  const tickRate = replay.config.tickRate;
  const total = replay.ticks;
  const botStats = (replay.extras ?? []).map((x) => (x && typeof x === 'object' ? (x as BotStats) : null));
  const sources = replay.players.map((p) => (p.kind === 'bot' ? p.source ?? 'bot' : p.kind === 'human' ? 'keyboard' : `dummy: ${p.source ?? ''}`));
  let seeking = false;

  const ticker = {
    get state() {
      return player.state;
    },
    tick: async () => player.stepOnce(),
  };

  const shell = new ArenaShell(app, {
    badge: 'REPLAY',
    meta: `${escapeHtml(replay.map.name)} · seed ${escapeHtml(replay.seed)} · recorded ${new Date(replay.createdAt).toLocaleString()}`,
    restartLabel: 'Restart',
    extraControls: `
      <div class="row seek-row">
        <input type="range" id="seek" min="0" max="${total}" value="0" step="1" />
        <span id="seek-time" class="speed">0:00 / ${formatTime(total, tickRate)}</span>
      </div>
      <div class="row"><button id="export-video" title="Render this replay to a video file">🎬 Export video</button></div>`,
    side: `
      <div class="replay-info">
        <div id="desync" class="note"></div>
        ${replay.players.map((p, i) => `<div class="replay-seat"><span class="dot" style="background:${playerColor(i)}"></span>${escapeHtml(p.name)} <span class="muted">${escapeHtml(sources[i])}${p.sourceHash ? ` · ${p.sourceHash.slice(0, 8)}` : ''}</span></div>`).join('')}
        ${replay.cheats.length ? `<div class="note">${replay.cheats.length} debug cheat(s) recorded</div>` : ''}
      </div>`,
    help: '<b>P</b> pause · <b>N</b> step · <b>[ ]</b> speed · <b>← →</b> seek 5s · <b>R</b> restart · <b>F3</b> debug',
  }, {
    onRestart: () => seekTo(0),
    onExit: () => callbacks.onExit(),
    onEvents: (events, s) => {
      if (events.some((e) => e.type === 'matchEnd')) showEnd(s);
    },
    onPanel: (s) => {
      if (!seeking) seek.value = String(s.tick);
      shell.el('seek-time').textContent = `${formatTime(s.tick, tickRate)} / ${formatTime(total, tickRate)}`;
      shell.setInfo(`tick ${s.tick} / ${total}${zoneStatus(s)} · ${shell.loop?.actualTps ?? 0} tps`);
      const desync = shell.el('desync');
      desync.className = player.desyncs.length ? 'note warn-text' : 'note';
      desync.textContent = player.desyncs.length
        ? `⚠ Desync at tick ${player.desyncs[0]}: the re-simulation no longer matches the recording (engine or config changed since it was recorded?).`
        : 'Checksums match the recording so far.';
    },
    onKey: (e) => {
      if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        seekTo(player.state.tick + (e.code === 'ArrowLeft' ? -5 : 5) * tickRate);
        return true;
      }
      return false;
    },
  });

  shell.el('export-video').onclick = () => {
    if (shell.loop && !shell.loop.paused) shell.togglePause();
    openVideoExport(replay);
  };
  const seek = shell.el<HTMLInputElement>('seek');
  seek.addEventListener('input', () => {
    seeking = true;
    seekTo(Number(seek.value));
  });
  seek.addEventListener('change', () => {
    seeking = false;
  });

  function seekTo(tick: number): void {
    player.seek(tick);
    shell.loop?.resetInterpolation();
    shell.clearFeed();
    shell.results.classList.add('hidden');
    if (player.state.over) showEnd(player.state);
  }

  function showEnd(s: typeof player.state): void {
    if (!s.result) return;
    showResults(shell.results, { state: s, botStats, sources }, {
      watchReplay: () => seekTo(0),
      download: () => downloadJson(replayFileName(replay), replay),
      exportVideo: () => openVideoExport(replay),
      setup: () => callbacks.onExit(),
    });
  }

  shell.run(ticker).start();
  return () => shell.dispose();
}
