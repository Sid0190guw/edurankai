// Browser push subscription helper. Loaded by AdminLayout + BaseLayout once
// the user is signed in. Asks for permission ONCE per device, registers the
// subscription with the server, and silently re-syncs on every visit.
//
// Usage from a layout:
//   <script src="/push-subscribe.js" defer></script>
//   <script>window.EduPush && EduPush.attach({ autoPrompt: true })</script>
//
// If VAPID isn't configured server-side, the prompt is suppressed and the
// in-app bell continues to work as the fallback.

(function () {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

  function urlBase64ToUint8(b64) {
    var padding = '='.repeat((4 - (b64.length % 4)) % 4);
    var base64 = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(base64);
    var arr = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  async function getVapidKey() {
    try {
      var r = await fetch('/api/push/vapid-key', { credentials: 'same-origin' });
      if (!r.ok) return null;
      var d = await r.json();
      return (d && d.ok && d.key) ? d.key : null;
    } catch (_) { return null; }
  }

  async function getRegistration() {
    try {
      var reg = await navigator.serviceWorker.getRegistration('/');
      if (reg) return reg;
      return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    } catch (_) { return null; }
  }

  async function sendSubscriptionToServer(sub) {
    try {
      await fetch('/api/push/subscribe', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: sub.endpoint,
          keys: {
            p256dh: btoa(String.fromCharCode.apply(null, new Uint8Array(sub.getKey('p256dh')))),
            auth: btoa(String.fromCharCode.apply(null, new Uint8Array(sub.getKey('auth')))),
          },
        }),
      });
    } catch (_) {}
  }

  async function subscribe() {
    var key = await getVapidKey(); if (!key) return { ok: false, reason: 'no-vapid' };
    var reg = await getRegistration(); if (!reg) return { ok: false, reason: 'no-sw' };
    try {
      var existing = await reg.pushManager.getSubscription();
      if (existing) {
        // Re-sync the subscription with the server (handles user changing devices etc.)
        await sendSubscriptionToServer(existing);
        return { ok: true, alreadySubscribed: true };
      }
      var sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8(key),
      });
      await sendSubscriptionToServer(sub);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: (e && e.name) || 'subscribe-failed', error: (e && e.message) || '' };
    }
  }

  async function attach(opts) {
    opts = opts || {};
    if (typeof Notification === 'undefined') return;

    // Already granted → silently re-sync the subscription so server has the latest endpoint.
    if (Notification.permission === 'granted') { await subscribe(); return; }

    // Denied → don't re-prompt. The in-app bell remains as the fallback.
    if (Notification.permission === 'denied') return;

    if (!opts.autoPrompt) return;

    // Only prompt ONCE per device per browser-session — never nag.
    var key = 'edurankai_push_prompted_v1';
    try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch (_) {}

    var perm = await Notification.requestPermission();
    if (perm === 'granted') await subscribe();
  }

  // Expose a manual trigger for diagnostic / settings pages.
  window.EduPush = {
    attach: attach,
    subscribe: subscribe,
    permission: function () { return (typeof Notification !== 'undefined') ? Notification.permission : 'unsupported'; },
  };
})();
