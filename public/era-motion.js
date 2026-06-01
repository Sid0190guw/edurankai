// EduRankAI motion primitives - scroll reveal + count-up + tilt cursor.
// Loaded on every page that wants the design system. Kept tiny on purpose.
(function () {
  'use strict';

  // 1) Scroll-triggered reveal: anything with .ds-reveal gets .ds-in when
  //    it enters the viewport. Once is enough.
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('ds-in');
          io.unobserve(e.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
    document.querySelectorAll('.ds-reveal').forEach(function (el) { io.observe(el); });

    // also catch nodes added after load (SPA-ish flows)
    var mo = new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        m.addedNodes.forEach(function (n) {
          if (n.nodeType !== 1) return;
          if (n.classList && n.classList.contains('ds-reveal')) io.observe(n);
          if (n.querySelectorAll) n.querySelectorAll('.ds-reveal').forEach(function (el) { io.observe(el); });
        });
      });
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // 2) Count-up: elements with [data-count="<n>"] animate from 0 -> n on
  //    intersection. Honors data-count-duration (ms) and data-count-suffix.
  function animateCount(el) {
    var target = parseFloat(el.getAttribute('data-count') || '0');
    var duration = parseInt(el.getAttribute('data-count-duration') || '900', 10);
    var suffix = el.getAttribute('data-count-suffix') || '';
    var startTs = performance.now();
    var fmt = new Intl.NumberFormat('en-IN');
    function frame(now) {
      var t = Math.min(1, (now - startTs) / duration);
      var eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      var v = Math.round(target * eased);
      el.textContent = fmt.format(v) + suffix;
      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  if ('IntersectionObserver' in window) {
    var countIo = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { animateCount(e.target); countIo.unobserve(e.target); }
      });
    }, { threshold: 0.3 });
    document.querySelectorAll('[data-count]').forEach(function (el) { countIo.observe(el); });
  }

  // 3) Magnetic cursor follow on .ds-magnetic-strong (pointer fine only)
  if (window.matchMedia('(pointer: fine)').matches) {
    document.querySelectorAll('.ds-magnetic-strong').forEach(function (el) {
      el.addEventListener('mousemove', function (ev) {
        var r = el.getBoundingClientRect();
        var x = ev.clientX - r.left - r.width / 2;
        var y = ev.clientY - r.top - r.height / 2;
        el.style.transform = 'translate(' + (x * 0.18).toFixed(1) + 'px,' + (y * 0.22).toFixed(1) + 'px) scale(1.04)';
      });
      el.addEventListener('mouseleave', function () { el.style.transform = ''; });
    });
  }
})();
