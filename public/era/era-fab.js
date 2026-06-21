/* era-fab.js - Floating Action Button system
   One stacked menu for all corner-positioned helpers (search, AI, notifications, etc)
   Registers items via window.ERA.FAB.add(item)
*/
(function(global) {
  'use strict';
  if (!global.ERA) global.ERA = {};

  var fab, menu, open = false;
  var items = [];
  var initialized = false;

  function build() {
    if (initialized) return;
    initialized = true;

    // Reserve bottom space for FAB so content doesn't hide behind it
    if (!document.getElementById('eraFabSpacing')) {
      var sp = document.createElement('style');
      sp.id = 'eraFabSpacing';
      sp.textContent = 'body { padding-bottom: 80px !important; } @media (max-width: 768px) { body { padding-bottom: 90px !important; } }';
      document.head.appendChild(sp);
    }


    // Main FAB
    fab = document.createElement('button');
    fab.id = 'eraFab';
    fab.setAttribute('aria-label', 'Open quick actions');
    fab.innerHTML = '<svg id="fabIcon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="6" cy="12" r="1.5" fill="currentColor"/><circle cx="18" cy="12" r="1.5" fill="currentColor"/></svg>';
    fab.style.cssText = 'position:fixed;bottom:16px;left:16px;width:48px;height:48px;background:#FF4F00;border:none;border-radius:50%;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(255,79,0,0.45);z-index:9990;transition:transform 0.2s, box-shadow 0.2s;';
    fab.onmouseenter = function() { fab.style.transform = 'scale(1.08)'; };
    fab.onmouseleave = function() { fab.style.transform = open ? 'rotate(45deg)' : 'scale(1)'; };
    fab.onclick = toggle;
    document.body.appendChild(fab);

    // Unread badge dot — folded-in widgets (e.g. live chat) toggle it via ERA.FAB.setBadge
    var fbadge = document.createElement('span');
    fbadge.id = 'eraFabBadge';
    fbadge.style.cssText = 'position:absolute;top:-1px;right:-1px;width:12px;height:12px;border-radius:50%;background:#ef4444;border:2px solid #100b08;display:none;';
    fab.appendChild(fbadge);

    // Menu container (stacks above FAB)
    menu = document.createElement('div');
    menu.id = 'eraFabMenu';
    menu.style.cssText = 'position:fixed;bottom:76px;left:16px;z-index:9989;display:flex;flex-direction:column;gap:10px;align-items:flex-start;pointer-events:none;max-height:calc(100vh - 96px);overflow-y:auto;overflow-x:visible;padding:2px;';
    document.body.appendChild(menu);
  }

  function renderMenu() {
    if (!menu) return;
    // Higher `order` renders nearer the FAB (easiest thumb reach) and pops in first.
    var ordered = items.slice().sort(function(a, b) { return (a.order || 0) - (b.order || 0); });
    var html = '';
    ordered.forEach(function(item, idx) {
      var delay = (ordered.length - idx - 1) * 40;
      html += '<div class="era-fab-item" data-key="' + item.key + '" style="display:flex;align-items:center;gap:10px;opacity:0;transform:translateY(10px) scale(0.85);transition:opacity 0.2s ' + delay + 'ms, transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1) ' + delay + 'ms;pointer-events:auto;">'
            + '<button class="era-fab-btn" data-key="' + item.key + '" style="width:42px;height:42px;background:' + (item.color || '#15151a') + ';border:1px solid rgba(255,255,255,0.1);border-radius:50%;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,0.3);" title="' + item.label + '">' + item.icon + '</button>'
            + '<span style="background:rgba(15,15,20,0.95);backdrop-filter:blur(10px);color:#fff;font-size:12px;font-weight:600;padding:6px 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.08);white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,0.3);">' + item.label
            + (item.shortcut ? ' <kbd style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);border-radius:3px;padding:0 5px;font-size:10px;margin-left:4px;font-family:monospace;color:rgba(255,255,255,0.7);">' + item.shortcut + '</kbd>' : '')
            + '</span>'
            + '</div>';
    });
    menu.innerHTML = html;
    // Attach handlers
    menu.querySelectorAll('.era-fab-btn').forEach(function(btn) {
      btn.onclick = function() {
        var key = btn.getAttribute('data-key');
        var it = items.find(function(x) { return x.key === key; });
        if (it && it.onClick) { it.onClick(); close(); }
      };
    });
  }

  function toggle() {
    open ? close() : openMenu();
  }

  function openMenu() {
    open = true;
    fab.style.transform = 'rotate(45deg)';
    fab.style.background = '#0f0f14';
    renderMenu();
    // Trigger animation
    requestAnimationFrame(function() {
      menu.querySelectorAll('.era-fab-item').forEach(function(it) {
        it.style.opacity = '1';
        it.style.transform = 'translateY(0) scale(1)';
      });
    });
  }

  function close() {
    open = false;
    fab.style.transform = 'scale(1)';
    fab.style.background = '#FF4F00';
    menu.querySelectorAll('.era-fab-item').forEach(function(it) {
      it.style.opacity = '0';
      it.style.transform = 'translateY(10px) scale(0.85)';
    });
    setTimeout(function() { if (!open) menu.innerHTML = ''; }, 250);
  }

  // Click outside to close
  document.addEventListener('click', function(e) {
    if (!open) return;
    if (fab && fab.contains(e.target)) return;
    if (menu && menu.contains(e.target)) return;
    close();
  });

  // ESC to close
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && open) close();
  });

  global.ERA.FAB = {
    init: build,
    add: function(item) {
      // item: {key, label, icon (SVG string), onClick, color?, shortcut?}
      if (!initialized) build();
      // De-dupe
      items = items.filter(function(x) { return x.key !== item.key; });
      items.push(item);
    },
    remove: function(key) {
      items = items.filter(function(x) { return x.key !== key; });
    },
    open: openMenu,
    close: close,
    setBadge: function(show) {
      var b = document.getElementById('eraFabBadge');
      if (b) b.style.display = show ? 'block' : 'none';
    }
  };

  // Load-order safety: register anything queued before this script defined ERA.FAB.
  if (global.ERA._fabQueue && global.ERA._fabQueue.length) {
    global.ERA._fabQueue.forEach(function(i) { global.ERA.FAB.add(i); });
    global.ERA._fabQueue = [];
  }

  // Auto-init on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})(typeof window !== 'undefined' ? window : this);
