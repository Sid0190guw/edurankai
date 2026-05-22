// public/analytics.js - EduRankAI visitor tracking with GPS support
(function() {
  var SESSION_KEY = 'era_session';

  function getOrCreateSession() {
    var s = sessionStorage.getItem(SESSION_KEY);
    if (!s) {
      s = Math.random().toString(36).substring(2) + Date.now().toString(36);
      sessionStorage.setItem(SESSION_KEY, s);
    }
    return s;
  }

  function getDeviceType() {
    var ua = navigator.userAgent;
    if (/tablet|ipad|playbook|silk/i.test(ua)) return 'tablet';
    if (/mobile|iphone|ipod|android|blackberry|mini|windows\sce|palm/i.test(ua)) return 'mobile';
    return 'desktop';
  }

  function getBrowser() {
    var ua = navigator.userAgent;
    if (ua.includes('Chrome') && !ua.includes('Edg')) return 'Chrome';
    if (ua.includes('Safari') && !ua.includes('Chrome')) return 'Safari';
    if (ua.includes('Firefox')) return 'Firefox';
    if (ua.includes('Edg')) return 'Edge';
    if (ua.includes('OPR') || ua.includes('Opera')) return 'Opera';
    return 'Other';
  }

  function getOS() {
    var ua = navigator.userAgent;
    if (ua.includes('Windows')) return 'Windows';
    if (ua.includes('Mac')) return 'macOS';
    if (ua.includes('Android')) return 'Android';
    if (ua.includes('iPhone') || ua.includes('iPad')) return 'iOS';
    if (ua.includes('Linux')) return 'Linux';
    return 'Other';
  }

  var startTime = Date.now();
  var sessionId = getOrCreateSession();


  // Capture enhanced device info (no permission needed)
  function getEnhancedDeviceInfo() {
    var nav = navigator;
    return {
      screen: screen.width + 'x' + screen.height,
      colorDepth: screen.colorDepth,
      pixelRatio: window.devicePixelRatio || 1,
      language: nav.language || nav.userLanguage,
      languages: (nav.languages || []).join(','),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      platform: nav.platform,
      cores: nav.hardwareConcurrency || null,
      memory: nav.deviceMemory || null,
      connection: nav.connection ? nav.connection.effectiveType : null,
      touchPoints: nav.maxTouchPoints || 0,
      cookiesEnabled: nav.cookieEnabled,
      doNotTrack: nav.doNotTrack,
    };
  }

  function getEnhancedDeviceInfo() {
    return {
      screen: screen.width + 'x' + screen.height,
      pixelRatio: window.devicePixelRatio || 1,
      language: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      cores: navigator.hardwareConcurrency || null,
      memory: navigator.deviceMemory || null,
      connection: navigator.connection ? navigator.connection.effectiveType : null,
      touchPoints: navigator.maxTouchPoints || 0,
    };
  }

  function track() {
    try {
      fetch('/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page: window.location.pathname,
          referrer: document.referrer || null,
          sessionId: sessionId,
          deviceType: getDeviceType(),
          browser: getBrowser(),
          os: getOS(),
          duration: Date.now() - startTime,
          deviceInfo: getEnhancedDeviceInfo(),
          deviceInfo: getEnhancedDeviceInfo(),
        })
      });
    } catch(e) {}
  }

  // Request GPS location - browser will ask permission
  function requestGPS() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      function(pos) {
        var lat = pos.coords.latitude;
        var lon = pos.coords.longitude;
        var acc = pos.coords.accuracy;

        // Reverse geocode using OpenStreetMap (free, no API key)
        fetch('https://nominatim.openstreetmap.org/reverse?lat=' + lat + '&lon=' + lon + '&format=json&zoom=16', {
          headers: { 'Accept-Language': 'en' }
        })
        .then(function(r) { return r.json(); })
        .then(function(geo) {
          var addr = geo.address || {};
          fetch('/api/track-location', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId: sessionId,
              lat: lat, lon: lon, accuracy: acc,
              altitude: pos.coords.altitude || null,
              speed: pos.coords.speed || null,
              heading: pos.coords.heading || null,
              altitude: pos.coords.altitude || null,
              speed: pos.coords.speed || null,
              heading: pos.coords.heading || null,
              address: geo.display_name || '',
              suburb: addr.suburb || addr.neighbourhood || addr.quarter || '',
              district: addr.city_district || addr.county || addr.state_district || '',
            })
          });
        }).catch(function() {
          // Send coordinates even without reverse geocode
          fetch('/api/track-location', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sessionId, lat: lat, lon: lon, accuracy: acc })
          });
        });
      },
      function() {}, // User denied - that's fine
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 300000 }
    );
  }

  // Track page view on load
  if (document.readyState === 'complete') {
    track();
    setTimeout(requestGPS, 2000); // Ask GPS 2s after page load
  } else {
    window.addEventListener('load', function() {
      track();
      setTimeout(requestGPS, 2000);
    });
  }

  // Track on SPA navigation
  var pushState = history.pushState;
  history.pushState = function() {
    pushState.apply(history, arguments);
    startTime = Date.now();
    setTimeout(track, 100);
  };
  window.addEventListener('popstate', function() {
    startTime = Date.now();
    setTimeout(track, 100);
  });

  // Send duration on page leave
  window.addEventListener('beforeunload', function() {
    var duration = Date.now() - startTime;
    if (duration > 2000) {
      navigator.sendBeacon('/api/track', JSON.stringify({
        page: window.location.pathname,
        sessionId: sessionId,
        deviceType: getDeviceType(),
        browser: getBrowser(),
        os: getOS(),
        duration: duration,
      }));
    }
  });
})();
