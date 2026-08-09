// public/sos.js - SOS button + proximity tracking for portal users
// Only activates on /portal pages when user is logged in
(function() {
  if (!window.location.pathname.startsWith('/portal')) return;

  var SESSION_KEY = 'era_session';
  var sessionId = sessionStorage.getItem(SESSION_KEY);
  var lastLat = null, lastLon = null;

  // ── 1. Location tracking (at most one update per 60s if the user shared GPS) ─────────
  //
  // THIS USED TO TAKE THE WHOLE SITE DOWN. The old code called watchPosition() inside a
  // setInterval(..., 60000). watchPosition registers a PERSISTENT watcher, so a new watcher was
  // added every minute and none were ever cleared: after an hour a single open tab held sixty
  // watchers, each firing on every GPS tick and each POSTing to /api/location/update. The request
  // volume compounded until the database connection pool was exhausted, at which point the session
  // lookup itself started failing and EVERY authenticated page returned 500 — the apply flow
  // included. The symptom looked nothing like its cause, which is what made it expensive.
  //
  // Now: exactly one watcher for the life of the page, and the POST is throttled by time AND by
  // distance, because a phone sitting still still emits position events.
  var MIN_MS_BETWEEN_SENDS = 60000;
  var MIN_METRES_MOVED = 25;
  var lastSentAt = 0;
  var watchId = null;

  // Rough metres between two coordinates. Good enough to decide "has this person actually moved",
  // which is all it is used for.
  function metresBetween(aLat, aLon, bLat, bLon) {
    var dLat = (bLat - aLat) * 111320;
    var dLon = (bLon - aLon) * 111320 * Math.cos(aLat * Math.PI / 180);
    return Math.sqrt(dLat * dLat + dLon * dLon);
  }

  function updateLocation(lat, lon, acc, force) {
    var now = Date.now();
    if (!force) {
      if (now - lastSentAt < MIN_MS_BETWEEN_SENDS) return;
      if (lastLat !== null && metresBetween(lastLat, lastLon, lat, lon) < MIN_METRES_MOVED) return;
    }
    lastLat = lat; lastLon = lon; lastSentAt = now;
    fetch('/api/location/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ lat: lat, lon: lon, accuracy: acc })
    }).then(function (r) {
      // 410 means the server has retired this beacon. Stop watching entirely rather than continuing
      // to fire at a door that is closed — a client that ignores the server's answer is how the
      // original incident kept going after it was fixed.
      if (r && r.status === 410 && watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
        lastSentAt = Number.MAX_SAFE_INTEGER;
      }
    }).catch(function() {});
  }

  function startTracking() {
    if (!navigator.geolocation) return;
    if (watchId !== null) return;               // one watcher, ever
    watchId = navigator.geolocation.watchPosition(
      function(pos) { updateLocation(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, false); },
      function() {},
      { enableHighAccuracy: true, maximumAge: 30000 }
    );
  }

  // Stop watching when the tab is hidden and resume when it comes back, so a forgotten background
  // tab is not reporting a position nobody is looking at.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    } else if (!document.hidden) {
      startTracking();
    }
  });

  navigator.geolocation?.getCurrentPosition(
    function(pos) {
      updateLocation(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, true);
      startTracking();
    },
    function() {},
    { timeout: 3000, maximumAge: 60000 }
  );

  // ── 2. SOS — folded into the single FAB menu (kept red, no standalone) ─
  function eraFabAdd(item) {
    var E = (window.ERA = window.ERA || {});
    if (E.FAB && E.FAB.add) E.FAB.add(item);
    else { (E._fabQueue = E._fabQueue || []).push(item); }
  }
  eraFabAdd({
    key: 'sos',
    label: 'Emergency SOS',
    color: '#ef4444',
    order: 99,
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    onClick: function() { triggerSOS(); }
  });

  function triggerSOS() {
    if (lastLat && lastLon) {
      showSOSModal(lastLat, lastLon);
      return;
    }
    // Try to get location first
    navigator.geolocation?.getCurrentPosition(
      function(pos) {
        lastLat = pos.coords.latitude;
        lastLon = pos.coords.longitude;
        showSOSModal(lastLat, lastLon);
      },
      function() {
        // No GPS - send without location
        showSOSModal(null, null);
      },
      { enableHighAccuracy: true, timeout: 5000 }
    );
  }

  function showSOSModal(lat, lon) {
    var modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.9);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;';
    modal.innerHTML = `
      <div style="background:#0f0f14;border:2px solid rgba(239,68,68,0.5);border-radius:16px;max-width:380px;width:100%;padding:28px;text-align:center;">
        <div style="width:64px;height:64px;background:rgba(239,68,68,0.15);border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        </div>
        <h2 style="font-size:20px;font-weight:800;color:#fff;margin:0 0 6px;">Send SOS Alert?</h2>
        <p style="font-size:13px;color:#8a8a94;margin:0 0 16px;">${lat ? 'Your exact location will be shared with EduRankAI admins. Nearby users will be identified.' : 'Location not available. Alert will be sent without coordinates.'}</p>
        <textarea id="sosMessage" placeholder="What's happening? (optional)" rows="3" style="width:100%;background:#15151a;border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:10px 12px;color:#fff;font-size:13px;outline:none;resize:none;margin-bottom:14px;"></textarea>
        <div style="display:flex;gap:8px;">
          <button onclick="this.closest('div[style*=fixed]').remove()" style="flex:1;background:#15151a;border:1px solid #1a1a1f;color:#d8d8de;font-size:13px;font-weight:600;padding:12px;border-radius:10px;cursor:pointer;">Cancel</button>
          <button id="confirmSOS" style="flex:2;background:#ef4444;border:none;color:#fff;font-size:14px;font-weight:700;padding:12px;border-radius:10px;cursor:pointer;letter-spacing:0.05em;">SEND SOS</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // ── THE PANIC BUTTON USED TO LIE ────────────────────────────────────────────────────────
    //
    // The old handler took ANY JSON response and said "SOS sent. Help is coming." — including
    // `{ ok:false, error:... }`, which is exactly what /api/safety/sos returns when its INSERT
    // fails. And on a network failure the `.catch` removed the modal and showed NOTHING AT ALL:
    // a person in an emergency tapped SEND SOS, the dialog vanished, and they believed help was
    // on the way. `data.nearbyCount` was printed unguarded too, so a failed call rendered
    // "undefined nearby users identified".
    //
    // Success is claimed ONLY when the server said ok. Every other outcome states plainly that the
    // alert did not go through, and the modal STAYS OPEN so it can be sent again.
    var sosBtn = document.getElementById('confirmSOS');
    if (!sosBtn) return;
    sosBtn.onclick = function() {
      var btn = this;
      var msgEl = document.getElementById('sosMessage');
      var msg = (msgEl && msgEl.value) || '';
      btn.textContent = 'Sending...';
      btn.disabled = true;

      function failed(detail) {
        btn.textContent = 'RETRY SOS';
        btn.disabled = false;
        var box = document.getElementById('sosResult');
        if (!box) {
          box = document.createElement('p');
          box.id = 'sosResult';
          box.style.cssText = 'font-size:12px;line-height:1.5;color:#fca5a5;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.4);border-radius:8px;padding:10px 12px;margin:0 0 12px;text-align:left;';
          if (btn.parentNode && btn.parentNode.parentNode) {
            btn.parentNode.parentNode.insertBefore(box, btn.parentNode);
          } else {
            modal.appendChild(box);
          }
        }
        box.textContent = 'YOUR ALERT WAS NOT SENT. ' + detail + ' Nobody has been notified. Contact someone directly, then try again.';
      }

      fetch('/api/safety/sos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ lat: lat, lon: lon, message: msg, radiusM: 100 })
      }).then(function(r) {
        // A 401 or a 500 with an HTML body must never be read as a delivered alert.
        return r.json().then(
          function(data) { return { status: r.status, data: data || null }; },
          function() { return { status: r.status, data: null }; }
        );
      }).then(function(res) {
        if (!res.data || res.data.ok !== true) {
          failed(res.data && res.data.error
            ? 'The server refused it: ' + res.data.error + '.'
            : 'The server answered ' + res.status + ' with no confirmation.');
          return;
        }
        modal.remove();
        var count = typeof res.data.nearbyCount === 'number' ? res.data.nearbyCount : null;
        var toast = document.createElement('div');
        toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#ef4444;color:#fff;font-size:13px;font-weight:700;padding:12px 24px;border-radius:100px;z-index:99999;text-align:center;max-width:90vw;';
        var head = document.createElement('span');
        head.textContent = 'SOS recorded. Admins have been alerted.';
        var sub = document.createElement('span');
        sub.style.cssText = 'display:block;font-size:11px;font-weight:400;';
        sub.textContent = count === null
          ? 'Nearby users could not be counted.'
          : count === 0
            ? 'No one nearby was sharing a location.'
            : count + (count === 1 ? ' nearby user identified' : ' nearby users identified');
        toast.appendChild(head);
        toast.appendChild(sub);
        document.body.appendChild(toast);
        setTimeout(function() { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 12000);
      }).catch(function(err) {
        failed('The request never reached the server' + (err && err.message ? ' (' + err.message + ')' : '') + '.');
      });
    };
  }

})();
