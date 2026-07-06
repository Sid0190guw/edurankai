/* Aquin — the in-house AquinTutor assistant widget. Self-contained, no deps.
   Streams from /api/aquintutor/assistant (own-LLM gateway; Claude fallback).
   Dedicated AquinTutor branding — replaces the EduRankAI help chat on AquinTutor
   pages. No emoji; SVG glyphs only. */
(function () {
  if (window.__aquinChat) return; window.__aquinChat = true;
  var CSS = ''
    + '.aqc-btn{position:fixed;right:20px;bottom:20px;z-index:99998;display:inline-flex;align-items:center;gap:9px;background:#1a1510;color:#faf6ef;border:none;border-radius:99px;padding:12px 18px 12px 15px;font-family:"Inter Tight",system-ui,sans-serif;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 10px 30px rgba(0,0,0,.28);transition:transform .12s,box-shadow .2s;}'
    + '.aqc-btn:hover{transform:translateY(-2px);box-shadow:0 16px 40px rgba(0,0,0,.34);}'
    + '.aqc-btn .aqc-dot{width:8px;height:8px;border-radius:50%;background:#c2410c;box-shadow:0 0 8px #c2410c;}'
    + '.aqc-panel{position:fixed;right:20px;bottom:20px;z-index:99999;width:380px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 40px);background:#faf6ef;border:1px solid #e6ddcd;border-radius:20px;box-shadow:0 30px 70px rgba(26,21,16,.3);display:none;flex-direction:column;overflow:hidden;font-family:"Inter Tight",system-ui,sans-serif;}'
    + '.aqc-panel.open{display:flex;animation:aqcIn .18s ease;}'
    + '@keyframes aqcIn{from{opacity:0;transform:translateY(10px) scale(.98);}to{opacity:1;transform:none;}}'
    + '.aqc-head{display:flex;align-items:center;gap:11px;padding:15px 16px;border-bottom:1px solid #eee3d2;background:linear-gradient(180deg,#fff,#faf6ef);}'
    + '.aqc-mark{width:34px;height:34px;border-radius:10px;background:#1a1510;color:#faf6ef;display:flex;align-items:center;justify-content:center;font-family:Fraunces,Georgia,serif;font-weight:600;font-size:18px;flex-shrink:0;}'
    + '.aqc-h-t{font-family:Fraunces,Georgia,serif;font-size:16px;font-weight:600;color:#1a1510;line-height:1.1;}'
    + '.aqc-h-s{font-family:"JetBrains Mono",monospace;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:#9a8f7d;margin-top:2px;}'
    + '.aqc-x{margin-left:auto;background:transparent;border:none;color:#9a8f7d;cursor:pointer;padding:6px;border-radius:8px;display:flex;}.aqc-x:hover{background:#efe6d6;color:#1a1510;}'
    + '.aqc-body{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:11px;}'
    + '.aqc-msg{max-width:86%;padding:10px 13px;border-radius:14px;font-size:14px;line-height:1.55;white-space:pre-wrap;word-break:break-word;}'
    + '.aqc-me{align-self:flex-end;background:#c2410c;color:#fff;border-bottom-right-radius:5px;}'
    + '.aqc-ai{align-self:flex-start;background:#fff;color:#1a1510;border:1px solid #ece2d1;border-bottom-left-radius:5px;}'
    + '.aqc-chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:2px;}'
    + '.aqc-chip{background:#fff;border:1px solid #e6ddcd;border-radius:99px;padding:7px 12px;font-size:12.5px;color:#5a5145;cursor:pointer;}.aqc-chip:hover{border-color:#c2410c;color:#c2410c;}'
    + '.aqc-foot{padding:11px;border-top:1px solid #eee3d2;display:flex;gap:8px;align-items:flex-end;background:#fff;}'
    + '.aqc-in{flex:1;resize:none;border:1px solid #e6ddcd;border-radius:12px;padding:10px 12px;font-family:inherit;font-size:14px;color:#1a1510;outline:none;max-height:110px;background:#faf6ef;}'
    + '.aqc-in:focus{border-color:#c2410c;}'
    + '.aqc-send{background:#c2410c;color:#fff;border:none;border-radius:12px;width:42px;height:42px;flex-shrink:0;cursor:pointer;display:flex;align-items:center;justify-content:center;}'
    + '.aqc-send:disabled{opacity:.5;cursor:default;}'
    + '.aqc-note{font-family:"JetBrains Mono",monospace;font-size:9.5px;color:#a89d8a;text-align:center;padding:0 12px 9px;}'
    + '@media(max-width:480px){.aqc-panel{right:8px;bottom:8px;width:calc(100vw - 16px);}}';
  var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);

  function svg(d, s) { return '<svg width="' + (s || 18) + '" height="' + (s || 18) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>'; }

  var btn = document.createElement('button'); btn.className = 'aqc-btn';
  btn.innerHTML = '<span class="aqc-dot"></span>' + svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>') + '<span>Ask Aquin</span>';
  document.body.appendChild(btn);

  var panel = document.createElement('div'); panel.className = 'aqc-panel';
  panel.innerHTML =
    '<div class="aqc-head"><div class="aqc-mark">A</div><div><div class="aqc-h-t">Aquin</div><div class="aqc-h-s">AquinTutor assistant</div></div>'
    + '<button class="aqc-x" aria-label="Close">' + svg('<path d="M18 6 6 18M6 6l12 12"/>') + '</button></div>'
    + '<div class="aqc-body" id="aqcBody"></div>'
    + '<div class="aqc-foot"><textarea class="aqc-in" id="aqcIn" rows="1" placeholder="Ask about AquinTutor, or get unstuck…"></textarea>'
    + '<button class="aqc-send" id="aqcSend" aria-label="Send">' + svg('<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>') + '</button></div>'
    + '<div class="aqc-note">Aquin is a study aid and can make mistakes. It won\'t give final answers to homework.</div>';
  document.body.appendChild(panel);

  var body = panel.querySelector('#aqcBody'), inp = panel.querySelector('#aqcIn'), send = panel.querySelector('#aqcSend');
  var history = [], busy = false, greeted = false;

  function open() { panel.classList.add('open'); btn.style.display = 'none'; if (!greeted) { greet(); greeted = true; } inp.focus(); }
  function close() { panel.classList.remove('open'); btn.style.display = 'inline-flex'; }
  btn.addEventListener('click', open); panel.querySelector('.aqc-x').addEventListener('click', close);

  function bubble(role, text) { var d = document.createElement('div'); d.className = 'aqc-msg ' + (role === 'me' ? 'aqc-me' : 'aqc-ai'); d.textContent = text; body.appendChild(d); body.scrollTop = body.scrollHeight; return d; }
  function greet() {
    bubble('ai', "Hello. I'm Aquin, your AquinTutor guide. Ask me how anything here works, or tell me what you're stuck on and I'll coach you to it.");
    var c = document.createElement('div'); c.className = 'aqc-chips';
    ['Which stage is right for me?', 'What are the virtual labs?', 'Help me start a learning path', 'How does verified learning work?'].forEach(function (q) {
      var b = document.createElement('button'); b.className = 'aqc-chip'; b.textContent = q; b.addEventListener('click', function () { c.remove(); ask(q); }); c.appendChild(b);
    });
    body.appendChild(c);
  }

  inp.addEventListener('input', function () { inp.style.height = 'auto'; inp.style.height = Math.min(110, inp.scrollHeight) + 'px'; });
  inp.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } });
  send.addEventListener('click', function () { ask(); });

  function ask(preset) {
    if (busy) return; var text = preset || inp.value.trim(); if (!text) return;
    bubble('me', text); history.push({ role: 'user', content: text });
    inp.value = ''; inp.style.height = 'auto'; busy = true; send.disabled = true;
    var out = bubble('ai', ''); out.textContent = '…'; var acc = '';
    fetch('/api/aquintutor/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ messages: history.slice(-16) }) })
      .then(function (res) {
        if (!res.ok || !res.body) { return res.json().then(function (j) { throw new Error(j.error || 'unavailable'); }); }
        var reader = res.body.getReader(), dec = new TextDecoder(), buf = ''; out.textContent = '';
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) { done(acc); return; }
            buf += dec.decode(r.value, { stream: true }); var lines = buf.split('\n'); buf = lines.pop() || '';
            lines.forEach(function (line) { var s = line.trim(); if (!s.indexOf('data:') === 0 && !s.startsWith('data:')) return; if (!s.startsWith('data:')) return;
              try { var j = JSON.parse(s.slice(5).trim()); if (j.t) { acc += j.t; out.textContent = acc; body.scrollTop = body.scrollHeight; } else if (j.error) { out.textContent = j.error; } } catch (e) {} });
            return pump();
          });
        }
        return pump();
      })
      .catch(function (e) { out.textContent = (e && e.message) || 'Aquin is unavailable right now.'; done(''); });
    function done(t) { if (t) history.push({ role: 'assistant', content: t }); busy = false; send.disabled = false; }
  }
})();
