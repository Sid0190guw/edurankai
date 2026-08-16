// src/lib/mail-search.test.ts — the search grammar, and the proof that the engine is swappable.
//
// Every function exercised here is PURE. Importing ./mail-search pulls in @/lib/db, which connects
// lazily behind a Proxy — no property is read, so no connection is opened. That is the same shape
// as src/lib/legal-hold.test.ts and it is why these run with no database at all.
//
// THE POINT OF THE toSearchDsl SUITE. "We can move to OpenSearch later" is the kind of claim that
// is true right up until somebody tries it. Compiling the SAME SearchQuery object to a bool query
// and asserting the clauses is what turns it into something checkable — if a new operator is added
// to the parser and not to the compiler, this suite fails rather than the migration.
import { describe, it, expect } from 'vitest';
import {
  parseSearchQuery, parseSize, parseWhen, formatSize, describeQuery, emptyQuery,
  isBroadQuery, toSearchDsl, encodeCursor, decodeCursor, SEARCH_HELP, COUNT_CAP,
} from './mail-search';

const NOW = new Date('2026-08-16T12:00:00+05:30');

describe('operators', () => {
  it('reads the example from the brief', () => {
    const q = parseSearchQuery('from:university.edu has:attachment is:unread');
    expect(q.from.map((f) => f.value)).toEqual(['university.edu']);
    expect(q.hasAttachment).toBe(true);
    expect(q.isUnread).toBe(true);
    expect(q.active).toBe(true);
  });

  it('covers every field the brief lists', () => {
    const q = parseSearchQuery(
      'from:anita to:accounts cc:ravi bcc:audit subject:invoice body:"site visit" ' +
      'filename:report.pdf domain:university.edu label:payroll in:sent has:attachment ' +
      'is:starred after:2026-07-01 before:2026-08-01 larger:1m smaller:5m',
    );
    expect(q.from[0].value).toBe('anita');
    expect(q.to[0].value).toBe('accounts');
    expect(q.cc[0].value).toBe('ravi');
    expect(q.bcc[0].value).toBe('audit');
    expect(q.subject[0].value).toBe('invoice');
    expect(q.body[0].value).toBe('site visit');
    expect(q.filename[0].value).toBe('report.pdf');
    expect(q.domain[0].value).toBe('university.edu');
    expect(q.labels[0].value).toBe('payroll');
    expect(q.folder).toBe('sent');
    expect(q.hasAttachment).toBe(true);
    expect(q.isStarred).toBe(true);
    expect(q.after).toBeInstanceOf(Date);
    expect(q.before).toBeInstanceOf(Date);
    expect(q.largerThan).toBe(1024 * 1024);
    expect(q.smallerThan).toBe(5 * 1024 * 1024);
    expect(q.warnings).toEqual([]);
  });

  it('keeps a quoted phrase whole and marks it as a phrase', () => {
    const q = parseSearchQuery('"kerala site visit" subject:"july invoice"');
    expect(q.text[0].value).toBe('kerala site visit');
    expect(q.text[0].phrase).toBe(true);
    expect(q.subject[0].value).toBe('july invoice');
  });

  it('a leading minus excludes', () => {
    const q = parseSearchQuery('-from:noreply invoice -receipt');
    expect(q.from[0]).toEqual({ value: 'noreply', negate: true, phrase: false });
    expect(q.text.find((t) => t.value === 'invoice')!.negate).toBe(false);
    expect(q.text.find((t) => t.value === 'receipt')!.negate).toBe(true);
  });

  it('is:read is the negation of is:unread, not a separate axis', () => {
    expect(parseSearchQuery('is:read').isUnread).toBe(false);
    expect(parseSearchQuery('is:unread').isUnread).toBe(true);
    expect(parseSearchQuery('-is:unread').isUnread).toBe(false);
  });

  it('in:anywhere is a scope, a folder name is a folder, anything else is a label', () => {
    expect(parseSearchQuery('in:anywhere').everywhere).toBe(true);
    expect(parseSearchQuery('in:archive').folder).toBe('archive');
    expect(parseSearchQuery('in:payroll').labels[0].value).toBe('payroll');
  });

  it('an address domain strips a leading @', () => {
    expect(parseSearchQuery('domain:@university.edu').domain[0].value).toBe('university.edu');
  });
});

describe('nothing typed is ever silently dropped', () => {
  it('an unknown operator becomes free text AND says so', () => {
    const q = parseSearchQuery('colour:red');
    expect(q.text[0].value).toBe('colour:red');
    expect(q.warnings.join(' ')).toContain('colour:');
  });

  it('an operator with no value is reported, not ignored in silence', () => {
    const q = parseSearchQuery('from: invoice');
    expect(q.warnings.length).toBe(1);
    expect(q.text[0].value).toBe('invoice');
  });

  it('an unreadable date is refused rather than guessed', () => {
    const q = parseSearchQuery('after:nonsense');
    expect(q.after).toBeNull();
    expect(q.warnings.join(' ')).toContain('after:nonsense');
  });

  it('an unreadable size is refused rather than guessed', () => {
    const q = parseSearchQuery('larger:huge');
    expect(q.largerThan).toBeNull();
    expect(q.warnings.join(' ')).toContain('larger:huge');
  });

  it('is: and has: values that mean nothing are reported', () => {
    expect(parseSearchQuery('is:purple').warnings.length).toBe(1);
    expect(parseSearchQuery('has:wings').warnings.length).toBe(1);
  });

  it('a thread: that is not an id is refused', () => {
    const q = parseSearchQuery('thread:12345');
    expect(q.threadId).toBeNull();
    expect(q.warnings.length).toBe(1);
  });
});

describe('sizes', () => {
  it('reads the units people type', () => {
    expect(parseSize('1024')).toBe(1024);
    expect(parseSize('2k')).toBe(2048);
    expect(parseSize('2kb')).toBe(2048);
    expect(parseSize('1m')).toBe(1048576);
    expect(parseSize('1.5m')).toBe(1572864);
    expect(parseSize('1g')).toBe(1073741824);
  });
  it('refuses what it cannot read', () => {
    expect(parseSize('')).toBeNull();
    expect(parseSize('big')).toBeNull();
    expect(parseSize('-5m')).toBeNull();
  });
  it('formats back into something readable', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(1048576)).toBe('1.0 MB');
    expect(formatSize(15 * 1048576)).toBe('15 MB');
  });
});

describe('dates', () => {
  it('reads the named days', () => {
    const today = parseWhen('today', NOW)!;
    expect(today.getDate()).toBe(NOW.getDate());
    expect(today.getHours()).toBe(0);
    expect(parseWhen('yesterday', NOW)!.getDate()).toBe(NOW.getDate() - 1);
  });
  it('reads relative spans', () => {
    expect(parseWhen('7d', NOW)!.getDate()).toBe(new Date(NOW.getTime() - 7 * 86400000).getDate());
    expect(parseWhen('1y', NOW)!.getFullYear()).toBe(NOW.getFullYear() - 1);
  });
  it('reads ISO and day-first forms', () => {
    expect(parseWhen('2026-07-01', NOW)!.getMonth()).toBe(6);
    // Day-first: 01/07/2026 is the first of July, which is how dates are written here.
    expect(parseWhen('01/07/2026', NOW)!.getMonth()).toBe(6);
    expect(parseWhen('01/07/2026', NOW)!.getDate()).toBe(1);
  });
  it('before: includes the named day', () => {
    const q = parseSearchQuery('before:2026-07-31');
    // The stored bound is exclusive and one day later, so the 31st itself matches.
    expect(q.before!.getDate()).toBe(1);
    expect(q.before!.getMonth()).toBe(7);
  });
});

describe('the sentence shown on screen', () => {
  it('describes what was actually searched for', () => {
    const q = parseSearchQuery('from:anita has:attachment is:unread invoice');
    expect(q.describe).toContain('invoice');
    expect(q.describe).toContain('from anita');
    expect(q.describe).toContain('with an attachment');
    expect(q.describe).toContain('unread only');
  });
  it('says what was excluded', () => {
    expect(parseSearchQuery('-from:noreply').describe).toContain('not from noreply');
  });
  it('an empty query is not active and describes nothing', () => {
    const q = parseSearchQuery('   ');
    expect(q.active).toBe(false);
    expect(q.describe).toBe('');
  });
  it('describeQuery works on a hand-built query too', () => {
    const q = emptyQuery();
    q.isStarred = true;
    expect(describeQuery(q).describe).toBe('starred only');
  });
});

describe('broadness', () => {
  it('a state-only query is broad — it narrows nothing a person named', () => {
    expect(isBroadQuery(parseSearchQuery('is:unread'))).toBe(true);
    expect(isBroadQuery(parseSearchQuery(''))).toBe(true);
  });
  it('anything with a term or an address is not broad', () => {
    expect(isBroadQuery(parseSearchQuery('invoice'))).toBe(false);
    expect(isBroadQuery(parseSearchQuery('from:anita'))).toBe(false);
    expect(isBroadQuery(parseSearchQuery('label:payroll'))).toBe(false);
  });
});

describe('keyset cursors', () => {
  it('round-trips', () => {
    const id = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    const t = '2026-08-16T06:30:00.000Z';
    expect(decodeCursor(encodeCursor(t, id))).toEqual({ t, id });
  });
  it('a damaged cursor starts from the top rather than throwing the listing away', () => {
    expect(decodeCursor('not-base64')).toBeNull();
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor(Buffer.from('{"t":"x","id":"nope"}').toString('base64url'))).toBeNull();
  });
});

describe('the second engine, compiled from the same query', () => {
  const ctx = { userId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' };

  it('mailbox ownership is a FILTER, never a relevance signal', () => {
    const dsl = toSearchDsl(parseSearchQuery('invoice'), ctx);
    expect(dsl.query.bool.filter).toContainEqual({ term: { user_id: ctx.userId } });
  });

  it('collapses to one hit per conversation, like the SQL path does', () => {
    const dsl = toSearchDsl(parseSearchQuery(''), ctx);
    expect(dsl.collapse.field).toBe('thread_id');
  });

  it('a negated term becomes must_not, not a missing clause', () => {
    const dsl = toSearchDsl(parseSearchQuery('-from:noreply'), ctx);
    expect(JSON.stringify(dsl.query.bool.must_not)).toContain('noreply');
    expect(JSON.stringify(dsl.query.bool.must)).not.toContain('noreply');
  });

  it('a quoted phrase compiles to a phrase match', () => {
    const dsl = toSearchDsl(parseSearchQuery('"site visit"'), ctx);
    expect(JSON.stringify(dsl.query.bool.must)).toContain('"type":"phrase"');
  });

  it('dates and sizes become range filters', () => {
    const dsl = toSearchDsl(parseSearchQuery('after:2026-07-01 larger:1m'), ctx);
    const filters = JSON.stringify(dsl.query.bool.filter);
    expect(filters).toContain('created_at');
    expect(filters).toContain('size_bytes');
  });

  it('sorting by date is keyset-friendly and by relevance leads with the score', () => {
    expect(JSON.stringify(toSearchDsl(parseSearchQuery('x'), ctx).sort)).toContain('created_at');
    const rel = parseSearchQuery('x');
    rel.sort = 'relevance';
    expect(toSearchDsl(rel, ctx).sort[0]).toBe('_score');
  });

  it('does not ask the cluster for an unbounded total either', () => {
    expect(toSearchDsl(parseSearchQuery('x'), ctx).track_total_hits).toBe(COUNT_CAP);
  });

  it('the scope in the rail survives the compile', () => {
    const starred = toSearchDsl(parseSearchQuery(''), { ...ctx, scope: { starred: true } });
    expect(JSON.stringify(starred.query.bool.filter)).toContain('is_starred');
    const labelled = toSearchDsl(parseSearchQuery(''), { ...ctx, scope: { label: 'payroll' } });
    expect(JSON.stringify(labelled.query.bool.filter)).toContain('payroll');
  });
});

describe('the help text cannot describe a grammar the parser does not have', () => {
  it('every operator shown in the help parses to something', () => {
    for (const row of SEARCH_HELP) {
      // Take the first operator on the line and give it a plausible operand.
      const op = row.op.split(/[\s/]/)[0];
      if (!op.includes(':')) continue;
      const [field, val] = op.split(':');
      const sample = val || 'x';
      const q = parseSearchQuery(field + ':' + (sample.replace(/"/g, '') || 'x'));
      expect(q.warnings.filter((w) => w.startsWith(field + ':'))).toEqual([]);
    }
  });
});
