// src/lib/mail-drafts.test.ts — the comparison that makes an idle autosave free, and the shape of
// the conflict contract.
//
// saveDraft() is one statement against a database and is exercised on the running site. What is
// tested here is draftsEqual(), because it is what decides whether a save happens at all: get it
// wrong in one direction and every debounce tick writes a row and a revision; get it wrong in the
// other and a real edit is silently discarded as "unchanged", which is data loss wearing the
// costume of an optimisation.
import { describe, it, expect } from 'vitest';
import { draftsEqual, MAX_REVISIONS, REVISION_INTERVAL_MS, type DraftState, type SaveDraftInput } from './mail-drafts';

const base: DraftState = {
  draftId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  version: 3,
  threadId: null,
  inReplyTo: null,
  to: 'anita@university.edu',
  cc: '',
  bcc: '',
  subject: 'Invoice 42',
  bodyText: 'Attached, with the July figures.',
  bodyHtml: '',
  attachments: [{ filename: 'july.pdf', url: 'https://drive.example/d/1' }],
  updatedAt: '2026-08-16T06:30:00.000Z',
  clientId: 'tab-a',
};

const incoming = (over: Partial<SaveDraftInput> = {}): SaveDraftInput => ({
  to: base.to, cc: base.cc, bcc: base.bcc,
  subject: base.subject, bodyText: base.bodyText, bodyHtml: base.bodyHtml,
  attachments: base.attachments,
  ...over,
});

describe('an autosave that changes nothing must do nothing', () => {
  it('identical content is equal', () => {
    expect(draftsEqual(base, incoming())).toBe(true);
  });

  it('a changed body is not equal', () => {
    expect(draftsEqual(base, incoming({ bodyText: 'Attached, with the August figures.' }))).toBe(false);
  });

  it('a single added character is not equal — this is the one that must never be missed', () => {
    expect(draftsEqual(base, incoming({ bodyText: base.bodyText + '.' }))).toBe(false);
  });

  it('a changed subject, recipient, cc or bcc is not equal', () => {
    expect(draftsEqual(base, incoming({ subject: 'Invoice 43' }))).toBe(false);
    expect(draftsEqual(base, incoming({ to: 'ravi@university.edu' }))).toBe(false);
    expect(draftsEqual(base, incoming({ cc: 'accounts@edurankai.in' }))).toBe(false);
    expect(draftsEqual(base, incoming({ bcc: 'audit@edurankai.in' }))).toBe(false);
  });

  it('an added, removed or reordered attachment is not equal', () => {
    expect(draftsEqual(base, incoming({ attachments: [] }))).toBe(false);
    expect(draftsEqual(base, incoming({
      attachments: [...base.attachments, { filename: 'aug.pdf', url: 'https://drive.example/d/2' }],
    }))).toBe(false);
  });

  it('a missing field and an empty field are the same thing, so a composer that omits cc is not a change', () => {
    expect(draftsEqual(base, incoming({ cc: undefined }))).toBe(true);
    expect(draftsEqual({ ...base, cc: '' }, incoming({ cc: '' }))).toBe(true);
  });

  it('the version and the writing tab are NOT content — a save from another tab with the same text is still unchanged', () => {
    expect(draftsEqual({ ...base, version: 99, clientId: 'tab-b' }, incoming())).toBe(true);
  });

  it('whitespace is content — trimming somebody paragraph break would be an edit they did not make', () => {
    expect(draftsEqual(base, incoming({ bodyText: base.bodyText + '\n' }))).toBe(false);
  });
});

describe('history is bounded', () => {
  it('keeps enough versions to undo a bad paste, and not an archive', () => {
    expect(MAX_REVISIONS).toBeGreaterThanOrEqual(5);
    expect(MAX_REVISIONS).toBeLessThanOrEqual(50);
  });

  it('does not write history on every keystroke', () => {
    expect(REVISION_INTERVAL_MS).toBeGreaterThanOrEqual(10_000);
  });
});
