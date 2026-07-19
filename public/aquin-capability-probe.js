// public/aquin-capability-probe.js — Block 05: dependency-free client capability probe.
// Reads the Web APIs headers cannot carry (Battery/Storage/WebXR/WebGL), POSTs them to
// /api/render/negotiate, caches the returned RenderProfile in sessionStorage, and exposes
// window.AquinCapabilities + window.AquinRenderProfile. All DOM/API access is guarded.
(function () {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return;

  function detectWebGL() {
    try {
      var c = document.createElement('canvas');
      if (c.getContext('webgl2')) return 2;
      if (c.getContext('webgl') || c.getContext('experimental-webgl')) return 1;
    } catch (e) {}
    return 0;
  }

  async function probe() {
    var t = {};
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn) {
      if (conn.effectiveType) t.effectiveType = conn.effectiveType;
      if (typeof conn.downlink === 'number') t.downlink = conn.downlink;
      if (typeof conn.saveData === 'boolean') t.saveData = conn.saveData;
    }
    if (typeof navigator.deviceMemory === 'number') t.deviceMemory = navigator.deviceMemory;
    if (typeof navigator.hardwareConcurrency === 'number') t.hardwareConcurrency = navigator.hardwareConcurrency;
    try { t.screenWidth = screen.width; t.screenHeight = screen.height; } catch (e) {}
    t.devicePixelRatio = window.devicePixelRatio || 1;
    t.viewportWidth = window.innerWidth;
    try {
      t.prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      t.prefersReducedData = window.matchMedia('(prefers-reduced-data: reduce)').matches;
    } catch (e) {}
    t.webglVersion = detectWebGL();
    t.webgpu = !!navigator.gpu;

    try { if (navigator.getBattery) { var b = await navigator.getBattery(); t.batteryLevel = b.level; t.batteryCharging = b.charging; } } catch (e) {}
    try {
      if (navigator.storage && navigator.storage.estimate) {
        var s = await navigator.storage.estimate();
        if (typeof s.quota === 'number') t.storageQuotaMB = Math.round(s.quota / 1048576);
        if (typeof s.usage === 'number') t.storageUsageMB = Math.round(s.usage / 1048576);
      }
    } catch (e) {}
    try {
      if (navigator.xr && navigator.xr.isSessionSupported) {
        var vr = await navigator.xr.isSessionSupported('immersive-vr').catch(function () { return false; });
        var ar = await navigator.xr.isSessionSupported('immersive-ar').catch(function () { return false; });
        t.xrImmersive = !!(vr || ar);
      }
    } catch (e) { t.xrImmersive = false; }
    return t;
  }

  function cached() { try { var v = sessionStorage.getItem('aquinRenderProfile'); return v ? JSON.parse(v) : null; } catch (e) { return null; } }

  window.AquinCapabilities = {
    probe: probe,
    async negotiate(force) {
      var c = cached();
      if (c && !force) { window.AquinRenderProfile = c; return c; }
      var t = await probe();
      var res = await fetch('/api/render/negotiate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(t),
      }).then(function (r) { return r.json(); }).catch(function () { return null; });
      var p = res && res.ok ? res.profile : null;
      if (p) { try { sessionStorage.setItem('aquinRenderProfile', JSON.stringify(p)); } catch (e) {} window.AquinRenderProfile = p; }
      return p;
    },
  };
})();
