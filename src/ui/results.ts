import type { GameState, PlayerState } from '../engine/types.ts';
import type { BotStats } from '../match/supervisor.ts';
import { playerColor } from '../render/renderer.ts';

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
  const detail = `timeouts ${stats.timeouts}, errors ${stats.errors}, invalid ${stats.invalid}, restarts ${stats.restarts}, max ${stats.maxDecideMs.toFixed(2)} ms`;
  const label = problems === 0 && stats.restarts === 0 ? `✓ ${avg.toFixed(2)} ms` : `⚠ ${problems} fail${problems === 1 ? '' : 's'}`;
  return `<span class="${problems ? 'warn-text' : 'muted'}" title="${detail}">${label}</span>`;
}

function itemsCell(p: PlayerState): string {
  const detail = Object.entries(p.stats.itemsByType).filter(([, n]) => n > 0).map(([t, n]) => `${t} ${n}`).join(', ');
  return `<span title="${detail || 'none'}">${p.stats.itemsPicked}</span>`;
}

function outcome(state: GameState, p: PlayerState): string {
  if (!p.eliminated) return `${p.lives} ♥ · ${Math.ceil(p.hp + p.shield)}`;
  return `out at ${(p.eliminatedTick / state.config.tickRate).toFixed(0)}s`;
}

/** Full-screen results overlay with ranking, per-player stats and follow-up actions. */
export function showResults(host: HTMLElement, data: ResultsData, actions: ResultsActions): void {
  const { state } = data;
  const result = state.result!;
  const winners = result.ranking.filter((r) => r.rank === 1).map((r) => state.players[r.playerId].name);
  const reason = result.reason === 'timeLimit' ? 'Time limit reached' : result.reason === 'allEliminated' ? 'Everyone is out' : 'Last one standing';
  const headline = winners.length === 1 ? `🏆 ${escapeHtml(winners[0])} wins` : `Draw: ${winners.map(escapeHtml).join(', ')}`;

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
      <td class="num" title="${s.shotsHit} / ${s.shotsFired} bullets">${pct(s.shotsHit, s.shotsFired)}</td>
      <td class="num" title="swings that hit / swings">${s.knifeHits}/${s.knifeSwings}</td>
      <td class="num" title="grenades that hurt an enemy / fired">${s.grenadeHits}/${s.grenadesFired}</td>
      <td class="num">${s.minesPlanted}</td>
      <td class="num">${itemsCell(p)}</td>
      <td>${botHealth(data.botStats[p.id])}</td>
    </tr>`;
  }).join('');

  host.innerHTML = `
    <div class="results-card">
      <div class="results-head">
        <div>
          <div class="banner-sub">${reason} · ${(result.endTick / state.config.tickRate).toFixed(1)}s · seed ${escapeHtml(state.seed)}</div>
          <h2>${headline}</h2>
        </div>
        <button class="close" title="Hide (look at the final state)">×</button>
      </div>
      <div class="results-table-wrap">
        <table class="results-table">
          <thead><tr>
            <th>#</th><th>Player</th><th>Result</th><th title="kills">K</th><th title="deaths">D</th>
            <th title="damage dealt">Dealt</th><th title="damage taken">Taken</th><th title="gun accuracy">Gun acc.</th>
            <th>Knife</th><th>Grenades</th><th>Mines</th><th>Items</th><th title="bot sandbox: average decide() time or failures">Bot</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="results-actions">
        ${actions.watchReplay ? '<button data-act="watchReplay">▶ Watch replay</button>' : ''}
        ${actions.download ? '<button data-act="download">⬇ Download replay</button>' : ''}
        ${actions.exportVideo ? '<button data-act="exportVideo">🎬 Export video</button>' : ''}
        ${actions.rematch ? '<button data-act="rematch">Rematch (same seed)</button>' : ''}
        ${actions.newSeed ? '<button data-act="newSeed">Rematch (new seed)</button>' : ''}
        <button data-act="setup" class="primary">Back to setup</button>
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
