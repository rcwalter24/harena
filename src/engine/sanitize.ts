import { normalizeAngle } from './dmath.ts';
import { IDLE_ACTION, type ActionInput, type Weapon } from './types.ts';

export interface SanitizeResult {
  action: ActionInput;
  /** false if the bot returned something malformed; the action is then idle. */
  valid: boolean;
  /** Human-readable description of what was wrong (empty when valid). */
  problems: string[];
}

const WEAPONS: readonly Weapon[] = ['knife', 'gun', 'launcher'];
const KNOWN_KEYS = new Set(['move', 'aim', 'attack', 'weapon', 'plantMine']);

const quantize = (v: number, step: number) => Math.round(v / step) * step;

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return `the string ${JSON.stringify(v.slice(0, 20))}`;
  return typeof v;
}

/**
 * Turn whatever a bot returned into a safe engine action.
 *
 * - null / undefined → stand still (valid).
 * - Anything that is not a plain object, or any known field of the wrong type
 *   or non-finite → the whole action is rejected (idle) and marked invalid.
 * - Unknown extra fields are ignored.
 * - move is clamped to length <= 1; aim is normalized. Both are quantized
 *   (move to 1e-3, aim to 1e-4) so recorded replays apply identical numbers.
 */
export function sanitizeAction(raw: unknown): SanitizeResult {
  if (raw === null || raw === undefined) return { action: { ...IDLE_ACTION }, valid: true, problems: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { action: { ...IDLE_ACTION }, valid: false, problems: [`action must be an object, got ${describe(raw)}`] };
  }
  const problems: string[] = [];
  const obj = raw as Record<string, unknown>;
  const action: ActionInput = { ...IDLE_ACTION };

  try {
    const move = obj.move;
    if (move !== undefined && move !== null) {
      const m = move as Record<string, unknown>;
      if (typeof move !== 'object' || Array.isArray(move) || typeof m.x !== 'number' || typeof m.y !== 'number'
        || !Number.isFinite(m.x) || !Number.isFinite(m.y)) {
        problems.push(`move must be {x: finite number, y: finite number}, got ${describe(move)}`);
      } else {
        let x = m.x;
        let y = m.y;
        const len = Math.sqrt(x * x + y * y);
        if (len > 1) {
          x /= len;
          y /= len;
        }
        action.moveX = quantize(x, 1e-3);
        action.moveY = quantize(y, 1e-3);
      }
    }

    const aim = obj.aim;
    if (aim !== undefined && aim !== null) {
      if (typeof aim !== 'number' || !Number.isFinite(aim)) problems.push(`aim must be a finite number, got ${describe(aim)}`);
      else action.aim = normalizeAngle(quantize(normalizeAngle(aim), 1e-4));
    }

    const attack = obj.attack;
    if (attack !== undefined && attack !== null) {
      if (typeof attack !== 'boolean') problems.push(`attack must be a boolean, got ${describe(attack)}`);
      else action.attack = attack;
    }

    const weapon = obj.weapon;
    if (weapon !== undefined && weapon !== null) {
      if (!WEAPONS.includes(weapon as Weapon)) problems.push(`weapon must be one of ${WEAPONS.join(', ')}, got ${describe(weapon)}`);
      else action.weapon = weapon as Weapon;
    }

    const plantMine = obj.plantMine;
    if (plantMine !== undefined && plantMine !== null) {
      if (typeof plantMine !== 'boolean') problems.push(`plantMine must be a boolean, got ${describe(plantMine)}`);
      else action.plantMine = plantMine;
    }
  } catch (err) {
    // Only reachable for in-process objects with throwing getters; worker results are plain data.
    problems.push(`reading the action threw: ${String(err)}`);
  }

  if (problems.length > 0) return { action: { ...IDLE_ACTION }, valid: false, problems };
  return { action, valid: true, problems };
}

/** Field names the engine understands (for warnings about typos such as "atack"). */
export function unknownActionKeys(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.keys(raw).filter((k) => !KNOWN_KEYS.has(k));
}
