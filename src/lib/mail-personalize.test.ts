import { describe, it, expect } from 'vitest';
import {
  extractVariables, usedVariableNames, renderText, renderHtml, renderSubject,
  missingVariables, variablesWithoutFallback, previewFill, mergeVarsForContact, escapeHtml,
} from '@/lib/mail-personalize';

describe('variable extraction', () => {
  it('reads a bare token', () => {
    const v = extractVariables('Hi {{first_name}},');
    expect(v).toHaveLength(1);
    expect(v[0].name).toBe('first_name');
    expect(v[0].fallback).toBeNull();
  });

  it('reads a double-quoted default', () => {
    const v = extractVariables('Hi {{first_name | default:"Applicant"}},');
    expect(v[0].fallback).toBe('Applicant');
  });

  it('reads a single-quoted default and tolerates missing spaces', () => {
    const v = extractVariables("Hi {{first_name|default:'there'}}");
    expect(v[0].fallback).toBe('there');
  });

  it('reads an unquoted default', () => {
    expect(extractVariables('{{stage|default:new}}')[0].fallback).toBe('new');
  });

  it('lower-cases the name but keeps the default verbatim', () => {
    const v = extractVariables('{{First_Name | default:"Dr Rao"}}');
    expect(v[0].name).toBe('first_name');
    expect(v[0].fallback).toBe('Dr Rao');
  });

  it('leaves prose in braces alone', () => {
    expect(extractVariables('{{ hello world }}')).toHaveLength(0);
    expect(renderText('{{ hello world }}', {})).toBe('{{ hello world }}');
  });

  it('lists distinct names in first-seen order', () => {
    expect(usedVariableNames('{{b}} {{a}} {{b}}')).toEqual(['b', 'a']);
  });
});

describe('rendering', () => {
  it('substitutes a present value', () => {
    expect(renderText('Hi {{first_name}}', { first_name: 'Ananya' })).toBe('Hi Ananya');
  });

  it('NEVER leaves a raw token in the output', () => {
    expect(renderText('Hi {{first_name}}', {})).toBe('Hi ');
    expect(renderText('Hi {{first_name}}', { first_name: null })).toBe('Hi ');
    expect(renderText('Hi {{first_name}}', { first_name: '   ' })).toBe('Hi ');
  });

  it('falls back when the value is missing, blank or whitespace', () => {
    const t = 'Hi {{first_name | default:"Applicant"}}';
    expect(renderText(t, {})).toBe('Hi Applicant');
    expect(renderText(t, { first_name: '' })).toBe('Hi Applicant');
    expect(renderText(t, { first_name: '  ' })).toBe('Hi Applicant');
    expect(renderText(t, { first_name: 'Ravi' })).toBe('Hi Ravi');
  });

  it('keeps a numeric zero, which is a value', () => {
    expect(renderText('{{score | default:"none"}}', { score: 0 })).toBe('0');
  });

  it('is case-insensitive about the variable name', () => {
    expect(renderText('{{first_name}}', { First_Name: 'Ravi' })).toBe('Ravi');
  });

  it('reads a custom field under both its bare and custom. name', () => {
    expect(renderText('{{custom.university}}', { university: 'IITG' })).toBe('IITG');
  });

  it('escapes merged values in HTML but not the template markup', () => {
    const out = renderHtml('<p>Hi {{organization}}</p>', { organization: 'Sharma & Co <b>' });
    expect(out).toBe('<p>Hi Sharma &amp; Co &lt;b&gt;</p>');
  });

  it('does not escape in the text renderer', () => {
    expect(renderText('{{organization}}', { organization: 'A & B' })).toBe('A & B');
  });

  it('strips newlines from a subject line', () => {
    expect(renderSubject('Re: {{topic}}', { topic: 'a\nb' })).toBe('Re: a b');
  });

  it('escapeHtml covers the five characters that matter', () => {
    expect(escapeHtml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;');
  });
});

describe('blank detection', () => {
  it('reports variables that will render blank for these values', () => {
    expect(missingVariables('{{a}} {{b | default:"x"}} {{c}}', { a: 'A' })).toEqual(['c']);
  });

  it('reports copy-level variables with no default at all', () => {
    expect(variablesWithoutFallback('{{a}} {{b | default:"x"}}')).toEqual(['a']);
  });

  it('does not demand a default on system variables the sender fills', () => {
    expect(variablesWithoutFallback('{{unsubscribe_url}} {{a}}')).toEqual(['a']);
  });

  it('previewFill leaves nothing unresolved', () => {
    const filled = previewFill('Hi {{first_name}} at {{organization}} — {{unsubscribe_url}}');
    expect(filled).not.toContain('{{');
  });
});

describe('mergeVarsForContact', () => {
  const c = {
    email: 'ananya@example.org',
    first_name: 'Ananya',
    last_name: 'Rao',
    organization: 'IIT Guwahati',
    role_title: 'SWE Intern',
    custom: { university: 'IITG', cohort: 3 },
    application_stage: 'assessment',
    application_number: 'ERA-2026-0184',
  };

  it('builds full_name from the parts', () => {
    expect(mergeVarsForContact(c).full_name).toBe('Ananya Rao');
  });

  it('exposes custom fields both ways', () => {
    const v = mergeVarsForContact(c);
    expect(v.university).toBe('IITG');
    expect(v['custom.university']).toBe('IITG');
    expect(v['custom.cohort']).toBe('3');
  });

  it('never lets a custom field shadow a standard one', () => {
    const v = mergeVarsForContact({ ...c, custom: { email: 'spoofed@evil.test' } });
    expect(v.email).toBe('ananya@example.org');
    expect(v['custom.email']).toBe('spoofed@evil.test');
  });

  it('lets the caller override with system variables', () => {
    const v = mergeVarsForContact(c, { unsubscribe_url: 'https://x/u' });
    expect(v.unsubscribe_url).toBe('https://x/u');
  });

  it('renders a full recruitment mail with no leftovers', () => {
    const body = 'Hi {{first_name | default:"Applicant"}}, your {{role}} application ({{application_id}}) '
      + 'is at stage {{stage}}. {{unsubscribe_url}}';
    const out = renderText(body, mergeVarsForContact(c, { unsubscribe_url: 'https://x/u' }));
    expect(out).toBe('Hi Ananya, your SWE Intern application (ERA-2026-0184) is at stage assessment. https://x/u');
  });
});
