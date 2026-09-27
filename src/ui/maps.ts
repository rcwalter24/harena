import { validateMap } from '../engine/maps.ts';
import type { MapData } from '../engine/types.ts';

const modules = import.meta.glob('/maps/*.json', { eager: true, import: 'default' });

/** All maps in maps/, validated, sorted by id. */
export const MAPS: MapData[] = Object.values(modules)
  .map((raw) => validateMap(raw))
  .sort((a, b) => a.id.localeCompare(b.id));

export function getMap(id: string): MapData {
  const map = MAPS.find((m) => m.id === id);
  if (!map) throw new Error(`Unknown map "${id}"`);
  return map;
}
