import { DEFAULT_CONFIG, mergeConfig } from '../engine/config.ts';
import { createGame } from '../engine/game.ts';
import type { Controller } from '../match/controller.ts';
import { DummyController } from '../match/dummies.ts';
import { MatchRunner } from '../match/runner.ts';
import { BotController, type LogEntry } from '../match/supervisor.ts';
import { Renderer, playerColor } from '../render/renderer.ts';
import { createBrowserWorker } from '../sandbox/browser/host.ts';
import { getBot } from './bots.ts';
import { KillFeed, PlayerCards } from './hud.ts';
import { HumanController } from './input.ts';
import { GameLoop } from './loop.ts';
import type { MatchSetup } from './matchSetup.ts';
import { getMap } from './maps.ts';

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Display names for the seats, numbering duplicates ("Gunner", "Gunner #2"). */
function seatNames(setup: MatchSetup): string[] {
  const base = setup.slots.map((s) => (s.kind === 'bot' ? getBot(s.file)?.name ?? s.file : s.kind === 'human' ? 'You' : `${s.dummy} dummy`));
  const seen = new Map<string, number>();
  return base.map((name) => {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name} #${n}`;
  });
}

/**
 * The spectator view: canvas, player cards, kill feed, speed controls and the
 * per-bot log. Returns a function that tears everything down.
 */
export function mountMatch(app: HTMLElement, setup: MatchSetup, onExit: () => void): () => void {
  const hasHuman = setup.slots.some((s) => s.kind === 'human');
  app.innerHTML = `
    <div class="layout">
      <div class="stage">
        <canvas id="arena"></canvas>
        <div class="killfeed" id="killfeed"></div>
        <div class="banner hidden" id="banner"></div>
        <div class="stage-info" id="stage-info"></div>
      </div>
      <aside class="panel">
        <div class="panel-head">
          <h1>Harena</h1>
          <button id="exit" title="Esc">← Setup</button>
        </div>
        <div class="match-meta" id="meta"></div>
        <div class="controls">
          <div class="row">
            <button id="pause" title="P">Pause</button>
            <button id="step" title="N">Step</button>
            <button id="restart" title="R">Restart</button>
          </div>
          <div class="row">
            <button id="slower" title="[">−</button>
            <span id="speed" class="speed">1×</span>
            <button id="faster" title="]">+</button>
            <label class="check"><input type="checkbox" id="debug" /> Debug (F3)</label>
          </div>
        </div>
        <div id="cards" class="cards"></div>
        <div class="logs">
          <div class="logs-head"><b>Bot log</b><select id="log-filter"></select></div>
          <div class="log-list" id="log-list"></div>
        </div>
        <div class="help">
          ${hasHuman ? '<b>WASD</b> move · <b>mouse</b> aim · <b>click/Space</b> attack<br /><b>1/2/3</b> knife/gun/launcher · <b>Q</b> next weapon · <b>E/right click</b> mine<br />' : ''}
          <b>P</b> pause · <b>N</b> step · <b>[ ]</b> speed · <b>R</b> restart · <b>F3</b> debug
          ${setup.debug ? '<br />Cheats: <b>G</b> all weapons + ammo + mines · <b>H</b> heal + shield' : ''}
        </div>
      </aside>
    </div>`;

  const $ = <T extends HTMLElement>(id: string) => app.querySelector<T>(`#${id}`)!;
  const canvas = $<HTMLCanvasElement>('arena');
  const debugBox = $<HTMLInputElement>('debug');
  const pauseBtn = $('pause');
  const speedLabel = $('speed');
  const info = $('stage-info');
  const banner = $('banner');
  const logList = $('log-list');
  const logFilter = $<HTMLSelectElement>('log-filter');

  const renderer = new Renderer(canvas);
  const cards = new PlayerCards($('cards'));
  const feed = new KillFeed($('killfeed'));
  const map = getMap(setup.mapId);
  const names = seatNames(setup);
  const humanId = setup.slots.findIndex((s) => s.kind === 'human');
  const config = setup.debug ? mergeConfig(DEFAULT_CONFIG, { player: { startLives: 99, maxLives: 99 } }) : DEFAULT_CONFIG;

  $('meta').textContent = `${map.name} · seed ${setup.seed} · ${setup.timeLimit > 0 ? `${setup.timeLimit}s` : 'no time limit'}${setup.debug ? ' · debug rules' : ''}`;

  let loop: GameLoop | null = null;
  let bots: Array<BotController | null> = [];
  let lastPanelUpdate = 0;
  let logsDirty = true;

  logFilter.add(new Option('All bots', 'all'));
  setup.slots.forEach((s, id) => {
    if (s.kind === 'bot') logFilter.add(new Option(names[id], String(id)));
  });
  logFilter.onchange = () => {
    logsDirty = true;
  };

  function renderLogs(): void {
    const filter = logFilter.value;
    const rows: Array<{ id: number; entry: LogEntry }> = [];
    bots.forEach((bot, id) => {
      if (!bot || (filter !== 'all' && filter !== String(id))) return;
      for (const entry of bot.logs) rows.push({ id, entry });
    });
    rows.sort((a, b) => a.entry.tick - b.entry.tick);
    const shown = rows.slice(-200);
    logList.innerHTML = shown.length === 0
      ? '<div class="log-empty">No messages yet.</div>'
      : shown.map(({ id, entry }) => `
        <div class="log ${entry.level}">
          <span class="log-tick">${entry.tick}</span>
          <span class="dot" style="background:${playerColor(id)}"></span>
          <span class="log-msg">${escapeHtml(entry.message)}${entry.count > 1 ? ` <span class="log-count">×${entry.count}</span>` : ''}</span>
        </div>`).join('');
    logList.scrollTop = logList.scrollHeight;
    logsDirty = false;
  }

  function start(): void {
    loop?.stop();
    loop?.runner.dispose();
    feed.clear();
    banner.classList.add('hidden');
    logsDirty = true;

    const state = createGame({ map, config, seed: setup.seed, timeLimit: setup.timeLimit, players: names.map((name) => ({ name })) });
    bots = [];
    const controllers: Controller[] = setup.slots.map((slot, id) => {
      if (slot.kind === 'human') {
        bots.push(null);
        return new HumanController(canvas, renderer);
      }
      if (slot.kind === 'dummy') {
        bots.push(null);
        return new DummyController(slot.dummy);
      }
      const entry = getBot(slot.file);
      const bot = new BotController({
        name: names[id],
        fileName: slot.file,
        source: entry?.source ?? '',
        botSeed: `${setup.seed}::bot${id}`,
        createWorker: createBrowserWorker,
        onLog: () => {
          logsDirty = true;
        },
      });
      bots.push(bot);
      return bot;
    });

    const runner = new MatchRunner(state, controllers);
    const previous = loop;
    loop = new GameLoop(
      runner,
      (s, prev, alpha) => {
        renderer.render(s, prev, alpha, { debug: debugBox.checked, focusId: humanId >= 0 ? humanId : undefined });
        const now = performance.now();
        if (now - lastPanelUpdate > 100) {
          lastPanelUpdate = now;
          cards.update(s, humanId >= 0 ? humanId : undefined);
          const t = s.tick / s.config.tickRate;
          const left = s.timeLimitTicks > 0 ? ` · ${Math.max(0, setup.timeLimit - t).toFixed(0)}s left` : '';
          info.textContent = `tick ${s.tick} · ${t.toFixed(1)}s${left} · ${loop!.actualTps} tps`;
          if (logsDirty) renderLogs();
        }
      },
      (events, s) => {
        renderer.addEvents(events, s);
        feed.add(events, s);
        for (const e of events) {
          if (e.type === 'matchEnd') {
            banner.textContent = e.reason === 'timeLimit' ? 'Time limit reached' : 'Match over';
            banner.classList.remove('hidden');
          }
        }
      },
    );
    if (previous) {
      loop.paused = previous.paused;
      loop.speedIndex = previous.speedIndex;
    }
    info.textContent = 'starting bots…';
    const current = loop;
    void runner.init().then(() => {
      if (loop === current) current.start();
    });
    syncButtons();
  }

  function syncButtons(): void {
    if (!loop) return;
    speedLabel.textContent = `${loop.speed}×`;
    pauseBtn.textContent = loop.paused ? 'Resume' : 'Pause';
  }

  function cheat(kind: 'gun' | 'heal'): void {
    if (!setup.debug || humanId < 0 || !loop) return;
    const me = loop.runner.state.players[humanId];
    if (!me.alive) return;
    const { player, gun, launcher, mines } = loop.runner.state.config;
    if (kind === 'gun') {
      me.hasGun = true;
      me.ammo = gun.maxAmmo;
      me.hasLauncher = true;
      me.grenades = launcher.maxAmmo;
      me.mines = mines.maxCarry;
    } else {
      me.hp = player.maxHp;
      me.shield = player.maxShield;
    }
  }

  const togglePause = () => {
    if (loop) loop.paused = !loop.paused;
    syncButtons();
  };
  const changeSpeed = (d: number) => {
    loop?.changeSpeed(d);
    syncButtons();
  };
  const exit = () => {
    dispose();
    onExit();
  };

  pauseBtn.onclick = togglePause;
  $('step').onclick = () => void loop?.stepOnce();
  $('restart').onclick = start;
  $('slower').onclick = () => changeSpeed(-1);
  $('faster').onclick = () => changeSpeed(1);
  $('exit').onclick = exit;

  const onKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'SELECT' || tag === 'INPUT') return;
    switch (e.code) {
      case 'KeyP': togglePause(); break;
      case 'KeyN': void loop?.stepOnce(); break;
      case 'BracketLeft': changeSpeed(-1); break;
      case 'BracketRight': changeSpeed(1); break;
      case 'KeyR': start(); break;
      case 'Escape': exit(); break;
      case 'F3':
        e.preventDefault();
        debugBox.checked = !debugBox.checked;
        break;
      case 'KeyG': cheat('gun'); break;
      case 'KeyH': cheat('heal'); break;
    }
  };
  window.addEventListener('keydown', onKey);

  function dispose(): void {
    window.removeEventListener('keydown', onKey);
    loop?.stop();
    loop?.runner.dispose();
    loop = null;
  }

  start();
  return dispose;
}
