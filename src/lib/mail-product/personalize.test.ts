// src/lib/mail-product/personalize.test.ts — merge variables.
//
// The assertion that matters most is the LAST one in the "missing" block: an unfillable token must
// become empty text on a real send, and must NEVER go out as the literal "{{first_name}}". That is
// the failure /admin/mail/templates warned about — "an operator discovering it in a mail to five
// hundred applicants addressed to {{first_name}}".
import { describe, it, expect } from 'vitest';
import {
  personalize, personalizeMessage, buildContext, extractVariables, unknownVariables,
  MERGE_VARIABLES, VARIABLE_KEYS,
} from './personalize';

const FIXED = new Date('2026-08-16T09:00:00Z');
const anita = { email: 'anita.rao@example.com', first_name: 'Anita', last_name: 'Rao', fields: { role: 'Data Engineer', stage: '3' } };

describe('extractVariables', () => {
  it('finds each variable once, in order of first appearance', () => {
    expect(extractVariables('{{a}} {{b}} {{a}}')).toEqual(['a', 'b']);
  });

  it('tolerates inner whitespace', () => {
    expect(extractVariables('{{  first_name  }}')).toEqual(['first_name']);
  });

  // A loose pattern would swallow CSS in a style block and silently mangle the HTML — a rendering
  // bug that only shows up in the recipient's inbox.
  it('does not match CSS braces or a single brace', () => {
    expect(extractVariables('.a { color: red }')).toEqual([]);
    expect(extractVariables('{not a token}')).toEqual([]);
    expect(extractVariables('{{ 1nvalid }}')).toEqual([]);
    expect(extractVariables('{{has-a-hyphen}}')).toEqual([]);
  });
});

describe('buildContext', () => {
  it('fills the built-in fields from the contact', () => {
    const ctx = buildContext({ contact: anita, now: FIXED });
    expect(ctx.first_name).toBe('Anita');
    expect(ctx.last_name).toBe('Rao');
    expect(ctx.full_name).toBe('Anita Rao');
    expect(ctx.email).toBe('anita.rao@example.com');
  });

  it('lets a custom field answer a variable this module has never heard of', () => {
    const ctx = buildContext({ contact: anita, now: FIXED });
    expect(ctx.role).toBe('Data Engineer');
    expect(ctx.stage).toBe('3');
  });

  it('does not let a custom field overwrite a built-in that has a value', () => {
    const ctx = buildContext({
      contact: { ...anita, fields: { first_name: 'IMPOSTER' } },
      now: FIXED,
    });
    expect(ctx.first_name).toBe('Anita');
  });

  it('is not time-dependent when given a clock', () => {
    expect(buildContext({ now: FIXED }).today).toBe(buildContext({ now: FIXED }).today);
  });
});

describe('personalize', () => {
  it('substitutes what it can', () => {
    const out = personalize('Hello {{first_name}} {{last_name}}', { contact: anita, now: FIXED });
    expect(out.text).toBe('Hello Anita Rao');
    expect(out.missing).toEqual([]);
  });

  // THE ONE THAT MATTERS.
  it('sends an unfillable token as EMPTY TEXT, never as the literal token', () => {
    const out = personalize('Hello {{first_name}}, about {{deadline}}', {
      contact: { email: 'x@y.com', fields: {} },
      missing: 'blank',
      now: FIXED,
    });
    expect(out.text).toBe('Hello , about ');
    expect(out.text).not.toContain('{{');
    expect(out.missing.sort()).toEqual(['deadline', 'first_name']);
  });

  it('fills with a sample in preview mode, so an author sees a realistic message', () => {
    const out = personalize('Hello {{first_name}}', { missing: 'sample', now: FIXED });
    expect(out.text).toBe('Hello Anita');
    expect(out.missing).toEqual(['first_name']);
  });

  it('leaves the token visible on the builder canvas', () => {
    const out = personalize('Hello {{first_name}}', { missing: 'keep', now: FIXED });
    expect(out.text).toBe('Hello {{first_name}}');
  });

  it('leaves a token nothing knows about alone in keep mode and blanks it in blank mode', () => {
    expect(personalize('{{totally_unknown}}', { missing: 'keep', now: FIXED }).text).toBe('{{totally_unknown}}');
    expect(personalize('{{totally_unknown}}', { missing: 'blank', now: FIXED }).text).toBe('');
  });

  it('does not touch CSS in a style block', () => {
    const css = '<style>.x { color: red; }</style><p>{{first_name}}</p>';
    const out = personalize(css, { contact: anita, now: FIXED });
    expect(out.text).toContain('.x { color: red; }');
    expect(out.text).toContain('Anita');
  });

  it('handles empty and non-string input without throwing', () => {
    expect(personalize('', {}).text).toBe('');
    expect(personalize(null as any, {}).text).toBe('');
    expect(personalize(undefined as any, {}).text).toBe('');
  });

  it('treats a contact with a blank first name as missing, not as an empty success', () => {
    const out = personalize('Hi {{first_name}}', { contact: { email: 'a@b.com', first_name: '' }, now: FIXED });
    expect(out.missing).toEqual(['first_name']);
  });
});

describe('personalizeMessage', () => {
  it('uses ONE context for subject, html and text, so the three cannot disagree', () => {
    const out = personalizeMessage(
      { subject: 'Hi {{first_name}}', html: '<p>Hi {{first_name}}</p>', text: 'Hi {{first_name}}' },
      { contact: anita, now: FIXED },
    );
    expect(out.subject).toBe('Hi Anita');
    expect(out.html).toBe('<p>Hi Anita</p>');
    expect(out.text).toBe('Hi Anita');
  });

  it('unions the missing tokens across all three parts', () => {
    const out = personalizeMessage(
      { subject: '{{a_thing}}', html: '{{another}}', text: '{{a_thing}}' },
      { contact: anita, now: FIXED },
    );
    expect(out.missing.sort()).toEqual(['a_thing', 'another']);
  });
});

describe('unknownVariables', () => {
  it('names only what the catalogue cannot fill', () => {
    expect(unknownVariables('{{first_name}} {{nope}}')).toEqual(['nope']);
  });
});

describe('the catalogue', () => {
  it('offers every variable the brief names', () => {
    for (const key of ['first_name', 'last_name', 'email', 'role', 'stage', 'deadline', 'application_id']) {
      expect(VARIABLE_KEYS).toContain(key);
    }
  });

  it('gives every entry a sample, because preview mode depends on it', () => {
    for (const v of MERGE_VARIABLES) {
      expect(v.sample.length).toBeGreaterThan(0);
      expect(v.label.length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate keys', () => {
    expect(new Set(VARIABLE_KEYS).size).toBe(VARIABLE_KEYS.length);
  });
});
