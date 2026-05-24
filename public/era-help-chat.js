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
  var conversationId = null;
  var lastTs = null;
  var pollTimer = null;
  var widgetEl = null;
  var streamEl = null;
  var unreadDot = null;

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
    if (window.__eraUser) {
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
    // Bootstrap conversation if not yet started
    if (!conversationId) {
      start().then(function(d) {
        if (d.ok) {
          conversationId = d.conversationId;
          if (d.messages && d.messages.length > 0) {
            appendMessages(d.messages);
            lastTs = d.messages[d.messages.length - 1].created_at;
          }
        }
      });
    }
    setTimeout(function() {
      var inp = document.getElementById('eraHelpInput');
      if (inp) inp.focus();
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
      '#eraHelpHeader{padding:14px 16px;background:linear-gradient(135deg,#FF4F00,#FF7040);color:#fff;display:flex;justify-content:space-between;align-items:center;}' +
      '#eraHelpHeader h3{font-size:14px;font-weight:700;margin:0;}' +
      '#eraHelpHeader p{font-size:11px;margin:2px 0 0;opacity:0.9;font-family:ui-monospace,monospace;letter-spacing:0.08em;text-transform:uppercase;}' +
      '#eraHelpClose{background:rgba(0,0,0,0.2);border:none;color:#fff;width:28px;height:28px;border-radius:6px;cursor:pointer;font-size:18px;line-height:1;}' +
      '#eraHelpStream{flex:1;overflow-y:auto;padding:14px;background:#08080a;}' +
      '#eraHelpEmpty{text-align:center;color:#a0a0ab;font-size:13px;padding:24px 14px;line-height:1.6;}' +
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
    var header = el('div', { id: 'eraHelpHeader' });
    var headerInfo = el('div');
    headerInfo.appendChild(el('h3', null, 'Talk to us'));
    headerInfo.appendChild(el('p', null, 'Real humans &middot; usually within an hour'));
    var closeBtn = el('button', { id: 'eraHelpClose', type: 'button', 'aria-label': 'Close chat' }, '&times;');
    header.appendChild(headerInfo);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    streamEl = el('div', { id: 'eraHelpStream' });
    streamEl.appendChild(el('p', { id: 'eraHelpEmpty' }, 'Hi! Type a question and a real person from our team will get back to you. We monitor messages during India working hours.'));
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

    // Restore open state from localStorage
    try {
      if (localStorage.getItem(STORAGE_KEY) === '1') openWidget();
      lastTs = localStorage.getItem(LAST_TS_KEY) || null;
    } catch (_) {}

    // Always poll (whether open or closed) so we can show unread dot
    pollTimer = setInterval(poll, 5000);
    // Initial poll after 2s to fetch the conversation if cookie exists from a prior visit
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildUI);
  } else {
    buildUI();
  }
})();
