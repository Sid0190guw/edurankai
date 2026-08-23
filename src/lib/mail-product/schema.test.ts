// src/lib/mail-product/schema.test.ts — the campaign state machine.
//
// The machine is a table rather than a pile of if-statements precisely so it can be asserted on. The
// interesting cases are the ones where a UI and a database could come to disagree about the same
// campaign.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canTransition, CAMPAIGN_STATUSES, CAMPAIGN_TRANSITIONS, CONTACT_STATUSES, EVENT_TYPES } from './schema';

describe('campaign state machine', () => {
  it('walks the ordinary path', () => {
    expect(canTransition('draft', 'queued')).toBe(true);
    expect(canTransition('queued', 'sending')).toBe(true);
    expect(canTransition('sending', 'completed')).toBe(true);
  });

  it('allows scheduling and unscheduling', () => {
    expect(canTransition('draft', 'scheduled')).toBe(true);
    expect(canTransition('scheduled', 'draft')).toBe(true);
    expect(canTransition('scheduled', 'queued')).toBe(true);
  });

  it('allows pause and resume', () => {
    expect(canTransition('sending', 'paused')).toBe(true);
    expect(canTransition('paused', 'queued')).toBe(true);
  });

  // The bug this test was written for: dispatchBatch() refuses before claiming a recipient when
  // there is no transport, and reports 'failed'. If the machine forbade queued -> failed, the row
  // would stay 'queued' while the response said 'failed'.
  it('lets a queued campaign fail, so a refusal to dispatch is recorded rather than only reported', () => {
    expect(canTransition('queued', 'failed')).toBe(true);
  });

  it('lets a failed campaign be queued again once the reason is fixed', () => {
    expect(canTransition('failed', 'queued')).toBe(true);
    expect(canTransition('failed', 'draft')).toBe(true);
  });

  it('treats completed and cancelled as terminal — a sent campaign cannot be un-sent', () => {
    expect(CAMPAIGN_TRANSITIONS.completed).toEqual([]);
    expect(CAMPAIGN_TRANSITIONS.cancelled).toEqual([]);
    for (const s of CAMPAIGN_STATUSES) {
      expect(canTransition('completed', s)).toBe(false);
      expect(canTransition('cancelled', s)).toBe(false);
    }
  });

  it('refuses to skip the queue — content is frozen at queue time, so draft cannot jump to sending', () => {
    expect(canTransition('draft', 'sending')).toBe(false);
    expect(canTransition('draft', 'completed')).toBe(false);
    expect(canTransition('scheduled', 'sending')).toBe(false);
  });

  it('names every state it can reach, so the table cannot point at a state that does not exist', () => {
    for (const from of CAMPAIGN_STATUSES) {
      for (const to of CAMPAIGN_TRANSITIONS[from]) {
        expect(CAMPAIGN_STATUSES).toContain(to);
      }
    }
  });

  it('covers every declared status', () => {
    for (const s of CAMPAIGN_STATUSES) {
      expect(CAMPAIGN_TRANSITIONS[s]).toBeDefined();
    }
  });

  it('has no self-transition, which would let a no-op look like progress', () => {
    for (const s of CAMPAIGN_STATUSES) {
      expect(CAMPAIGN_TRANSITIONS[s]).not.toContain(s);
    }
  });
});

describe('the mail_suppression mirror', () => {
  // audienceSql() filters campaigns against mail_suppression, so the table has to exist wherever
  // this module runs — and ensureMailProductSchema() cannot call ensureContactSchema() to guarantee
  // it, because mail-contacts.ts already imports ensureMailProductSchema() and the two ensureOnce()
  // caches would wait on each other. So the declaration is mirrored, and THIS test is what stops the
  // mirror rotting: it reads both files and compares the columns they actually declare.
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  /** The column lines of the first `CREATE TABLE … mail_suppression (…)` in a file, normalised. */
  function declaredColumns(src: string): string[] {
    const m = src.match(/CREATE TABLE IF NOT EXISTS mail_suppression\s*\(([\s\S]*?)\)`/);
    if (!m) return [];
    return m[1]
      .split('\n')
      .map((l) => l.trim().replace(/,$/, ''))
      .filter(Boolean);
  }

  const mine = declaredColumns(read('./schema.ts'));
  const theirs = declaredColumns(read('../mail-contacts.ts'));

  it('is declared in both files', () => {
    expect(mine.length).toBeGreaterThan(0);
    expect(theirs.length).toBeGreaterThan(0);
  });

  it('declares exactly the same columns as its owner in src/lib/mail-contacts.ts', () => {
    // If this fails, mail-contacts.ts changed the table and this mirror was not updated with it.
    // Fix the mirror in schema.ts — do not weaken this test.
    expect(mine).toEqual(theirs);
  });

  it('still keys on email, which is what audienceSql() joins against', () => {
    expect(mine[0]).toMatch(/^email text PRIMARY KEY$/);
  });
});

describe('vocabularies', () => {
  it('keeps suppression states distinct from subscribed ones', () => {
    expect(CONTACT_STATUSES).toContain('subscribed');
    for (const s of ['unsubscribed', 'bounced', 'complained']) {
      expect(CONTACT_STATUSES).toContain(s as any);
    }
  });

  it('names every event the analytics screens count, so a typo cannot invent a metric', () => {
    for (const t of ['sent', 'delivered', 'deferred', 'bounced', 'opened', 'clicked', 'unsubscribed', 'complained']) {
      expect(EVENT_TYPES).toContain(t as any);
    }
  });

  it('has no duplicates in either list', () => {
    expect(new Set(CONTACT_STATUSES).size).toBe(CONTACT_STATUSES.length);
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });
});
