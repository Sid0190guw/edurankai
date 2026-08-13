/* /admin-danger.js — a second step for destructive admin actions that is not a browser dialog.
 *
 * ================================================================================================
 * WHY NOT confirm()
 * ================================================================================================
 *
 * Every destructive control in this admin was guarded by onsubmit="return confirm(...)". That has
 * failed twice over:
 *
 *   1. THE SIDE PANEL. era-sidepanel.js frames admin pages in a sandboxed iframe. Until this was
 *      found, `allow-modals` was absent from that sandbox, so the browser IGNORED confirm() and
 *      RETURNED FALSE. Every guarded form cancelled its own submission — no dialog, no error, no
 *      request. 104 controls across 68 pages. The founder pressed Revoke on a signed offer, with
 *      the reason already typed, and nothing happened at all.
 *
 *      Worse, /admin/users chained `confirm(...) && prompt('Type DELETE') === 'DELETE'`. prompt()
 *      is suppressed the same way and returns null, so permanent user deletion was dead twice over.
 *
 *   2. DIALOG SUPPRESSION. Even with allow-modals granted, a browser told "prevent this page from
 *      creating additional dialogs" — one checkbox, offered after a couple of dialogs — makes
 *      confirm() return false forever. The same silent cancellation returns, and this time no code
 *      change can see it.
 *
 * Both failures share a shape: the guard says no, and the person is told nothing. A control that
 * silently refuses is indistinguishable from a broken one, and the reasonable response — press it
 * again, harder — is exactly the wrong one.
 *
 * ================================================================================================
 * WHAT REPLACES IT: ARM, THEN FIRE
 * ================================================================================================
 *
 * The first click ARMS the control: it does not submit, the label becomes the question, the button
 * turns red. The second click, within ARM_WINDOW_MS, does the thing. Clicking anything else,
 * pressing Escape, leaving the tab, or simply waiting disarms it.
 *
 * No dialog, no permission, no layout change — the button re-labels itself in place, so this works
 * in a table row of icon buttons where a checkbox never could. Unlike a modal it cannot be
 * dismissed by reflex: the second click lands on a button that now says "Delete permanently?" in
 * red where a moment ago it said "Delete".
 *
 * USAGE: put the question in data-danger on the <form> or the <button>, and delete the inline
 * confirm().
 *
 *     <form method="POST" data-danger="Delete this institution permanently?">
 *     <button type="submit" data-danger="Delete the selected rows? This cannot be undone.">
 *
 * NON-DESTRUCTIVE CONTROLS STAY ON confirm() DELIBERATELY. Archiving, approving and publishing are
 * reversible; making every one of them two-step would train people to click twice without reading,
 * which is the habit this exists to prevent.
 *
 * ================================================================================================
 * THE ORDERING BUG THIS FILE WAS NEARLY SHIPPED WITH
 * ================================================================================================
 *
 * A click on a submit button fires `click` and then `submit`. The first draft disarmed on the
 * second click and let the click through — but by the time `submit` ran, `armed` was already null,
 * so the submit handler saw an unarmed control, cancelled the submission and armed it AGAIN. The
 * button would have re-armed forever and NOTHING would ever have deleted. That is the same class of
 * silent refusal this file exists to remove, and it would have sat under forty-eight delete
 * buttons. The confirmation is therefore recorded ON THE FORM before disarming, and the submit
 * handler reads that flag. installDanger() is exported so this ordering is tested rather than
 * reasoned about — see src/lib/admin-danger.test.ts.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.installDanger = factory(), root.installDanger(document, window);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** After this long an armed control forgets, so a stray second click minutes later does nothing. */
  var ARM_WINDOW_MS = 5000;

  function installDanger(doc, win) {
    var armed = null;        // the element currently armed
    var armedTimer = null;
    var original = null;     // its label before arming

    function isInput(el) {
      return el.tagName === 'INPUT';
    }
    function readLabel(el) {
      return isInput(el) ? el.value : el.textContent;
    }
    function writeLabel(el, v) {
      if (isInput(el)) el.value = v; else el.textContent = v;
    }

    function disarm() {
      if (armed) {
        if (original !== null) writeLabel(armed, original);
        armed.removeAttribute('data-danger-armed');
        if (armed.style) {
          armed.style.removeProperty('background');
          armed.style.removeProperty('border-color');
          armed.style.removeProperty('color');
        }
      }
      if (armedTimer) clearTimeout(armedTimer);
      armed = null; armedTimer = null; original = null;
    }

    function arm(btn, question) {
      disarm();
      armed = btn;
      original = readLabel(btn);
      btn.setAttribute('data-danger-armed', '1');
      writeLabel(btn, question);
      // Inline and !important, so it reads as dangerous on every one of the wildly different button
      // styles in this admin without each page having to define a class.
      if (btn.style) {
        btn.style.setProperty('background', 'rgba(220,38,38,0.20)', 'important');
        btn.style.setProperty('border-color', 'rgba(248,113,113,0.65)', 'important');
        btn.style.setProperty('color', '#fca5a5', 'important');
      }
      btn.setAttribute('title', 'Click again to confirm. Click anywhere else to cancel.');
      armedTimer = setTimeout(disarm, ARM_WINDOW_MS);
    }

    /** The form this control submits, if that form carries the guard. */
    function guardedForm(btn) {
      var f = btn.form || (btn.closest ? btn.closest('form[data-danger]') : null);
      return f && f.getAttribute && f.getAttribute('data-danger') ? f : null;
    }

    /** The question for a control: its own data-danger, else its form's. */
    function questionFor(btn) {
      var own = btn.getAttribute ? btn.getAttribute('data-danger') : null;
      if (own) return own;
      var f = guardedForm(btn);
      return f ? f.getAttribute('data-danger') : null;
    }

    var SELECTOR = 'button[data-danger], a[data-danger], input[type="submit"][data-danger], '
      + 'form[data-danger] button[type="submit"], form[data-danger] input[type="submit"]';

    function onClick(e) {
      var btn = e.target && e.target.closest ? e.target.closest(SELECTOR) : null;

      if (!btn) { disarm(); return; }            // a click anywhere else always cancels

      if (btn === armed) {
        // SECOND CLICK. Record the confirmation on the form BEFORE disarming — the submit event
        // fires after this handler returns, and it must not see an unarmed control and re-arm.
        var f = guardedForm(btn);
        if (f) f.setAttribute('data-danger-confirmed', '1');
        disarm();
        return;                                   // let the click through
      }

      var q = questionFor(btn);
      if (!q) return;

      e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
      arm(btn, q);
    }

    function onSubmit(e) {
      var form = e.target;
      if (!form || !form.getAttribute || !form.getAttribute('data-danger')) return;
      if (form.getAttribute('data-danger-confirmed') === '1') {
        form.removeAttribute('data-danger-confirmed');
        return;                                   // confirmed by the second click: through it goes
      }
      // Reached by pressing Enter in a field, which produces no click at all.
      e.preventDefault();
      var btn = form.querySelector('button[type="submit"], input[type="submit"]');
      if (btn) arm(btn, form.getAttribute('data-danger'));
    }

    function onKey(e) {
      if (e.key === 'Escape') disarm();
    }

    // Capture phase, so this runs before any page handler that would act on the first click.
    doc.addEventListener('click', onClick, true);
    doc.addEventListener('submit', onSubmit, true);
    doc.addEventListener('keydown', onKey);
    if (win && win.addEventListener) win.addEventListener('blur', disarm);

    // Returned for tests; the browser never needs them.
    return { onClick: onClick, onSubmit: onSubmit, onKey: onKey, disarm: disarm, isArmed: function () { return armed; } };
  }

  return installDanger;
});
