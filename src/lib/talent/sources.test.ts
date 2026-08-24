// src/lib/talent/sources.test.ts — THE SOURCE REGISTRY RULES, EXERCISED WITH NO DATABASE.
//
// WHY THIS FILE EXISTS NOW. sources.ts is a thousand lines carrying the validation for the
// recruitment registry and every primitive of the ingest credential — mint, hash, mask, prefix,
// scope — and it had no test at all, because until now it had no screen either. /admin/talent/sources
// is that screen, and it drives every one of these rules rather than restating any of them, so the
// rules are now the only thing standing between an operator's click and a live partner credential.
//
// NOTHING HERE OPENS A CONNECTION. sources.ts imports the database handle at module scope, but
// src/lib/db connects on first USE and not on import, so reaching sourceProblems() must not require
// DATABASE_URL. If that regresses this file fails at COLLECTION rather than on an assertion, which
// is exactly the signal wanted: a whole suite going dark reads as a broken file, not a broken rule.
//
// THE FUNCTIONS TOUCHED HERE ARE PURE BY CONSTRUCTION, with one deliberate exception: mintSourceKey()
// is the CSPRNG, and what is asserted about it is its SHAPE and its non-repetition, never a value.
import { describe, it, expect } from 'vitest';
import {
  sourceSlug, sourceProblems, normalizeExternalId, normalizeScopes, hasSourceScope,
  isSourceCategory, isIngestMode, isUuid,
  mintSourceKey, looksLikeSourceKey, sourceKeyPrefix, hashSourceKey, maskSourceKey, hashesMatch,
  safeJsonPayload, sourceActions,
  SOURCE_KEY_SCOPES, DEFAULT_SOURCE_KEY_SCOPES, DEFAULT_SOURCES,
  SOURCE_NAME_MAX, EXTERNAL_ID_MAX, PAYLOAD_MAX_BYTES,
} from '@/lib/talent/sources';
import { SOURCE_CATEGORIES, INGEST_MODES } from '@/lib/talent/types';

const UUID = '11111111-2222-4333-8444-555555555555';

describe('the slug is a function of the name and of nothing else', () => {
  it('lower-cases, collapses punctuation and trims the dashes off both ends', () => {
    expect(sourceSlug('  Placement Cell -- Partnership!  ')).toBe('placement-cell-partnership');
  });

  // THE RULE THIS PINS. application-sources.ts falls back to a timestamp when a name yields nothing;
  // this module deliberately does not. A slug that depends on the clock is not a function of its
  // input, cannot be tested, and hands an operator a different permanent key every time they retry
  // a create that failed.
  it('is stable across calls, with no clock and no randomness in it', () => {
    const a = sourceSlug('Institution partnership');
    const b = sourceSlug('Institution partnership');
    expect(a).toBe(b);
    expect(a).toBe('institution-partnership');
  });

  it('returns empty for a name with nothing usable in it, rather than inventing a key', () => {
    expect(sourceSlug('***')).toBe('');
    expect(sourceSlug('   ')).toBe('');
    expect(sourceSlug(null)).toBe('');
    expect(sourceSlug(undefined)).toBe('');
  });

  it('caps at sixty characters and never ends on a dash', () => {
    const slug = sourceSlug('a'.repeat(58) + ' bbbbbbbbbb');
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('validation reports every problem at once, not the first one', () => {
  const ok = { name: 'Institution partnership', category: 'institution', ingestMode: 'csv' };

  it('passes a well-formed source with no complaints', () => {
    expect(sourceProblems(ok)).toEqual([]);
  });

  // Iterative single-error validation is how somebody spends four submissions discovering four
  // things. The console prints this whole list in one go, which is only possible if it is a list.
  it('names the missing name, the bad category and the bad mode in ONE answer', () => {
    const problems = sourceProblems({ name: '', category: 'nope', ingestMode: 'carrier-pigeon' });
    expect(problems).toHaveLength(3);
    expect(problems.some((p) => p.includes('name is required'))).toBe(true);
    expect(problems.some((p) => p.includes('Category'))).toBe(true);
    expect(problems.some((p) => p.includes('Ingest mode'))).toBe(true);
  });

  it('refuses a name that produces no slug, which would otherwise create an unreferenceable row', () => {
    const problems = sourceProblems({ ...ok, name: '###' });
    expect(problems.some((p) => p.includes('at least one letter or number'))).toBe(true);
  });

  it('refuses a name past the cap, and accepts one exactly at it', () => {
    expect(sourceProblems({ ...ok, name: 'a'.repeat(SOURCE_NAME_MAX) })).toEqual([]);
    expect(sourceProblems({ ...ok, name: 'a'.repeat(SOURCE_NAME_MAX + 1) })).toHaveLength(1);
  });

  it('accepts every member of the two vocabularies, and only those', () => {
    for (const c of SOURCE_CATEGORIES) expect(isSourceCategory(c)).toBe(true);
    for (const m of INGEST_MODES) expect(isIngestMode(m)).toBe(true);
    // 'other' is the COLUMN DEFAULT in the DDL and is not a member of the union. A row can carry it;
    // this console can never write it.
    expect(isSourceCategory('other')).toBe(false);
    expect(isIngestMode('')).toBe(false);
  });
});

describe('an external application identifier is opaque', () => {
  it('is trimmed and capped', () => {
    expect(normalizeExternalId('  abc  ')).toBe('abc');
    expect(normalizeExternalId('x'.repeat(EXTERNAL_ID_MAX + 50)).length).toBe(EXTERNAL_ID_MAX);
  });

  // THE RULE THIS PINS. Case-folding would collapse two genuinely distinct identifiers from a
  // case-sensitive partner system into one candidate — the exact failure the UNIQUE index on
  // (source_id, external_application_id) exists to make impossible.
  it('is never case-folded, so two identifiers that differ only in case stay two', () => {
    expect(normalizeExternalId('AbC-1')).toBe('AbC-1');
    expect(normalizeExternalId('AbC-1')).not.toBe(normalizeExternalId('abc-1'));
  });

  it('turns nothing into empty rather than into "null" or "undefined"', () => {
    expect(normalizeExternalId(null)).toBe('');
    expect(normalizeExternalId(undefined)).toBe('');
  });
});

describe('scopes: a key holds exactly the powers it was issued', () => {
  it('defaults to the narrow set when nothing is asked for', () => {
    expect(normalizeScopes(undefined)).toEqual({ scopes: DEFAULT_SOURCE_KEY_SCOPES, problems: [] });
    expect(normalizeScopes(null).scopes).toEqual(DEFAULT_SOURCE_KEY_SCOPES);
    expect(DEFAULT_SOURCE_KEY_SCOPES).toEqual(['candidate.ingest']);
  });

  it('rejects a request that is not a list at all', () => {
    const r = normalizeScopes('candidate.ingest');
    expect(r.scopes).toEqual([]);
    expect(r.problems).toHaveLength(1);
  });

  // THE FAILURE THIS PREVENTS. An empty tick-list posted from the console must be a REFUSAL, never
  // a key with no powers quietly issued and then debugged for an afternoon by somebody else.
  it('refuses a key with no scope at all', () => {
    const r = normalizeScopes([]);
    expect(r.scopes).toEqual([]);
    expect(r.problems.some((p) => p.includes('at least one scope'))).toBe(true);
  });

  it('names every unknown scope, and does not silently drop it', () => {
    const r = normalizeScopes(['candidate.ingest', 'candidate.delete', 'admin.*']);
    expect(r.problems).toHaveLength(2);
    expect(r.problems.some((p) => p.includes('candidate.delete'))).toBe(true);
    expect(r.problems.some((p) => p.includes('admin.*'))).toBe(true);
  });

  it('deduplicates and orders by the canonical list, not by what the caller typed', () => {
    const r = normalizeScopes(['candidate.status.read', 'candidate.ingest', 'candidate.ingest']);
    expect(r.problems).toEqual([]);
    expect(r.scopes).toEqual(['candidate.ingest', 'candidate.status.read']);
  });

  // NO WILDCARDS, in the grant or the requirement. A narrow partner integration must not be able to
  // become a broad one because somebody stored '*'.
  it('matches a required scope exactly, and a wildcard grants nothing', () => {
    expect(hasSourceScope(['candidate.ingest'], 'candidate.ingest')).toBe(true);
    expect(hasSourceScope(['candidate.ingest'], 'candidate.status.read')).toBe(false);
    expect(hasSourceScope(['*'], 'candidate.ingest')).toBe(false);
    expect(hasSourceScope(null, 'candidate.ingest')).toBe(false);
    expect(SOURCE_KEY_SCOPES.some((s) => String(s).includes('*'))).toBe(false);
  });
});

describe('the key itself: shown once, stored as a hash, shown afterwards only as a stub', () => {
  it('mints the declared format, and not the same one twice', () => {
    const a = mintSourceKey();
    const b = mintSourceKey();
    expect(looksLikeSourceKey(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(a.startsWith('ersk_')).toBe(true);
  });

  it('refuses anything that is not that format, including the other key families in this tree', () => {
    expect(looksLikeSourceKey('erm_' + 'a'.repeat(64))).toBe(false);
    expect(looksLikeSourceKey('erk_' + 'a'.repeat(64))).toBe(false);
    expect(looksLikeSourceKey('ersk_' + 'a'.repeat(63))).toBe(false);
    expect(looksLikeSourceKey('ersk_' + 'Z'.repeat(64))).toBe(false);
    expect(looksLikeSourceKey('')).toBe(false);
  });

  it('stores a sha256 that is not the key and is the same every time', () => {
    const key = mintSourceKey();
    const h = hashSourceKey(key);
    expect(h).toHaveLength(64);
    expect(h).not.toContain(key.slice(5));
    expect(hashSourceKey(key)).toBe(h);
    expect(hashSourceKey(' ' + key + ' ')).toBe(h);
  });

  // THE WHOLE POINT OF THE DISPLAY FORM. What the console shows must be enough to name a key in a
  // ticket and useless for authenticating with it.
  it('masks to a stub that contains no part of the body beyond the stored prefix', () => {
    const key = mintSourceKey();
    const prefix = sourceKeyPrefix(key);
    const masked = maskSourceKey(key);
    expect(prefix).toHaveLength(16);
    expect(masked.startsWith(prefix)).toBe(true);
    expect(masked.includes('...')).toBe(true);
    expect(masked.length).toBeLessThan(key.length);
    // The console only ever holds the stored prefix, never the key, so this is the form it renders.
    expect(maskSourceKey(prefix)).toBe(prefix + '...');
  });

  it('compares hashes without an early return on a length mismatch', () => {
    const h = hashSourceKey('a');
    expect(hashesMatch(h, hashSourceKey('a'))).toBe(true);
    expect(hashesMatch(h, hashSourceKey('b'))).toBe(false);
    expect(hashesMatch(h, 'short')).toBe(false);
    expect(hashesMatch('', '')).toBe(false);
  });
});

describe('a quarantined payload is never dropped, whatever shape it arrived in', () => {
  it('round-trips an ordinary payload', () => {
    expect(JSON.parse(safeJsonPayload({ a: 1 }))).toEqual({ a: 1 });
  });

  it('turns what JSON.stringify cannot express into a value jsonb will accept', () => {
    expect(safeJsonPayload(undefined)).toBe('null');
    expect(safeJsonPayload(() => 1)).toBe('null');
  });

  it('replaces an unserialisable payload with a marker that says so, rather than throwing', () => {
    const circular: any = {};
    circular.self = circular;
    const parsed = JSON.parse(safeJsonPayload(circular));
    expect(parsed.__unserializable).toBe(true);
    expect(typeof parsed.reason).toBe('string');
  });

  it('truncates an oversized payload to a marker carrying its real size and a preview', () => {
    const parsed = JSON.parse(safeJsonPayload({ blob: 'x'.repeat(PAYLOAD_MAX_BYTES + 1000) }));
    expect(parsed.__truncated).toBe(true);
    expect(parsed.limit).toBe(PAYLOAD_MAX_BYTES);
    expect(parsed.bytes).toBeGreaterThan(PAYLOAD_MAX_BYTES);
    expect(parsed.preview).toHaveLength(2000);
  });
});

describe('an id is checked here so Postgres never raises 22P02 at an operator', () => {
  it('accepts a uuid and refuses everything else', () => {
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid('  ' + UUID + '  ')).toBe(true);
    expect(isUuid('not-an-id')).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid(null)).toBe(false);
  });
});

describe('what the console may OFFER on a source row', () => {
  const active = { isActive: true };
  const inactive = { isActive: false };

  // These decide what a button looks like and NOTHING else: createSource, updateSource,
  // deactivateSource and issueSourceKey each re-decide their own refusal when the POST arrives,
  // because a hidden button is not a lock.
  it('offers nothing at all to a viewer who may only read', () => {
    expect(sourceActions(active, false)).toEqual({
      canEdit: false, canDeactivate: false, canReactivate: false, canIssueKey: false,
    });
    expect(sourceActions(inactive, false).canReactivate).toBe(false);
  });

  it('offers deactivate on an active source and reactivate on an inactive one, never both', () => {
    const a = sourceActions(active, true);
    const i = sourceActions(inactive, true);
    expect(a.canDeactivate).toBe(true);
    expect(a.canReactivate).toBe(false);
    expect(i.canDeactivate).toBe(false);
    expect(i.canReactivate).toBe(true);
  });

  // THE ONE THAT MATTERS. issueSourceKey() refuses on an inactive source, so a console that offered
  // the button anyway would spend an operator's click to earn a refusal they could not have
  // predicted — and a deactivated source that could still hand out live credentials is not
  // deactivated at all.
  it('never offers a key on an inactive source', () => {
    expect(sourceActions(inactive, true).canIssueKey).toBe(false);
    expect(sourceActions(active, true).canIssueKey).toBe(true);
  });

  it('treats a missing row and a missing flag as inactive rather than as active', () => {
    expect(sourceActions(null, true).canIssueKey).toBe(false);
    expect(sourceActions(undefined, true).canDeactivate).toBe(false);
    expect(sourceActions({}, true).canIssueKey).toBe(false);
  });
});

describe('the seed is generic channels, and it is internally consistent', () => {
  it('names a category and a mode the vocabulary knows for every seeded source', () => {
    for (const d of DEFAULT_SOURCES) {
      expect(isSourceCategory(d.category)).toBe(true);
      expect(isIngestMode(d.ingestMode)).toBe(true);
      expect(sourceProblems(d)).toEqual([]);
    }
  });

  it('has unique slugs, since the column is UNIQUE and a clash would silently seed one row fewer', () => {
    const slugs = DEFAULT_SOURCES.map((d) => d.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(sourceSlug(s)).toBe(s);
  });
});

// -------------------------------------------------------------------------------------------------
// ADDED ON REVIEW. Three rules the console leans on that nothing here pinned.
// -------------------------------------------------------------------------------------------------

describe('an empty scope request and an absent one are DIFFERENT questions', () => {
  // THIS IS THE ONE THE CONSOLE DEPENDS ON. /admin/talent/sources reads the tick-boxes with
  // fd.getAll('scopes'), which returns [] when nothing is ticked — never undefined. normalizeScopes
  // treats those two inputs oppositely on purpose: [] is somebody who ticked nothing and must be
  // refused, undefined is a caller with no opinion and gets the narrow default. If the page ever
  // switched to fd.get() and passed undefined, an operator who ticked no box would silently be
  // handed a working candidate.ingest key. The distinction is the whole safety of that form, so it
  // is asserted rather than assumed.
  it('defaults on undefined and refuses on an empty list, and those are not the same answer', () => {
    const absent = normalizeScopes(undefined);
    const empty = normalizeScopes([]);
    expect(absent.problems).toEqual([]);
    expect(absent.scopes).toEqual(['candidate.ingest']);
    expect(empty.scopes).toEqual([]);
    expect(empty.problems).not.toEqual([]);
    expect(absent.scopes).not.toEqual(empty.scopes);
  });

  it('refuses a list of nothing but blanks rather than defaulting it', () => {
    const r = normalizeScopes(['', '   ']);
    expect(r.scopes).toEqual([]);
    expect(r.problems.some((p) => p.includes('at least one scope'))).toBe(true);
  });

  // A returned default must not be the module's own array, or a caller mutating what it was handed
  // would change what every later key is issued with.
  it('hands back a copy of the default, not the module constant itself', () => {
    const r = normalizeScopes(undefined);
    expect(r.scopes).not.toBe(DEFAULT_SOURCE_KEY_SCOPES);
    r.scopes.push('candidate.status.read' as any);
    expect(DEFAULT_SOURCE_KEY_SCOPES).toEqual(['candidate.ingest']);
  });
});

describe('the column default is not a value this console can ever write', () => {
  // tal_recruitment_source.category DEFAULTS to 'other' in the DDL and 'other' is not in
  // SOURCE_CATEGORIES. A row written outside this module can carry it and the console prints it as
  // stored — but a create or an edit posting it must be REFUSED, not absorbed, or the vocabulary
  // stops meaning anything the first time somebody's form posts a stale value.
  it('refuses a create carrying the DDL default for category', () => {
    const problems = sourceProblems({ name: 'Placement cell', category: 'other', ingestMode: 'csv' });
    expect(problems.some((p) => p.includes('Category'))).toBe(true);
  });

  it('refuses the DDL default for ingest mode in the same way', () => {
    expect(isIngestMode('other')).toBe(false);
    expect(sourceProblems({ name: 'Placement cell', category: 'institution', ingestMode: 'other' }))
      .toHaveLength(1);
  });
});

describe('knowing the stored prefix gets you nowhere', () => {
  // The console holds key_prefix and NOTHING ELSE — the plaintext is gone the moment the issuing
  // page is closed. So the prefix must be useless: it must not hash to the stored hash, and it must
  // not be enough to pass the format check that guards authentication.
  it('the prefix does not hash to the key hash, and is not itself a well-formed key', () => {
    const key = mintSourceKey();
    const prefix = sourceKeyPrefix(key);
    expect(hashSourceKey(prefix)).not.toBe(hashSourceKey(key));
    expect(looksLikeSourceKey(prefix)).toBe(false);
    expect(looksLikeSourceKey(maskSourceKey(prefix))).toBe(false);
  });
});

describe('the action gate treats anything that is not exactly true as no authority', () => {
  // The console passes can(user, 'talent.manage'). A truthy non-boolean arriving here — a string, a
  // 1, an object — must not open a button, because sourceActions is what the operator sees and a
  // permission check that accepts "truthy" is one refactor away from accepting a non-empty string.
  it('grants nothing on a truthy value that is not the boolean true', () => {
    for (const truthy of ['yes', 1, {}, [], 'false']) {
      const a = sourceActions({ isActive: true }, truthy as any);
      expect(a.canEdit).toBe(false);
      expect(a.canIssueKey).toBe(false);
      expect(a.canDeactivate).toBe(false);
      expect(a.canReactivate).toBe(false);
    }
  });

  // isActive is read off a database row. A row that says 'f', or 1, or nothing at all, must not be
  // read as active — issuing a key against a source Postgres considers closed is the failure.
  it('reads a non-boolean is_active as inactive rather than guessing', () => {
    expect(sourceActions({ isActive: 'true' as any }, true).canIssueKey).toBe(false);
    expect(sourceActions({ isActive: 1 as any }, true).canIssueKey).toBe(false);
  });
});
