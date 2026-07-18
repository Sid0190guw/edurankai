// src/lib/render-policy.test.ts — run: npx tsx src/lib/render-policy.test.ts
// Adaptive Rendering policy: lite = zero client JS + compressed/small assets; rich = the
// designated interactive enhancement hydrates + full assets; per-object override changes the
// directive; media URLs get tier variants.
import { resolveDirective, assetVariantUrl, rewriteMedia } from './render-policy';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

const lite = resolveDirective('KnowledgeObject', 'lite');
const rich = resolveDirective('KnowledgeObject', 'rich');

console.log('\n== lite tier: zero client JS + compressed/small assets ==');
ok('lite hydrates NOTHING (zero client JS)', lite.hydrate.length === 0, lite.hydrate);
ok('lite uses small width + compressed format + lazy', lite.image.maxWidth === 320 && lite.image.format === 'webp' && lite.image.lazy === true, lite.image);
ok('lite disables animation + physics + audio', lite.animation === 'none' && lite.physics === false && lite.audio === 'none');
ok('lite asset URL is small + compressed', assetVariantUrl('/media/fig.png', lite).includes('w=320') && assetVariantUrl('/media/fig.png', lite).includes('fmt=webp'), assetVariantUrl('/media/fig.png', lite));

console.log('\n== rich tier: designated interactive component hydrates + full assets ==');
ok('rich hydrates the equation-explorer', rich.hydrate.includes('equation-explorer'), rich.hydrate);
ok('rich uses large width + avif + eager', rich.image.maxWidth === 1280 && rich.image.format === 'avif' && rich.image.lazy === false, rich.image);
ok('rich enables full animation', rich.animation === 'full');

console.log('\n== per-object override changes the directive ==');
const overridden = resolveDirective('KnowledgeObject', 'rich', { hydrate: [], animation: 'none' });
ok('override forces no hydration even at rich', overridden.hydrate.length === 0 && overridden.animation === 'none', overridden);
ok('override merges image partial', resolveDirective('KnowledgeObject', 'lite', { image: { maxWidth: 160 } as any }).image.maxWidth === 160);

console.log('\n== media rewrite honours the directive ==');
const html = '<p>see <img alt="fig" src="/media/fig.png"> here</p>';
const rl = rewriteMedia(html, lite);
ok('lite media is lazy + width-capped + variant URL', rl.includes('loading="lazy"') && rl.includes('width="320"') && rl.includes('w=320'), rl);
const rr = rewriteMedia(html, rich);
ok('rich media is eager (no lazy) + large width', !rr.includes('loading="lazy"') && rr.includes('width="1280"'), rr);

console.log('\n== other object types tier up their interactivity ==');
ok('SimulationObject lite = no interactivity', resolveDirective('SimulationObject', 'lite').hydrate.length === 0);
ok('SimulationObject rich = interactive sim + physics', resolveDirective('SimulationObject', 'rich').hydrate.includes('sim-interactive') && resolveDirective('SimulationObject', 'rich').physics === true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
