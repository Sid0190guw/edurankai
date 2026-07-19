// src/lib/i18n.test.ts — run: npx tsx src/lib/i18n.test.ts
// UI i18n (Prompt AP3a): t() resolves a locale string, falls back to the base locale, and MARKS
// untranslated keys (never blank); RTL locales flip direction; coverage is honest; formatting is
// locale-aware.
import { t, dir, isRTL, coverage, formatDate, formatNumber, BASE_LOCALE, supported, mergeStrings, coverageMerged } from './i18n';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

console.log('\n== translate + fallback + missing marker ==');
ok('a translated key returns the locale string', t('nav.hub', 'hi') === 'कैंपस हब');
ok('a missing key falls back to the base locale (not blank)', t('nav.recordings', 'ar') === t('nav.recordings', 'en') && t('nav.recordings', 'en').length > 0);
ok('an unknown key is MARKED, never blank', t('does.not.exist', 'hi') === '⟨does.not.exist⟩');
ok('base locale returns its own strings', t('lang.save', BASE_LOCALE) === 'Save');

console.log('\n== RTL ==');
ok('Arabic + Urdu are RTL', isRTL('ar') && isRTL('ur') && dir('ar') === 'rtl');
ok('English + Hindi are LTR', !isRTL('en') && !isRTL('hi') && dir('hi') === 'ltr');

console.log('\n== coverage is honest ==');
const covAr = coverage('ar');
ok('Arabic coverage < 100% and lists the missing keys', covAr.pct < 100 && covAr.missing.includes('nav.recordings'), covAr.pct);
ok('base locale is 100%', coverage('en').pct === 100);
ok('a fully-absent locale is 0% (all missing, none invented)', coverage('zz').pct === 0 && coverage('zz').translated === 0);

console.log('\n== AP3b: admin string overrides raise coverage (no code change) ==');
ok('an override fills a missing key', mergeStrings({}, { 'nav.recordings': 'रिकॉर्डिंग्स' })['nav.recordings'] === 'रिकॉर्डिंग्स');
const before = coverage('ar').pct;
const after = coverageMerged('ar', coverage('ar').missing.reduce((o: any, k) => (o[k] = 'x', o), {} as any));
ok('overriding all missing keys reaches 100%', after.pct === 100 && after.pct > before, [before, after.pct]);

console.log('\n== locale-aware formatting (Intl) ==');
ok('numbers format per locale', typeof formatNumber(12345.6, 'en') === 'string' && formatNumber(12345.6, 'en').includes(','));
ok('dates format without throwing', formatDate('2026-07-19', 'hi').length > 0);
ok('supported() gates the locale list', supported('hi') && supported('ar') && !supported('zz'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
