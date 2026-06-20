/* era-ux.js — site-wide progressive enhancement. Fail-safe: if anything throws,
 * the page is unaffected (content is never hidden without this running). Honors
 * prefers-reduced-motion. No company/brand names anywhere. */
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var path = location.pathname || '';
  var isApp = /^\/(admin|portal)/.test(path); // dashboards stay instant - no reveal

  // 1. Scroll progress bar
  try {
    var bar = document.createElement('div');
    bar.id = 'era-scroll-progress';
    document.body.appendChild(bar);
    var barTick = function () {
      var h = document.documentElement;
      var max = (h.scrollHeight - h.clientHeight) || 1;
      bar.style.width = Math.min(100, Math.max(0, (window.scrollY || h.scrollTop || 0) / max * 100)) + '%';
    };
    window.addEventListener('scroll', barTick, { passive: true });
    window.addEventListener('resize', barTick, { passive: true });
    barTick();
  } catch (e) {}

  // 2. Header elevation on scroll (sticky/fixed headers only)
  try {
    var heads = document.querySelectorAll('header');
    var hTick = function () {
      var s = (window.scrollY || 0) > 8;
      heads.forEach(function (h) {
        var pos = getComputedStyle(h).position;
        if (pos === 'sticky' || pos === 'fixed') h.classList.toggle('era-scrolled', s);
      });
    };
    window.addEventListener('scroll', hTick, { passive: true });
    hTick();
  } catch (e) {}

  // 4. Scroll-reveal (marketing / AquinTutor pages only; fail-safe + motion-aware)
  try {
    if (!reduce && !isApp && 'IntersectionObserver' in window) {
      document.documentElement.classList.add('era-reveal-on');
      var targets = [];
      document.querySelectorAll('main section, [data-reveal]').forEach(function (el) {
        if (el.closest('header, nav, #era-back-to-top')) return;
        if (el.getBoundingClientRect().height > window.innerHeight * 1.5) return; // skip huge wrappers
        el.classList.add('era-reveal-item');
        targets.push(el);
      });
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('era-revealed'); io.unobserve(en.target); } });
      }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });
      targets.forEach(function (t) { io.observe(t); });
      // hard safety: reveal everything after 2.5s regardless
      setTimeout(function () { targets.forEach(function (t) { t.classList.add('era-revealed'); }); }, 2500);
    }
  } catch (e) {}

  // 5. Debounced form auto-save (apply wizard + opt-in forms). Never touches
  //    passwords, OTP, card, face, 2FA or search fields.
  try {
    var SKIP = /pass|otp|cvv|card|secret|token|face|descriptor|2fa|otp|search|(^q$)/i;
    if (/\/apply\b/.test(path)) {
      document.querySelectorAll('form').forEach(function (f) { f.setAttribute('data-autosave', '1'); });
    }
    document.querySelectorAll('form[data-autosave], form.era-autosave').forEach(function (form, idx) {
      var key = 'era-form:' + path + ':' + idx;
      try {
        var saved = JSON.parse(localStorage.getItem(key) || '{}');
        Object.keys(saved).forEach(function (name) {
          var el = form.elements[name];
          if (el && el.type !== 'password' && el.type !== 'file' && !el.value && !SKIP.test(name)) {
            try { el.value = saved[name]; } catch (e) {}
          }
        });
      } catch (e) {}
      var t;
      form.addEventListener('input', function () {
        clearTimeout(t);
        t = setTimeout(function () {
          var data = {};
          Array.prototype.forEach.call(form.elements, function (el) {
            if (!el.name || el.type === 'password' || el.type === 'file' || SKIP.test(el.name)) return;
            if (el.type === 'checkbox' || el.type === 'radio') { if (el.checked) data[el.name] = el.value; }
            else if (el.value) data[el.name] = el.value;
          });
          try { localStorage.setItem(key, JSON.stringify(data)); } catch (e) {}
        }, 500);
      });
      form.addEventListener('submit', function () { try { localStorage.removeItem(key); } catch (e) {} });
    });
  } catch (e) {}
})();
