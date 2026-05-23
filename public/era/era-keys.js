/* era-keys.js - Global keyboard shortcuts system
   Shortcuts:
     ?    - Show this overlay
     g d  - Go to Dashboard
     g a  - Go to Applications
     g u  - Go to Users
     g t  - Go to Tests
     g h  - Go to HR
     g i  - Go to Interviews
     g s  - Go to Settings
     n a  - New Application
     n o  - New Offer (custom)
     /    - Focus search (Cmd+K)
     Esc  - Close overlay/modals
*/
(function(global) {
  'use strict';
  if (!global.ERA) global.ERA = {};

  var SHORTCUTS = [
    { keys: '?', label: 'Show this overlay', cat: 'Help' },
    { keys: '/', label: 'Quick search', cat: 'Help' },
    { keys: 'Ctrl + K', label: 'Quick search', cat: 'Help' },
    { keys: 'Esc', label: 'Close modal / overlay', cat: 'Help' },
    { keys: 'g d', label: 'Dashboard', cat: 'Navigation', href: '/admin' },
    { keys: 'g a', label: 'Applications', cat: 'Navigation', href: '/admin/applications' },
    { keys: 'g u', label: 'Users', cat: 'Navigation', href: '/admin/users' },
    { keys: 'g t', label: 'Tests', cat: 'Navigation', href: '/admin/tests' },
    { keys: 'g h', label: 'HR Management', cat: 'Navigation', href: '/admin/hr' },
    { keys: 'g e', label: 'Employees', cat: 'Navigation', href: '/admin/hr/employees' },
    { keys: 'g i', label: 'Interviews', cat: 'Navigation', href: '/admin/interviews' },
    { keys: 'g m', label: 'Messages / DMs', cat: 'Navigation', href: '/admin/messages' },
    { keys: 'g s', label: 'Settings', cat: 'Navigation', href: '/admin/settings' },
    { keys: 'n a', label: 'New Application', cat: 'Create', href: '/admin/applications/new' },
    { keys: 'n o', label: 'New Custom Offer', cat: 'Create', href: '/admin/offer/blank' },
    { keys: 'n t', label: 'New Test', cat: 'Create', href: '/admin/tests?new=1' },
  ];

  if (!window.location.pathname.startsWith('/admin')) return;

  var overlay = null;
  var keyBuffer = '';
  var bufferTimer = null;

  function buildOverlay() {
    overlay = document.createElement('div');
    overlay.id = 'eraKeysOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);backdrop-filter:blur(8px);z-index:99999;display:none;align-items:center;justify-content:center;padding:20px;';

    var cats = {};
    SHORTCUTS.forEach(function(s) {
      if (!cats[s.cat]) cats[s.cat] = [];
      cats[s.cat].push(s);
    });

    var html = '<div style="background:#0f0f14;border:1px solid #1a1a1f;border-radius:14px;max-width:560px;width:100%;max-height:85vh;overflow-y:auto;box-shadow:0 25px 50px rgba(0,0,0,0.5);">';
    html += '<div style="padding:16px 20px;border-bottom:1px solid #1a1a1f;display:flex;align-items:center;justify-content:space-between;"><h2 style="font-size:15px;font-weight:700;color:#fff;margin:0;">Keyboard Shortcuts</h2><span style="font-size:10px;color:#6e6e78;font-family:monospace;background:#15151a;border:1px solid #1a1a1f;border-radius:4px;padding:2px 8px;">Press ? to toggle</span></div>';
    html += '<div style="padding:16px 20px;">';
    Object.keys(cats).forEach(function(cat) {
      html += '<p style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#FF7040;margin:14px 0 8px;">' + cat + '</p>';
      cats[cat].forEach(function(s) {
        html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.04);">' +
                '<span style="font-size:13px;color:#d8d8de;">' + s.label + '</span>' +
                '<kbd style="background:#15151a;border:1px solid #1a1a1f;color:#fff;font-family:monospace;font-size:11px;font-weight:600;padding:3px 8px;border-radius:4px;letter-spacing:0.05em;">' + s.keys + '</kbd>' +
                '</div>';
      });
    });
    html += '</div>';
    html += '<div style="padding:12px 20px;border-top:1px solid #1a1a1f;font-size:11px;color:#6e6e78;text-align:center;">For two-key sequences (g d), press them within 1 second</div>';
    html += '</div>';
    overlay.innerHTML = html;
    overlay.addEventListener('click', function(e) { if (e.target === overlay) hide(); });
    document.body.appendChild(overlay);
  }

  function show() {
    if (!overlay) buildOverlay();
    overlay.style.display = 'flex';
  }
  function hide() {
    if (overlay) overlay.style.display = 'none';
  }

  function isTyping() {
    var el = document.activeElement;
    if (!el) return false;
    var tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function navigate(href) {
    if (window.ERA && window.ERA.toast) window.ERA.toast('Navigating...', { duration: 800 });
    setTimeout(function() { window.location.href = href; }, 100);
  }

  document.addEventListener('keydown', function(e) {
    // Don't intercept when user is typing
    if (isTyping()) {
      if (e.key === 'Escape') {
        e.target.blur();
      }
      return;
    }

    // Esc closes overlay
    if (e.key === 'Escape') {
      if (overlay && overlay.style.display === 'flex') {
        hide();
        return;
      }
    }

    // ? shows overlay
    if (e.key === '?' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (overlay && overlay.style.display === 'flex') hide();
      else show();
      return;
    }

    // / focuses search
    if (e.key === '/') {
      e.preventDefault();
      // Trigger Cmd+K palette via keyboard event
      var evt = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true });
      document.dispatchEvent(evt);
      return;
    }

    // Two-key sequences (g + letter, n + letter)
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var key = e.key.toLowerCase();
    if (key.length !== 1) return;

    keyBuffer += key;
    clearTimeout(bufferTimer);

    // Try to match a shortcut
    var matched = SHORTCUTS.find(function(s) {
      return s.keys.replace(/ /g, '').toLowerCase() === keyBuffer && s.href;
    });

    if (matched) {
      e.preventDefault();
      navigate(matched.href);
      keyBuffer = '';
      return;
    }

    // Reset buffer if too long
    if (keyBuffer.length >= 3) {
      keyBuffer = '';
    } else {
      bufferTimer = setTimeout(function() { keyBuffer = ''; }, 1000);
    }
  });

  // Register with FAB if available
  function register() {
    if (!window.ERA || !window.ERA.FAB) { setTimeout(register, 100); return; }
    window.ERA.FAB.add({
      key: 'shortcuts',
      label: 'Shortcuts',
      shortcut: '?',
      color: '#fbbf24',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 9h.01M15 9h.01M8 13s1.5 2 4 2 4-2 4-2"/><circle cx="12" cy="12" r="10"/></svg>',
      onClick: show
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', register);
  else register();

  global.ERA.keys = { show: show, hide: hide };
})(typeof window !== 'undefined' ? window : this);
