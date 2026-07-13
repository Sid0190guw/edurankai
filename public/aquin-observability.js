/*
 * aquin-observability.js — AES-100 Vol III Part II Ch 16: Platform Observability,
 * Diagnostics & Autonomous Operations Framework (PODAOF). Turns raw telemetry into
 * operational intelligence. Real, tested cores:
 *
 *  - METRICS time series + statistical ANOMALY DETECTION (z-score): a value more
 *    than k standard deviations from the metric's recent mean is flagged — no fixed
 *    threshold guessing.
 *  - HEALTH ROLLUP across components (one system health from many signals).
 *  - ROOT-CAUSE ANALYSIS: given the dependency graph and the set of failed
 *    components, trace to the DEEPEST upstream failure (the failed component with no
 *    failed dependency) — the probable root cause, explainable.
 *  - INCIDENT lifecycle with MTTD / MTTA / MTTR metrics.
 *
 * HONEST SCOPE: the anomaly detection, health rollup, root-cause traversal, and
 * MTTR math are real and tested; petabyte log storage, distributed trace
 * correlation at scale, and the AIOps ML models are declared substrates.
 * (~35.1M-LOC C++ → the core.)
 */
(function () {
  function mean(a) { return a.reduce(function (s, x) { return s + x; }, 0) / a.length; }
  function stddev(a) { var m = mean(a); return Math.sqrt(mean(a.map(function (x) { return (x - m) * (x - m); }))); }

  function createObservability(cfg) {
    cfg = cfg || {};
    var now = cfg.now || function () { return Date.now(); };
    var series = {};      // metric -> [values]
    var incidents = [];
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: now(), detail: d || null }); }

    var O = {
      provenance: provenance,
      record: function (metric, value) { (series[metric] = series[metric] || []).push(value); return this; },
      metric: function (m) { return (series[m] || []).slice(); },

      // z-score anomaly: is `value` anomalous vs the metric's history?
      anomaly: function (metric, value, k) {
        k = k != null ? k : 3;
        var hist = series[metric] || [];
        if (hist.length < 4) return { anomaly: false, reason: 'insufficient history' };
        var m = mean(hist), sd = stddev(hist);
        if (sd === 0) return { anomaly: value !== m, z: value !== m ? Infinity : 0 };
        var z = (value - m) / sd;
        var isAnom = Math.abs(z) >= k;
        rec('anomaly-check', { metric: metric, z: +z.toFixed(2), anomaly: isAnom });
        return { anomaly: isAnom, z: +z.toFixed(2), mean: +m.toFixed(2), stddev: +sd.toFixed(2), threshold: k };
      },

      // health rollup: worst-of + fraction healthy
      health: function (components) {
        var states = Object.keys(components).map(function (k) { return components[k]; });
        var healthy = states.filter(function (s) { return s === 'healthy'; }).length;
        var overall = states.indexOf('failed') >= 0 ? 'degraded' : states.indexOf('degraded') >= 0 ? 'degraded' : 'healthy';
        return { overall: overall, healthy: healthy, total: states.length, ratio: +(healthy / states.length).toFixed(3) };
      },

      // root cause: deepest upstream failed component in the dependency graph
      // graph: { comp -> [deps] } ; failed: [comps]
      rootCause: function (graph, failed) {
        var failedSet = {}; failed.forEach(function (f) { failedSet[f] = true; });
        // a failed comp is a root cause if none of its deps are also failed
        var roots = failed.filter(function (f) { var deps = graph[f] || []; return !deps.some(function (d) { return failedSet[d]; }); });
        rec('root-cause', { failed: failed.length, roots: roots.length });
        return { rootCauses: roots, note: roots.length ? 'the failure(s) originate at ' + roots.join(', ') + '; downstream failures are consequences' : 'no clear root (possible cycle)' };
      },

      // incident lifecycle for MTTD/MTTA/MTTR
      detectIncident: function (id, symptomAt) { var inc = { id: id, symptomAt: symptomAt, detectedAt: now(), ackAt: null, resolvedAt: null }; incidents.push(inc); return inc; },
      ackIncident: function (id) { var i = incidents.filter(function (x) { return x.id === id; })[0]; if (i) i.ackAt = now(); return this; },
      resolveIncident: function (id) { var i = incidents.filter(function (x) { return x.id === id; })[0]; if (i) i.resolvedAt = now(); return this; },
      metrics: function () {
        var done = incidents.filter(function (i) { return i.resolvedAt != null; });
        function avg(f) { return done.length ? +(done.reduce(function (s, i) { return s + f(i); }, 0) / done.length).toFixed(1) : null; }
        return {
          incidents: incidents.length, resolved: done.length,
          mttd: avg(function (i) { return i.detectedAt - i.symptomAt; }),
          mtta: avg(function (i) { return (i.ackAt || i.detectedAt) - i.detectedAt; }),
          mttr: avg(function (i) { return i.resolvedAt - i.detectedAt; })
        };
      }
    };
    return O;
  }
  window.AquinObservability = { createObservability: createObservability };
})();
