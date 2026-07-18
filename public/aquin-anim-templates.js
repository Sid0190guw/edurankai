/* aquin-anim-templates.js — AquinTutor parametric animation template engine (Prompt A1). A
   registry of web-native, ultra-light templates (SVG, minimal JS — no WebGL). Each template
   declares a parameter schema and PURE compute functions (geometry from params + time), plus a
   render() that draws into an SVG. The board broadcasts a SPEC {templateId, params, playState,
   timelinePos} — NEVER pixels — and every device renders locally at its tier. Dependency-free;
   the pure math is unit-tested in Node via the repo's eval pattern. */
(function () {
  function clampNum(v, s) { v = Number(v); if (!isFinite(v)) v = s.def; return Math.max(s.min, Math.min(s.max, v)); }

  var projectile = {
    id: 'projectile', name: 'Projectile motion', kind: 'physics',
    schema: [
      { key: 'angle', label: 'Angle (deg)', min: 0, max: 90, def: 45 },
      { key: 'v0', label: 'Initial velocity', min: 1, max: 100, def: 30 },
      { key: 'gravity', label: 'Gravity', min: 1, max: 30, def: 9.8 },
    ],
    duration: function (p) { var a = p.angle * Math.PI / 180; return (2 * p.v0 * Math.sin(a)) / p.gravity; },
    compute: function (p, t) { var a = p.angle * Math.PI / 180; var x = p.v0 * Math.cos(a) * t; var y = p.v0 * Math.sin(a) * t - 0.5 * p.gravity * t * t; return { x: x, y: Math.max(0, y) }; },
    path: function (p, samples) { samples = samples || 40; var d = this.duration(p), pts = []; for (var i = 0; i <= samples; i++) { pts.push(this.compute(p, (d * i) / samples)); } return pts; },
  };

  var sine = {
    id: 'sine', name: 'Function / sine plot', kind: 'math',
    schema: [
      { key: 'amplitude', label: 'Amplitude', min: 0.1, max: 10, def: 3 },
      { key: 'frequency', label: 'Frequency', min: 0.1, max: 10, def: 1 },
      { key: 'phase', label: 'Phase', min: 0, max: 6.28, def: 0 },
    ],
    duration: function () { return 4; },
    sample: function (p, n) { n = n || 60; var pts = []; for (var i = 0; i <= n; i++) { var x = (i / n) * 2 * Math.PI; pts.push({ x: x, y: p.amplitude * Math.sin(p.frequency * x + p.phase) }); } return pts; },
  };

  var sortbars = {
    id: 'sortbars', name: 'Sorting visualiser', kind: 'cs',
    schema: [{ key: 'values', label: 'List', type: 'list', def: [5, 2, 8, 1, 9, 3] }],
    // Bubble-sort snapshots: an array of array-states, so the timeline scrubs through the sort.
    steps: function (values) {
      var a = (values || []).slice(), snaps = [a.slice()];
      for (var i = 0; i < a.length; i++) { for (var j = 0; j < a.length - 1 - i; j++) { if (a[j] > a[j + 1]) { var t = a[j]; a[j] = a[j + 1]; a[j + 1] = t; snaps.push(a.slice()); } } }
      return snaps;
    },
    duration: function (p) { return this.steps(p.values).length * 0.25; },
  };

  var REG = { projectile: projectile, sine: sine, sortbars: sortbars };

  function get(id) { return REG[id] || null; }
  function list() { return Object.keys(REG).map(function (k) { return { id: REG[k].id, name: REG[k].name, kind: REG[k].kind, schema: REG[k].schema }; }); }
  /** Clamp/validate params against a template's schema (also used by A2's LLM extraction). Pure. */
  function clampParams(id, params) {
    var tpl = get(id); if (!tpl) return null; var out = {}; params = params || {};
    tpl.schema.forEach(function (s) {
      if (s.type === 'list') { var v = params[s.key]; out[s.key] = Array.isArray(v) && v.length ? v.map(Number).filter(function (n) { return isFinite(n); }) : s.def.slice(); }
      else out[s.key] = clampNum(params[s.key] != null ? params[s.key] : s.def, s);
    });
    return out;
  }
  /** The broadcast spec — small structured data, NEVER pixels. Pure. */
  function buildSpec(id, params, playState, timelinePos) { return { templateId: id, params: clampParams(id, params), playState: playState || 'paused', timelinePos: timelinePos || 0 }; }
  /** Sample density per render tier (Prompt 5): lite = coarse/near-static; rich = smooth. Pure. */
  function tierSamples(tier) { return tier === 'lite' ? 8 : tier === 'standard' ? 24 : 48; }
  function tierAnimated(tier) { return tier !== 'lite'; }   // lite = static keyframe, no rAF loop

  // ---- SVG render (browser only; no-op without a document) ----
  function renderSVG(svg, spec, tier) {
    if (typeof document === 'undefined' || !svg) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var NS = 'http://www.w3.org/2000/svg', W = 320, H = 200, tpl = get(spec.templateId); if (!tpl) return;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    function line(pts, color) { var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + p.x + ' ' + p.y; }).join(' '); var e = document.createElementNS(NS, 'path'); e.setAttribute('d', d); e.setAttribute('fill', 'none'); e.setAttribute('stroke', color); e.setAttribute('stroke-width', '2'); svg.appendChild(e); }
    var samples = tierSamples(tier);
    if (spec.templateId === 'projectile') {
      var pts = tpl.path(spec.params, samples).map(function (p) { return { x: 20 + p.x * 2.2, y: H - 20 - p.y * 2.2 }; });
      line(pts, '#b3541e');
      var tp = spec.timelinePos || 0, cur = pts[Math.min(pts.length - 1, Math.floor(tp * (pts.length - 1)))];
      if (cur) { var c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', cur.x); c.setAttribute('cy', cur.y); c.setAttribute('r', '5'); c.setAttribute('fill', '#1a1712'); svg.appendChild(c); }
    } else if (spec.templateId === 'sine') {
      var sp = tpl.sample(spec.params, samples).map(function (p) { return { x: (p.x / (2 * Math.PI)) * (W - 20) + 10, y: H / 2 - p.y * 12 }; }); line(sp, '#5a5aa8');
    } else if (spec.templateId === 'sortbars') {
      var snaps = tpl.steps(spec.params.values), idx = Math.min(snaps.length - 1, Math.floor((spec.timelinePos || 0) * (snaps.length - 1))), arr = snaps[idx] || [], max = Math.max.apply(null, arr.concat([1])), bw = (W - 20) / arr.length;
      arr.forEach(function (v, i) { var r = document.createElementNS(NS, 'rect'); var bh = (v / max) * (H - 30); r.setAttribute('x', 10 + i * bw); r.setAttribute('y', H - 10 - bh); r.setAttribute('width', bw - 3); r.setAttribute('height', bh); r.setAttribute('fill', '#b3541e'); svg.appendChild(r); });
    }
  }

  var api = { get: get, list: list, clampParams: clampParams, buildSpec: buildSpec, tierSamples: tierSamples, tierAnimated: tierAnimated, renderSVG: renderSVG, templates: REG };
  if (typeof window !== 'undefined') window.AquinAnim = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
