// public/sos.js - SOS button + proximity tracking for portal users
// Only activates on /portal pages when user is logged in
(function() {
  if (!window.location.pathname.startsWith('/portal')) return;

  var SESSION_KEY = 'era_session';
  var sessionId = sessionStorage.getItem(SESSION_KEY);
  var lastLat = null, lastLon = null;

  // ── 1. Location tracking (update every 60s if user shared GPS) ─────────
  function updateLocation(lat, lon, acc) {
    lastLat = lat; lastLon = lon;
    fetch('/api/location/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ lat: lat, lon: lon, accuracy: acc })
    }).catch(function() {});
  }

  function startTracking() {
    if (!navigator.geolocation) return;
    navigator.geolocation.watchPosition(
      function(pos) { updateLocation(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy); },
      function() {},
      { enableHighAccuracy: true, maximumAge: 30000 }
    );
  }

  // Only track if user previously allowed GPS (check via analytics session)
  navigator.geolocation?.getCurrentPosition(
    function(pos) {
      updateLocation(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
      setInterval(startTracking, 60000);
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

    document.getElementById('confirmSOS').onclick = function() {
      var msg = document.getElementById('sosMessage')?.value || '';
      this.textContent = 'Sending...';
      this.disabled = true;
      fetch('/api/safety/sos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ lat: lat, lon: lon, message: msg, radiusM: 100 })
      }).then(function(r) { return r.json(); })
      .then(function(data) {
        modal.remove();
        var toast = document.createElement('div');
        toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#ef4444;color:#fff;font-size:13px;font-weight:700;padding:12px 24px;border-radius:100px;z-index:99999;text-align:center;';
        toast.innerHTML = 'SOS sent. Help is coming.<br><span style="font-size:11px;font-weight:400;">' + data.nearbyCount + ' nearby users identified</span>';
        document.body.appendChild(toast);
      }).catch(function() {
        modal.remove();
      });
    };
  }

})();
