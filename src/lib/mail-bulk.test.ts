// src/lib/mail-bulk.test.ts — the rules a bulk operation is refused or reported by.
//
// applyBulk() itself is one statement against a database and is exercised on the running site, not
// here. What IS tested here is everything that decides whether that statement runs at all, and the
// sentence a person is shown afterwards — because "it said it worked" and "it worked" diverging is
// the failure this whole path was written against.
import { describe, it, expect } from 'vitest';
import {
  validateBulk, describeResult, BULK_OPS, MAX_BULK_THREADS, MAX_ID_LIST, SYSTEM_FOLDERS,
  type BulkRequest,
} from './mail-bulk';

const ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const ids = (n: number) => Array.from({ length: n }, () => ID);
const req = (over: Partial<BulkRequest>): BulkRequest => ({
  op: 'archive',
  selection: { mode: 'ids', threadIds: [ID] },
  ...over,
} as BulkRequest);

describe('what is refused before anything is written', () => {
  it('an unknown operation', () => {
    expect(validateBulk(req({ op: 'incinerate' as any }))).toMatch(/not an operation/);
  });

  it('an empty selection', () => {
    expect(validateBulk(req({ selection: { mode: 'ids', threadIds: [] } }))).toMatch(/Nothing was selected/);
  });

  it('an id that is not an id — one junk value would otherwise fail the whole batch in Postgres', () => {
    expect(validateBulk(req({ selection: { mode: 'ids', threadIds: [ID, 'not-a-uuid'] } }))).toMatch(/not valid/);
  });

  it('an id list longer than the request cap, and it points at the server-side path instead', () => {
    const msg = validateBulk(req({ selection: { mode: 'ids', threadIds: ids(MAX_ID_LIST + 1) } }));
    expect(msg).toContain('select all results');
  });

  it('a move to somewhere that is not a folder', () => {
    expect(validateBulk(req({ op: 'move', folder: 'somewhere' }))).toMatch(/not a folder/);
    for (const f of SYSTEM_FOLDERS) expect(validateBulk(req({ op: 'move', folder: f }))).toBeNull();
  });

  it('a label operation with no label, or an absurd one', () => {
    expect(validateBulk(req({ op: 'label-add', label: '' }))).toMatch(/No label/);
    expect(validateBulk(req({ op: 'label-add', label: 'x'.repeat(200) }))).toMatch(/too long/);
    expect(validateBulk(req({ op: 'label-add', label: 'payroll' }))).toBeNull();
  });

  it('a snooze into the past, which would put the message straight back', () => {
    expect(validateBulk(req({ op: 'snooze', until: '2020-01-01T00:00:00Z' }))).toMatch(/future/);
    expect(validateBulk(req({ op: 'snooze', until: 'tomorrow' }))).toMatch(/not a time/);
    const soon = new Date(Date.now() + 3600_000).toISOString();
    expect(validateBulk(req({ op: 'snooze', until: soon }))).toBeNull();
  });

  it('a query selection is accepted without any ids at all — that is the whole point', () => {
    expect(validateBulk(req({ selection: { mode: 'query', query: 'from:noreply' } }))).toBeNull();
  });

  it('every operation the module advertises passes its own validation with sane arguments', () => {
    for (const op of BULK_OPS) {
      const extras: Partial<BulkRequest> = {};
      if (op === 'move') extras.folder = 'archive';
      if (op === 'label-add' || op === 'label-remove') extras.label = 'payroll';
      if (op === 'snooze') extras.until = new Date(Date.now() + 3600_000).toISOString();
      expect(validateBulk(req({ op, ...extras }))).toBeNull();
    }
  });
});

describe('what the person is told afterwards', () => {
  it('counts, and gets the singular right', () => {
    expect(describeResult('archive', 1, false)).toBe('1 conversation archived.');
    expect(describeResult('archive', 142, false)).toContain('142 conversations archived');
  });

  it('says nothing changed rather than claiming success over zero rows', () => {
    expect(describeResult('read', 0, false)).toMatch(/Nothing changed/);
  });

  it('explains a permanent delete that did nothing, because that one has a rule behind it', () => {
    expect(describeResult('delete', 0, false)).toMatch(/already in Trash/);
  });

  it('admits truncation instead of reporting a whole job done', () => {
    const msg = describeResult('archive', MAX_BULK_THREADS, true);
    expect(msg).toContain('maximum for one operation');
    expect(msg).toContain('run it again');
  });

  it('names the folder and the label it acted with', () => {
    expect(describeResult('move', 3, false, { folder: 'archive' })).toContain('archive');
    expect(describeResult('label-add', 3, false, { label: 'payroll' })).toContain('payroll');
  });

  it('has a sentence for every operation — none falls through to a blank', () => {
    for (const op of BULK_OPS) {
      const msg = describeResult(op, 2, false, { folder: 'archive', label: 'payroll' });
      expect(msg.length).toBeGreaterThan(0);
      expect(msg).not.toContain('undefined');
    }
  });
});
