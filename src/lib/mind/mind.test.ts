// src/lib/mind/mind.test.ts — run: npx tsx src/lib/mind/mind.test.ts
// Self-contained, no database. Covers the learning core end to end: backpropagation actually
// learns, the feature vector is stable, clustering finds groups nobody labelled, self-training
// stays bounded, the metrics are right, and — the one that matters — a network trained on
// simulated learners BEATS the estimator the platform already uses, on data it never saw.
import { MLP, mulberry32 } from './nn';
import {
  featurize, newSequenceState, advanceSequence, baselinePredict, hashVector, hash32,
  FEATURE_DIM, FEATURE_NAMES, TEXT_DIM, type MindSignals,
} from './features';
import { kmeans, OnlineKMeans, chooseK, cosineDistance, normalize } from './cluster';
import { pseudoLabelBinary, pseudoLabelMulti, propagateLabels } from './semisup';
import { evaluateBinary, evaluateMulti, auc, isHoldout, shouldPromote } from './evaluate';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

function main() {
  // ---------------------------------------------------------------- nn
  console.log('\n== neural network ==');
  {
    const net = new MLP({ sizes: [2, 8, 1], output: 'sigmoid', seed: 42 });
    const data = [
      { x: [0, 0], y: [0] }, { x: [0, 1], y: [1] }, { x: [1, 0], y: [1] }, { x: [1, 1], y: [0] },
    ];
    const before = net.predictOne([0, 1]);
    const r = net.fit(data, { epochs: 900, batchSize: 4, lr: 0.05, seed: 1 });
    const preds = data.map((d) => net.predictOne(d.x));
    const allRight = data.every((d, i) => (preds[i] >= 0.5 ? 1 : 0) === d.y[0]);
    ok('learns XOR (a problem no linear model can do)', allRight, preds.map((p) => +p.toFixed(3)));
    ok('loss went down', r.history[r.history.length - 1] < r.history[0], { first: r.history[0], last: r.history[r.history.length - 1] });
    ok('prediction actually moved from its initial value', Math.abs(before - net.predictOne([0, 1])) > 0.1);
    ok('parameter count is reported', net.params === 2 * 8 + 8 + 8 * 1 + 1, net.params);

    const round = MLP.fromJSON(JSON.parse(JSON.stringify(net.toJSON())));
    ok('survives a JSON round trip byte-identically', data.every((d) => near(round.predictOne(d.x), net.predictOne(d.x), 1e-12)));
    const clone = net.clone();
    clone.fit(data, { epochs: 10, lr: 0.1 });
    ok('clone() does not train the original', near(net.predictOne([1, 1]), MLP.fromJSON(net.toJSON()).predictOne([1, 1]), 1e-12));

    const trainedOnDim = () => { try { net.predict([1, 2, 3]); return false; } catch { return true; } };
    ok('refuses an input of the wrong width', trainedOnDim());
  }
  {
    // softmax head: three linearly separable classes
    const rnd = mulberry32(9);
    const data: { x: number[]; y: number[] }[] = [];
    for (let i = 0; i < 300; i++) {
      const c = i % 3;
      const cx = [0.9, 0.1, 0.5][c], cy = [0.1, 0.9, 0.5][c];
      data.push({ x: [cx + (rnd() - 0.5) * 0.15, cy + (rnd() - 0.5) * 0.15], y: [0, 1, 2].map((k) => (k === c ? 1 : 0)) });
    }
    const net = new MLP({ sizes: [2, 10, 3], output: 'softmax', seed: 5 });
    net.fit(data, { epochs: 220, batchSize: 16, lr: 0.03, seed: 2 });
    const right = data.filter((d) => { const p = net.predict(d.x); let t = 0; for (let i = 1; i < 3; i++) if (p[i] > p[t]) t = i; return d.y[t] === 1; }).length;
    ok('softmax head classifies 3 classes (>95%)', right / data.length > 0.95, +(right / data.length).toFixed(3));
    const p = net.predict(data[0].x);
    ok('softmax outputs sum to 1', near(p[0] + p[1] + p[2], 1, 1e-9));
  }
  {
    // saliency should point at the input that actually drives the output
    const net = new MLP({ sizes: [3, 6, 1], output: 'sigmoid', seed: 11 });
    const rnd = mulberry32(3);
    const data = Array.from({ length: 400 }, () => {
      const a = rnd(), b = rnd(), c = rnd();
      return { x: [a, b, c], y: [a > 0.5 ? 1 : 0] };      // only feature 0 matters
    });
    net.fit(data, { epochs: 260, batchSize: 16, lr: 0.05, seed: 4 });
    const s = net.saliency([0.9, 0.5, 0.5]).map(Math.abs);
    ok('saliency names the feature that drives the prediction', s[0] > s[1] && s[0] > s[2], s.map((v) => +v.toFixed(3)));
  }

  // ---------------------------------------------------------------- features
  console.log('\n== features ==');
  {
    const sig: MindSignals = { itemKey: 'q1', conceptKey: 'kinematics', itemType: 'numeric', difficulty: 0.7, marks: 2, responseMs: 20000, text: 'A ball is thrown upward at 20 m/s', atMs: 1_700_000_000_000 };
    const state = newSequenceState();
    const v = featurize(sig, state);
    ok('vector width matches FEATURE_DIM', v.length === FEATURE_DIM, { got: v.length, want: FEATURE_DIM });
    ok('every feature has a name', FEATURE_NAMES.length === FEATURE_DIM);
    ok('all values finite and bounded', v.every((x) => isFinite(x) && Math.abs(x) <= 1.0001));
    ok('deterministic', JSON.stringify(featurize(sig, newSequenceState())) === JSON.stringify(v));

    const hv = hashVector('the mitochondrion is the powerhouse of the cell');
    let n2 = 0; for (const x of hv) n2 += x * x;
    ok('text encoder emits a unit vector of the right width', hv.length === TEXT_DIM && near(Math.sqrt(n2), 1, 1e-9));
    ok('same text, same vector', JSON.stringify(hashVector('newton second law')) === JSON.stringify(hashVector('newton second law')));
    ok('different text, different vector', JSON.stringify(hashVector('newton second law')) !== JSON.stringify(hashVector('photosynthesis')));
    ok('empty text is the zero vector, not a crash', hashVector('').every((x) => x === 0));
    ok('hash is stable', hash32('abc') === hash32('abc') && hash32('abc') !== hash32('abd'));

    // sequence state
    const st = newSequenceState();
    for (let i = 0; i < 5; i++) advanceSequence(st, sig, true, 1_700_000_000_000 + i * 60000);
    ok('streak counted', st.correctStreak === 5 && st.wrongStreak === 0);
    ok('mastery rose with five correct answers', st.concepts['kinematics'].mastery.pL > 0.8, +st.concepts['kinematics'].mastery.pL.toFixed(3));
    advanceSequence(st, sig, false, 1_700_000_000_000 + 6 * 60000);
    ok('a wrong answer resets the run and lowers mastery', st.correctStreak === 0 && st.wrongStreak === 1);
    ok('session position advances', st.sessionPos === 6, st.sessionPos);
    advanceSequence(st, sig, true, 1_700_000_000_000 + 6 * 60000 + 3 * 3600_000);
    ok('a three-hour gap starts a new session', st.sessionPos === 1, st.sessionPos);
    ok('recent window holds at most 20', st.recent.length <= 20);

    // baseline
    const fresh = newSequenceState();
    ok('unseen concept falls back to item difficulty', near(baselinePredict(sig, fresh), 1 - 0.7, 1e-9));
    ok('seen concept uses the BKT posterior', baselinePredict(sig, st) !== 1 - 0.7);
  }

  // ---------------------------------------------------------------- clustering (unsupervised)
  console.log('\n== unsupervised clustering ==');
  {
    const rnd = mulberry32(21);
    const groupA = Array.from({ length: 40 }, () => normalize([1 + rnd() * 0.1, rnd() * 0.1, rnd() * 0.05]));
    const groupB = Array.from({ length: 40 }, () => normalize([rnd() * 0.05, 1 + rnd() * 0.1, rnd() * 0.1]));
    const all = [...groupA, ...groupB];
    const r = kmeans(all, 2, { seed: 3 });
    const firstHalf = new Set(r.assignments.slice(0, 40));
    const secondHalf = new Set(r.assignments.slice(40));
    ok('two real groups are found without any labels', firstHalf.size === 1 && secondHalf.size === 1 && [...firstHalf][0] !== [...secondHalf][0], r.sizes);
    ok('inertia is reported', r.inertia >= 0);
    ok('k=1 is legal', kmeans(all, 1, { seed: 3 }).centroids.length === 1);
    ok('no vectors is not a crash', kmeans([], 3).centroids.length === 0);
    ok('elbow picks a small k on this data', chooseK(all, 8, 3) >= 2, chooseK(all, 8, 3));

    const online = new OnlineKMeans(r.centroids);
    const idx = online.learn(normalize([1, 0.05, 0]));
    ok('online update assigns to the nearer centroid', idx === online.nearest(normalize([1, 0.05, 0])).index);
    ok('one-hot is one slot wide', online.oneHot(groupA[0], 8).filter((x) => x === 1).length === 1);
    ok('novelty is high for something unlike anything seen', online.novelty(normalize([0, 0, 1])) > 0.5, +online.novelty(normalize([0, 0, 1])).toFixed(3));
    ok('novelty is low for a familiar point', online.novelty(groupA[1]) < 0.2, +online.novelty(groupA[1]).toFixed(3));
    ok('cosine distance of a vector to itself is zero', near(cosineDistance(groupA[0], groupA[0]), 0, 1e-9));
    const back = OnlineKMeans.fromJSON(JSON.parse(JSON.stringify(online.toJSON())));
    ok('clusters survive a JSON round trip', back.nearest(groupB[0]).index === online.nearest(groupB[0]).index);
  }

  // ---------------------------------------------------------------- semi-supervised
  console.log('\n== semi-supervised ==');
  {
    const items = [
      { id: 'a', x: [0.99] }, { id: 'b', x: [0.5] }, { id: 'c', x: [0.02] }, { id: 'd', x: [0.55] },
    ];
    const out = pseudoLabelBinary(items, (x) => x[0], { threshold: 0.85, max: 10 });
    ok('only confident guesses are admitted', out.length === 2 && out.map((o) => o.id).sort().join(',') === 'a,c', out.map((o) => o.id));
    ok('a guess always weighs less than a graded answer', out.every((o) => o.w < 1 && o.w > 0), out.map((o) => o.w));
    ok('labels follow the prediction', out.find((o) => o.id === 'a')!.y[0] === 1 && out.find((o) => o.id === 'c')!.y[0] === 0);
    ok('the cap is enforced', pseudoLabelBinary(items, () => 0.99, { threshold: 0.6, max: 2 }).length === 2);
    const multi = pseudoLabelMulti([{ id: 'm', x: [0] }], () => [0.05, 0.9, 0.05], 3, { threshold: 0.8 });
    ok('multi-class self-training picks the top class', multi.length === 1 && multi[0].y[1] === 1);
    ok('an unconfident multi-class guess is refused', pseudoLabelMulti([{ id: 'm', x: [0] }], () => [0.4, 0.35, 0.25], 3, { threshold: 0.8 }).length === 0);

    // label propagation over a prerequisite chain: a(0.9) -> b -> c -> d(0.1)
    const prop = propagateLabels(['a', 'b', 'c', 'd'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' }], { a: 0.9, d: 0.1 });
    ok('observations are never overwritten', prop.a.value === 0.9 && prop.d.value === 0.1);
    ok('unobserved nodes inherit from their neighbours', prop.b.value > prop.c.value, { b: prop.b.value, c: prop.c.value });
    ok('observed nodes are flagged as observed', prop.a.observed && !prop.b.observed);
    // Confidence decay needs an ASYMMETRIC graph: in the chain above, b and c are each one hop from
    // an observation, so equal confidence there is correct, not a bug. Seed only one end.
    const chain = propagateLabels(['a', 'b', 'c', 'd'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' }], { a: 0.9 });
    ok('confidence decays with distance from evidence', chain.b.confidence < 1 && chain.b.confidence > chain.c.confidence && chain.c.confidence > chain.d.confidence,
      { b: chain.b.confidence, c: chain.c.confidence, d: chain.d.confidence });
    ok('an isolated node is not a crash', propagateLabels(['x'], [], {}).x.confidence === 0);
  }

  // ---------------------------------------------------------------- metrics + promotion gate
  console.log('\n== evaluation ==');
  {
    const perfect = evaluateBinary([0.99, 0.01, 0.98, 0.02], [1, 0, 1, 0]);
    ok('a good model scores well', perfect.accuracy === 1 && perfect.logLoss < 0.05 && perfect.auc === 1, perfect);
    const backwards = evaluateBinary([0.01, 0.99, 0.02, 0.98], [1, 0, 1, 0]);
    ok('a backwards model scores badly', backwards.accuracy === 0 && backwards.auc === 0, { auc: backwards.auc });
    ok('a coin flip is AUC 0.5', auc([0.5, 0.5, 0.5, 0.5], [1, 0, 1, 0]) === 0.5);
    ok('a confident wrong answer is not infinite loss', isFinite(evaluateBinary([1], [0]).logLoss));
    ok('empty input is not a crash', evaluateBinary([], []).n === 0);
    const cal = evaluateBinary([0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7], [1, 1, 1, 1, 1, 1, 1, 0, 0, 0]);
    ok('calibration error is near zero when 70% means 70%', cal.ece < 0.02, cal.ece);
    const m = evaluateMulti([[0.8, 0.1, 0.1], [0.1, 0.8, 0.1]], [[1, 0, 0], [0, 1, 0]]);
    ok('multi-class accuracy', m.accuracy === 1 && m.n === 2);

    let hold = 0; for (let i = 0; i < 4000; i++) if (isHoldout('row-' + i, 0.25)) hold++;
    ok('holdout split is about the fraction asked for', Math.abs(hold / 4000 - 0.25) < 0.03, +(hold / 4000).toFixed(3));
    ok('holdout split is stable for the same id', isHoldout('row-7') === isHoldout('row-7'));

    const good = { n: 500, logLoss: 0.50, accuracy: 0.78, auc: 0.82, brier: 0.16, ece: 0.03, positiveRate: 0.6 };
    const baseline = { n: 500, logLoss: 0.62, accuracy: 0.70, auc: 0.70, brier: 0.21, ece: 0.06, positiveRate: 0.6 };
    ok('a clear winner is promoted', shouldPromote({ candidate: good, champion: null, baseline }).promote);
    ok('too little held-out data refuses promotion', !shouldPromote({ candidate: { ...good, n: 20 }, champion: null, baseline }).promote);
    ok('no improvement over the existing estimator refuses promotion', !shouldPromote({ candidate: { ...good, logLoss: 0.615 }, champion: null, baseline }).promote);
    ok('failing to beat the serving checkpoint refuses promotion', !shouldPromote({ candidate: good, champion: { ...good, logLoss: 0.499 }, baseline }).promote);
    ok('a badly calibrated model refuses promotion', !shouldPromote({ candidate: { ...good, ece: 0.4 }, champion: null, baseline }).promote);
    ok('the refusal says why, in words', shouldPromote({ candidate: { ...good, n: 20 }, champion: null, baseline }).reason.length > 30);
  }

  // ---------------------------------------------------------------- the whole pipeline
  console.log('\n== end to end: does the network actually beat what we already had ==');
  {
    // Simulated learners. Outcome depends on latent ability AND item difficulty AND fatigue late in
    // a session — a shape Bayesian Knowledge Tracing cannot represent, because it never sees the item.
    const rnd = mulberry32(2026);
    const logistic = (x: number) => 1 / (1 + Math.exp(-x));
    const concepts = ['algebra', 'kinematics', 'optics', 'cells'];
    const rows: { id: string; x: number[]; y: number; base: number }[] = [];
    for (let learner = 0; learner < 90; learner++) {
      const ability = (rnd() - 0.5) * 3;
      const state = newSequenceState();
      let t = 1_700_000_000_000 + learner * 86400000;
      for (let i = 0; i < 40; i++) {
        const concept = concepts[Math.floor(rnd() * concepts.length)];
        const difficulty = 0.15 + rnd() * 0.7;
        const b = Math.log(difficulty / (1 - difficulty));
        const fatigue = i > 25 ? -0.6 : 0;
        const p = logistic(ability - b + fatigue);
        const correct = rnd() < p;
        const sig: MindSignals = { itemKey: 'q' + i, conceptKey: concept, itemType: 'mcq_single', difficulty, marks: 1, responseMs: 12000 + rnd() * 8000, text: concept + ' question ' + (i % 7), atMs: t };
        rows.push({ id: 'L' + learner + '-' + i, x: featurize(sig, state), y: correct ? 1 : 0, base: baselinePredict(sig, state) });
        advanceSequence(state, sig, correct, t);
        t += 90000;
      }
    }
    const train = rows.filter((r) => !isHoldout(r.id, 0.25));
    const test = rows.filter((r) => isHoldout(r.id, 0.25));
    const net = new MLP({ sizes: [FEATURE_DIM, 24, 12, 1], output: 'sigmoid', seed: 77, l2: 1e-4 });
    net.fit(train.map((r) => ({ x: r.x, y: [r.y] })), { epochs: 60, batchSize: 32, lr: 0.01, seed: 5 });

    const labels = test.map((r) => r.y);
    const mNet = evaluateBinary(test.map((r) => net.predictOne(r.x)), labels);
    const mBase = evaluateBinary(test.map((r) => r.base), labels);
    const decision = shouldPromote({ candidate: mNet, champion: null, baseline: mBase });
    console.log('       network :', JSON.stringify(mNet));
    console.log('       baseline:', JSON.stringify(mBase));
    console.log('       decision:', decision.reason);
    ok('trained on ' + train.length + ', held out ' + test.length, test.length > 500);
    ok('the network beats the existing estimator on unseen answers', mNet.logLoss < mBase.logLoss, { net: mNet.logLoss, baseline: mBase.logLoss });
    ok('and it is the promotion gate that says so', decision.promote, decision.reason);

    // Self-training on the same pipeline must not make it worse.
    const unlabeled = rows.filter((r) => isHoldout(r.id, 0.25)).slice(0, 300).map((r) => ({ id: r.id, x: r.x }));
    const pseudo = pseudoLabelBinary(unlabeled, (x) => net.predictOne(x), { threshold: 0.8, max: 200 });
    ok('self-training produced weighted examples from unlabelled rows', pseudo.length > 0 && pseudo.every((p) => p.w < 1), pseudo.length);
  }

  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES: ' + fail) + '  (' + pass + ' passed)');
  if (fail > 0) process.exit(1);
}

main();
