import type { GameEvent, GameState } from '../engine/types.ts';
import { playerColor } from '../render/renderer.ts';

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
        ? 'eliminated'
        : !p.alive
          ? `respawn in ${(p.respawnTimer / state.config.tickRate).toFixed(1)}s`
          : p.invulnerableTimer > 0 ? 'invulnerable' : '';
      const weapon = p.weapon === 'gun' ? `gun · ${p.ammo}` : p.hasGun ? `knife (gun · ${p.ammo})` : 'knife';
      card.innerHTML = `
        <div class="card-head">
          <span class="dot" style="background:${playerColor(p.id)}"></span>
          <span class="name"></span>
          <span class="lives" title="lives">♥ ${p.lives}</span>
        </div>
        <div class="bar hp"><div style="width:${(100 * p.hp) / player.maxHp}%"></div><span>${Math.ceil(p.hp)}</span></div>
        <div class="bar shield"><div style="width:${(100 * p.shield) / player.maxShield}%"></div><span>${Math.ceil(p.shield)}</span></div>
        <div class="card-foot"><span>${weapon}</span><span>K ${p.stats.kills} · D ${p.stats.deaths}</span></div>
        <div class="status">${status}</div>`;
      card.querySelector('.name')!.textContent = p.name;
    }
  }
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
          row.append(name(e.killerId), el('span', 'how', e.weapon === 'gun' ? ' ⁍ ' : ' 🗡 '), name(e.playerId));
        } else {
          row.append(name(e.playerId), el('span', 'how', ' died'));
        }
      } else {
        row.append(name(e.playerId), el('span', 'how', ' is eliminated'));
        row.classList.add('elim');
      }
      this.root.prepend(row);
      setTimeout(() => row.classList.add('fade'), 5000);
      setTimeout(() => row.remove(), 6000);
      while (this.root.children.length > 8) this.root.lastElementChild?.remove();
    }
  }
}
