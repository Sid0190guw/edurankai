/* ================================================================================================
   public/mail/lists.js — the list and segment screens' interactions.

   The segment builder's whole point is the LIVE COUNT: every edit re-asks the server how many
   contacts the rule set matches. Without it a segment is a form somebody fills in and hopes about.
   The count is debounced and aborts its own previous request, so a fast typist does not queue eight
   counts and watch them land out of order.
   ============================================================================================== */
(function () {
  'use strict';
  var EM = window.EM;
  if (!EM) return;

  var data = { lists: [], fields: [], segments: [] };
  try { data = JSON.parse((document.getElementById('lsData') || {}).textContent || '{}'); } catch (_) {}

  var FIELDS = [
    { key: 'email', label: 'Email address' },
    { key: 'first_name', label: 'First name' },
    { key: 'last_name', label: 'Last name' },
    { key: 'status', label: 'Subscription status' },
    { key: 'tag', label: 'Tag' },
    { key: 'list', label: 'List membership' },
    { key: 'source', label: 'Source' },
    { key: 'created_at', label: 'Date added' },
    { key: 'field', label: 'Custom field' },
  ];
  var OPS = {
    text: ['is', 'is_not', 'contains', 'not_contains', 'starts_with', 'ends_with', 'is_set', 'is_not_set'],
    status: ['is', 'is_not'],
    tag: ['is', 'is_not'],
    list: ['is', 'is_not'],
    date: ['before', 'after'],
  };
  var OP_LABEL = {
    is: 'is', is_not: 'is not', contains: 'contains', not_contains: 'does not contain',
    starts_with: 'starts with', ends_with: 'ends with', is_set: 'is set', is_not_set: 'is not set',
    before: 'before', after: 'on or after',
  };
  function opsFor(field) {
    if (field === 'status') return OPS.status;
    if (field === 'tag') return OPS.tag;
    if (field === 'list') return OPS.list;
    if (field === 'created_at') return OPS.date;
    return OPS.text;
  }

  /* ---- List dialog ------------------------------------------------------------------------- */

  var listModal = document.getElementById('lsListModal');
  var segModal = document.getElementById('lsSegModal');
  var closeCurrent = null;

  function err(box, msg) {
    if (!box) return;
    box.hidden = !msg;
    if (msg) box.querySelector('p').textContent = msg;
  }

  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-ls-cancel]')) { if (closeCurrent) closeCurrent(); return; }

    if (e.target.closest('[data-ls-new-list]')) {
      err(listModal.querySelector('[data-ls-err]'), '');
      document.getElementById('lsListName').value = '';
      document.getElementById('lsListDesc').value = '';
      closeCurrent = EM.openModal(listModal);
      return;
    }

    if (e.target.closest('[data-ls-save-list]')) {
      var btn = e.target.closest('[data-ls-save-list]');
      var name = document.getElementById('lsListName').value.trim();
      if (!name) { err(listModal.querySelector('[data-ls-err]'), 'Give the list a name.'); return; }
      EM.busy(btn, true, 'Creating');
      EM.api('/api/mail/product/audience', {
        body: { action: 'list-create', name: name, description: document.getElementById('lsListDesc').value },
      }).then(function (res) {
        EM.busy(btn, false);
        if (!res.ok) { err(listModal.querySelector('[data-ls-err]'), res.error || 'The list was not created.'); return; }
        EM.toast('List created.', 'ok');
        location.reload();
      });
      return;
    }

    var delList = e.target.closest('[data-ls-del-list]');
    if (delList) {
      EM.confirm({
        title: 'Delete the list "' + delList.dataset.name + '"?',
        body: 'The list is removed. The contacts on it are NOT deleted — they stay in your audience and on any other list.',
        confirmLabel: 'Delete list',
        tone: 'danger',
      }).then(function (yes) {
        if (!yes) return;
        EM.api('/api/mail/product/audience', { body: { action: 'list-delete', id: delList.dataset.lsDelList } })
          .then(function (res) {
            if (!res.ok) { EM.toast(res.error || 'The list was not deleted.', 'bad'); return; }
            EM.toast('List deleted.', 'ok');
            location.reload();
          });
      });
      return;
    }

    var delField = e.target.closest('[data-ls-del-field]');
    if (delField) {
      EM.confirm({
        title: 'Remove this field?',
        body: 'It stops being offered in forms and in the variable picker. Values already stored on contacts are left alone — nothing is rewritten.',
        confirmLabel: 'Remove field',
        tone: 'danger',
      }).then(function (yes) {
        if (!yes) return;
        EM.api('/api/mail/product/audience', { body: { action: 'field-delete', id: delField.dataset.lsDelField } })
          .then(function (res) {
            EM.toast(res.ok ? (res.note || 'Field removed.') : (res.error || 'Nothing was changed.'), res.ok ? 'ok' : 'bad');
            if (res.ok) location.reload();
          });
      });
      return;
    }

    if (e.target.closest('[data-ls-new-field]')) {
      var label = window.prompt('Field name (what a person sees), e.g. "Application ID"');
      if (!label || !label.trim()) return;
      EM.api('/api/mail/product/audience', { body: { action: 'field-create', label: label.trim() } })
        .then(function (res) {
          if (!res.ok) { EM.toast(res.error || 'The field was not created.', 'bad'); return; }
          EM.toast('Field created. Use it as {{' + res.key + '}}.', 'ok', 6000);
          location.reload();
        });
      return;
    }
  });

  /* ---- Segment builder ------------------------------------------------------------------------ */

  var condHost = document.getElementById('lsConds');
  var liveEl = segModal && segModal.querySelector('[data-ls-live]');
  var editingId = null;
  var countCtrl = null;

  function condRow(c) {
    c = c || { field: 'tag', op: 'is', value: '' };
    var row = document.createElement('div');
    row.className = 'ls-cond';
    row.innerHTML =
      '<select class="em-select" data-c-field aria-label="Field">' +
        FIELDS.map(function (f) { return '<option value="' + f.key + '"' + (c.field === f.key ? ' selected' : '') + '>' + EM.esc(f.label) + '</option>'; }).join('') +
      '</select>' +
      '<input class="em-input" data-c-key placeholder="field key" aria-label="Custom field key" style="max-width:130px"' +
        (c.field === 'field' ? '' : ' hidden') + ' value="' + EM.esc(c.key || '') + '" />' +
      '<select class="em-select" data-c-op aria-label="Comparison" style="max-width:170px"></select>' +
      '<input class="em-input" data-c-value aria-label="Value" value="' + EM.esc(c.value || '') + '" />' +
      '<button type="button" class="em-btn ghost icon sm" data-c-remove aria-label="Remove condition">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>' +
      '</button>';
    condHost.appendChild(row);
    syncOps(row, c.op);
    return row;
  }

  function syncOps(row, keep) {
    var field = row.querySelector('[data-c-field]').value;
    var opSel = row.querySelector('[data-c-op]');
    var list = opsFor(field);
    opSel.innerHTML = list.map(function (o) {
      return '<option value="' + o + '"' + (o === keep ? ' selected' : '') + '>' + OP_LABEL[o] + '</option>';
    }).join('');
    row.querySelector('[data-c-key]').hidden = field !== 'field';

    // The value control changes shape with the field — a date picker for a date, a fixed list for a
    // status, the actual lists for list membership. A free-text box for all of them is how people
    // type "Subscribed" into a field that only matches "subscribed".
    var valueEl = row.querySelector('[data-c-value]');
    var current = valueEl.value;
    var replacement = null;
    if (field === 'status') {
      replacement = document.createElement('select');
      replacement.className = 'em-select';
      replacement.innerHTML = ['subscribed', 'unconfirmed', 'unsubscribed', 'bounced', 'complained']
        .map(function (s) { return '<option value="' + s + '"' + (s === current ? ' selected' : '') + '>' + s + '</option>'; }).join('');
    } else if (field === 'list') {
      replacement = document.createElement('select');
      replacement.className = 'em-select';
      replacement.innerHTML = data.lists.map(function (l) {
        return '<option value="' + EM.esc(l.id) + '"' + (l.id === current ? ' selected' : '') + '>' + EM.esc(l.name) + '</option>';
      }).join('') || '<option value="">No lists exist yet</option>';
    } else if (field === 'created_at') {
      replacement = document.createElement('input');
      replacement.className = 'em-input';
      replacement.type = 'date';
      replacement.value = current;
    } else if (valueEl.tagName !== 'INPUT' || valueEl.type !== 'text') {
      replacement = document.createElement('input');
      replacement.className = 'em-input';
      replacement.type = 'text';
      replacement.value = current;
    }
    if (replacement) {
      replacement.setAttribute('data-c-value', '');
      replacement.setAttribute('aria-label', 'Value');
      valueEl.replaceWith(replacement);
    }
    var setOps = opsFor(field);
    var noValue = opSel.value === 'is_set' || opSel.value === 'is_not_set';
    row.querySelector('[data-c-value]').hidden = noValue;
  }

  function readRules() {
    var conditions = [];
    condHost.querySelectorAll('.ls-cond').forEach(function (row) {
      var field = row.querySelector('[data-c-field]').value;
      var op = row.querySelector('[data-c-op]').value;
      var valueEl = row.querySelector('[data-c-value]');
      conditions.push({
        field: field, op: op,
        value: valueEl ? valueEl.value : '',
        key: field === 'field' ? row.querySelector('[data-c-key]').value : undefined,
      });
    });
    return { match: document.getElementById('lsSegMatch').value, conditions: conditions };
  }

  var recount = EM.debounce(function () {
    if (countCtrl) countCtrl.abort();
    countCtrl = new AbortController();
    if (liveEl) { liveEl.textContent = 'counting…'; liveEl.className = 'em-badge em-push'; }
    EM.api('/api/mail/product/audience', { body: { action: 'segment-count', rules: readRules() }, signal: countCtrl.signal })
      .then(function (res) {
        if (res.aborted || !liveEl) return;
        if (!res.ok) { liveEl.textContent = 'count unavailable'; liveEl.className = 'em-badge bad em-push'; return; }
        liveEl.textContent = EM.num(res.count) + ' contact' + (res.count === 1 ? '' : 's') + ' match now';
        // "Matches everybody" is a warning, not a neutral fact.
        liveEl.className = 'em-badge em-push ' + (res.unrestricted ? 'warn' : 'accent');
        if (res.unrestricted) liveEl.title = res.note || '';
      });
  }, 320);

  if (condHost) {
    condHost.addEventListener('change', function (e) {
      var row = e.target.closest('.ls-cond');
      if (!row) return;
      if (e.target.matches('[data-c-field]') || e.target.matches('[data-c-op]')) {
        syncOps(row, e.target.matches('[data-c-op]') ? e.target.value : undefined);
      }
      recount();
    });
    condHost.addEventListener('input', recount);
    condHost.addEventListener('click', function (e) {
      if (e.target.closest('[data-c-remove]')) {
        e.target.closest('.ls-cond').remove();
        recount();
      }
    });
  }

  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-ls-add-cond]')) { condRow(); recount(); return; }

    if (e.target.closest('[data-ls-new-segment]')) {
      editingId = null;
      err(segModal.querySelector('[data-ls-serr]'), '');
      document.getElementById('lsSegTitle').textContent = 'New segment';
      document.getElementById('lsSegName').value = '';
      document.getElementById('lsSegMatch').value = 'all';
      condHost.innerHTML = '';
      condRow();
      closeCurrent = EM.openModal(segModal);
      recount();
      return;
    }

    var edit = e.target.closest('[data-ls-edit-segment]');
    if (edit) {
      var payload = {};
      try { payload = JSON.parse(edit.dataset.payload || '{}'); } catch (_) {}
      editingId = payload.id;
      err(segModal.querySelector('[data-ls-serr]'), '');
      document.getElementById('lsSegTitle').textContent = 'Edit segment';
      document.getElementById('lsSegName').value = payload.name || '';
      document.getElementById('lsSegMatch').value = (payload.rules && payload.rules.match) || 'all';
      condHost.innerHTML = '';
      ((payload.rules && payload.rules.conditions) || []).forEach(condRow);
      if (!condHost.children.length) condRow();
      closeCurrent = EM.openModal(segModal);
      recount();
      return;
    }

    if (e.target.closest('[data-ls-save-seg]')) {
      var btn = e.target.closest('[data-ls-save-seg]');
      var name = document.getElementById('lsSegName').value.trim();
      if (!name) { err(segModal.querySelector('[data-ls-serr]'), 'Give the segment a name.'); return; }
      EM.busy(btn, true, 'Saving');
      EM.api('/api/mail/product/audience', {
        body: {
          action: editingId ? 'segment-update' : 'segment-create',
          id: editingId, name: name, rules: readRules(),
        },
      }).then(function (res) {
        EM.busy(btn, false);
        if (!res.ok) { err(segModal.querySelector('[data-ls-serr]'), res.error || 'The segment was not saved.'); return; }
        EM.toast('Segment saved.', 'ok');
        location.reload();
      });
      return;
    }

    var delSeg = e.target.closest('[data-ls-del-segment]');
    if (delSeg) {
      EM.confirm({
        title: 'Delete the segment "' + delSeg.dataset.name + '"?',
        body: 'The filter is removed. No contact is deleted. Campaigns that already sent to it keep their frozen recipient list.',
        confirmLabel: 'Delete segment',
        tone: 'danger',
      }).then(function (yes) {
        if (!yes) return;
        EM.api('/api/mail/product/audience', { body: { action: 'segment-delete', id: delSeg.dataset.lsDelSegment } })
          .then(function (res) {
            if (!res.ok) { EM.toast(res.error || 'Nothing was deleted.', 'bad'); return; }
            location.reload();
          });
      });
    }
  });

  /* ---- Live counts in the segment table --------------------------------------------------------- */
  /* Sequential, not parallel: a page with twenty segments would otherwise open twenty connections at
     once and each of those is a COUNT over the contact table.                                        */

  (function countSegments(i) {
    var s = data.segments[i];
    if (!s) return;
    EM.api('/api/mail/product/audience', { body: { action: 'segment-count', rules: s.rules } }).then(function (res) {
      var cell = document.querySelector('[data-ls-count="' + s.id + '"]');
      if (cell) {
        cell.className = '';
        cell.textContent = res.ok ? EM.num(res.count) : '—';
        if (res.ok && res.unrestricted) cell.title = 'This segment has no conditions, so it matches every contact.';
      }
      countSegments(i + 1);
    });
  })(0);

  var style = document.createElement('style');
  style.textContent =
    '.ls-cond{display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap}' +
    '.ls-cond .em-select,.ls-cond .em-input{flex:1;min-width:120px}' +
    '.ls-cond [data-c-field]{max-width:180px}';
  document.head.appendChild(style);
})();
