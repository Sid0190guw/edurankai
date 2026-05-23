/* era-motion.js - Motion utilities
   Auto-applies scroll reveals, manages animations, handles transitions
*/
(function(global) {
  'use strict';
  if (!global.ERA) global.ERA = {};

  // ===== SCROLL REVEAL =====
  // Any element with class "era-reveal" or [data-reveal] auto-animates on scroll
  function initScrollReveal() {
    if (typeof IntersectionObserver === 'undefined') return;
    var targets = document.querySelectorAll('.era-reveal, [data-reveal]');
    if (targets.length === 0) return;

    var observer = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting) {
          var el = entry.target;
          // Allow staggered children via data-reveal-stagger
          var delay = parseInt(el.getAttribute('data-reveal-delay') || '0');
          if (delay > 0) {
            setTimeout(function() { el.classList.add('era-revealed'); }, delay);
          } else {
            el.classList.add('era-revealed');
          }
          observer.unobserve(el);
        }
      });
    }, { threshold: 0.1, rootMargin: '50px' });

    targets.forEach(function(el) {
      if (!el.classList.contains('era-reveal')) el.classList.add('era-reveal');
      observer.observe(el);
    });
  }

  // ===== STAGGER CHILDREN =====
  // Container [data-stagger="100"] auto-staggers its direct children
  function initStagger() {
    document.querySelectorAll('[data-stagger]').forEach(function(parent) {
      var delay = parseInt(parent.getAttribute('data-stagger') || '80');
      Array.from(parent.children).forEach(function(child, i) {
        if (!child.classList.contains('era-reveal')) {
          child.classList.add('era-reveal');
        }
        child.setAttribute('data-reveal-delay', String(i * delay));
      });
    });
  }

  // ===== MAGNETIC HOVER =====
  // Element [data-magnetic] tilts slightly toward cursor
  function initMagnetic() {
    document.querySelectorAll('[data-magnetic]').forEach(function(el) {
      var strength = parseFloat(el.getAttribute('data-magnetic') || '0.3');
      el.addEventListener('mousemove', function(e) {
        var rect = el.getBoundingClientRect();
        var x = e.clientX - rect.left - rect.width / 2;
        var y = e.clientY - rect.top - rect.height / 2;
        el.style.transform = 'translate(' + (x * strength) + 'px, ' + (y * strength) + 'px)';
      });
      el.addEventListener('mouseleave', function() {
        el.style.transform = 'translate(0, 0)';
      });
    });
  }

  // ===== PARALLAX =====
  // Element [data-parallax="0.3"] moves at fraction speed of scroll
  function initParallax() {
    var els = document.querySelectorAll('[data-parallax]');
    if (els.length === 0) return;
    function update() {
      var scroll = window.pageYOffset;
      els.forEach(function(el) {
        var speed = parseFloat(el.getAttribute('data-parallax') || '0.5');
        var offset = scroll * speed;
        el.style.transform = 'translate3d(0, ' + (-offset) + 'px, 0)';
      });
    }
    window.addEventListener('scroll', update, { passive: true });
    update();
  }

  // ===== COUNTER ANIMATION =====
  // [data-counter="1234"] animates from 0 to number when in view
  function initCounters() {
    if (typeof IntersectionObserver === 'undefined') return;
    var observer = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        var target = parseFloat(el.getAttribute('data-counter') || '0');
        var duration = parseInt(el.getAttribute('data-counter-duration') || '1500');
        var prefix = el.getAttribute('data-counter-prefix') || '';
        var suffix = el.getAttribute('data-counter-suffix') || '';
        var start = performance.now();
        function step(now) {
          var p = Math.min((now - start) / duration, 1);
          var eased = 1 - Math.pow(1 - p, 3);
          var current = Math.round(target * eased);
          el.textContent = prefix + current.toLocaleString() + suffix;
          if (p < 1) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
        observer.unobserve(el);
      });
    }, { threshold: 0.4 });
    document.querySelectorAll('[data-counter]').forEach(function(el) {
      observer.observe(el);
    });
  }

  // ===== HEADER SCROLL SHRINK =====
  function initHeaderScroll() {
    var hdr = document.querySelector('[data-shrink-header]');
    if (!hdr) return;
    var lastY = 0;
    window.addEventListener('scroll', function() {
      var y = window.pageYOffset;
      if (y > 20 && lastY <= 20) hdr.classList.add('era-header-scrolled');
      else if (y <= 20 && lastY > 20) hdr.classList.remove('era-header-scrolled');
      lastY = y;
    }, { passive: true });
  }

  // ===== BUTTON RIPPLE =====
  // Add ripple effect to .era-btn on click
  function initRipple() {
    document.addEventListener('click', function(e) {
      var btn = e.target.closest('.era-btn-primary, .era-btn-secondary');
      if (!btn) return;
      var rect = btn.getBoundingClientRect();
      var ripple = document.createElement('span');
      ripple.style.cssText = 'position:absolute;border-radius:50%;background:rgba(255,255,255,0.4);pointer-events:none;width:8px;height:8px;left:' + (e.clientX - rect.left - 4) + 'px;top:' + (e.clientY - rect.top - 4) + 'px;animation:eraRipple 0.6s ease-out;';
      btn.style.position = btn.style.position || 'relative';
      btn.style.overflow = 'hidden';
      btn.appendChild(ripple);
      setTimeout(function() { ripple.remove(); }, 600);
    });
    if (!document.getElementById('eraRippleStyle')) {
      var s = document.createElement('style');
      s.id = 'eraRippleStyle';
      s.textContent = '@keyframes eraRipple { to { transform: scale(40); opacity: 0; } }';
      document.head.appendChild(s);
    }
  }

  // ===== INIT ALL =====
  function init() {
    initScrollReveal();
    initStagger();
    initMagnetic();
    initParallax();
    initCounters();
    initHeaderScroll();
    initRipple();
  }

  global.ERA.motion = {
    init: init,
    scrollReveal: initScrollReveal,
    stagger: initStagger,
    counters: initCounters,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : this);
