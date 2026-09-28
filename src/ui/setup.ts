import { DEFAULT_CONFIG } from '../engine/config.ts';
import { createGame } from '../engine/game.ts';
import { validateReplay, type Replay } from '../engine/replay.ts';
import { drawMapPreview } from '../render/mapPreview.ts';
import { DUMMY_KINDS, type DummyKind } from '../match/dummies.ts';
import type { BotReview } from '../review/jev.ts';
import { playerColor } from '../render/renderer.ts';
import { BOTS, fetchReviews, getBot, requestReview, reviewBadge, type BotEntry, type ReviewBadge } from './bots.ts';
import { MAPS } from './maps.ts';
import { loadSetup, randomSeed, saveSetup, type MatchSetup, type SlotSpec } from './matchSetup.ts';

const BADGE_TEXT: Record<ReviewBadge, string> = {
  pass: 'reviewed ✓',
  warn: 'review: warning',
  danger: 'review: danger',
  blocked: 'blocked',
  error: 'review failed',
  stale: 'changed since review',
  unreviewed: 'not reviewed',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function defaultSetup(): MatchSetup {
  const examples = ['gunner.js', 'chaser.js'].filter((f) => getBot(f));
  return {
    mapId: MAPS[0]?.id ?? '',
    seed: randomSeed(),
    timeLimit: DEFAULT_CONFIG.match.defaultTimeLimit,
    debug: false,
    slots: examples.map((file) => ({ kind: 'bot', file })),
  };
}

/** Drop slots whose bot no longer exists (or is now blocked) and fix an unknown map. */
function sanitizeSetup(setup: MatchSetup): MatchSetup {
  const slots = setup.slots.filter((s) => s.kind !== 'bot' || getBot(s.file)?.static.ok);
  return {
    ...setup,
    mapId: MAPS.some((m) => m.id === setup.mapId) ? setup.mapId : MAPS[0]?.id ?? '',
    slots: slots.slice(0, DEFAULT_CONFIG.match.maxPlayers),
  };
}

/** Match setup page: bot library with reviews, seats, map, seed and time limit. */
export interface SetupCallbacks {
  onStart: (setup: MatchSetup) => void;
  onReplay: (replay: Replay) => void;
}

export function mountSetup(app: HTMLElement, callbacks: SetupCallbacks): () => void {
  const onStart = callbacks.onStart;
  let setup = sanitizeSetup(loadSetup() ?? defaultSetup());
  let reviews: Record<string, BotReview> = {};
  const reviewing = new Set<string>();
  const maxPlayers = DEFAULT_CONFIG.match.maxPlayers;

  app.innerHTML = `
    <div class="setup">
      <header class="setup-head">
        <h1>Harena <small>bot arena</small></h1>
        <div class="head-links">
          <button id="load-replay" title="Open a replay .json file">Load replay…</button>
          <input type="file" id="replay-file" accept=".json,application/json" hidden />
          <a class="doc-link" href="/BOT_API.md" target="_blank" rel="noreferrer">BOT_API.md</a>
        </div>
      </header>
      <div class="setup-grid">
        <section class="box">
          <h2>Bots <small>from <code>bots/</code></small></h2>
          <div id="bot-list" class="bot-list"></div>
          <h2>Other players</h2>
          <div class="other-players">
            <button id="add-human">+ You (keyboard)</button>
            <select id="dummy-kind"></select>
            <button id="add-dummy">+ Dummy</button>
          </div>
        </section>
        <section class="box">
          <h2>Match</h2>
          <div class="form">
            <label>Map <select id="map"></select></label>
            <canvas id="map-preview" class="map-preview"></canvas>
            <div class="note">Coloured dots: where each player starts with this seed.</div>
            <label>Seed <span class="seed-row"><input type="text" id="seed" /><button id="reseed" title="Random seed">🎲</button></span></label>
            <label>Time limit (s) <input type="number" id="time" min="0" max="3600" step="10" /></label>
            <label class="check"><input type="checkbox" id="debug" /> Debug rules (99 lives, cheat keys)</label>
          </div>
          <h2>Players <small id="count"></small></h2>
          <div id="slots" class="slots"></div>
          <div id="start-note" class="note"></div>
          <button id="start" class="primary">Start match</button>
        </section>
      </div>
    </div>`;

  const $ = <T extends HTMLElement>(id: string) => app.querySelector<T>(`#${id}`)!;
  const botList = $('bot-list');
  const slotsEl = $('slots');
  const mapSelect = $<HTMLSelectElement>('map');
  const seedInput = $<HTMLInputElement>('seed');
  const timeInput = $<HTMLInputElement>('time');
  const debugBox = $<HTMLInputElement>('debug');
  const dummyKind = $<HTMLSelectElement>('dummy-kind');

  for (const m of MAPS) mapSelect.add(new Option(`${m.name} (${m.width}×${m.height})`, m.id));
  for (const k of DUMMY_KINDS) dummyKind.add(new Option(k, k));

  function persist(): void {
    saveSetup(setup);
  }

  function slotLabel(slot: SlotSpec): { name: string; sub: string; badge?: ReviewBadge } {
    if (slot.kind === 'human') return { name: 'You', sub: 'keyboard + mouse' };
    if (slot.kind === 'dummy') return { name: `${slot.dummy} dummy`, sub: 'scripted test opponent' };
    const bot = getBot(slot.file)!;
    return { name: bot.name, sub: slot.file, badge: reviewBadge(bot, reviews[slot.file]) };
  }

  function renderBots(): void {
    if (BOTS.length === 0) {
      botList.innerHTML = '<div class="note">No bots found. Put <code>.js</code> files in <code>bots/</code>.</div>';
      return;
    }
    botList.innerHTML = '';
    for (const bot of BOTS) botList.appendChild(botRow(bot));
  }

  function botRow(bot: BotEntry): HTMLElement {
    const review = reviews[bot.file];
    const badge = reviewBadge(bot, review);
    const row = document.createElement('div');
    row.className = `bot-row badge-${badge}`;
    const staticErrors = bot.static.findings.filter((f) => f.severity === 'error');
    const staticWarnings = bot.static.findings.filter((f) => f.severity === 'warning');
    const reasons = [
      ...staticErrors.map((f) => `⛔ ${f.message}${f.line ? ` (line ${f.line})` : ''}`),
      ...staticWarnings.map((f) => `⚠ ${f.message}${f.line ? ` (line ${f.line})` : ''}`),
      ...(review && review.sourceHash === bot.hash ? review.reasons.filter((r) => !r.startsWith('static:')) : []),
    ];
    const jev = review && review.sourceHash === bot.hash && review.jev && !('error' in review.jev) ? review.jev : null;
    const details = jev
      ? `quality ${jev.quality.score.toFixed(1)}/${jev.quality.max} · interface: ${jev.conformance.choice} · ${new Date(review!.reviewedAt).toLocaleString()}`
      : '';
    row.innerHTML = `
      <div class="bot-main">
        <div class="bot-name">${escapeHtml(bot.name)} <span class="bot-file">${escapeHtml(bot.file)}${bot.author ? ` · ${escapeHtml(bot.author)}` : ''}</span></div>
        <span class="badge ${badge}">${reviewing.has(bot.file) ? 'reviewing…' : BADGE_TEXT[badge]}</span>
        <button class="review" ${reviewing.has(bot.file) ? 'disabled' : ''} title="Static check + Jev AI review">Review</button>
        <button class="add" ${!bot.static.ok || setup.slots.length >= maxPlayers ? 'disabled' : ''}>+ Add</button>
      </div>
      ${reasons.length || details ? `<div class="bot-reasons">${reasons.map((r) => `<div>${escapeHtml(r)}</div>`).join('')}${details ? `<div class="muted">${escapeHtml(details)}</div>` : ''}</div>` : ''}`;
    row.querySelector<HTMLButtonElement>('.add')!.onclick = () => addSlot({ kind: 'bot', file: bot.file });
    row.querySelector<HTMLButtonElement>('.review')!.onclick = () => void runReview(bot.file);
    return row;
  }

  async function runReview(file: string): Promise<void> {
    reviewing.add(file);
    renderBots();
    try {
      reviews[file] = await requestReview(file);
    } catch (err) {
      alert(`Review of ${file} failed: ${(err as Error).message}`);
    } finally {
      reviewing.delete(file);
      renderAll();
    }
  }

  function renderSlots(): void {
    $('count').textContent = `${setup.slots.length} / ${maxPlayers}`;
    slotsEl.innerHTML = '';
    if (setup.slots.length === 0) slotsEl.innerHTML = '<div class="note">Add bots from the list.</div>';
    setup.slots.forEach((slot, i) => {
      const { name, sub, badge } = slotLabel(slot);
      const el = document.createElement('div');
      el.className = 'slot';
      const flag = badge === 'warn' || badge === 'danger' || badge === 'error'
        ? `<span class="badge ${badge}" title="See the bot's review">${BADGE_TEXT[badge]}</span>`
        : '';
      el.innerHTML = `
        <span class="dot" style="background:${playerColor(i)}"></span>
        <span class="slot-name">${escapeHtml(name)}</span>
        <span class="slot-sub">${escapeHtml(sub)}</span>
        ${flag}
        <button class="remove" title="Remove">×</button>`;
      el.querySelector<HTMLButtonElement>('.remove')!.onclick = () => {
        setup.slots.splice(i, 1);
        persist();
        renderAll();
      };
      slotsEl.appendChild(el);
    });
    const note = $('start-note');
    const start = $<HTMLButtonElement>('start');
    const needed = setup.debug ? 1 : 2;
    start.disabled = setup.slots.length < needed;
    note.textContent = setup.slots.length < needed
      ? `Add at least ${needed} player${needed > 1 ? 's' : ''}${setup.debug ? '' : ' (or enable debug rules to play alone)'}.`
      : '';
  }

  /** The preview shows where each seat actually starts for the current seed. */
  function renderPreview(): void {
    const map = MAPS.find((m) => m.id === setup.mapId);
    if (!map) return;
    let starts: { x: number; y: number }[] = [];
    if (setup.slots.length > 0 && setup.slots.length <= map.spawns.length) {
      const state = createGame({ map, seed: setup.seed, timeLimit: 0, players: setup.slots.map((_, i) => ({ name: String(i) })) });
      starts = state.players.map((p) => ({ x: p.x, y: p.y }));
    }
    drawMapPreview($<HTMLCanvasElement>('map-preview'), map, starts);
  }

  function renderForm(): void {
    mapSelect.value = setup.mapId;
    renderPreview();
    seedInput.value = setup.seed;
    timeInput.value = String(setup.timeLimit);
    debugBox.checked = setup.debug;
    $<HTMLButtonElement>('add-human').disabled = setup.slots.some((s) => s.kind === 'human') || setup.slots.length >= maxPlayers;
    $<HTMLButtonElement>('add-dummy').disabled = setup.slots.length >= maxPlayers;
  }

  function renderAll(): void {
    renderBots();
    renderSlots();
    renderForm();
  }

  function addSlot(slot: SlotSpec): void {
    if (setup.slots.length >= maxPlayers) return;
    setup.slots.push(slot);
    persist();
    renderAll();
  }

  mapSelect.onchange = () => {
    setup.mapId = mapSelect.value;
    persist();
    renderForm();
  };
  const fileInput = $<HTMLInputElement>('replay-file');
  $('load-replay').onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      callbacks.onReplay(validateReplay(JSON.parse(await file.text())));
    } catch (err) {
      alert(`Could not open ${file.name}: ${(err as Error).message}`);
    }
  };
  seedInput.oninput = () => {
    setup.seed = seedInput.value.trim() || '0';
    persist();
    renderPreview();
  };
  $('reseed').onclick = () => {
    setup.seed = randomSeed();
    persist();
    renderForm();
  };
  timeInput.oninput = () => {
    const v = Number(timeInput.value);
    setup.timeLimit = Number.isFinite(v) && v >= 0 ? Math.min(3600, Math.round(v)) : setup.timeLimit;
    persist();
  };
  debugBox.onchange = () => {
    setup.debug = debugBox.checked;
    persist();
    renderSlots();
  };
  $('add-human').onclick = () => addSlot({ kind: 'human' });
  $('add-dummy').onclick = () => addSlot({ kind: 'dummy', dummy: dummyKind.value as DummyKind });
  $('start').onclick = () => {
    persist();
    onStart(structuredClone(setup));
  };

  renderAll();
  void fetchReviews().then((r) => {
    reviews = r;
    renderAll();
  });

  return () => {
    app.innerHTML = '';
  };
}
