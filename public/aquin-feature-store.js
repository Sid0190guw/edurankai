/*
 * aquin-feature-store.js — AES-100 Vol IV P2 Ch87: Enterprise Feature Store, Data
 * Engineering & Intelligent Feature Management (EFSDEIFMF). Engineered features become
 * reusable, governed enterprise assets served CONSISTENTLY to training and inference.
 * Real, tested cores:
 *
 *  - ONLINE store: getOnline(entity) -> the LATEST value per feature (millisecond
 *    lookup for live inference).
 *  - OFFLINE store with POINT-IN-TIME-CORRECT joins: getHistorical(entity, asOf) ->
 *    the value that was valid at asOf, NEVER a value recorded after it. This is the
 *    core algorithm that prevents training/serving SKEW (label leakage) — training on
 *    "the future" is the classic silent ML bug, and this makes it impossible.
 *  - SKEW DETECTION: compares the online value with the point-in-time offline value.
 *  - FEATURE QUALITY: completeness, uniqueness, freshness.
 *  - LINEAGE graph (source -> transform -> feature) with an explain() trace, so every
 *    prediction is attributable.
 *  - DISCOVERY: search the registry by name/tags so engineers reuse instead of
 *    re-engineering.
 *  - LIFECYCLE state (design -> serving -> deprecated -> retired).
 *
 * HONEST SCOPE: registry, point-in-time join, skew/quality math and lineage are real
 * over an in-memory store; the distributed online KV store, streaming compute and
 * durable offline warehouse are declared substrates.
 */
(function () {
  function createFeatureStore() {
    var features = {};   // id -> { id, owner, type, transform, sources, tags, state }
    var values = {};     // id -> [ { entity, value, eventTime } ]  (offline log, append-only)
    var prov = [];
    function rec(op, d) { prov.push({ op: op, at: Date.now(), detail: d || null }); }

    function log(id) { return values[id] || (values[id] = []); }

    var F = {
      provenance: prov,
      registerFeature: function (id, spec) { spec = spec || {}; features[id] = { id: id, owner: spec.owner || null, type: spec.type || 'numeric', transform: spec.transform || null, sources: (spec.sources || []).slice(), tags: (spec.tags || []).slice(), state: 'serving' }; rec('register', { id: id }); return features[id]; },

      // ingest a feature value observed for an entity at a given event time
      push: function (id, entity, value, eventTime) { if (!features[id]) return { ok: false, reason: 'unknown feature "' + id + '"' }; log(id).push({ entity: entity, value: value, eventTime: eventTime != null ? eventTime : Date.now() }); return { ok: true }; },

      // ONLINE: latest value per feature for an entity (inference path)
      getOnline: function (entity, ids) {
        var out = {}; (ids || Object.keys(features)).forEach(function (id) { var rows = log(id).filter(function (r) { return r.entity === entity; }); var latest = null; rows.forEach(function (r) { if (!latest || r.eventTime > latest.eventTime) latest = r; }); out[id] = latest ? latest.value : null; });
        return out;
      },

      // OFFLINE / TRAINING: point-in-time-correct value — the newest observation at or
      // before asOf. Never leaks a value recorded after asOf.
      getHistorical: function (entity, ids, asOf) {
        var out = {}; (ids || Object.keys(features)).forEach(function (id) { var best = null; log(id).forEach(function (r) { if (r.entity === entity && r.eventTime <= asOf && (!best || r.eventTime > best.eventTime)) best = r; }); out[id] = best ? best.value : null; });
        return out;
      },

      // training/serving skew: does the online value match the point-in-time offline value at asOf?
      skew: function (entity, id, asOf) { var on = F.getOnline(entity, [id])[id], off = F.getHistorical(entity, [id], asOf)[id]; return { entity: entity, feature: id, online: on, offlineAsOf: off, skew: on !== off }; },

      quality: function (id) {
        var rows = log(id); if (!rows.length) return { completeness: 0, uniqueness: 0, freshnessMs: null, count: 0 };
        var nonNull = rows.filter(function (r) { return r.value != null; }).length;
        var distinct = {}; rows.forEach(function (r) { distinct[JSON.stringify(r.value)] = 1; });
        var newest = rows.reduce(function (a, r) { return Math.max(a, r.eventTime); }, 0);
        return { count: rows.length, completeness: +(nonNull / rows.length).toFixed(4), uniqueness: +(Object.keys(distinct).length / rows.length).toFixed(4), freshnessMs: Date.now() - newest };
      },

      // lineage: walk sources -> feature, returning the derivation chain
      explain: function (id) { var f = features[id]; if (!f) return null; return { feature: id, transform: f.transform, sources: f.sources, chain: f.sources.map(function (s) { return s + ' -> ' + (f.transform || 'identity') + ' -> ' + id; }) }; },

      discover: function (query) { var q = (query || '').toLowerCase(); return Object.keys(features).map(function (k) { return features[k]; }).filter(function (f) { return f.id.toLowerCase().indexOf(q) !== -1 || f.tags.some(function (t) { return t.toLowerCase().indexOf(q) !== -1; }); }).map(function (f) { return { id: f.id, owner: f.owner, tags: f.tags, state: f.state }; }); },

      transition: function (id, to) { var f = features[id]; var order = ['design', 'serving', 'deprecated', 'retired']; if (!f) return { ok: false }; if (order.indexOf(to) <= order.indexOf(f.state)) return { ok: false, reason: 'cannot move ' + f.state + ' -> ' + to }; f.state = to; return { ok: true, state: to }; },
      feature: function (id) { return features[id]; }
    };
    return F;
  }
  window.AquinFeatureStore = { createFeatureStore: createFeatureStore };
})();
