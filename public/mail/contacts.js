/* ================================================================================================
   public/mail/contacts.js — the contact list's interactions.

   Selection, bulk actions, "load 50 more" by cursor, the add/edit dialog, and export.
   The row markup is produced HERE for appended pages, matching the <tbody> the server rendered —
   the two are kept in step by rendering the same six cells in the same order, and by there being
   exactly one place in this file that builds a row.
   ============================================================================================== */
(function () {
  'use strict';
  var EM = window.EM;
  var root = document.getElementById('ctRoot');
  if (!EM || !root) return;

  var filter = {};
  try { filter = JSON.parse(root.dataset.filter || '{}'); } catch (_) {}
  var lists = [];
  try { lists = JSON.parse((document.getElementById('ctLists') || {}).textContent || '[]'); } catch (_) {}

  var body = root.querySelector('[data-ct-body]');
  var bulk = root.querySelector('[data-ct-bulk]');
  var countEl = root.querySelector('[data-ct-count]');
  var shownEl = root.querySelector('[data-ct-shown]');
  var moreBtn = root.querySelector('[data-ct-more]');
  var picked = Object.create(null);
  var shown = body ? body.children.length : 0;

  var STATUS_TONE = { subscribed: 'ok', unconfirmed: 'warn', unsubscribed: '', bounced: 'bad', complained: 'bad' };

  /* ---- Selection ------------------------------------------------------------------------------ */

  function ids() { return Object.keys(picked); }

  function sync() {
    var n = ids().length;
    if (bulk) bulk.hidden = n === 0;
    if (countEl) countEl.textContent = n + ' selected';
    var all = root.querySelector('[data-ct-all]');
    if (all) {
      var boxes = root.querySelectorAll('[data-ct-pick]');
      all.checked = n > 0 && n === boxes.length;
      all.indeterminate = n > 0 && n < boxes.length;
    }
  }

  root.addEventListener('change', function (e) {
    var box = e.target.closest('[data-ct-pick]');
    if (box) {
      if (box.checked) picked[box.value] = true; else delete picked[box.value];
      sync();
      return;
    }
    var all = e.target.closest('[data-ct-all]');
    if (all) {
      // "Select all" means EVERY ROW ON THIS PAGE, and nothing beyond it. There is deliberately no
      // "select all 240,000 matching" — a destructive action against a set nobody can see is not a
      // set anybody can consent to.
      root.querySelectorAll('[data-ct-pick]').forEach(function (b) {
        b.checked = all.checked;
        if (all.checked) picked[b.value] = true; else delete picked[b.value];
      });
      sync();
    }
  });

  var clearBtn = root.querySelector('[data-ct-bulk-clear]');
  if (clearBtn) clearBtn.addEventListener('click', function () {
    picked = Object.create(null);
    root.querySelectorAll('[data-ct-pick]').forEach(function (b) { b.checked = false; });
    sync();
  });

  /* ---- Bulk actions ----------------------------------------------------------------------------- */

  root.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-ct-bulk-act]');
    if (!btn) return;
    var selected = ids();
    if (!selected.length) return;
    var kind = btn.dataset.ctBulkAct;

    if (kind === 'unsubscribe') {
      EM.confirm({
        title: 'Unsubscribe ' + selected.length + ' contact' + (selected.length === 1 ? '' : 's') + '?',
        body: 'They stop receiving campaigns immediately. This is deliberately hard to undo: a later import will NOT resubscribe them, because that is how a suppression list gets wiped by accident.',
        confirmLabel: 'Unsubscribe ' + selected.length,
        tone: 'danger',
      }).then(function (yes) {
        if (!yes) return;
        EM.busy(btn, true);
        EM.api('/api/mail/product/contacts', { body: { action: 'bulk-status', ids: selected, status: 'unsubscribed' } })
          .then(function (res) {
            EM.busy(btn, false);
            if (!res.ok) { EM.toast(res.error || 'Nothing was changed.', 'bad'); return; }
            EM.toast(res.changed + ' of ' + res.asked + ' contacts unsubscribed.', 'ok');
            setTimeout(function () { location.reload(); }, 700);
          });
      });
      return;
    }

    if (kind === 'bulk-list') {
      if (!lists.length) { EM.toast('There are no lists yet. Create one on Lists & segments first.', 'bad'); return; }
      var options = lists.map(function (l, i) { return (i + 1) + '. ' + l.name; }).join('\n');
      var pick = window.prompt('Add ' + selected.length + ' contact(s) to which list?\n\n' + options, '1');
      var idx = parseInt(pick, 10) - 1;
      if (!(idx >= 0 && idx < lists.length)) return;
      EM.busy(btn, true);
      EM.api('/api/mail/product/contacts', { body: { action: 'bulk-list', ids: selected, listId: lists[idx].id } })
        .then(function (res) {
          EM.busy(btn, false);
          EM.toast(res.ok ? res.changed + ' added to ' + lists[idx].name + '.' : (res.error || 'Nothing was changed.'), res.ok ? 'ok' : 'bad');
        });
      return;
    }

    if (kind === 'bulk-tag') {
      var tag = window.prompt('Tag ' + selected.length + ' contact(s) with:', '');
      if (!tag || !tag.trim()) return;
      EM.busy(btn, true);
      EM.api('/api/mail/product/contacts', { body: { action: 'bulk-tag', ids: selected, tag: tag.trim() } })
        .then(function (res) {
          EM.busy(btn, false);
          if (!res.ok) { EM.toast(res.error || 'Nothing was changed.', 'bad'); return; }
          EM.toast(res.changed + ' contacts tagged "' + tag.trim() + '".', 'ok');
          setTimeout(function () { location.reload(); }, 700);
        });
    }
  });

  /* ---- Paging ------------------------------------------------------------------------------------ */

  function esc(v) { return EM.esc(v); }

  function rowHtml(c) {
    var name = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email;
    var tags = (c.tags || []).slice(0, 3).map(function (t) {
      return '<span class="em-badge" style="margin-inline-end:4px">' + esc(t) + '</span>';
    }).join('');
    return '<tr data-id="' + esc(c.id) + '">' +
      '<td class="pick"><input type="checkbox" data-ct-pick value="' + esc(c.id) + '" aria-label="Select ' + esc(c.email) + '" /></td>' +
      '<td><span class="em-row tight" style="flex-wrap:nowrap">' +
        '<span class="em-avatar sm" aria-hidden="true" style="background:' + EM.avatarColour(c.email) + '">' + esc(EM.initials(name, c.email)) + '</span>' +
        '<span style="min-width:0"><a href="/mail/contacts/' + esc(c.id) + '">' + esc(name) + '</a>' +
        '<div class="em-note em-mono">' + esc(c.email) + '</div></span>' +
      '</span></td>' +
      '<td><span class="em-badge ' + (STATUS_TONE[c.status] || '') + '">' + esc(c.status) + '</span></td>' +
      '<td>' + tags + '</td>' +
      '<td><span class="em-note">' + esc(EM.timeAgo(c.created_at)) + '</span></td>' +
      '<td><a class="em-btn ghost sm" href="/mail/contacts/' + esc(c.id) + '">Open</a></td>' +
    '</tr>';
  }

  if (moreBtn) {
    moreBtn.addEventListener('click', function () {
      EM.busy(moreBtn, true, 'Loading');
      var params = new URLSearchParams();
      if (filter.q) params.set('q', filter.q);
      if (filter.status && filter.status !== 'all') params.set('status', filter.status);
      if (filter.listId) params.set('listId', filter.listId);
      if (filter.segmentId) params.set('segmentId', filter.segmentId);
      if (filter.tag) params.set('tag', filter.tag);
      params.set('cursor', moreBtn.dataset.cursor);
      params.set('limit', '50');

      EM.api('/api/mail/product/contacts?' + params.toString()).then(function (res) {
        EM.busy(moreBtn, false);
        if (!res.ok) { EM.toast(res.error || 'More contacts could not be loaded.', 'bad'); return; }
        body.insertAdjacentHTML('beforeend', (res.rows || []).map(rowHtml).join(''));
        shown += (res.rows || []).length;
        if (shownEl) shownEl.textContent = 'Showing ' + EM.num(shown) + ' contacts';
        if (res.nextCursor) moreBtn.dataset.cursor = res.nextCursor;
        else moreBtn.remove();
        sync();
      });
    });
  }

  /* ---- Export ------------------------------------------------------------------------------------- */

  document.addEventListener('click', function (e) {
    if (!e.target.closest('[data-ct-export]')) return;
    var params = new URLSearchParams();
    if (filter.q) params.set('q', filter.q);
    if (filter.status && filter.status !== 'all') params.set('status', filter.status);
    if (filter.listId) params.set('listId', filter.listId);
    if (filter.segmentId) params.set('segmentId', filter.segmentId);
    if (filter.tag) params.set('tag', filter.tag);
    // A plain navigation, so the browser's own download UI handles it and a large export streams
    // instead of being buffered in a blob.
    EM.toast('The export is streaming. Large exports take a moment to start.', '', 5000);
    location.href = '/api/mail/product/contacts-io?' + params.toString();
  });

  /* ---- Add contact ---------------------------------------------------------------------------------- */

  var modal = document.getElementById('ctModal');
  var closeModal = null;
  var errBox = modal && modal.querySelector('[data-ct-error]');

  function showError(msg) {
    if (!errBox) return;
    errBox.hidden = !msg;
    if (msg) errBox.querySelector('p').textContent = msg;
  }

  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-ct-new]')) {
      showError('');
      closeModal = EM.openModal(modal);
      return;
    }
    if (e.target.closest('[data-ct-cancel]')) { if (closeModal) closeModal(); return; }

    if (e.target.closest('[data-ct-save]')) {
      var btn = e.target.closest('[data-ct-save]');
      var email = (document.getElementById('ctEmail').value || '').trim();
      if (!email || email.indexOf('@') < 1) { showError('Enter a valid email address. Nothing has been saved.'); return; }
      showError('');

      var fields = {};
      modal.querySelectorAll('[data-ct-field]').forEach(function (el) {
        if (el.value.trim()) fields[el.dataset.ctField] = el.value.trim();
      });
      var listIds = [];
      modal.querySelectorAll('[data-ct-listpick]:checked').forEach(function (el) { listIds.push(el.value); });

      EM.busy(btn, true, 'Saving');
      EM.api('/api/mail/product/contacts', {
        body: {
          action: 'create',
          email: email,
          firstName: document.getElementById('ctFirst').value,
          lastName: document.getElementById('ctLast').value,
          tags: (document.getElementById('ctTags').value || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
          fields: fields,
          listIds: listIds,
        },
      }).then(function (res) {
        EM.busy(btn, false);
        if (!res.ok) { showError(res.error || 'The contact was not saved.'); return; }
        EM.toast(res.created ? 'Contact added.' : 'That address already existed, so its details were updated.', 'ok');
        if (closeModal) closeModal();
        setTimeout(function () { location.reload(); }, 600);
      });
    }
  });

  sync();
})();
