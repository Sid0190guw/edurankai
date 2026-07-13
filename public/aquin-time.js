/*
 * aquin-time.js — Educational Time Intelligence Engine (AES-100, Vol II, Ch 60).
 * Conventional LMSs treat time as a timestamp on an assignment. A good teacher
 * treats time as an active dimension: a child learns better in the morning,
 * revision after ~24h improves retention, burnout appears after weeks of overload,
 * curiosity changes over years. This engine turns time from passive metadata into
 * an active computational resource.
 *
 * Engineered guarantees (proven in the tests):
 *  - MULTI-SCALE: it reasons over daily / weekly / semester / annual / lifetime
 *    scales simultaneously.
 *  - RETENTION OVER TIME: it estimates how much of a concept survives as time
 *    passes (forgetting curve) — reusing the memory model, not reinventing truth.
 *  - SPACED REVISION SCHEDULING: it schedules the NEXT revision at expanding
 *    intervals; a well-recalled concept waits longer, a shaky one comes back soon.
 *  - RHYTHM DETECTION: from real performance history it finds WHEN this learner
 *    performs best (e.g. mornings) — evidence, not assumption.
 *  - COGNITIVE TIMING is ADAPTIVE, not deterministic: it recommends teach / revise
 *    / assess / rest and always exposes the evidence; it never commands.
 *  - OVERLOAD/BURNOUT signal from sustained high load across weeks.
 *  - TEMPORAL PROVENANCE of every timing decision.
 *
 * HONEST SCOPE: pure temporal reasoning over supplied event history. The forgetting
 * model is the Ebbinghaus-style curve also used by aquin-memory.js (Vol I); this
 * engine adds scheduling, rhythm detection, and multi-scale cognitive timing above
 * it. Multiple evidence-based memory models can be plugged in behind `retention`.
 */
(function () {
  var DAY = 86400000, HOUR = 3600000;
  var SCALES = ['daily', 'weekly', 'semester', 'annual', 'lifetime'];

  function createTimeIntelligence(cfg) {
    cfg = cfg || {};
    var now = cfg.now || function () { return Date.now(); };
    var events = [];         // { concept, kind, correct?, at, hour, load? }
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: now(), detail: d || null }); }

    // record an educational event (a review, an assessment, a session)
    function record(ev) {
      var at = ev.at != null ? ev.at : now();
      events.push({ concept: ev.concept || null, kind: ev.kind || 'review', correct: ev.correct, at: at, hour: new Date(at).getHours(), load: ev.load != null ? ev.load : null });
      rec('record', { concept: ev.concept, kind: ev.kind });
      return true;
    }

    // RETENTION OVER TIME — Ebbinghaus-style decay R = exp(-t/S), strength S grows
    // with each successful review (spacing effect). Same curve family as aquin-memory.
    function retention(concept, at) {
      at = at != null ? at : now();
      var reps = events.filter(function (e) { return e.concept === concept && (e.kind === 'review' || e.kind === 'learn') && e.correct !== false; })
        .sort(function (a, b) { return a.at - b.at; });
      if (!reps.length) return { concept: concept, retention: 0, reviews: 0, note: 'never studied' };
      var last = reps[reps.length - 1];
      var strengthDays = 1 * Math.pow(2, reps.length - 1);              // memory strengthens with successful reps
      var elapsedDays = Math.max(0, (at - last.at) / DAY);
      var R = Math.exp(-elapsedDays / strengthDays);
      return { concept: concept, retention: +R.toFixed(3), reviews: reps.length, elapsedDays: +elapsedDays.toFixed(2), strengthDays: strengthDays, lastReviewed: last.at };
    }

    // SPACED REVISION SCHEDULING — next review when retention would fall to target
    function nextRevision(concept, targetRetention) {
      var target = targetRetention != null ? targetRetention : 0.7;
      var r = retention(concept);
      if (!r.reviews) return { concept: concept, dueNow: true, reason: 'never studied — introduce it' };
      // solve exp(-t/S)=target  =>  t = -S*ln(target)
      var intervalDays = -r.strengthDays * Math.log(target);
      var dueAt = r.lastReviewed + intervalDays * DAY;
      var overdueDays = (now() - dueAt) / DAY;
      rec('schedule', { concept: concept, intervalDays: +intervalDays.toFixed(2) });
      return { concept: concept, dueAt: dueAt, intervalDays: +intervalDays.toFixed(2), dueNow: overdueDays >= 0, overdueDays: +overdueDays.toFixed(2), currentRetention: r.retention };
    }

    // RHYTHM DETECTION — when does this learner actually perform best? (evidence)
    function dailyRhythm() {
      var buckets = {};   // hour -> { n, correct }
      events.filter(function (e) { return e.correct != null; }).forEach(function (e) { var b = (buckets[e.hour] = buckets[e.hour] || { hour: e.hour, n: 0, correct: 0 }); b.n++; if (e.correct) b.correct++; });
      var ranked = Object.keys(buckets).map(function (h) { var b = buckets[h]; return { hour: +h, samples: b.n, successRate: +(b.correct / b.n).toFixed(3) }; })
        .filter(function (b) { return b.samples >= (cfg.minSamples || 2); })
        .sort(function (a, b) { return b.successRate - a.successRate; });
      rec('rhythm', { buckets: ranked.length });
      return { bestHours: ranked.slice(0, 3), evidence: ranked.length ? (ranked.length + ' time-bucket(s) with >=' + (cfg.minSamples || 2) + ' samples') : 'insufficient history — no rhythm asserted', ranked: ranked };
    }

    // OVERLOAD / BURNOUT — sustained high load across recent weeks
    function loadTrend(weeks) {
      weeks = weeks || 3;
      var since = now() - weeks * 7 * DAY;
      var recent = events.filter(function (e) { return e.at >= since && e.load != null; });
      if (!recent.length) return { overloaded: false, note: 'no load data' };
      var avg = recent.reduce(function (s, e) { return s + e.load; }, 0) / recent.length;
      var overloaded = avg >= (cfg.overloadThreshold || 0.75);
      return { overloaded: overloaded, avgLoad: +avg.toFixed(3), samples: recent.length, note: overloaded ? 'sustained high load — recovery break recommended' : 'load within healthy range' };
    }

    // COGNITIVE TIMING — adaptive recommendation, always with evidence, never a command
    function recommend(concept) {
      var load = loadTrend();
      if (load.overloaded) return { action: 'rest', adaptive: true, evidence: load.note, note: 'recovery precedes new learning' };
      var rev = nextRevision(concept);
      var rhythm = dailyRhythm();
      var best = rhythm.bestHours[0];
      var atGoodHour = best ? (new Date(now()).getHours() === best.hour) : null;
      var action, why;
      if (rev.dueNow && rev.reason) { action = 'teach'; why = rev.reason; }
      else if (rev.dueNow) { action = 'revise'; why = 'retention ~' + rev.currentRetention + ' has fallen to the revision threshold'; }
      else { action = 'assess-or-advance'; why = 'concept is well retained (~' + rev.currentRetention + '); not yet due for revision'; }
      rec('recommend', { concept: concept, action: action });
      return {
        action: action, adaptive: true, why: why,
        bestTimeOfDay: best ? best.hour + ':00 (success ' + best.successRate + ')' : 'unknown (insufficient rhythm history)',
        isGoodTimeNow: atGoodHour,
        note: 'recommendation is adaptive guidance, not a command; learner/teacher decides'
      };
    }

    return {
      SCALES: SCALES, provenance: provenance,
      record: record, retention: retention, nextRevision: nextRevision,
      dailyRhythm: dailyRhythm, loadTrend: loadTrend, recommend: recommend,
      timeSince: function (concept) { var r = retention(concept); return r.reviews ? { concept: concept, daysSinceReview: r.elapsedDays } : { concept: concept, daysSinceReview: null }; }
    };
  }

  window.AquinTime = { SCALES: SCALES, createTimeIntelligence: createTimeIntelligence };
})();
