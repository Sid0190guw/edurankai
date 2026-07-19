// public/aquin-scene-engine.js — the scene engine's PURE core + tier dispatch + 2D fallback
// (Prompt A3a). Dependency-free (no Three.js here): it turns a scene spec into a resolved "scene
// model", owns the primitive/motion/physics REGISTRIES, decides the renderer for a Prompt-5 tier,
// and draws the LITE 2D fallback. The heavy WebGL adapter (window.AquinSceneGL, Three.js) is loaded
// separately and ONLY on rich/standard — so lite never pays for WebGL. All DOM use is guarded, so
// this file runs (and is tested) in Node via eval, exactly like aquin-anim-templates.js.
(function () {
  var TAU = Math.PI * 2;

  // ---- primitive library (the moat: a registry, built to grow) ----
  // Each entry: kind + the params it understands. The builder geometry lives in the WebGL adapter
  // (rich/standard) and the 2D drawer (lite); this registry is the shared contract + admin catalog.
  var PRIMITIVES = {
    sphere: { kind: 'base', params: ['size'] }, box: { kind: 'base', params: ['size'] },
    cylinder: { kind: 'base', params: ['size'] }, cone: { kind: 'base', params: ['size'] },
    torus: { kind: 'base', params: ['size'] }, ring: { kind: 'base', params: ['size'] },
    plane: { kind: 'base', params: ['size'] }, line: { kind: 'base', params: ['points'] },
    arrow: { kind: 'base', params: ['position', 'size'] }, particles: { kind: 'base', params: ['count', 'size'] },
    label: { kind: 'base', params: ['text', 'position'] },
    projectile: { kind: 'physics', params: ['angle', 'v0', 'gravity'] },
    pendulum: { kind: 'physics', params: ['length', 'gravity', 'amplitude'] },
    spring: { kind: 'physics', params: ['k', 'mass', 'amplitude'] },
  };

  // ---- motion library (parametric + easing) ----
  var MOTIONS = ['none', 'spin', 'orbit', 'oscillate', 'float', 'pulse', 'grow', 'flow', 'fall'];
  function easeInOut(x) { return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }

  // ---- physics pack (pure, correct) ----
  var PHYSICS = {
    // 3D projectile: x forward, y up, z = 0. Returns flight duration + point(t) over [0,duration].
    projectile: function (p) {
      var a = (p.angle != null ? p.angle : 45) * Math.PI / 180, v = p.v0 != null ? p.v0 : 30, g = p.gravity != null ? p.gravity : 9.8;
      var dur = (2 * v * Math.sin(a)) / g;
      return {
        duration: dur,
        point: function (t) { var x = v * Math.cos(a) * t, y = v * Math.sin(a) * t - 0.5 * g * t * t; return [x, Math.max(0, y), 0]; },
        apex: (v * v * Math.sin(a) * Math.sin(a)) / (2 * g),
        range: (v * v * Math.sin(2 * a)) / g,
      };
    },
    // simple pendulum (small-to-moderate angle): theta(t) = A cos(sqrt(g/L) t)
    pendulum: function (p) {
      var L = p.length != null ? p.length : 4, g = p.gravity != null ? p.gravity : 9.8, A = p.amplitude != null ? p.amplitude : 0.5;
      var w = Math.sqrt(g / L);
      return { omega: w, period: TAU / w, angle: function (t) { return A * Math.cos(w * t); }, bob: function (t) { var th = A * Math.cos(w * t); return [L * Math.sin(th), -L * Math.cos(th), 0]; } };
    },
    // mass on a spring: x(t) = A cos(sqrt(k/m) t)
    spring: function (p) {
      var k = p.k != null ? p.k : 8, m = p.mass != null ? p.mass : 1, A = p.amplitude != null ? p.amplitude : 2;
      var w = Math.sqrt(k / m);
      return { omega: w, period: TAU / w, x: function (t) { return A * Math.cos(w * t); } };
    },
  };
  function trajectory(type, params, n) {
    var ph = PHYSICS[type]; if (!ph) return [];
    var m = ph(params || {}), pts = [], N = n || 48;
    if (type === 'projectile') { for (var i = 0; i <= N; i++) pts.push(m.point((i / N) * m.duration)); }
    else if (type === 'pendulum') { for (var j = 0; j <= N; j++) pts.push(m.bob((j / N) * m.period)); }
    else if (type === 'spring') { for (var s = 0; s <= N; s++) { var x = m.x((s / N) * m.period); pts.push([0, x, 0]); } }
    return pts;
  }

  // ---- tier -> renderer selection (Prompt 5) ----
  function rendererFor(tier) { return tier === 'lite' ? 'svg2d' : 'webgl'; }   // rich/standard = WebGL
  function usesWebGL(tier) { return tier !== 'lite'; }                         // lite NEVER loads Three.js
  function tierQuality(tier) { return { bloom: tier === 'rich', shadows: tier !== 'lite', envMap: tier === 'rich', maxLights: tier === 'rich' ? 4 : 2, particleCap: tier === 'rich' ? 2000 : tier === 'standard' ? 400 : 60 }; }

  // ---- build a resolved scene model both renderers consume (PURE) ----
  function asVec(v, d) { return Array.isArray(v) ? [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0] : (d || [0, 0, 0]); }
  function buildModel(spec) {
    var s = spec || {}, objs = Array.isArray(s.objects) ? s.objects : [];
    var byId = {}; objs.forEach(function (o) { if (o && o.id) byId[o.id] = o; });
    var nodes = objs.map(function (o) {
      var pos = asVec(o.position);
      if (o.parent && byId[o.parent]) { var pp = asVec(byId[o.parent].position); pos = [pos[0] + pp[0], pos[1] + pp[1], pos[2] + pp[2]]; }
      var node = {
        id: o.id, type: o.type, position: pos, rotation: asVec(o.rotation), size: o.size == null ? 1 : o.size,
        color: o.color || '#7db1ff', material: o.material || { metalness: 0.1, roughness: 0.6, emissive: 0, opacity: 1 },
        motion: o.motion || { type: 'none', axis: [0, 1, 0], speed: 1, params: {} },
        orbitCenter: o.orbitCenter ? asVec(o.orbitCenter) : null, text: o.text || '', count: o.count || 0, points: o.points || null,
      };
      if (PRIMITIVES[o.type] && PRIMITIVES[o.type].kind === 'physics') node.path = trajectory(o.type, o.motion && o.motion.params, 48);
      return node;
    });
    return { title: s.title || '', subtitle: s.subtitle || '', palette: s.palette || 'studio', nodes: nodes, camera: s.camera || { autoRotate: true, distance: 12, target: [0, 0, 0] } };
  }

  // ---- motion applied at time t (used by both renderers) ----
  function motionAt(node, t) {
    var m = node.motion || {}, sp = m.speed == null ? 1 : m.speed, pos = node.position.slice(), rot = node.rotation.slice(), scale = 1;
    switch (m.type) {
      case 'spin': rot[1] += t * sp; break;
      case 'orbit': { var c = node.orbitCenter || [0, 0, 0], rdx = pos[0] - c[0], rdz = pos[2] - c[2], r = Math.sqrt(rdx * rdx + rdz * rdz) || 1, a0 = Math.atan2(rdz, rdx), a = a0 + t * sp; pos = [c[0] + r * Math.cos(a), pos[1], c[2] + r * Math.sin(a)]; break; }
      case 'oscillate': pos[1] += Math.sin(t * sp) * ((m.params && m.params.amplitude) || 1); break;
      case 'float': pos[1] += Math.sin(t * sp) * 0.3; break;
      case 'pulse': scale = 1 + Math.sin(t * sp) * 0.15; break;
      case 'grow': scale = 0.2 + easeInOut(Math.min(1, t * sp * 0.25)) * 0.8; break;
      case 'flow': case 'fall': if (node.path && node.path.length) { var idx = Math.floor((t * sp * 0.15) % 1 * (node.path.length - 1)); pos = node.path[Math.max(0, Math.min(node.path.length - 1, idx))].slice(); } break;
    }
    return { position: pos, rotation: rot, scale: scale };
  }

  // ---- LITE renderer: draw the SAME spec in 2D SVG (no WebGL). DOM-guarded. ----
  function renderSVG2D(container, spec, tier, t) {
    var model = spec && spec.nodes ? spec : buildModel(spec);
    if (typeof document === 'undefined' || !container) return { renderer: 'svg2d', nodes: model.nodes.length };
    var W = 320, H = 200, cx = W / 2, cy = H * 0.62, scale = (W * 0.32) / (model.camera.distance || 12) * 3;
    var svg = container.querySelector('svg[data-scene]');
    if (!svg) { svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('data-scene', '1'); svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.style.width = '100%'; svg.style.height = 'auto'; container.appendChild(svg); }
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var time = t || 0;
    // faint ground line for depth
    var ground = el('line', { x1: 0, y1: cy, x2: W, y2: cy, stroke: '#e6e1d6', 'stroke-width': 1 }); svg.appendChild(ground);
    model.nodes.forEach(function (n) {
      var mo = motionAt(n, time), P = mo.position, sx = cx + P[0] * scale, sy = cy - P[1] * scale;
      var op = (n.material && n.material.opacity != null) ? n.material.opacity : 1, sz = (typeof n.size === 'number' ? n.size : 1) * mo.scale;
      if (n.path && n.path.length) { var d = n.path.map(function (p, i) { return (i ? 'L' : 'M') + (cx + p[0] * scale) + ' ' + (cy - p[1] * scale); }).join(' '); svg.appendChild(el('path', { d: d, fill: 'none', stroke: n.color, 'stroke-width': 1.5, opacity: 0.5 })); }
      if (n.type === 'label') { svg.appendChild(txt(sx, sy, n.text || '', n.color)); return; }
      if (n.type === 'line' && n.points && n.points.length > 1) { var dl = n.points.map(function (p, i) { return (i ? 'L' : 'M') + (cx + p[0] * scale) + ' ' + (cy - p[1] * scale); }).join(' '); svg.appendChild(el('path', { d: dl, fill: 'none', stroke: n.color, 'stroke-width': 2, opacity: op })); return; }
      if (n.type === 'box' || n.type === 'plane') { svg.appendChild(el('rect', { x: sx - sz * 6, y: sy - sz * 6, width: sz * 12, height: sz * 12, fill: n.color, opacity: op, rx: 2 })); return; }
      if (n.type === 'particles') { for (var i = 0; i < Math.min(24, n.count || 12); i++) { var an = (i / 12) * TAU; svg.appendChild(el('circle', { cx: sx + Math.cos(an) * sz * 8, cy: sy + Math.sin(an) * sz * 6, r: 1.2, fill: n.color, opacity: op })); } return; }
      svg.appendChild(el('circle', { cx: sx, cy: sy, r: Math.max(2, sz * 6), fill: n.color, opacity: op }));   // sphere/cylinder/cone/torus/ring/arrow/physics body
    });
    if (model.title) svg.appendChild(txt(8, 16, model.title, '#8a8378', 'start'));
    return { renderer: 'svg2d', nodes: model.nodes.length };
    function el(name, attrs) { var e = document.createElementNS('http://www.w3.org/2000/svg', name); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }
    function txt(x, y, s, color, anchor) { var e = el('text', { x: x, y: y, fill: color || '#1a1712', 'font-size': 9, 'font-family': 'Inter Tight, sans-serif', 'text-anchor': anchor || 'middle' }); e.textContent = s; return e; }
  }

  // ---- top-level dispatch: pick the renderer by tier. WebGL hook is optional (lite never calls it). ----
  function render(container, spec, tier, opts) {
    var model = buildModel(spec);
    if (usesWebGL(tier) && typeof window !== 'undefined' && window.AquinSceneGL && typeof document !== 'undefined' && container) {
      window.AquinSceneGL.render(container, model, { tier: tier, quality: tierQuality(tier), palette: model.palette });
      return { renderer: 'webgl', nodes: model.nodes.length };
    }
    return renderSVG2D(container, model, tier, opts && opts.t);   // lite, or WebGL adapter not loaded yet
  }

  var api = {
    version: 1, PRIMITIVES: PRIMITIVES, MOTIONS: MOTIONS, PHYSICS: PHYSICS,
    primitives: function () { return Object.keys(PRIMITIVES).map(function (k) { return { type: k, kind: PRIMITIVES[k].kind, params: PRIMITIVES[k].params }; }); },
    motions: function () { return MOTIONS.slice(); },
    trajectory: trajectory, buildModel: buildModel, motionAt: motionAt,
    rendererFor: rendererFor, usesWebGL: usesWebGL, tierQuality: tierQuality,
    renderSVG2D: renderSVG2D, render: render,
  };
  if (typeof window !== 'undefined') window.AquinScene = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
