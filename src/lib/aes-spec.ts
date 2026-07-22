// src/lib/aes-spec.ts — the AES-100 specification made executable.
// Every module in the AES books (Document ID, dependency chain, engineering mission,
// repository structure and object model) is extracted into structured data and served
// from here. This is the specification itself, machine-readable and browsable — it does
// not claim the abstract systems are implemented; §"status" is honest about that.
import MODULES from '@/data/aes-modules.json';

export interface AesModule {
  id: string;            // e.g. AES100-V8-P2-CH58
  chapter: number;
  volume: string;
  part: string;
  title: string;
  dependsOn: string;
  produces: string;
  mission: string;
  repository: string[];  // §7 repository structure
  objectName: string;    // §8 object model name
  fields: string[];      // §8 object model fields
}

const ALL = MODULES as unknown as AesModule[];

/** Every module, in execution order (chapter ascending = the dependency sequence). */
export function allModules(): AesModule[] { return ALL; }
export function moduleById(id: string): AesModule | null { return ALL.find((m) => m.id === id) || null; }
export function modulesByVolume(volume: string): AesModule[] { return ALL.filter((m) => m.volume === volume); }

/** Volumes present in the books, with counts — ordered numerically. */
export function volumeSummary(): { volume: string; count: number; first: number; last: number }[] {
  const map = new Map<string, AesModule[]>();
  for (const m of ALL) { const k = m.volume; if (!map.has(k)) map.set(k, []); map.get(k)!.push(m); }
  return [...map.entries()]
    .map(([volume, list]) => ({ volume, count: list.length, first: Math.min(...list.map((x) => x.chapter)), last: Math.max(...list.map((x) => x.chapter)) }))
    .sort((a, b) => Number(a.volume) - Number(b.volume));
}

export function specStats() {
  return {
    modules: ALL.length,
    withRepository: ALL.filter((m) => m.repository.length > 0).length,
    withObjectModel: ALL.filter((m) => m.fields.length > 0).length,
    fields: ALL.reduce((n, m) => n + m.fields.length, 0),
    firstChapter: Math.min(...ALL.map((m) => m.chapter)),
    lastChapter: Math.max(...ALL.map((m) => m.chapter)),
    volumes: new Set(ALL.map((m) => m.volume)).size,
  };
}

/** Free-text search across id / title / mission / object model. */
export function searchModules(q: string, limit = 60): AesModule[] {
  const needle = (q || '').trim().toLowerCase();
  if (!needle) return ALL.slice(0, limit);
  return ALL.filter((m) =>
    m.id.toLowerCase().includes(needle) ||
    m.title.toLowerCase().includes(needle) ||
    m.objectName.toLowerCase().includes(needle) ||
    m.mission.toLowerCase().includes(needle) ||
    m.fields.some((f) => f.toLowerCase().includes(needle))
  ).slice(0, limit);
}

/** The Roman numeral for a volume (the books number volumes in Roman). */
export function roman(v: string): string {
  const n = Number(v);
  const table: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  if (!Number.isFinite(n) || n <= 0) return v;
  let out = '', rest = n;
  for (const [val, sym] of table) while (rest >= val) { out += sym; rest -= val; }
  return out;
}
