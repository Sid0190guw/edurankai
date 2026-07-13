/*
 * aquin-languages.js — AquinTutor's shared Indian-language registry.
 *
 * ONE dependency-free file, loaded as <script src>, exposing window.AquinLangs
 * so every surface (live classroom, mobile, concept pages) shares the same
 * correct language metadata and font handling.
 *
 * Scope, honestly:
 *   - `list` covers English + the 22 languages of the Eighth Schedule of the
 *     Constitution of India, each with its correct endonym (native name),
 *     script, and text direction. These names are the real, verifiable thing.
 *   - Actual *translation of lesson content* is separate: a surface supplies
 *     human-authored translations for the languages it has, and for every other
 *     language shows an honest "neural translation pending" state rather than
 *     inventing text. Broad coverage comes from integrating an open-source
 *     Indic translation model at the service layer — that is the real path,
 *     wired in later, not faked in the UI. A wrong physics translation would
 *     mislead a learner, so we never present unverified text as authoritative.
 */
(function () {
  var list = [
    { code: 'en',  en: 'English',        native: 'English',      script: 'latin',      dir: 'ltr' },
    { code: 'hi',  en: 'Hindi',          native: 'हिन्दी',        script: 'devanagari', dir: 'ltr' },
    { code: 'bn',  en: 'Bengali',        native: 'বাংলা',         script: 'bengali',    dir: 'ltr' },
    { code: 'te',  en: 'Telugu',         native: 'తెలుగు',        script: 'telugu',     dir: 'ltr' },
    { code: 'mr',  en: 'Marathi',        native: 'मराठी',         script: 'devanagari', dir: 'ltr' },
    { code: 'ta',  en: 'Tamil',          native: 'தமிழ்',         script: 'tamil',      dir: 'ltr' },
    { code: 'gu',  en: 'Gujarati',       native: 'ગુજરાતી',       script: 'gujarati',   dir: 'ltr' },
    { code: 'kn',  en: 'Kannada',        native: 'ಕನ್ನಡ',         script: 'kannada',    dir: 'ltr' },
    { code: 'ml',  en: 'Malayalam',      native: 'മലയാളം',        script: 'malayalam',  dir: 'ltr' },
    { code: 'pa',  en: 'Punjabi',        native: 'ਪੰਜਾਬੀ',        script: 'gurmukhi',   dir: 'ltr' },
    { code: 'or',  en: 'Odia',           native: 'ଓଡ଼ିଆ',          script: 'odia',       dir: 'ltr' },
    { code: 'as',  en: 'Assamese',       native: 'অসমীয়া',        script: 'bengali',    dir: 'ltr' },
    { code: 'ur',  en: 'Urdu',           native: 'اردو',          script: 'arabic',     dir: 'rtl' },
    { code: 'sa',  en: 'Sanskrit',       native: 'संस्कृतम्',      script: 'devanagari', dir: 'ltr' },
    { code: 'ne',  en: 'Nepali',         native: 'नेपाली',        script: 'devanagari', dir: 'ltr' },
    { code: 'kok', en: 'Konkani',        native: 'कोंकणी',        script: 'devanagari', dir: 'ltr' },
    { code: 'mai', en: 'Maithili',       native: 'मैथिली',        script: 'devanagari', dir: 'ltr' },
    { code: 'doi', en: 'Dogri',          native: 'डोगरी',         script: 'devanagari', dir: 'ltr' },
    { code: 'brx', en: 'Bodo',           native: 'बड़ो',          script: 'devanagari', dir: 'ltr' },
    { code: 'ks',  en: 'Kashmiri',       native: 'कॉशुर',         script: 'devanagari', dir: 'ltr' },
    { code: 'sd',  en: 'Sindhi',         native: 'سنڌي',          script: 'arabic',     dir: 'rtl' },
    { code: 'mni', en: 'Manipuri',       native: 'মেইতেই',        script: 'bengali',    dir: 'ltr' },
    { code: 'sat', en: 'Santali',        native: 'ᱥᱟᱱᱛᱟᱲᱤ',       script: 'olchiki',    dir: 'ltr' }
  ];

  // System-font stacks per script — no downloaded fonts, so it stays light on a
  // low-end phone and renders offline. Falls back to the platform's own font.
  var FONTS = {
    latin:      "'Inter Tight',system-ui,sans-serif",
    devanagari: "'Noto Sans Devanagari','Nirmala UI',system-ui,sans-serif",
    bengali:    "'Noto Sans Bengali','Nirmala UI',system-ui,sans-serif",
    telugu:     "'Noto Sans Telugu','Gautami','Nirmala UI',system-ui,sans-serif",
    tamil:      "'Noto Sans Tamil','Latha','Nirmala UI',system-ui,sans-serif",
    gujarati:   "'Noto Sans Gujarati','Shruti','Nirmala UI',system-ui,sans-serif",
    kannada:    "'Noto Sans Kannada','Tunga','Nirmala UI',system-ui,sans-serif",
    malayalam:  "'Noto Sans Malayalam','Kartika','Nirmala UI',system-ui,sans-serif",
    gurmukhi:   "'Noto Sans Gurmukhi','Raavi','Nirmala UI',system-ui,sans-serif",
    odia:       "'Noto Sans Oriya','Kalinga','Nirmala UI',system-ui,sans-serif",
    arabic:     "'Noto Nastaliq Urdu','Noto Naskh Arabic',system-ui,sans-serif",
    olchiki:    "'Noto Sans Ol Chiki',system-ui,sans-serif"
  };

  var byCode = {};
  list.forEach(function (l) { byCode[l.code] = l; });

  window.AquinLangs = {
    list: list,
    get: function (code) { return byCode[code] || byCode.en; },
    fontFor: function (code) { var l = byCode[code]; return (l && FONTS[l.script]) || FONTS.latin; },
    dirFor: function (code) { var l = byCode[code]; return (l && l.dir) || 'ltr'; },
    // Convenience: labels like "हिन्दी · Hindi" for a picker.
    label: function (code) { var l = byCode[code]; if (!l) return code; return l.code === 'en' ? 'English' : (l.native + ' · ' + l.en); }
  };
})();
