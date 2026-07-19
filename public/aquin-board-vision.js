// public/aquin-board-vision.js — physical-board vision core (Prompt A4a). Dependency-free + PURE
// (array math only; all camera/canvas/DOM use is guarded), so it runs and is TESTED in Node via
// eval like the other engines. Privacy-first: this derives STRUCTURED data (a rectifying homography,
// lighting quality, and vectorized ink strokes) from frames LOCALLY — it never emits pixels/video.
// The browser capture layer (getUserMedia -> canvas -> grayscale) feeds these functions plain arrays.
(function () {
  // ---- 4-point homography (DLT): map board corners in the frame to a flat rectangle ----
  function solveLinear(A, b) {                          // Gaussian elimination, n<=8
    var n = b.length, M = A.map(function (r, i) { return r.concat([b[i]]); });
    for (var c = 0; c < n; c++) {
      var piv = c; for (var r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      var tmp = M[c]; M[c] = M[piv]; M[piv] = tmp;
      if (Math.abs(M[c][c]) < 1e-12) return null;
      for (var r2 = 0; r2 < n; r2++) { if (r2 === c) continue; var f = M[r2][c] / M[c][c]; for (var k = c; k <= n; k++) M[r2][k] -= f * M[c][k]; }
    }
    return M.map(function (row, i) { return row[n] / row[i]; });
  }
  // src = 4 [x,y] board corners in the frame; dst = 4 [x,y] target rectangle corners
  function computeHomography(src, dst) {
    if (!src || !dst || src.length !== 4 || dst.length !== 4) return null;
    var A = [], b = [];
    for (var i = 0; i < 4; i++) {
      var x = src[i][0], y = src[i][1], u = dst[i][0], v = dst[i][1];
      A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -x * v, -y * v]); b.push(v);
    }
    var h = solveLinear(A, b); if (!h) return null;
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }
  function applyHomography(H, pt) {
    var x = pt[0], y = pt[1], w = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  }

  // ---- lighting quality (from grayscale stats) ----
  function brightnessStats(gray) {
    var n = gray.length; if (!n) return { mean: 0, stddev: 0 };
    var s = 0; for (var i = 0; i < n; i++) s += gray[i]; var m = s / n;
    var v = 0; for (var j = 0; j < n; j++) { var d = gray[j] - m; v += d * d; } return { mean: m, stddev: Math.sqrt(v / n) };
  }
  function lightingQuality(stats) {
    var m = stats.mean, sd = stats.stddev;
    if (m < 40) return { level: 'poor', score: 0.2, reason: 'too dark' };
    if (m > 230) return { level: 'poor', score: 0.2, reason: 'over-exposed / glare' };
    if (sd < 12) return { level: 'poor', score: 0.3, reason: 'low contrast — frame the board' };
    if (m >= 60 && m <= 205 && sd >= 25) return { level: 'good', score: 0.9, reason: 'clear' };
    return { level: 'fair', score: 0.6, reason: 'usable, lighting could be better' };
  }

  // ---- frame differencing: new marker strokes = pixels that changed from the calibration baseline ----
  function diffMask(baseline, current, threshold) {
    var th = threshold || 40, idx = [], darker = 0, lighter = 0;
    for (var i = 0; i < current.length; i++) { var d = current[i] - baseline[i]; if (Math.abs(d) > th) { idx.push(i); if (d < 0) darker++; else lighter++; } }
    return { indices: idx, polarity: darker >= lighter ? 'dark-on-light' : 'light-on-dark', changedRatio: idx.length / (current.length || 1) };
  }

  // ---- vectorize changed pixels -> normalized stroke polylines (structured data, NOT pixels) ----
  function gridCenters(indices, w, h, cell) {
    var c = cell || 8, cols = Math.ceil(w / c), occ = {};
    for (var i = 0; i < indices.length; i++) { var p = indices[i], x = p % w, y = (p / w) | 0, key = ((y / c) | 0) * cols + ((x / c) | 0); (occ[key] = occ[key] || { sx: 0, sy: 0, n: 0 }); occ[key].sx += x; occ[key].sy += y; occ[key].n++; }
    var pts = []; for (var k in occ) { var o = occ[k]; pts.push([(o.sx / o.n) / w, (o.sy / o.n) / h]); }
    return pts;                                          // normalized [0..1] cell centroids
  }
  function chainStrokes(points, maxGap) {                // greedy nearest-neighbour into polylines
    var gap = maxGap || 0.06, remaining = points.slice(), strokes = [];
    while (remaining.length) {
      var cur = remaining.shift(), line = [cur];
      var advanced = true;
      while (advanced) {
        advanced = false; var bi = -1, bd = gap;
        for (var i = 0; i < remaining.length; i++) { var dx = remaining[i][0] - cur[0], dy = remaining[i][1] - cur[1], dd = Math.sqrt(dx * dx + dy * dy); if (dd < bd) { bd = dd; bi = i; } }
        if (bi >= 0) { cur = remaining.splice(bi, 1)[0]; line.push(cur); advanced = true; }
      }
      strokes.push(line);
    }
    return strokes;
  }
  function maskToStrokes(indices, w, h, opts) {
    opts = opts || {};
    var pts = gridCenters(indices, w, h, opts.cell || 8);
    if (opts.maxPoints && pts.length > opts.maxPoints) pts = pts.slice(0, opts.maxPoints);
    var strokes = chainStrokes(pts, opts.maxGap || 0.06);
    // round to keep the broadcast payload tiny (still vectors, never pixels)
    return strokes.map(function (s) { return s.map(function (p) { return [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000]; }); });
  }

  // ---- overall capture confidence (honest, surfaced in the UI; never fabricated) ----
  function captureConfidence(light, changedRatio) {
    if (light.level === 'poor') return { value: 0.15, usable: false, reason: light.reason };
    if (changedRatio < 0.0005) return { value: 0.25, usable: false, reason: 'nothing detected on the board' };
    if (changedRatio > 0.25) return { value: 0.3, usable: false, reason: 'too much changed — re-calibrate' };
    return { value: Math.min(0.85, light.score), usable: true, reason: light.reason };
  }

  // ---- DOM/canvas helpers (guarded; no-op in Node) ----
  function frameToGray(video, canvas, w, h) {
    if (typeof document === 'undefined') return null;
    var ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0, w, h);
    var d = ctx.getImageData(0, 0, w, h).data, gray = new Uint8ClampedArray(w * h);
    for (var i = 0, p = 0; i < d.length; i += 4, p++) gray[p] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    return gray;
  }

  var api = {
    computeHomography: computeHomography, applyHomography: applyHomography,
    brightnessStats: brightnessStats, lightingQuality: lightingQuality,
    diffMask: diffMask, gridCenters: gridCenters, chainStrokes: chainStrokes, maskToStrokes: maskToStrokes,
    captureConfidence: captureConfidence, frameToGray: frameToGray,
  };
  if (typeof window !== 'undefined') window.AquinVision = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
