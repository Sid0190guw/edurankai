/* Lab feedback widget. A small floating button on every virtual-lab page that
   opens a rating + comment form and posts to /api/aquintutor/feedback. Works
   for anonymous visitors (the labs are open). Self-contained, no deps, SVG
   glyphs only (no emoji). Sits bottom-right so it never overlaps the
   bottom-left quick launcher. */
(function () {
  if (window.__labFeedback) return; window.__labFeedback = true;

  var slug = (location.pathname.split('/').pop() || 'lab');
  var CSS = ''
    + '.lf-btn{position:fixed;right:16px;bottom:20px;z-index:99990;display:inline-flex;align-items:center;gap:7px;background:#12100c;color:#faf6ef;border:1px solid #2a2a35;border-radius:99px;padding:9px 15px;font-family:"Geist Mono",ui-monospace,monospace;font-size:11px;font-weight:700;letter-spacing:.04em;cursor:pointer;box-shadow:0 10px 28px rgba(0,0,0,.35);}'
    + '.lf-btn:hover{border-color:#5ee7ff;color:#5ee7ff;}'
    + '.lf-ov{position:fixed;inset:0;z-index:99991;background:rgba(6,7,12,.6);backdrop-filter:blur(3px);display:none;align-items:center;justify-content:center;padding:18px;}'
    + '.lf-ov.open{display:flex;}'
    + '.lf-card{width:100%;max-width:400px;background:#0f1220;border:1px solid #1e2740;border-radius:16px;padding:20px;box-shadow:0 24px 70px rgba(0,0,0,.55);font-family:"Inter Tight",system-ui,sans-serif;color:#e8ecf4;}'
    + '.lf-h{font-family:"Cormorant Garamond",Georgia,serif;font-size:21px;font-weight:600;margin:0 0 3px;}'
    + '.lf-sub{font-size:12.5px;color:#8ea0be;margin:0 0 14px;}'
    + '.lf-stars{display:flex;gap:6px;margin-bottom:14px;}'
    + '.lf-star{cursor:pointer;color:#3a4258;transition:color .1s,transform .1s;}'
    + '.lf-star:hover{transform:scale(1.12);} .lf-star.on{color:#fbbf24;}'
    + '.lf-l{font-family:"Geist Mono",monospace;font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:#8ea0be;font-weight:700;display:block;margin:0 0 5px;}'
    + '.lf-in,.lf-ta{width:100%;box-sizing:border-box;background:#080a12;border:1px solid #26314f;border-radius:8px;padding:9px 11px;color:#e8ecf4;font-family:inherit;font-size:13px;outline:none;margin-bottom:11px;}'
    + '.lf-ta{resize:vertical;min-height:74px;}'
    + '.lf-row{display:flex;gap:9px;}.lf-row>div{flex:1;}'
    + '.lf-send{width:100%;background:linear-gradient(180deg,#7af0ff,#33cfe6);color:#04161b;border:none;border-radius:10px;padding:12px;font-family:"Geist Mono",monospace;font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;}'
    + '.lf-x{background:none;border:none;color:#8ea0be;cursor:pointer;font-size:20px;line-height:1;float:right;padding:0;}'
    + '.lf-ok{text-align:center;padding:14px 0;color:#34d399;font-size:14px;font-weight:600;}';
  var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);

  function svg(inner, s, cls) { return '<svg class="' + (cls || '') + '" width="' + (s || 18) + '" height="' + (s || 18) + '" viewBox="0 0 24 24" fill="currentColor" stroke="none">' + inner + '</svg>'; }
  var STAR = '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>';
  var CHAT = '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';

  var btn = document.createElement('button'); btn.className = 'lf-btn';
  btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>Feedback';
  document.body.appendChild(btn);

  var ov = document.createElement('div'); ov.className = 'lf-ov';
  var starsHtml = '';
  for (var i = 1; i <= 5; i++) starsHtml += '<span class="lf-star" data-n="' + i + '">' + svg(STAR, 26) + '</span>';
  ov.innerHTML = ''
    + '<div class="lf-card">'
    + '<button class="lf-x" data-close>&times;</button>'
    + '<p class="lf-h">How is this lab?</p>'
    + '<p class="lf-sub">Your feedback shapes what we build next. Takes ten seconds.</p>'
    + '<div class="lf-body">'
    + '<div class="lf-stars">' + starsHtml + '</div>'
    + '<label class="lf-l">What worked, what didn\'t?</label>'
    + '<textarea class="lf-ta" id="lf-comment" placeholder="Too easy, too hard, a bug, an idea, anything…"></textarea>'
    + '<div class="lf-row"><div><label class="lf-l">Name (optional)</label><input class="lf-in" id="lf-name" maxlength="120"/></div>'
    + '<div><label class="lf-l">Email (optional)</label><input class="lf-in" id="lf-email" type="email" maxlength="200"/></div></div>'
    + '<button class="lf-send" id="lf-send">Send feedback</button>'
    + '</div>'
    + '<div class="lf-ok" id="lf-ok" style="display:none;">Thank you — feedback received.</div>'
    + '</div>';
  document.body.appendChild(ov);

  var rating = 0;
  var starEls = ov.querySelectorAll('.lf-star');
  function paint(n) { starEls.forEach(function (s) { s.classList.toggle('on', (+s.getAttribute('data-n')) <= n); }); }
  starEls.forEach(function (s) {
    s.addEventListener('mouseenter', function () { paint(+s.getAttribute('data-n')); });
    s.addEventListener('mouseleave', function () { paint(rating); });
    s.addEventListener('click', function () { rating = +s.getAttribute('data-n'); paint(rating); });
  });

  function open() { ov.classList.add('open'); }
  function close() { ov.classList.remove('open'); }
  btn.addEventListener('click', open);
  ov.addEventListener('click', function (e) { if (e.target === ov || e.target.hasAttribute('data-close')) close(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

  document.getElementById('lf-send').addEventListener('click', function () {
    var comment = document.getElementById('lf-comment').value.trim();
    if (!rating && !comment) { document.getElementById('lf-comment').focus(); return; }
    var b = this; b.disabled = true; b.textContent = 'Sending…';
    fetch('/api/aquintutor/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rating: rating, comment: comment, lab: slug, page: location.pathname,
        name: document.getElementById('lf-name').value.trim(),
        email: document.getElementById('lf-email').value.trim()
      })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok) { ov.querySelector('.lf-body').style.display = 'none'; document.getElementById('lf-ok').style.display = 'block'; setTimeout(close, 1400); }
      else { b.disabled = false; b.textContent = 'Send feedback'; }
    }).catch(function () { b.disabled = false; b.textContent = 'Send feedback'; });
  });
})();
