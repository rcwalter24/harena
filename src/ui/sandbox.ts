import { DEFAULT_CONFIG, mergeConfig } from '../engine/config.ts';
import { createGame } from '../engine/game.ts';
import type { GameState } from '../engine/types.ts';
import type { Controller } from '../match/controller.ts';
import { DUMMY_KINDS, DummyController, type DummyKind } from '../match/dummies.ts';
import { MatchRunner } from '../match/runner.ts';
import { Renderer } from '../render/renderer.ts';
import { KillFeed, PlayerCards } from './hud.ts';
import { HumanController } from './input.ts';
import { GameLoop } from './loop.ts';
import { MAPS } from './maps.ts';

/**
 * Debug sandbox: one keyboard/mouse player against scripted dummies, with
 * effectively unlimited lives and no time limit, for testing rule feel.
 */
export function mountSandbox(app: HTMLElement): void {
  app.innerHTML = `
    <div class="layout">
      <div class="stage">
        <canvas id="arena"></canvas>
        <div class="killfeed" id="killfeed"></div>
        <div class="stage-info" id="stage-info"></div>
      </div>
      <aside class="panel">
        <h1>Harena <small>debug sandbox</small></h1>
        <div class="controls">
          <label>Map <select id="map"></select></label>
          <label>Dummies <select id="count"></select></label>
          <label>Type <select id="kind"></select></label>
          <div class="row">
            <button id="restart" title="R">Restart</button>
            <button id="pause" title="P">Pause</button>
            <button id="step" title="N">Step</button>
          </div>
          <div class="row">
            <button id="slower" title="[">−</button>
            <span id="speed" class="speed">1×</span>
            <button id="faster" title="]">+</button>
            <label class="check"><input type="checkbox" id="debug" /> Debug (F3)</label>
          </div>
        </div>
        <div id="cards" class="cards"></div>
        <div class="help">
          <b>WASD</b> move · <b>mouse</b> aim · <b>click/Space</b> attack<br />
          <b>1</b> knife · <b>2</b> gun · <b>Q</b> toggle weapon<br />
          <b>P</b> pause · <b>N</b> step · <b>[ ]</b> speed · <b>R</b> restart · <b>F3</b> debug<br />
          Cheats: <b>G</b> give gun + ammo · <b>H</b> heal + shield
        </div>
      </aside>
    </div>`;

  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const canvas = $<HTMLCanvasElement>('arena');
  const mapSelect = $<HTMLSelectElement>('map');
  const countSelect = $<HTMLSelectElement>('count');
  const kindSelect = $<HTMLSelectElement>('kind');
  const debugBox = $<HTMLInputElement>('debug');
  const speedLabel = $('speed');
  const pauseBtn = $('pause');
  const info = $('stage-info');

  for (const m of MAPS) mapSelect.add(new Option(m.name, m.id));
  for (let n = 1; n <= 7; n++) countSelect.add(new Option(String(n), String(n)));
  countSelect.value = '3';
  for (const k of DUMMY_KINDS) kindSelect.add(new Option(k, k));
  kindSelect.add(new Option('mixed', 'mixed'));
  kindSelect.value = 'mixed';

  const renderer = new Renderer(canvas);
  const cards = new PlayerCards($('cards'));
  const feed = new KillFeed($('killfeed'));
  let loop: GameLoop | null = null;
  let lastCards = 0;

  const config = mergeConfig(DEFAULT_CONFIG, { player: { startLives: 99, maxLives: 99 } });

  function restart(): void {
    loop?.stop();
    loop?.runner.dispose();
    feed.clear();
    const map = MAPS.find((m) => m.id === mapSelect.value) ?? MAPS[0];
    const count = Math.min(Number(countSelect.value), map.spawns.length - 1);
    const kinds: DummyKind[] = Array.from({ length: count }, (_, i) =>
      kindSelect.value === 'mixed' ? DUMMY_KINDS[(i + 1) % DUMMY_KINDS.length] : (kindSelect.value as DummyKind));
    const state: GameState = createGame({
      map,
      config,
      seed: Date.now(),
      timeLimit: 0,
      players: [{ name: 'You' }, ...kinds.map((k, i) => ({ name: `${k} ${i + 1}` }))],
    });
    const human = new HumanController(canvas, renderer);
    const controllers: Controller[] = [human, ...kinds.map((k) => new DummyController(k))];
    const runner = new MatchRunner(state, controllers);
    const paused = loop?.paused ?? false;
    const speedIndex = loop?.speedIndex;
    loop = new GameLoop(
      runner,
      (s, prev, alpha) => {
        renderer.render(s, prev, alpha, { debug: debugBox.checked, focusId: 0 });
        const now = performance.now();
        if (now - lastCards > 100) {
          lastCards = now;
          cards.update(s, 0);
          const t = s.tick / s.config.tickRate;
          info.textContent = `tick ${s.tick} · ${t.toFixed(1)}s · ${loop!.actualTps} tps`;
        }
      },
      (events, s) => {
        renderer.addEvents(events, s);
        feed.add(events, s);
      },
    );
    loop.paused = paused;
    if (speedIndex !== undefined) loop.speedIndex = speedIndex;
    void runner.init().then(() => loop!.start());
    syncButtons();
  }

  function syncButtons(): void {
    if (!loop) return;
    speedLabel.textContent = `${loop.speed}×`;
    pauseBtn.textContent = loop.paused ? 'Resume' : 'Pause';
  }

  function cheat(kind: 'gun' | 'heal'): void {
    const me = loop?.runner.state.players[0];
    if (!me || !me.alive) return;
    const { player, gun } = loop!.runner.state.config;
    if (kind === 'gun') {
      me.hasGun = true;
      me.ammo = gun.maxAmmo;
    } else {
      me.hp = player.maxHp;
      me.shield = player.maxShield;
    }
  }

  $('restart').onclick = restart;
  pauseBtn.onclick = () => {
    if (loop) loop.paused = !loop.paused;
    syncButtons();
  };
  $('step').onclick = () => void loop?.stepOnce();
  $('slower').onclick = () => {
    loop?.changeSpeed(-1);
    syncButtons();
  };
  $('faster').onclick = () => {
    loop?.changeSpeed(1);
    syncButtons();
  };
  for (const s of [mapSelect, countSelect, kindSelect]) s.onchange = restart;

  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).tagName === 'SELECT') return;
    switch (e.code) {
      case 'KeyP':
        pauseBtn.click();
        break;
      case 'KeyN':
        void loop?.stepOnce();
        break;
      case 'BracketLeft':
        $('slower').click();
        break;
      case 'BracketRight':
        $('faster').click();
        break;
      case 'KeyR':
        restart();
        break;
      case 'F3':
        e.preventDefault();
        debugBox.checked = !debugBox.checked;
        break;
      case 'KeyG':
        cheat('gun');
        break;
      case 'KeyH':
        cheat('heal');
        break;
    }
  });

  restart();
}
