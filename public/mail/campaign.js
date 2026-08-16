/* ================================================================================================
   public/mail/campaign.js — the campaign screen: autosave, the live audience count, and dispatch.

   DISPATCH IS A LOOP OF BOUNDED REQUESTS. Each POST sends one batch and answers with how many are
   left; the loop continues while `remaining > 0` and the page is open. That means:
     - a serverless request is never asked to hold a fifty-thousand-message send open
     - progress on screen is the real count of rows that have left 'queued', not an animation
     - closing the tab pauses the send rather than losing it — reopening and pressing Continue
       resumes from exactly where the recipient rows say it stopped
   A refusal (no transport, wrong state) STOPS the loop and shows the reason. It never retries into
   a wall.
   ============================================================================================== */
(function () {
  'use strict';
  var EM = window.EM;
  var root = document.getElementById('cRoot');
  if (!EM || !root) return;

  var id = root.dataset.id;
  var status = root.dataset.status;

  function field(sel) { var el = document.getElementById(sel); return el ? el.value : undefined; }

  function collect() {
    var listIds = [];
    root.querySelectorAll('[data-c-list]:checked').forEach(function (b) { listIds.push(b.value); });
    return {
      name: field('cName'),
      subject: field('cSubject'),
      preheader: field('cPreheader'),
      fromName: field('cFromName'),
      fromEmail: field('cFromEmail'),
      replyTo: field('cReplyTo'),
      listIds: listIds,
      segmentId: field('cSegment') || null,
    };
  }

  /* ---- Autosave ------------------------------------------------------------------------------- */

  var dirty = false;
  var saving = false;

  function save(explicit) {
    if (saving) return Promise.resolve({ ok: true });
    saving = true;
    var patch = collect();
    patch.action = 'save';
    patch.id = id;
    return EM.api('/api/mail/product/campaigns', { body: patch }).then(function (res) {
      saving = false;
      if (res.ok) {
        dirty = false;
        if (explicit) EM.toast('Saved.', 'ok');
      } else if (explicit) {
        EM.toast(res.error || 'This campaign was NOT saved.', 'bad');
      }
      return res;
    });
  }

  var autosave = EM.debounce(function () { save(false); }, 1200);

  root.addEventListener('input', function (e) {
    if (e.target.closest('.em-card')) { dirty = true; autosave(); }
  });
  root.addEventListener('change', function (e) {
    if (e.target.matches('[data-c-list]') || e.target.matches('#cSegment')) {
      dirty = true;
      save(false).then(recount);
    }
  });

  window.addEventListener('beforeunload', function (e) {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  var saveBtn = root.querySelector('[data-c-save]') || document.querySelector('[data-c-save]');
  if (saveBtn) saveBtn.addEventListener('click', function () {
    EM.busy(saveBtn, true, 'Saving');
    save(true).then(function () { EM.busy(saveBtn, false); });
  });

  /* ---- Subject length hint ---------------------------------------------------------------------- */

  var subject = document.getElementById('cSubject');
  var subHint = root.querySelector('[data-c-sublen]');
  if (subject && subHint) {
    var base = subHint.textContent;
    var updateLen = function () {
      var n = subject.value.length;
      subHint.textContent = n + ' characters. ' + base;
      subHint.style.color = n > 60 ? 'var(--em-warn)' : '';
    };
    subject.addEventListener('input', updateLen);
    updateLen();
  }

  /* ---- Live audience count ------------------------------------------------------------------------ */

  var audienceEl = root.querySelector('[data-c-audience]');

  function recount() {
    if (!audienceEl) return;
    audienceEl.textContent = 'counting…';
    audienceEl.className = 'em-badge em-push';
    EM.api('/api/mail/product/campaigns?id=' + encodeURIComponent(id)).then(function (res) {
      if (!res.ok) { audienceEl.textContent = 'count unavailable'; audienceEl.className = 'em-badge bad em-push'; return; }
      audienceEl.textContent = EM.num(res.audience) + ' will receive it';
      // Nobody is a warning, not a number. It is the most common reason a campaign "did not send".
      audienceEl.className = 'em-badge em-push ' + (res.audience === 0 ? 'bad' : 'accent');
      if (res.audience === 0) audienceEl.title = 'No subscribed contact matches these lists and this segment, so there is nobody to send to.';
    });
  }

  /* ---- Template ---------------------------------------------------------------------------------- */

  var tplSel = root.querySelector('[data-c-template]');
  if (tplSel) tplSel.addEventListener('change', function () {
    if (!tplSel.value) return;
    EM.confirm({
      title: 'Start from this template?',
      body: 'The campaign content is replaced with the template. Anything already designed here is lost.',
      confirmLabel: 'Replace content',
      tone: 'danger',
    }).then(function (yes) {
      if (!yes) { tplSel.value = ''; return; }
      EM.api('/api/mail/product/templates?id=' + encodeURIComponent(tplSel.value)).then(function (res) {
        if (!res.ok || !res.template) { EM.toast(res.error || 'The template could not be read.', 'bad'); return; }
        EM.api('/api/mail/product/campaigns', {
          body: {
            action: 'save', id: id,
            templateId: tplSel.value,
            subject: field('cSubject') || res.template.subject,
            blocks: res.template.blocks || { version: 1, blocks: [] },
          },
        }).then(function (r2) {
          if (!r2.ok) { EM.toast(r2.error || 'The template was not applied.', 'bad'); return; }
          EM.toast('Template applied.', 'ok');
          location.reload();
        });
      });
    });
  });

  /* ---- Test send ----------------------------------------------------------------------------------- */

  var testBtn = root.querySelector('[data-c-test]');
  if (testBtn) testBtn.addEventListener('click', function () {
    var to = (document.getElementById('cTestTo') || {}).value || '';
    if (!to.trim()) { EM.toast('Enter an address to send the test to.', 'bad'); return; }
    EM.busy(testBtn, true, 'Sending');
    // Save first, so the test is of what is on screen rather than of what was last stored.
    save(false).then(function () {
      EM.api('/api/mail/product/campaigns', { body: { action: 'test', id: id, to: to.trim() } })
        .then(function (res) {
          EM.busy(testBtn, false);
          EM.toast(res.ok ? (res.note || 'Test sent.') : (res.error || 'The test was not sent.'), res.ok ? 'ok' : 'bad', res.ok ? 6000 : 12000);
        });
    });
  });

  /* ---- Dispatch loop ---------------------------------------------------------------------------------- */

  var running = false;

  function runBatches(btn) {
    if (running) return;
    running = true;
    EM.busy(btn, true, 'Sending');

    var sent = 0;
    var failed = 0;

    function step() {
      return EM.api('/api/mail/product/campaigns', { body: { action: 'dispatch', id: id, batchSize: 25 } })
        .then(function (res) {
          if (!res.ok) {
            // A refusal is final. Retrying into "no transport configured" would spin for ever.
            running = false;
            EM.busy(btn, false);
            EM.toast(res.error || 'Sending stopped.', 'bad', 14000);
            setTimeout(function () { location.reload(); }, 2500);
            return;
          }

          sent += res.sent || 0;
          failed += res.failed || 0;
          paint(res);

          if (res.remaining > 0 && res.status === 'sending') return step();

          running = false;
          EM.busy(btn, false);
          if (res.status === 'completed') {
            EM.toast('Campaign complete. ' + EM.num(sent) + ' sent' + (failed ? ', ' + EM.num(failed) + ' failed' : '') + '.',
                     failed ? 'bad' : 'ok', 9000);
          } else {
            EM.toast('Sending stopped: the campaign is now ' + res.status + '.', '', 7000);
          }
          setTimeout(function () { location.reload(); }, 1800);
        });
    }

    step();
  }

  /**
   * Paint one batch's result.
   *
   * TWO NUMBERS COME FROM THE SERVER AND ONE FROM THE PAGE, and that split is the point:
   *   res.remaining  — a COUNT over mail_campaign_recipients. Authoritative, and it is the only
   *                    figure that stays correct when a batch is retried or a second dispatcher runs.
   *   data-total     — the frozen recipient count, rendered server-side. The denominator.
   *   sent / failed  — accumulated here purely so the two tiles tick up as it goes; the page reloads
   *                    when the loop ends, at which point both come from the database again.
   */
  function paint(res) {
    var label = root.querySelector('[data-c-progress-label]');
    var bar = root.querySelector('[data-c-progress]');
    var sentEl = root.querySelector('[data-c-sent]');
    var failedEl = root.querySelector('[data-c-failed]');

    var digits = function (el) { return el ? (Number(String(el.textContent).replace(/[^0-9]/g, '')) || 0) : 0; };

    if (sentEl && res.sent) sentEl.textContent = EM.num(digits(sentEl) + res.sent);
    if (failedEl && res.failed) {
      failedEl.textContent = EM.num(digits(failedEl) + res.failed);
      failedEl.style.color = 'var(--em-bad)';
    }

    if (!label || !bar) return;
    var total = Number(label.dataset.total) || 0;
    if (total <= 0) return;

    var done = Math.max(0, total - (Number(res.remaining) || 0));
    var pctDone = Math.min(100, Math.round((done / total) * 100));
    bar.style.width = pctDone + '%';
    if (bar.parentElement) bar.parentElement.setAttribute('aria-valuenow', String(pctDone));
    label.textContent = EM.num(done) + ' of ' + EM.num(total) + ' attempted';
  }

  /* ---- Actions ------------------------------------------------------------------------------------------- */

  root.addEventListener('click', function (e) {
    var run = e.target.closest('[data-c-run]');
    if (run) { runBatches(run); return; }

    var btn = e.target.closest('[data-c-act]');
    if (!btn) return;
    var action = btn.dataset.cAct;

    var confirms = {
      queue: {
        title: 'Send this campaign?',
        body: 'The recipient list is built and frozen now, and messages start going out. It can be paused, but anything already sent has been sent.',
        confirmLabel: 'Build the list and send',
      },
      cancel: {
        title: 'Cancel this campaign?',
        body: 'Everything not yet attempted is dropped. Anything already sent stays sent. This cannot be undone.',
        confirmLabel: 'Cancel the send',
        tone: 'danger',
      },
      delete: {
        title: 'Delete this campaign?',
        body: 'The campaign and its report are removed permanently. This cannot be undone.',
        confirmLabel: 'Delete permanently',
        tone: 'danger',
      },
      schedule: null, pause: null, duplicate: null,
    };

    var go = confirms[action] ? EM.confirm(confirms[action]) : Promise.resolve(true);

    go.then(function (yes) {
      if (!yes) return;
      var body = { action: action, id: id };
      if (action === 'schedule') {
        var when = (document.getElementById('cSchedule') || {}).value;
        if (!when) { EM.toast('Pick a date and time first.', 'bad'); return; }
        body.scheduledAt = new Date(when).toISOString();
      }

      EM.busy(btn, true);
      // Save first for anything that acts on stored content, so what is sent is what is on screen.
      var prep = (action === 'queue' || action === 'schedule') ? save(false) : Promise.resolve({ ok: true });

      prep.then(function () {
        EM.api('/api/mail/product/campaigns', { body: body }).then(function (res) {
          EM.busy(btn, false);
          if (!res.ok) { EM.toast(res.error || 'That did not go through, and the campaign is unchanged.', 'bad', 12000); return; }

          if (action === 'delete') { location.href = '/mail/campaigns'; return; }
          if (action === 'duplicate') { location.href = '/mail/campaigns/' + res.id; return; }
          if (action === 'queue') {
            dirty = false;
            EM.toast('Queued for ' + EM.num(res.total) + ' recipients. Starting to send…', 'ok');
            setTimeout(function () { location.reload(); }, 900);
            return;
          }
          dirty = false;
          EM.toast('Done.', 'ok');
          setTimeout(function () { location.reload(); }, 700);
        });
      });
    });
  });

  // A campaign that is queued or sending when the page opens starts working immediately, so
  // "Sending" on screen is a thing that is happening rather than a label.
  if (status === 'sending') {
    var auto = root.querySelector('[data-c-run]');
    if (auto) runBatches(auto);
  }
})();
