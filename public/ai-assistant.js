// public/ai-assistant.js v2 - Help Assistant, registers with ERA.FAB
(function() {
  var panel, msgList, input, isOpen = false, conversation = [], built = false;
  var WELCOME = "Hi! I'm the EduRankAI help assistant. Ask me about applications, the portal, or how things work here. I can't see your account data - for that, log in.";

  function build() {
    if (built) return;
    built = true;
    panel = document.createElement('div');
    panel.id = 'aiHelpPanel';
    panel.style.cssText = 'position:fixed;bottom:80px;right:16px;width:360px;max-width:calc(100vw - 32px);height:520px;max-height:calc(100vh - 120px);background:#0f0f14;border:1px solid #1a1a1f;border-radius:14px;display:none;flex-direction:column;box-shadow:0 20px 50px rgba(0,0,0,0.5);z-index:9995;overflow:hidden;';
    panel.innerHTML = '\
<div style="background:#08080a;border-bottom:1px solid #1a1a1f;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;">\
  <div style="display:flex;align-items:center;gap:8px;">\
    <div style="width:28px;height:28px;background:#FF4F0022;border-radius:50%;display:flex;align-items:center;justify-content:center;">\
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#FF7040" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>\
    </div>\
    <div>\
      <p style="font-size:13px;font-weight:700;color:#fff;margin:0;">Help Assistant</p>\
      <p style="font-size:10px;color:#10b981;margin:0;display:flex;align-items:center;gap:4px;"><span style="width:6px;height:6px;background:#10b981;border-radius:50%;display:inline-block;"></span> Online</p>\
    </div>\
  </div>\
  <button id="aiCloseBtn" style="background:#15151a;border:1px solid #1a1a1f;color:#8a8a94;width:26px;height:26px;border-radius:6px;cursor:pointer;font-size:16px;line-height:1;">x</button>\
</div>\
<div id="aiMsgList" style="flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;"></div>\
<div style="padding:10px 12px;border-top:1px solid #1a1a1f;background:#08080a;">\
  <div style="display:flex;gap:6px;align-items:flex-end;">\
    <textarea id="aiInput" rows="1" placeholder="Ask a question..." style="flex:1;background:#15151a;border:1px solid #1a1a1f;border-radius:18px;padding:9px 14px;color:#fff;font-size:13px;outline:none;resize:none;min-height:36px;max-height:90px;font-family:inherit;"></textarea>\
    <button id="aiSendBtn" style="width:36px;height:36px;background:#FF4F00;border:none;border-radius:50%;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;">\
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>\
    </button>\
  </div>\
  <p style="font-size:9px;color:#6e6e78;margin:6px 0 0;text-align:center;">Powered by AI - I can not access your account. Log in for that.</p>\
</div>';
    document.body.appendChild(panel);
    msgList = document.getElementById('aiMsgList');
    input = document.getElementById('aiInput');
    document.getElementById('aiCloseBtn').onclick = toggle;
    document.getElementById('aiSendBtn').onclick = send;
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    input.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 90) + 'px';
    });
    addMsg('assistant', WELCOME);
    addQuickReplies();
  }

  function toggle() {
    if (!built) build();
    isOpen = !isOpen;
    panel.style.display = isOpen ? 'flex' : 'none';
    if (isOpen) setTimeout(function() { input.focus(); }, 100);
  }

  function addMsg(role, text) {
    var div = document.createElement('div');
    if (role === 'user') {
      div.style.cssText = 'align-self:flex-end;max-width:80%;background:#FF4F00;color:#fff;padding:8px 12px;border-radius:14px;border-bottom-right-radius:4px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word;';
    } else {
      div.style.cssText = 'align-self:flex-start;max-width:88%;background:#1a1a20;color:#e8e8ee;padding:9px 13px;border-radius:14px;border-bottom-left-radius:4px;font-size:13px;line-height:1.55;white-space:pre-wrap;word-wrap:break-word;';
    }
    div.textContent = text;
    msgList.appendChild(div);
    msgList.scrollTop = msgList.scrollHeight;
  }

  function addQuickReplies() {
    var div = document.createElement('div');
    div.id = 'aiQuickReplies';
    div.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px;padding:6px 0;';
    var replies = ['How do I apply for a job?', 'I forgot my password', 'Track my application', 'What is EduRankAI?'];
    replies.forEach(function(text) {
      var chip = document.createElement('button');
      chip.textContent = text;
      chip.style.cssText = 'background:#15151a;border:1px solid #1a1a1f;color:#FF7040;font-size:11px;font-weight:500;padding:5px 10px;border-radius:100px;cursor:pointer;';
      chip.onclick = function() { input.value = text; send(); };
      div.appendChild(chip);
    });
    msgList.appendChild(div);
  }

  function addTyping() {
    var div = document.createElement('div');
    div.id = 'aiTyping';
    div.style.cssText = 'align-self:flex-start;background:#1a1a20;color:#8a8a94;padding:10px 14px;border-radius:14px;font-size:13px;';
    div.innerHTML = '<span style="display:inline-block;animation:aiPulse 1.4s infinite;">.</span><span style="display:inline-block;animation:aiPulse 1.4s infinite 0.2s;">.</span><span style="display:inline-block;animation:aiPulse 1.4s infinite 0.4s;">.</span>';
    if (!document.getElementById('aiPulseStyle')) {
      var st = document.createElement('style');
      st.id = 'aiPulseStyle';
      st.textContent = '@keyframes aiPulse { 0%,80%,100% { opacity: 0.3; } 40% { opacity: 1; } }';
      document.head.appendChild(st);
    }
    msgList.appendChild(div);
    msgList.scrollTop = msgList.scrollHeight;
  }

  function removeTyping() {
    var t = document.getElementById('aiTyping');
    if (t) t.remove();
  }

  function send() {
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    var qr = document.getElementById('aiQuickReplies');
    if (qr) qr.remove();
    addMsg('user', text);
    conversation.push({ role: 'user', content: text });
    addTyping();
    fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ messages: conversation })
    }).then(function(r) { return r.json(); }).then(function(data) {
      removeTyping();
      if (data.ok && data.reply) {
        addMsg('assistant', data.reply);
        conversation.push({ role: 'assistant', content: data.reply });
      } else {
        addMsg('assistant', data.error || 'Sorry, I had trouble responding. Please try again or contact hr@edurankai.in');
      }
    }).catch(function() {
      removeTyping();
      addMsg('assistant', 'Connection error. Please check your internet and try again.');
    });
  }

  // Register with FAB once it's available
  function register() {
    if (!window.ERA || !window.ERA.FAB) {
      setTimeout(register, 100);
      return;
    }
    window.ERA.FAB.add({
      key: 'ai-help',
      label: 'Help Assistant',
      color: '#a78bfa',
      icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
      onClick: toggle
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', register);
  } else {
    register();
  }
})();
