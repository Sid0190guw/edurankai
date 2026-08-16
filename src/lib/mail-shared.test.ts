// src/lib/mail-shared.test.ts — the shared mailbox, and the guarantee that a note stays internal.
//
// THE IMPORTANT SUITE IN THIS FILE IS THE LAST ONE, and it does not test a function. It reads the
// SOURCE of the send path and asserts that nothing there can reach mail_shared_notes.
//
// Why that is worth a test rather than a comment: "internal notes must not be sent to the customer"
// is a rule that survives exactly as long as everybody who edits the composer remembers it. The
// note table has no recipients column and no join to mail_messages, so the only way one could ever
// go out is if somebody wired it in — and this is the thing that fails when they do.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { SHARED_QUEUES, SHARED_STATUSES, canWriteShared, NOTES_ARE_INTERNAL } from './mail-shared';

describe('queues', () => {
  it('has the five the brief names, plus everything', () => {
    const keys = SHARED_QUEUES.map((q) => q.key);
    expect(keys).toEqual(['unassigned', 'mine', 'others', 'pending', 'resolved', 'all']);
  });

  it('every queue carries a label and a sentence, so the rail is never a bare word', () => {
    for (const q of SHARED_QUEUES) {
      expect(q.label.length).toBeGreaterThan(0);
      expect(q.hint.length).toBeGreaterThan(0);
    }
  });

  it('the statuses a conversation may hold are exactly four', () => {
    expect(SHARED_STATUSES).toEqual(['unassigned', 'open', 'pending', 'resolved']);
  });
});

describe('who may change the work', () => {
  it('owners and agents write; viewers read', () => {
    expect(canWriteShared('owner')).toBe(true);
    expect(canWriteShared('agent')).toBe(true);
    expect(canWriteShared('viewer')).toBe(false);
  });

  it('a missing role is never a write — the default is refusal', () => {
    expect(canWriteShared(null)).toBe(false);
    expect(canWriteShared(undefined as any)).toBe(false);
  });
});

describe('internal notes cannot reach an external recipient', () => {
  const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

  it('the rule has a name in the code', () => {
    expect(NOTES_ARE_INTERNAL).toBe(true);
  });

  // Every file that can put bytes on the wire. If a new one appears, add it here — that is the
  // point at which somebody is deciding what the send path may read.
  const SEND_PATHS = [
    'src/pages/api/mail/send.ts',
    'src/lib/mail-transport.ts',
    'src/pages/api/mail/scheduled-send.ts',
    'src/pages/api/mail/draft.ts',
    'src/pages/api/mail/autosave.ts',
  ];

  it('no send path reads the notes table', () => {
    for (const p of SEND_PATHS) {
      const src = read(p);
      if (!src) continue;
      expect(src, p + ' must not read mail_shared_notes').not.toContain('mail_shared_notes');
    }
  });

  it('no send path imports the shared-mailbox module at all', () => {
    for (const p of SEND_PATHS) {
      const src = read(p);
      if (!src) continue;
      expect(src, p + ' must not import mail-shared').not.toMatch(/from ['"][^'"]*mail-shared['"]/);
    }
  });

  it('the notes table itself has no way to address anybody', () => {
    // A note with no recipient column is a note that cannot be delivered, whatever anybody writes
    // later. The schema is the guarantee; this asserts the schema stays that shape.
    const src = read('src/lib/mail-shared.ts');
    const notesDdl = src.slice(src.indexOf('CREATE TABLE IF NOT EXISTS mail_shared_notes'));
    const block = notesDdl.slice(0, notesDdl.indexOf(')`'));
    expect(block).toContain('body TEXT NOT NULL');
    expect(block).not.toMatch(/\brecipient/i);
    expect(block).not.toMatch(/\bto_email/i);
    expect(block).not.toMatch(/\bmessage_id/i);
  });
});
