// src/lib/mailapi/render.test.ts — template rendering and send-request validation.
//
// The renderer is the mechanism /admin/mail/templates said did not exist, so the first thing asserted
// is the failure it was written to prevent: a template that references a variable nobody supplied
// must be REFUSED, not rendered as "Dear ,". Every other assertion here is an injection or an
// escaping case, because a mail body is attacker-adjacent input.
import { describe, it, expect } from 'vitest';
import { render, escapeHtml, extractVariables, validateTemplateSyntax, htmlToText, parse } from './render';
import { renderVersion } from './templates';
import {
  normalizeSendRequest, assertAttachments, assertHeaders, assertTags, assertMetadata,
  assertScheduledAt, assertRecipientCount, parseAddress, isEmail, toList, LIMITS,
} from './validate';

describe('variable substitution', () => {
  it('substitutes and reports nothing missing', () => {
    const r = render('Hello {{name}}', { name: 'Priya' });
    expect(r.output).toBe('Hello Priya');
    expect(r.missing).toEqual([]);
  });

  it('REPORTS a missing variable instead of rendering a blank', () => {
    const r = render('Dear {{candidate_name}}, stage {{stage}}', { stage: 3 });
    expect(r.missing).toEqual(['candidate_name']);
    // The placeholder is dropped from the output, but the send path refuses on `missing` — the
    // output is never delivered in this state.
    expect(r.output).toBe('Dear , stage 3');
  });

  it('treats an empty string as supplied, and null as missing', () => {
    expect(render('[{{a}}]', { a: '' }).missing).toEqual([]);
    expect(render('[{{a}}]', { a: null }).missing).toEqual(['a']);
    expect(render('[{{a}}]', { a: 0 }).missing).toEqual([]);
    expect(render('[{{a}}]', { a: false }).output).toBe('[false]');
  });

  it('resolves dotted paths', () => {
    expect(render('{{role.title}} in {{role.city}}', { role: { title: 'AI Engineering Intern', city: 'Bengaluru' } }).output)
      .toBe('AI Engineering Intern in Bengaluru');
    expect(render('{{role.missing}}', { role: {} }).missing).toEqual(['role.missing']);
  });

  it('escapes HTML in a body and does not escape a subject', () => {
    const html = render('<p>{{name}}</p>', { name: '<script>alert(1)</script>' }, { escape: true });
    expect(html.output).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    const subject = render('{{name}}', { name: 'Smith & Co' }, { escape: false });
    expect(subject.output).toBe('Smith & Co');
  });

  it('a triple brace is raw, and it is the only way to get raw', () => {
    expect(render('{{{block}}}', { block: '<b>bold</b>' }, { escape: true }).output).toBe('<b>bold</b>');
    expect(render('{{block}}', { block: '<b>bold</b>' }, { escape: true }).output).toBe('&lt;b&gt;bold&lt;/b&gt;');
  });

  it('escapeHtml covers every character that changes meaning in markup', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('blocks', () => {
  it('#if renders only when truthy, with an else branch', () => {
    expect(render('{{#if deadline}}by {{deadline}}{{else}}no deadline{{/if}}', { deadline: '20 Aug' }).output).toBe('by 20 Aug');
    expect(render('{{#if deadline}}by {{deadline}}{{else}}no deadline{{/if}}', {}).output).toBe('no deadline');
    expect(render('{{#if list}}yes{{else}}no{{/if}}', { list: [] }).output).toBe('no');
    expect(render('{{#if s}}yes{{else}}no{{/if}}', { s: '   ' }).output).toBe('no');
  });

  it('#unless is the inverse', () => {
    expect(render('{{#unless paid}}Payment pending{{/unless}}', { paid: false }).output).toBe('Payment pending');
    expect(render('{{#unless paid}}Payment pending{{/unless}}', { paid: true }).output).toBe('');
  });

  it('#each iterates objects and primitives, with index helpers', () => {
    expect(render('{{#each steps}}{{@number}}. {{title}}\n{{/each}}', { steps: [{ title: 'Apply' }, { title: 'Assess' }] }).output)
      .toBe('1. Apply\n2. Assess\n');
    expect(render('{{#each tags}}[{{this}}]{{/each}}', { tags: ['a', 'b'] }).output).toBe('[a][b]');
    expect(render('{{#each nope}}x{{else}}empty{{/each}}', { nope: [] }).output).toBe('empty');
  });

  it('an inner scope wins and still falls back outward', () => {
    const r = render('{{#each people}}{{name}} at {{company}}; {{/each}}', {
      company: 'EduRankAI',
      people: [{ name: 'A' }, { name: 'B', company: 'Partner' }],
    });
    expect(r.output).toBe('A at EduRankAI; B at Partner; ');
    expect(r.missing).toEqual([]);
  });

  it('nests blocks', () => {
    const out = render('{{#each rounds}}{{#if passed}}{{name}} ok. {{/if}}{{/each}}', {
      rounds: [{ name: 'R1', passed: true }, { name: 'R2', passed: false }],
    }).output;
    expect(out).toBe('R1 ok. ');
  });
});

describe('template syntax errors', () => {
  it('reports an unclosed block', () => {
    const errs = validateTemplateSyntax('{{#if x}}hello');
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('never closed');
  });

  it('reports a mismatched close and a stray close', () => {
    expect(validateTemplateSyntax('{{#if x}}a{{/each}}')[0]).toContain('closed with');
    expect(validateTemplateSyntax('a{{/if}}')[0]).toContain('no matching opening');
  });

  it('reports an unknown block instead of guessing', () => {
    expect(validateTemplateSyntax('{{#loop x}}a{{/loop}}')[0]).toContain('Unknown block');
  });

  it('a lone brace is a typo, not an error — it must not stop a password reset', () => {
    expect(validateTemplateSyntax('Cost { 100 }')).toEqual([]);
    expect(render('Cost { 100 }', {}).output).toBe('Cost { 100 }');
  });

  it('a clean template has no errors', () => {
    expect(validateTemplateSyntax('{{#each x}}{{this}}{{/each}}{{#if y}}a{{else}}b{{/if}}')).toEqual([]);
    expect(parse('plain text').nodes.length).toBe(1);
  });
});

describe('extractVariables', () => {
  it('lists what a caller has to supply', () => {
    expect(extractVariables('{{a}} {{b.c}}', '{{#if d}}{{e}}{{/if}}')).toEqual(['a', 'b.c', 'd', 'e']);
  });

  it('qualifies loop-body names instead of demanding them at the top level', () => {
    // `steps` is what a caller supplies; `title` comes from each item. Reporting a bare `title`
    // would send somebody looking for a variable that does not exist.
    expect(extractVariables('{{#each steps}}{{title}}{{/each}}')).toEqual(['steps', 'steps[].title']);
    expect(extractVariables('{{#each steps}}{{@index}}{{this}}{{/each}}')).toEqual(['steps']);
    expect(extractVariables('{{#each rounds}}{{#if passed}}{{name}}{{/if}}{{/each}}'))
      .toEqual(['rounds', 'rounds[].name', 'rounds[].passed']);
  });
});

describe('plain-text fallback', () => {
  it('keeps a link target a text-only reader would otherwise lose', () => {
    expect(htmlToText('<p>Read the <a href="https://x.test/a">brief</a>.</p>')).toBe('Read the brief (https://x.test/a).');
  });

  it('strips script and style and unescapes entities', () => {
    expect(htmlToText('<style>p{color:red}</style><script>evil()</script><p>Smith &amp; Co</p>')).toBe('Smith & Co');
  });

  it('turns list items and breaks into lines', () => {
    expect(htmlToText('<ul><li>One</li><li>Two</li></ul>')).toBe('- One\n- Two');
    expect(htmlToText('a<br/>b')).toBe('a\nb');
  });
});

describe('renderVersion', () => {
  const version = { subject: '{{role}} — stage {{stage}}', html: '<p>Hello {{name}}</p>', text: null };

  it('renders subject unescaped, body escaped, and derives the text part', () => {
    const r = renderVersion(version, { role: 'AI & ML Intern', stage: 3, name: '<b>P</b>' });
    expect(r.subject).toBe('AI & ML Intern — stage 3');
    expect(r.html).toBe('<p>Hello &lt;b&gt;P&lt;/b&gt;</p>');
    expect(r.text).toBe('Hello <b>P</b>');
    expect(r.missing).toEqual([]);
  });

  it('collects missing variables from every part', () => {
    expect(renderVersion(version, { name: 'P' }).missing).toEqual(['role', 'stage']);
  });
});

describe('recipients', () => {
  it('accepts a plain address and a display-name form', () => {
    expect(parseAddress('a@x.test', 'to')).toEqual({ email: 'a@x.test', name: null });
    expect(parseAddress('Priya S <Priya@X.test>', 'to')).toEqual({ email: 'priya@x.test', name: 'Priya S' });
  });

  it('refuses malformed addresses', () => {
    for (const bad of ['', 'nope', 'a@', '@x.test', 'a b@x.test', 'a@x', 'a@.test', 'a@x..test']) {
      expect(() => parseAddress(bad, 'to'), bad).toThrow();
    }
    expect(isEmail('a@x.test')).toBe(true);
    expect(isEmail('a'.repeat(250) + '@x.test')).toBe(false);
  });

  it('refuses a display name containing a line break (header injection)', () => {
    expect(() => parseAddress('Evil\r\nBcc: victim@x.test <a@x.test>', 'to')).toThrow(/line breaks/);
  });

  it('deduplicates and accepts a single string or an array', () => {
    expect(toList('a@x.test', 'to')).toEqual(['a@x.test']);
    expect(toList(['a@x.test', 'A@X.test', 'b@x.test'], 'to')).toEqual(['a@x.test', 'b@x.test']);
    expect(toList(null, 'to')).toEqual([]);
  });

  it('requires at least one recipient and caps the total', () => {
    expect(() => assertRecipientCount([], [], [])).toThrow(/At least one/);
    const many = Array.from({ length: LIMITS.maxRecipients + 1 }, (_, i) => 'a' + i + '@x.test');
    expect(() => assertRecipientCount(many, [], [])).toThrow(/at most/);
    expect(() => assertRecipientCount(many.slice(0, 25), many.slice(0, 25), [])).not.toThrow();
  });
});

describe('attachments are links', () => {
  it('accepts a url and derives a filename', () => {
    expect(assertAttachments([{ url: 'https://drive.test/a/Offer%20Letter.pdf' }])[0].url).toContain('drive.test');
  });

  it('REFUSES base64 content with the platform rule, rather than dropping it', () => {
    const err = (() => { try { assertAttachments([{ filename: 'a.pdf', content: 'JVBERi0=' }]); } catch (e: any) { return e; } })();
    expect(err.code).toBe('attachment_not_a_link');
    expect(err.message).toContain('shared links');
    // The same refusal for the other names a client might reach for.
    expect(() => assertAttachments([{ url: 'https://x.test/a', path: '/tmp/a.pdf' }])).toThrow();
    expect(() => assertAttachments([{ url: 'https://x.test/a', data: 'xx' }])).toThrow();
  });

  it('refuses non-http schemes and caps the count', () => {
    expect(() => assertAttachments([{ url: 'file:///etc/passwd' }])).toThrow();
    expect(() => assertAttachments([{ url: 'not a url' }])).toThrow();
    expect(() => assertAttachments(Array.from({ length: 21 }, () => ({ url: 'https://x.test/a' })))).toThrow(/At most/);
  });
});

describe('headers, tags, metadata, schedule', () => {
  it('allows X- headers and refuses the ones the platform owns', () => {
    expect(assertHeaders({ 'X-Entity-Ref-Id': 'abc' })).toEqual({ 'X-Entity-Ref-Id': 'abc' });
    expect(assertHeaders({ 'In-Reply-To': '<a@b>' })['In-Reply-To']).toBe('<a@b>');
    for (const name of ['From', 'To', 'Bcc', 'Subject', 'Content-Type', 'Return-Path', 'DKIM-Signature']) {
      expect(() => assertHeaders({ [name]: 'x' }), name).toThrow(/set by the platform/);
    }
  });

  it('refuses a header value with a line break (header injection)', () => {
    expect(() => assertHeaders({ 'X-A': 'ok\r\nBcc: victim@x.test' })).toThrow(/line breaks/);
  });

  it('bounds tags and metadata', () => {
    expect(assertTags(['stage-3', 'careers'])).toEqual(['stage-3', 'careers']);
    expect(() => assertTags(['has space'])).toThrow();
    expect(() => assertTags(Array.from({ length: 11 }, (_, i) => 't' + i))).toThrow();
    expect(assertMetadata({ application_id: 'x' })).toEqual({ application_id: 'x' });
    expect(() => assertMetadata(['a'])).toThrow();
    expect(() => assertMetadata({ big: 'x'.repeat(9000) })).toThrow(/larger than/);
  });

  it('a schedule must be in the future and inside the horizon', () => {
    const now = Date.parse('2026-08-16T10:00:00Z');
    expect(assertScheduledAt('2026-08-17T10:00:00Z', now)?.toISOString()).toBe('2026-08-17T10:00:00.000Z');
    expect(assertScheduledAt(null, now)).toBe(null);
    expect(() => assertScheduledAt('2026-08-15T10:00:00Z', now)).toThrow(/in the past/);
    expect(() => assertScheduledAt('2027-08-16T10:00:00Z', now)).toThrow(/at most/);
    expect(() => assertScheduledAt('tomorrow please', now)).toThrow(/ISO 8601/);
    // A few seconds of clock skew is not an error.
    expect(() => assertScheduledAt(new Date(now - 20_000).toISOString(), now)).not.toThrow();
  });
});

describe('normalizeSendRequest', () => {
  const base = { to: ['a@x.test'], template_id: 'internship-stage-update' };

  it('normalizes a template send', () => {
    const r = normalizeSendRequest({ ...base, variables: { stage: 3 } });
    expect(r.to).toEqual(['a@x.test']);
    expect(r.templateRef).toBe('internship-stage-update');
    expect(r.variables).toEqual({ stage: 3 });
    expect(r.options.allowDraft).toBe(false);
  });

  it('accepts template_variables as the same field, and refuses a disagreement', () => {
    expect(normalizeSendRequest({ ...base, template_variables: { stage: 1 } }).variables).toEqual({ stage: 1 });
    expect(() => normalizeSendRequest({ ...base, variables: { stage: 1 }, template_variables: { stage: 2 } })).toThrow(/two names/);
  });

  it('requires a body of some kind, and refuses both at once', () => {
    expect(() => normalizeSendRequest({ to: ['a@x.test'] })).toThrow(/template_id.*or.*inline/i);
    expect(() => normalizeSendRequest({ to: ['a@x.test'], template_id: 't', html: '<p>x</p>' })).toThrow(/not both/);
    expect(() => normalizeSendRequest({ to: ['a@x.test'], html: '<p>x</p>' })).toThrow(/needs a `subject`/);
    expect(normalizeSendRequest({ to: ['a@x.test'], html: '<p>x</p>', subject: 'Hi' }).subject).toBe('Hi');
  });

  it('takes the Idempotency-Key header over the body field', () => {
    const r = normalizeSendRequest({ ...base, idempotency_key: 'from-body' }, { idempotencyKey: 'from-header' });
    expect(r.idempotencyKey).toBe('from-header');
    expect(normalizeSendRequest({ ...base, idempotency_key: 'from-body' }).idempotencyKey).toBe('from-body');
  });

  it('refuses a subject with a line break', () => {
    expect(() => normalizeSendRequest({ to: ['a@x.test'], html: '<p>x</p>', subject: 'Hi\r\nBcc: x@y.test' })).toThrow();
  });

  it('reads the options block', () => {
    const r = normalizeSendRequest({ ...base, options: { allow_draft: true, track_opens: true, include_unsubscribe: true } });
    expect(r.options).toMatchObject({ allowDraft: true, trackOpens: true, trackClicks: false, includeUnsubscribe: true });
  });

  it('refuses a body that is not an object', () => {
    expect(() => normalizeSendRequest(null)).toThrow();
    expect(() => normalizeSendRequest([{ to: 'a@x.test' }])).toThrow();
  });
});
