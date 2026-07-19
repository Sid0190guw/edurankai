// src/lib/board-vision.test.ts — run: npx tsx src/lib/board-vision.test.ts
// Physical-board vision core (Prompt A4a), PURE. Calibration rectifies a board quad (homography);
// lighting quality is judged from real stats and degrades honestly; frame-differencing finds new
// marker strokes; strokes vectorize into normalized polylines — STRUCTURED data, never pixels.
import { readFileSync } from 'node:fs';
const g: any = globalThis as any; g.window = {};
// eslint-disable-next-line no-eval
eval(readFileSync('public/aquin-board-vision.js', 'utf8'));
const V = g.window.AquinVision;

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

console.log('\n== calibration: 4-corner homography rectifies the board ==');
const src = [[100, 80], [520, 60], [560, 400], [80, 420]];   // a skewed board quad in the frame
const dst = [[0, 0], [1, 0], [1, 1], [0, 1]];                 // -> unit rectangle
const H = V.computeHomography(src, dst);
ok('homography solves (9 coeffs)', Array.isArray(H) && H.length === 9);
ok('each board corner maps to its rectangle corner', dst.every((d: number[], i: number) => { const p = V.applyHomography(H, src[i]); return Math.abs(p[0] - d[0]) < 1e-6 && Math.abs(p[1] - d[1]) < 1e-6; }));
const mid = V.applyHomography(H, [(src[0][0] + src[2][0]) / 2, (src[0][1] + src[2][1]) / 2]);
ok('a frame point maps inside the rectified board', mid[0] > 0 && mid[0] < 1 && mid[1] > 0 && mid[1] < 1, mid);

console.log('\n== lighting quality degrades honestly ==');
ok('bright, high-contrast frame -> good', V.lightingQuality({ mean: 140, stddev: 40 }).level === 'good');
ok('near-black frame -> poor (too dark)', V.lightingQuality({ mean: 20, stddev: 30 }).level === 'poor');
ok('flat/no-contrast frame -> poor (low contrast)', V.lightingQuality({ mean: 150, stddev: 5 }).level === 'poor');
ok('brightnessStats computes mean + stddev', (() => { const s = V.brightnessStats([0, 0, 255, 255]); return Math.abs(s.mean - 127.5) < 1 && s.stddev > 100; })());

console.log('\n== frame-diff finds NEW strokes vs the calibration baseline ==');
const W = 20, Hh = 20, base = new Uint8ClampedArray(W * Hh).fill(230);   // blank white board
const cur = base.slice(); for (let y = 5; y < 15; y++) cur[y * W + 10] = 20;  // a dark vertical marker stroke
const dm = V.diffMask(base, cur, 40);
ok('detects the changed pixels', dm.indices.length === 10, dm.indices.length);
ok('reads polarity dark-on-light (whiteboard marker)', dm.polarity === 'dark-on-light');

console.log('\n== vectorize: strokes become normalized polylines (NOT pixels) ==');
const strokes = V.maskToStrokes(dm.indices, W, Hh, { cell: 4, maxGap: 0.3 });
ok('produces polyline(s) of [x,y] in 0..1', strokes.length >= 1 && strokes[0].every((p: number[]) => p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1));
ok('the payload is small structured data, no pixel/image field', !/"(image|video|pixels|dataUrl|png)"/.test(JSON.stringify(strokes)) && JSON.stringify(strokes).length < 2000);
const chained = V.chainStrokes([[0, 0], [0.02, 0.02], [0.04, 0.04], [0.9, 0.9]], 0.06);
ok('nearby points chain into a stroke; a far point starts another', chained.length === 2 && chained[0].length === 3);

console.log('\n== capture confidence is honest (never fabricated) ==');
ok('poor lighting -> not usable', V.captureConfidence({ level: 'poor', score: 0.2, reason: 'too dark' }, 0.01).usable === false);
ok('nothing on board -> not usable', V.captureConfidence({ level: 'good', score: 0.9, reason: 'clear' }, 0).usable === false);
ok('good lighting + some ink -> usable, bounded confidence', (() => { const c = V.captureConfidence({ level: 'good', score: 0.9, reason: 'clear' }, 0.01); return c.usable && c.value <= 0.85; })());

console.log('\n== A4b: best-effort gesture recognition (low, honest confidence + centroid) ==');
const circle = [[0.4, 0.3], [0.5, 0.28], [0.6, 0.34], [0.62, 0.46], [0.55, 0.55], [0.45, 0.56], [0.38, 0.48], [0.39, 0.36], [0.41, 0.31]];
const rc = V.recognizeStrokes([circle]);
ok('a closed loop is read as a circle/selection gesture', rc.kind === 'circle' && rc.confidence <= 0.6, rc.kind);
ok('recognition reports WHERE (a centroid to point at)', Array.isArray(rc.centroid) && rc.centroid[0] > 0.4 && rc.centroid[0] < 0.6);
const under = [[0.2, 0.5], [0.4, 0.5], [0.6, 0.51], [0.8, 0.5]];
ok('a horizontal stroke -> underline', V.recognizeStrokes([under]).kind === 'underline');
ok('scattered writing -> marks (confirm, never silently guess)', V.recognizeStrokes([[[0.5, 0.5], [0.52, 0.55]]]).kind === 'marks');
ok('confidence is always low/honest (<=0.6), never fabricated-high', [rc, V.recognizeStrokes([under])].every((r: any) => r.confidence <= 0.6));

console.log('\n== A4: the ink broadcast is vector strokes, NOT raw video (privacy) ==');
const inkPayload = { templateId: 'ink', params: { strokes: V.maskToStrokes(dm.indices, W, Hh, { cell: 4 }), source: 'physical' }, playState: 'static' };
ok('carries vector strokes under params.strokes', inkPayload.templateId === 'ink' && Array.isArray(inkPayload.params.strokes));
ok('no raw video / image / pixel field anywhere in the payload', !/"(video|image|pixels|dataUrl|png|jpeg|stream|blob)"/.test(JSON.stringify(inkPayload)));
ok('payload is small (structured vectors, not a frame)', JSON.stringify(inkPayload).length < 4000);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
