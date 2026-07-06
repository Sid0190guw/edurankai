/* Portal quick-access launcher. A floating button that opens a sheet of tiles
   for the employee's key sections — attendance, wallet, leave, profile, learning
   and tools — so everything necessary is one tap away from any portal page.
   Self-contained, no deps, no emoji (SVG glyphs). */
(function () {
  if (window.__quickLaunch) return; window.__quickLaunch = true;

  var TILES = [
    ['/portal', 'Home', '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>'],
    ['/portal/employee', 'Attendance', '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'],
    ['/portal/employee/wallet', 'Wallet', '<path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4"/><path d="M4 6v12c0 1.1.9 2 2 2h14v-4"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>'],
    ['/portal/employee/leave', 'Leave', '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'],
    ['/portal/profile', 'Profile', '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'],
    ['/portal/courses', 'Learn', '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>'],
    ['/portal/discussion', 'Community', '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'],
    ['/portal/wellbeing', 'Wellbeing', '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 1 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/>']
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
    + '.ql-tile span{font-size:11.5px;font-weight:600;text-align:center;line-height:1.15;}';
  var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);

  function svg(inner, s) { return '<svg width="' + (s || 18) + '" height="' + (s || 18) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>'; }

  var btn = document.createElement('button'); btn.className = 'ql-btn'; btn.setAttribute('aria-label', 'Quick access');
  btn.innerHTML = svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>', 20);
  document.body.appendChild(btn);

  var ov = document.createElement('div'); ov.className = 'ql-ov'; document.body.appendChild(ov);
  var sheet = document.createElement('div'); sheet.className = 'ql-sheet';
  var tiles = TILES.map(function (t) {
    return '<a class="ql-tile" href="' + t[0] + '"><span class="ic">' + svg(t[2], 18) + '</span><span>' + t[1] + '</span></a>';
  }).join('');
  sheet.innerHTML = '<div class="ql-grip"></div><div class="ql-h">Quick access</div><div class="ql-grid">' + tiles + '</div>';
  document.body.appendChild(sheet);

  function open() { ov.classList.add('open'); sheet.classList.add('open'); }
  function close() { ov.classList.remove('open'); sheet.classList.remove('open'); }
  btn.addEventListener('click', open);
  ov.addEventListener('click', close);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
})();
