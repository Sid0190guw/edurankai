// public/analytics.js
// Add <script src="/analytics.js"></script> to any page to track it
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
    if (ua.includes('Linux')) return 'Linux';
    if (ua.includes('Android')) return 'Android';
    if (ua.includes('iOS') || ua.includes('iPhone') || ua.includes('iPad')) return 'iOS';
    return 'Other';
  }
  
  function track() {
    try {
      fetch('/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page: window.location.pathname,
          referrer: document.referrer || null,
          sessionId: getOrCreateSession(),
          deviceType: getDeviceType(),
          browser: getBrowser(),
          os: getOS(),
        })
      });
    } catch(e) {}
  }
  
  // Track on load
  if (document.readyState === 'complete') {
    track();
  } else {
    window.addEventListener('load', track);
  }
  
  // Track on SPA navigation
  var pushState = history.pushState;
  history.pushState = function() {
    pushState.apply(history, arguments);
    setTimeout(track, 100);
  };
  window.addEventListener('popstate', function() { setTimeout(track, 100); });
})();
