// Tests for the event envelope, the buffer, and the load generator's safety guards.
//
// The loadgen guard tests are the most important ones in this patch. §9 says generated load must
// never reach a public recipient; these assertions are what make that a property of the code rather
// than a promise in a comment.
import { describe, it, expect } from 'vitest';
import {
  makeEvent, validateEvent, toRow, toNdjson, scrubMetadata, partitionSql,
  EventBuffer, memorySink, METADATA_DENY, EVENT_TYPES, CLICKHOUSE_DDL, EVENT_DDL, toIso,
  type EventRow,
} from './events';
import {
  isReservedAddress, assertSafeRecipients, assertLocalSmtp, UnsafeRecipientError,
  seededRandom, generateContacts, generateMessages, generateCampaigns, generateWorkflowRuns,
  generateEventStream, summarizeCorpus, SYNTHETIC_DOMAIN, SYNTHETIC_TAG, SYNTHETIC_HEADER, SIZE_MIX,
} from './loadgen';

const TENANT = '00000000-0000-4000-8000-000000000001';

describe('event envelope', () => {
  it('fills every field §5 requires', () => {
    const e = makeEvent({ eventType: 'message.sent', tenantId: TENANT, source: 'worker', messageId: 'm1' });
    expect(e.eventId).toBeTruthy();
    expect(e.timestamp).toBeTruthy();
    expect(e.tenantId).toBe(TENANT);
    expect(e.source).toBe('worker');
    expect(e.metadata).toEqual({});
  });

  it('mints unique ids', () => {
    const ids = new Set(Array.from({ length: 500 }, () => makeEvent({ eventType: 'message.sent', tenantId: TENANT, source: 'api', messageId: 'm' }).eventId));
    expect(ids.size).toBe(500);
  });

  it('rejects an event with no tenant — it could never be billed, filtered or deleted on request', () => {
    const v = validateEvent({ eventId: 'a', eventType: 'message.sent', timestamp: new Date().toISOString(), source: 'api', messageId: 'm' });
    expect(v.valid).toBe(false);
    expect(v.errors.join(' ')).toContain('tenantId');
  });

  it('requires the join key implied by the event family', () => {
    // An event ABOUT a message that cannot name the message inflates counts and answers nothing.
    expect(validateEvent(makeEvent({ eventType: 'message.sent', tenantId: TENANT, source: 'api' })).valid).toBe(false);
    expect(validateEvent(makeEvent({ eventType: 'campaign.started', tenantId: TENANT, source: 'api' })).valid).toBe(false);
    expect(validateEvent(makeEvent({ eventType: 'workflow.started', tenantId: TENANT, source: 'api' })).valid).toBe(false);
    expect(validateEvent(makeEvent({ eventType: 'workflow.started', tenantId: TENANT, source: 'api', workflowId: 'w1' })).valid).toBe(true);
  });

  it('enforces the <entity>.<verb> naming rule', () => {
    expect(validateEvent(makeEvent({ eventType: 'MessageSent', tenantId: TENANT, source: 'api' })).errors.join(' ')).toContain('snake case');
  });

  it('rejects an unparseable timestamp', () => {
    expect(validateEvent({ ...makeEvent({ eventType: 'queue.job_enqueued', tenantId: TENANT, source: 'api' }), timestamp: 'yesterday' }).valid).toBe(false);
  });

  it('every catalogued event type passes its own naming rule', () => {
    for (const t of EVENT_TYPES) expect(t).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
  });
});

describe('metadata scrubbing', () => {
  it('drops message content, which no redaction regex would ever catch', () => {
    const out = scrubMetadata({ bodyHtml: '<p>secret</p>', text: 'hello', sizeBytes: 10 });
    expect(out.bodyHtml).toBeUndefined();
    expect(out.text).toBeUndefined();
    expect(out.sizeBytes).toBe(10);
  });

  it('drops every denied key regardless of case', () => {
    const meta: Record<string, unknown> = {};
    for (const k of METADATA_DENY) meta[k.toUpperCase()] = 'x';
    expect(Object.keys(scrubMetadata(meta))).toHaveLength(0);
  });

  it('truncates a very long string rather than storing it whole', () => {
    const out = scrubMetadata({ note: 'x'.repeat(5000) });
    expect(String(out.note)).toContain('[truncated]');
    expect(String(out.note).length).toBeLessThan(2100);
  });

  it('scrubbing happens on the way to a row, not only when asked', () => {
    const row = toRow(makeEvent({ eventType: 'message.sent', tenantId: TENANT, source: 'api', messageId: 'm', metadata: { bodyText: 'private', ok: 1 } }));
    expect(row.metadata).not.toContain('private');
    expect(JSON.parse(row.metadata)).toEqual({ ok: 1 });
  });
});

describe('storage shapes', () => {
  it('the row uses the wire spelling that both stores share', () => {
    const row = toRow(makeEvent({ eventType: 'message.delivered', tenantId: TENANT, source: 'mta', messageId: 'm1', sourceId: 'mta-01' }));
    expect(Object.keys(row).sort()).toEqual(['campaign_id', 'contact_id', 'event_id', 'event_type', 'message_id', 'metadata', 'occurred_at', 'source', 'source_id', 'tenant_id', 'workflow_id']);
  });

  it('NDJSON is one row per line and empty for no events', () => {
    const events = [
      makeEvent({ eventType: 'message.sent', tenantId: TENANT, source: 'api', messageId: 'a' }),
      makeEvent({ eventType: 'message.sent', tenantId: TENANT, source: 'api', messageId: 'b' }),
    ];
    expect(toNdjson(events).trim().split('\n')).toHaveLength(2);
    expect(toNdjson([])).toBe('');
  });

  it('the ClickHouse columns match EventRow exactly, so the migration is a copy', () => {
    const row = toRow(makeEvent({ eventType: 'message.sent', tenantId: TENANT, source: 'api', messageId: 'm' }));
    for (const col of Object.keys(row)) expect(CLICKHOUSE_DDL).toContain(col);
  });

  it('partitions are monthly and roll the year correctly', () => {
    expect(partitionSql(2026, 8)).toContain("FROM ('2026-08-01') TO ('2026-09-01')");
    expect(partitionSql(2026, 12)).toContain("FROM ('2026-12-01') TO ('2027-01-01')");
    expect(partitionSql(2026, 12)).toContain('mp_events_202612');
  });

  it('ships a DEFAULT partition so an insert can never fail for a missing month', () => {
    expect(EVENT_DDL.join(' ')).toContain('PARTITION OF mp_events DEFAULT');
  });
});

describe('EventBuffer', () => {
  it('batches and flushes as one write', async () => {
    const sink = memorySink();
    const buf = new EventBuffer(sink, 3);
    for (let i = 0; i < 3; i++) buf.add(makeEvent({ eventType: 'message.sent', tenantId: TENANT, source: 'api', messageId: 'm' + i }));
    expect(buf.shouldFlush()).toBe(true);
    await buf.flush();
    expect(sink.rows).toHaveLength(3);
    expect(buf.pending).toBe(0);
  });

  it('rejects an invalid event without throwing onto the send path', () => {
    const buf = new EventBuffer(memorySink());
    expect(buf.add({ eventId: 'x', eventType: 'nope', timestamp: 'bad', tenantId: '', source: 'api', metadata: {} } as never)).toBe(false);
    expect(buf.snapshot().dropped).toBe(1);
    expect(buf.snapshot().lastError).toContain('invalid event');
  });

  it('is BOUNDED: a failing sink cannot grow the buffer until the process dies', () => {
    const buf = new EventBuffer(memorySink(), 10, 5);
    for (let i = 0; i < 50; i++) buf.add(makeEvent({ eventType: 'message.sent', tenantId: TENANT, source: 'api', messageId: 'm' + i }));
    expect(buf.pending).toBe(5);
    expect(buf.snapshot().dropped).toBe(45);
  });

  it('puts rows BACK on a failed flush, so a pooler blip does not lose events', async () => {
    let fail = true;
    const flaky = { async write(rows: readonly EventRow[]) { if (fail) throw new Error('pooler timeout'); received.push(...rows); } };
    const received: EventRow[] = [];
    const buf = new EventBuffer(flaky, 10, 100);
    for (let i = 0; i < 4; i++) buf.add(makeEvent({ eventType: 'message.sent', tenantId: TENANT, source: 'api', messageId: 'm' + i }));

    const bad = await buf.flush();
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('pooler timeout');
    expect(buf.pending).toBe(4);

    fail = false;
    const good = await buf.flush();
    expect(good.ok).toBe(true);
    expect(received).toHaveLength(4);
  });

  it('drops oldest-first when a restore would exceed the cap', async () => {
    const buf = new EventBuffer({ async write() { throw new Error('down'); } }, 10, 3);
    for (let i = 0; i < 3; i++) buf.add(makeEvent({ eventType: 'message.sent', tenantId: TENANT, source: 'api', messageId: 'm' + i }));
    await buf.flush();
    expect(buf.pending).toBeLessThanOrEqual(3);
    expect(buf.snapshot().lastError).toContain('down');
  });
});

// ---------------------------------------------------------------------------
// Load generator safety
// ---------------------------------------------------------------------------

describe('recipient safety', () => {
  it('recognises the reserved suffixes', () => {
    expect(isReservedAddress('a@loadtest.invalid')).toBe(true);
    expect(isReservedAddress('a@anything.test')).toBe(true);
    expect(isReservedAddress('a@example.com')).toBe(true);
    expect(isReservedAddress('a@localhost')).toBe(true);
  });

  it('rejects real domains, including near misses', () => {
    expect(isReservedAddress('a@gmail.com')).toBe(false);
    expect(isReservedAddress('a@edurankai.in')).toBe(false);
    expect(isReservedAddress('a@invalid.com')).toBe(false);      // suffix is `.invalid`, not the word
    expect(isReservedAddress('a@notexample.com')).toBe(false);
    expect(isReservedAddress('no-at-sign')).toBe(false);
  });

  it('THROWS rather than filtering, so a run pointed at a real list cannot quietly succeed', () => {
    // Silently dropping would produce a throughput number for a smaller corpus than requested —
    // a wrong benchmark AND a near miss nobody investigates.
    expect(() => assertSafeRecipients(['ok@loadtest.invalid', 'real@gmail.com'])).toThrow(UnsafeRecipientError);
    try {
      assertSafeRecipients(['real@gmail.com']);
    } catch (e) {
      expect((e as UnsafeRecipientError).offenders).toEqual(['real@gmail.com']);
      expect((e as Error).message).toContain('never reach a public mailbox');
    }
  });

  it('accepts an all-reserved list', () => {
    expect(() => assertSafeRecipients(['a@loadtest.invalid', 'b@x.test'])).not.toThrow();
  });

  it('refuses a non-local SMTP target', () => {
    expect(() => assertLocalSmtp('smtp.gmail.com')).toThrow(/local SMTP test infrastructure/);
    expect(() => assertLocalSmtp('localhost')).not.toThrow();
    expect(() => assertLocalSmtp('127.0.0.1')).not.toThrow();
    expect(() => assertLocalSmtp('192.168.1.20')).not.toThrow();
    expect(() => assertLocalSmtp('mail.internal')).not.toThrow();
    expect(() => assertLocalSmtp('smtp.gmail.com', { allowRemote: true })).not.toThrow();
  });
});

describe('corpus generation', () => {
  it('is deterministic for a seed', () => {
    expect(generateContacts(50, { seed: 7 })).toEqual(generateContacts(50, { seed: 7 }));
    expect(generateContacts(50, { seed: 7 })).not.toEqual(generateContacts(50, { seed: 8 }));
  });

  it('seededRandom stays in range and repeats exactly', () => {
    const a = seededRandom(42), b = seededRandom(42);
    for (let i = 0; i < 100; i++) {
      const v = a();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(v).toBe(b());
    }
  });

  it('generates unique addresses at scale — no silent upsert-conflict benchmark', () => {
    const contacts = generateContacts(5000, { seed: 3 });
    expect(new Set(contacts.map((c) => c.email)).size).toBe(5000);
    expect(contacts.every((c) => c.email.endsWith('@' + SYNTHETIC_DOMAIN))).toBe(true);
  });

  it('every generated message is addressed to a reserved domain', () => {
    const contacts = generateContacts(100, { seed: 1 });
    const msgs = generateMessages(1000, contacts, { seed: 1 });
    expect(msgs.every((m) => isReservedAddress(m.to))).toBe(true);
    expect(msgs.every((m) => isReservedAddress(m.from))).toBe(true);
  });

  it('refuses a real sender domain', () => {
    const contacts = generateContacts(5, { seed: 1 });
    expect(() => generateMessages(5, contacts, { seed: 1, fromDomain: 'edurankai.in' })).toThrow(UnsafeRecipientError);
  });

  it('tags every message so a run is findable afterwards', () => {
    const msgs = generateMessages(10, generateContacts(5, { seed: 1 }), { seed: 1 });
    expect(msgs.every((m) => m.headers[SYNTHETIC_HEADER] === SYNTHETIC_TAG)).toBe(true);
    expect(msgs.every((m) => m.externalId.startsWith(SYNTHETIC_TAG))).toBe(true);
  });

  it('produces a SPREAD of message sizes, not one constant', () => {
    // A corpus of identical small messages measures a system nobody operates.
    const msgs = generateMessages(2000, generateContacts(100, { seed: 5 }), { seed: 5 });
    const sizes = new Set(msgs.map((m) => m.sizeBytes));
    expect(sizes.size).toBeGreaterThan(100);
    expect(Math.min(...msgs.map((m) => m.sizeBytes))).toBeLessThan(10_000);
    expect(Math.max(...msgs.map((m) => m.sizeBytes))).toBeGreaterThan(100_000);
  });

  it('the size mix weights sum to 1', () => {
    expect(SIZE_MIX.reduce((s, b) => s + b.weight, 0)).toBeCloseTo(1, 6);
  });

  it('bodies are compressible like prose, not like a repeated character', () => {
    // Filler of one repeated char would make every storage and transfer measurement wrong by an
    // order of magnitude. A crude proxy: many distinct words present.
    const msg = generateMessages(1, generateContacts(1, { seed: 2 }), { seed: 2 })[0];
    expect(new Set(msg.text.split(/\s+/)).size).toBeGreaterThan(5);
  });

  it('generates campaigns and workflow runs', () => {
    expect(generateCampaigns(3, 100, { seed: 1 })).toHaveLength(3);
    const runs = generateWorkflowRuns(20, generateContacts(5, { seed: 1 }), { seed: 1 });
    expect(runs).toHaveLength(20);
    expect(runs.every((r) => r.nodesExecuted >= 2 && r.nodesExecuted <= 9)).toBe(true);
  });

  it('refuses to generate messages with no contacts rather than inventing one', () => {
    expect(() => generateMessages(5, [], { seed: 1 })).toThrow(/at least one contact/);
  });

  it('event streams always start queued+sent and terminate', () => {
    const contacts = generateContacts(10, { seed: 9 });
    const msgs = generateMessages(200, contacts, { seed: 9 });
    let bounced = 0, delivered = 0;
    msgs.forEach((m, i) => {
      const stream = generateEventStream(m, contacts[i % contacts.length], { seed: 9, seedOffset: i });
      expect(stream[0].eventType).toBe('message.queued');
      expect(stream[1].eventType).toBe('message.sent');
      if (stream.some((s) => s.eventType === 'message.bounced')) bounced++;
      if (stream.some((s) => s.eventType === 'message.delivered')) delivered++;
    });
    expect(bounced).toBeGreaterThan(0);
    expect(delivered).toBeGreaterThan(0);
    expect(bounced + delivered).toBe(200);   // exactly one terminal state each
  });

  it('summarises the realised distribution, so throughput can be read next to its payload', () => {
    const contacts = generateContacts(50, { seed: 4 });
    const messages = generateMessages(500, contacts, { seed: 4 });
    const s = summarizeCorpus({ contacts, messages, seed: 4 });
    expect(s.messages).toBe(500);
    expect(s.allRecipientsReserved).toBe(true);
    expect(s.meanBytes).toBeGreaterThan(1000);
    expect(Object.keys(s.bandCounts).length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Regression: millisecond truncation (found by adversarial review)
// ---------------------------------------------------------------------------

describe('toIso — millisecond fidelity', () => {
  it('keeps milliseconds when handed a Date, which is what postgres-js returns for timestamptz', () => {
    // THE BUG THIS LOCKS DOWN. `new Date(String(date)).toISOString()` routes through
    // Date.prototype.toString(), whose format ("Sun Aug 16 2026 15:30:00 GMT+0530") carries NO
    // fractional seconds — so .742 became .000.
    const d = new Date('2026-08-16T10:00:00.742Z');
    expect(toIso(d)).toBe('2026-08-16T10:00:00.742Z');
    // The old, broken formulation, asserted explicitly so the difference is visible in the test file.
    expect(new Date(String(d)).toISOString()).toBe('2026-08-16T10:00:00.000Z');
  });

  it('handles an ISO string unchanged', () => {
    expect(toIso('2026-08-16T10:00:00.742Z')).toBe('2026-08-16T10:00:00.742Z');
  });

  it('does not throw on an unparseable value', () => {
    expect(toIso('not a date')).toBe('not a date');
  });

  it('a truncated cursor would re-read rows already emitted — the reason this matters', () => {
    // Page 1's last row is at .742. A cursor truncated to .000 sorts BEFORE every row in that
    // second, so `(occurred_at, event_id) > cursor` stays true for all of them and page 2 restarts
    // at the top of the second: duplicated exports, and a loop that never terminates.
    const lastRow = new Date('2026-08-16T10:00:00.742Z');
    const truncated = new Date(String(lastRow)).toISOString();
    const correct = toIso(lastRow);
    expect(Date.parse(truncated)).toBeLessThan(Date.parse(correct));   // points backwards: the bug
    expect(Date.parse(correct)).toBe(lastRow.getTime());               // points at the row: the fix
  });
});

// ---------------------------------------------------------------------------
// Regression: bounds and guards (found by adversarial review)
// ---------------------------------------------------------------------------

describe('EventBuffer bound holds when the buffer is already full', () => {
  it('slice(-0) does NOT restore the whole batch when the buffer refilled mid-flush', async () => {
    // `arr.slice(-0)` is `arr.slice(0)` — the ENTIRE array. room reaches 0 only when the buffer
    // refilled while a flush was in flight, which is the ordinary case for a worker: flush() is
    // async, and the send path keeps calling add() during the await. So this test interleaves them
    // deliberately rather than flushing a quiet buffer.
    let reject: (e: Error) => void = () => {};
    const gate = new Promise<void>((_, rej) => { reject = rej; });
    const buf = new EventBuffer({ write: () => gate }, 2, 3);

    for (let i = 0; i < 3; i++) buf.add(makeEvent({ eventType: 'message.sent', tenantId: TENANT, source: 'api', messageId: 'a' + i }));
    const inFlight = buf.flush();            // takes the 3 rows, empties this.rows, awaits the gate

    // The send path keeps producing while the sink is stuck, refilling the buffer to its cap.
    for (let i = 0; i < 3; i++) buf.add(makeEvent({ eventType: 'message.sent', tenantId: TENANT, source: 'api', messageId: 'b' + i }));
    expect(buf.pending).toBe(3);             // full: room is now 0

    reject(new Error('sink down'));
    const r = await inFlight;
    expect(r.ok).toBe(false);

    expect(buf.pending).toBeLessThanOrEqual(3);   // the cap holds — before the fix this was 6
    expect(buf.snapshot().dropped).toBe(3);       // and all 3 unrestorable rows are COUNTED
  });

  it('never exceeds maxBuffer across repeated flush failures', async () => {
    const buf = new EventBuffer({ async write() { throw new Error('down'); } }, 5, 4);
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 5; i++) buf.add(makeEvent({ eventType: 'message.sent', tenantId: TENANT, source: 'api', messageId: 'm' + round + i }));
      await buf.flush();
      expect(buf.pending).toBeLessThanOrEqual(4);
    }
  });
});

describe('assertLocalSmtp — private-range guard is a FULL match', () => {
  it('rejects a public host that merely BEGINS with a private range', () => {
    // The original prefix regexes (/^10\./ etc.) were anchored at the start only, so these
    // publicly-resolvable hosts were accepted as "local" and would have received generated load.
    for (const h of ['10.0.0.1.evil.com', '192.168.1.1.attacker.net', '172.16.0.1.evil.com', '127.0.0.1.evil.com']) {
      expect(() => assertLocalSmtp(h), h + ' must be refused').toThrow(/local SMTP test infrastructure/);
    }
  });

  it('rejects a host that merely CONTAINS a local-looking label', () => {
    for (const h of ['localhost.evil.com', 'notlocalhost', 'evil-internal.com', 'my.local.evil.com']) {
      expect(() => assertLocalSmtp(h), h + ' must be refused').toThrow();
    }
  });

  it('still accepts the genuinely local forms', () => {
    for (const h of ['localhost', 'localhost.', '127.0.0.1', '::1', '10.1.2.3', '192.168.1.20', '172.16.5.5', '172.31.0.1', 'mail.internal', 'printer.local', '0.0.0.0']) {
      expect(() => assertLocalSmtp(h), h + ' must be accepted').not.toThrow();
    }
  });

  it('rejects a public address just outside the private ranges', () => {
    for (const h of ['172.15.0.1', '172.32.0.1', '11.0.0.1', '192.169.0.1', '8.8.8.8']) {
      expect(() => assertLocalSmtp(h), h + ' must be refused').toThrow();
    }
  });

  it('rejects a malformed octet rather than treating it as an address', () => {
    expect(() => assertLocalSmtp('10.999.0.1')).toThrow();
  });
});
