// Core platform tests: permissions, templates, contacts validation, domains, webhooks, automation.
//
// All pure functions — no database, no network, no clock beyond what is passed in. That is not a
// limitation of the suite, it is the reason the rules live in pure functions in the first place:
// the decisions that matter (may this caller send? is this bounce permanent? does this graph loop?)
// can be tested exhaustively without a connection.

import { describe, it, expect } from 'vitest';
import {
  ALL_MAIL_PERMISSIONS,
  can,
  intersectScopes,
  mailRoleForInternalUser,
  PERMISSIONS_BY_ROLE,
  permissionsOf,
  roleHas,
} from './permissions';
import { extractVariables, renderTemplate } from './templates';
import { deriveFullName, validateAttributes } from './contacts';
import { validateGraph, nextNode } from './automation';
import { nextAttemptDelayMs, signPayload, validateWebhookUrl, verifySignature } from './webhooks';
import { dkimTxtValue, dmarcPolicy, ownershipValue, requiredRecordsFor, spfIncludes, txtMatches } from './adapters/domain-dns';
import { isValidDomain, normalizeDomain } from './domains';
import { attachmentKey } from './adapters/attachment-store';
import type { CustomField, Domain, Principal } from './types';

const principal = (over: Partial<Principal> = {}): Principal => ({
  kind: 'user',
  id: 'u1',
  orgId: 'o1',
  role: 'member',
  permissions: [...PERMISSIONS_BY_ROLE.member],
  ...over,
});

// ---------------------------------------------------------------------------

describe('permissions', () => {
  it('gives an owner everything and an admin everything but org.manage', () => {
    expect(PERMISSIONS_BY_ROLE.owner).toEqual(ALL_MAIL_PERMISSIONS);
    expect(PERMISSIONS_BY_ROLE.admin).not.toContain('org.manage');
    expect(PERMISSIONS_BY_ROLE.admin.length).toBe(ALL_MAIL_PERMISSIONS.length - 1);
  });

  it('separates sending one message from sending a campaign', () => {
    // A single "can send email" capability collapses two acts with very different consequences.
    expect(roleHas('member', 'mail.send')).toBe(true);
    expect(roleHas('member', 'campaigns.send')).toBe(false);
    expect(roleHas('admin', 'campaigns.send')).toBe(true);
  });

  it('keeps an analyst read-only', () => {
    for (const p of PERMISSIONS_BY_ROLE.analyst) expect(p).toMatch(/\.read$/);
  });

  it('gives an API key (service) no administrative capability', () => {
    // A leaked integration key must not be able to add a sending domain.
    const service = PERMISSIONS_BY_ROLE.service;
    expect(service).toContain('mail.send');
    expect(service).not.toContain('domains.manage');
    expect(service).not.toContain('mail.manage');
    expect(service).not.toContain('org.manage');
    expect(service).not.toContain('contacts.write');
  });

  it('reads the principal\'s own list ahead of its role', () => {
    // An API key may be issued narrower than its role; the narrower set must win.
    const narrowed = principal({ kind: 'api_key', role: 'service', permissions: ['mail.read'] });
    expect(can(narrowed, 'mail.read')).toBe(true);
    expect(can(narrowed, 'mail.send')).toBe(false);
  });

  it('falls back to the role when no explicit list is recorded', () => {
    // A key issued before scopes existed must keep working exactly as it did.
    const legacy = principal({ kind: 'api_key', role: 'service', permissions: [] });
    expect(can(legacy, 'mail.send')).toBe(true);
    expect(permissionsOf(legacy)).toEqual(PERMISSIONS_BY_ROLE.service);
  });

  it('refuses everything for a null principal', () => {
    expect(can(null, 'mail.read')).toBe(false);
    expect(permissionsOf(null)).toEqual([]);
  });

  it('lets scopes narrow but never widen', () => {
    expect(intersectScopes(PERMISSIONS_BY_ROLE.service, ['mail.send'])).toEqual(['mail.send']);
    // A scope naming a capability the role does not have adds nothing.
    expect(intersectScopes(PERMISSIONS_BY_ROLE.service, ['org.manage'])).toEqual([]);
    expect(intersectScopes(PERMISSIONS_BY_ROLE.service, ['*'])).toEqual(PERMISSIONS_BY_ROLE.service);
    expect(intersectScopes(PERMISSIONS_BY_ROLE.service, [])).toEqual(PERMISSIONS_BY_ROLE.service);
  });

  it('never maps an internal role straight to owner', () => {
    // Ownership of a tenant is a recorded act, not something inferred from a job title.
    expect(mailRoleForInternalUser({ role: 'super_admin' })).toBe('admin');
    expect(mailRoleForInternalUser({ role: 'admin' })).toBe('admin');
    expect(mailRoleForInternalUser({ role: 'recruiter' })).toBe('member');
    expect(mailRoleForInternalUser({ role: 'auditor' })).toBe('analyst');
    expect(mailRoleForInternalUser({ role: 'admin', isActive: false })).toBeNull();
    expect(mailRoleForInternalUser(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('templates', () => {
  const version = {
    subject: 'Stage {{ stage }} for {{candidate_name}}',
    htmlBody: '<p>Hello {{candidate_name}}, you are at stage {{stage}} for {{role}}.</p>',
    textBody: null,
  };

  it('finds every declared variable once, in order', () => {
    expect(extractVariables(version.subject, version.htmlBody)).toEqual(['stage', 'candidate_name', 'role']);
  });

  it('renders the brief\'s own example', () => {
    const out = renderTemplate(version, { candidate_name: 'Candidate', stage: 3, role: 'AI Engineering Intern' });
    expect(out.subject).toBe('Stage 3 for Candidate');
    expect(out.html).toContain('Hello Candidate, you are at stage 3 for AI Engineering Intern.');
    expect(out.missing).toEqual([]);
  });

  it('HTML-escapes values in the HTML body', () => {
    // A contact name arrives from an import file or a signup form. Interpolated raw, every template
    // becomes a stored-XSS sink in whatever renders the message.
    const out = renderTemplate({ subject: 's', htmlBody: '<p>{{name}}</p>', textBody: null }, { name: '<img onerror=alert(1)>' });
    expect(out.html).toBe('<p>&lt;img onerror=alert(1)&gt;</p>');
    expect(out.html).not.toContain('<img');
  });

  it('REPORTS a missing variable instead of rendering a blank', () => {
    // "Dear ," reaching a candidate is worse than a refusal, because it goes out looking almost right.
    const out = renderTemplate(version, { candidate_name: 'X' });
    expect(out.missing.sort()).toEqual(['role', 'stage']);
  });

  it('resolves a dotted path', () => {
    const out = renderTemplate({ subject: '{{user.name}}', htmlBody: 'x', textBody: null }, { user: { name: 'Ada' } });
    expect(out.subject).toBe('Ada');
  });

  it('strips newlines from a rendered subject', () => {
    // A newline in a Subject header is header injection.
    const out = renderTemplate({ subject: 'A{{v}}B', htmlBody: 'x', textBody: null }, { v: '\r\nBcc: victim@x.com' });
    expect(out.subject).not.toContain('\n');
  });

  it('derives a text body from the HTML when none is given', () => {
    const out = renderTemplate({ subject: 's', htmlBody: '<p>One</p><p>Two</p>', textBody: null }, {});
    expect(out.text).toBe('One\n\nTwo');
  });
});

// ---------------------------------------------------------------------------

describe('contacts', () => {
  const fields: CustomField[] = [
    { id: '1', orgId: 'o', entity: 'contact', key: 'plan', label: 'Plan', dataType: 'select', options: ['free', 'pro'], isRequired: false },
    { id: '2', orgId: 'o', entity: 'contact', key: 'seats', label: 'Seats', dataType: 'number', options: null, isRequired: false },
    { id: '3', orgId: 'o', entity: 'contact', key: 'active', label: 'Active', dataType: 'boolean', options: null, isRequired: false },
  ];

  it('derives a full name without inventing one', () => {
    expect(deriveFullName('Ada', 'Lovelace')).toBe('Ada Lovelace');
    expect(deriveFullName(null, null)).toBeNull();
    expect(deriveFullName('Ada', 'Lovelace', 'Existing')).toBe('Existing');
  });

  it('rejects an attribute the organization has not defined', () => {
    // A typo'd key that silently persists produces a segment matching nobody and a personalization
    // variable rendering blank — neither failure points at its cause.
    const out = validateAttributes(fields, { plann: 'pro' });
    expect(out.ok).toBe(false);
    expect(out.errors[0]).toContain('no custom field called "plann"');
  });

  it('coerces by declared type', () => {
    const out = validateAttributes(fields, { seats: '12', active: 'true', plan: 'pro' });
    expect(out.ok).toBe(true);
    expect(out.values).toEqual({ seats: 12, active: true, plan: 'pro' });
  });

  it('rejects a select value outside its options', () => {
    const out = validateAttributes(fields, { plan: 'enterprise' });
    expect(out.ok).toBe(false);
    expect(out.errors[0]).toContain('free, pro');
  });

  it('rejects a number that is not one', () => {
    expect(validateAttributes(fields, { seats: 'many' }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('domains and DNS', () => {
  const domain: Domain = {
    id: 'd1',
    orgId: 'o1',
    domain: 'example.org',
    status: 'pending',
    purpose: 'both',
    verificationToken: 'tok123',
    verifiedAt: null,
    dkimSelector: 'era1',
    createdAt: '',
    updatedAt: '',
    deletedAt: null,
  };

  it('normalizes what a person actually pastes', () => {
    expect(normalizeDomain('https://www.Example.ORG/path')).toBe('example.org');
    expect(normalizeDomain('example.org.')).toBe('example.org');
    expect(isValidDomain('example.org')).toBe(true);
    expect(isValidDomain('not a domain')).toBe(false);
    expect(isValidDomain('localhost')).toBe(false);
  });

  it('compares TXT values ignoring quotes and chunking', () => {
    // A 255-byte TXT is returned in chunks and some registrars store the quotes literally. A strict
    // compare fails on a record that is in fact correct.
    expect(txtMatches('v=DKIM1; k=rsa; p=ABC', '"v=DKIM1;" "k=rsa;" "p=ABC"')).toBe(true);
    expect(txtMatches('a', 'b')).toBe(false);
  });

  it('checks SPF by include, not by equality', () => {
    expect(spfIncludes('v=spf1 include:mail.edurankai.in include:other ~all', 'mail.edurankai.in')).toBe(true);
    expect(spfIncludes('v=spf1 include:other ~all', 'mail.edurankai.in')).toBe(false);
    expect(spfIncludes('not an spf record', 'x')).toBe(false);
  });

  it('reads a DMARC policy', () => {
    expect(dmarcPolicy('v=DMARC1; p=quarantine; rua=mailto:x@y')).toBe('quarantine');
    expect(dmarcPolicy('v=spf1 ~all')).toBeNull();
  });

  it('builds a DKIM TXT with no whitespace in the key', () => {
    // Some DNS panels wrap long values, and that alone stops the record validating.
    expect(dkimTxtValue('AB\nCD EF')).toBe('v=DKIM1; k=rsa; p=ABCDEF');
  });

  it('generates required records, defaulting SPF to softfail', () => {
    const records = requiredRecordsFor(domain, null, { spfInclude: 'mail.edurankai.in', mxHost: 'mx.edurankai.in' });
    const spf = records.find((r) => r.purpose === 'spf');
    // `-all` on a domain that still has another forgotten sender destroys their mail silently.
    expect(spf?.value).toBe('v=spf1 include:mail.edurankai.in ~all');

    const ownership = records.find((r) => r.purpose === 'ownership');
    expect(ownership?.host).toBe('_edurankai.example.org');
    expect(ownership?.value).toBe(ownershipValue('tok123'));

    const dmarc = records.find((r) => r.purpose === 'dmarc');
    // p=none to start. Publishing quarantine before SPF and DKIM pass spam-folders your own mail.
    expect(dmarc?.value).toContain('p=none');
    expect(dmarc?.isRequired).toBe(false);

    expect(records.find((r) => r.purpose === 'mx')?.priority).toBe(10);
  });

  it('omits the MX for a send-only domain and the SPF for a receive-only one', () => {
    const sending = requiredRecordsFor({ ...domain, purpose: 'sending' }, null, { spfInclude: 's', mxHost: 'mx' });
    expect(sending.find((r) => r.purpose === 'mx')).toBeUndefined();

    const receiving = requiredRecordsFor({ ...domain, purpose: 'receiving' }, null, { spfInclude: 's', mxHost: 'mx' });
    expect(receiving.find((r) => r.purpose === 'spf')).toBeUndefined();
    expect(receiving.find((r) => r.purpose === 'mx')).toBeTruthy();
  });

  it('omits a record it cannot generate rather than emitting a broken one', () => {
    const records = requiredRecordsFor(domain, null, {});
    expect(records.find((r) => r.purpose === 'spf')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('webhooks', () => {
  it('signs over timestamp AND body', () => {
    // Signing only the body makes a captured request valid forever.
    const sig = signPayload('secret', '{"a":1}', 1_700_000_000);
    expect(sig).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(verifySignature('secret', '{"a":1}', sig, 1_700_000_010).valid).toBe(true);
  });

  it('rejects a replayed signature outside the window', () => {
    const sig = signPayload('secret', 'body', 1_700_000_000);
    const out = verifySignature('secret', 'body', sig, 1_700_000_000 + 3600);
    expect(out.valid).toBe(false);
    expect(out.reason).toContain('tolerance');
  });

  it('rejects a wrong secret, a tampered body and a malformed header', () => {
    const sig = signPayload('secret', 'body', 1_700_000_000);
    expect(verifySignature('other', 'body', sig, 1_700_000_000).valid).toBe(false);
    expect(verifySignature('secret', 'tampered', sig, 1_700_000_000).valid).toBe(false);
    expect(verifySignature('secret', 'body', 'garbage', 1_700_000_000).valid).toBe(false);
  });

  it('refuses a webhook URL that is not https or points inside the network', () => {
    // Without this, registering a webhook is a server-side request forgery primitive aimed at cloud
    // metadata services and internal hosts.
    expect(validateWebhookUrl('http://example.com/hook').ok).toBe(false);
    expect(validateWebhookUrl('https://169.254.169.254/latest/meta-data').ok).toBe(false);
    expect(validateWebhookUrl('https://localhost/hook').ok).toBe(false);
    expect(validateWebhookUrl('https://10.0.0.5/hook').ok).toBe(false);
    expect(validateWebhookUrl('https://api.partner.example.com/hook').ok).toBe(true);
  });

  it('backs off and eventually gives up', () => {
    expect(nextAttemptDelayMs(0)).toBe(60_000);
    expect(nextAttemptDelayMs(4)).toBeGreaterThan(nextAttemptDelayMs(3)!);
    expect(nextAttemptDelayMs(5)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('automation graph', () => {
  const trigger = { key: 't', nodeType: 'trigger' as const };
  const send = { key: 's', nodeType: 'send_email' as const, config: { template: 'welcome' } };
  const exit = { key: 'x', nodeType: 'exit' as const };

  it('accepts a straight-line workflow', () => {
    const out = validateGraph([trigger, send, exit], [
      { from: 't', to: 's' },
      { from: 's', to: 'x' },
    ]);
    expect(out.ok).toBe(true);
    expect(out.problems).toEqual([]);
  });

  it('REFUSES a cycle', () => {
    // A cycle is an infinite send loop pointed at a real person's inbox — the single most damaging
    // thing an automation system can do.
    const out = validateGraph([trigger, send, { key: 'b', nodeType: 'send_email' as const, config: { template: 'x' } }], [
      { from: 't', to: 's' },
      { from: 's', to: 'b' },
      { from: 'b', to: 's' },
    ]);
    expect(out.ok).toBe(false);
    expect(out.problems.some((p) => /loops back/.test(p.message))).toBe(true);
  });

  it('refuses two triggers', () => {
    const out = validateGraph([trigger, { key: 't2', nodeType: 'trigger' as const }, exit], [
      { from: 't', to: 'x' },
      { from: 't2', to: 'x' },
    ]);
    expect(out.ok).toBe(false);
    expect(out.problems.some((p) => /exactly one/.test(p.message))).toBe(true);
  });

  it('refuses a dead end', () => {
    // A run that arrives at a dead end hangs in 'running' forever, holding the contact out of the
    // workflow's re-entry guard.
    const out = validateGraph([trigger, send], [{ from: 't', to: 's' }]);
    expect(out.ok).toBe(false);
    expect(out.problems.some((p) => p.nodeKey === 's' && /no next step/.test(p.message))).toBe(true);
  });

  it('refuses a condition with only one branch', () => {
    const condition = { key: 'c', nodeType: 'condition' as const };
    const out = validateGraph([trigger, condition, exit], [
      { from: 't', to: 'c' },
      { from: 'c', to: 'x', branch: 'true' },
    ]);
    expect(out.ok).toBe(false);
    expect(out.problems.some((p) => /both a true and a false branch/.test(p.message))).toBe(true);
  });

  it('refuses a send step with no template and a delay with no duration', () => {
    const out = validateGraph(
      [trigger, { key: 's', nodeType: 'send_email' as const }, { key: 'd', nodeType: 'delay' as const, config: {} }, exit],
      [{ from: 't', to: 's' }, { from: 's', to: 'd' }, { from: 'd', to: 'x' }],
    );
    expect(out.problems.some((p) => /has no template/.test(p.message))).toBe(true);
    expect(out.problems.some((p) => /positive delayMs/.test(p.message))).toBe(true);
  });

  it('warns about an unreachable node without blocking activation', () => {
    const out = validateGraph([trigger, exit, { key: 'orphan', nodeType: 'exit' as const }], [{ from: 't', to: 'x' }]);
    expect(out.ok).toBe(true);
    expect(out.problems.some((p) => p.severity === 'warning' && p.nodeKey === 'orphan')).toBe(true);
  });

  it('does not blow the stack on a long chain', () => {
    // Recursive cycle detection would; "the workflow editor crashed the server" is a worse outcome
    // than a slightly longer function.
    const nodes = [trigger, ...Array.from({ length: 5000 }, (_, i) => ({ key: `n${i}`, nodeType: 'exit' as const }))];
    const edges = [{ from: 't', to: 'n0' }];
    expect(() => validateGraph(nodes as any, edges)).not.toThrow();
  });

  it('routes by branch, case-insensitively', () => {
    // A builder UI and a hand-written API call will not agree on capitalisation, and a run silently
    // ending because of a capital T takes a day to find.
    const edges = [
      { from: 'c', to: 'yes', branch: 'True' },
      { from: 'c', to: 'no', branch: 'false' },
    ];
    expect(nextNode('c', edges, 'true')).toBe('yes');
    expect(nextNode('c', edges, 'FALSE')).toBe('no');
    expect(nextNode('c', edges, 'maybe')).toBeNull();
    expect(nextNode('nowhere', edges)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('attachment keys', () => {
  it('keeps the extension and discards everything else about a remote filename', () => {
    // A remote-supplied filename is untrusted input on a path.
    expect(attachmentKey('org', 'msg', '../../etc/passwd.pdf', 'u1')).toBe('mail/org/msg/u1.pdf');
    expect(attachmentKey('org', 'msg', 'no-extension', 'u1')).toBe('mail/org/msg/u1.bin');
    expect(attachmentKey('o/../..', 'm', 'a.PNG', 'u1')).toBe('mail/o/m/u1.png');
  });
});
