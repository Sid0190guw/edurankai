// src/lib/mailgov/governance.test.ts — retention, consent, deletion, export, support and search.
//
// The pure half of the governance layer, which is deliberately most of it. Everything that decides
// something — how long a thing is kept, whether an address may be sent a category of mail, what a
// deletion will remove and who must approve it, which columns may leave the platform, what a support
// engineer sees — is a function of its arguments, so it is tested here rather than observed in
// production one incident at a time.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  RETENTION_CLASSES, RETENTION_SPECS, checkpointSummary, crossClassConflicts, cutoffFor,
  defaultPolicy, resolvePolicies, sweepPlan, validatePolicy, type RetentionPolicy,
} from './retention-policy';

import {
  CATEGORY_SPECS, CONSENT_CATEGORIES, SUPPRESSION_BLOCKS, applyConsent, applyUnsubscribe,
  emailDomain, emptyConsent, maySend, normalizeEmail,
} from './consent-policy';

import {
  approvalsSatisfied, confirmationPhraseFor, deletionGate, deletionPlan, graceHours, planSummary,
  requiredApprovals, scheduledFor,
} from './deletion-plan';

import {
  DATASETS, FORBIDDEN_COLUMNS, buildManifest, contentDatasets, csvCell, datasetByKey, downloadWindowHours,
  expiresAt, isExpired, serializeRows, validateExportRequest,
} from './export-plan';

import {
  GRANT_MAX_USES, grantExpiry, grantUsable, maskEmail, retryEligible, toContentView, toMetadataView,
  validateGrantRequest, type ContentGrant,
} from './support-policy';

import { assessCampaign, assessCredentialUse, assessFailedLogins, classify, isKnownSecurityType } from './security-policy';
import { likeLiteral, parseSearch, searchable } from './search-parse';

const ORG = 'org-1';

// ---------------------------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------------------------

describe('retention policy', () => {
  it('refuses an audit retention shorter than the platform floor rather than clamping it', () => {
    const v = validatePolicy('audit_logs', 30);
    expect(v.ok).toBe(false);
    expect(String(v.error)).toContain('365');
    // Clamping silently would tell the operator they had deleted something they had not.
    expect(v.retainDays).toBeUndefined();
  });

  it('refuses an indefinite retention', () => {
    expect(validatePolicy('messages', 100000).ok).toBe(false);
  });

  it('refuses a non-integer, a missing class and an unknown action', () => {
    expect(validatePolicy('messages', 30.5).ok).toBe(false);
    expect(validatePolicy('nonsense', 30).ok).toBe(false);
    expect(validatePolicy('messages', 30, 'shred').ok).toBe(false);
  });

  it('allows redaction only where there is content to redact', () => {
    expect(validatePolicy('messages', 30, 'redact').ok).toBe(true);
    expect(validatePolicy('attachments', 30, 'redact').ok).toBe(true);
    expect(validatePolicy('audit_logs', 400, 'redact').ok).toBe(false);
  });

  it('accepts every class at its own default', () => {
    for (const c of RETENTION_CLASSES) {
      expect(validatePolicy(c, RETENTION_SPECS[c].defaultDays).ok, c).toBe(true);
    }
  });

  it('computes a cutoff from a supplied clock, never from Date.now()', () => {
    const p = defaultPolicy(ORG, 'production', 'delivery_events');
    const now = new Date('2026-08-16T00:00:00.000Z');
    const cutoff = cutoffFor(p, now);
    expect(cutoff.toISOString()).toBe('2026-02-17T00:00:00.000Z');
  });

  it('fills every class, marking which are the tenant choice and which the platform default', () => {
    const stored: RetentionPolicy[] = [{
      orgId: ORG, environment: 'production', dataClass: 'messages', retainDays: 90,
      action: 'delete', enabled: true, updatedBy: 'u1', updatedAt: '2026-08-01T00:00:00.000Z',
    }];
    const all = resolvePolicies(ORG, 'production', stored);
    expect(all.length).toBe(RETENTION_CLASSES.length);
    expect(all.find((p) => p.dataClass === 'messages')?.updatedAt).toBeTruthy();
    expect(all.find((p) => p.dataClass === 'audit_logs')?.updatedAt).toBe(null);
  });

  it('reports a consent policy shorter than the messages it authorised', () => {
    const policies = resolvePolicies(ORG, 'production', [
      { orgId: ORG, environment: 'production', dataClass: 'messages', retainDays: 1000, action: 'delete', enabled: true, updatedBy: null, updatedAt: null },
      { orgId: ORG, environment: 'production', dataClass: 'consent_records', retainDays: 400, action: 'delete', enabled: true, updatedBy: null, updatedAt: null },
    ]);
    const conflicts = crossClassConflicts(policies);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts.join(' ')).toContain('Consent records');
  });

  it('produces no sweep task for a disabled policy', () => {
    const policies = resolvePolicies(ORG, 'production', []).map((p) =>
      p.dataClass === 'messages' ? { ...p, enabled: false } : p);
    const plan = sweepPlan(policies, new Date('2026-08-16T00:00:00.000Z'));
    expect(plan.find((t) => t.dataClass === 'messages')).toBeUndefined();
    expect(plan.length).toBe(RETENTION_CLASSES.length - 1);
  });

  it('summarises a prune checkpoint so the gap in the chain is explained', () => {
    const s = checkpointSummary({
      fromSeq: 1, toSeq: 100, removed: 100, lastRemovedHash: 'a'.repeat(64),
      cutoff: '2025-08-16T00:00:00.000Z', by: null,
    });
    expect(s).toContain('100');
    expect(s).toContain('seq 1-100');
  });
});

// ---------------------------------------------------------------------------------------------
// Consent — the rule the brief singles out
// ---------------------------------------------------------------------------------------------

describe('consent', () => {
  const rec = (over: any = {}) => ({ ...emptyConsent(ORG, 'production', 'a@b.com', 'marketing'), ...over });

  it('does NOT let a marketing unsubscribe stop a transactional message', () => {
    const unsubscribedFromMarketing = rec({ category: 'marketing', status: 'unsubscribed', unsubscribedAt: '2026-01-01T00:00:00.000Z' });
    expect(maySend({ category: 'marketing', consent: unsubscribedFromMarketing }).allowed).toBe(false);
    // Same address, transactional category, no consent record of its own: still allowed.
    expect(maySend({ category: 'transactional', consent: null }).allowed).toBe(true);
  });

  it('does NOT let a transactional relationship imply marketing consent', () => {
    const d = maySend({ category: 'marketing', consent: null });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('no-consent-recorded');
  });

  it('requires an opt-in for marketing, product and recruitment, and not for transactional or system', () => {
    for (const c of CONSENT_CATEGORIES) {
      const allowed = maySend({ category: c, consent: null }).allowed;
      expect(allowed, c).toBe(!CATEGORY_SPECS[c].requiresOptIn);
    }
  });

  it('refuses a pending consent — half an opt-in is not an opt-in', () => {
    expect(maySend({ category: 'marketing', consent: rec({ status: 'pending' }) }).code).toBe('consent-pending');
  });

  it('blocks every category on a hard bounce, because the mailbox does not exist', () => {
    for (const c of CONSENT_CATEGORIES) {
      const d = maySend({ category: c, consent: rec({ category: c, status: 'subscribed' }), suppression: { reason: 'hard_bounce' } });
      expect(d.allowed, c).toBe(false);
      expect(d.fromSuppression).toBe(true);
    }
  });

  it('after a complaint, stops marketing but keeps receipts and security notices flowing', () => {
    expect(maySend({ category: 'marketing', consent: rec({ status: 'subscribed' }), suppression: { reason: 'complaint' } }).allowed).toBe(false);
    expect(maySend({ category: 'transactional', consent: null, suppression: { reason: 'complaint' } }).allowed).toBe(true);
    expect(maySend({ category: 'system', consent: null, suppression: { reason: 'complaint' } }).allowed).toBe(true);
  });

  it('treats an unknown suppression reason as blocking everything', () => {
    expect(SUPPRESSION_BLOCKS['not-a-real-reason']).toBeUndefined();
    expect(maySend({ category: 'transactional', consent: null, suppression: { reason: 'not-a-real-reason' } }).allowed).toBe(false);
  });

  it('refuses an unknown category rather than guessing', () => {
    expect(maySend({ category: 'newsletterish', consent: null }).code).toBe('unknown-category');
  });

  it('permits a system message even where an unsubscribe record somehow exists, and says why', () => {
    const d = maySend({ category: 'system', consent: rec({ category: 'system', status: 'unsubscribed' }) });
    expect(d.allowed).toBe(true);
    expect(d.reason).toContain('cannot be unsubscribed');
  });

  it('refuses to unsubscribe from a category that cannot be switched off', () => {
    const r = applyUnsubscribe(emptyConsent(ORG, 'production', 'a@b.com', 'system'), '2026-08-16T00:00:00.000Z', 'form');
    expect(r.ok).toBe(false);
  });

  it('keeps the earlier unsubscribe date after re-consent', () => {
    const withdrawn = applyUnsubscribe(emptyConsent(ORG, 'production', 'a@b.com', 'marketing'), '2026-01-01T00:00:00.000Z', 'link').record!;
    const again = applyConsent(withdrawn, '2026-06-01T00:00:00.000Z', { source: 'form' });
    expect(again.status).toBe('subscribed');
    expect(again.unsubscribedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('normalises case and whitespace, and nothing else', () => {
    expect(normalizeEmail('  A.B+tag@Example.COM ')).toBe('a.b+tag@example.com');
    // Dots and plus tags are one provider's rules, not a property of addresses. Treating
    // a.b@x and ab@x as one person eventually mails somebody who never agreed.
    expect(normalizeEmail('a.b@x.com')).not.toBe(normalizeEmail('ab@x.com'));
    expect(emailDomain('a@b.co.in')).toBe('b.co.in');
    expect(emailDomain('nonsense')).toBe('');
  });
});

// ---------------------------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------------------------

describe('deletion', () => {
  const now = new Date('2026-08-16T12:00:00.000Z');

  it('derives a confirmation phrase from the target, not a generic word', () => {
    expect(confirmationPhraseFor('contact', 'Someone@Example.com')).toBe('erase someone@example.com');
    expect(confirmationPhraseFor('organization', 'abcdef12-3456')).toBe('delete organization abcdef12');
  });

  it('needs two DIFFERENT approvers for an organization, and never the requester', () => {
    expect(requiredApprovals('organization')).toBe(2);
    const sameTwice = approvalsSatisfied('organization', 'req', [
      { userId: 'a', at: '' }, { userId: 'a', at: '' },
    ]);
    expect(sameTwice.ok).toBe(false);
    const withRequester = approvalsSatisfied('organization', 'req', [
      { userId: 'req', at: '' }, { userId: 'a', at: '' },
    ]);
    expect(withRequester.ok).toBe(false);
    expect(approvalsSatisfied('organization', 'req', [{ userId: 'a', at: '' }, { userId: 'b', at: '' }]).ok).toBe(true);
  });

  it('runs a contact erasure promptly and makes an organization wait', () => {
    expect(graceHours('contact')).toBe(0);
    expect(scheduledFor('contact', now)).toBe(null);
    expect(graceHours('organization')).toBe(72);
    expect(scheduledFor('organization', now)).toBe('2026-08-19T12:00:00.000Z');
  });

  it('keeps the audit log and the suppression entry out of a contact erasure', () => {
    const plan = deletionPlan({ scope: 'contact', target: 'a@b.com' });
    expect(plan.steps.find((s) => s.table === 'mailapi_audit_events')).toBeUndefined();
    expect(plan.steps.find((s) => s.table === 'mailapi_suppressions')).toBeUndefined();
    expect(plan.retained.join(' ')).toContain('suppression');
  });

  it('does not reach into the internal mailbox store on a tenant erasure', () => {
    const plan = deletionPlan({ scope: 'contact', target: 'a@b.com' });
    for (const step of plan.steps) {
      expect(step.table.startsWith('mailapi_'), step.table + ' is not a tenant table').toBe(true);
    }
  });

  it('says out loud that removing the suppression entry re-enables mail', () => {
    const plan = deletionPlan({ scope: 'contact', target: 'a@b.com', alsoRemoveSuppression: true });
    const step = plan.steps.find((s) => s.table === 'mailapi_suppressions');
    expect(step).toBeTruthy();
    expect(String(step?.describes)).toContain('POSSIBLE AGAIN');
  });

  it('keeps the audit log when an entire organization is deleted', () => {
    const plan = deletionPlan({ scope: 'organization', target: 'org-1' });
    expect(plan.steps.find((s) => s.table === 'mailapi_audit_events')).toBeUndefined();
    expect(plan.retained.join(' ')).toContain('audit log');
    expect(plan.steps[plan.steps.length - 1].table).toBe('mailapi_orgs');
  });

  it('blocks on a legal hold before anything else is even considered', () => {
    const g = deletionGate({
      scope: 'contact', target: 'a@b.com', requestedBy: 'req',
      typedPhrase: 'wrong phrase entirely', approvals: [], scheduledFor: null, now, activeHolds: 1,
    });
    expect(g.ok).toBe(false);
    expect(g.code).toBe('legal-hold');
  });

  it('refuses a mistyped confirmation', () => {
    const g = deletionGate({
      scope: 'contact', target: 'a@b.com', requestedBy: 'req',
      typedPhrase: 'erase a@b.co', approvals: [], scheduledFor: null, now, activeHolds: 0,
    });
    expect(g.ok).toBe(false);
    expect(g.code).toBe('confirmation-mismatch');
  });

  it('refuses while the grace window is still running', () => {
    const g = deletionGate({
      scope: 'organization', target: 'org-1', requestedBy: 'req',
      typedPhrase: confirmationPhraseFor('organization', 'org-1'),
      approvals: [{ userId: 'a', at: '' }, { userId: 'b', at: '' }],
      scheduledFor: '2026-08-19T12:00:00.000Z', now, activeHolds: 0, orgSuspended: true,
    });
    expect(g.ok).toBe(false);
    expect(g.code).toBe('grace-not-elapsed');
  });

  it('refuses to delete a live organization that has not been suspended first', () => {
    const g = deletionGate({
      scope: 'organization', target: 'org-1', requestedBy: 'req',
      typedPhrase: confirmationPhraseFor('organization', 'org-1'),
      approvals: [{ userId: 'a', at: '' }, { userId: 'b', at: '' }],
      scheduledFor: null, now, activeHolds: 0, orgSuspended: false,
    });
    expect(g.ok).toBe(false);
    expect(g.code).toBe('org-not-suspended');
  });

  it('passes when everything is satisfied', () => {
    const g = deletionGate({
      scope: 'organization', target: 'org-1', requestedBy: 'req',
      typedPhrase: confirmationPhraseFor('organization', 'org-1'),
      approvals: [{ userId: 'a', at: '' }, { userId: 'b', at: '' }],
      scheduledFor: '2026-08-16T11:00:00.000Z', now, activeHolds: 0, orgSuspended: true,
    });
    expect(g.ok).toBe(true);
  });

  it('summarises what a plan will do, for the audit record', () => {
    expect(planSummary(deletionPlan({ scope: 'organization', target: 'org-1' }))).toContain('cleared');
  });
});

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

describe('export', () => {
  it('never projects a secret-bearing column in any dataset', () => {
    for (const d of DATASETS) {
      for (const c of d.columns) {
        expect(FORBIDDEN_COLUMNS.includes(c), d.key + ' must not export ' + c).toBe(false);
      }
    }
  });

  it('scopes every dataset to a tenant, directly or through a named parent', () => {
    for (const d of DATASETS) {
      const scoped = d.orgColumn !== null || d.table === 'mailapi_template_versions';
      expect(scoped, d.key + ' has no tenant scope').toBe(true);
    }
  });

  it('refuses a content export without an explicit acknowledgement', () => {
    const v = validateExportRequest({ datasets: ['messages_content'], format: 'jsonl' });
    expect(v.ok).toBe(false);
    expect(String(v.error)).toContain('message bodies');
    expect(validateExportRequest({ datasets: ['messages_content'], format: 'jsonl', acknowledgedContent: true }).ok).toBe(true);
  });

  it('accepts a metadata export with no acknowledgement', () => {
    const v = validateExportRequest({ datasets: ['messages_metadata', 'delivery_events'], format: 'csv' });
    expect(v.ok).toBe(true);
    expect(v.includesContent).toBe(false);
  });

  it('refuses an unknown dataset, an empty selection and an unknown format', () => {
    expect(validateExportRequest({ datasets: ['nope'], format: 'csv' }).ok).toBe(false);
    expect(validateExportRequest({ datasets: [], format: 'csv' }).ok).toBe(false);
    expect(validateExportRequest({ datasets: ['templates'], format: 'xlsx' }).ok).toBe(false);
  });

  it('gives a content export a shorter download window', () => {
    expect(downloadWindowHours(true)).toBeLessThan(downloadWindowHours(false));
    const at = new Date('2026-08-16T00:00:00.000Z');
    expect(expiresAt(at, true)).toBe('2026-08-16T12:00:00.000Z');
    expect(isExpired('2026-08-16T12:00:00.000Z', new Date('2026-08-16T12:00:01.000Z'))).toBe(true);
    expect(isExpired(null, at)).toBe(true);
  });

  it('neutralises a CSV formula injection', () => {
    // An exported contact name beginning with = becomes code that runs on the machine of whoever
    // opens the file. Prefixing with a quote is what stops that.
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+44 1234')).toBe("'+44 1234");
    expect(csvCell('-5')).toBe("'-5");
    expect(csvCell('@here')).toBe("'@here");
  });

  it('quotes commas, quotes and newlines the RFC way', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('writes a null as an empty CSV field rather than the four letters', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell('null')).toBe('null');
  });

  it('serialises CSV and JSONL to the same projection', () => {
    const cols = ['id', 'email'];
    const rows = [{ id: '1', email: 'a@b.com', secret: 'nope' }];
    const csv = serializeRows('csv', cols, rows);
    expect(csv).toBe('id,email\n1,a@b.com\n');
    expect(csv).not.toContain('nope');
    const jsonl = serializeRows('jsonl', cols, rows);
    expect(JSON.parse(jsonl.trim())).toEqual({ id: '1', email: 'a@b.com' });
  });

  it('names an unavailable dataset in the manifest instead of shipping an empty file', () => {
    const m = buildManifest({
      exportId: 'e1', orgId: ORG, organization: 'Acme', requestedBy: 'u1',
      requestedAt: '2026-08-16T00:00:00.000Z', finishedAt: '2026-08-16T00:01:00.000Z',
      format: 'jsonl', expiresAt: '2026-08-18T00:00:00.000Z',
      results: [{ dataset: 'campaigns', rows: 0, note: 'No mailapi_campaigns table exists on this deployment.' }],
    });
    expect(m.files[0].note).toContain('No mailapi_campaigns table');
    expect(m.notes.join(' ')).toContain('not the same thing');
  });

  it('knows which datasets carry correspondence', () => {
    expect(contentDatasets(['messages_metadata', 'messages_content'])).toEqual(['messages_content']);
    expect(datasetByKey('messages_content')?.content).toBe(true);
    expect(datasetByKey('nope')).toBe(null);
  });
});

// ---------------------------------------------------------------------------------------------
// Support access
// ---------------------------------------------------------------------------------------------

describe('support access', () => {
  const now = new Date('2026-08-16T12:00:00.000Z');
  const grant = (over: Partial<ContentGrant> = {}): ContentGrant => ({
    id: 'g1', orgId: ORG, subjectType: 'message', subjectId: 'm1', requestedBy: 'support-1',
    reason: 'x'.repeat(40), matterRef: 'TICKET-1', status: 'approved', approvedBy: 'owner-1',
    approvedAt: '2026-08-16T11:00:00.000Z', expiresAt: '2026-08-16T15:00:00.000Z',
    uses: 0, maxUses: GRANT_MAX_USES, createdAt: '2026-08-16T10:00:00.000Z', ...over,
  });

  it('masks the local part and keeps the domain', () => {
    expect(maskEmail('siddharth@edurankai.in')).toBe('s********@edurankai.in');
    expect(maskEmail('a@b.com')).toBe('*@b.com');
    expect(maskEmail('')).toBe('');
    expect(maskEmail('not-an-address')).toBe('***');
  });

  it('withholds the subject and body from the metadata view', () => {
    const view = toMetadataView({
      id: 'm1', org_id: ORG, environment: 'production', status: 'failed',
      from_email: 'noreply@edurankai.in', to_emails: ['someone@example.com'],
      subject: 'SHOULD NOT APPEAR', body_html: '<p>SHOULD NOT APPEAR</p>',
      attempts: 2, last_error: '451 temporary failure', created_at: '2026-08-16T10:00:00.000Z',
      has_content: true,
    });
    expect(view.subjectWithheld).toBe(true);
    expect(JSON.stringify(view)).not.toContain('SHOULD NOT APPEAR');
    expect(view.to).toEqual(['s******@example.com']);
    expect(view.recipientDomains).toEqual(['example.com']);
    expect(view.contentAvailable).toBe(true);
  });

  it('reveals content only through the grant-bearing view', () => {
    const row = { id: 'm1', org_id: ORG, subject: 'Your receipt', body_text: 'thanks', to_emails: ['someone@example.com'], has_content: true };
    const view = toContentView(row, grant());
    expect(view.subject).toBe('Your receipt');
    expect(view.bodyText).toBe('thanks');
    expect(view.to).toEqual(['someone@example.com']);
    expect(view.grantId).toBe('g1');
  });

  it('refuses a short or missing justification', () => {
    expect(validateGrantRequest({ subjectType: 'message', subjectId: 'm1', reason: 'investigating' }).ok).toBe(false);
    expect(validateGrantRequest({ subjectType: 'message', subjectId: '', reason: 'x'.repeat(40) }).ok).toBe(false);
    expect(validateGrantRequest({ subjectType: 'everything', subjectId: 'm1', reason: 'x'.repeat(40) }).ok).toBe(false);
    expect(validateGrantRequest({ subjectType: 'message', subjectId: 'm1', reason: 'x'.repeat(40) }).ok).toBe(true);
  });

  it('refuses an unapproved, expired, exhausted, revoked or mismatched grant', () => {
    const want = { orgId: ORG, subjectType: 'message' as const, subjectId: 'm1' };
    expect(grantUsable(null, want, now).code).toBe('not-approved');
    expect(grantUsable(grant({ status: 'requested' }), want, now).code).toBe('not-approved');
    expect(grantUsable(grant({ status: 'revoked' }), want, now).code).toBe('revoked');
    expect(grantUsable(grant({ expiresAt: '2026-08-16T11:59:00.000Z' }), want, now).code).toBe('expired');
    expect(grantUsable(grant({ uses: GRANT_MAX_USES }), want, now).code).toBe('exhausted');
    expect(grantUsable(grant({ subjectId: 'm2' }), want, now).code).toBe('wrong-subject');
    expect(grantUsable(grant({ orgId: 'other-org' }), want, now).code).toBe('wrong-subject');
    expect(grantUsable(grant(), want, now).usable).toBe(true);
  });

  it('expires a grant a few hours out, not a few days', () => {
    expect(grantExpiry(new Date('2026-08-16T12:00:00.000Z'))).toBe('2026-08-16T16:00:00.000Z');
  });

  it('never retries a suppressed message', () => {
    const r = retryEligible({ status: 'suppressed', attempts: 0, max_attempts: 5 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('suppression list');
  });

  it('never retries a delivered message, and refuses one that is out of attempts', () => {
    expect(retryEligible({ status: 'delivered', attempts: 1, max_attempts: 5 }).ok).toBe(false);
    expect(retryEligible({ status: 'failed', attempts: 5, max_attempts: 5 }).ok).toBe(false);
    expect(retryEligible({ status: 'failed', attempts: 2, max_attempts: 5 }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Security signals — advisory, always
// ---------------------------------------------------------------------------------------------

describe('security signals', () => {
  it('never returns anything a caller could treat as an instruction to act', () => {
    const findings = [
      assessFailedLogins({ failures: 50, windowMinutes: 5, distinctAccounts: 20 }),
      assessCampaign({ recipients: 100000, complaintRate: 0.02, bounceRate: 0.2, newDomainAgeDays: 1, firstCampaignForOrg: true }),
      assessCredentialUse({ keyLabel: 'k', knownIps: ['1.1.1.1'], currentIp: '2.2.2.2', daysActive: 90 }),
    ];
    for (const f of findings) {
      expect(f.advisoryOnly).toBe(true);
      expect(f.recommendation.length).toBeGreaterThan(10);
      expect(Object.keys(f)).not.toContain('action');
      expect(Object.keys(f)).not.toContain('suspend');
    }
  });

  it('does not flag ordinary noise', () => {
    expect(assessFailedLogins({ failures: 3, windowMinutes: 10, distinctAccounts: 1 }).flag).toBe(false);
    expect(assessCampaign({ recipients: 500, complaintRate: 0.0001, bounceRate: 0.01, newDomainAgeDays: 400, firstCampaignForOrg: false }).flag).toBe(false);
    expect(assessCredentialUse({ keyLabel: 'k', knownIps: ['1.1.1.1'], currentIp: '1.1.1.1', daysActive: 30 }).flag).toBe(false);
  });

  it('treats spread-out failures as more serious than concentrated ones', () => {
    const spread = assessFailedLogins({ failures: 40, windowMinutes: 5, distinctAccounts: 30 });
    const focused = assessFailedLogins({ failures: 40, windowMinutes: 5, distinctAccounts: 1 });
    expect(spread.severity).toBe('critical');
    expect(focused.severity).toBe('high');
  });

  it('records an unrecognised event type rather than dropping the signal', () => {
    expect(isKnownSecurityType('auth.login_failed')).toBe(true);
    expect(isKnownSecurityType('something.new')).toBe(false);
    const spec = classify('something.new');
    expect(spec.type).toBe('something.new');
    expect(spec.recommendation).toContain('security-policy.ts');
  });
});

// ---------------------------------------------------------------------------------------------
// Admin search
// ---------------------------------------------------------------------------------------------

describe('admin search', () => {
  it('reads an angle-bracketed value as a message id, not an address', () => {
    const q = parseSearch('<abc123@edurankai.in>');
    expect(q.kind).toBe('rfc_message_id');
    expect(q.value).toBe('abc123@edurankai.in');
    expect(q.targets).toContain('messages');
  });

  it('reads the same characters without brackets as an address', () => {
    expect(parseSearch('abc123@edurankai.in').kind).toBe('email');
  });

  it('recognises UUIDs, domains, key prefixes and addresses', () => {
    expect(parseSearch('11111111-1111-4111-8111-111111111111').kind).toBe('uuid');
    expect(parseSearch('edurankai.in').kind).toBe('domain');
    expect(parseSearch('erm_live_abc123').kind).toBe('api_key_prefix');
    expect(parseSearch('203.0.113.7').kind).toBe('ip');
  });

  it('never searches message bodies or subjects', () => {
    for (const term of ['hello there', 'invoice', 'password']) {
      const q = parseSearch(term);
      expect(q.explain.toLowerCase()).toContain('name');
      expect(q.targets).not.toContain('message_events');
    }
  });

  it('refuses a search too short to be anything but a table scan', () => {
    expect(searchable(parseSearch('ab')).ok).toBe(false);
    expect(searchable(parseSearch('')).ok).toBe(false);
    // An exact identifier is fine at any length.
    expect(searchable(parseSearch('a@b.co')).ok).toBe(true);
  });

  it('escapes LIKE wildcards so a stray % cannot match every row', () => {
    expect(likeLiteral('100%')).toBe('100\\%');
    expect(likeLiteral('a_b')).toBe('a\\_b');
    expect(likeLiteral('back\\slash')).toBe('back\\\\slash');
  });
});

// ---------------------------------------------------------------------------------------------
// Plan and executor agreement
//
// The confirmation screen prints the PLAN; ./deletion.ts performs the work with statements written out
// by hand per scope. Those are two descriptions of the same act, and nothing but this test stops them
// drifting — a plan that promises to remove label assignments while the executor never touches them
// is a screen that lies to the person approving it. (It found exactly that: mail_message_labels was
// in the plan and missing from the executor.)
//
// Structural rather than behavioural, deliberately: executing a deletion plan needs a database, and a
// test that needs production to prove a deletion is a test nobody will run.
// ---------------------------------------------------------------------------------------------

describe('every table a deletion plan promises is named in the executor', () => {
  const source = readFileSync(fileURLToPath(new URL('./deletion.ts', import.meta.url)), 'utf8');

  for (const scope of ['contact', 'mailbox', 'organization'] as const) {
    it(scope + ' plan', () => {
      const plan = deletionPlan({ scope, target: scope === 'contact' ? 'a@b.com' : 'org-1' });
      for (const step of plan.steps) {
        expect(source.includes(step.table), scope + ' plan names ' + step.table + ', executor does not').toBe(true);
      }
    });
  }

  it('names no table the plans do not mention, beyond the ones deliberately kept', () => {
    const planned = new Set(
      (['contact', 'mailbox', 'organization'] as const)
        .flatMap((scope) => deletionPlan({ scope, target: 'x' }).steps.map((s) => s.table)),
    );
    // Tables the executor touches for bookkeeping rather than as a deletion target.
    const bookkeeping = new Set(['mailapi_deletion_jobs', 'mailapi_orgs', 'mailapi_messages']);
    const mentioned = Array.from(new Set(source.match(/mail(?:api)?_[a-z_]+/g) || []));
    const unexpected = mentioned.filter((t) => !planned.has(t) && !bookkeeping.has(t) && !t.startsWith('mailgov'));
    expect(unexpected, 'executor touches tables no plan describes: ' + unexpected.join(', ')).toEqual([]);
  });
});
