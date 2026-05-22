/* era-utils.js - Common utilities (no dependencies)
   Provides: ERA.fmt, ERA.fetch, ERA.toast, ERA.modal, ERA.debounce
*/
(function(global) {
  'use strict';
  var ERA = global.ERA = global.ERA || {};

  // ===== FORMAT =====
  ERA.fmt = {
    date: function(d, opts) {
      if (!d) return '';
      var date = d instanceof Date ? d : new Date(d);
      if (isNaN(date)) return '';
      return date.toLocaleDateString(undefined, opts || { day: 'numeric', month: 'short', year: 'numeric' });
    },
    dateTime: function(d, opts) {
      if (!d) return '';
      var date = d instanceof Date ? d : new Date(d);
      if (isNaN(date)) return '';
      return date.toLocaleString(undefined, opts || { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    },
    timeAgo: function(d) {
      if (!d) return '';
      var date = d instanceof Date ? d : new Date(d);
      var s = Math.floor((Date.now() - date.getTime()) / 1000);
      if (s < 60) return 'just now';
      if (s < 3600) return Math.floor(s / 60) + 'm ago';
      if (s < 86400) return Math.floor(s / 3600) + 'h ago';
      if (s < 2592000) return Math.floor(s / 86400) + 'd ago';
      return ERA.fmt.date(date);
    },
    currency: function(n, currency) {
      currency = currency || 'INR';
      if (n == null) return '';
      try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency }).format(n);
      } catch(e) {
        return currency + ' ' + Number(n).toLocaleString();
      }
    },
    number: function(n) {
      if (n == null) return '';
      return Number(n).toLocaleString();
    },
    bytes: function(b) {
      if (!b) return '0 B';
      var k = 1024, sizes = ['B','KB','MB','GB','TB'];
      var i = Math.min(Math.floor(Math.log(b) / Math.log(k)), sizes.length - 1);
      return (b / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
    }
  };

  // ===== FETCH WRAPPER =====
  ERA.fetch = function(url, options) {
    options = options || {};
    var opts = {
      method: options.method || 'GET',
      credentials: options.credentials || 'same-origin',
      headers: options.headers || {}
    };
    if (options.json) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(options.json);
    } else if (options.body) {
      opts.body = options.body;
    }
    return fetch(url, opts).then(function(r) {
      if (options.parseJson !== false) {
        return r.json().then(function(data) {
          return { ok: r.ok, status: r.status, data: data };
        });
      }
      return { ok: r.ok, status: r.status, response: r };
    });
  };

  // ===== TOAST =====
  ERA.toast = function(msg, opts) {
    opts = opts || {};
    var type = opts.type || 'info';
    var d = opts.duration || 3000;
    var colors = {
      info: { bg: '#1a1a20', fg: '#fff', border: '#1a1a1f' },
      success: { bg: 'rgba(16,185,129,0.15)', fg: '#6ee7b7', border: 'rgba(16,185,129,0.3)' },
      error: { bg: 'rgba(239,68,68,0.15)', fg: '#fca5a5', border: 'rgba(239,68,68,0.3)' },
      warn: { bg: 'rgba(251,191,36,0.15)', fg: '#fbbf24', border: 'rgba(251,191,36,0.3)' }
    };
    var c = colors[type] || colors.info;
    var el = document.createElement('div');
    el.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:' + c.bg + ';color:' + c.fg + ';border:1px solid ' + c.border + ';font-size:13px;font-weight:500;padding:12px 22px;border-radius:100px;z-index:99999;backdrop-filter:blur(10px);animation:eraToastIn 0.25s ease-out;';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function() {
      el.style.transition = 'opacity 0.3s, transform 0.3s';
      el.style.opacity = '0';
      el.style.transform = 'translate(-50%, -10px)';
      setTimeout(function() { el.remove(); }, 300);
    }, d);
    if (!document.getElementById('eraToastStyle')) {
      var s = document.createElement('style');
      s.id = 'eraToastStyle';
      s.textContent = '@keyframes eraToastIn { from { opacity: 0; transform: translate(-50%, -10px); } to { opacity: 1; transform: translate(-50%, 0); } }';
      document.head.appendChild(s);
    }
  };

  // ===== MODAL =====
  ERA.modal = function(htmlContent, options) {
    options = options || {};
    var overlay = document.createElement('div');
    overlay.className = 'era-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);backdrop-filter:blur(6px);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
    var box = document.createElement('div');
    box.className = 'era-modal-box';
    box.style.cssText = 'background:#0f0f14;border:1px solid #1a1a1f;border-radius:14px;max-width:' + (options.maxWidth || '480px') + ';width:100%;max-height:90vh;overflow-y:auto;color:#fff;';
    box.innerHTML = htmlContent;
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    if (options.closeOnClick !== false) {
      overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
    }
    return {
      close: function() { overlay.remove(); },
      element: box
    };
  };

  // ===== DEBOUNCE =====
  ERA.debounce = function(fn, wait) {
    var timer;
    return function() {
      var args = arguments, ctx = this;
      clearTimeout(timer);
      timer = setTimeout(function() { fn.apply(ctx, args); }, wait);
    };
  };

  // ===== LOCAL TIME RENDERING =====
  ERA.renderLocalTimes = function() {
    document.querySelectorAll('[data-ts]').forEach(function(el) {
      var ts = el.getAttribute('data-ts');
      if (!ts) return;
      var fmt = el.getAttribute('data-fmt') || 'datetime';
      if (fmt === 'date') el.textContent = ERA.fmt.date(ts);
      else if (fmt === 'timeago') el.textContent = ERA.fmt.timeAgo(ts);
      else el.textContent = ERA.fmt.dateTime(ts);
    });
  };

  // Auto-render local times on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ERA.renderLocalTimes);
  } else {
    ERA.renderLocalTimes();
  }
})(typeof window !== 'undefined' ? window : this);
