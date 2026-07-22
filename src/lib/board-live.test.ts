// src/lib/board-live.test.ts — run: npx tsx src/lib/board-live.test.ts
// Self-contained (no DB): the recognition contract + the pure translation/assessment helpers.
import { RecognitionEventZ } from './recognition-event';
import { translatableText, applyTranslations, type TranslatableEvent } from './board-translate';
import { windowConcepts, validateDrafts, templateItemsFor } from './board-assess';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

function main() {
  console.log('\n== recognition event union ==');
  const sp = RecognitionEventZ.safeParse({ kind: 'speech', transcript: 'draw a projectile', at: 1 });
  ok('speech parses; interim/lang default', sp.success && sp.data.kind === 'speech' && (sp.data as any).interim === false && (sp.data as any).lang === 'en');
  ok('ink parses (vector strokes only)', RecognitionEventZ.safeParse({ kind: 'ink', strokes: [[[0, 0], [0.5, 0.5]]], source: 'pen', at: 1 }).success);
  ok('gesture parses', RecognitionEventZ.safeParse({ kind: 'gesture', gesture: 'circle', centroid: [0.5, 0.5], confidence: 0.6, at: 1 }).success);
  ok('equation parses', RecognitionEventZ.safeParse({ kind: 'equation', latex: 'x^2', at: 1 }).success);
  ok('unknown kind rejected', !RecognitionEventZ.safeParse({ kind: 'video', at: 1 }).success);
  ok('gesture confidence > 1 rejected', !RecognitionEventZ.safeParse({ kind: 'gesture', gesture: 'circle', centroid: [0, 0], confidence: 1.5, at: 1 }).success);
  ok('ink has no pixel/image field in the schema (vectors only)', (() => { const r = RecognitionEventZ.safeParse({ kind: 'ink', strokes: [[[0, 0]]], source: 'physical', at: 1 }); return r.success && !('image' in (r.data as any)) && !('dataUrl' in (r.data as any)); })());

  console.log('\n== translatableText (pure) ==');
  const slide: TranslatableEvent = { templateId: 'slide', params: { slide: { title: 'Bernoulli', bullets: ['pressure drops', 'speed rises'] } } };
  ok('slide -> title + bullets', translatableText(slide).join('|') === 'Bernoulli|pressure drops|speed rises');
  const scene: TranslatableEvent = { templateId: 'scene', params: { scene: { title: 'Flow', subtitle: 'venturi', objects: [{ text: 'inlet' }, { text: 'outlet' }, {}] } } };
  ok('scene -> title, subtitle, object texts', translatableText(scene).join('|') === 'Flow|venturi|inlet|outlet');
  ok('equation -> caption only (never LaTeX)', translatableText({ templateId: 'equation', params: { latex: 'x^2', caption: 'a square' } }).join('|') === 'a square');
  ok('projectile -> nothing translatable', translatableText({ templateId: 'projectile', params: { v0: 10 } }).length === 0);

  console.log('\n== applyTranslations (pure) ==');
  const tr = applyTranslations(slide, { Bernoulli: 'बर्नौली', 'pressure drops': 'दाब घटता है' });
  ok('replaces mapped strings, leaves unmapped', tr.params.slide.title === 'बर्नौली' && tr.params.slide.bullets[0] === 'दाब घटता है' && tr.params.slide.bullets[1] === 'speed rises');
  ok('original event is not mutated', slide.params.slide.title === 'Bernoulli');
  const eqTr = applyTranslations({ templateId: 'equation', params: { latex: 'x^2', caption: 'a square' } }, { 'a square': 'एक वर्ग' });
  ok('equation caption translated, LaTeX untouched', eqTr.params.caption === 'एक वर्ग' && eqTr.params.latex === 'x^2');

  console.log('\n== windowConcepts (pure) ==');
  const wc = windowConcepts([
    { transcript: 'lets look at projectile motion', templateId: 'projectile' },
    { transcript: 'now a sine wave', templateId: 'sine' },
    { transcript: 'projectile again', templateId: 'projectile' },
    { transcript: '', templateId: null, params: { concept: 'bernoulli' } },
  ]);
  ok('distinct concepts (params.concept > templateId), order preserved', wc.concepts.join(',') === 'projectile,sine,bernoulli', wc.concepts);
  ok('transcript window joined (blanks dropped)', wc.transcript === 'lets look at projectile motion now a sine wave projectile again');

  console.log('\n== validateDrafts (pure) ==');
  const drafts = validateDrafts([
    { type: 'numeric', prompt: 'outlet speed?', answer: { value: 4 }, points: 2 },
    { type: 'mcq', prompt: 'which?', options: ['a', 'b'], answer: { correctIndex: 0 }, points: 99 },
    { type: 'mcq', prompt: 'no options', answer: {}, points: 1 },     // dropped: mcq needs >=2 options
    { type: 'weird', prompt: 'coerced to mcq but no opts', answer: {}, points: 1 }, // dropped
    { prompt: '' },                                                    // dropped: empty prompt
  ]);
  ok('keeps valid numeric + mcq, drops bad', drafts.length === 2 && drafts[0].type === 'numeric' && drafts[1].type === 'mcq');
  ok('clamps points into [1,10]', drafts[1].points === 10);
  ok('caps output at 20', validateDrafts(Array.from({ length: 40 }, () => ({ type: 'true_false', prompt: 'q', answer: { value: true }, points: 1 }))).length === 20);

  console.log('\n== templateItemsFor fallback (pure) ==');
  const fb = templateItemsFor(['projectile', 'sine']);
  ok('one true/false per concept', fb.length === 2 && fb[0].type === 'true_false' && /projectile/.test(fb[0].prompt));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main();
