/* ================================================================================================
   public/mail/keys.js — API keys and webhooks.

   The reveal dialog is the only place a plaintext key exists outside the caller's memory, and it is
   deliberately hard to dismiss by accident: the confirm button says "I have stored it", and closing
   it does not fetch the key again because there is nothing to fetch.
   ============================================================================================== */
(function () {
  'use strict';
  var EM = window.EM;
  var root = document.getElementById('kRoot');
  if (!EM || !root) return;

  var modal = document.getElementById('kModal');
  var reveal = document.getElementById('kReveal');
  var hookModal = document.getElementById('kHookModal');
  var closers = {};

  function err(box, msg) {
    if (!box) return;
    box.hidden = !msg;
    if (msg) box.querySelector('p').textContent = msg;
  }

  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-k-cancel]')) {
      Object.keys(closers).forEach(function (k) { if (closers[k]) closers[k](); });
      closers = {};
      return;
    }

    /* ---- Create key --------------------------------------------------------------------------- */

    if (e.target.closest('[data-k-new]')) {
      err(modal.querySelector('[data-k-err]'), '');
      document.getElementById('kName').value = '';
      modal.querySelectorAll('[data-k-scope]').forEach(function (b) { b.checked = false; });
      closers.key = EM.openModal(modal);
      return;
    }

    var create = e.target.closest('[data-k-create]');
    if (create) {
      var name = document.getElementById('kName').value.trim();
      var scopes = [];
      modal.querySelectorAll('[data-k-scope]:checked').forEach(function (b) { scopes.push(b.value); });
      if (!name) { err(modal.querySelector('[data-k-err]'), 'Give the key a name.'); return; }
      if (!scopes.length) { err(modal.querySelector('[data-k-err]'), 'Choose at least one permission. A key with none can do nothing.'); return; }

      EM.busy(create, true, 'Creating');
      EM.api('/api/mail/product/settings', { body: { action: 'key-create', name: name, scopes: scopes } })
        .then(function (res) {
          EM.busy(create, false);
          if (!res.ok) { err(modal.querySelector('[data-k-err]'), res.error || 'The key was not created.'); return; }
          if (closers.key) closers.key();
          document.getElementById('kSecret').value = res.key;
          reveal.querySelector('[data-k-note]').textContent = res.note || '';
          closers.reveal = EM.openModal(reveal, { dismissible: false });
          // Selected, so the very next keystroke can copy it.
          setTimeout(function () { document.getElementById('kSecret').select(); }, 60);
        });
      return;
    }

    if (e.target.closest('[data-k-copy]')) {
      var input = document.getElementById('kSecret');
      input.select();
      var done = function () { EM.toast('Copied. Store it now — it cannot be shown again.', 'ok', 6000); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(input.value).then(done, function () {
          // execCommand is deprecated and is still the only fallback where the async API is blocked
          // (an insecure origin, or a permissions policy).
          try { document.execCommand('copy'); done(); } catch (_) { EM.toast('Select the key and copy it manually.', 'bad'); }
        });
      } else {
        try { document.execCommand('copy'); done(); } catch (_) { EM.toast('Select the key and copy it manually.', 'bad'); }
      }
      return;
    }

    if (e.target.closest('[data-k-done]')) {
      document.getElementById('kSecret').value = '';
      if (closers.reveal) closers.reveal();
      location.reload();
      return;
    }

    var revoke = e.target.closest('[data-k-revoke]');
    if (revoke) {
      EM.confirm({
        title: 'Revoke "' + revoke.dataset.name + '"?',
        body: 'It stops working immediately, and anything using it starts failing. The row is kept so past calls can still be attributed to it. This cannot be undone — a new key would be a different key.',
        confirmLabel: 'Revoke key',
        tone: 'danger',
      }).then(function (yes) {
        if (!yes) return;
        EM.api('/api/mail/product/settings', { body: { action: 'key-revoke', id: revoke.dataset.kRevoke } })
          .then(function (res) {
            if (!res.ok) { EM.toast(res.error || 'Nothing was changed.', 'bad'); return; }
            EM.toast(res.note || 'Key revoked.', 'ok', 7000);
            location.reload();
          });
      });
      return;
    }

    /* ---- Webhooks ------------------------------------------------------------------------------ */

    if (e.target.closest('[data-k-hook]')) {
      err(hookModal.querySelector('[data-k-herr]'), '');
      document.getElementById('kUrl').value = '';
      hookModal.querySelectorAll('[data-k-event]').forEach(function (b) { b.checked = false; });
      closers.hook = EM.openModal(hookModal);
      return;
    }

    var createHook = e.target.closest('[data-k-createhook]');
    if (createHook) {
      var url = document.getElementById('kUrl').value.trim();
      var events = [];
      hookModal.querySelectorAll('[data-k-event]:checked').forEach(function (b) { events.push(b.value); });
      if (!/^https:\/\//i.test(url)) { err(hookModal.querySelector('[data-k-herr]'), 'The endpoint must start with https://.'); return; }
      if (!events.length) { err(hookModal.querySelector('[data-k-herr]'), 'Choose at least one event.'); return; }

      EM.busy(createHook, true, 'Adding');
      EM.api('/api/mail/product/settings', { body: { action: 'hook-create', url: url, events: events } })
        .then(function (res) {
          EM.busy(createHook, false);
          if (!res.ok) { err(hookModal.querySelector('[data-k-herr]'), res.error || 'The webhook was not created.'); return; }
          if (closers.hook) closers.hook();
          document.getElementById('kSecret').value = res.secret;
          reveal.querySelector('[data-k-note]').textContent = res.note || '';
          reveal.querySelector('#kRevealTitle').textContent = 'Copy this signing secret now';
          closers.reveal = EM.openModal(reveal, { dismissible: false });
          setTimeout(function () { document.getElementById('kSecret').select(); }, 60);
        });
      return;
    }

    var test = e.target.closest('[data-k-test]');
    if (test) {
      EM.busy(test, true, 'Testing');
      EM.api('/api/mail/product/settings', { body: { action: 'hook-test', id: test.dataset.kTest } })
        .then(function (res) {
          EM.busy(test, false);
          // A real POST to the real endpoint, recorded like any other delivery — a test that only
          // pretended would be testing nothing that matters.
          EM.toast(res.ok ? (res.note || 'Your endpoint accepted the delivery.')
                          : (res.error || 'The endpoint did not accept the delivery.'),
                   res.ok ? 'ok' : 'bad', res.ok ? 6000 : 12000);
        });
      return;
    }

    var log = e.target.closest('[data-k-log]');
    if (log) {
      EM.busy(log, true);
      EM.api('/api/mail/product/settings', { body: { action: 'hook-deliveries', id: log.dataset.kLog } })
        .then(function (res) {
          EM.busy(log, false);
          var host = document.getElementById('kLog');
          if (!res.ok) { EM.toast(res.error || 'The log could not be read.', 'bad'); return; }
          var rows = res.deliveries || [];
          host.innerHTML =
            '<div class="em-card"><div class="em-card-head"><h2 class="em-h2">Recent deliveries</h2>' +
            '<button type="button" class="em-btn ghost sm em-push" data-k-closelog>Close</button></div>' +
            (rows.length === 0
              ? '<div class="em-empty" style="padding:32px"><h3>Nothing delivered yet</h3><p>Deliveries appear here as events happen.</p></div>'
              : '<div class="em-card-body flush"><div class="em-tablewrap"><table class="em-table">' +
                '<thead><tr><th scope="col">Event</th><th scope="col">Result</th><th scope="col">Response</th><th scope="col">When</th></tr></thead><tbody>' +
                rows.map(function (d) {
                  return '<tr><td><span class="em-badge">' + EM.esc(d.event) + '</span></td>' +
                    '<td><span class="em-badge ' + (d.ok ? 'ok' : 'bad') + '">' + (d.ok ? 'accepted' : 'failed') +
                    (d.status_code ? ' ' + d.status_code : '') + '</span>' +
                    (d.attempt > 1 ? ' <span class="em-note">attempt ' + d.attempt + '</span>' : '') + '</td>' +
                    '<td><code class="em-mono" style="word-break:break-all;font-size:11px">' +
                    EM.esc(String(d.response_body || '').slice(0, 160)) + '</code></td>' +
                    '<td><span class="em-note">' + EM.esc(EM.timeAgo(d.created_at)) + '</span></td></tr>';
                }).join('') + '</tbody></table></div></div>') +
            '</div>';
          host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
      return;
    }

    if (e.target.closest('[data-k-closelog]')) { document.getElementById('kLog').innerHTML = ''; return; }

    var toggle = e.target.closest('[data-k-toggle]');
    if (toggle) {
      var active = toggle.dataset.active !== 'true';
      EM.busy(toggle, true);
      EM.api('/api/mail/product/settings', { body: { action: 'hook-active', id: toggle.dataset.kToggle, active: active } })
        .then(function (res) {
          EM.busy(toggle, false);
          if (!res.ok) { EM.toast(res.error || 'Nothing was changed.', 'bad'); return; }
          location.reload();
        });
      return;
    }

    var delHook = e.target.closest('[data-k-delhook]');
    if (delHook) {
      EM.confirm({
        title: 'Delete this webhook?',
        body: 'It stops receiving events immediately, and its delivery log is removed with it. This cannot be undone.',
        confirmLabel: 'Delete webhook',
        tone: 'danger',
      }).then(function (yes) {
        if (!yes) return;
        EM.api('/api/mail/product/settings', { body: { action: 'hook-delete', id: delHook.dataset.kDelhook } })
          .then(function (res) {
            if (!res.ok) { EM.toast(res.error || 'Nothing was deleted.', 'bad'); return; }
            location.reload();
          });
      });
    }
  });
})();
