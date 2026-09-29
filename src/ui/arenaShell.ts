import type { GameEvent, GameState } from '../engine/types.ts';
import { Renderer, type FrameCapture } from '../render/renderer.ts';
import { KillFeed, PlayerCards } from './hud.ts';
import { t } from './i18n.ts';
import { GameLoop, type Ticker } from './loop.ts';

export interface ShellOptions {
  /** Small caption under the title (map, seed, ...). */
  meta: string;
  /** Optional badge next to the title, e.g. "REPLAY". */
  badge?: string;
  /** Extra controls row (HTML) placed under the standard ones. */
  extraControls?: string;
  /** Side section below the player cards (bot log, replay info, ...). */
  side: string;
  help: string;
  /** Label of the "restart" button. */
  restartLabel: string;
}

export interface ShellHooks {
  /** Player whose view is drawn (a human), or undefined for spectators. */
  viewerId?: number;
  onEvents?: (events: GameEvent[], state: GameState) => void;
  /** Called ~10×/s for panel updates. */
  onPanel?: (state: GameState) => void;
  onRestart: () => void;
  onExit: () => void;
  /** Extra key handling; return true if handled. */
  onKey?: (e: KeyboardEvent) => boolean;
}

const PANEL_KEY = 'harena.panelCollapsed';

function loadPanelCollapsed(): boolean {
  try {
    return localStorage.getItem(PANEL_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The shared arena page used by live matches and replays: canvas, kill feed,
 * player cards, pause / step / speed controls, debug toggle, results overlay
 * host and keyboard shortcuts.
 */
export class ArenaShell {
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly renderer: Renderer;
  readonly results: HTMLElement;
  loop: GameLoop | null = null;

  private readonly cards: PlayerCards;
  private readonly feed: KillFeed;
  private readonly info: HTMLElement;
  private readonly debugBox: HTMLInputElement;
  private readonly hooks: ShellHooks;
  private lastPanel = 0;
  private readonly keyHandler: (e: KeyboardEvent) => void;

  constructor(app: HTMLElement, opts: ShellOptions, hooks: ShellHooks) {
    this.hooks = hooks;
    app.innerHTML = `
      <div class="layout">
        <div class="stage">
          <canvas id="arena"></canvas>
          <div class="killfeed" id="killfeed"></div>
          <div class="results hidden" id="results"></div>
          <div class="stage-info" id="stage-info"></div>
          <button id="panel-show" class="panel-show" title="${t('Show the side panel (Tab)')}">«</button>
        </div>
        <aside class="panel">
          <div class="panel-head">
            <h1>Harena ${opts.badge ? `<span class="badge replay">${opts.badge}</span>` : ''}</h1>
            <span class="panel-head-buttons">
              <button id="exit" title="Esc">${t('← Setup')}</button>
              <button id="panel-hide" title="${t('Hide the side panel (Tab)')}">»</button>
            </span>
          </div>
          <div class="match-meta">${opts.meta}</div>
          <div class="controls">
            <div class="row">
              <button id="pause" title="P">${t('Pause')}</button>
              <button id="step" title="N">${t('Step')}</button>
              <button id="restart" title="R">${opts.restartLabel}</button>
            </div>
            <div class="row">
              <button id="slower" title="[">−</button>
              <span id="speed" class="speed">1×</span>
              <button id="faster" title="]">+</button>
              <label class="check"><input type="checkbox" id="debug" /> ${t('Debug (F3)')}</label>
            </div>
            ${opts.extraControls ?? ''}
          </div>
          <div id="cards" class="cards"></div>
          ${opts.side}
          <div class="help">${opts.help}</div>
        </aside>
      </div>`;
    this.root = app;
    this.canvas = this.el<HTMLCanvasElement>('arena');
    this.renderer = new Renderer(this.canvas);
    this.cards = new PlayerCards(this.el('cards'));
    this.feed = new KillFeed(this.el('killfeed'));
    this.info = this.el('stage-info');
    this.results = this.el('results');
    this.debugBox = this.el<HTMLInputElement>('debug');

    this.el('pause').onclick = () => this.togglePause();
    this.el('step').onclick = () => void this.loop?.stepOnce();
    this.el('restart').onclick = () => hooks.onRestart();
    this.el('slower').onclick = () => this.changeSpeed(-1);
    this.el('faster').onclick = () => this.changeSpeed(1);
    this.el('exit').onclick = () => hooks.onExit();
    this.el('panel-hide').onclick = () => this.setPanelCollapsed(true);
    this.el('panel-show').onclick = () => this.setPanelCollapsed(false);
    this.setPanelCollapsed(loadPanelCollapsed());

    this.keyHandler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'SELECT' || tag === 'INPUT') return;
      if (hooks.onKey?.(e)) return;
      switch (e.code) {
        case 'KeyP': this.togglePause(); break;
        case 'KeyN': void this.loop?.stepOnce(); break;
        case 'BracketLeft': this.changeSpeed(-1); break;
        case 'BracketRight': this.changeSpeed(1); break;
        case 'KeyR': hooks.onRestart(); break;
        case 'Escape': hooks.onExit(); break;
        case 'Tab':
          e.preventDefault();
          this.setPanelCollapsed(!this.root.querySelector('.layout')!.classList.contains('collapsed'));
          break;
        case 'F3':
          e.preventDefault();
          this.debugBox.checked = !this.debugBox.checked;
          break;
      }
    };
    window.addEventListener('keydown', this.keyHandler);
  }

  /** Hide or show the side panel; the arena grows to fill the space. Remembered in this browser. */
  setPanelCollapsed(collapsed: boolean): void {
    this.root.querySelector('.layout')!.classList.toggle('collapsed', collapsed);
    try {
      localStorage.setItem(PANEL_KEY, collapsed ? '1' : '0');
    } catch {
      // Not remembered; lasts for this page only.
    }
  }

  el<T extends HTMLElement = HTMLElement>(id: string): T {
    return this.root.querySelector<T>(`#${id}`)!;
  }

  setInfo(text: string): void {
    this.info.textContent = text;
  }

  /** Replace the running game (keeps pause state and speed). */
  run(ticker: Ticker): GameLoop {
    const previous = this.loop;
    previous?.stop();
    this.feed.clear();
    this.results.classList.add('hidden');
    const loop = new GameLoop(
      ticker,
      (s, prev, alpha) => this.frame(s, prev, alpha),
      (events, s) => {
        this.renderer.addEvents(events, s);
        this.feed.add(events, s);
        this.hooks.onEvents?.(events, s);
      },
    );
    if (previous) {
      loop.paused = previous.paused;
      loop.speedIndex = previous.speedIndex;
    }
    this.loop = loop;
    this.syncButtons();
    return loop;
  }

  clearFeed(): void {
    this.feed.clear();
  }

  private frame(s: GameState, prev: FrameCapture | null, alpha: number): void {
    this.renderer.render(s, prev, alpha, { debug: this.debugBox.checked, focusId: this.hooks.viewerId, viewerId: this.hooks.viewerId });
    const now = performance.now();
    if (now - this.lastPanel > 100) {
      this.lastPanel = now;
      this.cards.update(s, this.hooks.viewerId);
      this.hooks.onPanel?.(s);
    }
  }

  togglePause(): void {
    if (this.loop) this.loop.paused = !this.loop.paused;
    this.syncButtons();
  }

  changeSpeed(delta: number): void {
    this.loop?.changeSpeed(delta);
    this.syncButtons();
  }

  syncButtons(): void {
    if (!this.loop) return;
    this.el('speed').textContent = `${this.loop.speed}×`;
    this.el('pause').textContent = this.loop.paused ? t('Resume') : t('Pause');
  }

  dispose(): void {
    window.removeEventListener('keydown', this.keyHandler);
    this.loop?.stop();
    this.loop = null;
  }
}
