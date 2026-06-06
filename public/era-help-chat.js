/* era-help-chat.js
   In-house live chat widget. Visitor messages land in /admin/help (the team
   inbox). Polls every 5s for admin replies.
   Loaded site-wide via BaseLayout.
   Coexists with the AI assistant - this is human help; AI is a separate tab.
*/
(function() {
  if (window.__eraHelpInit) return;
  window.__eraHelpInit = true;

  var STORAGE_KEY = 'era_help_chat_open';
  var LAST_TS_KEY = 'era_help_last_ts';
  var INTAKE_KEY = 'era_help_intake';
  var conversationId = null;
  var lastTs = null;
  var pollTimer = null;
  var widgetEl = null;
  var streamEl = null;
  var unreadDot = null;
  var intake = null; // { name, email, dob, phone }

  function loadIntake() {
    try {
      var raw = localStorage.getItem(INTAKE_KEY);
      if (!raw) return null;
      var v = JSON.parse(raw);
      if (v && v.name && v.email) return v;
    } catch (_) {}
    return null;
  }
  function saveIntake(v) {
    try { localStorage.setItem(INTAKE_KEY, JSON.stringify(v)); } catch (_) {}
  }

  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (k === 'style') e.style.cssText = attrs[k];
        else if (k === 'class') e.className = attrs[k];
        else e.setAttribute(k, attrs[k]);
      }
    }
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function escapeHtml(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function formatTime(iso) {
    try { return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
  }
  function scrollBottom() {
    if (streamEl) streamEl.scrollTop = streamEl.scrollHeight;
  }

  function renderMessage(m) {
    var isAdmin = m.sender_role === 'admin';
    var isSystem = m.sender_role === 'system';
    var wrap = el('div', { style: 'display:flex;flex-direction:column;align-items:' + (isAdmin ? 'flex-start' : 'flex-end') + ';margin-bottom:10px;' });
    if (!isSystem) {
      wrap.appendChild(el('p', { style: 'font-size:10px;color:rgba(255,255,255,0.45);margin:0 0 3px;font-family:ui-monospace,monospace;' }, (isAdmin ? (m.sender_name || 'Support') : 'You') + ' &middot; ' + formatTime(m.created_at)));
    }
    wrap.appendChild(el('div', {
      style: 'max-width:88%;padding:8px 12px;border-radius:12px;font-size:13.5px;line-height:1.5;word-wrap:break-word;white-space:pre-wrap;' + (
        isSystem
          ? 'background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.6);font-style:italic;align-self:center;text-align:center;font-size:11.5px;max-width:90%;'
          : isAdmin
            ? 'background:#15151a;color:#e8e8ee;border:1px solid rgba(255,255,255,0.08);'
            : 'background:#FF4F00;color:#fff;'
      )
    }, escapeHtml(m.body).replace(/\n/g, '<br/>')));
    return wrap;
  }

  function appendMessages(msgs) {
    if (!streamEl) return;
    var emptyState = document.getElementById('eraHelpEmpty');
    if (emptyState && msgs.length > 0) emptyState.style.display = 'none';
    msgs.forEach(function(m) { streamEl.appendChild(renderMessage(m)); });
    scrollBottom();
  }

  function start(initialMessage) {
    var body = {};
    if (intake) {
      body.name = intake.name;
      body.email = intake.email;
      body.dob = intake.dob;
      body.phone = intake.phone;
    } else if (window.__eraUser) {
      body.name = window.__eraUser.name;
      body.email = window.__eraUser.email;
    }
    body.path = location.pathname;
    if (initialMessage) body.initialMessage = initialMessage;
    return fetch('/api/help/start', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function(r) { return r.json(); });
  }

  function setStage(stage) {
    if (!widgetEl) return;
    widgetEl.setAttribute('data-stage', stage);
  }

  function send(text) {
    return fetch('/api/help/send', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: text }),
    }).then(function(r) { return r.json(); });
  }

  function poll() {
    if (!conversationId) return;
    fetch('/api/help/poll?since=' + encodeURIComponent(lastTs || ''), { credentials: 'same-origin' })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (!d.ok || !d.messages) return;
        if (d.messages.length > 0) {
          appendMessages(d.messages);
          lastTs = d.messages[d.messages.length - 1].created_at;
          try { localStorage.setItem(LAST_TS_KEY, lastTs); } catch (_) {}
          // If widget is closed but admin replied, show unread dot
          if (!widgetEl.classList.contains('era-help-open') && d.messages.some(function(m) { return m.sender_role === 'admin'; })) {
            if (unreadDot) unreadDot.style.display = 'block';
          }
        }
      })
      .catch(function() {});
  }

  function openWidget() {
    widgetEl.classList.add('era-help-open');
    if (unreadDot) unreadDot.style.display = 'none';
    try { localStorage.setItem(STORAGE_KEY, '1'); } catch (_) {}
    // If we already have intake + conversation, go straight to chat
    if (intake && conversationId) {
      setStage('chat');
      setTimeout(function() { var inp = document.getElementById('eraHelpInput'); if (inp) inp.focus(); }, 250);
      return;
    }
    // If we have intake (returning visitor) but no conversation, bootstrap silently
    if (intake && !conversationId) {
      setStage('chat');
      start().then(function(d) {
        if (d.ok) {
          conversationId = d.conversationId;
          if (d.messages && d.messages.length > 0) {
            appendMessages(d.messages);
            lastTs = d.messages[d.messages.length - 1].created_at;
          }
        }
      });
      setTimeout(function() { var inp = document.getElementById('eraHelpInput'); if (inp) inp.focus(); }, 250);
      return;
    }
    // First-time visitor: show topics screen first (lets users self-serve before
    // dropping into intake form). Skip via the "Type my own question" link.
    setStage('topics');
    setTimeout(function() {
      var nameInp = document.querySelector('#eraHelpIntakeForm [name="name"]');
      if (nameInp) nameInp.focus();
    }, 250);
  }

  function closeWidget() {
    widgetEl.classList.remove('era-help-open');
    try { localStorage.setItem(STORAGE_KEY, '0'); } catch (_) {}
  }

  function buildUI() {
    if (document.getElementById('eraHelpWidget')) return;
    var styleEl = el('style', null,
      '#eraHelpWidget{position:fixed;bottom:max(16px,env(safe-area-inset-bottom,16px));right:16px;z-index:9990;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,system-ui,sans-serif;}' +
      '#eraHelpLauncher{width:54px;height:54px;border-radius:50%;background:#FF4F00;border:none;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 22px rgba(255,79,0,0.42);transition:transform 0.15s;position:relative;}' +
      '#eraHelpLauncher:hover{transform:translateY(-2px);}' +
      '#eraHelpUnread{display:none;position:absolute;top:6px;right:6px;width:10px;height:10px;border-radius:50%;background:#fff;border:2px solid #FF4F00;}' +
      '#eraHelpPanel{display:none;position:fixed;bottom:max(80px,env(safe-area-inset-bottom,16px) + 80px);right:16px;width:360px;max-width:calc(100vw - 32px);height:540px;max-height:calc(100vh - 120px);background:#0a0a0c;border:1px solid #1a1a1f;border-radius:16px;overflow:hidden;flex-direction:column;box-shadow:0 16px 48px rgba(0,0,0,0.6);}' +
      '#eraHelpWidget.era-help-open #eraHelpPanel{display:flex;}' +
      '#eraHelpWidget.era-help-open #eraHelpLauncher{transform:scale(0.85);opacity:0.85;}' +
      '#eraHelpHeader{padding:14px 16px;background:linear-gradient(135deg,#FF4F00,#FF7040);color:#fff;display:flex;align-items:center;gap:12px;}' +
      '#eraHelpAvatar{flex-shrink:0;width:40px;height:40px;border-radius:50%;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.18);}' +
      '#eraHelpHeaderInfo{flex:1;min-width:0;}' +
      '#eraHelpTopics{display:none;padding:18px 16px 16px;background:#08080a;flex:1;overflow-y:auto;}' +
      '#eraHelpWidget[data-stage="topics"] #eraHelpTopics{display:block;}' +
      '#eraHelpWidget[data-stage="topics"] #eraHelpStream,#eraHelpWidget[data-stage="topics"] #eraHelpForm,#eraHelpWidget[data-stage="topics"] #eraHelpFoot{display:none;}' +
      '.era-topics-greet{font-size:15px;color:#fff;margin:0 0 4px;font-weight:600;line-height:1.4;}' +
      '.era-topics-sub{font-size:12px;color:#9aa6b6;margin:0 0 14px;line-height:1.5;}' +
      '.era-topics-section{margin:14px 0 8px;}' +
      '.era-topics-section-label{font-size:10px;color:#FF7040;font-family:ui-monospace,monospace;letter-spacing:0.12em;text-transform:uppercase;font-weight:700;}' +
      '.era-topics-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;}' +
      '.era-topic{background:#15151a;border:1px solid #1a1a1f;color:#d8d8de;border-radius:10px;padding:10px 11px;font-size:11.5px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:7px;text-align:left;font-family:inherit;transition:border-color 0.12s, transform 0.12s;}' +
      '.era-topic:hover{border-color:#FF4F00;transform:translateY(-1px);}' +
      '.era-topic svg{flex-shrink:0;color:#FF7040;}' +
      '.era-topic span{flex:1;line-height:1.25;}' +
      '.era-topic-skip{margin-top:14px;background:transparent;border:none;color:#FF7040;font-size:12px;cursor:pointer;width:100%;padding:8px;font-weight:600;font-family:inherit;}' +
      '.era-topic-skip:hover{text-decoration:underline;}' +
      '#eraHelpHeader h3{font-size:14px;font-weight:700;margin:0;}' +
      '#eraHelpHeader p{font-size:11px;margin:2px 0 0;opacity:0.9;font-family:ui-monospace,monospace;letter-spacing:0.08em;text-transform:uppercase;}' +
      '#eraHelpClose{background:rgba(0,0,0,0.2);border:none;color:#fff;width:28px;height:28px;border-radius:6px;cursor:pointer;font-size:18px;line-height:1;}' +
      '#eraHelpStream{flex:1;overflow-y:auto;padding:14px;background:#08080a;}' +
      '#eraHelpEmpty{text-align:center;color:#a0a0ab;font-size:13px;padding:24px 14px;line-height:1.6;}' +
      '#eraHelpIntake{padding:16px;background:#08080a;flex:1;overflow-y:auto;display:none;flex-direction:column;}' +
      '#eraHelpIntake h4{font-size:14px;color:#fff;margin:0 0 4px;font-weight:700;}' +
      '#eraHelpIntake .lead{font-size:12px;color:#a0a0ab;margin:0 0 14px;line-height:1.55;}' +
      '#eraHelpIntake label{display:block;font-size:10px;font-weight:700;color:#a0a0ab;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:5px;font-family:ui-monospace,monospace;}' +
      '#eraHelpIntake input,#eraHelpIntake textarea{width:100%;background:#15151a;border:1px solid #1a1a1f;color:#fff;border-radius:8px;padding:9px 12px;font-size:13px;font-family:inherit;outline:none;box-sizing:border-box;}' +
      '#eraHelpIntake input:focus,#eraHelpIntake textarea:focus{border-color:#FF4F00;}' +
      '#eraHelpIntake .field{margin-bottom:11px;}' +
      '#eraHelpIntake .row{display:flex;gap:8px;}' +
      '#eraHelpIntake .row .field{flex:1;}' +
      '#eraHelpIntake .submit{background:#FF4F00;border:none;color:#fff;border-radius:8px;padding:11px 16px;font-size:13.5px;font-weight:600;cursor:pointer;width:100%;margin-top:6px;}' +
      '#eraHelpIntake .submit:hover{background:#FF7040;}' +
      '#eraHelpIntake .submit:disabled{opacity:0.6;cursor:not-allowed;}' +
      '#eraHelpIntake .err{display:none;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);color:#fca5a5;font-size:11.5px;padding:7px 10px;border-radius:6px;margin-bottom:10px;}' +
      '#eraHelpIntake .privacy{font-size:10.5px;color:#6e6e78;margin:10px 0 0;line-height:1.5;text-align:center;}' +
      '#eraHelpWidget[data-stage="intake"] #eraHelpIntake{display:flex;}' +
      '#eraHelpWidget[data-stage="intake"] #eraHelpStream,#eraHelpWidget[data-stage="intake"] #eraHelpForm{display:none;}' +
      '#eraHelpForm{padding:10px;border-top:1px solid #1a1a1f;background:#0a0a0c;display:flex;gap:8px;align-items:flex-end;}' +
      '#eraHelpInput{flex:1;background:#15151a;border:1px solid #1a1a1f;color:#fff;border-radius:8px;padding:8px 12px;font-size:14px;font-family:inherit;outline:none;resize:none;line-height:1.4;max-height:120px;min-height:38px;}' +
      '#eraHelpInput:focus{border-color:#FF4F00;}' +
      '#eraHelpSend{background:#FF4F00;border:none;color:#fff;border-radius:8px;width:38px;height:38px;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;}' +
      '#eraHelpSend:hover{background:#FF7040;}' +
      '#eraHelpSend:disabled{opacity:0.5;cursor:not-allowed;}' +
      '#eraHelpFoot{font-size:10px;color:#6e6e78;text-align:center;padding:6px 14px 10px;background:#0a0a0c;font-family:ui-monospace,monospace;letter-spacing:0.04em;}' +
      '@media(max-width:480px){#eraHelpPanel{right:8px;left:8px;width:auto;height:78vh;max-height:78vh;bottom:80px;}}'
    );
    document.head.appendChild(styleEl);

    widgetEl = el('div', { id: 'eraHelpWidget' });

    // Panel
    var panel = el('div', { id: 'eraHelpPanel' });
    // Persona header — avatar + tagline. Inspired by airline / fintech assistants.
    var header = el('div', { id: 'eraHelpHeader' });
    var avatar = el('div', { id: 'eraHelpAvatar' });
    avatar.innerHTML = '<svg viewBox="0 0 40 40" width="40" height="40"><defs><linearGradient id="eraG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FF7040"/><stop offset="1" stop-color="#d63b00"/></linearGradient></defs><circle cx="20" cy="20" r="20" fill="url(#eraG)"/><text x="50%" y="56%" text-anchor="middle" font-size="16" font-weight="800" fill="#fff" font-family="\'Inter Tight\', sans-serif">E</text></svg>';
    var headerInfo = el('div', { id: 'eraHelpHeaderInfo' });
    headerInfo.appendChild(el('h3', null, 'Era · EduRankAI Assistant'));
    headerInfo.appendChild(el('p', null, 'Real humans &middot; English &middot; Hindi'));
    var closeBtn = el('button', { id: 'eraHelpClose', type: 'button', 'aria-label': 'Close chat' }, '&times;');
    header.appendChild(avatar);
    header.appendChild(headerInfo);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // Quick-topic categories (shown only on first open before intake)
    var topics = el('div', { id: 'eraHelpTopics' });
    topics.innerHTML =
      '<p class="era-topics-greet">Hi, I\'m <strong>Era</strong>. How may I help you today?</p>' +
      '<p class="era-topics-sub">Pick a topic or type your question below.</p>' +
      '<div class="era-topics-section"><span class="era-topics-section-label">For applicants</span></div>' +
      '<div class="era-topics-grid">' +
        '<button type="button" class="era-topic" data-topic="application_status"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span>Application status</span></button>' +
        '<button type="button" class="era-topic" data-topic="open_roles"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg><span>Open roles</span></button>' +
        '<button type="button" class="era-topic" data-topic="submit_work"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg><span>Submit my work</span></button>' +
      '</div>' +
      '<div class="era-topics-section"><span class="era-topics-section-label">For test takers</span></div>' +
      '<div class="era-topics-grid">' +
        '<button type="button" class="era-topic" data-topic="test_help"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg><span>Test or proctoring</span></button>' +
        '<button type="button" class="era-topic" data-topic="verify_cert"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/></svg><span>Verify a credential</span></button>' +
        '<button type="button" class="era-topic" data-topic="payment"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg><span>Payment / refund</span></button>' +
      '</div>' +
      '<div class="era-topics-section"><span class="era-topics-section-label">For Campus Ambassadors</span></div>' +
      '<div class="era-topics-grid">' +
        '<button type="button" class="era-topic" data-topic="ca_report"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg><span>Submit CA report</span></button>' +
        '<button type="button" class="era-topic" data-topic="ca_perks"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg><span>Perks &amp; rewards</span></button>' +
      '</div>' +
      '<button type="button" class="era-topic-skip">Type my own question →</button>';
    panel.appendChild(topics);

    // Intake form (shown until visitor provides contact details)
    var intakeEl = el('div', { id: 'eraHelpIntake' });
    intakeEl.innerHTML =
      '<h4>Before we start</h4>' +
      '<p class="lead">A few details so the team can reach you if we are offline or need to follow up by email or phone.</p>' +
      '<div class="err" id="eraHelpIntakeErr"></div>' +
      '<form id="eraHelpIntakeForm" novalidate>' +
        '<div class="field"><label>Name</label><input name="name" required maxlength="200" autocomplete="name" placeholder="Your full name" /></div>' +
        '<div class="field"><label>Email</label><input name="email" type="email" required maxlength="255" autocomplete="email" placeholder="you@example.com" /></div>' +
        '<div class="row">' +
          '<div class="field"><label>Date of birth</label><input name="dob" type="date" required /></div>' +
          '<div class="field"><label>Phone</label><input name="phone" type="tel" required maxlength="40" autocomplete="tel" placeholder="+91 98xxxxxxxx" /></div>' +
        '</div>' +
        '<div class="field"><label>Your message</label><textarea name="initialMessage" required rows="3" maxlength="5000" placeholder="What can we help with?"></textarea></div>' +
        '<button type="submit" class="submit" id="eraHelpIntakeSubmit">Start the conversation</button>' +
        '<p class="privacy">We use these only to reply to your enquiry. No marketing, no third parties.</p>' +
      '</form>';
    panel.appendChild(intakeEl);

    streamEl = el('div', { id: 'eraHelpStream' });
    streamEl.appendChild(el('p', { id: 'eraHelpEmpty' }, 'Hi! Send a message and a real person from our team will get back to you. We monitor during India working hours.'));
    panel.appendChild(streamEl);

    var form = el('form', { id: 'eraHelpForm' });
    var input = el('textarea', { id: 'eraHelpInput', rows: '1', placeholder: 'Type a message...', maxlength: '5000' });
    var sendBtn = el('button', { id: 'eraHelpSend', type: 'submit', 'aria-label': 'Send' });
    sendBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
    form.appendChild(input);
    form.appendChild(sendBtn);
    panel.appendChild(form);

    panel.appendChild(el('p', { id: 'eraHelpFoot' }, 'in-house chat &middot; not a bot'));

    // Launcher
    var launcher = el('button', { id: 'eraHelpLauncher', type: 'button', 'aria-label': 'Open chat' });
    launcher.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';
    unreadDot = el('span', { id: 'eraHelpUnread' });
    launcher.appendChild(unreadDot);

    widgetEl.appendChild(panel);
    widgetEl.appendChild(launcher);
    document.body.appendChild(widgetEl);

    launcher.addEventListener('click', function() {
      if (widgetEl.classList.contains('era-help-open')) closeWidget();
      else openWidget();
    });
    closeBtn.addEventListener('click', closeWidget);

    // Topic chip clicks — route to internal pages instead of waiting on a human
    var TOPIC_ROUTES = {
      application_status: { url: '/portal/applications', message: 'I want to check the status of my application.' },
      open_roles:         { url: '/careers',             message: 'Show me current open roles.' },
      submit_work:        { url: '/portal/submissions/new', message: 'I want to submit my original work.' },
      test_help:          { url: '/aquintutor/tests',    message: 'I need help with a test or proctoring.' },
      verify_cert:        { url: '/credentials/',        message: 'I want to verify a credential.' },
      payment:            { url: '/portal/payments',     message: 'I have a question about a payment or refund.' },
      ca_report:          { url: '/portal/submissions/new', message: 'I want to submit my Campus Ambassador report.' },
      ca_perks:           { url: '/careers/campus-ambassador', message: 'Tell me about Campus Ambassador perks and rewards.' },
    };
    document.addEventListener('click', function(e) {
      var t = e.target;
      while (t && t !== widgetEl) {
        if (t.classList && t.classList.contains('era-topic') && t.getAttribute('data-topic')) {
          var topic = t.getAttribute('data-topic');
          var route = TOPIC_ROUTES[topic];
          if (route && route.url) { window.location.href = route.url; return; }
          break;
        }
        if (t.classList && t.classList.contains('era-topic-skip')) {
          // Skip topics, drop into chat/intake as before
          if (intake && conversationId) setStage('chat');
          else if (intake) { setStage('chat'); start(); }
          else setStage('intake');
          return;
        }
        t = t.parentNode;
      }
    });

    // Intake form submit -> save contact details + start conversation + switch to chat stage
    var intakeForm = document.getElementById('eraHelpIntakeForm');
    var intakeSubmit = document.getElementById('eraHelpIntakeSubmit');
    var intakeErr = document.getElementById('eraHelpIntakeErr');
    if (intakeForm) {
      intakeForm.addEventListener('submit', function(e) {
        e.preventDefault();
        var fd = new FormData(intakeForm);
        var v = {
          name: (fd.get('name') || '').toString().trim(),
          email: (fd.get('email') || '').toString().trim().toLowerCase(),
          dob: (fd.get('dob') || '').toString().trim(),
          phone: (fd.get('phone') || '').toString().trim(),
          initialMessage: (fd.get('initialMessage') || '').toString().trim()
        };
        intakeErr.style.display = 'none';
        if (!v.name || v.name.length < 2) { intakeErr.textContent = 'Please enter your name.'; intakeErr.style.display = 'block'; return; }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) { intakeErr.textContent = 'Please enter a valid email.'; intakeErr.style.display = 'block'; return; }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v.dob)) { intakeErr.textContent = 'Please enter your date of birth.'; intakeErr.style.display = 'block'; return; }
        if (!v.phone || v.phone.replace(/\D/g, '').length < 7) { intakeErr.textContent = 'Please enter a valid phone number.'; intakeErr.style.display = 'block'; return; }
        if (!v.initialMessage) { intakeErr.textContent = 'Please type a message.'; intakeErr.style.display = 'block'; return; }

        intakeSubmit.disabled = true;
        var prev = intakeSubmit.textContent;
        intakeSubmit.textContent = 'Starting...';

        intake = { name: v.name, email: v.email, dob: v.dob, phone: v.phone };
        saveIntake(intake);

        start(v.initialMessage).then(function(d) {
          intakeSubmit.disabled = false;
          intakeSubmit.textContent = prev;
          if (!d.ok) {
            intakeErr.textContent = d.error || 'Could not start - try again.';
            intakeErr.style.display = 'block';
            return;
          }
          conversationId = d.conversationId;
          setStage('chat');
          if (d.messages && d.messages.length > 0) {
            appendMessages(d.messages);
            lastTs = d.messages[d.messages.length - 1].created_at;
          }
          setTimeout(function() {
            var inp = document.getElementById('eraHelpInput');
            if (inp) inp.focus();
          }, 100);
        }).catch(function() {
          intakeSubmit.disabled = false;
          intakeSubmit.textContent = prev;
          intakeErr.textContent = 'Network error - try again.';
          intakeErr.style.display = 'block';
        });
      });
    }

    form.addEventListener('submit', function(e) {
      e.preventDefault();
      var text = input.value.trim();
      if (!text) return;
      sendBtn.disabled = true;
      var localMsg = { sender_role: 'visitor', body: text, created_at: new Date().toISOString() };

      function afterStart(done) {
        send(text).then(function(d) {
          sendBtn.disabled = false;
          if (d.ok && d.message) {
            appendMessages([d.message]);
            input.value = '';
            input.style.height = 'auto';
            lastTs = d.message.created_at;
            try { localStorage.setItem(LAST_TS_KEY, lastTs); } catch (_) {}
          } else if (!d.ok && d.error && d.error.indexOf('no session') !== -1) {
            // session disappeared - start fresh and retry once
            start(text).then(function(s) {
              sendBtn.disabled = false;
              if (s.ok) {
                conversationId = s.conversationId;
                if (s.messages) appendMessages(s.messages.slice(-3));
                input.value = '';
              }
            });
          }
        }).catch(function() { sendBtn.disabled = false; });
        if (done) done();
      }

      if (!conversationId) {
        start(text).then(function(d) {
          sendBtn.disabled = false;
          if (d.ok) {
            conversationId = d.conversationId;
            if (d.messages) {
              appendMessages(d.messages);
              lastTs = d.messages.length > 0 ? d.messages[d.messages.length - 1].created_at : null;
            }
            input.value = '';
            input.style.height = 'auto';
          }
        });
      } else {
        afterStart();
      }
    });

    // Enter to send, Shift+Enter newline
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.dispatchEvent(new Event('submit', { cancelable: true })); }
    });
    input.addEventListener('input', function() {
      input.style.height = 'auto';
      input.style.height = Math.min(120, input.scrollHeight) + 'px';
    });

    // Load saved intake (returning visitors skip the form)
    intake = loadIntake();
    setStage(intake ? 'chat' : 'intake');

    // Restore open state from localStorage
    try {
      if (localStorage.getItem(STORAGE_KEY) === '1') openWidget();
      lastTs = localStorage.getItem(LAST_TS_KEY) || null;
    } catch (_) {}

    // Always poll (whether open or closed) so we can show unread dot
    pollTimer = setInterval(poll, 5000);

    // Bootstrap conversation only for returning visitors who have intake on file.
    // First-time visitors will start their conversation when they submit the intake form.
    if (intake) {
      setTimeout(function() {
        start().then(function(d) {
          if (d.ok && d.messages && d.messages.length > 0) {
            conversationId = d.conversationId;
            appendMessages(d.messages);
            lastTs = d.messages[d.messages.length - 1].created_at;
          } else if (d.ok) {
            conversationId = d.conversationId;
          }
        }).catch(function() {});
      }, 2000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildUI);
  } else {
    buildUI();
  }
})();
