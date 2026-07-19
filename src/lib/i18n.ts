// src/lib/i18n.ts — interface-string localization (Prompt AP3a). A tiny, dependency-free i18n on top
// of built-in Intl: t(key, locale) resolves the locale's string, falls back to the base locale, and
// MARKS anything still missing (never a blank) so coverage is honest. dir()/isRTL() drive right-to-
// left layout. Real translations are provided for what we actually have; everything else is clearly
// untranslated, not invented. Per-user locale persists in edu_student_settings (reused).
export const BASE_LOCALE = 'en';
export interface LocaleInfo { code: string; name: string; native: string; dir: 'ltr' | 'rtl' }
export const LOCALES: LocaleInfo[] = [
  { code: 'en', name: 'English', native: 'English', dir: 'ltr' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी', dir: 'ltr' },
  { code: 'bn', name: 'Bengali', native: 'বাংলা', dir: 'ltr' },
  { code: 'ta', name: 'Tamil', native: 'தமிழ்', dir: 'ltr' },
  { code: 'ur', name: 'Urdu', native: 'اردو', dir: 'rtl' },
  { code: 'ar', name: 'Arabic', native: 'العربية', dir: 'rtl' },
];
const RTL = new Set(['ar', 'ur', 'he', 'fa']);

// UI strings. 'en' is the complete base; other locales fill what we genuinely have (real translations),
// and t() falls back + marks the rest. This is the extract-target other surfaces add keys to.
export const STRINGS: Record<string, Record<string, string>> = {
  en: {
    'access.title': 'Your account', 'access.subtitle': 'This is exactly what your account can do on the platform.',
    'nav.hub': 'Campus hub', 'nav.recordings': 'Recordings', 'nav.settings': 'Settings', 'nav.search': 'Search & discover',
    'lang.title': 'Language', 'lang.pick': 'Choose your language', 'lang.save': 'Save', 'lang.saved': 'Language saved',
    'lang.rtlNote': 'This language reads right to left.', 'lang.coverage': 'translated',
  },
  hi: {
    'access.title': 'आपका खाता', 'access.subtitle': 'यह वही है जो आपका खाता मंच पर कर सकता है।',
    'nav.hub': 'कैंपस हब', 'nav.recordings': 'रिकॉर्डिंग', 'nav.settings': 'सेटिंग्स', 'nav.search': 'खोजें और जानें',
    'lang.title': 'भाषा', 'lang.pick': 'अपनी भाषा चुनें', 'lang.save': 'सहेजें', 'lang.saved': 'भाषा सहेजी गई',
    'lang.coverage': 'अनुवादित',
  },
  ar: {
    'access.title': 'حسابك', 'access.subtitle': 'هذا بالضبط ما يمكن لحسابك فعله على المنصة.',
    'nav.hub': 'مركز الحرم', 'nav.settings': 'الإعدادات', 'lang.title': 'اللغة', 'lang.pick': 'اختر لغتك', 'lang.save': 'حفظ',
    'lang.rtlNote': 'تُقرأ هذه اللغة من اليمين إلى اليسار.',
  },
};

export function isRTL(locale: string): boolean { return RTL.has((locale || '').slice(0, 2)); }
export function dir(locale: string): 'ltr' | 'rtl' { return isRTL(locale) ? 'rtl' : 'ltr'; }
export function localeInfo(locale: string): LocaleInfo { return LOCALES.find((l) => l.code === locale) || LOCALES[0]; }
export function supported(locale: string): boolean { return LOCALES.some((l) => l.code === locale); }

/** Translate a key; fall back to the base locale; mark anything still missing (never blank). */
export function t(key: string, locale: string = BASE_LOCALE): string {
  const loc = STRINGS[locale];
  if (loc && typeof loc[key] === 'string') return loc[key];
  const base = STRINGS[BASE_LOCALE];
  if (base && typeof base[key] === 'string') return base[key];   // fall back to English
  return '⟨' + key + '⟩';                                          // untranslated marker — visible, never blank
}
/** A translator bound to a locale (convenience for a page/layout). */
export function translator(locale: string) { return (key: string) => t(key, locale); }

/** Translation coverage of a locale vs the base (for the admin string-management view). */
export function coverage(locale: string): { total: number; translated: number; pct: number; missing: string[] } {
  const baseKeys = Object.keys(STRINGS[BASE_LOCALE] || {});
  const loc = STRINGS[locale] || {};
  const missing = baseKeys.filter((k) => typeof loc[k] !== 'string');
  const translated = baseKeys.length - missing.length;
  return { total: baseKeys.length, translated, pct: baseKeys.length ? Math.round((translated / baseKeys.length) * 100) : 0, missing };
}

// ---- locale-aware formatting (built-in Intl) ----
export function formatDate(d: Date | string | number, locale: string): string { try { return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(d)); } catch { return String(d); } }
export function formatNumber(n: number, locale: string): string { try { return new Intl.NumberFormat(locale).format(n); } catch { return String(n); } }
