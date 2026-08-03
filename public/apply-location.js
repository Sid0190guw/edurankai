/* apply-location.js — capture where an application is being filed from.
 *
 * Loaded on the /apply steps. Two jobs:
 *
 *  1. Send DEVICE signals (timezone, clock offset, language list, platform, screen) on every step.
 *     These need no permission and, crucially, a VPN cannot change them: it reroutes the network,
 *     it does not touch the machine's clock or locale. When the network says one country and these
 *     say another, the device is usually telling the truth.
 *
 *  2. Ask for precise location ONCE, with the reason shown on screen first. Browsers require an
 *     explicit prompt for this and it can be refused — so a refusal is reported too, because
 *     "declined" is itself information on a security-cleared programme. It is recorded as advisory
 *     only; a human decides, never this script.
 *
 * Everything is fire-and-forget. Nothing here may ever block someone from submitting an
 * application, so all failures are swallowed and no return value is awaited by the form.
 */
(function () {
  'use strict';
  if (window.__eraApplyLocation) return;
  window.__eraApplyLocation = true;

  var ENDPOINT = '/api/apply/location';

  function deviceSignals() {
    var tz = null;
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (_) {}
    var langs = [];
    try { langs = (navigator.languages && navigator.languages.length) ? navigator.languages.slice(0, 6) : (navigator.language ? [navigator.language] : []); } catch (_) {}
    var plat = null;
    try { plat = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || null; } catch (_) {}
    var scr = null;
    try { scr = screen.width + 'x' + screen.height; } catch (_) {}
    return {
      browserTimezone: tz,
      // Note the sign convention: getTimezoneOffset() returns -330 for IST (UTC+5:30).
      utcOffsetMin: (function () { try { return new Date().getTimezoneOffset(); } catch (_) { return null; } })(),
      languages: langs,
      platform: plat,
      screen: scr,
    };
  }

  function ids() {
    var el = document.querySelector('[data-era-apply]');
    var d = (el && el.dataset) || {};
    return {
      applicationId: d.applicationId || null,
      intentId: d.intentId || null,
      email: d.email || null,
      step: d.step || (location.pathname.split('/').filter(Boolean).pop() || 'apply'),
    };
  }

  function send(payload) {
    try {
      var body = JSON.stringify(payload);
      // sendBeacon survives the page unloading on form submit; fetch is the fallback.
      if (navigator.sendBeacon) {
        navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
      } else {
        fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body, keepalive: true }).catch(function () {});
      }
    } catch (_) {}
  }

  /* Same post, but WAITING for the server to say whether the row was actually written.
   * sendBeacon deliberately discards the response, which is fine for observability and wrong for the
   * mandatory-location gate: there the applicant is told "granted" and the server later refuses the
   * submission for a location it never received. Resolves true only when the server confirms a
   * usable row was stored. */
  function sendConfirmed(payload) {
    try {
      return fetch(ENDPOINT, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { return !!(j && j.stored); })
        .catch(function () { return false; });
    } catch (_) { return Promise.resolve(false); }
  }

  var base = function () {
    var i = ids();
    var d = deviceSignals();
    return {
      applicationId: i.applicationId, intentId: i.intentId, email: i.email, step: i.step,
      browserTimezone: d.browserTimezone, utcOffsetMin: d.utcOffsetMin,
      languages: d.languages, platform: d.platform, screen: d.screen,
    };
  };

  // 1. Device signals for this step, immediately.
  var b = base();
  b.status = 'unavailable';   // no GPS attempted yet; this row carries the device signals
  send(b);

  // 2. Precise location, once per browser, and only after the notice has been shown.
  var ASKED = 'era_geo_asked_v1';
  /* force=true bypasses the once-per-session guard. The mandatory gate on security-classified roles
     needs that: the guard exists so an honest applicant is not nagged, but when location is a
     CONDITION of applying the grant must actually be recorded, even if the optional ask already ran
     earlier in the session. */
  /* Returns a promise of { status, stored }:
   *   status — what the BROWSER did: 'granted' | 'denied' | 'timeout' | 'unavailable' | 'skipped'
   *   stored — what the SERVER did: true / false when confirmed (force=true), null when the report
   *            was fired off without waiting for a reply.
   * A caller that shows the applicant a result must check both. "The browser said yes" and "we hold
   * your location" are different facts, and treating the first as the second is what let an applicant
   * be told they could continue when nothing had been recorded. */
  function askPrecise(force) {
    if (!force) {
      try { if (sessionStorage.getItem(ASKED)) return Promise.resolve({ status: 'skipped', stored: null }); sessionStorage.setItem(ASKED, '1'); } catch (_) {}
    }
    var deliver = force ? sendConfirmed : function (p) { send(p); return Promise.resolve(null); };
    if (!navigator.geolocation) {
      var u = base(); u.status = 'unavailable';
      return deliver(u).then(function (s) { return { status: 'unavailable', stored: s }; });
    }
    return new Promise(function (resolve) {
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          var g = base();
          g.status = 'granted';
          g.latitude = pos.coords.latitude;
          g.longitude = pos.coords.longitude;
          g.accuracy = pos.coords.accuracy;
          deliver(g).then(function (s) { resolve({ status: 'granted', stored: s }); });
        },
        function (err) {
          var g = base();
          // 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT
          g.status = err && err.code === 1 ? 'denied' : (err && err.code === 3 ? 'timeout' : 'unavailable');
          deliver(g).then(function (s) { resolve({ status: g.status, stored: s }); });
        },
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
      );
    });
  }

  // Only prompt where the page has opted in, so the notice is always on screen alongside it.
  var trigger = document.querySelector('[data-era-geo-consent]');
  if (trigger) {
    if (trigger.tagName === 'BUTTON' || trigger.tagName === 'A') {
      trigger.addEventListener('click', function (e) { e.preventDefault(); askPrecise(); });
    } else {
      // A plain notice element: ask after it has had a moment to be read.
      setTimeout(askPrecise, 1200);
    }
  }

  window.AquinApplyLocation = { askPrecise: askPrecise, signals: deviceSignals };
})();
