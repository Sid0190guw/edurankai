/*
 * aquin-edu-dpi.js — AES-100 Vol III Part III Ch 12: Global Academic Federation &
 * Educational Digital Public Infrastructure (GAF-EDPIF). Edu-DPI = reusable, trusted,
 * federated educational services (like a public-infrastructure rail everyone builds
 * on) — NOT a central database. Ch 11 already does DIRECT credential recognition +
 * equivalence, so this builds the two distinct DPI cores — real and tested:
 *
 *  - TRANSITIVE / DELEGATED TRUST NETWORK: trust is a graph. If A trusts B and B
 *    trusts C, A can trust C THROUGH the chain — with confidence that DECAYS along
 *    the path (delegated trust weakens) and a bounded chain length. The engine finds
 *    the strongest trust PATH (a real graph search), and honestly returns "no trust"
 *    when no path exists.
 *  - ONCE-ONLY SERVICE (the core DPI promise): a learner submits a verified record
 *    ONCE; any service the learner authorises can REUSE it — no repeated submission,
 *    no repeated verification. Reuse is consent-gated and logged.
 *
 * HONEST SCOPE: the trust-graph search, decay, and once-only consent/reuse logic are
 * real and tested; cryptographic credential signing (aquin-identity.js) and real
 * inter-institutional API transport are declared substrates.
 */
(function () {
  function createDPI(cfg) {
    cfg = cfg || {};
    var maxHops = cfg.maxHops || 4, decay = cfg.decay != null ? cfg.decay : 0.85;
    var trustEdges = {};   // from -> { to -> weight 0..1 }
    var records = {};      // recordId -> { owner, type, data, verifiedBy }
    var consents = {};     // "owner|service" -> true
    var services = {};     // id -> { kind }
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    var D = {
      provenance: provenance,
      registerService: function (id, kind) { services[id] = { id: id, kind: kind || 'service' }; return this; },
      trust: function (from, to, weight) { (trustEdges[from] = trustEdges[from] || {})[to] = weight != null ? weight : 1; rec('trust', { from: from, to: to }); return this; },

      // strongest trust PATH from A to C (BFS/Dijkstra-style on multiplicative decay)
      trustPath: function (from, to) {
        if (from === to) return { trusted: true, confidence: 1, path: [from] };
        // best-first by confidence (product of edge weights * decay^hops)
        var best = { }, pq = [{ node: from, conf: 1, path: [from] }];
        var result = null;
        while (pq.length) {
          pq.sort(function (a, b) { return b.conf - a.conf; });
          var cur = pq.shift();
          if (cur.path.length > maxHops) continue;
          var edges = trustEdges[cur.node] || {};
          for (var nxt in edges) {
            var conf = cur.conf * edges[nxt] * decay;
            if (nxt === to) { if (!result || conf > result.confidence) result = { trusted: true, confidence: +conf.toFixed(3), path: cur.path.concat(nxt), hops: cur.path.length }; continue; }
            if (!best[nxt] || conf > best[nxt]) { best[nxt] = conf; pq.push({ node: nxt, conf: conf, path: cur.path.concat(nxt) }); }
          }
        }
        rec('trust-path', { from: from, to: to, trusted: !!result });
        return result || { trusted: false, confidence: 0, reason: 'no trust path from "' + from + '" to "' + to + '" within ' + maxHops + ' hops' };
      },

      // ONCE-ONLY: submit a verified record once
      submitRecord: function (id, owner, type, data, verifiedBy) { records[id] = { id: id, owner: owner, type: type, data: data, verifiedBy: verifiedBy || null }; rec('submit-record', { id: id, owner: owner }); return { ok: true, recordId: id }; },
      grantConsent: function (owner, service) { consents[owner + '|' + service] = true; return this; },
      // a service reuses an existing record instead of re-collecting it (consent required)
      reuseRecord: function (recordId, byService) {
        var r = records[recordId]; if (!r) return { ok: false, reason: 'no such record' };
        if (!consents[r.owner + '|' + byService]) return { ok: false, reason: 'no consent from "' + r.owner + '" for service "' + byService + '" — cannot reuse' };
        rec('reuse', { record: recordId, by: byService });
        return { ok: true, reused: true, type: r.type, data: r.data, verifiedBy: r.verifiedBy, note: 'record reused without re-submission (once-only DPI)' };
      }
    };
    return D;
  }
  window.AquinEduDPI = { createDPI: createDPI };
})();
