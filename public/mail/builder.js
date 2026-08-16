/* ================================================================================================
   public/mail/builder.js — the email builder.
   ------------------------------------------------------------------------------------------------
   THE DOCUMENT IS THE TRUTH. `doc` below is { version, settings, blocks[] } and it is the only state
   this file keeps. Every edit mutates it, then asks the SERVER to render it. The canvas is the
   server's answer. There is no local renderer here to fall out of step with the one that sends.

   WHY A ROUND TRIP PER EDIT IS THE RIGHT CHOICE. Rendering email HTML correctly means nested tables,
   Outlook conditional comments, an allow-list sanitiser and colour validation — reimplementing that
   in the browser would be a second implementation of the security-relevant part, and the two would
   diverge on the first bug fixed in only one of them. The render endpoint touches no database, so it
   is fast, and edits are debounced.

   AUTOSAVE IS SEPARATE FROM RENDER. Rendering is constant; saving is every couple of seconds and on
   every structural change. A save that FAILS says so and keeps the document in memory — it never
   clears the canvas and never claims "Saved".
   ============================================================================================== */
(function () {
  'use strict';
  var EM = window.EM;
  var root = document.getElementById('bdRoot');
  if (!EM || !root) return;

  var owner = root.dataset.owner;             // 'template' | 'campaign'
  var ownerId = root.dataset.ownerId;

  var doc = { version: 1, settings: {}, blocks: [] };
  try { doc = JSON.parse((document.getElementById('bdDocSeed') || {}).textContent || '{}') || doc; } catch (_) {}
  if (!Array.isArray(doc.blocks)) doc.blocks = [];
  if (!doc.settings || typeof doc.settings !== 'object') doc.settings = {};

  var meta = { fonts: [], variables: [], blocks: [] };
  try { meta = JSON.parse((document.getElementById('bdMeta') || {}).textContent || '{}') || meta; } catch (_) {}

  var docEl = document.getElementById('bdDoc');
  var htmlEl = document.getElementById('bdHtml');
  var frame = document.getElementById('bdFrame');
  var inspect = document.getElementById('bdInspectBody');
  var subjectEl = document.getElementById('bdSubject');
  var preheaderEl = document.getElementById('bdPreheader');

  var selected = null;   // block id
  var dirty = false;
  var renderCtrl = null;

  /* ---- Ids ------------------------------------------------------------------------------------ */

  var seq = 0;
  function newId() { seq++; return 'b' + Date.now().toString(36) + seq.toString(36); }

  function findBlock(id, list) {
    list = list || doc.blocks;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return { block: list[i], list: list, index: i };
      if (list[i].columns) {
        for (var c = 0; c < list[i].columns.length; c++) {
          var hit = findBlock(id, list[i].columns[c]);
          if (hit) return hit;
        }
      }
    }
    return null;
  }

  /* ---- Defaults for a new block ----------------------------------------------------------------- */

  function defaultsFor(kind) {
    var b = { id: newId(), kind: kind, style: {} };
    switch (kind) {
      case 'heading': b.content = 'Your heading'; b.height = 2; break;
      case 'text': b.content = 'Write the one thing this message is for.'; break;
      case 'image': b.src = ''; b.alt = ''; break;
      case 'button': b.label = 'Open'; b.href = 'https://edurankai.in'; break;
      case 'spacer': b.height = 24; break;
      case 'divider': break;
      case 'quote': b.content = 'A line worth setting apart.'; break;
      case 'html': b.content = '<p>Custom HTML</p>'; break;
      case 'footer': b.content = 'EduRankAI — the technology platform.'; break;
      case 'signature': b.content = 'Name<br>Role'; break;
      case 'social': b.links = [{ label: 'Website', href: 'https://edurankai.in' }]; break;
      case 'columns': b.columns = [
        [{ id: newId(), kind: 'text', content: 'Left column', style: {} }],
        [{ id: newId(), kind: 'text', content: 'Right column', style: {} }],
      ]; break;
    }
    return b;
  }

  /* ---- Render ------------------------------------------------------------------------------------ */

  var render = EM.debounce(function () {
    if (renderCtrl) renderCtrl.abort();
    renderCtrl = new AbortController();

    doc.settings.preheader = preheaderEl ? preheaderEl.value : doc.settings.preheader;

    EM.api('/api/mail/product/templates', {
      body: {
        action: 'render',
        blocks: doc,
        subject: subjectEl ? subjectEl.value : '',
        inline: true,
        personalize: true,
      },
      signal: renderCtrl.signal,
    }).then(function (res) {
      if (res.aborted) return;
      if (!res.ok) {
        docEl.innerHTML = '<div class="bd-empty"><p style="color:var(--em-bad)">' +
          EM.esc(res.error || 'This could not be rendered. Your design is not lost — it is still in this page.') + '</p></div>';
        return;
      }
      paintCanvas(res.html);
      if (htmlEl) htmlEl.textContent = res.html;

      // Variables the product cannot fill are a warning, not a silent blank at send time.
      if ((res.unknown || []).length) {
        warnUnknown(res.unknown);
      } else {
        clearWarn();
      }
    });
  }, 260);

  var warnEl = null;
  function warnUnknown(list) {
    if (!warnEl) {
      warnEl = document.createElement('div');
      warnEl.className = 'em-alert warn';
      warnEl.style.margin = '0 0 12px';
      frame.parentElement.insertBefore(warnEl, frame);
    }
    warnEl.innerHTML = '<p><strong>Unknown variable' + (list.length > 1 ? 's' : '') + ':</strong> ' +
      list.map(function (v) { return '<code>{{' + EM.esc(v) + '}}</code>'; }).join(', ') +
      '. Nothing fills ' + (list.length > 1 ? 'these' : 'this') + ', so ' +
      (list.length > 1 ? 'they' : 'it') + ' will be sent as empty text. Declare a custom field with that name, or correct the spelling.</p>';
  }
  function clearWarn() { if (warnEl) { warnEl.remove(); warnEl = null; } }

  /**
   * Wrap the rendered HTML so each top-level block is selectable.
   *
   * The server returns one <tr> per block in document order, so the wrapper walks the rendered rows
   * alongside doc.blocks. Selection is by INDEX, which is exact because both come from the same
   * array in the same order.
   */
  function paintCanvas(html) {
    if (!doc.blocks.length) {
      docEl.innerHTML =
        '<div class="bd-empty">' +
          '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>' +
          '<h3 class="em-h2" style="margin-top:12px">Nothing here yet</h3>' +
          '<p class="em-note">Add a block from the left to start.</p>' +
        '</div>';
      return;
    }

    var holder = document.createElement('div');
    holder.innerHTML = html;
    var rows = holder.querySelectorAll(':scope > table > tbody > tr, :scope > table > tr');

    docEl.innerHTML = '';
    var dropTop = dropZone(0);
    docEl.appendChild(dropTop);

    doc.blocks.forEach(function (b, i) {
      var item = document.createElement('div');
      item.className = 'bd-item' + (b.id === selected ? ' on' : '');
      item.dataset.bdItem = b.id;
      item.draggable = true;

      var tag = document.createElement('span');
      tag.className = 'bd-item-tag';
      tag.textContent = b.kind;
      item.appendChild(tag);

      var bar = document.createElement('div');
      bar.className = 'bd-item-bar';
      bar.innerHTML =
        btn('bdUp', 'Move up', 'M12 19V5M5 12l7-7 7 7') +
        btn('bdDown', 'Move down', 'M12 5v14M19 12l-7 7-7-7') +
        btn('bdDup', 'Duplicate', 'M9 9h10v10H9zM5 15H4V4h11v1') +
        btn('bdDel', 'Delete', 'M18 6 6 18M6 6l12 12');
      item.appendChild(bar);

      var pane = document.createElement('div');
      pane.style.pointerEvents = 'none';   // clicks belong to the item, not to a link in the preview
      var table = document.createElement('table');
      table.setAttribute('role', 'presentation');
      table.setAttribute('cellpadding', '0');
      table.setAttribute('cellspacing', '0');
      table.style.width = '100%';
      var tbody = document.createElement('tbody');
      if (rows[i]) tbody.appendChild(rows[i].cloneNode(true));
      table.appendChild(tbody);
      pane.appendChild(table);
      item.appendChild(pane);

      docEl.appendChild(item);
      docEl.appendChild(dropZone(i + 1));
    });
  }

  function btn(attr, label, path) {
    return '<button type="button" data-' + attr.replace(/([A-Z])/g, '-$1').toLowerCase() + ' aria-label="' + label + '" title="' + label + '">' +
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="' + path + '"/></svg></button>';
  }

  function dropZone(index) {
    var d = document.createElement('div');
    d.className = 'bd-drop';
    d.dataset.bdDrop = String(index);
    return d;
  }

  /* ---- Inspector ---------------------------------------------------------------------------------- */

  function row(label, control, hint) {
    return '<label class="em-field"><span class="em-label">' + EM.esc(label) + '</span>' + control +
      (hint ? '<span class="em-hint">' + hint + '</span>' : '') + '</label>';
  }
  function input(key, value, attrs) {
    return '<input class="em-input" data-bd-set="' + key + '" value="' + EM.esc(value == null ? '' : value) + '" ' + (attrs || '') + ' />';
  }
  function numberInput(key, value, min, max) {
    return '<input class="em-input" type="number" data-bd-set="' + key + '" value="' + (value == null ? '' : value) +
      '" min="' + min + '" max="' + max + '" />';
  }
  function select(key, value, options) {
    return '<select class="em-select" data-bd-set="' + key + '">' + options.map(function (o) {
      return '<option value="' + EM.esc(o.value) + '"' + (String(value) === String(o.value) ? ' selected' : '') + '>' + EM.esc(o.label) + '</option>';
    }).join('') + '</select>';
  }
  function colour(key, value, fallback) {
    var v = /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : fallback;
    return '<span class="bd-color">' +
      '<input type="color" data-bd-colour="' + key + '" value="' + v + '" aria-label="Colour picker" />' +
      '<input type="text" class="em-input" data-bd-set="' + key + '" value="' + EM.esc(value == null ? '' : value) + '" placeholder="' + fallback + '" />' +
      '</span>';
  }
  function padding(s) {
    return '<span class="em-label">Padding (top, right, bottom, left)</span><div class="bd-quad">' +
      ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].map(function (k) {
        return '<input class="em-input" type="number" min="0" max="200" data-bd-set="style.' + k + '" value="' +
          (s[k] == null ? '' : s[k]) + '" aria-label="' + k + '" />';
      }).join('') + '</div>';
  }
  function varPicker() {
    return '<div class="bd-vars">' + meta.variables.map(function (v) {
      return '<button type="button" class="bd-var" data-bd-var="' + v.key + '" title="' + EM.esc(v.label) + '">{{' + v.key + '}}</button>';
    }).join('') + '</div>';
  }
  function alignSelect(s) {
    return row('Alignment', select('style.align', s.align || 'left', [
      { value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' }, { value: 'right', label: 'Right' },
    ]));
  }
  function typeGroup(s) {
    return '<details class="bd-group" open><summary>Type</summary>' +
      row('Font', select('style.fontFamily', s.fontFamily || '', [{ value: '', label: 'Inherit from the email' }].concat(
        meta.fonts.map(function (f) { return { value: f.value, label: f.label }; })))) +
      '<div class="bd-pair">' +
        row('Size (px)', numberInput('style.fontSize', s.fontSize, 8, 96)) +
        row('Weight', select('style.fontWeight', s.fontWeight || '', [
          { value: '', label: 'Default' }, { value: '300', label: 'Light' }, { value: '400', label: 'Regular' },
          { value: '600', label: 'Semibold' }, { value: '700', label: 'Bold' },
        ])) +
      '</div>' +
      '<div class="bd-pair">' +
        row('Line height', '<input class="em-input" type="number" step="0.05" min="0.9" max="3" data-bd-set="style.lineHeight" value="' + (s.lineHeight == null ? '' : s.lineHeight) + '" />') +
        row('Letter spacing', numberInput('style.letterSpacing', s.letterSpacing, -2, 6)) +
      '</div>' +
      row('Colour', colour('style.color', s.color, '#1E293B')) +
      alignSelect(s) +
      '</details>';
  }
  function boxGroup(s) {
    return '<details class="bd-group"><summary>Box</summary>' +
      row('Background', colour('style.background', s.background, '#FFFFFF')) +
      '<div class="em-field">' + padding(s) + '</div>' +
      '<div class="bd-pair">' +
        row('Border width', numberInput('style.borderWidth', s.borderWidth, 0, 20)) +
        row('Radius', numberInput('style.borderRadius', s.borderRadius, 0, 60)) +
      '</div>' +
      row('Border colour', colour('style.borderColor', s.borderColor, '#E3E8EF')) +
      '</details>';
  }

  function renderInspector() {
    if (!selected) { renderSettings(); return; }
    var hit = findBlock(selected);
    if (!hit) { selected = null; renderSettings(); return; }
    var b = hit.block;
    var s = b.style || {};
    var html = '<h3>' + b.kind.charAt(0).toUpperCase() + b.kind.slice(1) + '</h3>' +
      '<p class="em-note">Changes appear on the canvas as you type.</p>';

    switch (b.kind) {
      case 'heading':
        html += row('Level', select('height', b.height || 1, [
          { value: 1, label: 'H1 — largest' }, { value: 2, label: 'H2' }, { value: 3, label: 'H3' }, { value: 4, label: 'H4 — smallest' },
        ]));
        html += row('Text', '<div class="bd-rich" contenteditable="true" data-bd-rich="content">' + (b.content || '') + '</div>') + varPicker();
        html += typeGroup(s) + boxGroup(s);
        break;

      case 'text':
      case 'quote':
      case 'footer':
      case 'signature':
        html += row('Content', '<div class="bd-rich" contenteditable="true" data-bd-rich="content">' + (b.content || '') + '</div>',
          'Basic formatting is kept; anything the sanitiser does not recognise is dropped, and its text is preserved.') + varPicker();
        html += typeGroup(s) + boxGroup(s);
        break;

      case 'html':
        html += row('HTML', '<textarea class="em-textarea" data-bd-set="content" rows="8" style="font-family:var(--em-mono);font-size:12px">' + EM.esc(b.content || '') + '</textarea>',
          'Passed through the same allow-list as every other block — this is a block for tables and inline styles, not a way past the sanitiser.');
        html += boxGroup(s);
        break;

      case 'image':
        html += row('Image URL', input('src', b.src, 'placeholder="https://…"'),
          'Images are linked, never uploaded — this product has no file store. Host it somewhere public or most clients will show nothing.');
        html += row('Alt text', input('alt', b.alt),
          'Images are OFF by default in a large share of mail clients. This is what those readers see instead, so make it say what the picture says.');
        html += row('Links to', input('href', b.href, 'placeholder="https://… (optional)"'));
        html += '<div class="bd-pair">' + row('Width (px)', numberInput('width', b.width, 20, 1200)) +
          row('Radius', numberInput('style.borderRadius', s.borderRadius, 0, 60)) + '</div>';
        html += alignSelect(s) + boxGroup(s);
        break;

      case 'button':
        html += row('Label', input('label', b.label));
        html += row('Links to', input('href', b.href, 'placeholder="https://…"'));
        html += '<div class="bd-pair">' + row('Background', colour('style.background', s.background, '#FF4F00')) +
          row('Text colour', colour('style.color', s.color, '#FFFFFF')) + '</div>';
        html += '<div class="bd-pair">' + row('Size (px)', numberInput('style.fontSize', s.fontSize, 10, 32)) +
          row('Radius', numberInput('style.borderRadius', s.borderRadius, 0, 40)) + '</div>';
        html += alignSelect(s) + boxGroup(s);
        break;

      case 'divider':
        html += '<div class="bd-pair">' + row('Thickness', numberInput('style.borderWidth', s.borderWidth, 1, 8)) +
          row('Colour', colour('style.borderColor', s.borderColor, '#E3E8EF')) + '</div>';
        html += boxGroup(s);
        break;

      case 'spacer':
        html += row('Height (px)', numberInput('height', b.height, 2, 200));
        break;

      case 'social':
        html += '<div class="em-label">Links</div><div data-bd-social>' +
          (b.links || []).map(function (l, i) {
            return '<div class="em-row tight" style="margin-bottom:6px">' +
              '<input class="em-input" data-bd-social-label="' + i + '" value="' + EM.esc(l.label || '') + '" placeholder="Label" style="flex:1" />' +
              '<input class="em-input" data-bd-social-href="' + i + '" value="' + EM.esc(l.href || '') + '" placeholder="https://…" style="flex:2" />' +
              '<button type="button" class="em-btn ghost icon sm" data-bd-social-del="' + i + '" aria-label="Remove link">&times;</button>' +
            '</div>';
          }).join('') + '</div>' +
          '<button type="button" class="em-btn sm" data-bd-social-add>Add link</button>' +
          '<p class="em-hint">Text labels, not logos: a brand mark in an email is that company&rsquo;s trademark on our message, and it needs a hosted image most clients block.</p>';
        html += typeGroup(s) + boxGroup(s);
        break;

      case 'columns':
        html += '<p class="em-note">' + (b.columns || []).length + ' columns. Select a block inside a column on the canvas to edit it.</p>';
        html += row('Columns', select('__cols', (b.columns || []).length, [
          { value: 2, label: 'Two' }, { value: 3, label: 'Three' }, { value: 4, label: 'Four' },
        ]), 'They stack on a narrow screen. Four columns are unreadable on a phone even stacked.');
        html += boxGroup(s);
        break;
    }

    html += '<div class="bd-group"><button type="button" class="em-btn ghost wide" data-bd-deselect>Back to email settings</button></div>';
    inspect.innerHTML = html;
  }

  function renderSettings() {
    var s = doc.settings || {};
    inspect.innerHTML =
      '<h3>Email settings</h3>' +
      '<p class="em-note">Defaults for the whole message. Select a block to override them there.</p>' +
      row('Page background', colour('settings.background', s.background, '#F1F4F8')) +
      row('Content background', colour('settings.contentBackground', s.contentBackground, '#FFFFFF')) +
      row('Content width (px)', numberInput('settings.width', s.width, 320, 900),
        '600px is the safe maximum — desktop Outlook renders wider content unpredictably.') +
      row('Default font', select('settings.fontFamily', s.fontFamily || '', meta.fonts.map(function (f) {
        return { value: f.value, label: f.label };
      })), 'Web fonts are not loaded: Outlook ignores @font-face and Gmail strips the link, so a custom font is a fallback nobody chose.') +
      row('Text colour', colour('settings.textColor', s.textColor, '#1E293B')) +
      row('Link colour', colour('settings.linkColor', s.linkColor, '#DC4500'));
  }

  /* ---- Editing --------------------------------------------------------------------------------------- */

  function setPath(target, path, value) {
    var parts = path.split('.');
    var o = target;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
      o = o[parts[i]];
    }
    var key = parts[parts.length - 1];
    if (value === '' || value === null) delete o[key];
    else o[key] = value;
  }

  function applySet(path, raw, isNumber) {
    var value = raw;
    if (isNumber) {
      value = raw === '' ? '' : Number(raw);
      if (value !== '' && !isFinite(value)) return;
    }

    if (path.indexOf('settings.') === 0) {
      setPath(doc, path, value);
    } else if (selected) {
      var hit = findBlock(selected);
      if (!hit) return;
      if (path === '__cols') {
        var want = Number(value);
        var cols = hit.block.columns || [];
        while (cols.length > want) cols.pop();
        while (cols.length < want) cols.push([{ id: newId(), kind: 'text', content: 'Column', style: {} }]);
        hit.block.columns = cols;
      } else {
        setPath(hit.block, path, value);
      }
    }
    dirty = true;
    render();
    scheduleSave();
  }

  inspect.addEventListener('input', function (e) {
    var el = e.target.closest('[data-bd-set]');
    if (el) { applySet(el.dataset.bdSet, el.value, el.type === 'number'); return; }

    var rich = e.target.closest('[data-bd-rich]');
    if (rich && selected) {
      var hit = findBlock(selected);
      if (hit) { hit.block[rich.dataset.bdRich] = rich.innerHTML; dirty = true; render(); scheduleSave(); }
      return;
    }

    var sl = e.target.closest('[data-bd-social-label]');
    var sh = e.target.closest('[data-bd-social-href]');
    if ((sl || sh) && selected) {
      var h = findBlock(selected);
      if (!h) return;
      var i = Number((sl || sh).dataset.bdSocialLabel != null ? sl.dataset.bdSocialLabel : sh.dataset.bdSocialHref);
      h.block.links = h.block.links || [];
      h.block.links[i] = h.block.links[i] || { label: '', href: '' };
      if (sl) h.block.links[i].label = sl.value; else h.block.links[i].href = sh.value;
      dirty = true; render(); scheduleSave();
    }
  });

  inspect.addEventListener('change', function (e) {
    var el = e.target.closest('select[data-bd-set]');
    if (el) applySet(el.dataset.bdSet, el.value, false);
  });

  inspect.addEventListener('click', function (e) {
    // The colour swatch writes into its text twin, so the two never disagree.
    var picker = e.target.closest('[data-bd-colour]');
    if (picker) return;

    var v = e.target.closest('[data-bd-var]');
    if (v) {
      var rich = inspect.querySelector('[data-bd-rich]');
      var token = '{{' + v.dataset.bdVar + '}}';
      if (rich) {
        rich.focus();
        try { document.execCommand('insertText', false, token); } catch (_) { rich.innerHTML += token; }
        var hit = findBlock(selected);
        if (hit) { hit.block.content = rich.innerHTML; dirty = true; render(); scheduleSave(); }
      }
      return;
    }

    if (e.target.closest('[data-bd-deselect]')) { selected = null; render(); renderSettings(); return; }

    if (e.target.closest('[data-bd-social-add]') && selected) {
      var h = findBlock(selected);
      if (h) { h.block.links = (h.block.links || []).concat([{ label: '', href: '' }]); dirty = true; render(); renderInspector(); scheduleSave(); }
      return;
    }
    var del = e.target.closest('[data-bd-social-del]');
    if (del && selected) {
      var hh = findBlock(selected);
      if (hh) { (hh.block.links || []).splice(Number(del.dataset.bdSocialDel), 1); dirty = true; render(); renderInspector(); scheduleSave(); }
    }
  });

  inspect.addEventListener('input', function (e) {
    var picker = e.target.closest('[data-bd-colour]');
    if (!picker) return;
    var twin = inspect.querySelector('[data-bd-set="' + picker.dataset.bdColour + '"]');
    if (twin) twin.value = picker.value;
    applySet(picker.dataset.bdColour, picker.value, false);
  });

  /* ---- Canvas interaction ------------------------------------------------------------------------------ */

  docEl.addEventListener('click', function (e) {
    var item = e.target.closest('[data-bd-item]');
    if (!item) return;
    var id = item.dataset.bdItem;
    var hit = findBlock(id);
    if (!hit) return;

    if (e.target.closest('[data-bd-del]')) {
      hit.list.splice(hit.index, 1);
      if (selected === id) selected = null;
      dirty = true; render(); renderInspector(); scheduleSave();
      return;
    }
    if (e.target.closest('[data-bd-dup]')) {
      var copy = JSON.parse(JSON.stringify(hit.block));
      copy.id = newId();
      hit.list.splice(hit.index + 1, 0, copy);
      dirty = true; render(); scheduleSave();
      return;
    }
    if (e.target.closest('[data-bd-up]')) {
      if (hit.index > 0) { hit.list.splice(hit.index - 1, 0, hit.list.splice(hit.index, 1)[0]); dirty = true; render(); scheduleSave(); }
      return;
    }
    if (e.target.closest('[data-bd-down]')) {
      if (hit.index < hit.list.length - 1) { hit.list.splice(hit.index + 1, 0, hit.list.splice(hit.index, 1)[0]); dirty = true; render(); scheduleSave(); }
      return;
    }

    selected = id;
    render();
    renderInspector();
    if (window.matchMedia('(max-width: 1080px)').matches) root.classList.add('inspect-open');
  });

  /* ---- Adding + drag/drop -------------------------------------------------------------------------------- */

  var draggingKind = null;
  var draggingId = null;

  document.addEventListener('click', function (e) {
    var add = e.target.closest('[data-bd-add]');
    if (!add) return;
    var b = defaultsFor(add.dataset.bdAdd);
    doc.blocks.push(b);
    selected = b.id;
    dirty = true; render(); renderInspector(); scheduleSave();
    root.classList.remove('palette-open');
  });

  document.addEventListener('dragstart', function (e) {
    var add = e.target.closest('[data-bd-add]');
    if (add) { draggingKind = add.dataset.bdAdd; draggingId = null; e.dataTransfer.effectAllowed = 'copy'; return; }
    var item = e.target.closest('[data-bd-item]');
    if (item) {
      draggingId = item.dataset.bdItem; draggingKind = null;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    }
  });
  document.addEventListener('dragend', function () {
    docEl.querySelectorAll('.dragging').forEach(function (el) { el.classList.remove('dragging'); });
    docEl.querySelectorAll('.bd-drop.over').forEach(function (el) { el.classList.remove('over'); });
    draggingKind = null; draggingId = null;
  });

  docEl.addEventListener('dragover', function (e) {
    var zone = e.target.closest('[data-bd-drop]');
    if (!zone || (!draggingKind && !draggingId)) return;
    e.preventDefault();
    docEl.querySelectorAll('.bd-drop.over').forEach(function (el) { if (el !== zone) el.classList.remove('over'); });
    zone.classList.add('over');
  });
  docEl.addEventListener('dragleave', function (e) {
    var zone = e.target.closest('[data-bd-drop]');
    if (zone) zone.classList.remove('over');
  });
  docEl.addEventListener('drop', function (e) {
    var zone = e.target.closest('[data-bd-drop]');
    if (!zone) return;
    e.preventDefault();
    var at = Number(zone.dataset.bdDrop);

    if (draggingKind) {
      var b = defaultsFor(draggingKind);
      doc.blocks.splice(at, 0, b);
      selected = b.id;
    } else if (draggingId) {
      var hit = findBlock(draggingId);
      if (hit && hit.list === doc.blocks) {
        var moved = hit.list.splice(hit.index, 1)[0];
        doc.blocks.splice(at > hit.index ? at - 1 : at, 0, moved);
      }
    }
    dirty = true; render(); renderInspector(); scheduleSave();
  });

  /* ---- Devices ------------------------------------------------------------------------------------------- */

  document.addEventListener('click', function (e) {
    var d = e.target.closest('[data-bd-device]');
    if (d) {
      var mode = d.dataset.bdDevice;
      frame.dataset.device = mode;
      docEl.hidden = mode === 'html';
      htmlEl.hidden = mode !== 'html';
      document.querySelectorAll('[data-bd-device]').forEach(function (b) {
        b.setAttribute('aria-pressed', String(b === d));
      });
      return;
    }
    var t = e.target.closest('[data-bd-toggle]');
    if (t) {
      var which = t.dataset.bdToggle;
      root.classList.toggle(which + '-open');
      root.classList.remove((which === 'palette' ? 'inspect' : 'palette') + '-open');
    }
  });

  /* ---- Saving ---------------------------------------------------------------------------------------------- */

  var saveTimer = null;
  var statusEl = document.querySelector('[data-bd-status]');

  function setStatus(text, warn) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.style.color = warn ? 'var(--em-warn)' : '';
    statusEl.style.fontWeight = warn ? '640' : '';
  }

  function scheduleSave() {
    setStatus('Unsaved changes');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { save(false); }, 1800);
  }

  function save(explicit) {
    setStatus('Saving…');
    var body = owner === 'template'
      ? { action: 'save', id: ownerId, blocks: doc, subject: subjectEl ? subjectEl.value : undefined, preheader: preheaderEl ? preheaderEl.value : undefined }
      : { action: 'save', id: ownerId, blocks: doc, subject: subjectEl ? subjectEl.value : undefined, preheader: preheaderEl ? preheaderEl.value : undefined };
    var url = owner === 'template' ? '/api/mail/product/templates' : '/api/mail/product/campaigns';

    return EM.api(url, { body: body }).then(function (res) {
      if (res.ok) {
        dirty = false;
        setStatus('Saved ' + new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) +
                  (res.version ? ' · v' + res.version : ''));
        if (explicit) EM.toast('Saved.', 'ok');
      } else {
        // NOT lost, and NOT claimed as saved. The document is still in memory and on the canvas.
        setStatus('NOT saved — your design is still on screen. ' + (res.error || ''), true);
        if (explicit) EM.toast(res.error || 'This was NOT saved. Your design is still here.', 'bad', 12000);
      }
      return res;
    });
  }

  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-bd-save]')) {
      var btn = e.target.closest('[data-bd-save]');
      clearTimeout(saveTimer);
      EM.busy(btn, true, 'Saving');
      save(true).then(function () { EM.busy(btn, false); });
    }
  });

  if (subjectEl) subjectEl.addEventListener('input', function () { dirty = true; render(); scheduleSave(); });
  if (preheaderEl) preheaderEl.addEventListener('input', function () { dirty = true; render(); scheduleSave(); });

  window.addEventListener('beforeunload', function (e) {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      clearTimeout(saveTimer);
      save(true);
    }
    if (e.key === 'Escape' && selected && !e.target.closest('input,textarea,[contenteditable]')) {
      selected = null; render(); renderSettings();
    }
  });

  /* ---- Boot -------------------------------------------------------------------------------------------------- */

  render();
  renderSettings();
})();
