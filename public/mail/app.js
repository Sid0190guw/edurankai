/* ================================================================================================
   public/mail/app.js — the client runtime shared by every /mail screen.
   ------------------------------------------------------------------------------------------------
   Loaded once by MailShell.astro. It owns four things and nothing else:

     EM.api()      the service layer. EVERY network call in this product goes through it, so the
                   error shape, the credentials and the "what is unchanged" wording are decided once.
     EM.toast()    the confirmation/error surface.
     EM.confirm()  a REAL dialog, because window.confirm() DOES NOT WORK HERE. Admin pages are framed
                   without allow-modals in this product's shell, so a native confirm() is suppressed
                   by the browser and returns false — which silently CANCELS the action the person
                   asked for. This project has already had to remove forty-nine delete buttons that
                   depended on one.
     the drawer    rail open/close under 1080px, with Escape and a focus trap.

   NO FRAMEWORK, NO BUILD STEP. This ships as one file the browser parses in a few milliseconds. The
   heavy screens (the email builder, the automation canvas) load their own script separately, so a
   person reading their inbox never downloads either.
   ============================================================================================== */
(function () {
  'use strict';

  var EM = window.EM || {};
  window.EM = EM;

  /* ---- Service layer ------------------------------------------------------------------------- */

  /**
   * One fetch, one error shape.
   *
   * ALWAYS RESOLVES. Callers get { ok, ...data } or { ok:false, error }, never a thrown exception —
   * an unhandled rejection in a click handler leaves a button spinning forever with no explanation.
   *
   * The error strings the server sends are written for the operator and say what is UNCHANGED. They
   * are passed through verbatim rather than replaced with a generic message.
   */
  EM.api = function (url, options) {
    options = options || {};
    var init = {
      method: options.method || (options.body ? 'POST' : 'GET'),
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      signal: options.signal,
    };
    if (options.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    }
    return fetch(url, init).then(function (res) {
      return res.json().catch(function () {
        // A non-JSON body from a JSON endpoint is a server error page or a proxy. Say which, because
        // "unexpected token <" tells the person nothing they can act on.
        return { ok: false, error: 'The server answered with something that was not JSON (HTTP ' + res.status + '). Nothing has been changed.' };
      }).then(function (data) {
        if (res.status === 401) return { ok: false, status: 401, error: 'Your session has ended. Sign in again — nothing you were doing has been sent.' };
        if (res.status === 403) return { ok: false, status: 403, error: data.error || 'You do not have access to that.' };
        if (!res.ok && data.ok === undefined) return { ok: false, status: res.status, error: data.error || ('The request failed (HTTP ' + res.status + ').') };
        data.status = res.status;
        return data;
      });
    }).catch(function (err) {
      if (err && err.name === 'AbortError') return { ok: false, aborted: true };
      return { ok: false, error: 'Could not reach the server. Check your connection — nothing has been sent.' };
    });
  };

  /* ---- Toasts ------------------------------------------------------------------------------- */

  EM.toast = function (message, tone, ms) {
    var host = document.getElementById('emToasts');
    if (!host) { console.log('[mail]', message); return; }
    var el = document.createElement('div');
    el.className = 'em-toast' + (tone ? ' ' + tone : '');
    var span = document.createElement('span');
    span.style.flex = '1';
    span.textContent = message;
    var close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    close.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    close.onclick = function () { el.remove(); };
    el.appendChild(span);
    el.appendChild(close);
    host.appendChild(el);
    // An error stays until dismissed. Auto-hiding the sentence that explains what went wrong, while
    // the person is still reading it, is how a product becomes impossible to debug from the outside.
    if (tone !== 'bad') setTimeout(function () { el.remove(); }, ms || 4200);
    return el;
  };

  /* ---- Focus trap ---------------------------------------------------------------------------- */

  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  function trap(container, onEscape) {
    var previouslyFocused = document.activeElement;
    function keydown(e) {
      if (e.key === 'Escape') { e.preventDefault(); onEscape && onEscape(); return; }
      if (e.key !== 'Tab') return;
      var items = Array.prototype.filter.call(container.querySelectorAll(FOCUSABLE), function (el) {
        return el.offsetParent !== null || el === document.activeElement;
      });
      if (!items.length) return;
      var first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', keydown, true);
    var initial = container.querySelector('[data-autofocus]') || container.querySelector(FOCUSABLE);
    if (initial) setTimeout(function () { initial.focus(); }, 30);
    return function release() {
      document.removeEventListener('keydown', keydown, true);
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
    };
  }
  EM.trap = trap;

  /* ---- Modal --------------------------------------------------------------------------------- */

  /**
   * Open a modal that already exists in the page.
   * Returns a close function. Backdrop click and Escape both close it.
   */
  EM.openModal = function (el, opts) {
    opts = opts || {};
    if (!el) return function () {};
    el.hidden = false;
    document.body.style.overflow = 'hidden';
    var release = trap(el, close);
    function backdrop(e) { if (e.target === el && opts.dismissible !== false) close(); }
    el.addEventListener('mousedown', backdrop);
    function close() {
      el.hidden = true;
      document.body.style.overflow = '';
      el.removeEventListener('mousedown', backdrop);
      release();
      opts.onClose && opts.onClose();
    }
    el.__emClose = close;
    return close;
  };

  EM.closeModal = function (el) { if (el && el.__emClose) el.__emClose(); };

  /**
   * The replacement for window.confirm().
   *
   * Resolves true/false. The destructive button carries the CONSEQUENCE as its label ("Delete 240
   * contacts"), not the word "OK" — a dialog whose buttons are Yes and No is a dialog people answer
   * without reading.
   */
  EM.confirm = function (opts) {
    return new Promise(function (resolve) {
      var wrap = document.createElement('div');
      wrap.className = 'em-modal';
      wrap.innerHTML =
        '<div class="em-modal-card" role="alertdialog" aria-modal="true" aria-labelledby="emCfmT" aria-describedby="emCfmB" style="max-width:460px">' +
          '<div class="em-modal-head"><h2 id="emCfmT"></h2></div>' +
          '<div class="em-modal-body"><p id="emCfmB" style="margin:0;font-size:13.5px;line-height:1.6;color:var(--em-ink-3)"></p></div>' +
          '<div class="em-modal-foot"><span class="spacer"></span>' +
            '<button type="button" class="em-btn" data-no></button>' +
            '<button type="button" class="em-btn" data-yes data-autofocus></button>' +
          '</div>' +
        '</div>';
      wrap.querySelector('#emCfmT').textContent = opts.title || 'Are you sure?';
      wrap.querySelector('#emCfmB').textContent = opts.body || '';
      var no = wrap.querySelector('[data-no]');
      var yes = wrap.querySelector('[data-yes]');
      no.textContent = opts.cancelLabel || 'Cancel';
      yes.textContent = opts.confirmLabel || 'Confirm';
      yes.className = 'em-btn ' + (opts.tone === 'danger' ? 'danger' : 'pri');
      document.body.appendChild(wrap);

      var close = EM.openModal(wrap, { onClose: function () { wrap.remove(); resolve(false); } });
      no.onclick = function () { close(); };
      yes.onclick = function () {
        // Resolve BEFORE close, so the onClose(false) that follows cannot win the race.
        resolve(true);
        wrap.__emClose = function () { wrap.hidden = true; document.body.style.overflow = ''; wrap.remove(); };
        close();
      };
    });
  };

  /* ---- Small helpers used across screens ------------------------------------------------------ */

  EM.esc = function (v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  EM.num = function (n) { var v = Number(n); return isFinite(v) ? v.toLocaleString('en-IN') : '0'; };

  EM.timeAgo = function (input) {
    if (!input) return '';
    var t = Date.parse(input);
    if (isNaN(t)) return '';
    var s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return 'just now';
    var m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
    var d = Math.floor(h / 24); if (d < 7) return d + 'd ago';
    if (d < 365) return Math.floor(d / 7) + 'w ago';
    return Math.floor(d / 365) + 'y ago';
  };

  EM.fullTime = function (input) {
    if (!input) return '';
    var d = new Date(input);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  EM.initials = function (name, email) {
    var src = String(name || '').trim() || String(email || '').trim();
    if (!src) return '?';
    var parts = src.replace(/@.*$/, '').split(/[\s._-]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return src.slice(0, 2).toUpperCase();
  };

  var PALETTE = ['var(--em-c2)', 'var(--em-c3)', 'var(--em-c4)', 'var(--em-c5)', 'var(--em-c6)'];
  EM.avatarColour = function (seed) {
    var h = 0, s = String(seed || '');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  };

  /** Debounce — used by every search box and by the builder's live preview. */
  EM.debounce = function (fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms || 250);
    };
  };

  /** A button that shows it is working, and cannot be pressed twice while it is. */
  EM.busy = function (btn, on, label) {
    if (!btn) return;
    if (on) {
      btn.dataset.label = btn.dataset.label || btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="em-spin"></span>' + (label ? ' ' + EM.esc(label) : '');
    } else {
      btn.disabled = false;
      if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
    }
  };

  /* ---- Nav drawer ----------------------------------------------------------------------------- */

  document.addEventListener('DOMContentLoaded', function () {
    var shell = document.getElementById('emShell');
    var rail = document.getElementById('emRail');
    if (!shell || !rail) return;

    var release = null;
    var burger = document.querySelector('[data-open-nav]');

    function openNav() {
      shell.classList.add('nav-open');
      if (burger) burger.setAttribute('aria-expanded', 'true');
      release = trap(rail, closeNav);
    }
    function closeNav() {
      shell.classList.remove('nav-open');
      if (burger) burger.setAttribute('aria-expanded', 'false');
      if (release) { release(); release = null; }
    }

    if (burger) burger.addEventListener('click', openNav);
    document.querySelectorAll('[data-close-nav]').forEach(function (el) { el.addEventListener('click', closeNav); });
    // Following a link inside the drawer must close it, or the destination renders behind an
    // overlay on a phone.
    rail.addEventListener('click', function (e) { if (e.target.closest('a')) closeNav(); });

    // A resize past the breakpoint leaves the drawer state stranded. Reset it.
    var mq = window.matchMedia('(min-width: 1081px)');
    (mq.addEventListener ? mq.addEventListener.bind(mq, 'change') : mq.addListener.bind(mq))(function () {
      if (mq.matches) closeNav();
    });
  });

  /* ---- Lazy modules ----------------------------------------------------------------------------
     CODE SPLITTING WITHOUT A BUNDLER. The composer is roughly the size of everything above it and
     most visits never open it, so it is fetched the first time somebody presses Compose and cached
     by the browser after that. The email builder and the automation canvas load the same way, from
     the pages that need them.                                                                     */

  var loaded = {};
  EM.load = function (src) {
    if (loaded[src]) return loaded[src];
    loaded[src] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () {
        delete loaded[src];   // a failed load must be retryable, not cached as done
        reject(new Error('load failed'));
      };
      document.head.appendChild(s);
    });
    return loaded[src];
  };

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-compose]');
    if (!btn) return;
    e.preventDefault();
    EM.busy(btn, true);
    EM.load('/mail/compose.js').then(function () {
      EM.busy(btn, false);
      EM.compose(JSON.parse(btn.dataset.compose || '{}'));
    }).catch(function () {
      EM.busy(btn, false);
      EM.toast('The composer could not be loaded. Check your connection and try again — nothing has been sent.', 'bad');
    });
  });
})();
