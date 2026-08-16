/* ================================================================================================
   public/mail/import.js — the two-step CSV importer.

   Step one posts action:'preview' and writes nothing. Step two posts action:'import'.
   The file is read as text in the browser; nothing is uploaded and nothing is stored — this mail
   system has no file store and deliberately does not grow one for a CSV.
   ============================================================================================== */
(function () {
  'use strict';
  var EM = window.EM;
  var root = document.getElementById('imRoot');
  if (!EM || !root) return;

  var customFields = [];
  try { customFields = JSON.parse((document.getElementById('imFields') || {}).textContent || '[]'); } catch (_) {}

  var state = { csv: '', filename: '', headers: [], mapping: {}, sample: [], emailColumn: null };

  var $ = function (s) { return root.querySelector(s); };
  var errBox = $('[data-im-err]');

  function showError(msg) {
    errBox.hidden = !msg;
    if (msg) errBox.querySelector('p').textContent = msg;
  }

  function step(n) {
    root.querySelectorAll('[data-im-panel]').forEach(function (p) { p.hidden = p.dataset.imPanel !== String(n); });
    root.querySelectorAll('[data-im-step]').forEach(function (s) {
      var i = Number(s.dataset.imStep);
      if (i < n) { s.setAttribute('data-done', ''); s.removeAttribute('aria-current'); }
      else if (i === n) { s.removeAttribute('data-done'); s.setAttribute('aria-current', 'step'); }
      else { s.removeAttribute('data-done'); s.removeAttribute('aria-current'); }
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ---- File selection ------------------------------------------------------------------------- */

  var drop = document.getElementById('imDrop');
  var file = document.getElementById('imFile');

  drop.addEventListener('click', function () { file.click(); });
  drop.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); }
  });
  ['dragenter', 'dragover'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', function (e) {
    if (e.dataTransfer.files && e.dataTransfer.files[0]) read(e.dataTransfer.files[0]);
  });
  file.addEventListener('change', function () { if (file.files[0]) read(file.files[0]); });

  function read(f) {
    showError('');
    if (f.size > 12 * 1024 * 1024) {
      showError('That file is ' + (f.size / 1048576).toFixed(1) + ' MB. The limit is 12 MB — split it, so you can see what landed from each part.');
      return;
    }
    var reader = new FileReader();
    reader.onerror = function () { showError('That file could not be read from disk. Nothing has been imported.'); };
    reader.onload = function () {
      state.csv = String(reader.result || '');
      state.filename = f.name;
      preview();
    };
    reader.readAsText(f);
  }

  /* ---- Preview ------------------------------------------------------------------------------- */

  var TARGETS = [
    { value: 'email', label: 'Email address' },
    { value: 'firstName', label: 'First name' },
    { value: 'lastName', label: 'Last name' },
    { value: 'fullName', label: 'Full name (split on the first space)' },
    { value: 'ignore', label: 'Do not import' },
  ];

  function preview() {
    EM.toast('Reading the file…');
    EM.api('/api/mail/product/contacts-io', { body: { action: 'preview', csv: state.csv } }).then(function (res) {
      if (!res.ok) { showError(res.error || 'That file could not be read.'); return; }

      state.headers = res.headers || [];
      state.mapping = res.mapping || {};
      state.sample = res.sample || [];
      state.emailColumn = res.emailColumn;

      $('[data-im-filename]').textContent = state.filename;
      $('[data-im-rows]').textContent = EM.num(res.rowCount);
      $('[data-im-valid]').textContent = EM.num(res.valid);
      $('[data-im-dupes]').textContent = EM.num(res.duplicates);
      $('[data-im-invalid]').textContent = EM.num(res.invalid);
      $('[data-im-noemail]').hidden = !!res.emailColumn;

      renderMapping();
      renderSample();
      step(2);
    });
  }

  function optionsFor(col) {
    var opts = TARGETS.map(function (t) {
      return '<option value="' + t.value + '"' + (state.mapping[col] === t.value ? ' selected' : '') + '>' + EM.esc(t.label) + '</option>';
    });
    // Declared custom fields, then a catch-all that stores the column under its own name.
    customFields.forEach(function (f) {
      var v = 'field:' + f.key;
      opts.push('<option value="' + EM.esc(v) + '"' + (state.mapping[col] === v ? ' selected' : '') + '>Field: ' + EM.esc(f.label) + '</option>');
    });
    var own = 'field:' + String(col).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    if (!customFields.some(function (f) { return 'field:' + f.key === own; })) {
      opts.push('<option value="' + EM.esc(own) + '"' + (state.mapping[col] === own ? ' selected' : '') + '>Store as ' + EM.esc(own.slice(6)) + '</option>');
    }
    return opts.join('');
  }

  function renderMapping() {
    var body = $('[data-im-map]');
    body.innerHTML = state.headers.map(function (h) {
      var firstValue = state.sample.length ? String(state.sample[0][h] == null ? '' : state.sample[0][h]) : '';
      return '<tr>' +
        '<td><code class="em-mono">' + EM.esc(h) + '</code></td>' +
        '<td><select class="em-select" data-im-col="' + EM.esc(h) + '" aria-label="Import the ' + EM.esc(h) + ' column as">' + optionsFor(h) + '</select></td>' +
        '<td><span class="em-note">' + EM.esc(firstValue.slice(0, 50)) + '</span></td>' +
      '</tr>';
    }).join('');
  }

  function renderSample() {
    var t = $('[data-im-sample]');
    if (!state.sample.length) { t.innerHTML = ''; return; }
    t.innerHTML =
      '<thead><tr>' + state.headers.map(function (h) { return '<th scope="col">' + EM.esc(h) + '</th>'; }).join('') + '</tr></thead>' +
      '<tbody>' + state.sample.map(function (r) {
        return '<tr>' + state.headers.map(function (h) {
          return '<td>' + EM.esc(String(r[h] == null ? '' : r[h]).slice(0, 40)) + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody>';
  }

  root.addEventListener('change', function (e) {
    var sel = e.target.closest('[data-im-col]');
    if (!sel) return;
    var col = sel.dataset.imCol;

    // Exactly one column may be the email address. Choosing a second silently demotes the first,
    // which is the kind of quiet reassignment that ends with a whole import rejected.
    if (sel.value === 'email') {
      Object.keys(state.mapping).forEach(function (k) {
        if (k !== col && state.mapping[k] === 'email') state.mapping[k] = 'ignore';
      });
    }
    state.mapping[col] = sel.value;
    state.emailColumn = Object.keys(state.mapping).filter(function (k) { return state.mapping[k] === 'email'; })[0] || null;
    $('[data-im-noemail]').hidden = !!state.emailColumn;
    renderMapping();
  });

  /* ---- Import --------------------------------------------------------------------------------- */

  root.addEventListener('click', function (e) {
    if (e.target.closest('[data-im-back]')) {
      state = { csv: '', filename: '', headers: [], mapping: {}, sample: [], emailColumn: null };
      file.value = '';
      showError('');
      step(1);
      return;
    }

    var run = e.target.closest('[data-im-run]');
    if (!run) return;

    if (!state.emailColumn) {
      EM.toast('Pick the column holding email addresses first. Nothing has been imported.', 'bad');
      return;
    }

    var listId = document.getElementById('imList').value;
    var tags = (document.getElementById('imTags').value || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var rowCount = $('[data-im-rows]').textContent;

    EM.confirm({
      title: 'Import ' + rowCount + ' rows?',
      body: 'New addresses are created and existing ones are updated. Anybody unsubscribed, bounced or complained stays suppressed. This cannot be undone in one step.',
      confirmLabel: 'Import',
    }).then(function (yes) {
      if (!yes) return;
      EM.busy(run, true, 'Importing');
      EM.api('/api/mail/product/contacts-io', {
        body: { action: 'import', csv: state.csv, mapping: state.mapping, listId: listId || null, tags: tags },
      }).then(function (res) {
        EM.busy(run, false);
        if (!res.ok) { EM.toast(res.error || 'Nothing was imported.', 'bad'); return; }

        $('[data-im-created]').textContent = EM.num(res.created);
        $('[data-im-updated]').textContent = EM.num(res.updated);
        $('[data-im-rejected]').textContent = EM.num(res.rejected);

        var host = $('[data-im-rejects]');
        if (res.rejected > 0 && (res.rejectedSample || []).length) {
          host.innerHTML =
            '<h3 class="em-h3" style="margin-bottom:8px">Rows that were not imported</h3>' +
            (res.truncatedErrors
              ? '<p class="em-note" style="margin-bottom:8px">The first ' + res.rejectedSample.length +
                ' are listed; the count above is exact.</p>' : '') +
            '<div class="em-tablewrap"><table class="em-table"><thead><tr>' +
            '<th scope="col">Row</th><th scope="col">Value</th><th scope="col">Why</th></tr></thead><tbody>' +
            res.rejectedSample.map(function (r) {
              return '<tr><td class="num">' + r.row + '</td><td><code class="em-mono">' + EM.esc(r.value) + '</code></td>' +
                     '<td><span class="em-note">' + EM.esc(r.reason) + '</span></td></tr>';
            }).join('') + '</tbody></table></div>';
        } else {
          host.innerHTML = '<p class="em-alert ok" style="margin:0"><span>Every row was imported.</span></p>';
        }

        EM.toast(res.created + ' created, ' + res.updated + ' updated.', 'ok', 6000);
        step(3);
      });
    });
  });
})();
