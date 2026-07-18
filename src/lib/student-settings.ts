// src/lib/student-settings.ts — self-serve student settings + profile (Prompt 14). These FEED the
// Prompt-4 runtime estimators (language, accessibility, learning style) — the same edu_student_settings
// store the runtime already reads, extended with a prefs column (theme, notifications). For MINOR
// students, consent-gated settings are editable only by a linked GUARDIAN, not the minor themselves.
// The authorization + merge logic is pure and unit-tested.

export const LANGUAGES = ['en', 'hi', 'mr', 'ta', 'te', 'bn', 'gu', 'kn', 'ml', 'pa', 'ur'];
export const LEARNING_STYLES = ['balanced', 'visual', 'reading', 'practical', 'socratic'];
export const THEMES = ['system', 'light', 'dark'];
export const ACCESSIBILITY_KEYS = ['reduceMotion', 'highContrast', 'screenReader'] as const;
// Settings a minor may NOT change alone — a guardian must (per consent).
export const CONSENT_GATED = ['aiTutor', 'community', 'dataSharing'] as const;

export interface StudentProfile {
  language: string;
  accessibility: { reduceMotion?: boolean; highContrast?: boolean; screenReader?: boolean; fontScale?: number };
  learningStyle: string;
  theme: string;
  notifications: { email?: boolean; deadlines?: boolean; results?: boolean };
  consent: { aiTutor?: boolean; community?: boolean; dataSharing?: boolean };
}
export const DEFAULT_PROFILE: StudentProfile = {
  language: 'en', accessibility: {}, learningStyle: 'balanced', theme: 'system',
  notifications: { email: false, deadlines: true, results: true }, consent: { aiTutor: true, community: false, dataSharing: false },
};

/** Who may edit a given setting. Guardian may edit anything for their linked minor; a minor may edit
 *  their own NON-consent-gated settings only; an adult edits their own freely. Pure. */
export function canEditSetting(settingKey: string, ctx: { isSelf: boolean; isMinor: boolean; isGuardianOfTarget: boolean }): boolean {
  if (ctx.isGuardianOfTarget) return true;
  if (!ctx.isSelf) return false;
  if (ctx.isMinor && (CONSENT_GATED as readonly string[]).includes(settingKey)) return false;   // consent-blocked for the minor
  return true;
}

/** Merge a patch into the current profile, keeping only valid values, honoring per-setting edit rights. */
export function mergeProfile(current: StudentProfile, patch: Partial<StudentProfile>, ctx: { isSelf: boolean; isMinor: boolean; isGuardianOfTarget: boolean }): StudentProfile {
  const next: StudentProfile = { ...current, accessibility: { ...current.accessibility }, notifications: { ...current.notifications }, consent: { ...current.consent } };
  if (patch.language && LANGUAGES.includes(patch.language) && canEditSetting('language', ctx)) next.language = patch.language;
  if (patch.learningStyle && LEARNING_STYLES.includes(patch.learningStyle) && canEditSetting('learningStyle', ctx)) next.learningStyle = patch.learningStyle;
  if (patch.theme && THEMES.includes(patch.theme) && canEditSetting('theme', ctx)) next.theme = patch.theme;
  if (patch.accessibility && canEditSetting('accessibility', ctx)) for (const k of ACCESSIBILITY_KEYS) if (k in patch.accessibility) (next.accessibility as any)[k] = !!(patch.accessibility as any)[k];
  if (patch.notifications && canEditSetting('notifications', ctx)) for (const k of ['email', 'deadlines', 'results']) if (patch.notifications && k in patch.notifications) (next.notifications as any)[k] = !!(patch.notifications as any)[k];
  if (patch.consent) for (const k of CONSENT_GATED) if (patch.consent && k in patch.consent && canEditSetting(k, ctx)) (next.consent as any)[k] = !!(patch.consent as any)[k];
  return next;
}

// ============================ DB (extends the runtime's edu_student_settings) ====================
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
let booted = false;
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); return { db, sql }; }
export async function ensureSettingsSchema(): Promise<void> {
  if (booted) return; const { db, sql } = await ctx();
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_student_settings (user_id UUID PRIMARY KEY, language TEXT NOT NULL DEFAULT 'en', accessibility JSONB NOT NULL DEFAULT '{}'::jsonb, learning_style TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`));
  await db.execute(sql.raw(`ALTER TABLE edu_student_settings ADD COLUMN IF NOT EXISTS prefs JSONB NOT NULL DEFAULT '{}'::jsonb`));
  booted = true;
}
export async function getProfile(userId: string): Promise<StudentProfile> {
  try { await ensureSettingsSchema(); const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT language, accessibility, learning_style, prefs FROM edu_student_settings WHERE user_id = ${userId} LIMIT 1`))[0];
    if (!r) return { ...DEFAULT_PROFILE };
    const prefs = r.prefs || {};
    return { language: r.language || 'en', accessibility: r.accessibility || {}, learningStyle: r.learning_style || 'balanced', theme: prefs.theme || 'system', notifications: prefs.notifications || DEFAULT_PROFILE.notifications, consent: prefs.consent || DEFAULT_PROFILE.consent };
  } catch { return { ...DEFAULT_PROFILE }; }
}
export async function saveProfile(userId: string, p: StudentProfile): Promise<void> {
  await ensureSettingsSchema(); const { db, sql } = await ctx();
  const prefs = { theme: p.theme, notifications: p.notifications, consent: p.consent };
  await db.execute(sql`INSERT INTO edu_student_settings (user_id, language, accessibility, learning_style, prefs)
    VALUES (${userId}, ${p.language}, ${JSON.stringify(p.accessibility)}::jsonb, ${p.learningStyle}, ${JSON.stringify(prefs)}::jsonb)
    ON CONFLICT (user_id) DO UPDATE SET language=${p.language}, accessibility=${JSON.stringify(p.accessibility)}::jsonb, learning_style=${p.learningStyle}, prefs=${JSON.stringify(prefs)}::jsonb, updated_at=NOW()`);
}
export async function isGuardianOf(guardianId: string, minorId: string): Promise<boolean> {
  try { const { db, sql } = await ctx();
    return rows(await db.execute(sql`SELECT 1 FROM rbac_guardian_links WHERE guardian_user_id = ${guardianId} AND minor_user_id = ${minorId} LIMIT 1`)).length > 0;
  } catch { return false; }
}
