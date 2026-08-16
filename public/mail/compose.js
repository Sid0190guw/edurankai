/* ================================================================================================
   public/mail/compose.js — the composer. Loaded on demand by app.js.
   ------------------------------------------------------------------------------------------------
   EM.compose({ to, cc, subject, body, threadId, inReplyTo, draftId, mode })

   It posts to the THREE EXISTING ENDPOINTS — /api/mail/send, /api/mail/draft, /api/mail/action —
   unchanged, because those are the mail system's write path and are shared with /admin/mail. This
   file is a second UI in front of them, not a second send path.

   THREE THINGS IT REFUSES TO DO QUIETLY:

   1. It never reports "Sent" on a response it did not read. /api/mail/send answers with a per-
      recipient delivery verdict; a message that was stored internally but never left for an external
      address says exactly that.
   2. It never loses a draft to a failed autosave. A save that fails leaves the text on screen, sets
      a visible warning, and keeps retrying on the next change — it does not clear the field and it
      does not claim "Saved".
   3. Attachments are LINKS. There is no upload path in this mail system and there never has been
      (see /api/mail/send.ts) — the server describes and validates each link, and a link it refuses
      is shown as refused rather than dropped from the message.
   ============================================================================================== */
(function () {
  'use strict';
  var EM = window.EM;

  var MODAL_HTML =
    '<div class="em-modal-card wide" role="dialog" aria-modal="true" aria-labelledby="emcTitle">' +
      '<div class="em-modal-head">' +
        '<h2 id="emcTitle">New message</h2>' +
        '<span class="spacer" style="margin-inline-start:auto"></span>' +
        '<button type="button" class="em-btn ghost icon sm" data-emc-close aria-label="Close composer">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="em-modal-body">' +
        '<div class="em-alert bad" data-emc-error hidden><p></p></div>' +

        '<div class="emc-row">' +
          '<label class="emc-lab" for="emcTo">To</label>' +
          '<input class="em-input" id="emcTo" data-autofocus placeholder="name@example.com, or @group:slug" autocomplete="off" />' +
          '<button type="button" class="em-btn ghost sm" data-emc-toggle="cc" aria-expanded="false">Cc/Bcc</button>' +
        '</div>' +
        '<div data-emc-cc hidden>' +
          '<div class="emc-row"><label class="emc-lab" for="emcCc">Cc</label><input class="em-input" id="emcCc" autocomplete="off" /></div>' +
          '<div class="emc-row"><label class="emc-lab" for="emcBcc">Bcc</label><input class="em-input" id="emcBcc" autocomplete="off" /></div>' +
          '<div class="emc-row"><label class="emc-lab" for="emcReply">Reply-To</label><input class="em-input" id="emcReply" autocomplete="off" placeholder="Where replies should go (optional)" /></div>' +
        '</div>' +
        '<div class="emc-row">' +
          '<label class="emc-lab" for="emcSubject">Subject</label>' +
          '<input class="em-input" id="emcSubject" autocomplete="off" />' +
        '</div>' +

        '<div class="emc-toolbar" role="toolbar" aria-label="Formatting">' +
          '<button type="button" class="emc-tool" data-cmd="bold" aria-label="Bold" title="Bold"><b>B</b></button>' +
          '<button type="button" class="emc-tool" data-cmd="italic" aria-label="Italic" title="Italic"><i>I</i></button>' +
          '<button type="button" class="emc-tool" data-cmd="underline" aria-label="Underline" title="Underline"><u>U</u></button>' +
          '<span class="emc-sep"></span>' +
          '<button type="button" class="emc-tool" data-cmd="insertUnorderedList" aria-label="Bulleted list" title="Bulleted list">&#8226;&#8212;</button>' +
          '<button type="button" class="emc-tool" data-cmd="insertOrderedList" aria-label="Numbered list" title="Numbered list">1&#8212;</button>' +
          '<button type="button" class="emc-tool" data-emc-link aria-label="Insert link" title="Insert link">Link</button>' +
          '<span class="emc-sep"></span>' +
          '<button type="button" class="emc-tool" data-emc-var aria-label="Insert a variable" title="Insert a variable">{{ }}</button>' +
          '<span class="emc-sep"></span>' +
          '<button type="button" class="emc-tool" data-emc-plain aria-pressed="false" title="Write in plain text instead">Plain text</button>' +
        '</div>' +

        '<div class="emc-editor" id="emcBody" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Message body"></div>' +
        '<textarea class="em-textarea emc-plain" id="emcPlain" hidden aria-label="Message body, plain text"></textarea>' +

        '<div class="emc-links">' +
          '<div class="emc-row">' +
            '<label class="emc-lab" for="emcAtt">Attach</label>' +
            '<input class="em-input" id="emcAtt" placeholder="Paste a share link (Drive, etc.) and press Add" />' +
            '<button type="button" class="em-btn sm" data-emc-add-att>Add</button>' +
          '</div>' +
          '<p class="em-hint" style="margin-top:0">Attachments in this system are <strong>links</strong>, never uploaded files. Set the link to &ldquo;anyone with the link can view&rdquo; before sending, or the recipient will see a permission wall.</p>' +
          '<div data-emc-atts class="emc-att-list"></div>' +
        '</div>' +

        '<details class="emc-more">' +
          '<summary>Sending options</summary>' +
          '<div class="emc-row" style="margin-top:12px">' +
            '<label class="emc-lab" for="emcSchedule">Schedule</label>' +
            '<input class="em-input" id="emcSchedule" type="datetime-local" />' +
          '</div>' +
          '<label class="em-check" style="margin-top:10px"><input type="checkbox" id="emcSig" checked /> Append my signature</label>' +
          '<p class="em-hint">A scheduled message is held and sent by the scheduler. It stays cancellable until then.</p>' +
        '</details>' +
      '</div>' +
      '<div class="em-modal-foot">' +
        '<button type="button" class="em-btn pri" data-emc-send>Send</button>' +
        '<button type="button" class="em-btn" data-emc-draft>Save draft</button>' +
        '<button type="button" class="em-btn ghost" data-emc-discard>Discard</button>' +
        '<span class="spacer"></span>' +
        '<span class="emc-status" data-emc-status aria-live="polite"></span>' +
      '</div>' +
    '</div>';

  var CSS =
    '.emc-row{display:flex;align-items:center;gap:10px;margin-bottom:10px}' +
    '.emc-lab{width:64px;flex-shrink:0;font-size:12px;font-weight:640;color:var(--em-ink-3)}' +
    '.emc-row .em-input{flex:1;min-width:0}' +
    '.emc-toolbar{display:flex;align-items:center;gap:2px;flex-wrap:wrap;padding:6px;background:var(--em-surface-3);border-radius:var(--em-r-sm) var(--em-r-sm) 0 0;border:1px solid var(--em-line-2);border-bottom:none;margin-top:6px}' +
    '.emc-tool{min-width:30px;height:28px;padding:0 8px;border:none;background:transparent;border-radius:5px;cursor:pointer;font:inherit;font-size:12.5px;color:var(--em-ink-2)}' +
    '.emc-tool:hover{background:var(--em-surface)}' +
    '.emc-tool[aria-pressed="true"]{background:var(--em-surface);box-shadow:var(--em-sh-1)}' +
    '.emc-sep{width:1px;height:18px;background:var(--em-line-2);margin:0 4px}' +
    '.emc-editor{min-height:200px;max-height:38vh;overflow-y:auto;padding:14px;border:1px solid var(--em-line-2);border-radius:0 0 var(--em-r-sm) var(--em-r-sm);background:var(--em-surface);font-size:14px;line-height:1.65;color:var(--em-ink)}' +
    '.emc-editor:focus{outline:none;border-color:var(--em-accent);box-shadow:0 0 0 3px var(--em-accent-soft)}' +
    '.emc-editor:empty::before{content:attr(data-placeholder);color:var(--em-ink-4)}' +
    '.emc-plain{min-height:200px;border-radius:0 0 var(--em-r-sm) var(--em-r-sm);font-family:var(--em-mono);font-size:13px}' +
    '.emc-links{margin-top:16px;padding-top:14px;border-top:1px solid var(--em-line)}' +
    '.emc-att-list{display:flex;flex-wrap:wrap;gap:6px}' +
    '.emc-more{margin-top:14px;font-size:13px}' +
    '.emc-more summary{cursor:pointer;font-weight:620;color:var(--em-ink-3);padding:4px 0}' +
    '.emc-status{font-size:12px;color:var(--em-ink-4);text-align:end;min-width:0;overflow-wrap:anywhere}' +
    '.emc-status.warn{color:var(--em-warn);font-weight:620}' +
    '@media(max-width:720px){.emc-row{flex-wrap:wrap}.emc-lab{width:100%}}';

  var VARIABLES = ['first_name', 'last_name', 'email', 'role', 'stage', 'deadline', 'application_id'];

  function injectCss() {
    if (document.getElementById('emcCss')) return;
    var s = document.createElement('style');
    s.id = 'emcCss';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  EM.compose = function (opts) {
    opts = opts || {};
    injectCss();

    var wrap = document.createElement('div');
    wrap.className = 'em-modal';
    wrap.innerHTML = MODAL_HTML;
    document.body.appendChild(wrap);

    var $ = function (sel) { return wrap.querySelector(sel); };
    var toEl = $('#emcTo'), ccEl = $('#emcCc'), bccEl = $('#emcBcc'), replyEl = $('#emcReply');
    var subjEl = $('#emcSubject'), bodyEl = $('#emcBody'), plainEl = $('#emcPlain');
    var statusEl = $('[data-emc-status]'), errorEl = $('[data-emc-error]');
    var attList = $('[data-emc-atts]');

    var state = {
      draftId: opts.draftId || null,
      threadId: opts.threadId || null,
      inReplyTo: opts.inReplyTo || null,
      attachments: [],
      plain: false,
      dirty: false,
      sending: false,
    };

    $('#emcTitle').textContent = opts.title || (opts.mode === 'reply' ? 'Reply' : opts.mode === 'forward' ? 'Forward' : 'New message');
    toEl.value = opts.to || '';
    ccEl.value = opts.cc || '';
    subjEl.value = opts.subject || '';
    bodyEl.setAttribute('data-placeholder', 'Write your message…');
    bodyEl.innerHTML = opts.body || '';
    if (opts.cc) { $('[data-emc-cc]').hidden = false; $('[data-emc-toggle="cc"]').setAttribute('aria-expanded', 'true'); }
    // A reply opens with the cursor in the body; a new message opens with it in To.
    if (opts.mode === 'reply' || opts.mode === 'forward') bodyEl.setAttribute('data-autofocus', '');
    else toEl.setAttribute('data-autofocus', '');

    function setError(msg) {
      if (!msg) { errorEl.hidden = true; return; }
      errorEl.hidden = false;
      errorEl.querySelector('p').textContent = msg;
      errorEl.scrollIntoView({ block: 'nearest' });
    }
    function setStatus(msg, warn) {
      statusEl.textContent = msg || '';
      statusEl.className = 'emc-status' + (warn ? ' warn' : '');
    }

    function bodyHtml() {
      if (state.plain) {
        return '<div>' + EM.esc(plainEl.value).replace(/\n/g, '<br/>') + '</div>';
      }
      return bodyEl.innerHTML;
    }
    function bodyText() {
      if (state.plain) return plainEl.value;
      return (bodyEl.innerText || bodyEl.textContent || '').trim();
    }

    function payload() {
      return {
        to: toEl.value, cc: ccEl.value, bcc: bccEl.value,
        replyTo: replyEl.value || undefined,
        subject: subjEl.value,
        bodyHtml: bodyHtml(), bodyText: bodyText(),
        attachments: state.attachments,
        threadId: state.threadId, inReplyTo: state.inReplyTo,
        draftId: state.draftId,
        signature: $('#emcSig').checked,
      };
    }

    /* ---- Attachments (links) ------------------------------------------------------------------ */

    function renderAtts() {
      attList.innerHTML = '';
      state.attachments.forEach(function (a, i) {
        var chip = document.createElement('span');
        chip.className = 'em-chip';
        chip.innerHTML = '<span></span><button type="button" aria-label="Remove attachment">' +
          '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>';
        chip.querySelector('span').textContent = a.filename || a.url;
        chip.querySelector('button').onclick = function () { state.attachments.splice(i, 1); renderAtts(); };
        attList.appendChild(chip);
      });
    }

    $('[data-emc-add-att]').onclick = function () {
      var input = $('#emcAtt');
      var url = input.value.trim();
      if (!url) return;
      if (!/^https?:\/\//i.test(url)) {
        setError('That is not a link. Attachments here are share links (they start with https://) — this mail system has no file upload, so a filename on its own cannot be sent.');
        return;
      }
      setError('');
      var name = url.split('/').filter(Boolean).pop() || url;
      state.attachments.push({ url: url, filename: decodeURIComponent(name).slice(0, 120) });
      input.value = '';
      renderAtts();
      markDirty();
    };

    /* ---- Toolbar ------------------------------------------------------------------------------ */

    wrap.querySelectorAll('[data-cmd]').forEach(function (b) {
      b.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep the selection
      b.addEventListener('click', function () {
        // document.execCommand is deprecated and is still the only thing every browser implements
        // for rich text in a contenteditable without shipping an editor library. The plain-text
        // toggle beside it is the honest escape hatch when it misbehaves.
        try { document.execCommand(b.dataset.cmd, false, null); } catch (_) {}
        bodyEl.focus();
        markDirty();
      });
    });

    $('[data-emc-link]').addEventListener('mousedown', function (e) { e.preventDefault(); });
    $('[data-emc-link]').onclick = function () {
      var sel = window.getSelection();
      var text = sel && String(sel);
      var href = window.prompt('Link address (https://…)', 'https://');
      if (!href || !/^https?:\/\//i.test(href)) return;
      bodyEl.focus();
      try {
        if (text) document.execCommand('createLink', false, href);
        else document.execCommand('insertHTML', false, '<a href="' + EM.esc(href) + '">' + EM.esc(href) + '</a>');
      } catch (_) {}
      markDirty();
    };

    $('[data-emc-var]').addEventListener('mousedown', function (e) { e.preventDefault(); });
    $('[data-emc-var]').onclick = function () {
      // Said plainly, because it is a real and easily-missed distinction in this product.
      EM.toast('Variables like {{first_name}} are filled per person in CAMPAIGNS. A message sent from this composer goes to its recipients as one message, so a variable here is sent literally.', 'bad', 9000);
      var pick = window.prompt('Insert which variable?\n\n' + VARIABLES.join(', '), VARIABLES[0]);
      if (!pick || VARIABLES.indexOf(pick.trim()) < 0) return;
      var token = '{{' + pick.trim() + '}}';
      if (state.plain) {
        plainEl.setRangeText(token, plainEl.selectionStart, plainEl.selectionEnd, 'end');
      } else {
        bodyEl.focus();
        try { document.execCommand('insertText', false, token); } catch (_) { bodyEl.innerHTML += token; }
      }
      markDirty();
    };

    $('[data-emc-plain]').onclick = function () {
      state.plain = !state.plain;
      this.setAttribute('aria-pressed', String(state.plain));
      if (state.plain) {
        plainEl.value = (bodyEl.innerText || '').trim();
        plainEl.hidden = false; bodyEl.hidden = true;
        wrap.querySelectorAll('[data-cmd],[data-emc-link]').forEach(function (b) { b.disabled = true; });
        plainEl.focus();
      } else {
        bodyEl.innerHTML = '<div>' + EM.esc(plainEl.value).replace(/\n/g, '<br/>') + '</div>';
        plainEl.hidden = true; bodyEl.hidden = false;
        wrap.querySelectorAll('[data-cmd],[data-emc-link]').forEach(function (b) { b.disabled = false; });
        bodyEl.focus();
      }
    };

    $('[data-emc-toggle="cc"]').onclick = function () {
      var box = $('[data-emc-cc]');
      box.hidden = !box.hidden;
      this.setAttribute('aria-expanded', String(!box.hidden));
      if (!box.hidden) ccEl.focus();
    };

    /* ---- Autosave ------------------------------------------------------------------------------
       A save that FAILS does not clear anything and does not say "Saved". It says so, and the next
       change retries. Losing somebody's half-written message to a transient 500 while telling them
       it was saved is the worst thing a composer can do.                                          */

    var saveTimer = null;
    function markDirty() {
      state.dirty = true;
      setStatus('Unsaved changes');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveDraft, 2500);
    }
    ['input', 'change'].forEach(function (ev) {
      [toEl, ccEl, bccEl, replyEl, subjEl, plainEl].forEach(function (el) { el.addEventListener(ev, markDirty); });
    });
    bodyEl.addEventListener('input', markDirty);

    function saveDraft(explicit) {
      if (state.sending) return Promise.resolve({ ok: false });
      var hasContent = (toEl.value || subjEl.value || bodyText()).trim();
      if (!hasContent) { setStatus(''); return Promise.resolve({ ok: true }); }
      setStatus('Saving…');
      var p = payload();
      p.action = 'save';
      return EM.api('/api/mail/draft', { body: p }).then(function (res) {
        if (res.ok) {
          state.draftId = res.draftId || state.draftId;
          state.threadId = res.threadId || state.threadId;
          state.dirty = false;
          setStatus('Draft saved ' + new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
        } else {
          setStatus('NOT saved — your text is still here. ' + (res.error || ''), true);
        }
        return res;
      });
    }
    $('[data-emc-draft]').onclick = function () {
      var btn = this;
      EM.busy(btn, true, 'Saving');
      saveDraft(true).then(function (res) {
        EM.busy(btn, false);
        if (res.ok) EM.toast('Draft saved.', 'ok');
        else EM.toast(res.error || 'The draft was not saved. Your message is still on screen.', 'bad');
      });
    };

    /* ---- Send ---------------------------------------------------------------------------------- */

    $('[data-emc-send]').onclick = function () {
      var btn = this;
      setError('');
      if (!toEl.value.trim() && !ccEl.value.trim() && !bccEl.value.trim()) {
        setError('Add at least one recipient.'); toEl.focus(); return;
      }
      if (!subjEl.value.trim() && !bodyText().trim()) {
        setError('This message has no subject and no body. Nothing has been sent.'); return;
      }

      var p = payload();
      var sched = $('#emcSchedule').value;
      if (sched) {
        var when = new Date(sched);
        if (isNaN(when.getTime())) { setError('That send time could not be read.'); return; }
        if (when.getTime() < Date.now() + 60000) { setError('Pick a time at least a minute from now, so there is time to cancel it.'); return; }
        p.scheduledAt = when.toISOString();
      }

      state.sending = true;
      clearTimeout(saveTimer);
      EM.busy(btn, true, 'Sending');
      EM.api('/api/mail/send', { body: p }).then(function (res) {
        state.sending = false;
        EM.busy(btn, false);

        if (!res.ok) {
          // The server's sentence, verbatim. It is the one that says what is unchanged.
          setError(res.error || 'This message was NOT sent, and it is still here.');
          if (res.rejectedAttachments && res.rejectedAttachments.length) {
            setError((res.error || '') + ' — ' + res.rejectedAttachments.map(function (a) { return a.reason; }).join('; '));
          }
          return;
        }

        if (res.scheduled) {
          EM.toast('Scheduled for ' + EM.fullTime(res.scheduledAt) + '. It stays cancellable until then.', 'ok', 6000);
          close(true);
          return;
        }

        // THE SERVER'S VERDICT, NOT AN ASSUMPTION.
        //
        // /api/mail/send returns a resolved DeliveryStatus already run through deliveryWording() —
        // { state, sent, failed, label, tone, detail }. That wording function exists precisely so
        // "the composer's toast and the thread badge cannot disagree", so this reads it rather than
        // deciding again. A message stored internally that never reached a transport has state
        // 'no_transport' and tone 'bad'; showing "Sent" for it is the exact failure mail.ts
        // documents removing.
        var d = res.delivery || {};
        var tone = d.tone === 'ok' ? 'ok' : (d.tone === 'bad' || d.tone === 'warn') ? 'bad' : '';
        EM.toast((d.label || 'Message sent') + (d.detail ? ' — ' + d.detail : ''), tone, tone === 'bad' ? 12000 : 5000);

        // An existing group with no members still means nobody on that list received it.
        if (res.groupWarning) EM.toast(res.groupWarning, 'bad', 12000);

        close(true);
        if (opts.onSent) opts.onSent(res);
      });
    };

    /* ---- Discard / close ------------------------------------------------------------------------ */

    $('[data-emc-discard]').onclick = function () {
      EM.confirm({
        title: 'Discard this message?',
        body: state.draftId
          ? 'The saved draft will be deleted. This cannot be undone.'
          : 'Everything typed here will be lost. Nothing has been sent.',
        confirmLabel: 'Discard',
        tone: 'danger',
      }).then(function (yes) {
        if (!yes) return;
        if (state.draftId) {
          EM.api('/api/mail/draft', { body: { action: 'delete', draftId: state.draftId } }).then(function (res) {
            if (!res.ok) EM.toast(res.error || 'The draft could not be deleted.', 'bad');
            close(true);
            if (opts.onDiscard) opts.onDiscard();
          });
        } else {
          close(true);
        }
      });
    };

    function close(force) {
      if (!force && state.dirty) {
        EM.confirm({
          title: 'Close without saving?',
          body: 'This message has changes that have not been saved as a draft.',
          confirmLabel: 'Close and lose them',
          tone: 'danger',
        }).then(function (yes) { if (yes) doClose(); });
        return;
      }
      doClose();
    }
    function doClose() {
      clearTimeout(saveTimer);
      wrap.hidden = true;
      document.body.style.overflow = '';
      release();
      wrap.remove();
      window.removeEventListener('beforeunload', warn);
    }

    $('[data-emc-close]').onclick = function () { close(); };

    // The browser's own guard, for a tab close rather than a modal close.
    function warn(e) { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } }
    window.addEventListener('beforeunload', warn);

    var release = EM.trap(wrap, function () { close(); });
    wrap.hidden = false;
    document.body.style.overflow = 'hidden';
    wrap.addEventListener('mousedown', function (e) { if (e.target === wrap) close(); });

    // Ctrl/Cmd+Enter sends, which is the shortcut every mail client has trained people to expect.
    wrap.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); $('[data-emc-send]').click(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); $('[data-emc-draft]').click(); }
    });

    renderAtts();
    return { close: close };
  };
})();
