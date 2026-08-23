// src/lib/fusion/render.ts — THE WORDS AND THE GLYPHS. NO EMOJI, ANYWHERE, EVER.
//
// This project renders monochrome inline SVG and nothing else. An emoji is a font-dependent picture
// that means different things on different platforms, and half of them mean something about a person
// — which is the last thing that belongs beside a reading about one.
//
// PURE. No database, no imports beyond the contract, so every sentence here can be checked without a
// connection. That is the same reason src/lib/evidence-graph.ts keeps its mappers pure.
import {
  AGREEMENT_LABELS,
  CONFIDENCE_BAND_LABELS,
  CONFIDENCE_DIRECTION_LABELS,
  READING_STATUS_LABELS,
  SOURCE_CLASS_LABELS,
  sourceClassSpec,
  type Agreement,
  type ConfidenceBand,
  type ConfidenceDirection,
  type DimensionReading,
  type ReadingStatus,
  type SourceClass,
  type SourceView,
} from './types';

// -------------------------------------------------------------------------------------------------
// GLYPHS — 16px, currentColor, aria-hidden. The label beside them carries the meaning.
// -------------------------------------------------------------------------------------------------

const svg = (body: string): string =>
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + body + '</svg>';

/** A tick — this source says the same thing. */
export const GLYPH_CONFIRMS = svg('<path d="M20 6 9 17l-5-5"/>');
/** A half tick — a weaker version of the same thing. */
export const GLYPH_PARTIAL = svg('<path d="M20 6 9 17l-5-5"/><path d="M3 21h18" opacity=".4"/>');
/** Divergent arrows — these two records do not agree. */
export const GLYPH_CONTRADICTS = svg('<path d="M7 7 3 12l4 5"/><path d="M17 7l4 5-4 5"/><path d="M3 12h18"/>');
/** A dash — nothing was said. */
export const GLYPH_SILENT = svg('<path d="M5 12h14"/>');
/** A crossed circle — offered, and not admitted here. */
export const GLYPH_NOT_ADMITTED = svg('<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>');
/** An upward trend. */
export const GLYPH_UP = svg('<path d="M3 17 9 11l4 4 8-8"/><path d="M21 3h-6"/><path d="M21 3v6"/>');
/** A downward trend. */
export const GLYPH_DOWN = svg('<path d="M3 7 9 13l4-4 8 8"/><path d="M21 21h-6"/><path d="M21 21v-6"/>');
/** A flat line. */
export const GLYPH_STEADY = svg('<path d="M3 12h18"/>');
/** A single point — one reading is not a trajectory. */
export const GLYPH_FIRST = svg('<circle cx="12" cy="12" r="2.5"/><path d="M3 12h5"/><path d="M16 12h5" opacity=".4"/>');
/** An open book — this is advisory, read it. */
export const GLYPH_ADVISORY = svg('<circle cx="12" cy="12" r="9"/><path d="M12 8h.01"/><path d="M11 12h1v4h1"/>');
/** A person — a named human is answerable for this. */
export const GLYPH_ATTRIBUTED = svg('<circle cx="12" cy="8" r="3.25"/><path d="M5 20a7 7 0 0 1 14 0"/>');
/** A link — the evidence is a link, never an upload. */
export const GLYPH_LINK = svg('<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>');

export function agreementGlyph(a: Agreement): string {
  switch (a) {
    case 'strongly_confirms': return GLYPH_CONFIRMS;
    case 'partially_confirms': return GLYPH_PARTIAL;
    case 'contradicts': return GLYPH_CONTRADICTS;
    case 'does_not_confirm': return GLYPH_CONTRADICTS;
    case 'silent': return GLYPH_SILENT;
    default: return GLYPH_SILENT;
  }
}

export function directionGlyph(d: ConfidenceDirection): string {
  switch (d) {
    case 'increasing': return GLYPH_UP;
    case 'decreasing': return GLYPH_DOWN;
    case 'steady': return GLYPH_STEADY;
    default: return GLYPH_FIRST;
  }
}

// -------------------------------------------------------------------------------------------------
// TONE CLASSES — so a screen never has to decide what a status means
// -------------------------------------------------------------------------------------------------

export type Tone = 'record' | 'stated' | 'derived' | 'advisory' | 'absent';

export function statusTone(s: ReadingStatus): Tone {
  switch (s) {
    case 'evidenced': return 'record';
    case 'thin_evidence': return 'derived';
    case 'foundation_only': return 'advisory';
    case 'nothing_on_record': return 'absent';
    default: return 'absent';
  }
}

export function bandTone(b: ConfidenceBand): Tone {
  switch (b) {
    case 'high': return 'record';
    case 'moderate': return 'derived';
    case 'low': return 'stated';
    default: return 'absent';
  }
}

// -------------------------------------------------------------------------------------------------
// SENTENCES
// -------------------------------------------------------------------------------------------------

/**
 * The one line beside a source row.
 *
 * It never says "0" where it means "nothing was offered". A class that is silent says it is silent,
 * a class that was refused says it was refused and why, and the two are visibly different rows.
 */
export function sourceSentence(v: SourceView, showWeights: boolean): string {
  if (!v.signalCount) {
    return SOURCE_CLASS_LABELS[v.sourceClass] + ' offered nothing. That is an absence in the record, '
      + 'not a finding about the person.';
  }
  if (v.withheldBecause) {
    return SOURCE_CLASS_LABELS[v.sourceClass] + ' — ' + v.signalCount + ' signal'
      + (v.signalCount === 1 ? '' : 's') + ', counted as nothing. ' + v.withheldBecause;
  }
  const weightPart = showWeights ? ' at weight ' + v.weight + ' of 100' : '';
  return SOURCE_CLASS_LABELS[v.sourceClass] + ' — ' + v.signalCount + ' signal'
    + (v.signalCount === 1 ? '' : 's') + weightPart + ', and it '
    + AGREEMENT_LABELS[v.agreement] + '.';
}

/** The headline a card prints above the number, or instead of it. */
export function headline(r: DimensionReading): string {
  if (r.reading === null) return READING_STATUS_LABELS[r.status];
  return String(r.reading) + ' / 100';
}

/** The confidence line. Band and value together, never the value alone. */
export function confidenceLine(r: DimensionReading): string {
  const c = r.explanation.confidence;
  return CONFIDENCE_BAND_LABELS[c.band] + ' (' + c.value + '/100), '
    + CONFIDENCE_DIRECTION_LABELS[c.direction] + ' — ' + c.independentSources
    + ' independent kind' + (c.independentSources === 1 ? '' : 's') + ' of demonstrated evidence.';
}

/** What a screen prints where an expected provider has not registered. */
export function notConnectedSentence(m: { ownerPatch: string; what: string }): string {
  return m.ownerPatch + ' has not connected a provider yet. ' + m.what
    + ' Every reading below is missing whatever it would have contributed — that is this line, not a lower number.';
}

/** The permanent notice that travels with anything inferred. Never optional, never abbreviated. */
export function foundationNotice(): string {
  return sourceClassSpec('inferred_foundation').meaning
    + ' It is capped by weight, it is not admitted at all on the dimensions that ask what somebody '
    + 'actually did, demonstrated evidence displaces it where the two disagree, and it can never '
    + 'produce a reading on its own.';
}

/** A short, neutral label for a source class. Proprietary terminology only. */
export function sourceLabel(c: SourceClass): string {
  return SOURCE_CLASS_LABELS[c];
}

// -------------------------------------------------------------------------------------------------
// THE STYLE BLOCK — one copy, so eleven screens do not drift into eleven designs
// -------------------------------------------------------------------------------------------------

export const FUSION_CSS = [
  '.fu{max-width:1080px}',
  '.fu h1{font-size:22px;font-weight:700;letter-spacing:-.01em;margin:0 0 4px}',
  '.fu .lede{font-size:13.5px;line-height:1.6;color:#6b6255;margin:0 0 18px;max-width:72ch}',
  '.fu .flash{background:rgba(5,150,105,.09);border:1px solid rgba(5,150,105,.3);color:#065f46;',
  'border-radius:10px;padding:11px 13px;font-size:13px;line-height:1.5;margin-bottom:16px;overflow-wrap:anywhere}',
  '.fu .flash.warn{background:rgba(220,38,38,.07);border-color:rgba(220,38,38,.34);color:#8a1c1c}',
  '.fu .deny{background:#fbf7f1;border:1px solid #eadecd;color:#6d470d;border-radius:12px;',
  'padding:16px;font-size:13.5px;line-height:1.6;max-width:72ch}',
  '.fu .card{background:#fff;border:1px solid #ece4d6;border-radius:14px;padding:16px;margin-bottom:14px}',
  '.fu .card h2{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;',
  'letter-spacing:.13em;text-transform:uppercase;color:#9a8f7d;font-weight:700;margin:0 0 12px}',
  '.fu .muted{font-size:12.5px;line-height:1.55;color:#6b6255;overflow-wrap:anywhere}',
  '.fu .grid{display:grid;grid-template-columns:1fr;gap:12px}',
  '.fu .dim{border:1px solid #ece4d6;border-radius:12px;padding:14px;background:#fff}',
  '.fu .dim h3{font-size:14.5px;font-weight:650;margin:0 0 2px;color:#1a1510}',
  '.fu .dim .q{font-size:12.5px;line-height:1.5;color:#6b6255;margin:0 0 10px}',
  '.fu .num{font-size:26px;font-weight:700;letter-spacing:-.02em;line-height:1.1;color:#1a1510}',
  '.fu .num.absent{font-size:15px;font-weight:600;color:#8a7f6d}',
  '.fu .meter{display:block;height:7px;border-radius:99px;background:#f0e9db;overflow:hidden;margin:8px 0}',
  '.fu .meter i{display:block;height:100%;background:#c2410c;border-radius:99px}',
  '.fu .meter.inv i{background:#7c5c1e}',
  '.fu .say{font-size:13px;line-height:1.55;color:#3a332a;margin:8px 0 0}',
  '.fu .src{display:flex;gap:8px;align-items:flex-start;padding:8px 0;border-bottom:1px solid #f4efe6;font-size:12.5px;line-height:1.5}',
  '.fu .src:last-child{border-bottom:none}',
  '.fu .src svg{flex:0 0 auto;margin-top:2px;color:#9a8f7d}',
  '.fu .src.off{opacity:.62}',
  '.fu .tag{display:inline-flex;align-items:center;gap:.35rem;font-size:11px;padding:.15rem .45rem;',
  'border-radius:.3rem;border:1px solid currentColor;line-height:1.3}',
  '.fu .tag.record{color:#0f5132;font-weight:600}',
  '.fu .tag.derived{color:#6b4e00}',
  '.fu .tag.stated{color:#5b5347}',
  '.fu .tag.advisory{color:#7a6a55;border-style:dashed;font-style:italic}',
  '.fu .tag.absent{color:#8a7f6d;border-style:dotted}',
  '.fu details{margin-top:10px}',
  '.fu summary{cursor:pointer;font-size:12.5px;color:#6b6255;min-height:44px;display:flex;align-items:center}',
  '.fu .chain{font-size:12px;line-height:1.55;color:#5b5347;margin:6px 0 0;padding-left:14px}',
  '.fu .chain li{margin:4px 0}',
  '.fu label{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9.5px;letter-spacing:.1em;',
  'text-transform:uppercase;color:#9a8f7d;font-weight:700;display:block;margin:10px 0 4px}',
  '.fu input,.fu select,.fu textarea{width:100%;background:#faf7f1;border:1px solid #e6ddcd;border-radius:9px;',
  'padding:10px 12px;font-size:14px;font-family:inherit;color:#1a1510;outline:none;min-height:44px}',
  '.fu textarea{min-height:80px;resize:vertical}',
  '.fu input:focus,.fu select:focus,.fu textarea:focus{border-color:#c2410c}',
  '.fu .btn{background:#c2410c;color:#fff;border:none;border-radius:10px;padding:11px 18px;font-size:14px;',
  'font-weight:650;cursor:pointer;font-family:inherit;min-height:44px;margin-top:12px}',
  '.fu .btn.ghost{background:#fff;color:#6b6255;border:1px solid #e6ddcd}',
  '.fu .row2{display:grid;grid-template-columns:1fr;gap:9px}',
  '.fu .tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch;margin-top:10px}',
  '.fu table{border-collapse:collapse;width:100%;min-width:520px;font-size:13px}',
  '.fu th{text-align:left;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9.5px;',
  'letter-spacing:.1em;text-transform:uppercase;color:#9a8f7d;font-weight:700;padding:8px 10px;',
  'border-bottom:1px solid #ece4d6;white-space:nowrap}',
  '.fu td{padding:10px;border-bottom:1px solid #f4efe6;vertical-align:top}',
  '.fu .spark{display:flex;align-items:flex-end;gap:3px;height:34px;margin-top:8px}',
  '.fu .spark b{display:block;width:7px;background:#e2d7c3;border-radius:2px 2px 0 0}',
  '.fu .spark b.on{background:#c2410c}',
  '@media (min-width:820px){ .fu .grid{grid-template-columns:1fr 1fr} .fu .row2{grid-template-columns:1fr 1fr} }',
].join('');
