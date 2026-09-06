// The three governance routes, tested at the boundary they exist to hold.
//
// THIS FILE LIVES BESIDE THE LIBRARY, NOT BESIDE THE ROUTES. Everything under src/pages is a route
// in Astro, including a .test.ts, and astro.config.mjs traces those sources into the serverless
// bundle. A suite kept next to the handlers it tests would be deployed and served. It is the only
// reason these imports are absolute.
//
// These routes were missing entirely: seven controls on /admin/governance and
// /admin/governance/retention posted to 404s. Wiring them up creates a NEW way in — a URL anybody
// with a session can POST to directly, whether or not the page ever drew them a button. So what is
// asserted here is not "the happy path works" (the library underneath already has its own suite in
// src/lib/horizon/governance/governance.test.ts) but the things a route, and only a route, decides:
//
//   - an unauthenticated caller is sent to sign in and NOTHING is called;
//   - a caller without the key is refused, and the library is never reached;
//   - `request` and `approve` are different permissions, so the person who opens an erasure request
//     is not thereby the person who may carry it out — the whole point of a two-person workflow, and
//     enforcing it only in the page that draws the buttons enforces it not at all;
//   - a degraded permission answer refuses the WRITE rather than guessing who the caller is.
//
// The library is mocked so these assert the route's decisions, not the database's.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  governancePermissions: vi.fn(),
  setRetentionPolicy: vi.fn(),
  applyRetention: vi.fn(),
  requestErasure: vi.fn(),
  approveErasure: vi.fn(),
  rejectErasure: vi.fn(),
  executeErasure: vi.fn(),
  publishGovernancePermissions: vi.fn(),
}));

vi.mock('@/lib/horizon/governance', async () => {
  // holdsGovernancePermission is the real one: a test that mocks the predicate it is asserting
  // would pass with the check deleted.
  const real = await vi.importActual<any>('@/lib/horizon/governance/matrix');
  return {
    holdsGovernancePermission: real.holdsGovernancePermission,
    governancePermissions: mocks.governancePermissions,
    setRetentionPolicy: mocks.setRetentionPolicy,
    applyRetention: mocks.applyRetention,
    requestErasure: mocks.requestErasure,
    approveErasure: mocks.approveErasure,
    rejectErasure: mocks.rejectErasure,
    executeErasure: mocks.executeErasure,
    publishGovernancePermissions: mocks.publishGovernancePermissions,
  };
});

import { POST as retentionPost } from '@/pages/api/admin/governance/retention';
import { POST as erasurePost } from '@/pages/api/admin/governance/erasure';
import { POST as publishPost } from '@/pages/api/admin/governance/publish';

const held = (keys: string[], degraded = false) => ({ permissions: new Set(keys), degraded, role: 'admin' });

/** A form POST, the way a browser sends one from these pages. */
function form(fields: Record<string, string>): Request {
  const body = new URLSearchParams(fields);
  return new Request('https://example.test/api/admin/governance/x', { method: 'POST', body });
}

const ctx = (request: Request, user: any) =>
  ({ request, locals: { user }, redirect: (to: string) => new Response(null, { status: 302, headers: { Location: to } }) }) as any;

/** The sentence a route redirected back with, decoded from the Location it set. */
function flash(res: Response): { kind: string; text: string } {
  const loc = res.headers.get('Location') || '';
  const q = loc.split('?')[1] || '';
  const p = new URLSearchParams(q);
  if (p.has('done')) return { kind: 'done', text: p.get('done')! };
  if (p.has('error')) return { kind: 'error', text: p.get('error')! };
  return { kind: 'none', text: loc };
}

const SIGNED_IN = { id: '11111111-1111-1111-1111-111111111111', email: 'a@b.test', name: 'A' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setRetentionPolicy.mockResolvedValue({ ok: true });
  mocks.applyRetention.mockResolvedValue([]);
  mocks.requestErasure.mockResolvedValue({ ok: true, data: { blockers: [] } });
  mocks.approveErasure.mockResolvedValue({ ok: true, data: {} });
  mocks.rejectErasure.mockResolvedValue({ ok: true });
  mocks.executeErasure.mockResolvedValue({ ok: true, data: { status: 'completed', report: {} } });
  mocks.publishGovernancePermissions.mockResolvedValue({ ok: true, data: { published: ['a', 'b'], failed: [] } });
});

// -------------------------------------------------------------------------------------------
describe('signing in comes first', () => {
  it('sends an anonymous caller to the admin login and calls nothing', async () => {
    for (const handler of [retentionPost, erasurePost, publishPost]) {
      const res = await handler(ctx(form({ action: 'sweep' }), null));
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toContain('/admin/login');
    }
    expect(mocks.governancePermissions).not.toHaveBeenCalled();
    expect(mocks.applyRetention).not.toHaveBeenCalled();
  });
});

describe('retention', () => {
  it('refuses a caller without horizon.retention.manage, and never reaches the sweep', async () => {
    mocks.governancePermissions.mockResolvedValue(held(['horizon.governance.view']));
    const res = await retentionPost(ctx(form({ action: 'sweep' }), SIGNED_IN));
    expect(flash(res).kind).toBe('error');
    expect(flash(res).text).toContain('horizon.retention.manage');
    expect(mocks.applyRetention).not.toHaveBeenCalled();
  });

  it('refuses to write at all when the permission answer is degraded', async () => {
    mocks.governancePermissions.mockResolvedValue(held(['horizon.retention.manage'], true));
    const res = await retentionPost(ctx(form({ action: 'sweep' }), SIGNED_IN));
    expect(flash(res).kind).toBe('error');
    expect(mocks.applyRetention).not.toHaveBeenCalled();
  });

  it('runs the sweep FOR REAL, never as a dry run — the page already has the dry run', async () => {
    mocks.governancePermissions.mockResolvedValue(held(['horizon.retention.manage']));
    mocks.applyRetention.mockResolvedValue([{ recordClass: 'access_log', action: 'review', affected: 3, note: '' }]);
    const res = await retentionPost(ctx(form({ action: 'sweep' }), SIGNED_IN));
    expect(mocks.applyRetention).toHaveBeenCalledWith(expect.objectContaining({ id: SIGNED_IN.id }), { dryRun: false });
    // The class AND the action, so a `review` count cannot read as a deletion.
    expect(flash(res).text).toContain('access_log (review) 3');
  });

  it('reports a sweep whose classes FAILED as an error, not as a green "Sweep complete"', async () => {
    // applyRetention does not throw when a class fails. It catches per class and records
    // `{ affected: 0, note: 'FAILED: <reason>' }`, so a total failure — which is exactly what a
    // database with no hgov_* tables produces — comes back as a list of honest-looking zeroes.
    // Summarising only recordClass/action/affected printed a green tick over it.
    mocks.governancePermissions.mockResolvedValue(held(['horizon.retention.manage']));
    mocks.applyRetention.mockResolvedValue([
      { recordClass: 'access_log', action: 'review', affected: 0, note: 'FAILED: relation "hgov_retention_policy" does not exist' },
      { recordClass: 'decision_log', action: 'delete', affected: 0, note: 'FAILED: relation "hgov_decision_log" does not exist' },
    ]);
    const res = await retentionPost(ctx(form({ action: 'sweep' }), SIGNED_IN));
    expect(flash(res).kind).toBe('error');
    expect(flash(res).text).toContain('2 of 2');
    expect(flash(res).text).toContain('does not exist');
    expect(flash(res).text).not.toContain('Sweep complete');
  });

  it('still reports a PARTIAL sweep failure as an error, not as a success with a smaller number', async () => {
    mocks.governancePermissions.mockResolvedValue(held(['horizon.retention.manage']));
    mocks.applyRetention.mockResolvedValue([
      { recordClass: 'access_log', action: 'delete', affected: 12, note: 'Rows removed.' },
      { recordClass: 'decision_log', action: 'delete', affected: 0, note: 'FAILED: permission denied' },
    ]);
    const res = await retentionPost(ctx(form({ action: 'sweep' }), SIGNED_IN));
    expect(flash(res).kind).toBe('error');
    expect(flash(res).text).toContain('1 of 2');
    expect(flash(res).text).toContain('permission denied');
  });

  it('catches the shape applyRetention now produces for a "review"/"report only" class whose due-count could not be read', async () => {
    // Before this fix, a 'review' or 'report only' class's own count query failing returned a bare
    // 0, and applyRetention() printed "Held for a person to decide... 0" or "X owns this table. 0
    // rows are past the period" — never a note starting 'FAILED:', so this endpoint's own check
    // (`note.startsWith('FAILED')`) could not catch it at all. retention.ts's fix gives that failure
    // the same 'FAILED: ' prefix the owned-here delete/anonymise path already used. This exercises
    // the real endpoint against exactly that new shape, so a future change to either file's prefix
    // that breaks the other is caught here rather than in production.
    mocks.governancePermissions.mockResolvedValue(held(['horizon.retention.manage']));
    mocks.applyRetention.mockResolvedValue([
      { recordClass: 'access_log', action: 'review', affected: 0, note: 'FAILED: could not count what is due — relation "hzn_access_log" does not exist' },
    ]);
    const res = await retentionPost(ctx(form({ action: 'sweep' }), SIGNED_IN));
    expect(flash(res).kind).toBe('error');
    expect(flash(res).text).toContain('could not count what is due');
  });

  it('passes the policy fields through and refuses an end-of-period action it does not know', async () => {
    mocks.governancePermissions.mockResolvedValue(held(['horizon.retention.manage']));
    const bad = await retentionPost(ctx(form({ action: 'policy', recordClass: 'access_log', retainDays: '30', then: 'shred', basis: 'because' }), SIGNED_IN));
    expect(flash(bad).kind).toBe('error');
    expect(mocks.setRetentionPolicy).not.toHaveBeenCalled();

    await retentionPost(ctx(form({ action: 'policy', recordClass: 'access_log', retainDays: '30', then: 'review', basis: 'statutory' }), SIGNED_IN));
    expect(mocks.setRetentionPolicy).toHaveBeenCalledWith(expect.objectContaining({
      recordClass: 'access_log', retainDays: 30, action: 'review', basis: 'statutory',
    }));
  });
});

describe('erasure keeps its two permissions apart', () => {
  const REQUESTER = ['horizon.erasure.request'];
  const APPROVER = ['horizon.erasure.approve'];

  it('lets a requester open a request', async () => {
    mocks.governancePermissions.mockResolvedValue(held(REQUESTER));
    const res = await erasurePost(ctx(form({ action: 'request', kind: 'employee', subject: 'e-1', mode: 'anonymise', reason: 'a long enough reason' }), SIGNED_IN));
    expect(flash(res).kind).toBe('done');
    expect(mocks.requestErasure).toHaveBeenCalledWith(expect.objectContaining({
      subject: expect.objectContaining({ kind: 'employee', id: 'e-1', idScheme: 'hr_employee' }),
      action: 'anonymise',
    }));
  });

  it('does NOT let a requester approve, reject or carry out — that is a second person', async () => {
    mocks.governancePermissions.mockResolvedValue(held(REQUESTER));
    for (const action of ['approve', 'reject', 'execute']) {
      const res = await erasurePost(ctx(form({ action, id: 'req-1', reason: 'no' }), SIGNED_IN));
      expect(flash(res).kind, action).toBe('error');
      expect(flash(res).text, action).toContain('horizon.erasure.approve');
    }
    expect(mocks.approveErasure).not.toHaveBeenCalled();
    expect(mocks.rejectErasure).not.toHaveBeenCalled();
    expect(mocks.executeErasure).not.toHaveBeenCalled();
  });

  it('does NOT let an approver open a request', async () => {
    mocks.governancePermissions.mockResolvedValue(held(APPROVER));
    const res = await erasurePost(ctx(form({ action: 'request', kind: 'employee', subject: 'e-1', mode: 'delete', reason: 'a long enough reason' }), SIGNED_IN));
    expect(flash(res).kind).toBe('error');
    expect(mocks.requestErasure).not.toHaveBeenCalled();
  });

  it('refuses a subject kind the layer cannot anchor, rather than writing an unresolvable one', async () => {
    mocks.governancePermissions.mockResolvedValue(held(REQUESTER));
    // `intern` and `contractor` were offered by the form and mean no anchor table.
    for (const kind of ['intern', 'contractor', 'anything']) {
      const res = await erasurePost(ctx(form({ action: 'request', kind, subject: 'x', mode: 'delete', reason: 'a long enough reason' }), SIGNED_IN));
      expect(flash(res).kind, kind).toBe('error');
    }
    expect(mocks.requestErasure).not.toHaveBeenCalled();
  });

  it('maps each offered kind onto a coherent kind/scheme pair', async () => {
    mocks.governancePermissions.mockResolvedValue(held(REQUESTER));
    const expected: Record<string, [string, string]> = {
      employee: ['employee', 'hr_employee'],
      candidate: ['applicant', 'application'],
      person: ['applicant', 'tal_person'],
      user: ['applicant', 'user'],
    };
    for (const [formValue, [kind, idScheme]] of Object.entries(expected)) {
      mocks.requestErasure.mockClear();
      await erasurePost(ctx(form({ action: 'request', kind: formValue, subject: 's', mode: 'delete', reason: 'a long enough reason' }), SIGNED_IN));
      expect(mocks.requestErasure, formValue).toHaveBeenCalledWith(expect.objectContaining({
        subject: expect.objectContaining({ kind, idScheme }),
      }));
    }
  });

  it('reports a partial erasure as a failure, not as "carried out"', async () => {
    mocks.governancePermissions.mockResolvedValue(held(APPROVER));
    mocks.executeErasure.mockResolvedValue({ ok: true, data: { status: 'blocked', report: { wellness: 'refused' } } });
    const res = await erasurePost(ctx(form({ action: 'execute', id: 'req-1' }), SIGNED_IN));
    expect(flash(res).kind).toBe('error');
    expect(flash(res).text).toContain('blocked');
  });

  it('says a request is blocked when it is opened blocked', async () => {
    mocks.governancePermissions.mockResolvedValue(held(REQUESTER));
    mocks.requestErasure.mockResolvedValue({ ok: true, data: { blockers: ['an open legal matter'] } });
    const res = await erasurePost(ctx(form({ action: 'request', kind: 'employee', subject: 'e-1', mode: 'delete', reason: 'a long enough reason' }), SIGNED_IN));
    expect(flash(res).text).toContain('an open legal matter');
  });
});

describe('publishing the permission keys', () => {
  it('refuses a caller who holds nothing', async () => {
    mocks.governancePermissions.mockResolvedValue(held([]));
    const res = await publishPost(ctx(form({}), SIGNED_IN));
    expect(flash(res).kind).toBe('error');
    expect(mocks.publishGovernancePermissions).not.toHaveBeenCalled();
  });

  it('reports a PARTIAL publish as an error, not a green tick', async () => {
    mocks.governancePermissions.mockResolvedValue(held(['horizon.governance.view']));
    mocks.publishGovernancePermissions.mockResolvedValue({
      ok: true,
      data: { published: ['a'], failed: [{ key: 'b', error: 'catalogue refused it' }] },
    });
    const res = await publishPost(ctx(form({}), SIGNED_IN));
    expect(flash(res).kind).toBe('error');
    expect(flash(res).text).toContain('catalogue refused it');
  });

  it('reports the count when everything published', async () => {
    mocks.governancePermissions.mockResolvedValue(held(['*']));
    const res = await publishPost(ctx(form({}), SIGNED_IN));
    expect(flash(res).kind).toBe('done');
    expect(flash(res).text).toContain('2 permission keys');
  });
});
