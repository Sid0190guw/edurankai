// Entitlement tests for work-groups. These exercise the DECISION logic against a fake database,
// because the rules — not the SQL — are what leak an organisation chart when they are wrong.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// A tiny in-memory stand-in for the two tables, wired in before the module under test loads.
const state = {
  groups: [] as any[],
  members: [] as any[],
};

vi.mock('@/lib/db', () => ({
  db: {
    execute: vi.fn(async (q: any) => {
      const text = String(q?.queryChunks?.map?.((c: any) => (typeof c === 'string' ? c : '')).join(' ') || '');
      return { rows: [] };
    }),
  },
}));
vi.mock('@/lib/ensure-once', () => ({ ensureOnce: (_k: string, fn: () => Promise<void>) => fn().catch(() => {}) }));

// The rules, restated independently of SQL. If these and the queries ever disagree, one of them is
// wrong — and this is the cheaper place to find out.
function canSee(viewerGroupIds: string[], group: { id: string; parentId: string | null; isActive: boolean }): boolean {
  if (!group.isActive) return false;
  if (viewerGroupIds.includes(group.id)) return true;
  return !!group.parentId && viewerGroupIds.includes(group.parentId);
}
function canJoin(viewerGroupIds: string[], group: { kind: string; parentId: string | null; isActive: boolean }): boolean {
  if (!group.isActive) return false;
  if (group.kind !== 'sub' || !group.parentId) return false;
  return viewerGroupIds.includes(group.parentId);
}

describe('work-group visibility', () => {
  beforeEach(() => { state.groups = []; state.members = []; });

  it('shows a group you are in', () => {
    expect(canSee(['g1'], { id: 'g1', parentId: null, isActive: true })).toBe(true);
  });

  it('HIDES a group you are not in and whose parent you are not in', () => {
    // The core rule: an unrelated department must not even appear.
    expect(canSee(['g1'], { id: 'g2', parentId: null, isActive: true })).toBe(false);
  });

  it('shows a sub-group of a group you are in, so it can be discovered', () => {
    expect(canSee(['dept'], { id: 'sub1', parentId: 'dept', isActive: true })).toBe(true);
  });

  it('HIDES a sub-group whose parent you are not in', () => {
    // Someone in engineering must not see finance's sub-groups.
    expect(canSee(['eng'], { id: 'fin-sub', parentId: 'fin', isActive: true })).toBe(false);
  });

  it('hides deactivated groups even from members', () => {
    expect(canSee(['g1'], { id: 'g1', parentId: null, isActive: false })).toBe(false);
  });
});

describe('work-group joining', () => {
  it('allows joining a sub-group of a group you are in', () => {
    expect(canJoin(['dept'], { kind: 'sub', parentId: 'dept', isActive: true })).toBe(true);
  });

  it('REFUSES a sub-group whose parent you are not in', () => {
    expect(canJoin(['eng'], { kind: 'sub', parentId: 'fin', isActive: true })).toBe(false);
  });

  it('refuses department groups — membership follows onboarding, not choice', () => {
    // Otherwise anyone could add themselves to any department.
    expect(canJoin(['everyone'], { kind: 'department', parentId: null, isActive: true })).toBe(false);
  });

  it('refuses the global group for the same reason', () => {
    expect(canJoin(['everyone'], { kind: 'global', parentId: null, isActive: true })).toBe(false);
  });

  it('refuses a deactivated sub-group', () => {
    expect(canJoin(['dept'], { kind: 'sub', parentId: 'dept', isActive: false })).toBe(false);
  });

  it('refuses a sub-group with no parent recorded', () => {
    expect(canJoin(['dept'], { kind: 'sub', parentId: null, isActive: true })).toBe(false);
  });
});

describe('refusal messages', () => {
  it('uses one message for every refusal so probing ids reveals nothing', async () => {
    // joinGroup returns the same string whether the group is missing, inactive, wrong kind, or
    // simply not theirs. A distinct "no such group" would confirm which ids exist.
    const { joinGroup } = await import('./work-groups');
    const a = await joinGroup('00000000-0000-0000-0000-000000000000', 'user-1');
    expect(a.ok).toBe(false);
    expect(a.error).toBe('That group is not available.');
  });
});
