// public/safety.js - EduRankAI Content Safety Layer
// Runs on all public pages - link checking, content warnings, report button
(function() {
  'use strict';

  // ── 1. LINK SAFETY CHECK ──────────────────────────────────────────────
  // Intercept external link clicks and check against blocked domains
  document.addEventListener('click', function(e) {
    var target = e.target.closest('a');
    if (!target) return;
    var href = target.getAttribute('href');
    if (!href || href.startsWith('/') || href.startsWith('#') || href.startsWith('mailto:')) return;

    try {
      var url = new URL(href);
      var domain = url.hostname.toLowerCase().replace('www.', '');

      // Check against blocked list
      fetch('/api/safety/check-domain?domain=' + encodeURIComponent(domain), {
        credentials: 'same-origin'
      }).then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.blocked) {
          e.preventDefault();
          showWarning(href, data.reason, data.category);
        }
      }).catch(function() {}); // If check fails, allow navigation
    } catch(e) {}
  });

  function showWarning(href, reason, category) {
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;';
    overlay.innerHTML = `
      <div style="background:#0f0f14;border:1px solid rgba(239,68,68,0.4);border-radius:16px;max-width:420px;width:100%;padding:24px;text-align:center;">
        <div style="width:56px;height:56px;background:rgba(239,68,68,0.1);border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        </div>
        <h2 style="font-size:16px;font-weight:700;color:#fff;margin:0 0 8px;">Safety Warning</h2>
        <p style="font-size:13px;color:#8a8a94;margin:0 0 6px;">This link leads to a blocked domain.</p>
        <p style="font-size:12px;color:#fca5a5;margin:0 0 20px;font-family:monospace;">${reason || category || 'Content policy violation'}</p>
        <div style="display:flex;gap:8px;">
          <button onclick="this.closest('div[style*=fixed]').remove()" style="flex:1;background:#15151a;border:1px solid #1a1a1f;color:#d8d8de;font-size:13px;font-weight:600;padding:10px;border-radius:8px;cursor:pointer;">Go back</button>
          <button onclick="window.open('${href}','_blank');this.closest('div[style*=fixed]').remove()" style="flex:1;background:rgba(239,68,68,0.2);border:1px solid rgba(239,68,68,0.3);color:#fca5a5;font-size:13px;font-weight:600;padding:10px;border-radius:8px;cursor:pointer;">Proceed anyway</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
  }

  // ── 2. REPORT BUTTON ─────────────────────────────────────────────────
  // Add a floating report button on portal pages
  if (window.location.pathname.startsWith('/portal')) {
    var reportBtn = document.createElement('button');
    reportBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>
      Report
    `;
    reportBtn.style.cssText = 'position:fixed;bottom:80px;left:16px;background:#15151a;border:1px solid #1a1a1f;color:#6e6e78;font-size:11px;font-weight:600;padding:6px 12px;border-radius:100px;cursor:pointer;display:flex;align-items:center;gap:5px;z-index:40;';
    reportBtn.onclick = function() { showReportModal(); };
    document.body.appendChild(reportBtn);
  }

  function showReportModal() {
    var modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:99999;display:flex;align-items:flex-end;justify-content:center;';
    modal.innerHTML = `
      <div style="background:#0f0f14;border:1px solid #1a1a1f;border-radius:16px 16px 0 0;width:100%;max-width:500px;padding:20px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <h3 style="font-size:15px;font-weight:700;color:#fff;margin:0;">Report Content</h3>
          <button onclick="this.closest('div[style*=fixed]').remove()" style="background:#1a1a1f;border:none;color:#8a8a94;width:28px;height:28px;border-radius:6px;font-size:18px;cursor:pointer;">&times;</button>
        </div>
        <p style="font-size:12px;color:#6e6e78;margin:0 0 12px;">What are you reporting?</p>
        <form id="reportForm" style="display:flex;flex-direction:column;gap:10px;">
          <select id="flagType" style="background:#15151a;border:1px solid #1a1a1f;border-radius:8px;padding:10px 12px;color:#fff;font-size:13px;outline:none;width:100%;">
            <option value="nudity">Nude or explicit content</option>
            <option value="propaganda">Propaganda or misinformation</option>
            <option value="hate_speech">Hate speech or discrimination</option>
            <option value="harassment">Harassment or bullying</option>
            <option value="violence">Violence or threats</option>
            <option value="spam">Spam</option>
            <option value="other">Other</option>
          </select>
          <textarea id="reportNote" placeholder="Additional details (optional)..." rows="3" style="background:#15151a;border:1px solid #1a1a1f;border-radius:8px;padding:10px 12px;color:#fff;font-size:13px;outline:none;resize:vertical;width:100%;"></textarea>
          <button type="button" onclick="submitReport()" style="background:#FF4F00;border:none;color:#fff;font-weight:600;font-size:14px;padding:12px;border-radius:10px;cursor:pointer;width:100%;">Submit Report</button>
        </form>
      </div>
    `;
    document.body.appendChild(modal);
  }

  function submitReport() {
    var flagType = document.getElementById('flagType')?.value;
    var note = document.getElementById('reportNote')?.value;
    fetch('/api/safety/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        flagType: flagType,
        entityType: 'page',
        entityId: window.location.pathname,
        contentSnippet: note,
        page: window.location.pathname,
      })
    }).then(function() {
      document.querySelector('div[style*="fixed"][style*="align-items:flex-end"]')?.remove();
      var toast = document.createElement('div');
      toast.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#10b981;color:#fff;font-size:13px;font-weight:600;padding:10px 20px;border-radius:100px;z-index:99999;';
      toast.textContent = 'Report submitted. Thank you.';
      document.body.appendChild(toast);
      setTimeout(function() { toast.remove(); }, 3000);
    }).catch(function() {});
  }

  // ── 3. PROPAGANDA KEYWORD SCAN ────────────────────────────────────────
  // Scan page text for known propaganda/hate keywords (client-side, lightweight)
  var HATE_KEYWORDS = ['kill all', 'death to', 'exterminate', 'white power', 'jai jihad', 'kafir'];
  var pageText = document.body.innerText?.toLowerCase() || '';
  for (var i = 0; i < HATE_KEYWORDS.length; i++) {
    if (pageText.includes(HATE_KEYWORDS[i])) {
      // Auto-flag this page
      fetch('/api/safety/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          flagType: 'hate_speech',
          flagSource: 'system',
          entityType: 'page',
          entityId: window.location.pathname,
          contentSnippet: 'Auto-detected hate keyword on page',
        })
      }).catch(function() {});
      break;
    }
  }

})();
