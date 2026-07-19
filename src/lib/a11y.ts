// src/lib/a11y.ts — accessibility helpers (Prompt AP4). Pure: WCAG contrast checks (so we can verify
// core UI meets AA), the reduced-motion decision the animation engine honors (static render instead of
// motion), and text-scale clamping. Backed by the existing edu_student_settings.accessibility model
// (reduceMotion / highContrast / screenReader) — this adds the logic + audit, not a new store.

// ---- WCAG contrast ----
function toRgb(hex: string): [number, number, number] {
  let h = (hex || '').replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6) || '000000', 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function relLum([r, g, b]: [number, number, number]): number {
  const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
/** WCAG contrast ratio between two hex colors (1..21). */
export function contrastRatio(fg: string, bg: string): number {
  const l1 = relLum(toRgb(fg)), l2 = relLum(toRgb(bg));
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}
/** Does the pair meet WCAG AA? 4.5:1 normal text, 3:1 large text / UI components. */
export function meetsAA(fg: string, bg: string, opts: { large?: boolean } = {}): boolean {
  return contrastRatio(fg, bg) >= (opts.large ? 3 : 4.5);
}

// ---- reduced motion ----
export interface A11yPrefs { reduceMotion?: boolean; highContrast?: boolean; screenReader?: boolean; textScale?: number }
/** Should animation be suppressed? (explicit setting OR the OS/browser signal). */
export function reduceMotion(prefs: A11yPrefs, osReduce = false): boolean { return !!prefs?.reduceMotion || !!osReduce; }
/** The render tier the engine should use once reduced-motion is honored: lite = static keyframe. */
export function effectiveTier(tier: string, prefs: A11yPrefs, osReduce = false): string { return reduceMotion(prefs, osReduce) ? 'lite' : tier; }

// ---- text scale (clamped to a sane, layout-safe range) ----
export function clampTextScale(scale: any): number { const n = Number(scale); return Number.isFinite(n) ? Math.min(1.6, Math.max(0.9, n)) : 1; }

// ---- a body class list applied for the user's a11y prefs (high-contrast / large-text / no-motion) ----
export function bodyA11yClasses(prefs: A11yPrefs): string {
  const c: string[] = [];
  if (prefs?.highContrast) c.push('a11y-contrast');
  if (prefs?.reduceMotion) c.push('a11y-no-motion');
  if (prefs?.screenReader) c.push('a11y-sr');
  const ts = clampTextScale(prefs?.textScale);
  if (ts >= 1.25) c.push('a11y-text-lg'); else if (ts >= 1.1) c.push('a11y-text-md');
  return c.join(' ');
}
