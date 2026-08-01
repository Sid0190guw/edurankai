/* Portal quick-access launcher. A floating button that opens a sheet of tiles
   for the employee's key sections — attendance, wallet, leave, profile, learning
   and tools — so everything necessary is one tap away from any portal page.
   Self-contained, no deps, no emoji (SVG glyphs). */
(function () {
  if (window.__quickLaunch) return; window.__quickLaunch = true;

  // [key, href, label, icon]. The KEY is what the server allows or withholds — see
  // /api/portal/quick-access. A tile whose key is not returned is never rendered.
  var TILES = [
    ['home', '/portal', 'Home', '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>'],
    ['attendance', '/portal/employee', 'Attendance', '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'],
    ['wallet', '/portal/employee/wallet', 'Wallet', '<path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4"/><path d="M4 6v12c0 1.1.9 2 2 2h14v-4"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>'],
    ['leave', '/portal/employee/leave', 'Leave', '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'],
    ['profile', '/portal/profile', 'Profile', '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'],
    ['learn', '/portal/courses', 'Learn', '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>'],
    ['community', '/portal/discussion', 'Community', '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'],
    ['wellbeing', '/portal/wellbeing', 'Wellbeing', '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 1 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/>']
  ];
  var CSS = ''
    + '.ql-btn{position:fixed;left:16px;bottom:20px;z-index:99990;width:52px;height:52px;border-radius:50%;background:#12100c;color:#faf6ef;border:none;display:flex;align-items:center;justify-content:center;box-shadow:0 10px 28px rgba(0,0,0,.3);cursor:pointer;transition:transform .12s;}'
    + '.ql-btn:hover{transform:translateY(-2px);}'
    + '.ql-ov{position:fixed;inset:0;z-index:99991;background:rgba(10,8,6,.45);backdrop-filter:blur(2px);opacity:0;pointer-events:none;transition:opacity .18s;}'
    + '.ql-ov.open{opacity:1;pointer-events:auto;}'
    + '.ql-sheet{position:fixed;left:0;right:0;bottom:0;z-index:99992;background:#faf6ef;border-radius:20px 20px 0 0;box-shadow:0 -20px 60px rgba(26,21,16,.25);transform:translateY(110%);transition:transform .22s cubic-bezier(.2,.7,.2,1);padding:10px 16px calc(20px + env(safe-area-inset-bottom));font-family:"Inter Tight",system-ui,sans-serif;max-width:520px;margin:0 auto;}'
    + '.ql-sheet.open{transform:translateY(0);}'
    + '.ql-grip{width:40px;height:4px;border-radius:99px;background:#e0d6c5;margin:8px auto 12px;}'
    + '.ql-h{font-family:Fraunces,Georgia,serif;font-size:17px;font-weight:600;color:#1a1510;margin:0 4px 12px;}'
    + '.ql-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;}'
    + '@media(max-width:360px){.ql-grid{grid-template-columns:repeat(3,1fr);}}'
    + '.ql-tile{display:flex;flex-direction:column;align-items:center;gap:7px;text-decoration:none;color:#1a1510;background:#fff;border:1px solid #ece4d6;border-radius:14px;padding:14px 6px;transition:border-color .12s,transform .1s;}'
    + '.ql-tile:hover{border-color:#c2410c;transform:translateY(-2px);}'
    + '.ql-tile .ic{width:34px;height:34px;border-radius:10px;background:#f3ece0;color:#c2410c;display:flex;align-items:center;justify-content:center;}'
    + '.ql-tile span{font-size:11.5px;font-weight:600;text-align:center;line-height:1.15;}'
    // Two floating buttons were sitting on the same corner: this launcher (left:16px, bottom:20px,
    // z-index 99990) and the global era-fab (left:16px, bottom:16px, z-index 9990). The launcher
    // won on z-index, so the orange FAB showed as a crescent poking out from behind it. While this
    // launcher is on screen it is the single corner control, so the FAB and its menu are hidden.
    // Done as a CSS rule rather than by touching the element, because era-fab builds itself on
    // DOMContentLoaded and may not exist yet when this script runs -- a rule covers it either way.
    + 'body.ql-active #eraFab,body.ql-active #eraFabMenu{display:none !important;}';
  var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);

  function svg(inner, s) { return '<svg width="' + (s || 18) + '" height="' + (s || 18) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>'; }

  var btn = document.createElement('button'); btn.className = 'ql-btn'; btn.setAttribute('aria-label', 'Quick access');
  btn.innerHTML = svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>', 20);
  document.body.appendChild(btn);

  var ov = document.createElement('div'); ov.className = 'ql-ov'; document.body.appendChild(ov);
  var sheet = document.createElement('div'); sheet.className = 'ql-sheet';
  document.body.appendChild(sheet);

  // ---- Fold the era-fab's tools into this sheet -----------------------------------------------
  // Live chat, search and shortcuts register themselves with ERA.FAB, so hiding the FAB without
  // adopting them would simply delete those features. We capture every registration and render
  // them here instead, which is what makes this the single corner control rather than a rival one.
  var TOOLS = [];
  function recordTool(item) {
    if (!item || !item.key) return;
    TOOLS = TOOLS.filter(function (x) { return x.key !== item.key; });
    TOOLS.push(item);
  }
  (function captureFabItems() {
    var E = (window.ERA = window.ERA || {});
    // Anything registered before era-fab.js defined ERA.FAB is still sitting in the queue.
    if (E._fabQueue && E._fabQueue.length) E._fabQueue.forEach(recordTool);
    function wrap() {
      if (!E.FAB || !E.FAB.add || E.FAB.__qlWrapped) return !!(E.FAB && E.FAB.__qlWrapped);
      var orig = E.FAB.add;
      E.FAB.add = function (item) { recordTool(item); return orig.call(E.FAB, item); };
      E.FAB.__qlWrapped = true;
      return true;
    }
    // era-fab.js and the help-chat widget load after this script, so poll briefly until ERA.FAB
    // exists rather than assuming an order that a deferred/injected script could change.
    if (!wrap()) {
      var iv = setInterval(function () { if (wrap()) clearInterval(iv); }, 120);
      setTimeout(function () { clearInterval(iv); }, 8000);
    }
  })();

  // Which portal tiles this viewer may see, per the server. null = not answered yet.
  var ALLOW = null;
  fetch('/api/portal/quick-access', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : { allow: [] }; })
    .then(function (d) { ALLOW = (d && d.allow) || []; })
    // Fail closed: on error the viewer sees no portal tiles rather than tiles they may not hold.
    .catch(function () { ALLOW = []; });

  // Built on every open, not once at load, so tools that register late (the help widget is
  // injected after this script) are present the first time someone actually opens the sheet.
  function render() {
    var allow = ALLOW || [];
    var tiles = TILES.filter(function (t) { return allow.indexOf(t[0]) !== -1; }).map(function (t) {
      return '<a class="ql-tile" href="' + t[1] + '"><span class="ic">' + svg(t[3], 18) + '</span><span>' + t[2] + '</span></a>';
    }).join('');
    var tools = TOOLS.map(function (it, i) {
      return '<button class="ql-tile" data-tool="' + i + '" type="button"><span class="ic">' + (it.icon || '') + '</span><span>' + it.label + '</span></button>';
    }).join('');

    sheet.innerHTML = '<div class="ql-grip"></div>'
      + (tiles ? '<div class="ql-h">Quick access</div><div class="ql-grid">' + tiles + '</div>' : '')
      + (tools ? '<div class="ql-h" style="margin-top:14px;">Tools</div><div class="ql-grid">' + tools + '</div>' : '')
      + (tiles || tools ? '' : '<p style="margin:4px 4px 14px;font-size:12.5px;color:#6b6154;">Nothing available here yet.</p>');

    sheet.querySelectorAll('[data-tool]').forEach(function (b) {
      b.addEventListener('click', function () {
        var it = TOOLS[parseInt(b.getAttribute('data-tool'), 10)];
        close();
        if (it && it.onClick) it.onClick();
      });
    });
  }

  function open() { render(); ov.classList.add('open'); sheet.classList.add('open'); }
  function close() { ov.classList.remove('open'); sheet.classList.remove('open'); }
  btn.addEventListener('click', open);
  ov.addEventListener('click', close);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

  // Avoid two quick-access UIs on one screen: on desktop, the home page already
  // shows the #qaRail side rail, so this floating launcher is redundant there and
  // its open sheet reads as an overlap. Hide the launcher only when the rail is
  // present AND we're at desktop width; keep it on mobile and on desktop
  // sub-pages that have no rail.
  function syncVisibility() {
    var hasRail = !!document.getElementById('qaRail');
    var desktop = window.matchMedia('(min-width:1024px)').matches;
    var hide = hasRail && desktop;
    btn.style.display = hide ? 'none' : '';
    if (hide) close();
    // Only suppress the era-fab while this launcher is actually the visible control. When the
    // launcher steps aside for the desktop rail, the FAB is the only corner control left and must
    // come back rather than leaving the user with none.
    document.body.classList.toggle('ql-active', !hide);
  }
  syncVisibility();
  window.addEventListener('resize', syncVisibility);
})();
