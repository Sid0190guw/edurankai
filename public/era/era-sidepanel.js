/* era-sidepanel.js - Slide-in side panel for previews
   Any link with [data-preview="/some/url"] opens that page in a side panel
   instead of full navigation
*/
(function(global) {
  'use strict';
  if (!global.ERA) global.ERA = {};

  var panel = null;
  var backdrop = null;
  var iframe = null;
  var loadingEl = null;
  var titleEl = null;

  function build() {
    backdrop = document.createElement('div');
    backdrop.id = 'eraSidePanelBackdrop';
    backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);backdrop-filter:blur(4px);z-index:9000;opacity:0;visibility:hidden;transition:opacity 0.2s, visibility 0.2s;';
    backdrop.addEventListener('click', close);
    document.body.appendChild(backdrop);

    panel = document.createElement('div');
    panel.id = 'eraSidePanel';
    panel.style.cssText = 'position:fixed;top:0;right:0;width:min(720px,90vw);height:100vh;background:#0a0a0c;border-left:1px solid #1a1a1f;box-shadow:-20px 0 50px rgba(0,0,0,0.4);transform:translateX(100%);transition:transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);z-index:9001;display:flex;flex-direction:column;';

    var header = document.createElement('div');
    header.style.cssText = 'background:#0f0f14;border-bottom:1px solid #1a1a1f;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;';
    titleEl = document.createElement('p');
    titleEl.style.cssText = 'font-size:13px;font-weight:600;color:#fff;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    titleEl.textContent = 'Preview';

    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:6px;align-items:center;flex-shrink:0;';
    var openFull = document.createElement('button');
    openFull.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
    openFull.title = 'Open in full page';
    openFull.style.cssText = 'background:#15151a;border:1px solid #1a1a1f;color:#8a8a94;width:30px;height:30px;border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:center;';
    openFull.onclick = function() {
      var url = panel.getAttribute('data-current-url');
      if (url) window.location.href = url;
    };
    var closeBtn = document.createElement('button');
    closeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    closeBtn.title = 'Close (Esc)';
    closeBtn.style.cssText = 'background:#15151a;border:1px solid #1a1a1f;color:#fff;width:30px;height:30px;border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:center;';
    closeBtn.onclick = close;
    actions.appendChild(openFull);
    actions.appendChild(closeBtn);
    header.appendChild(titleEl);
    header.appendChild(actions);
    panel.appendChild(header);

    loadingEl = document.createElement('div');
    loadingEl.style.cssText = 'flex:1;display:none;align-items:center;justify-content:center;color:#6e6e78;font-size:13px;flex-direction:column;gap:10px;';
    loadingEl.innerHTML = '<div style="width:28px;height:28px;border:3px solid #1a1a1f;border-top-color:#FF4F00;border-radius:50%;animation:eraSpin 0.7s linear infinite;"></div><p>Loading...</p>';
    panel.appendChild(loadingEl);

    iframe = document.createElement('iframe');
    iframe.style.cssText = 'flex:1;border:none;background:#08080a;width:100%;display:none;';
    iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts allow-forms allow-popups');
    panel.appendChild(iframe);

    document.body.appendChild(panel);

    if (!document.getElementById('eraSpinKf')) {
      var s = document.createElement('style');
      s.id = 'eraSpinKf';
      s.textContent = '@keyframes eraSpin { to { transform: rotate(360deg); } }';
      document.head.appendChild(s);
    }

    // ESC to close
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && panel.style.transform === 'translateX(0px)') {
        // Don't close if user is typing in iframe
        close();
      }
    });
  }

  function openUrl(url, title) {
    if (!panel) build();
    if (title) titleEl.textContent = title;
    panel.setAttribute('data-current-url', url);
    loadingEl.style.display = 'flex';
    iframe.style.display = 'none';
    iframe.src = url;
    iframe.onload = function() {
      loadingEl.style.display = 'none';
      iframe.style.display = 'block';
      // Try to update title from iframe
      try {
        var doc = iframe.contentDocument;
        if (doc && doc.title) titleEl.textContent = doc.title.replace(' - Admin - EduRankAI', '').replace(' - EduRankAI', '');
      } catch(e) {}
    };
    backdrop.style.opacity = '1';
    backdrop.style.visibility = 'visible';
    panel.style.transform = 'translateX(0)';
    document.body.style.overflow = 'hidden';
  }

  function close() {
    if (!panel) return;
    backdrop.style.opacity = '0';
    backdrop.style.visibility = 'hidden';
    panel.style.transform = 'translateX(100%)';
    document.body.style.overflow = '';
    setTimeout(function() { if (iframe) iframe.src = 'about:blank'; }, 300);
  }

  // Auto-wire: any link with data-preview attribute opens in side panel
  // Also intercepts any link with class era-preview-link
  function wireLinks() {
    document.addEventListener('click', function(e) {
      // Holding cmd/ctrl/shift = let browser handle normally
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;

      var link = e.target.closest('[data-preview], .era-preview-link');
      if (!link) return;

      var url = link.getAttribute('data-preview') || link.getAttribute('href');
      if (!url) return;

      e.preventDefault();
      var title = link.getAttribute('data-preview-title') || link.textContent.trim();
      openUrl(url, title);
    });
  }

  global.ERA.sidepanel = {
    open: openUrl,
    close: close,
    init: function() { if (!panel) build(); wireLinks(); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { build(); wireLinks(); });
  } else {
    build();
    wireLinks();
  }
})(typeof window !== 'undefined' ? window : this);
