/* AquinTutor Animator Engine — shared, reusable, real-time procedural animation
   library. Pure canvas 2D, zero dependencies, ~16 scenes spanning fractals,
   dynamics, physics, biology, astronomy, geometry. Powers:
     - /aquintutor/labs/animator.astro (the full Animation Studio)
     - the Aquin Co-pilot "type a topic, watch it teach it" live demo
     - embedded animation panels inside real lesson pages
   One engine, three surfaces — so a fix or a new scene reaches everywhere.

   API:
     AquinAnimator.SCENES            -> array of scene definitions
     AquinAnimator.findScene(text)   -> best-matching scene for free-text topic,
                                          or null if nothing scores above threshold
     AquinAnimator.attach(canvas, scene, opts) -> controller
        opts: { palette?: string, speed?: number, params?: object }
        controller: { play(), pause(), setParam(id, value), setPalette(name),
                       setSpeed(n), destroy(), scene }
*/
(function (global) {
  'use strict';

  // ============ PALETTES ============
  var palettes = {
    cosmic: ['#0a0a3a', '#1d2671', '#5b4a92', '#a78bfa', '#67e8f9', '#86efac', '#fbbf24', '#fb923c'],
    warm:   ['#1a0a00', '#451a03', '#7c2d12', '#c2410c', '#fb923c', '#fde047', '#f0fdfa', '#fff7ed'],
    cool:   ['#04161b', '#0c4a6e', '#0369a1', '#0ea5e9', '#67e8f9', '#a78bfa', '#e0e7ff', '#fff'],
    fire:   ['#000', '#7f1d1d', '#dc2626', '#f97316', '#facc15', '#fde047', '#fff', '#fff'],
    forest: ['#022c22', '#064e3b', '#065f46', '#10b981', '#86efac', '#fef9c3', '#fff7ed', '#fff'],
    mono:   ['#000', '#262626', '#525252', '#a3a3a3', '#d4d4d4', '#f5f5f5', '#fff', '#fff'],
  };
  function hex2rgb(h) { var n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function makePalHelpers(paletteName) {
    function pal(i) { var p = palettes[paletteName] || palettes.cosmic; return p[Math.abs(Math.floor(i)) % p.length]; }
    function palLerp(t) {
      var p = palettes[paletteName] || palettes.cosmic;
      t = Math.max(0, Math.min(0.999, t));
      var pos = t * (p.length - 1);
      var i = Math.floor(pos), f = pos - i;
      var a = hex2rgb(p[i]), b = hex2rgb(p[i + 1] || p[i]);
      return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * f) + ',' + Math.round(a[1] + (b[1] - a[1]) * f) + ',' + Math.round(a[2] + (b[2] - a[2]) * f) + ')';
    }
    return { pal: pal, palLerp: palLerp };
  }

  // ============ SCENES ============
  // Each scene: { id, label, cat, keywords: [free-text topic hints for intent
  // matching], controls: [{id,label,min,max,step,value}], draw(ctx,t,p,w,h,helpers) }
  var SCENES = [
    {
      id: 'mandelbrot', label: 'Mandelbrot zoom', cat: 'Fractals',
      keywords: ['mandelbrot', 'fractal', 'complex plane', 'iteration', 'zoom fractal'],
      controls: [
        { id: 'iter', label: 'Max iterations', min: 50, max: 400, step: 10, value: 180 },
        { id: 'zoom', label: 'Zoom speed', min: 0, max: 0.5, step: 0.01, value: 0.12 },
        { id: 'cx', label: 'Center X', min: -2, max: 1, step: 0.001, value: -0.7435 },
        { id: 'cy', label: 'Center Y', min: -1.5, max: 1.5, step: 0.001, value: 0.1314 },
      ],
      draw: function (ctx, t, p, w, h, H) {
        var scale = 3 / Math.exp(t * p.zoom);
        var img = ctx.createImageData(w, h);
        for (var py = 0; py < h; py++) {
          for (var px = 0; px < w; px++) {
            var x0 = p.cx + (px - w / 2) / w * scale;
            var y0 = p.cy + (py - h / 2) / h * scale;
            var x = 0, y = 0, n = 0;
            while (x * x + y * y < 4 && n < p.iter) { var xt = x * x - y * y + x0; y = 2 * x * y + y0; x = xt; n++; }
            var idx = (py * w + px) * 4;
            if (n === p.iter) { img.data[idx] = 0; img.data[idx + 1] = 0; img.data[idx + 2] = 0; img.data[idx + 3] = 255; }
            else {
              var sm = n + 1 - Math.log(Math.log(Math.sqrt(x * x + y * y))) / Math.log(2);
              var rgb = H.palLerp((sm % 60) / 60).match(/\d+/g);
              img.data[idx] = +rgb[0]; img.data[idx + 1] = +rgb[1]; img.data[idx + 2] = +rgb[2]; img.data[idx + 3] = 255;
            }
          }
        }
        ctx.putImageData(img, 0, 0);
      },
    },
    {
      id: 'julia', label: 'Julia set', cat: 'Fractals',
      keywords: ['julia set', 'julia fractal'],
      controls: [
        { id: 'iter', label: 'Max iterations', min: 50, max: 250, step: 10, value: 150 },
        { id: 'rot', label: 'Rotation speed', min: 0, max: 0.3, step: 0.01, value: 0.05 },
        { id: 'r', label: 'Radius', min: 0.5, max: 0.85, step: 0.01, value: 0.7885 },
      ],
      draw: function (ctx, t, p, w, h, H) {
        var cx = p.r * Math.cos(t * p.rot), cy = p.r * Math.sin(t * p.rot);
        var img = ctx.createImageData(w, h), scale = 3;
        for (var py = 0; py < h; py++) {
          for (var px = 0; px < w; px++) {
            var x = (px - w / 2) / w * scale, y = (py - h / 2) / h * scale, n = 0;
            while (x * x + y * y < 4 && n < p.iter) { var xt = x * x - y * y + cx; y = 2 * x * y + cy; x = xt; n++; }
            var idx = (py * w + px) * 4;
            if (n === p.iter) { img.data[idx] = 0; img.data[idx + 1] = 0; img.data[idx + 2] = 0; img.data[idx + 3] = 255; }
            else { var rgb = H.palLerp((n * 4) / p.iter).match(/\d+/g); img.data[idx] = +rgb[0]; img.data[idx + 1] = +rgb[1]; img.data[idx + 2] = +rgb[2]; img.data[idx + 3] = 255; }
          }
        }
        ctx.putImageData(img, 0, 0);
      },
    },
    {
      id: 'lorenz', label: 'Lorenz attractor', cat: 'Dynamics',
      keywords: ['lorenz attractor', 'chaos theory', 'strange attractor', 'butterfly effect', 'chaotic system'],
      controls: [
        { id: 'sigma', label: 'sigma', min: 5, max: 20, step: 0.1, value: 10 },
        { id: 'rho', label: 'rho', min: 20, max: 50, step: 0.1, value: 28 },
        { id: 'beta', label: 'beta', min: 1, max: 5, step: 0.1, value: 8 / 3 },
        { id: 'rotY', label: 'Rotation Y', min: 0, max: 1, step: 0.01, value: 0.2 },
      ],
      state: null,
      draw: function (ctx, t, p, w, h, H) {
        if (!this.state || this.state._reset) this.state = { points: [[0.1, 0, 0]], _reset: false };
        var dt = 0.005, steps = 20, last = this.state.points[this.state.points.length - 1];
        for (var i = 0; i < steps; i++) {
          var x = last[0], y = last[1], z = last[2];
          var dx = p.sigma * (y - x), dy = x * (p.rho - z) - y, dz = x * y - p.beta * z;
          last = [x + dx * dt, y + dy * dt, z + dz * dt];
          this.state.points.push(last);
        }
        if (this.state.points.length > 8000) this.state.points = this.state.points.slice(-8000);
        ctx.fillStyle = 'rgba(0,0,0,0.08)'; ctx.fillRect(0, 0, w, h);
        var cy = Math.cos(t * p.rotY), sy = Math.sin(t * p.rotY), cx = Math.cos(0.3), sx = Math.sin(0.3);
        ctx.beginPath();
        for (var j = 1; j < this.state.points.length; j++) {
          var pt = this.state.points[j], px = pt[0], py = pt[1] - 25, pz = pt[2];
          var x1 = px * cy - pz * sy, z1 = px * sy + pz * cy, y1 = py * cx - z1 * sx, scale = 8;
          var sx2 = w / 2 + x1 * scale, sy2 = h / 2 + y1 * scale;
          if (j === 1) ctx.moveTo(sx2, sy2); else ctx.lineTo(sx2, sy2);
        }
        ctx.strokeStyle = H.palLerp(0.6); ctx.lineWidth = 0.7; ctx.stroke();
      },
    },
    {
      id: 'waves', label: 'Wave interference', cat: 'Physics',
      keywords: ['wave interference', 'interference pattern', 'huygens', 'superposition', 'constructive interference', 'destructive interference', 'ripple tank'],
      controls: [
        { id: 'src1', label: 'Source 1 frequency', min: 0.1, max: 2, step: 0.05, value: 0.8 },
        { id: 'src2', label: 'Source 2 frequency', min: 0.1, max: 2, step: 0.05, value: 0.7 },
        { id: 'k', label: 'Wave number', min: 0.05, max: 0.3, step: 0.01, value: 0.15 },
      ],
      draw: function (ctx, t, p, w, h, H) {
        var img = ctx.createImageData(w, h);
        var s1x = w * 0.3, s1y = h * 0.4, s2x = w * 0.7, s2y = h * 0.6;
        for (var py = 0; py < h; py += 2) {
          for (var px = 0; px < w; px += 2) {
            var d1 = Math.hypot(px - s1x, py - s1y), d2 = Math.hypot(px - s2x, py - s2y);
            var v = Math.sin(d1 * p.k - t * p.src1) + Math.sin(d2 * p.k - t * p.src2);
            var rgb = H.palLerp((v + 2) / 4).match(/\d+/g);
            for (var dy = 0; dy < 2; dy++) for (var dx = 0; dx < 2; dx++) {
              var idx = ((py + dy) * w + (px + dx)) * 4;
              img.data[idx] = +rgb[0]; img.data[idx + 1] = +rgb[1]; img.data[idx + 2] = +rgb[2]; img.data[idx + 3] = 255;
            }
          }
        }
        ctx.putImageData(img, 0, 0);
      },
    },
    {
      id: 'particles', label: 'Particle field', cat: 'Particles',
      keywords: ['particle field', 'curl noise', 'flow field', 'brownian motion'],
      controls: [
        { id: 'count', label: 'Particles', min: 50, max: 800, step: 10, value: 250 },
        { id: 'speed', label: 'Speed', min: 0.1, max: 5, step: 0.1, value: 1.5 },
        { id: 'noise', label: 'Curl noise', min: 0, max: 0.05, step: 0.001, value: 0.012 },
      ],
      state: null,
      draw: function (ctx, t, p, w, h, H) {
        if (!this.state || this.state.particles.length !== Math.floor(p.count) || this.state._reset) {
          var parts = [];
          for (var i = 0; i < Math.floor(p.count); i++) parts.push({ x: Math.random() * w, y: Math.random() * h, vx: 0, vy: 0, hue: Math.random() });
          this.state = { particles: parts, _reset: false };
        }
        ctx.fillStyle = 'rgba(0,0,0,0.05)'; ctx.fillRect(0, 0, w, h);
        this.state.particles.forEach(function (q) {
          var nx = Math.sin(q.x * p.noise + t * 0.5) + Math.cos(q.y * p.noise + t * 0.3);
          var ny = Math.cos(q.x * p.noise + t * 0.5) - Math.sin(q.y * p.noise + t * 0.3);
          q.vx = q.vx * 0.92 + nx * p.speed; q.vy = q.vy * 0.92 + ny * p.speed;
          q.x += q.vx; q.y += q.vy;
          if (q.x < 0) q.x += w; if (q.x > w) q.x -= w; if (q.y < 0) q.y += h; if (q.y > h) q.y -= h;
          ctx.fillStyle = H.palLerp(q.hue); ctx.fillRect(q.x, q.y, 1.5, 1.5);
        });
      },
    },
    {
      id: 'gol', label: 'Game of Life', cat: 'Cellular',
      keywords: ['game of life', 'cellular automaton', 'conway'],
      controls: [
        { id: 'cellSize', label: 'Cell size', min: 4, max: 20, step: 1, value: 8 },
        { id: 'speed', label: 'Update rate', min: 1, max: 30, step: 1, value: 6 },
      ],
      state: null,
      draw: function (ctx, t, p, w, h, H) {
        var cs = p.cellSize, cols = Math.floor(w / cs), rows = Math.floor(h / cs);
        if (!this.state || this.state.cols !== cols || this.state._reset) {
          var grid = [];
          for (var i = 0; i < rows; i++) { grid.push([]); for (var j = 0; j < cols; j++) grid[i].push(Math.random() < 0.25 ? 1 : 0); }
          this.state = { grid: grid, cols: cols, rows: rows, lastT: t, _reset: false };
        }
        if (t - this.state.lastT > 1 / p.speed) {
          var g = this.state.grid, ng = [];
          for (var i2 = 0; i2 < rows; i2++) {
            ng.push([]);
            for (var j2 = 0; j2 < cols; j2++) {
              var n = 0;
              for (var di = -1; di <= 1; di++) for (var dj = -1; dj <= 1; dj++) { if (di === 0 && dj === 0) continue; var ni = (i2 + di + rows) % rows, nj = (j2 + dj + cols) % cols; n += g[ni][nj]; }
              ng[i2].push(g[i2][j2] === 1 ? (n === 2 || n === 3 ? 1 : 0) : (n === 3 ? 1 : 0));
            }
          }
          this.state.grid = ng; this.state.lastT = t;
        }
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = H.palLerp(0.6);
        for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) if (this.state.grid[r][c]) ctx.fillRect(c * cs, r * cs, cs - 1, cs - 1);
      },
    },
    {
      id: 'tree', label: 'Fractal tree', cat: 'Fractals',
      keywords: ['fractal tree', 'l-system', 'branching pattern', 'recursive tree'],
      controls: [
        { id: 'depth', label: 'Depth', min: 4, max: 12, step: 1, value: 10 },
        { id: 'angle', label: 'Branch angle', min: 10, max: 45, step: 1, value: 25 },
        { id: 'sway', label: 'Wind sway', min: 0, max: 0.5, step: 0.01, value: 0.15 },
        { id: 'len', label: 'Trunk length', min: 80, max: 200, step: 5, value: 130 },
      ],
      draw: function (ctx, t, p, w, h, H) {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
        function branch(x, y, len, ang, d) {
          if (d <= 0 || len < 1) return;
          var x2 = x + Math.cos(ang) * len, y2 = y + Math.sin(ang) * len;
          ctx.strokeStyle = H.palLerp(1 - d / p.depth); ctx.lineWidth = Math.max(0.5, d / 3);
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke();
          var sw = Math.sin(t * 0.6 + d) * p.sway;
          branch(x2, y2, len * 0.7, ang - p.angle * Math.PI / 180 + sw, d - 1);
          branch(x2, y2, len * 0.7, ang + p.angle * Math.PI / 180 + sw, d - 1);
        }
        branch(w / 2, h - 20, p.len, -Math.PI / 2, Math.floor(p.depth));
      },
    },
    {
      id: 'wavepkt', label: 'Wave packet', cat: 'Quantum',
      keywords: ['wave packet', 'schrodinger', 'quantum mechanics', 'wavefunction', 'probability density'],
      controls: [
        { id: 'k', label: 'Momentum k', min: -10, max: 10, step: 0.5, value: 4 },
        { id: 'sigma', label: 'Width sigma', min: 0.05, max: 0.3, step: 0.01, value: 0.1 },
      ],
      draw: function (ctx, t, p, w, h, H) {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
        var midY = h / 2;
        ctx.strokeStyle = '#2a2a35'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(w, midY); ctx.stroke();
        var x0 = 0.5 + 0.3 * Math.sin(t * 0.3);
        for (var i = 0; i < w; i++) {
          var x = i / w, arg = -((x - x0) * (x - x0)) / (2 * p.sigma * p.sigma), env = Math.exp(arg), phase = p.k * x * 10 - t * 2;
          var re = env * Math.cos(phase), im = env * Math.sin(phase), prob = re * re + im * im;
          ctx.fillStyle = H.pal(0); ctx.fillRect(i, midY - re * 180, 1, 1);
          ctx.fillStyle = H.pal(2); ctx.fillRect(i, midY - im * 180, 1, 1);
          ctx.fillStyle = H.palLerp(prob); ctx.fillRect(i, midY + prob * 150, 1, 2);
        }
      },
    },
    {
      id: 'vector', label: 'Vector field', cat: 'Physics',
      keywords: ['vector field', 'flow visualization', 'gradient field', 'divergence', 'curl'],
      controls: [
        { id: 'mode', label: 'Field type', min: 0, max: 3, step: 1, value: 0 },
        { id: 'density', label: 'Arrow density', min: 10, max: 50, step: 2, value: 24 },
      ],
      draw: function (ctx, t, p, w, h, H) {
        ctx.fillStyle = '#0a0a0c'; ctx.fillRect(0, 0, w, h);
        var d = Math.floor(p.density), step = Math.min(w, h) / d;
        for (var iy = 0; iy < d; iy++) {
          for (var ix = 0; ix < d * w / h; ix++) {
            var x = (ix + 0.5) * step, y = (iy + 0.5) * step, nx = x / w - 0.5, ny = y / h - 0.5, vx, vy;
            if (p.mode === 0) { vx = Math.sin(ny * 8 + t); vy = Math.cos(nx * 8 + t); }
            else if (p.mode === 1) { vx = -ny + Math.sin(t * 0.3) * 0.2; vy = nx; }
            else if (p.mode === 2) { var r = Math.hypot(nx, ny); vx = nx / r * Math.sin(t); vy = ny / r * Math.sin(t); }
            else { vx = Math.sin(t + nx * 4); vy = Math.cos(t + ny * 4); }
            var len = Math.hypot(vx, vy), ang = Math.atan2(vy, vx), L = step * 0.45 * Math.min(1, len);
            ctx.strokeStyle = H.palLerp(0.3 + 0.5 * len); ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(x - Math.cos(ang) * L / 2, y - Math.sin(ang) * L / 2); ctx.lineTo(x + Math.cos(ang) * L / 2, y + Math.sin(ang) * L / 2); ctx.stroke();
          }
        }
      },
    },
    {
      id: 'turing', label: 'Turing patterns', cat: 'Biology',
      keywords: ['turing pattern', 'reaction diffusion', 'morphogenesis', 'animal coat pattern'],
      controls: [
        { id: 'feed', label: 'Feed rate', min: 0.01, max: 0.08, step: 0.001, value: 0.045 },
        { id: 'kill', label: 'Kill rate', min: 0.04, max: 0.07, step: 0.001, value: 0.062 },
      ],
      state: null,
      draw: function (ctx, t, p, w, h, H) {
        var gw = 200, gh = Math.floor(gw * h / w);
        if (!this.state || this.state.gw !== gw || this.state._reset) {
          var a = new Float32Array(gw * gh), b = new Float32Array(gw * gh);
          for (var i = 0; i < gw * gh; i++) a[i] = 1;
          for (var iy0 = gh / 2 - 5; iy0 < gh / 2 + 5; iy0++) for (var ix0 = gw / 2 - 5; ix0 < gw / 2 + 5; ix0++) b[Math.floor(iy0) * gw + Math.floor(ix0)] = 1;
          this.state = { a: a, b: b, gw: gw, gh: gh, _reset: false };
        }
        var dA = 1.0, dB = 0.5, iters = 8;
        for (var it = 0; it < iters; it++) {
          var na = new Float32Array(gw * gh), nb = new Float32Array(gw * gh);
          for (var iy = 1; iy < gh - 1; iy++) {
            for (var ix = 1; ix < gw - 1; ix++) {
              var idx = iy * gw + ix;
              var la = -this.state.a[idx] + 0.2 * (this.state.a[idx - 1] + this.state.a[idx + 1] + this.state.a[idx - gw] + this.state.a[idx + gw]) + 0.05 * (this.state.a[idx - gw - 1] + this.state.a[idx - gw + 1] + this.state.a[idx + gw - 1] + this.state.a[idx + gw + 1]);
              var lb = -this.state.b[idx] + 0.2 * (this.state.b[idx - 1] + this.state.b[idx + 1] + this.state.b[idx - gw] + this.state.b[idx + gw]) + 0.05 * (this.state.b[idx - gw - 1] + this.state.b[idx - gw + 1] + this.state.b[idx + gw - 1] + this.state.b[idx + gw + 1]);
              var ab2 = this.state.a[idx] * this.state.b[idx] * this.state.b[idx];
              na[idx] = this.state.a[idx] + dA * la - ab2 + p.feed * (1 - this.state.a[idx]);
              nb[idx] = this.state.b[idx] + dB * lb + ab2 - (p.kill + p.feed) * this.state.b[idx];
            }
          }
          this.state.a = na; this.state.b = nb;
        }
        var img = ctx.createImageData(w, h);
        for (var py = 0; py < h; py++) {
          for (var px = 0; px < w; px++) {
            var sx = Math.floor(px / w * gw), sy = Math.floor(py / h * gh);
            var v = this.state.a[sy * gw + sx] - this.state.b[sy * gw + sx];
            var rgb = H.palLerp((v + 1) / 2).match(/\d+/g), idx2 = (py * w + px) * 4;
            img.data[idx2] = +rgb[0]; img.data[idx2 + 1] = +rgb[1]; img.data[idx2 + 2] = +rgb[2]; img.data[idx2 + 3] = 255;
          }
        }
        ctx.putImageData(img, 0, 0);
      },
    },
    {
      id: 'galaxy', label: 'Spiral galaxy', cat: 'Astronomy',
      keywords: ['spiral galaxy', 'galaxy formation', 'astronomy', 'star field'],
      controls: [
        { id: 'stars', label: 'Star count', min: 200, max: 4000, step: 100, value: 1500 },
        { id: 'arms', label: 'Arm count', min: 2, max: 6, step: 1, value: 3 },
        { id: 'wind', label: 'Spiral wind', min: 0.5, max: 5, step: 0.1, value: 2.2 },
        { id: 'rotSpeed', label: 'Rotation speed', min: 0, max: 1, step: 0.01, value: 0.2 },
      ],
      state: null,
      draw: function (ctx, t, p, w, h, H) {
        var n = Math.floor(p.stars);
        if (!this.state || this.state.stars.length !== n || this.state._reset) {
          var stars = [];
          for (var i = 0; i < n; i++) {
            var r = Math.pow(Math.random(), 1.4) * Math.min(w, h) * 0.45;
            var armBase = Math.floor(Math.random() * p.arms) * (Math.PI * 2 / p.arms);
            var jitter = (Math.random() - 0.5) * 0.5;
            stars.push({ r: r, theta: armBase + r * 0.01 * p.wind + jitter, brightness: Math.random() });
          }
          this.state = { stars: stars, _reset: false };
        }
        ctx.fillStyle = 'rgba(0,0,0,0.15)'; ctx.fillRect(0, 0, w, h);
        var rot = t * p.rotSpeed; ctx.translate(w / 2, h / 2);
        this.state.stars.forEach(function (s) {
          var ang = s.theta + rot * (1 - s.r / (Math.min(w, h) * 0.5)) * 0.5;
          var x = s.r * Math.cos(ang), y = s.r * Math.sin(ang), sz = 0.5 + s.brightness * 1.5;
          ctx.fillStyle = H.palLerp(s.brightness); ctx.globalAlpha = 0.4 + s.brightness * 0.6; ctx.fillRect(x, y, sz, sz);
        });
        ctx.globalAlpha = 1; ctx.setTransform(1, 0, 0, 1, 0, 0);
      },
    },
    {
      id: 'pendcascade', label: 'Pendulum cascade', cat: 'Physics',
      keywords: ['pendulum wave', 'pendulum cascade', 'harmonic motion', 'resonance'],
      controls: [
        { id: 'count', label: 'Pendulum count', min: 8, max: 32, step: 1, value: 16 },
        { id: 'g', label: 'Gravity', min: 5, max: 20, step: 0.5, value: 9.81 },
      ],
      draw: function (ctx, t, p, w, h, H) {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
        var n = Math.floor(p.count), spacing = w / (n + 2), pivotY = 60, maxLen = h * 0.7;
        for (var i = 0; i < n; i++) {
          var L = maxLen / (1 + i * 0.08), omega = Math.sqrt(p.g / L), theta = (Math.PI / 6) * Math.cos(omega * t);
          var x = (i + 1.5) * spacing, bx = x + L * Math.sin(theta), by = pivotY + L * Math.cos(theta);
          ctx.strokeStyle = H.palLerp(i / n); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x, pivotY); ctx.lineTo(bx, by); ctx.stroke();
          ctx.fillStyle = H.palLerp(i / n); ctx.beginPath(); ctx.arc(bx, by, 5 + i * 0.3, 0, Math.PI * 2); ctx.fill();
        }
      },
    },
    {
      id: 'phyllotaxis', label: 'Phyllotaxis', cat: 'Biology',
      keywords: ['phyllotaxis', 'sunflower spiral', 'golden angle', 'fibonacci spiral'],
      controls: [
        { id: 'angle', label: 'Divergence angle', min: 100, max: 200, step: 0.1, value: 137.5 },
        { id: 'count', label: 'Dot count', min: 100, max: 3000, step: 50, value: 1200 },
        { id: 'growth', label: 'Growth speed', min: 0, max: 1, step: 0.01, value: 0.3 },
      ],
      draw: function (ctx, t, p, w, h, H) {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
        var n = Math.floor(p.count), phi = p.angle * Math.PI / 180, maxN = Math.min(n, Math.floor(t * p.growth * 200) + 50);
        ctx.translate(w / 2, h / 2);
        for (var i = 0; i < maxN; i++) {
          var r = Math.sqrt(i) * 6; if (r > Math.min(w, h) / 2 - 10) break;
          var a = i * phi, x = r * Math.cos(a), y = r * Math.sin(a);
          ctx.fillStyle = H.palLerp((i % 100) / 100); ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      },
    },
    {
      id: 'dblpend', label: 'Double pendulum', cat: 'Physics',
      keywords: ['double pendulum', 'chaotic pendulum', 'sensitive dependence'],
      controls: [
        { id: 'm1', label: 'Mass 1', min: 0.5, max: 3, step: 0.1, value: 1 },
        { id: 'm2', label: 'Mass 2', min: 0.5, max: 3, step: 0.1, value: 1 },
        { id: 'L1', label: 'Length 1', min: 50, max: 200, step: 5, value: 150 },
        { id: 'L2', label: 'Length 2', min: 50, max: 200, step: 5, value: 150 },
      ],
      state: null,
      draw: function (ctx, t, p, w, h, H) {
        if (!this.state || this.state._reset) this.state = { th1: Math.PI * 0.8, th2: Math.PI * 0.6, w1: 0, w2: 0, trail: [], _reset: false };
        var dt = 0.01, g = 9.81, m1 = p.m1, m2 = p.m2, L1 = p.L1 / 30, L2 = p.L2 / 30;
        for (var step = 0; step < 4; step++) {
          var th1 = this.state.th1, th2 = this.state.th2, w1 = this.state.w1, w2 = this.state.w2;
          var num1 = -g * (2 * m1 + m2) * Math.sin(th1) - m2 * g * Math.sin(th1 - 2 * th2) - 2 * Math.sin(th1 - th2) * m2 * (w2 * w2 * L2 + w1 * w1 * L1 * Math.cos(th1 - th2));
          var den1 = L1 * (2 * m1 + m2 - m2 * Math.cos(2 * th1 - 2 * th2)), a1 = num1 / den1;
          var num2 = 2 * Math.sin(th1 - th2) * (w1 * w1 * L1 * (m1 + m2) + g * (m1 + m2) * Math.cos(th1) + w2 * w2 * L2 * m2 * Math.cos(th1 - th2));
          var den2 = L2 * (2 * m1 + m2 - m2 * Math.cos(2 * th1 - 2 * th2)), a2 = num2 / den2;
          this.state.w1 += a1 * dt; this.state.w2 += a2 * dt; this.state.th1 += this.state.w1 * dt; this.state.th2 += this.state.w2 * dt;
        }
        var cx = w / 2, cy = h / 3;
        var x1 = cx + p.L1 * Math.sin(this.state.th1), y1 = cy + p.L1 * Math.cos(this.state.th1);
        var x2 = x1 + p.L2 * Math.sin(this.state.th2), y2 = y1 + p.L2 * Math.cos(this.state.th2);
        this.state.trail.push([x2, y2]); if (this.state.trail.length > 400) this.state.trail.shift();
        ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = H.palLerp(0.5); ctx.lineWidth = 1.5; ctx.beginPath();
        this.state.trail.forEach(function (pt, i) { if (i === 0) ctx.moveTo(pt[0], pt[1]); else ctx.lineTo(pt[0], pt[1]); }); ctx.stroke();
        ctx.strokeStyle = '#cfd6da'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        ctx.fillStyle = '#fbbf24'; ctx.beginPath(); ctx.arc(x1, y1, 6 + p.m1 * 2, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = H.palLerp(0.9); ctx.beginPath(); ctx.arc(x2, y2, 6 + p.m2 * 2, 0, Math.PI * 2); ctx.fill();
      },
    },
    {
      id: 'mobius', label: 'Mobius strip', cat: 'Geometry',
      keywords: ['mobius strip', 'klein bottle', 'non-orientable surface', 'topology'],
      controls: [
        { id: 'rotY', label: 'Rotation Y', min: 0, max: 2, step: 0.01, value: 0.5 },
        { id: 'twist', label: 'Twist count', min: 1, max: 5, step: 1, value: 1 },
      ],
      draw: function (ctx, t, p, w, h, H) {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
        var R = Math.min(w, h) * 0.32, rotY = t * p.rotY, cy = Math.cos(rotY), sy = Math.sin(rotY), cx = Math.cos(0.4), sx = Math.sin(0.4);
        var triangles = [], Nu = 80, Nv = 12;
        for (var ui = 0; ui < Nu; ui++) {
          for (var vi = 0; vi < Nv; vi++) {
            var u = ui / Nu * Math.PI * 2, u2 = (ui + 1) / Nu * Math.PI * 2, v = (vi / Nv - 0.5) * 80, v2 = ((vi + 1) / Nv - 0.5) * 80;
            var corners = [[u, v], [u2, v], [u2, v2], [u, v2]].map(function (q) {
              var th = q[0] * p.twist / 2, x = (R + q[1] * Math.cos(th)) * Math.cos(q[0]), y = (R + q[1] * Math.cos(th)) * Math.sin(q[0]), z = q[1] * Math.sin(th);
              var x1 = x * cy - z * sy, z1 = x * sy + z * cy, y1 = y * cx - z1 * sx;
              return { x: x1, y: y1, z: x * sy + z * cy, u: q[0] };
            });
            triangles.push({ z: (corners[0].z + corners[1].z + corners[2].z + corners[3].z) / 4, c: corners });
          }
        }
        triangles.sort(function (a, b) { return a.z - b.z; });
        triangles.forEach(function (tr) {
          ctx.fillStyle = H.palLerp((tr.c[0].u + Math.PI) / (Math.PI * 2));
          ctx.beginPath();
          ctx.moveTo(w / 2 + tr.c[0].x, h / 2 + tr.c[0].y); ctx.lineTo(w / 2 + tr.c[1].x, h / 2 + tr.c[1].y);
          ctx.lineTo(w / 2 + tr.c[2].x, h / 2 + tr.c[2].y); ctx.lineTo(w / 2 + tr.c[3].x, h / 2 + tr.c[3].y);
          ctx.closePath(); ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.stroke();
        });
      },
    },
  ];

  // ============ INTENT MATCHING ============
  // Free-text topic -> best scene. Scores each scene by keyword substring hits
  // (longer keyword matches score higher) plus a fallback on the scene id/label
  // itself, so "show me chaos" -> Lorenz attractor or double pendulum (whichever
  // keyword is more specific), "sunflower pattern" -> Phyllotaxis, etc.
  function findScene(query) {
    var q = (query || '').toLowerCase().trim();
    if (!q) return null;
    var best = null, bestScore = 0;
    SCENES.forEach(function (s) {
      var score = 0;
      (s.keywords || []).forEach(function (kw) {
        if (q.indexOf(kw) !== -1) score = Math.max(score, kw.length);
        else {
          // partial word-overlap credit
          var words = kw.split(' ');
          var hits = words.filter(function (w) { return w.length > 3 && q.indexOf(w) !== -1; }).length;
          if (hits) score = Math.max(score, hits * 4);
        }
      });
      if (q.indexOf(s.id) !== -1 || q.indexOf(s.label.toLowerCase()) !== -1) score = Math.max(score, 20);
      if (score > bestScore) { bestScore = score; best = s; }
    });
    return bestScore >= 4 ? best : null;
  }

  // ============ ENGINE: attach a scene to a canvas ============
  function attach(canvas, scene, opts) {
    opts = opts || {};
    var ctx = canvas.getContext('2d');
    var paletteName = opts.palette || 'cosmic';
    var H = makePalHelpers(paletteName);
    var params = {};
    (scene.controls || []).forEach(function (c) { params[c.id] = (opts.params && opts.params[c.id] != null) ? opts.params[c.id] : c.value; });
    var t = 0, lastFrame = 0, speed = opts.speed || 1, playing = true, raf = null;
    if (scene.state) scene.state = null; // fresh instance per attach

    function frame(ts) {
      var dt = lastFrame ? (ts - lastFrame) / 1000 : 0.016;
      lastFrame = ts;
      if (playing) t += dt * speed;
      try { scene.draw(ctx, t, params, canvas.width, canvas.height, H); }
      catch (e) { ctx.fillStyle = '#f87171'; ctx.font = '13px monospace'; ctx.fillText('Scene error: ' + e.message, 10, 20); }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return {
      scene: scene,
      play: function () { playing = true; },
      pause: function () { playing = false; },
      setParam: function (id, value) { params[id] = value; },
      setPalette: function (name) { paletteName = name; H = makePalHelpers(paletteName); },
      setSpeed: function (n) { speed = n; },
      destroy: function () { if (raf) cancelAnimationFrame(raf); },
    };
  }

  global.AquinAnimator = { SCENES: SCENES, palettes: palettes, findScene: findScene, attach: attach, makePalHelpers: makePalHelpers };
})(typeof window !== 'undefined' ? window : this);
