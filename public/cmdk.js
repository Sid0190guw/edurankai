// public/cmdk.js - Global Cmd+K search palette
// Loads on every admin page
(function() {
  if (!window.location.pathname.startsWith('/admin')) return;

  var modal, input, results, isOpen = false, selectedIdx = 0, lastResults = [];

  function build() {
    modal = document.createElement('div');
    modal.id = 'cmdkModal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:9999;display:none;align-items:flex-start;justify-content:center;padding-top:80px;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);';
    modal.innerHTML = '\
<div id="cmdkBox" style="background:#0f0f14;border:1px solid #1a1a1f;border-radius:14px;width:100%;max-width:580px;box-shadow:0 25px 50px rgba(0,0,0,0.5);overflow:hidden;">\
  <div style="padding:14px 16px;border-bottom:1px solid #1a1a1f;display:flex;align-items:center;gap:10px;">\
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6e6e78" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>\
    <input id="cmdkInput" placeholder="Search applications, users, pages, courses..." style="flex:1;background:transparent;border:none;outline:none;color:#fff;font-size:15px;font-family:inherit;">\
    <span style="background:#15151a;border:1px solid #1a1a1f;border-radius:4px;padding:2px 6px;font-size:10px;color:#6e6e78;font-family:monospace;">ESC</span>\
  </div>\
  <div id="cmdkResults" style="max-height:60vh;overflow-y:auto;padding:6px;"></div>\
  <div style="padding:8px 14px;border-top:1px solid #1a1a1f;display:flex;justify-content:space-between;font-size:10px;color:#6e6e78;">\
    <div><kbd style="background:#15151a;border:1px solid #1a1a1f;border-radius:3px;padding:1px 5px;font-family:monospace;">UP</kbd> <kbd style="background:#15151a;border:1px solid #1a1a1f;border-radius:3px;padding:1px 5px;font-family:monospace;">DOWN</kbd> Navigate</div>\
    <div><kbd style="background:#15151a;border:1px solid #1a1a1f;border-radius:3px;padding:1px 5px;font-family:monospace;">ENTER</kbd> Open</div>\
  </div>\
</div>';
    document.body.appendChild(modal);
    input = document.getElementById('cmdkInput');
    results = document.getElementById('cmdkResults');

    modal.addEventListener('click', function(e) { if (e.target === modal) close(); });
    input.addEventListener('input', search);
    input.addEventListener('keydown', handleKey);
  }

  function open() {
    if (!modal) build();
    isOpen = true;
    modal.style.display = 'flex';
    input.value = '';
    input.focus();
    renderEmpty();
  }

  function close() {
    isOpen = false;
    if (modal) modal.style.display = 'none';
  }

  function renderEmpty() {
    results.innerHTML = '\
<div style="padding:28px 16px;text-align:center;color:#6e6e78;">\
  <p style="font-size:13px;margin:0 0 14px;">Quick actions:</p>\
  <div style="display:flex;flex-direction:column;gap:6px;text-align:left;">\
    <a href="/admin/applications/new" class="cmdk-quick" style="padding:8px 12px;background:#15151a;border:1px solid #1a1a1f;border-radius:8px;color:#d8d8de;text-decoration:none;font-size:13px;display:flex;align-items:center;gap:8px;"><span style="color:#FF7040;">+</span> New Application</a>\
    <a href="/admin/users" class="cmdk-quick" style="padding:8px 12px;background:#15151a;border:1px solid #1a1a1f;border-radius:8px;color:#d8d8de;text-decoration:none;font-size:13px;display:flex;align-items:center;gap:8px;"><span style="color:#FF7040;">+</span> Add User</a>\
    <a href="/admin/offer/blank" class="cmdk-quick" style="padding:8px 12px;background:#15151a;border:1px solid #1a1a1f;border-radius:8px;color:#d8d8de;text-decoration:none;font-size:13px;display:flex;align-items:center;gap:8px;"><span style="color:#FF7040;">+</span> Custom Offer</a>\
    <a href="/admin/messages?new=1" class="cmdk-quick" style="padding:8px 12px;background:#15151a;border:1px solid #1a1a1f;border-radius:8px;color:#d8d8de;text-decoration:none;font-size:13px;display:flex;align-items:center;gap:8px;"><span style="color:#FF7040;">+</span> New Message</a>\
  </div>\
</div>';
  }

  var typeIcons = {
    page: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="9"/></svg>',
    user: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#FF7040" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    application: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    course: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
    institution: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="2"><path d="M3 21h18M5 21V7l8-4 8 4v14M9 9h.01M9 12h.01M9 15h.01"/></svg>',
  };

  var typeColors = {
    page:'#60a5fa', user:'#FF7040', application:'#a78bfa', course:'#10b981', institution:'#fbbf24'
  };

  var debounceTimer;
  function search() {
    var q = input.value.trim();
    if (q.length < 2) { renderEmpty(); return; }
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function() {
      fetch('/api/search?q=' + encodeURIComponent(q), { credentials: 'same-origin' })
        .then(function(r) { return r.json(); })
        .then(function(data) { render(data.results || []); })
        .catch(function() {});
    }, 150);
  }

  function render(items) {
    lastResults = items;
    selectedIdx = 0;
    if (items.length === 0) {
      results.innerHTML = '<div style="padding:28px;text-align:center;color:#6e6e78;font-size:13px;">No results</div>';
      return;
    }
    var html = '';
    items.forEach(function(item, i) {
      var color = typeColors[item.type] || '#6e6e78';
      var icon = typeIcons[item.type] || '';
      html += '<a href="' + item.url + '" class="cmdk-item" data-idx="' + i + '" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;text-decoration:none;margin-bottom:2px;' + (i === 0 ? 'background:rgba(255,79,0,0.1);' : '') + '">' +
        '<div style="width:28px;height:28px;background:' + color + '22;border-radius:6px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">' + icon + '</div>' +
        '<div style="flex:1;min-width:0;">' +
          '<p style="font-size:13px;font-weight:600;color:#fff;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(item.title) + '</p>' +
          '<p style="font-size:11px;color:#6e6e78;margin:1px 0 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(item.subtitle || '') + '</p>' +
        '</div>' +
        '<span style="font-size:9px;background:' + color + '22;color:' + color + ';padding:2px 7px;border-radius:100px;font-weight:700;text-transform:uppercase;flex-shrink:0;">' + item.type + '</span>' +
      '</a>';
    });
    results.innerHTML = html;
  }

  function handleKey(e) {
    if (e.key === 'Escape') { close(); return; }
    if (lastResults.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIdx = Math.min(selectedIdx + 1, lastResults.length - 1);
      highlight();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIdx = Math.max(selectedIdx - 1, 0);
      highlight();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (lastResults[selectedIdx]) {
        window.location.href = lastResults[selectedIdx].url;
      }
    }
  }

  function highlight() {
    document.querySelectorAll('.cmdk-item').forEach(function(el, i) {
      el.style.background = i === selectedIdx ? 'rgba(255,79,0,0.1)' : '';
    });
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[<>&"']/g, function(c) {
      return {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c];
    });
  }

  // Global hotkey
  document.addEventListener('keydown', function(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      isOpen ? close() : open();
    }
  });

  // Optional floating button on mobile
  if (window.innerWidth > 768) {
    var btn = document.createElement('button');
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg> Search <kbd style="background:#1a1a1f;border:1px solid #2a2a2f;border-radius:3px;padding:0 4px;font-size:10px;margin-left:6px;">Ctrl+K</kbd>';
    btn.style.cssText = 'position:fixed;bottom:16px;right:16px;background:#0f0f14;border:1px solid #1a1a1f;color:#8a8a94;font-size:12px;font-weight:500;padding:8px 14px;border-radius:100px;cursor:pointer;display:flex;align-items:center;gap:6px;z-index:30;box-shadow:0 4px 12px rgba(0,0,0,0.4);';
    btn.onclick = function() { open(); };
    document.body.appendChild(btn);
  }
})();
