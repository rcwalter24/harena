import { IDLE_ACTION, type ActionInput, type GameState, type Weapon } from '../engine/types.ts';
import type { Controller } from '../match/controller.ts';
import type { Renderer } from '../render/renderer.ts';

/**
 * Keyboard + mouse player for testing rule feel.
 * WASD / arrows: move · mouse: aim · left click or Space: attack ·
 * 1: knife · 2: gun · 3: launcher · Q: next owned weapon · E or right click: plant mine.
 */
export class HumanController implements Controller {
  readonly label = 'human';
  private readonly keys = new Set<string>();
  private mouse: { x: number; y: number } | null = null;
  private mouseDown = false;
  /** A click since the last tick; a press + release shorter than a tick still attacks once. */
  private clicked = false;
  private pendingWeapon: Weapon | null = null;
  private toggleWeapon = false;
  private plantMine = false;
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: Renderer;
  private readonly cleanup: Array<() => void> = [];

  constructor(canvas: HTMLCanvasElement, renderer: Renderer) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.listen(window, 'keydown', (e) => this.onKey(e as KeyboardEvent, true));
    this.listen(window, 'keyup', (e) => this.onKey(e as KeyboardEvent, false));
    this.listen(window, 'blur', () => {
      this.keys.clear();
      this.mouseDown = false;
    });
    this.listen(canvas, 'mousemove', (e) => this.onMouse(e as MouseEvent));
    this.listen(canvas, 'mousedown', (e) => {
      if ((e as MouseEvent).button === 0) {
        this.mouseDown = true;
        this.clicked = true;
      }
      if ((e as MouseEvent).button === 2) this.plantMine = true;
      this.onMouse(e as MouseEvent);
    });
    this.listen(window, 'mouseup', (e) => {
      if ((e as MouseEvent).button === 0) this.mouseDown = false;
    });
    this.listen(canvas, 'contextmenu', (e) => e.preventDefault());
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void): void {
    target.addEventListener(type, fn);
    this.cleanup.push(() => target.removeEventListener(type, fn));
  }

  private onMouse(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
    const gameKeys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'];
    if (gameKeys.includes(e.code)) e.preventDefault();
    if (down) {
      this.keys.add(e.code);
      if (e.code === 'Digit1') this.pendingWeapon = 'knife';
      if (e.code === 'Digit2') this.pendingWeapon = 'gun';
      if (e.code === 'Digit3') this.pendingWeapon = 'launcher';
      if (e.code === 'KeyE' && !e.repeat) this.plantMine = true;
      if (e.code === 'Space' && !e.repeat) this.clicked = true;
      if (e.code === 'KeyQ' && !e.repeat) this.toggleWeapon = true;
    } else {
      this.keys.delete(e.code);
    }
  }

  decide(state: Readonly<GameState>, playerId: number): ActionInput {
    const self = state.players[playerId];
    if (!self.alive) {
      this.pendingWeapon = null;
      this.toggleWeapon = false;
      this.plantMine = false;
      this.clicked = false;
      return IDLE_ACTION;
    }
    const k = this.keys;
    let mx = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let my = (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0);
    if (mx !== 0 && my !== 0) {
      mx *= Math.SQRT1_2;
      my *= Math.SQRT1_2;
    }
    let aim: number | null = null;
    if (this.mouse) {
      const w = this.renderer.screenToWorld(this.mouse.x, this.mouse.y);
      aim = Math.atan2(w.y - self.y, w.x - self.x);
    }
    let weapon = this.pendingWeapon;
    if (this.toggleWeapon) {
      const owned: Weapon[] = ['knife'];
      if (self.hasGun) owned.push('gun');
      if (self.hasLauncher) owned.push('launcher');
      weapon = owned[(owned.indexOf(self.weapon) + 1) % owned.length];
    }
    const plantMine = this.plantMine;
    const attack = this.mouseDown || k.has('Space') || this.clicked;
    this.pendingWeapon = null;
    this.toggleWeapon = false;
    this.plantMine = false;
    this.clicked = false;
    return { moveX: mx, moveY: my, aim, attack, weapon, plantMine };
  }

  dispose(): void {
    for (const fn of this.cleanup) fn();
  }
}
