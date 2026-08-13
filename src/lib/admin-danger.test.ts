// Tests for the arm-then-fire guard on destructive admin controls.
//
// =================================================================================================
// WHY THIS IS TESTED AGAINST A FAKE DOM RATHER THAN REASONED ABOUT
// =================================================================================================
//
// The first draft of public/admin-danger.js had an ordering bug that would have made every one of
// the forty-eight delete buttons permanently un-submittable. A click on a submit button fires
// `click` and THEN `submit`. The draft disarmed on the second click and let the click through — so
// by the time the submit handler ran, `armed` was already null, it saw an unarmed control, and it
// cancelled the submission and armed the button again. Forever.
//
// That is the exact failure this guard was written to remove: a control that silently refuses, and
// a person who presses it again because there is nothing else to try. Nobody would have caught it
// by reading. So the handlers are exported and driven here.
//
// There is no jsdom in this project and adding one for this would be a heavy dependency for one
// file, so the DOM below is a stub with only what the guard actually touches.

import { describe, it, expect, report } from './test-shim';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const installDanger = require_('../../public/admin-danger.js');

// -------------------------------------------------------------------------------------------------
// A DOM stub. Only the surface the guard uses: attributes, labels, style, closest, querySelector.
// -------------------------------------------------------------------------------------------------
class El {
  tagName: string;
  attrs: Record<string, string> = {};
  children: El[] = [];
  parent: El | null = null;
  textContent = '';
  value = '';
  styleProps: Record<string, string> = {};
  style = {
    setProperty: (k: string, v: string) => { this.styleProps[k] = v; },
    removeProperty: (k: string) => { delete this.styleProps[k]; },
  };

  constructor(tag: string, attrs: Record<string, string> = {}) {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
  }
  getAttribute(k: string) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  removeAttribute(k: string) { delete this.attrs[k]; }
  append(...kids: El[]) { for (const k of kids) { k.parent = this; this.children.push(k); } return this; }

  get form(): El | null {
    let p: El | null = this.parent;
    while (p && p.tagName !== 'FORM') p = p.parent;
    return p;
  }
  /** Enough selector support for the two the guard uses. */
  matches(sel: string): boolean {
    return sel.split(',').map((s) => s.trim()).some((s) => this.matchesOne(s));
  }
  private matchesOne(s: string): boolean {
    // Descendant selectors: "form[data-danger] button[type=submit]"
    const parts = s.split(/\s+/).filter(Boolean);
    if (parts.length > 1) {
      if (!this.matchesOne(parts[parts.length - 1])) return false;
      let p: El | null = this.parent;
      while (p) { if (p.matchesOne(parts[0])) return true; p = p.parent; }
      return false;
    }
    const m = /^([a-z]*)((\[[^\]]+\])*)$/i.exec(s);
    if (!m) return false;
    if (m[1] && this.tagName !== m[1].toUpperCase()) return false;
    for (const a of s.match(/\[[^\]]+\]/g) || []) {
      const inner = a.slice(1, -1);
      const eq = inner.indexOf('=');
      if (eq === -1) { if (this.getAttribute(inner) === null) return false; }
      else {
        const k = inner.slice(0, eq);
        const v = inner.slice(eq + 1).replace(/^["']|["']$/g, '');
        if (this.getAttribute(k) !== v) return false;
      }
    }
    return true;
  }
  closest(sel: string): El | null {
    let n: El | null = this;
    while (n) { if (n.matches(sel)) return n; n = n.parent; }
    return null;
  }
  querySelector(sel: string): El | null {
    for (const k of this.children) {
      if (k.matches(sel)) return k;
      const deep = k.querySelector(sel);
      if (deep) return deep;
    }
    return null;
  }
}

function harness() {
  const listeners: Record<string, Function[]> = {};
  const doc = {
    addEventListener: (t: string, fn: Function) => { (listeners[t] = listeners[t] || []).push(fn); },
  };
  const win = { addEventListener: () => {} };
  const api = installDanger(doc as any, win as any);

  /** Returns whether the default action survived — i.e. whether the browser would act. */
  function fire(type: 'click' | 'submit', target: El): boolean {
    let defaultPrevented = false;
    const ev = {
      target,
      key: '',
      preventDefault: () => { defaultPrevented = true; },
      stopPropagation: () => {},
    };
    for (const fn of listeners[type] || []) fn(ev);
    return !defaultPrevented;
  }
  return { api, fire };
}

/** A form carrying the guard, with one submit button. */
function guardedForm(question = 'Delete this institution permanently?') {
  const form = new El('form', { method: 'POST', 'data-danger': question });
  const btn = new El('button', { type: 'submit' });
  btn.textContent = 'Delete';
  form.append(btn);
  return { form, btn, question };
}

describe('the first click arms and does not act', () => {
  it('cancels the click instead of submitting', () => {
    const { fire } = harness();
    const { btn } = guardedForm();
    expect(fire('click', btn)).toBe(false);
  });

  it('re-labels the button with the question so the second click is not a reflex', () => {
    const { fire } = harness();
    const { btn, question } = guardedForm();
    fire('click', btn);
    expect(btn.textContent).toBe(question);
    expect(btn.getAttribute('data-danger-armed')).toBe('1');
  });

  it('turns it red', () => {
    const { fire } = harness();
    const { btn } = guardedForm();
    fire('click', btn);
    expect(String(btn.styleProps.color)).toBe('#fca5a5');
  });
});

describe('the second click actually fires — the bug that nearly shipped', () => {
  it('lets the click through', () => {
    const { fire } = harness();
    const { btn } = guardedForm();
    fire('click', btn);
    expect(fire('click', btn)).toBe(true);
  });

  it('and the submit that follows it is NOT cancelled', () => {
    // THE REGRESSION. click fires, then submit. The first draft disarmed during the click, so the
    // submit handler saw an unarmed control, cancelled the submission and re-armed. Forever.
    const { fire } = harness();
    const { form, btn } = guardedForm();
    fire('click', btn);            // arm
    fire('click', btn);            // fire
    expect(fire('submit', form)).toBe(true);
  });

  it('restores the original label so a failed POST does not leave the question on screen', () => {
    const { fire } = harness();
    const { btn } = guardedForm();
    fire('click', btn);
    fire('click', btn);
    expect(btn.textContent).toBe('Delete');
    expect(btn.getAttribute('data-danger-armed')).toBe(null);
  });

  it('consumes the confirmation, so a later stray submit is guarded again', () => {
    const { fire } = harness();
    const { form, btn } = guardedForm();
    fire('click', btn);
    fire('click', btn);
    fire('submit', form);
    expect(form.getAttribute('data-danger-confirmed')).toBe(null);
    expect(fire('submit', form)).toBe(false);
  });
});

describe('the ways it disarms', () => {
  it('a click anywhere else cancels', () => {
    const { fire } = harness();
    const { btn } = guardedForm();
    const elsewhere = new El('div');
    fire('click', btn);
    fire('click', elsewhere);
    expect(btn.textContent).toBe('Delete');
    expect(fire('click', btn)).toBe(false);   // armed afresh, not fired
  });

  it('Escape cancels', () => {
    const { api, fire } = harness();
    const { btn } = guardedForm();
    fire('click', btn);
    api.onKey({ key: 'Escape' });
    expect(api.isArmed()).toBe(null);
  });
});

describe('submitting with the Enter key cannot slip past', () => {
  it('a bare submit with no click is cancelled and arms the button instead', () => {
    // Enter in a text field produces `submit` and no `click` at all.
    const { fire } = harness();
    const { form, btn, question } = guardedForm();
    expect(fire('submit', form)).toBe(false);
    expect(btn.textContent).toBe(question);
  });
});

describe('the shapes of control it has to cover', () => {
  it('guards a bare button that carries the question itself', () => {
    const { fire } = harness();
    const btn = new El('button', { 'data-danger': 'Delete the selected rows?' });
    btn.textContent = 'Delete';
    expect(fire('click', btn)).toBe(false);
    expect(btn.textContent).toBe('Delete the selected rows?');
    expect(fire('click', btn)).toBe(true);
  });

  it('guards an input[type=submit], whose label lives in value not textContent', () => {
    const form = new El('form', { 'data-danger': 'Delete permanently?' });
    const input = new El('input', { type: 'submit' });
    input.value = 'Delete';
    form.append(input);
    const { fire } = harness();
    fire('click', input);
    expect(input.value).toBe('Delete permanently?');
    fire('click', input);
    expect(input.value).toBe('Delete');
    expect(fire('submit', form)).toBe(true);
  });

  it('leaves an UNGUARDED form completely alone', () => {
    // 41 reversible controls keep their confirm(). This must not touch them.
    const form = new El('form', { method: 'POST' });
    const btn = new El('button', { type: 'submit' });
    form.append(btn);
    const { fire } = harness();
    expect(fire('click', btn)).toBe(true);
    expect(fire('submit', form)).toBe(true);
  });

  it('arming one control disarms another, so two are never live at once', () => {
    const { fire } = harness();
    const a = guardedForm('Delete A?');
    const b = guardedForm('Delete B?');
    fire('click', a.btn);
    fire('click', b.btn);
    expect(a.btn.textContent).toBe('Delete');       // A stood down
    expect(b.btn.textContent).toBe('Delete B?');
    expect(fire('click', a.btn)).toBe(false);       // A needs arming again, it does not just fire
  });
});

report();
