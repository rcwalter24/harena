import type { GameState, PlayerState } from '../engine/types.ts';
import type { BotStats } from '../match/supervisor.ts';
import { playerColor } from '../render/renderer.ts';
import { t } from './i18n.ts';

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export interface ResultsData {
  state: GameState;
  /** Supervisor stats for bot seats (null for humans / dummies / unknown). */
  botStats: Array<BotStats | null>;
  /** Short description per seat, e.g. "gunner.js" or "keyboard". */
  sources: string[];
}

export interface ResultsActions {
  download?: () => void;
  rematch?: () => void;
  newSeed?: () => void;
  watchReplay?: () => void;
  exportVideo?: () => void;
  setup: () => void;
}

const pct = (hit: number, total: number) => (total > 0 ? `${Math.round((100 * hit) / total)}%` : '–');

function botHealth(stats: BotStats | null): string {
  if (!stats) return '<span class="muted">–</span>';
  const problems = stats.timeouts + stats.errors + stats.invalid;
  const avg = stats.decisions > 0 ? stats.totalDecideMs / stats.decisions : 0;
  const detail = t('timeouts {t}, errors {e}, invalid {i}, restarts {r}, max {max} ms', {
    t: stats.timeouts, e: stats.errors, i: stats.invalid, r: stats.restarts, max: stats.maxDecideMs.toFixed(2),
  });
  const label = problems === 0 && stats.restarts === 0 ? `✓ ${avg.toFixed(2)} ms` : t(problems === 1 ? '⚠ {n} fail' : '⚠ {n} fails', { n: problems });
  return `<span class="${problems ? 'warn-text' : 'muted'}" title="${detail}">${label}</span>`;
}

function itemsCell(p: PlayerState): string {
  const detail = Object.entries(p.stats.itemsByType).filter(([, n]) => n > 0).map(([type, n]) => `${type} ${n}`).join(', ');
  return `<span title="${detail || t('none')}">${p.stats.itemsPicked}</span>`;
}

function outcome(state: GameState, p: PlayerState): string {
  if (!p.eliminated) return `${p.lives} ♥ · ${Math.ceil(p.hp + p.shield)}`;
  return t('out at {s}s', { s: (p.eliminatedTick / state.config.tickRate).toFixed(0) });
}

/** Full-screen results overlay with ranking, per-player stats and follow-up actions. */
export function showResults(host: HTMLElement, data: ResultsData, actions: ResultsActions): void {
  const { state } = data;
  const result = state.result!;
  const winners = result.ranking.filter((r) => r.rank === 1).map((r) => state.players[r.playerId].name);
  const reason = t(result.reason === 'timeLimit' ? 'Time limit reached' : result.reason === 'allEliminated' ? 'Everyone is out' : 'Last one standing');
  const headline = winners.length === 1 ? t('🏆 {name} wins', { name: escapeHtml(winners[0]) }) : t('Draw: {names}', { names: winners.map(escapeHtml).join(', ') });

  const rows = result.ranking.map(({ playerId, rank }) => {
    const p = state.players[playerId];
    const s = p.stats;
    return `<tr>
      <td class="num">${rank}</td>
      <td class="who"><span class="dot" style="background:${playerColor(p.id)}"></span>${escapeHtml(p.name)}<div class="muted small">${escapeHtml(data.sources[p.id] ?? '')}</div></td>
      <td>${outcome(state, p)}</td>
      <td class="num">${s.kills}</td>
      <td class="num">${s.deaths}</td>
      <td class="num">${Math.round(s.damageDealt)}</td>
      <td class="num">${Math.round(s.damageTaken)}</td>
      <td class="num" title="${t('{hit} / {fired} bullets', { hit: s.shotsHit, fired: s.shotsFired })}">${pct(s.shotsHit, s.shotsFired)}</td>
      <td class="num" title="${t('swings that hit / swings')}">${s.knifeHits}/${s.knifeSwings}</td>
      <td class="num" title="${t('grenades that hurt an enemy / fired')}">${s.grenadeHits}/${s.grenadesFired}</td>
      <td class="num" title="${t('laser hits / shots')}">${s.laserHits}/${s.lasersFired}</td>
      <td class="num">${s.minesPlanted}</td>
      <td class="num">${itemsCell(p)}</td>
      <td>${botHealth(data.botStats[p.id])}</td>
    </tr>`;
  }).join('');

  host.innerHTML = `
    <div class="results-card">
      <div class="results-head">
        <div>
          <div class="banner-sub">${reason} · ${t('{s}s', { s: (result.endTick / state.config.tickRate).toFixed(1) })} · ${t('seed {seed}', { seed: escapeHtml(state.seed) })}</div>
          <h2>${headline}</h2>
        </div>
        <button class="close" title="${t('Hide (look at the final state)')}">×</button>
      </div>
      <div class="results-table-wrap">
        <table class="results-table">
          <thead><tr>
            <th>#</th><th>${t('Player')}</th><th>${t('Result')}</th><th title="${t('kills')}">${t('K')}</th><th title="${t('deaths')}">${t('D')}</th>
            <th title="${t('damage dealt')}">${t('Dealt')}</th><th title="${t('damage taken')}">${t('Taken')}</th><th title="${t('gun accuracy')}">${t('Gun acc.')}</th>
            <th>${t('Knife')}</th><th>${t('Grenades')}</th><th>${t('Laser')}</th><th>${t('Mines')}</th><th>${t('Items')}</th><th title="${t('bot sandbox: average decide() time or failures')}">${t('Bot')}</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="results-actions">
        ${actions.watchReplay ? `<button data-act="watchReplay">${t('▶ Watch replay')}</button>` : ''}
        ${actions.download ? `<button data-act="download">${t('⬇ Download replay')}</button>` : ''}
        ${actions.exportVideo ? `<button data-act="exportVideo">${t('🎬 Export video')}</button>` : ''}
        ${actions.rematch ? `<button data-act="rematch">${t('Rematch (same seed)')}</button>` : ''}
        ${actions.newSeed ? `<button data-act="newSeed">${t('Rematch (new seed)')}</button>` : ''}
        <button data-act="setup" class="primary">${t('Back to setup')}</button>
      </div>
    </div>`;
  host.classList.remove('hidden');
  host.querySelector<HTMLButtonElement>('.close')!.onclick = () => host.classList.add('hidden');
  for (const btn of host.querySelectorAll<HTMLButtonElement>('[data-act]')) {
    const act = actions[btn.dataset.act as keyof ResultsActions];
    btn.onclick = () => act?.();
  }
}

/** Save a JSON object as a file download. */
export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
