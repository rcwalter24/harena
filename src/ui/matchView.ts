import { DEFAULT_CONFIG, mergeConfig } from '../engine/config.ts';
import { applyCheat, type CheatKind } from '../engine/debug.ts';
import { createGame } from '../engine/game.ts';
import { ReplayRecorder, type Replay, type ReplayPlayerInfo } from '../engine/replay.ts';
import type { GameState } from '../engine/types.ts';
import type { Controller } from '../match/controller.ts';
import { DummyController } from '../match/dummies.ts';
import { MatchRunner } from '../match/runner.ts';
import { BotController } from '../match/supervisor.ts';
import { playerColor } from '../render/renderer.ts';
import { createBrowserWorker } from '../sandbox/browser/host.ts';
import { ArenaShell } from './arenaShell.ts';
import { zoneStatus } from './hud.ts';
import { openVideoExport } from './videoDialog.ts';
import { displayName, getBot } from './bots.ts';
import { HumanController } from './input.ts';
import { t } from './i18n.ts';
import { randomSeed, saveSetup, type MatchSetup } from './matchSetup.ts';
import { getMap } from './maps.ts';
import { downloadJson, escapeHtml, showResults } from './results.ts';

/** Display names for the seats, numbering duplicates ("Gunner", "Gunner #2"). */
function seatNames(setup: MatchSetup): string[] {
  const base = setup.slots.map((s) => {
    if (s.kind === 'human') return t('You');
    if (s.kind === 'dummy') return t('{kind} dummy', { kind: t(s.dummy) });
    const bot = getBot(s.file);
    return bot ? displayName(bot) : s.file;
  });
  const seen = new Map<string, number>();
  return base.map((name) => {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name} #${n}`;
  });
}

function seatInfo(setup: MatchSetup, names: string[]): ReplayPlayerInfo[] {
  return setup.slots.map((s, i) => {
    if (s.kind === 'bot') return { name: names[i], kind: 'bot', source: s.file, sourceHash: getBot(s.file)?.hash };
    if (s.kind === 'dummy') return { name: names[i], kind: 'dummy', source: s.dummy };
    return { name: names[i], kind: 'human', source: 'keyboard' };
  });
}

export function replayFileName(replay: Replay): string {
  const stamp = replay.createdAt.replace(/[:.]/g, '-').slice(0, 19);
  return `harena-${replay.map.id}-${replay.seed}-${stamp}.json`;
}

export interface MatchCallbacks {
  onExit: () => void;
  onReplay: (replay: Replay) => void;
}

/**
 * A live match: bots in Web Workers, optional human and dummies, the per-bot
 * log, replay recording and the results screen. Returns a teardown function.
 */
export function mountMatch(app: HTMLElement, setup: MatchSetup, callbacks: MatchCallbacks): () => void {
  const hasHuman = setup.slots.some((s) => s.kind === 'human');
  const humanId = setup.slots.findIndex((s) => s.kind === 'human');
  const map = getMap(setup.mapId);
  const names = seatNames(setup);
  const config = mergeConfig(DEFAULT_CONFIG, {
    ...(setup.debug ? { player: { startLives: 99, maxLives: 99 } } : {}),
    ...(setup.zone === false ? { zone: { damagePerSecond: 0 } } : {}),
  });
  const metaText = () => [
    t(map.name),
    t('seed {seed}', { seed: escapeHtml(setup.seed) }),
    setup.timeLimit > 0 ? t('{s}s', { s: setup.timeLimit }) : t('no time limit'),
    ...(setup.zone === false ? [t('no zone')] : []),
    ...(setup.debug ? [t('debug rules')] : []),
  ].join(' · ');

  let runner: MatchRunner | null = null;
  let recorder: ReplayRecorder | null = null;
  let bots: Array<BotController | null> = [];
  let lastReplay: Replay | null = null;
  let logsDirty = true;

  const shell = new ArenaShell(app, {
    meta: metaText(),
    restartLabel: t('Restart'),
    side: `
      <div class="logs">
        <div class="logs-head"><b>${t('Bot log')}</b><select id="log-filter"></select></div>
        <div class="log-list" id="log-list"></div>
      </div>`,
    help: `${hasHuman ? t('<b>WASD</b> move · <b>mouse</b> aim · <b>click/Space</b> attack<br /><b>1/2/3/4</b> knife/gun/launcher/laser · <b>Q</b> next weapon · <b>E/right click</b> mine · <b>F/C</b> throw smoke/gas to the cursor<br />') : ''}
      ${t('<b>P</b> pause · <b>N</b> step · <b>[ ]</b> speed · <b>R</b> restart · <b>F3</b> debug')}
      ${setup.debug ? t('<br />Cheats: <b>G</b> all weapons + ammo + mines · <b>H</b> heal + shield') : ''}`,
  }, {
    viewerId: hasHuman ? humanId : undefined,
    onRestart: () => start(),
    onExit: () => callbacks.onExit(),
    onEvents: (events, s) => {
      if (events.some((e) => e.type === 'matchEnd')) finish(s);
    },
    onPanel: (s) => {
      const time = s.tick / s.config.tickRate;
      const left = s.timeLimitTicks > 0 ? t(' · {s}s left', { s: Math.max(0, setup.timeLimit - time).toFixed(0) }) : '';
      shell.setInfo(`${t('tick {tick} · {time}s', { tick: s.tick, time: time.toFixed(1) })}${left}${zoneStatus(s)} · ${shell.loop?.actualTps ?? 0} tps`);
      if (logsDirty) renderLogs();
    },
    onKey: (e) => {
      if (e.code === 'KeyG') return cheat('arm');
      if (e.code === 'KeyH') return cheat('heal');
      return false;
    },
  });

  const logList = shell.el('log-list');
  const logFilter = shell.el<HTMLSelectElement>('log-filter');
  logFilter.add(new Option(t('All bots'), 'all'));
  setup.slots.forEach((s, id) => {
    if (s.kind === 'bot') logFilter.add(new Option(names[id], String(id)));
  });
  logFilter.onchange = () => {
    logsDirty = true;
  };

  function renderLogs(): void {
    const filter = logFilter.value;
    const rows = bots.flatMap((bot, id) => (!bot || (filter !== 'all' && filter !== String(id)) ? [] : bot.logs.map((entry) => ({ id, entry }))));
    rows.sort((a, b) => a.entry.tick - b.entry.tick);
    const shown = rows.slice(-200);
    logList.innerHTML = shown.length === 0
      ? `<div class="log-empty">${t('No messages yet.')}</div>`
      : shown.map(({ id, entry }) => `
        <div class="log ${entry.level}">
          <span class="log-tick">${entry.tick}</span>
          <span class="dot" style="background:${playerColor(id)}"></span>
          <span class="log-msg">${escapeHtml(entry.message)}${entry.count > 1 ? ` <span class="log-count">×${entry.count}</span>` : ''}</span>
        </div>`).join('');
    logList.scrollTop = logList.scrollHeight;
    logsDirty = false;
  }

  function cheat(kind: CheatKind): boolean {
    if (!setup.debug || humanId < 0 || !runner || runner.state.over) return false;
    if (applyCheat(runner.state, humanId, kind)) recorder?.recordCheat(runner.state.tick, humanId, kind);
    return true;
  }

  function sources(): string[] {
    return setup.slots.map((s) => (s.kind === 'bot' ? (getBot(s.file)?.local ? t('your bot') : s.file) : s.kind === 'human' ? t('keyboard') : t('dummy: {kind}', { kind: t(s.dummy) })));
  }

  function finish(s: GameState): void {
    const botStats = bots.map((b) => (b ? structuredClone(b.stats) : null));
    lastReplay = recorder ? recorder.finish(s, botStats) : null;
    showResults(shell.results, { state: s, botStats, sources: sources() }, {
      watchReplay: lastReplay ? () => callbacks.onReplay(lastReplay!) : undefined,
      download: lastReplay ? () => downloadJson(replayFileName(lastReplay!), lastReplay) : undefined,
      exportVideo: lastReplay ? () => openVideoExport(lastReplay!) : undefined,
      rematch: () => start(),
      newSeed: () => {
        setup.seed = randomSeed();
        saveSetup(setup);
        shell.root.querySelector('.match-meta')!.innerHTML = metaText();
        start();
      },
      setup: () => callbacks.onExit(),
    });
  }

  function start(): void {
    shell.loop?.stop();
    runner?.dispose();
    logsDirty = true;

    const state = createGame({ map, config, seed: setup.seed, timeLimit: setup.timeLimit, players: names.map((name) => ({ name })) });
    bots = [];
    const controllers: Controller[] = setup.slots.map((slot, id) => {
      if (slot.kind === 'human') {
        bots.push(null);
        return new HumanController(shell.canvas, shell.renderer);
      }
      if (slot.kind === 'dummy') {
        bots.push(null);
        return new DummyController(slot.dummy);
      }
      const bot = new BotController({
        name: names[id],
        fileName: slot.file,
        source: getBot(slot.file)?.source ?? '',
        botSeed: `${setup.seed}::bot${id}`,
        createWorker: createBrowserWorker,
        onLog: () => {
          logsDirty = true;
        },
      });
      bots.push(bot);
      return bot;
    });

    const current = new MatchRunner(state, controllers);
    recorder = new ReplayRecorder({ seed: setup.seed, timeLimit: setup.timeLimit, map, config, players: seatInfo(setup, names) });
    current.recorder = recorder;
    runner = current;
    const loop = shell.run(current);
    shell.setInfo(t('starting bots…'));
    void current.init().then(() => {
      if (runner === current) loop.start();
    });
  }

  start();
  return () => {
    shell.dispose();
    runner?.dispose();
    runner = null;
  };
}
