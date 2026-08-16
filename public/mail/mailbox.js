/* ================================================================================================
   public/mail/mailbox.js — the virtualised message list and every action on it.
   ------------------------------------------------------------------------------------------------
   WHY VIRTUALISED. A mailbox with 12,000 conversations rendered as 12,000 anchors is ~250,000 DOM
   nodes: several seconds of layout, hundreds of megabytes, and a scroll that stutters on every
   frame. This keeps a plain array of row DATA and renders only the rows inside the viewport plus a
   small overscan — usually about twenty nodes, whatever the total. Memory and paint cost are
   constant in the number of messages.

   ONE ROW TEMPLATE. The markup is <template id="mbRow"> in the Astro page. This file clones and
   fills it. There is no second copy of a row's HTML anywhere, so a change to the row is one change.

   ACTIONS ARE OPTIMISTIC, AND HONEST ABOUT IT. A star flips immediately because a 200ms wait for a
   star is a product that feels broken — but if the request fails the flip is REVERTED and the
   failure is shown. An optimistic update that silently keeps a state the server rejected is a UI
   lying about the database.
   ============================================================================================== */
(function () {
  'use strict';
  var EM = window.EM;
  if (!EM) return;

  var root = document.getElementById('mbRoot');
  var viewport = document.getElementById('mbViewport');
  var runway = document.getElementById('mbRunway');
  var rowsHost = document.getElementById('mbRows');
  var tpl = document.getElementById('mbRow');
  var foot = document.getElementById('mbFoot');
  var seedEl = document.getElementById('mbSeed');
  if (!root || !viewport || !tpl || !seedEl) return;

  var seed = {};
  try { seed = JSON.parse(seedEl.textContent || '{}'); } catch (_) { seed = {}; }

  var ROW_H = parseInt(getComputedStyle(root).getPropertyValue('--mb-row'), 10) || 78;
  var OVERSCAN = 6;

  var state = {
    folder: seed.folder || 'inbox',
    q: seed.q || '',
    label: seed.label || null,
    threadId: seed.threadId || '',
    rows: Array.isArray(seed.rows) ? seed.rows : [],
    nextBefore: seed.nextBefore || null,
    loading: false,
    exhausted: !seed.nextBefore,
    picked: Object.create(null),
    pool: [],          // recycled row elements
    first: -1,
    last: -1,
  };

  /* ---- Rendering ------------------------------------------------------------------------------ */

  function makeRow() {
    var el = tpl.content.firstElementChild.cloneNode(true);
    el.style.position = 'absolute';
    el.style.insetInlineStart = '0';
    el.style.width = '100%';
    rowsHost.appendChild(el);
    return el;
  }

  function fill(el, t, index) {
    el.style.transform = 'translateY(' + (index * ROW_H) + 'px)';
    el.href = '/mail/box/' + state.folder + '?thread=' + encodeURIComponent(t.thread_id) +
              (state.q ? '&q=' + encodeURIComponent(state.q) : '') +
              (state.label ? '&label=' + encodeURIComponent(state.label) : '');
    el.dataset.thread = t.thread_id;
    el.dataset.index = String(index);

    var unread = !t.is_read;
    el.classList.toggle('unread', unread);
    el.classList.toggle('sel', t.thread_id === state.threadId);
    el.classList.toggle('picked', !!state.picked[t.thread_id]);
    el.setAttribute('aria-selected', state.picked[t.thread_id] ? 'true' : 'false');

    var box = el.querySelector('.mb-pick input');
    box.checked = !!state.picked[t.thread_id];

    var star = el.querySelector('.mb-star');
    star.classList.toggle('on', !!t.is_starred);
    star.querySelector('svg').setAttribute('fill', t.is_starred ? 'currentColor' : 'none');
    star.setAttribute('aria-label', (t.is_starred ? 'Unstar' : 'Star') + ' conversation with ' + (t.from_name || t.from_email || ''));
    star.setAttribute('aria-pressed', t.is_starred ? 'true' : 'false');

    var who = t.participants || t.from_name || t.from_email || '(unknown sender)';
    el.querySelector('.mb-from').textContent = who;

    var time = el.querySelector('.mb-time');
    time.textContent = EM.timeAgo(t.created_at);
    time.title = EM.fullTime(t.created_at);

    var subj = el.querySelector('.mb-subj');
    subj.textContent = t.subject || '(no subject)';
    if (Number(t.thread_count) > 1) {
      var c = document.createElement('span');
      c.className = 'mb-count';
      c.textContent = t.thread_count;
      subj.appendChild(c);
    }

    var snip = el.querySelector('.mb-snip');
    snip.textContent = '';
    (t.labels || []).slice(0, 2).forEach(function (l) {
      var chip = document.createElement('span');
      chip.className = 'mb-label';
      chip.textContent = l;
      snip.appendChild(chip);
    });
    snip.appendChild(document.createTextNode(t.snippet || ''));

    el.querySelector('.mb-clip').hidden = !t.has_attachments;

    // The whole row is one accessible label: a screen reader reads "Anita Rao, Invoice for July,
    // unread, 2 hours ago" rather than four disconnected fragments.
    el.setAttribute('aria-label',
      who + '. ' + (t.subject || 'No subject') + '. ' +
      (unread ? 'Unread. ' : '') + (t.has_attachments ? 'Has attachment. ' : '') +
      EM.timeAgo(t.created_at));
  }

  function draw() {
    var total = state.rows.length;
    runway.style.height = (total * ROW_H) + 'px';

    var top = viewport.scrollTop;
    var first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    var visible = Math.ceil(viewport.clientHeight / ROW_H) + OVERSCAN * 2;
    var last = Math.min(total, first + visible);

    if (first === state.first && last === state.last) return;
    state.first = first;
    state.last = last;

    var need = last - first;
    while (state.pool.length < need) state.pool.push(makeRow());
    for (var i = 0; i < state.pool.length; i++) {
      var el = state.pool[i];
      if (i < need) { el.hidden = false; fill(el, state.rows[first + i], first + i); }
      else { el.hidden = true; }
    }
  }

  function redraw() { state.first = -1; state.last = -1; draw(); }

  /* ---- Paging ---------------------------------------------------------------------------------- */

  function setFoot(html) {
    if (!foot) return;
    foot.hidden = !html;
    foot.innerHTML = html || '';
  }

  function loadMore() {
    if (state.loading || state.exhausted) return;
    state.loading = true;
    setFoot('<span class="em-spin"></span> Loading more…');

    var url = '/api/mail/product/threads?folder=' + encodeURIComponent(state.folder) +
      '&limit=40' +
      (state.q ? '&q=' + encodeURIComponent(state.q) : '') +
      (state.label ? '&label=' + encodeURIComponent(state.label) : '') +
      (state.nextBefore ? '&before=' + encodeURIComponent(state.nextBefore) : '');

    EM.api(url).then(function (res) {
      state.loading = false;
      if (!res.ok) {
        // A failed page must not look like the end of the list.
        setFoot('<span style="color:var(--em-bad)">' + EM.esc(res.error || 'More mail could not be loaded.') +
                '</span> <button type="button" class="em-btn sm" data-mb-retry>Try again</button>');
        return;
      }
      var known = Object.create(null);
      state.rows.forEach(function (r) { known[r.thread_id] = true; });
      (res.rows || []).forEach(function (r) { if (!known[r.thread_id]) state.rows.push(r); });

      state.nextBefore = res.nextBefore;
      state.exhausted = !res.nextBefore || !(res.rows || []).length;
      redraw();
      setFoot(state.exhausted
        ? '<span>' + EM.num(state.rows.length) + ' conversation' + (state.rows.length === 1 ? '' : 's') + ' — that is all of them.</span>'
        : '');
    });
  }

  /* ---- Empty state ------------------------------------------------------------------------------ */

  function renderEmpty() {
    if (state.rows.length) return;
    var filtered = !!(state.q || state.label);
    rowsHost.innerHTML =
      '<div class="em-empty" style="position:static">' +
        '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/></svg>' +
        '<h3>' + (filtered ? 'Nothing matches that' : 'Nothing here yet') + '</h3>' +
        '<p>' + (filtered
          ? 'Try fewer words, or clear the search. Operators like <code>from:</code>, <code>has:attachment</code> and <code>after:7d</code> can be combined.'
          : 'When mail arrives in this folder it will appear here.') + '</p>' +
        (filtered ? '<a class="em-btn" href="/mail/box/' + EM.esc(state.folder) + '">Clear the search</a>' : '') +
      '</div>';
    runway.style.height = 'auto';
  }

  /* ---- Selection --------------------------------------------------------------------------------- */

  function pickedIds() { return Object.keys(state.picked); }

  function syncSelection() {
    var n = pickedIds().length;
    root.classList.toggle('has-selection', n > 0);
    var label = root.querySelector('[data-mb-count]');
    if (label) label.textContent = n + ' selected';
  }

  function togglePick(id, on) {
    if (on) state.picked[id] = true; else delete state.picked[id];
    syncSelection();
  }

  root.querySelector('[data-mb-clear]') && root.querySelector('[data-mb-clear]').addEventListener('click', function () {
    state.picked = Object.create(null);
    syncSelection();
    redraw();
  });

  /* ---- Actions ------------------------------------------------------------------------------------ */

  var DESTRUCTIVE = { trash: 1, delete: 1, spam: 1 };

  function act(action, ids, opts) {
    opts = opts || {};
    if (!ids.length) return Promise.resolve();

    var doIt = function () {
      return EM.api('/api/mail/action', { body: { action: action, threadIds: ids } }).then(function (res) {
        if (!res.ok) {
          EM.toast(res.error || 'That did not go through, and your mailbox is unchanged.', 'bad');
          if (opts.revert) opts.revert();
          return res;
        }
        // Rows that left this folder are removed from the list rather than left behind looking
        // present. Rows whose STATE changed are updated in place.
        var LEAVES = { archive: 1, trash: 1, spam: 1, delete: 1, inbox: state.folder !== 'inbox' ? 1 : 0 };
        if (LEAVES[action]) {
          var gone = {};
          ids.forEach(function (i) { gone[i] = true; });
          state.rows = state.rows.filter(function (r) { return !gone[r.thread_id]; });
          ids.forEach(function (i) { delete state.picked[i]; });
          syncSelection();
          redraw();
          renderEmpty();
          EM.toast(ids.length + ' conversation' + (ids.length === 1 ? '' : 's') + ' ' + pastTense(action) + '.', 'ok');
          // Standing inside a thread that was just moved: go back to the list rather than reading a
          // conversation that is no longer in this folder.
          if (state.threadId && gone[state.threadId]) location.href = '/mail/box/' + state.folder;
        } else {
          var patch = { read: { is_read: true }, unread: { is_read: false }, star: { is_starred: true }, unstar: { is_starred: false } }[action];
          if (patch) {
            state.rows.forEach(function (r) {
              if (ids.indexOf(r.thread_id) >= 0) for (var k in patch) r[k] = patch[k];
            });
            redraw();
          }
          if (!opts.quiet) EM.toast('Done.', 'ok');
        }
        return res;
      });
    };

    // A destructive bulk action names the CONSEQUENCE, and it uses EM.confirm because
    // window.confirm() is suppressed in this shell and returns false — which would silently cancel.
    if (DESTRUCTIVE[action] && ids.length > 1) {
      return EM.confirm({
        title: verbFor(action) + ' ' + ids.length + ' conversations?',
        body: action === 'delete'
          ? 'They will be removed permanently. This cannot be undone.'
          : 'You can move them back from ' + (action === 'trash' ? 'Trash' : 'Spam') + ' afterwards.',
        confirmLabel: verbFor(action) + ' ' + ids.length,
        tone: 'danger',
      }).then(function (yes) { return yes ? doIt() : null; });
    }
    if (action === 'delete') {
      return EM.confirm({
        title: 'Delete permanently?',
        body: 'This conversation will be removed for good. This cannot be undone.',
        confirmLabel: 'Delete for ever',
        tone: 'danger',
      }).then(function (yes) { return yes ? doIt() : null; });
    }
    return doIt();
  }

  function verbFor(a) { return a === 'delete' ? 'Delete' : a === 'trash' ? 'Delete' : a === 'spam' ? 'Report' : 'Move'; }
  function pastTense(a) {
    return { archive: 'archived', trash: 'moved to Trash', spam: 'reported as spam', delete: 'deleted permanently', inbox: 'moved to Inbox' }[a] || 'updated';
  }

  /* ---- Events -------------------------------------------------------------------------------------- */

  viewport.addEventListener('scroll', function () {
    draw();
    // Prefetch the next page a screen and a half before the bottom, so scrolling never stops.
    if (!state.exhausted && !state.loading &&
        viewport.scrollTop + viewport.clientHeight * 1.5 >= runway.offsetHeight) {
      loadMore();
    }
  }, { passive: true });

  window.addEventListener('resize', EM.debounce(redraw, 120));

  rowsHost.addEventListener('click', function (e) {
    var row = e.target.closest('.mb-row');
    if (!row) return;
    var id = row.dataset.thread;

    var star = e.target.closest('.mb-star');
    if (star) {
      e.preventDefault();
      var t = state.rows[Number(row.dataset.index)];
      if (!t) return;
      var was = !!t.is_starred;
      // Optimistic, and REVERTED on failure — see the header.
      t.is_starred = !was;
      redraw();
      act(was ? 'unstar' : 'star', [id], {
        quiet: true,
        revert: function () { t.is_starred = was; redraw(); },
      });
      return;
    }

    if (e.target.closest('.mb-pick')) {
      e.preventDefault();
      var on = !state.picked[id];
      togglePick(id, on);
      row.classList.toggle('picked', on);
      row.setAttribute('aria-selected', on ? 'true' : 'false');
      var box = row.querySelector('.mb-pick input');
      if (box) box.checked = on;
      return;
    }

    // With a selection open, clicking a row extends the selection rather than navigating away from
    // the selection somebody is building.
    if (pickedIds().length) {
      e.preventDefault();
      var nowOn = !state.picked[id];
      togglePick(id, nowOn);
      redraw();
    }
  });

  root.addEventListener('click', function (e) {
    var bulk = e.target.closest('[data-mb-act]');
    if (bulk) { act(bulk.dataset.mbAct, pickedIds()); return; }

    var one = e.target.closest('[data-mb-one]');
    if (one && state.threadId) { act(one.dataset.mbOne, [state.threadId]); return; }

    if (e.target.closest('[data-mb-retry]')) { setFoot(''); loadMore(); return; }

    if (e.target.closest('[data-mb-refresh]')) { location.reload(); return; }
  });

  /* ---- Reply / forward ------------------------------------------------------------------------------ */

  function openComposer(mode) {
    var head = document.querySelector('.mb-read');
    if (!head) return;
    var msgs = head.querySelectorAll('.mb-msg');
    var last = msgs[msgs.length - 1];
    var subject = (document.querySelector('.mb-subject') || {}).textContent || '';
    var fromAddr = last ? (last.querySelector('.mb-msg-addr') || {}).textContent || '' : '';
    fromAddr = fromAddr.replace(/[<>\s]/g, '');
    var when = last ? (last.querySelector('.mb-msg-when') || {}).textContent || '' : '';
    var body = last ? (last.querySelector('.mb-body') || {}).innerHTML || '' : '';

    var quoted =
      '<br><br><div style="border-left:2px solid #CFD8E3;padding-left:12px;color:#475569">' +
      '<p style="font-size:12px;color:#7C8AA0">On ' + EM.esc(when) + ', ' + EM.esc(fromAddr) + ' wrote:</p>' +
      body + '</div>';

    var ccList = [];
    if (mode === 'replyAll' && last) {
      var to = (last.querySelector('.mb-msg-to') || {}).textContent || '';
      ccList = to.replace(/^to\s*/i, '').split(/[,·]/).map(function (s) { return s.trim(); })
        .filter(function (s) { return s.indexOf('@') > 0; });
    }

    EM.load('/mail/compose.js').then(function () {
      EM.compose({
        mode: mode === 'forward' ? 'forward' : 'reply',
        to: mode === 'forward' ? '' : fromAddr,
        cc: ccList.join(', '),
        subject: (mode === 'forward' ? 'Fwd: ' : /^re:/i.test(subject) ? '' : 'Re: ') + subject,
        body: quoted,
        threadId: mode === 'forward' ? null : state.threadId,
        title: mode === 'forward' ? 'Forward' : mode === 'replyAll' ? 'Reply all' : 'Reply',
      });
    }).catch(function () {
      EM.toast('The composer could not be loaded. Nothing has been sent.', 'bad');
    });
  }

  root.addEventListener('click', function (e) {
    if (e.target.closest('[data-mb-reply-all]')) { e.preventDefault(); openComposer('replyAll'); }
    else if (e.target.closest('[data-mb-reply]')) { e.preventDefault(); openComposer('reply'); }
    else if (e.target.closest('[data-mb-forward]')) { e.preventDefault(); openComposer('forward'); }
  });

  /* ---- Keyboard ------------------------------------------------------------------------------------- */
  /* The shortcuts every mail client has trained people to expect. They are ignored while a field has
     focus, so typing "e" in the search box does not archive a conversation.                           */

  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    var ids = pickedIds();
    var target = ids.length ? ids : (state.threadId ? [state.threadId] : []);

    switch (e.key) {
      case '/': e.preventDefault(); var s = document.getElementById('mbSearch'); if (s) s.focus(); break;
      case 'c': e.preventDefault(); var b = document.querySelector('[data-compose]'); if (b) b.click(); break;
      case 'e': if (target.length) { e.preventDefault(); act('archive', target); } break;
      case '#': if (target.length) { e.preventDefault(); act('trash', target); } break;
      case 's': if (target.length) { e.preventDefault(); act('star', target); } break;
      case 'u': e.preventDefault(); location.href = '/mail/box/' + state.folder; break;
      case 'r': if (state.threadId) { e.preventDefault(); openComposer('reply'); } break;
      case 'f': if (state.threadId) { e.preventDefault(); openComposer('forward'); } break;
      case 'Escape':
        if (ids.length) { state.picked = Object.create(null); syncSelection(); redraw(); }
        break;
    }
  });

  /* ---- Boot ------------------------------------------------------------------------------------------ */

  redraw();
  renderEmpty();
  if (state.exhausted && state.rows.length >= 40) {
    setFoot('<span>' + EM.num(state.rows.length) + ' conversations — that is all of them.</span>');
  }

  // The search box submits as a normal GET form (so it works without JS and the URL is shareable),
  // but a live search feels better. Debounced, and it uses the same route.
  var search = document.getElementById('mbSearch');
  if (search) {
    search.addEventListener('input', EM.debounce(function () {
      var v = search.value.trim();
      if (v === state.q) return;
      var u = '/mail/box/' + state.folder + (v ? '?q=' + encodeURIComponent(v) : '');
      history.replaceState(null, '', u);
      state.q = v;
      state.rows = [];
      state.nextBefore = null;
      state.exhausted = false;
      state.picked = Object.create(null);
      syncSelection();
      redraw();
      setFoot('<span class="em-spin"></span> Searching…');
      loadMore();
    }, 350));
  }
})();
