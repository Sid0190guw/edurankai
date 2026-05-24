/* era-pwa.js - registers the EduRankAI service worker + handles
   the "Add to home screen" install banner. Loaded by BaseLayout. */
(function() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('/era-sw.js', { scope: '/' }).catch(function() {});
  });

  // ===== Install banner =====
  var deferred = null;
  var DISMISS_KEY = 'era_pwa_dismissed_at';

  function shouldShow() {
    try {
      var v = localStorage.getItem(DISMISS_KEY);
      if (!v) return true;
      // suppress for 30 days after dismiss
      return (Date.now() - parseInt(v, 10)) > 30 * 24 * 3600 * 1000;
    } catch (_) { return true; }
  }

  window.addEventListener('beforeinstallprompt', function(e) {
    e.preventDefault();
    deferred = e;
    if (!shouldShow()) return;
    setTimeout(showBanner, 2500);
  });

  function showBanner() {
    if (document.getElementById('eraPwaBanner')) return;
    var b = document.createElement('div');
    b.id = 'eraPwaBanner';
    b.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:9998;background:#0f0f14;border:1px solid #FF4F00;border-radius:14px;padding:14px 16px;display:flex;align-items:center;gap:12px;box-shadow:0 12px 32px rgba(0,0,0,0.5);max-width:520px;margin-left:auto;margin-right:auto;color:#fff;font-family:system-ui,sans-serif;';
    b.innerHTML =
      '<div style="flex:1;min-width:0;">' +
        '<p style="font-size:13.5px;font-weight:600;margin:0 0 2px;">Install EduRankAI</p>' +
        '<p style="font-size:11.5px;color:#a8a8b3;margin:0;line-height:1.45;">Add to your home screen for faster access and offline pages.</p>' +
      '</div>' +
      '<button id="eraPwaInstall" style="background:#FF4F00;border:none;color:#fff;font-weight:600;font-size:12.5px;padding:8px 14px;border-radius:8px;cursor:pointer;white-space:nowrap;">Install</button>' +
      '<button id="eraPwaDismiss" style="background:transparent;border:1px solid #1f1f26;color:#a8a8b3;font-size:12px;padding:7px 10px;border-radius:8px;cursor:pointer;">Later</button>';
    document.body.appendChild(b);

    document.getElementById('eraPwaInstall').addEventListener('click', function() {
      if (!deferred) { b.remove(); return; }
      deferred.prompt();
      deferred.userChoice.then(function() {
        deferred = null;
        b.remove();
      });
    });
    document.getElementById('eraPwaDismiss').addEventListener('click', function() {
      try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (_) {}
      b.remove();
    });
  }

  // iOS doesn't fire beforeinstallprompt - show a soft hint after 5s for Safari standalone-capable
  window.addEventListener('load', function() {
    var ua = navigator.userAgent || '';
    var isIOS = /iPad|iPhone|iPod/.test(ua) && !(window).MSStream;
    var isStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || (navigator).standalone;
    if (!isIOS || isStandalone || !shouldShow()) return;
    setTimeout(function() {
      if (document.getElementById('eraPwaBanner')) return;
      var b = document.createElement('div');
      b.id = 'eraPwaBanner';
      b.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:9998;background:#0f0f14;border:1px solid #FF4F00;border-radius:14px;padding:14px 16px;display:flex;align-items:center;gap:12px;box-shadow:0 12px 32px rgba(0,0,0,0.5);max-width:520px;margin-left:auto;margin-right:auto;color:#fff;font-family:system-ui,sans-serif;';
      b.innerHTML =
        '<div style="flex:1;min-width:0;">' +
          '<p style="font-size:13.5px;font-weight:600;margin:0 0 2px;">Add to home screen</p>' +
          '<p style="font-size:11.5px;color:#a8a8b3;margin:0;line-height:1.45;">Tap the share icon, then "Add to Home Screen".</p>' +
        '</div>' +
        '<button id="eraPwaDismiss" style="background:#FF4F00;border:none;color:#fff;font-weight:600;font-size:12.5px;padding:8px 14px;border-radius:8px;cursor:pointer;">Got it</button>';
      document.body.appendChild(b);
      document.getElementById('eraPwaDismiss').addEventListener('click', function() {
        try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (_) {}
        b.remove();
      });
    }, 5000);
  });
})();
