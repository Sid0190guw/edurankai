// Feature flags — hide in-development / non-functional surfaces so nothing reads
// as a dead end. Now DB-backed and editable by a super-admin at
// /admin/feature-flags. Precedence for a flag's value:
//   1. DB override (admin toggle)  ->  2. env var FEATURE_<ENV>  ->  3. default
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export interface FlagDef { key: string; env: string; label: string; desc: string; def: boolean; group: string; }

// Catalog — add a row here to expose a new flag in the admin panel.
export const FLAG_CATALOG: FlagDef[] = [
  { key: 'aiTutor',        env: 'AI_TUTOR',        label: 'AI conversation tutor', desc: 'Conversational AI tutor (/aquintutor/converse). Needs the LLM key + a verified flow.', def: false, group: 'AquinTutor' },
  { key: 'dailyChallenge', env: 'DAILY_CHALLENGE', label: 'Daily challenge',        desc: 'Daily challenge surface (/aquintutor/daily).', def: false, group: 'AquinTutor' },
  { key: 'storyReading',   env: 'STORY_READING',   label: 'Story reading',          desc: 'Story-reading practice mode.', def: false, group: 'AquinTutor' },
];

function envOverride(envName: string): boolean | null {
  const raw = (typeof process !== 'undefined' && process.env && process.env['FEATURE_' + envName]) || '';
  const v = raw.toLowerCase();
  if (v === 'on' || v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'off' || v === 'false' || v === '0' || v === 'no') return false;
  return null;
}

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

let ready: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS feature_flags (
        key TEXT PRIMARY KEY,
        enabled BOOLEAN NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    } catch (_) { ready = null; }
  })();
  return ready;
}

async function dbFlags(): Promise<Record<string, boolean>> {
  try {
    await ensureSchema();
    const out: Record<string, boolean> = {};
    for (const r of rows(await db.execute(sql`SELECT key, enabled FROM feature_flags`))) out[r.key] = !!r.enabled;
    return out;
  } catch { return {}; }
}

/** Resolve one flag (async). DB override > env > default. */
export async function isFeatureEnabled(key: string): Promise<boolean> {
  const cat = FLAG_CATALOG.find((f) => f.key === key);
  if (!cat) return false;
  const overrides = await dbFlags();
  if (key in overrides) return overrides[key];
  const env = envOverride(cat.env);
  if (env !== null) return env;
  return cat.def;
}

/** All flags with their resolved value + where it came from (for the admin UI). */
export async function getAllFlags(): Promise<Array<FlagDef & { enabled: boolean; source: 'admin' | 'env' | 'default' }>> {
  const overrides = await dbFlags();
  return FLAG_CATALOG.map((cat) => {
    if (cat.key in overrides) return { ...cat, enabled: overrides[cat.key], source: 'admin' as const };
    const env = envOverride(cat.env);
    if (env !== null) return { ...cat, enabled: env, source: 'env' as const };
    return { ...cat, enabled: cat.def, source: 'default' as const };
  });
}

/** Admin: set (or clear) a flag override. */
export async function setFlag(key: string, enabled: boolean): Promise<void> {
  if (!FLAG_CATALOG.find((f) => f.key === key)) return;
  await ensureSchema();
  await db.execute(sql`
    INSERT INTO feature_flags (key, enabled, updated_at) VALUES (${key}, ${enabled}, NOW())
    ON CONFLICT (key) DO UPDATE SET enabled = ${enabled}, updated_at = NOW()
  `);
}
