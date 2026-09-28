import type { GameEvent, GameState } from '../engine/types.ts';
import { zoneAt, zoneEnabled } from '../engine/systems/zone.ts';
import { playerColor } from '../render/renderer.ts';
import { t } from './i18n.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** Side-panel cards: name, lives, hp/shield bars, weapon + ammo, K/D. */
export class PlayerCards {
  private readonly root: HTMLElement;
  private cards: HTMLElement[] = [];

  constructor(root: HTMLElement) {
    this.root = root;
  }

  update(state: GameState, focusId?: number): void {
    const { player } = state.config;
    if (this.cards.length !== state.players.length) {
      this.root.replaceChildren();
      this.cards = state.players.map(() => {
        const card = el('div', 'card');
        this.root.appendChild(card);
        return card;
      });
    }
    for (const p of state.players) {
      const card = this.cards[p.id];
      card.classList.toggle('dead', !p.alive);
      card.classList.toggle('eliminated', p.eliminated);
      card.classList.toggle('focus', p.id === focusId);
      const status = p.eliminated
        ? t('eliminated')
        : !p.alive
          ? t('respawn in {s}s', { s: (p.respawnTimer / state.config.tickRate).toFixed(1) })
          : p.invulnerableTimer > 0 ? t('invulnerable') : '';
      const label = (w: 'knife' | 'gun' | 'launcher') => (p.weapon === w ? `<b>${t(w)}</b>` : t(w));
      const owned = [
        p.hasGun ? `${label('gun')} ${p.ammo}` : '',
        p.hasLauncher ? `${label('launcher')} ${p.grenades}` : '',
        p.mines > 0 ? t('mines {n}', { n: p.mines }) : '',
      ].filter(Boolean);
      const weapon = [label('knife'), ...owned].join(' · ');
      card.innerHTML = `
        <div class="card-head">
          <span class="dot" style="background:${playerColor(p.id)}"></span>
          <span class="name"></span>
          <span class="lives" title="${t('lives')}">♥ ${p.lives}</span>
        </div>
        <div class="bar hp"><div style="width:${(100 * p.hp) / player.maxHp}%"></div><span>${Math.ceil(p.hp)}</span></div>
        <div class="bar shield"><div style="width:${(100 * p.shield) / player.maxShield}%"></div><span>${Math.ceil(p.shield)}</span></div>
        <div class="card-weapons">${weapon}</div>
        <div class="card-foot"><span class="status">${status}</span><span>${t('K')} ${p.stats.kills} · ${t('D')} ${p.stats.deaths}</span></div>
`;
      card.querySelector('.name')!.textContent = p.name;
    }
  }
}

/** Short safe-zone status for the info line ('' when the zone is off). */
export function zoneStatus(state: GameState): string {
  if (!zoneEnabled(state.config)) return '';
  const zone = zoneAt(state);
  if (state.tick < zone.startTick) return t(' · zone shrinks in {s}s', { s: Math.ceil((zone.startTick - state.tick) / state.config.tickRate) });
  if (state.tick < zone.endTick) return t(' · zone shrinking');
  if (state.tick < zone.collapseStartTick) return t(' · zone collapses in {s}s', { s: Math.ceil((zone.collapseStartTick - state.tick) / state.config.tickRate) });
  return zone.radius > 0 ? t(' · zone collapsing') : t(' · zone closed');
}

/** Kill messages overlaid on the arena; each fades after a few seconds. */
export class KillFeed {
  private readonly root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  clear(): void {
    this.root.replaceChildren();
  }

  add(events: readonly GameEvent[], state: GameState): void {
    for (const e of events) {
      if (e.type !== 'death' && e.type !== 'eliminated') continue;
      const row = el('div', 'kill');
      const name = (id: number) => {
        const span = el('span', 'who', state.players[id].name);
        span.style.color = playerColor(id);
        return span;
      };
      if (e.type === 'death') {
        if (e.killerId >= 0) {
          const icon = e.weapon === 'gun' ? ' ⁍ ' : e.weapon === 'knife' ? ' 🗡 ' : ' 💥 ';
          row.append(name(e.killerId), el('span', 'how', icon), name(e.playerId));
        } else {
          const how = e.weapon === 'launcher' || e.weapon === 'mine' ? ' blew themselves up' : e.weapon === 'zone' ? ' was caught outside the zone' : ' died';
          row.append(name(e.playerId), el('span', 'how', t(how)));
        }
      } else {
        row.append(name(e.playerId), el('span', 'how', t(' is eliminated')));
        row.classList.add('elim');
      }
      this.root.prepend(row);
      setTimeout(() => row.classList.add('fade'), 5000);
      setTimeout(() => row.remove(), 6000);
      while (this.root.children.length > 8) this.root.lastElementChild?.remove();
    }
  }
}
