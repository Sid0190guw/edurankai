// src/lib/mailplatform/domains/mailbox.test.ts — mailboxes, aliases, loops, and org isolation.
// Run: npx vitest run src/lib/mailplatform/domains/mailbox.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  expand, wouldCreateLoop, validateAlias, withAlias, withForwarding, normalizeAddress, addressDomain,
  type DeliveryGraph,
} from './aliases';
import {
  validateMailboxAddress, canTransition, MAILBOX_TRANSITIONS, STATUS_EFFECT, parseQuota, formatBytes,
  quotaState, shouldAutoReply, autoReplyHeaders, applySignature, ROLE_ADDRESSES,
} from './mailbox-rules';
import { PERMISSIONS_BY_ROLE, can, roleHas } from '../permissions';
import type { Principal } from '../types';

const ORG = 'org-1';

function graph(): DeliveryGraph {
  return {
    mailboxes: [
      { address: 'asha@edurankai.in', status: 'active' },
      { address: 'ravi@edurankai.in', status: 'active' },
      { address: 'old@edurankai.in', status: 'disabled' },
    ],
    aliases: [],
  };
}

describe('address validation', () => {
  it('accepts ordinary addresses and normalizes case', () => {
    const v = validateMailboxAddress('Talent@EduRankAI.in');
    expect(v.ok).toBe(true);
    expect(v.normalized).toBe('talent@edurankai.in');
  });

  it('refuses malformed addresses', () => {
    expect(validateMailboxAddress('not-an-address').ok).toBe(false);
    expect(validateMailboxAddress('@edurankai.in').ok).toBe(false);
    expect(validateMailboxAddress('a@').ok).toBe(false);
    expect(validateMailboxAddress('a b@edurankai.in').ok).toBe(false);
    expect(validateMailboxAddress('.lead@edurankai.in').ok).toBe(false);
    expect(validateMailboxAddress('a'.repeat(65) + '@edurankai.in').ok).toBe(false);
  });

  it('UNAUTHORIZED DOMAIN: an address on a domain the org has not verified is refused', () => {
    const v = validateMailboxAddress('someone@not-ours.com', { allowedDomains: ['edurankai.in'] });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('verified domains');
  });

  it('flags role addresses and no-reply, without blocking them', () => {
    for (const role of ROLE_ADDRESSES) {
      const v = validateMailboxAddress(role + '@edurankai.in');
      expect(v.ok).toBe(true);
      expect(v.warnings.join(' ')).toContain('role address');
    }
    expect(validateMailboxAddress('no-reply@edurankai.in').warnings.join(' ')).toContain('discards replies');
  });
});

describe('mailbox lifecycle', () => {
  it('allows the transitions the brief names', () => {
    expect(canTransition('active', 'disabled').ok).toBe(true);
    expect(canTransition('active', 'suspended').ok).toBe(true);
    expect(canTransition('suspended', 'active').ok).toBe(true);
    expect(canTransition('disabled', 'deleted').ok).toBe(true);
  });

  it('makes deletion terminal from this surface', () => {
    expect(MAILBOX_TRANSITIONS.deleted).toEqual([]);
    const v = canTransition('deleted', 'active');
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('separate administrative action');
  });

  it('refuses a no-op transition rather than pretending something happened', () => {
    expect(canTransition('active', 'active').ok).toBe(false);
  });

  it('states the DIFFERENCE between disabled and suspended, which is what admins get wrong', () => {
    // Disabled keeps accepting mail; suspended bounces it. Choosing the wrong one loses mail.
    expect(STATUS_EFFECT.disabled).toContain('still accepted');
    expect(STATUS_EFFECT.suspended).toContain('REJECTED');
    expect(STATUS_EFFECT.deleted).toContain('stays reserved');
  });
});

describe('quotas', () => {
  it('parses the forms people type', () => {
    expect(parseQuota('5GB')).toBe(5 * 1024 ** 3);
    expect(parseQuota('500 MB')).toBe(500 * 1024 ** 2);
    expect(parseQuota('1024')).toBe(1024);
    expect(parseQuota('')).toBeNull();
    expect(parseQuota('unlimited')).toBeNull();
    expect(() => parseQuota('big')).toThrow();
    expect(() => parseQuota('5 parsecs')).toThrow();
  });

  it('formats sizes back', () => {
    expect(formatBytes(null)).toBe('Unlimited');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5 GB');
  });

  it('says what happens at each level, including that delivery stops', () => {
    expect(quotaState(0, null).level).toBe('unlimited');
    expect(quotaState(50, 100).level).toBe('ok');
    expect(quotaState(80, 100).level).toBe('warn');
    expect(quotaState(95, 100).level).toBe('critical');
    const full = quotaState(100, 100);
    expect(full.level).toBe('full');
    expect(full.message).toContain('rejected');
  });
});

describe('alias expansion', () => {
  it('routes to one or more mailboxes', () => {
    const g = withAlias(graph(), { source: 'support@edurankai.in', targets: ['asha@edurankai.in', 'ravi@edurankai.in'], isActive: true });
    const out = expand('support@edurankai.in', g);
    expect(out.mailboxes.sort()).toEqual(['asha@edurankai.in', 'ravi@edurankai.in']);
    expect(out.loops).toEqual([]);
  });

  it('follows a chain of aliases', () => {
    let g = withAlias(graph(), { source: 'hello@edurankai.in', targets: ['info@edurankai.in'], isActive: true });
    g = withAlias(g, { source: 'info@edurankai.in', targets: ['asha@edurankai.in'], isActive: true });
    expect(expand('hello@edurankai.in', g).mailboxes).toEqual(['asha@edurankai.in']);
  });

  it('a DIAMOND is not a loop', () => {
    // Two aliases pointing at the same mailbox is normal and must expand once, not be refused.
    let g = withAlias(graph(), { source: 'a@edurankai.in', targets: ['c@edurankai.in', 'd@edurankai.in'], isActive: true });
    g = withAlias(g, { source: 'c@edurankai.in', targets: ['asha@edurankai.in'], isActive: true });
    g = withAlias(g, { source: 'd@edurankai.in', targets: ['asha@edurankai.in'], isActive: true });
    const out = expand('a@edurankai.in', g);
    expect(out.loops).toEqual([]);
    expect(out.mailboxes).toEqual(['asha@edurankai.in']);
  });

  it('a DISABLED MAILBOX is reported as undeliverable rather than silently dropped', () => {
    const g = withAlias(graph(), { source: 'team@edurankai.in', targets: ['asha@edurankai.in', 'old@edurankai.in'], isActive: true });
    const out = expand('team@edurankai.in', g);
    expect(out.mailboxes).toEqual(['asha@edurankai.in']);
    expect(out.undeliverable).toEqual([{ address: 'old@edurankai.in', reason: 'the mailbox is disabled' }]);
  });

  it('an inactive alias is not followed', () => {
    const g = withAlias(graph(), { source: 'off@edurankai.in', targets: ['asha@edurankai.in'], isActive: false });
    expect(expand('off@edurankai.in', g).mailboxes).toEqual([]);
  });

  it('mailbox forwarding is part of the same graph', () => {
    const g = withForwarding(graph(), 'asha@edurankai.in', ['ravi@edurankai.in'], true);
    const out = expand('asha@edurankai.in', g);
    expect(out.mailboxes.sort()).toEqual(['asha@edurankai.in', 'ravi@edurankai.in']);

    const noCopy = withForwarding(graph(), 'asha@edurankai.in', ['ravi@edurankai.in'], false);
    expect(expand('asha@edurankai.in', noCopy).mailboxes).toEqual(['ravi@edurankai.in']);
  });

  it('an external destination is separated from local mailboxes', () => {
    const g = withForwarding(graph(), 'asha@edurankai.in', ['personal@elsewhere.example'], true);
    const out = expand('asha@edurankai.in', g);
    expect(out.external).toEqual(['personal@elsewhere.example']);
  });

  it('stops at the fan-out ceiling and says it was truncated', () => {
    const targets = Array.from({ length: 30 }, (_, i) => 'user' + i + '@elsewhere.example');
    const g = withAlias({ ...graph(), maxTargets: 5 }, { source: 'big@edurankai.in', targets, isActive: true });
    const out = expand('big@edurankai.in', g);
    expect(out.truncated).toBe(true);
  });
});

describe('ALIAS LOOPS — the check that must never be skipped', () => {
  it('refuses an alias that points at itself', () => {
    const v = wouldCreateLoop({ source: 'a@edurankai.in', targets: ['a@edurankai.in'], isActive: true }, graph());
    expect(v.loop).toBe(true);
    expect(v.reason).toContain('points at itself');
  });

  it('refuses a two-step cycle: support -> help -> support', () => {
    const g = withAlias(graph(), { source: 'help@edurankai.in', targets: ['support@edurankai.in'], isActive: true });
    const v = wouldCreateLoop({ source: 'support@edurankai.in', targets: ['help@edurankai.in'], isActive: true }, g);
    expect(v.loop).toBe(true);
    expect(v.cycle.length).toBeGreaterThan(1);
    expect(v.reason).toContain('expanded forever');
  });

  it('refuses a longer cycle: a -> b -> c -> a', () => {
    let g = withAlias(graph(), { source: 'b@edurankai.in', targets: ['c@edurankai.in'], isActive: true });
    g = withAlias(g, { source: 'c@edurankai.in', targets: ['a@edurankai.in'], isActive: true });
    expect(wouldCreateLoop({ source: 'a@edurankai.in', targets: ['b@edurankai.in'], isActive: true }, g).loop).toBe(true);
  });

  it('catches a cycle that closes through MAILBOX FORWARDING, not just aliases', () => {
    // The same loop, expressed across two tables. Checking aliases alone misses this entirely.
    const g = withForwarding(graph(), 'asha@edurankai.in', ['team@edurankai.in'], true);
    const v = wouldCreateLoop({ source: 'team@edurankai.in', targets: ['asha@edurankai.in'], isActive: true }, g);
    expect(v.loop).toBe(true);
  });

  it('allows a legitimate alias that merely shares a destination', () => {
    const g = withAlias(graph(), { source: 'careers@edurankai.in', targets: ['asha@edurankai.in'], isActive: true });
    expect(wouldCreateLoop({ source: 'talent@edurankai.in', targets: ['asha@edurankai.in'], isActive: true }, g).loop).toBe(false);
  });
});

describe('alias validation', () => {
  const orgDomains = ['edurankai.in'];

  it('accepts an alias to authorized mailboxes', () => {
    const v = validateAlias({ source: 'support@edurankai.in', targets: ['asha@edurankai.in'], isActive: true }, graph(), { orgDomains });
    expect(v.ok).toBe(true);
  });

  it('REFUSES an alias on a domain this organization does not own', () => {
    const v = validateAlias({ source: 'support@someone-else.com', targets: ['asha@edurankai.in'], isActive: true }, graph(), { orgDomains });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('not on a domain this organization has verified');
  });

  it('REFUSES an external destination unless it is explicitly allowed', () => {
    // An alias quietly forwarding admissions mail to a personal address elsewhere is an
    // exfiltration path that looks like a typo.
    const candidate = { source: 'admissions@edurankai.in', targets: ['someone@elsewhere.example'], isActive: true };
    const refused = validateAlias(candidate, graph(), { orgDomains });
    expect(refused.ok).toBe(false);
    expect(refused.externalTargets).toEqual(['someone@elsewhere.example']);
    expect(validateAlias(candidate, graph(), { orgDomains, allowExternal: true }).ok).toBe(true);
  });

  it('requires at least one destination', () => {
    expect(validateAlias({ source: 'a@edurankai.in', targets: [], isActive: true }, graph(), { orgDomains }).ok).toBe(false);
  });

  it('warns when a destination mailbox is not accepting mail', () => {
    const v = validateAlias({ source: 'a@edurankai.in', targets: ['old@edurankai.in'], isActive: true }, graph(), { orgDomains });
    expect(v.warnings.join(' ')).toContain('disabled');
  });

  it('normalizes addresses so case is never a second identity', () => {
    expect(normalizeAddress('  Support@EduRankAI.IN ')).toBe('support@edurankai.in');
    expect(addressDomain('a@b.example')).toBe('b.example');
  });
});

describe('auto-reply suppression', () => {
  const settings = { enabled: true, subject: 'Away', body: 'Back on Monday.' };
  const ctx = { now: new Date('2026-08-16T10:00:00Z'), ownDomains: ['edurankai.in'], ownAddresses: ['asha@edurankai.in'] };
  const base = { from: 'someone@elsewhere.example', to: ['asha@edurankai.in'], headers: {}, receivedAt: ctx.now.toISOString() };

  it('replies to an ordinary message', () => {
    expect(shouldAutoReply(base, settings, ctx).send).toBe(true);
  });

  it('NEVER replies to automatic mail (RFC 3834) — the guard that stops a reply storm', () => {
    expect(shouldAutoReply({ ...base, headers: { 'Auto-Submitted': 'auto-generated' } }, settings, ctx).send).toBe(false);
    expect(shouldAutoReply({ ...base, headers: { 'X-Auto-Response-Suppress': 'All' } }, settings, ctx).send).toBe(false);
  });

  it('never replies to a mailing list', () => {
    expect(shouldAutoReply({ ...base, headers: { 'List-Id': '<list.example>' } }, settings, ctx).send).toBe(false);
    expect(shouldAutoReply({ ...base, headers: { Precedence: 'bulk' } }, settings, ctx).send).toBe(false);
  });

  it('never replies to a bounce or to a no-reply address', () => {
    expect(shouldAutoReply({ ...base, headers: { 'Return-Path': '<>' } }, settings, ctx).send).toBe(false);
    expect(shouldAutoReply({ ...base, from: 'no-reply@bank.example' }, settings, ctx).send).toBe(false);
    expect(shouldAutoReply({ ...base, from: 'MAILER-DAEMON@x.example' }, settings, ctx).send).toBe(false);
  });

  it('never replies to itself', () => {
    expect(shouldAutoReply({ ...base, from: 'asha@edurankai.in' }, settings, ctx).send).toBe(false);
  });

  it('does not reply when the mailbox is not a visible recipient (bcc or catch-all)', () => {
    const d = shouldAutoReply({ ...base, to: ['someone-else@edurankai.in'] }, settings, ctx);
    expect(d.send).toBe(false);
    expect(d.reason).toContain('catch-all');
  });

  it('honours the date window', () => {
    const windowed = { ...settings, startsAt: '2026-08-20T00:00:00Z', endsAt: '2026-08-30T00:00:00Z' };
    expect(shouldAutoReply(base, windowed, ctx).send).toBe(false);
    expect(shouldAutoReply(base, windowed, { ...ctx, now: new Date('2026-08-25T10:00:00Z') }).send).toBe(true);
    expect(shouldAutoReply(base, windowed, { ...ctx, now: new Date('2026-09-25T10:00:00Z') }).send).toBe(false);
  });

  it('replies at most once per sender per interval', () => {
    const recent = { ...ctx, alreadyRepliedAt: '2026-08-15T10:00:00Z' };
    expect(shouldAutoReply(base, settings, recent).send).toBe(false);
    const old = { ...ctx, alreadyRepliedAt: '2026-07-01T10:00:00Z' };
    expect(shouldAutoReply(base, settings, old).send).toBe(true);
  });

  it('honours internal-only and external-only scopes', () => {
    const internalOnly = { ...settings, replyToExternal: false };
    expect(shouldAutoReply(base, internalOnly, ctx).send).toBe(false);
    expect(shouldAutoReply({ ...base, from: 'ravi@edurankai.in' }, internalOnly, ctx).send).toBe(true);
  });

  it('always gives a reason, including when it sends', () => {
    expect(shouldAutoReply(base, settings, ctx).reason).toBeTruthy();
    expect(shouldAutoReply(base, { ...settings, enabled: false }, ctx).reason).toContain('switched off');
  });

  it('marks its own replies so the next system does not answer them back', () => {
    const h = autoReplyHeaders();
    expect(h['Auto-Submitted']).toBe('auto-replied');
    expect(h['X-Auto-Response-Suppress']).toBe('All');
  });
});

describe('signatures', () => {
  it('uses the standard separator so clients can trim it when quoting', () => {
    expect(applySignature('Hello', 'Asha\nEduRankAI')).toBe('Hello\n\n-- \nAsha\nEduRankAI\n');
  });
  it('leaves an empty signature alone', () => {
    expect(applySignature('Hello', '')).toBe('Hello');
    expect(applySignature('Hello', null)).toBe('Hello');
  });
});

describe('ORGANIZATION ISOLATION', () => {
  const principal = (role: Principal['role']): Principal => ({ kind: 'user', id: 'u1', orgId: ORG, role, permissions: PERMISSIONS_BY_ROLE[role] });

  it('only owner and admin may manage domains', () => {
    expect(can(principal('owner'), 'domains.manage')).toBe(true);
    expect(can(principal('admin'), 'domains.manage')).toBe(true);
    expect(can(principal('member'), 'domains.manage')).toBe(false);
    expect(can(principal('analyst'), 'domains.manage')).toBe(false);
    // A leaked API key must not be able to add a sending domain.
    expect(can(principal('service'), 'domains.manage')).toBe(false);
    expect(can(principal('service'), 'mailbox.manage')).toBe(false);
  });

  it('an analyst may look but not touch', () => {
    expect(roleHas('analyst', 'domains.read')).toBe(true);
    expect(roleHas('analyst', 'domains.manage')).toBe(false);
    expect(roleHas('analyst', 'mailbox.manage')).toBe(false);
  });

  it('no principal at all can do anything', () => {
    expect(can(null, 'domains.read')).toBe(false);
    expect(can(undefined, 'domains.manage')).toBe(false);
  });

  it('EVERY statement that writes an mp_ table carries an org_id predicate', () => {
    // A source-level invariant rather than a runtime one, because the failure it guards against —
    // one forgotten WHERE clause letting a tenant reach another tenant's rows — cannot be caught by
    // a unit test that has no database, and is exactly the kind of line that gets added in a hurry.
    const src = readFileSync(fileURLToPath(new URL('./store.ts', import.meta.url)), 'utf8');
    const statements = src.match(/sql`[\s\S]*?`/g) || [];
    expect(statements.length).toBeGreaterThan(20);

    const offenders: string[] = [];
    for (const stmt of statements) {
      const touchesMp = /\b(INSERT INTO|UPDATE|DELETE FROM|FROM)\s+mp_/i.test(stmt);
      if (!touchesMp) continue;
      const isWrite = /\b(INSERT INTO|UPDATE|DELETE FROM)\s+mp_/i.test(stmt);
      // `SELECT 1 ... LIMIT 1` existence probes are deliberately global: mailbox addresses are
      // unique across the whole platform, and that fact is not a tenant's to hide.
      const isExistenceProbe = /SELECT\s+1\s+FROM/i.test(stmt);
      if (isExistenceProbe && !isWrite) continue;
      if (!/org_id/i.test(stmt)) offenders.push(stmt.slice(0, 110).replace(/\s+/g, ' '));
    }
    expect(offenders).toEqual([]);
  });
});
