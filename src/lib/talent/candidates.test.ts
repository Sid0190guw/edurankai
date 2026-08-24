// src/lib/talent/candidates.test.ts — the candidate register's rules, exercised with no database.
//
// THE IMPORT ITSELF IS THE FIRST ASSERTION. candidates.ts resolves its database handle inside ctx()
// and every rule below is reachable without one. If that ever regresses, this file fails at
// COLLECTION rather than on an assertion — which reads as a broken file rather than a broken rule,
// and is exactly the signal wanted.
import { describe, it, expect } from 'vitest';
import {
  classifySearch, SEARCH_KIND_LABELS, SEARCH_ELSEWHERE,
  statusBucket, statusesInBucket, resolveStatusFilter, statusLiteralList,
  confidenceBand, CONFIDENCE_BAND_LABELS,
  evidenceSignals, mergeDecisionProblem, describeMergeEffect,
  applicationsPhrase, overlappingOpportunities,
  IN_PROGRESS_STATUSES, DECIDED_STATUSES, ONBOARDING_STATUSES_C, JOINED_STATUSES, CLOSED_STATUSES,
  MIN_MERGE_REASON, STATUS_BUCKET_LABELS, likeTerm, toCandidate,
  type SearchKind, type StatusBucket,
} from '@/lib/talent/candidates';
import { CANDIDATE_STATUSES, ID_PREFIX } from '@/lib/talent/types';

const REASON = 'Same person, confirmed by phone with the candidate';

// ---------------------------------------------------------------------------------------------
// SEARCH CLASSIFICATION — the rule this screen most needs to get right, because the failure mode is
// a confident wrong answer rather than an error.
// ---------------------------------------------------------------------------------------------

describe('classifySearch tells a candidate reference from every other ERAI namespace', () => {
  it('recognises the three references this register can actually answer', () => {
    expect(classifySearch('ERAI-PER-2026-000001').kind).toBe('person_code');
    expect(classifySearch('ERAI-CAN-2026-000001').kind).toBe('candidate_code');
    expect(classifySearch('ERAI-APP-2026-000123').kind).toBe('application_code');
    for (const t of ['ERAI-PER-2026-000001', 'ERAI-CAN-2026-000001', 'ERAI-APP-2026-000123']) {
      expect(classifySearch(t).searchable).toBe(true);
      expect(classifySearch(t).belongsTo).toBeNull();
    }
  });

  it('refuses to call an OPPORTUNITY code a missing candidate, and says where it belongs', () => {
    // The whole point. Answering "no such candidate" here would be a confident wrong answer to a
    // question the register never understood.
    const r = classifySearch('ERAI-OPP-2026-00421');
    expect(r.kind).toBe('opportunity_code');
    expect(r.searchable).toBe(false);
    expect(r.belongsTo).toBe(SEARCH_ELSEWHERE.opportunity_code);
    expect(String(r.belongsTo)).toContain('Opportunities');
  });

  it('splits ERAI-ONBCODE from ERAI-ONB, which is the collision finding F11 exists for', () => {
    // The two share a stem. A match on the shorter prefix would file every onboarding CODE under
    // the onboarding APPLICATION register, and both are pasted into this same box.
    const code = classifySearch('ERAI-ONBCODE-2026-000007');
    const app = classifySearch('ERAI-ONB-2026-000007');
    expect(code.kind).toBe('onboarding_code_ref');
    expect(app.kind).toBe('onboarding_ref');
    expect(code.kind).not.toBe(app.kind);
    expect(code.belongsTo).toBe('Onboarding codes');
    expect(app.belongsTo).toBe('Onboarding review');
  });

  it('holds that split whatever the case and whitespace of the paste', () => {
    expect(classifySearch('  erai-onbcode-2026-000007  ').kind).toBe('onboarding_code_ref');
    expect(classifySearch('erai-onb-2026-000007').kind).toBe('onboarding_ref');
    expect(classifySearch('  erai-onbcode-2026-000007  ').term).toBe('ERAI-ONBCODE-2026-000007');
  });

  it('does not let the ONBCODE prefix swallow anything it does not own', () => {
    // Only the exact prefix plus a hyphen counts. 'ERAI-ONBCODEX...' is in no namespace.
    expect(classifySearch('ERAI-ONBCODEX-1').kind).toBe('text');
    expect(classifySearch('ERAI-ONBCODE').kind).toBe('text');
    expect(classifySearch('ERAI-ONB').kind).toBe('text');
  });

  it('treats ERAI-INT as an intern IDENTITY, never as an internship opportunity (F10)', () => {
    const intern = classifySearch('ERAI-INT-002184');
    expect(intern.kind).toBe('identity_code');
    expect(intern.searchable).toBe(false);
    expect(intern.belongsTo).toBe(SEARCH_ELSEWHERE.identity_code);
    expect(classifySearch('ERAI-OPP-2026-00421').kind).not.toBe(intern.kind);
  });

  it('files the remaining identity series under the identity registry', () => {
    for (const t of ['ERAI-EMP-002184', 'ERAI-FEL-000012', 'ERAI-MEM-000900']) {
      expect(classifySearch(t).kind).toBe('identity_code');
      expect(classifySearch(t).searchable).toBe(false);
    }
  });

  it('sends a selection reference to the selected-candidates console', () => {
    const r = classifySearch('ERAI-SEL-2026-000004');
    expect(r.kind).toBe('selection_code');
    expect(r.belongsTo).toBe('Selected candidates');
  });

  it('classifies by NAMESPACE, not by whether the digits are well formed', () => {
    // Somebody reaching for a person with a mistyped body is still reaching for a person, and
    // saying so is more useful than calling it free text.
    expect(classifySearch('ERAI-PER-oops').kind).toBe('person_code');
  });

  it('normalises an email exactly the way this platform normalises one', () => {
    const r = classifySearch('  Sid.Prasad@Example.COM ');
    expect(r.kind).toBe('email');
    expect(r.term).toBe('sid.prasad@example.com');
    expect(r.searchable).toBe(true);
  });

  it('does not call a half-typed address an email', () => {
    expect(classifySearch('sid@').kind).toBe('text');
    expect(classifySearch('@example.com').kind).toBe('text');
    expect(classifySearch('sid@example').kind).toBe('text');
  });

  it('treats nothing typed as no filter, not as an unanswerable search', () => {
    for (const v of ['', '   ', null, undefined]) {
      const r = classifySearch(v);
      expect(r.kind).toBe('empty');
      expect(r.term).toBe('');
      expect(r.searchable).toBe(true);
    }
  });

  it('leaves ordinary free text alone, trimmed', () => {
    const r = classifySearch('  Priya Nair  ');
    expect(r.kind).toBe('text');
    expect(r.term).toBe('Priya Nair');
    expect(r.searchable).toBe(true);
  });

  it('gives every kind it can return a label, and every unsearchable kind somewhere to go', () => {
    const kinds = Object.keys(SEARCH_KIND_LABELS) as SearchKind[];
    for (const k of kinds) expect(SEARCH_KIND_LABELS[k]).toBeTruthy();
    // Every namespace types.ts mints must classify to something, so a new prefix cannot quietly
    // fall through to "free text" and be searched as a name.
    for (const prefix of Object.values(ID_PREFIX)) {
      const r = classifySearch(prefix + '-2026-000001');
      expect(r.kind).not.toBe('text');
      if (!r.searchable) expect(r.belongsTo).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// STATUS BUCKETS — the tiles, the tabs and the counting query all read the same five arrays.
// ---------------------------------------------------------------------------------------------

describe('every candidate status lands in exactly one bucket', () => {
  it('covers all of CANDIDATE_STATUSES', () => {
    for (const s of CANDIDATE_STATUSES) {
      expect(statusBucket(s)).not.toBe('unknown');
    }
  });

  it('never puts one status in two buckets', () => {
    const all = [
      ...IN_PROGRESS_STATUSES, ...DECIDED_STATUSES, ...ONBOARDING_STATUSES_C,
      ...JOINED_STATUSES, ...CLOSED_STATUSES,
    ];
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(CANDIDATE_STATUSES.length);
  });

  it('reports an unrecognised status as unknown rather than filing it under closed', () => {
    // Quietly bucketing a status this build has not heard of would make a live candidate disappear
    // from the register instead of showing up somewhere visible.
    expect(statusBucket('teleported')).toBe('unknown');
    expect(statusBucket('')).toBe('unknown');
  });

  it('places the statuses whose bucket is easy to get wrong', () => {
    expect(statusBucket('final_review')).toBe('in_progress');
    expect(statusBucket('waitlisted')).toBe('decided');
    expect(statusBucket('onboarding_approved')).toBe('onboarding');
    expect(statusBucket('active')).toBe('joined');
    expect(statusBucket('withdrawn')).toBe('closed');
  });
});

describe('resolveStatusFilter turns a query string into statuses, never into an empty register', () => {
  it('resolves a bucket key to its statuses', () => {
    expect(resolveStatusFilter('decided')).toEqual(DECIDED_STATUSES);
    const inProg = resolveStatusFilter('in_progress');
    expect(inProg).toHaveLength(IN_PROGRESS_STATUSES.length);
  });

  it('resolves a single status to itself', () => {
    expect(resolveStatusFilter('shortlisted')).toEqual(['shortlisted']);
  });

  it('treats nothing and "all" as no filter', () => {
    expect(resolveStatusFilter('')).toBeNull();
    expect(resolveStatusFilter('all')).toBeNull();
    expect(resolveStatusFilter(undefined)).toBeNull();
  });

  it('treats an unrecognised value as NO FILTER, not as no rows', () => {
    // The dangerous direction. A filter value this build does not know must not produce an empty
    // table that an operator reads as "there are no candidates".
    expect(resolveStatusFilter('selected_maybe')).toBeNull();
    expect(resolveStatusFilter("'; DROP TABLE tal_person; --")).toBeNull();
    expect(resolveStatusFilter(42)).toBeNull();
  });

  it('knows every bucket and nothing else', () => {
    const buckets: StatusBucket[] = ['in_progress', 'decided', 'onboarding', 'joined', 'closed'];
    for (const b of buckets) expect(statusesInBucket(b).length).toBeGreaterThan(0);
    expect(statusesInBucket('nonsense')).toEqual([]);
  });
});

describe('statusLiteralList only ever emits statuses the contract knows', () => {
  it('quotes a known list', () => {
    expect(statusLiteralList(['selected', 'waitlisted'])).toBe("'selected', 'waitlisted'");
  });

  it('drops anything that is not a CandidateStatus', () => {
    // This is what makes it safe to hand to sql.raw(). Nothing from a request can survive the
    // membership test, and a list that empties out becomes a literal that matches no row.
    expect(statusLiteralList(['selected', "x'; DROP TABLE tal_person; --"])).toBe("'selected'");
    expect(statusLiteralList([])).toBe("''");
    expect(statusLiteralList(['nope'])).toBe("''");
  });
});

// ---------------------------------------------------------------------------------------------
// MERGE RULES — F2. Nothing here decides a merge; these only decide whether a HUMAN may.
// ---------------------------------------------------------------------------------------------

describe('confidenceBand is advisory and refuses to read a number that is not a confidence', () => {
  it('bands the unit interval', () => {
    expect(confidenceBand(0.97)).toBe('strong');
    expect(confidenceBand(0.9)).toBe('strong');
    expect(confidenceBand(0.75)).toBe('possible');
    expect(confidenceBand(0.6)).toBe('possible');
    expect(confidenceBand(0.59)).toBe('weak');
    expect(confidenceBand(0)).toBe('weak');
  });

  it('reads a NUMERIC column that arrives as a string', () => {
    // postgres-js hands NUMERIC back as text. A band computed off NaN would read "weak" for a
    // proposal the matcher was certain about.
    expect(confidenceBand('0.940')).toBe('strong');
    expect(confidenceBand('0.500')).toBe('weak');
  });

  it('says nothing rather than something when no confidence was recorded', () => {
    for (const v of [null, undefined, '', 'high', NaN]) expect(confidenceBand(v)).toBe('unstated');
  });

  it('reports a value outside 0..1 as unstated rather than rounding it into a band', () => {
    // NUMERIC(4,3) accepts 9.999. A writer that stored 5 meant something this scale cannot say.
    expect(confidenceBand(5)).toBe('unstated');
    expect(confidenceBand(-0.2)).toBe('unstated');
  });

  it('labels every band', () => {
    for (const b of ['strong', 'possible', 'weak', 'unstated'] as const) {
      expect(CONFIDENCE_BAND_LABELS[b]).toBeTruthy();
    }
  });
});

describe('evidenceSignals says what matched and never what it matched', () => {
  it('returns the axes, humanised', () => {
    expect(evidenceSignals({ email: 'sid@example.com' })).toEqual(['Email']);
    expect(evidenceSignals({ phone_number: '+919812345678' })).toEqual(['Phone number']);
    expect(evidenceSignals({ externalRef: 'X-1' })).toEqual(['External ref']);
  });

  it('LEAKS NO VALUE, which is the point of the function', () => {
    const out = evidenceSignals({
      email: 'sid.prasad@example.com',
      phone: '+919812345678',
      government_id: 'ABCDE1234F',
    }).join(' | ');
    expect(out).not.toContain('@');
    expect(out).not.toContain('919812345678');
    expect(out).not.toContain('ABCDE1234F');
    expect(out).toContain('Government id');
  });

  it('caps a pathological evidence object rather than filling the row', () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 40; i++) big['key_' + i] = 'v';
    expect(evidenceSignals(big)).toHaveLength(8);
  });

  it('returns nothing for anything that is not an object', () => {
    for (const v of [null, undefined, '', 'email', 7, ['email']]) {
      expect(evidenceSignals(v)).toEqual([]);
    }
  });
});

describe('mergeDecisionProblem is the lock on an irreversible act', () => {
  const base = {
    status: 'proposed',
    keepPersonId: '11111111-1111-1111-1111-111111111111',
    mergePersonId: '22222222-2222-2222-2222-222222222222',
    reason: REASON,
  };

  it('allows a well-formed confirmation', () => {
    expect(mergeDecisionProblem(base, 'confirm')).toBeNull();
  });

  it('allows a well-formed rejection', () => {
    expect(mergeDecisionProblem(base, 'reject')).toBeNull();
  });

  it('refuses a proposal that has already been decided, in either direction', () => {
    for (const status of ['confirmed', 'rejected', '', 'proposed_maybe']) {
      expect(mergeDecisionProblem({ ...base, status }, 'confirm')).toBeTruthy();
      expect(mergeDecisionProblem({ ...base, status }, 'reject')).toBeTruthy();
    }
  });

  it('demands a written reason for BOTH decisions', () => {
    expect(mergeDecisionProblem({ ...base, reason: '' }, 'confirm')).toBeTruthy();
    expect(mergeDecisionProblem({ ...base, reason: '   ' }, 'reject')).toBeTruthy();
    expect(mergeDecisionProblem({ ...base, reason: 'yes' }, 'confirm')).toBeTruthy();
  });

  it('measures the reason after trimming, so whitespace is not a reason', () => {
    const justUnder = ' '.repeat(20) + 'a'.repeat(MIN_MERGE_REASON - 1) + ' '.repeat(20);
    const justOver = 'a'.repeat(MIN_MERGE_REASON);
    expect(mergeDecisionProblem({ ...base, reason: justUnder }, 'confirm')).toBeTruthy();
    expect(mergeDecisionProblem({ ...base, reason: justOver }, 'confirm')).toBeNull();
  });

  it('refuses a proposal that names one record twice', () => {
    expect(mergeDecisionProblem({ ...base, mergePersonId: base.keepPersonId }, 'confirm')).toBeTruthy();
    expect(mergeDecisionProblem({ ...base, mergePersonId: base.keepPersonId }, 'reject')).toBeTruthy();
  });

  it('refuses a proposal missing either record', () => {
    expect(mergeDecisionProblem({ ...base, keepPersonId: '' }, 'confirm')).toBeTruthy();
    expect(mergeDecisionProblem({ ...base, mergePersonId: '' }, 'confirm')).toBeTruthy();
  });

  it('refuses to CONFIRM into a record that has itself been folded away', () => {
    // This is the chain refusal. Building a chain would make one COALESCE hop insufficient and
    // scatter one human across three cards.
    const p = mergeDecisionProblem({ ...base, keepAlreadyMergedInto: 'x' }, 'confirm');
    expect(p).toBeTruthy();
    expect(String(p)).toContain('surviving record');
  });

  it('refuses to CONFIRM a record already folded somewhere else', () => {
    expect(mergeDecisionProblem({ ...base, mergeAlreadyMergedInto: 'somewhere' }, 'confirm')).toBeTruthy();
  });

  it('accepts a confirm when the record is already folded into THIS keeper', () => {
    // A retry after the proposal update failed half way. Re-running must be allowed, not refused
    // as a chain.
    expect(mergeDecisionProblem(
      { ...base, mergeAlreadyMergedInto: base.keepPersonId }, 'confirm',
    )).toBeNull();
  });

  it('still allows a REJECTION when either record has since been folded', () => {
    // "These are two different humans" stays true and stays worth recording.
    expect(mergeDecisionProblem({ ...base, keepAlreadyMergedInto: 'x' }, 'reject')).toBeNull();
    expect(mergeDecisionProblem({ ...base, mergeAlreadyMergedInto: 'y' }, 'reject')).toBeNull();
  });
});

describe('describeMergeEffect says what will happen before it happens', () => {
  const keep = { personCode: 'ERAI-PER-2026-000001', displayName: 'Priya Nair', applicationCount: 2 };
  const fold = { personCode: 'ERAI-PER-2026-000044', displayName: 'P Nair', applicationCount: 3 };

  it('names both records by code, so neither is identified by name alone', () => {
    const text = describeMergeEffect(keep, fold).join(' ');
    expect(text).toContain('ERAI-PER-2026-000001');
    expect(text).toContain('ERAI-PER-2026-000044');
  });

  it('states the combined application count the survivor will carry', () => {
    expect(describeMergeEffect(keep, fold).join(' ')).toContain('5 applications');
  });

  it('says plainly that it is not deleted and not reversible here', () => {
    const text = describeMergeEffect(keep, fold).join(' ');
    expect(text).toContain('not deleted');
    expect(text.toLowerCase()).toContain('cannot undo');
  });

  it('falls back to the code when a record has no name', () => {
    const anon = { personCode: 'ERAI-PER-2026-000099', displayName: '', applicationCount: 0 };
    expect(describeMergeEffect(keep, anon).join(' ')).toContain('ERAI-PER-2026-000099');
  });
});

describe('overlappingOpportunities surfaces the duplicate a merge will NOT resolve', () => {
  const a = [
    { opportunityId: 'o1', opportunityTitle: 'Research engineer' },
    { opportunityId: 'o2', opportunityTitle: 'Data analyst' },
  ];

  it('finds an opportunity both records applied to', () => {
    const b = [{ opportunityId: 'o2', opportunityTitle: 'Data analyst' }];
    expect(overlappingOpportunities(a, b)).toEqual(['Data analyst']);
  });

  it('finds nothing when the two records applied to different things', () => {
    expect(overlappingOpportunities(a, [{ opportunityId: 'o9', opportunityTitle: 'Tutor' }])).toEqual([]);
  });

  it('never repeats a title', () => {
    const b = [
      { opportunityId: 'o1', opportunityTitle: 'Research engineer' },
      { opportunityId: 'o1', opportunityTitle: 'Research engineer' },
    ];
    expect(overlappingOpportunities(a, b)).toEqual(['Research engineer']);
  });

  it('survives empty and missing lists', () => {
    expect(overlappingOpportunities([], a)).toEqual([]);
    expect(overlappingOpportunities(a, [])).toEqual([]);
    expect(overlappingOpportunities(null as any, null as any)).toEqual([]);
  });
});

describe('applicationsPhrase counts in words an operator reads without arithmetic', () => {
  it('handles nothing, one and many', () => {
    expect(applicationsPhrase(0)).toBe('no applications');
    expect(applicationsPhrase(1)).toBe('1 application');
    expect(applicationsPhrase(4)).toBe('4 applications');
  });

  it('never reports a negative or a fraction', () => {
    expect(applicationsPhrase(-3)).toBe('no applications');
    expect(applicationsPhrase(2.7)).toBe('2 applications');
    expect(applicationsPhrase(NaN as any)).toBe('no applications');
  });
});

// ---------------------------------------------------------------------------------------------
// THE SEARCH TERM REACHES A LIKE PREDICATE. What an operator types is a value, never a pattern.
// ---------------------------------------------------------------------------------------------

describe('likeTerm stops a typed character from becoming a wildcard', () => {
  it('wraps an ordinary term', () => {
    expect(likeTerm('Priya')).toBe('%Priya%');
  });

  // EVERY EXPECTATION BELOW IS String.raw, AND THAT IS THE POINT. Written as ordinary quoted
  // strings these read '%50\%%' and '%a\_b%' — but in JavaScript '\%' is just '%' and '\_' is
  // just '_', so the assertions compared the ESCAPED output against the UNESCAPED text and failed
  // while likeTerm() was doing exactly the right thing. A red bar over correct code is how an
  // unescaped LIKE pattern gets shipped by somebody "fixing" it.
  it('escapes a per-cent sign, which would otherwise match every row in the register', () => {
    // The failure this prevents is not an error: a search for "50%" would quietly return EVERYONE,
    // which an operator reads as "the filter is broken" and a careless one reads as a result set.
    expect(likeTerm('50%')).toBe(String.raw`%50\%%`);
    expect(likeTerm('%')).toBe(String.raw`%\%%`);
  });

  it('escapes an underscore, which would otherwise match any single character', () => {
    // Real identifiers and handles contain underscores. 'a_b' must not also find 'axb'.
    expect(likeTerm('a_b')).toBe(String.raw`%a\_b%`);
  });

  it('escapes the escape character itself, so a backslash cannot maim the pattern', () => {
    // THE INPUT WAS WRONG HERE TOO. 'a\b' in JavaScript is "a" followed by U+0008 BACKSPACE, not a
    // backslash, so this case never exercised the escape-the-escape rule in any form.
    expect(likeTerm(String.raw`a\b`)).toBe(String.raw`%a\\b%`);
  });

  it('survives an empty or absent term', () => {
    expect(likeTerm('')).toBe('%%');
    expect(likeTerm(null as any)).toBe('%%');
  });
});

// ---------------------------------------------------------------------------------------------
// THE PAGE'S TABS AND THE MODULE'S FILTER MUST BE THE SAME VOCABULARY. The register's status tabs
// are built from STATUS_BUCKET_LABELS and their keys are handed straight to resolveStatusFilter();
// a key that labelled a tab but resolved to no filter would render the whole register under a tab
// claiming to be a subset of it.
// ---------------------------------------------------------------------------------------------

describe('every bucket the screen can name is a bucket the filter can resolve', () => {
  it('resolves every labelled bucket to a non-empty status list', () => {
    const keys = Object.keys(STATUS_BUCKET_LABELS) as StatusBucket[];
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(STATUS_BUCKET_LABELS[k]).toBeTruthy();
      const resolved = resolveStatusFilter(k);
      expect(resolved).not.toBeNull();
      expect((resolved || []).length).toBeGreaterThan(0);
      // And the list survives the whitelist that guards sql.raw() intact, so the tab and the tile
      // it filters cannot count different things.
      expect(statusLiteralList(resolved || [])).not.toBe("''");
    }
  });

  it('labels exactly the buckets statusBucket can return, and no others', () => {
    const labelled = new Set(Object.keys(STATUS_BUCKET_LABELS));
    const produced = new Set(CANDIDATE_STATUSES.map((s) => statusBucket(s)));
    for (const b of produced) expect(labelled.has(String(b))).toBe(true);
    for (const k of labelled) expect(produced.has(k as StatusBucket)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// A REFERENCE THIS REGISTER CANNOT ANSWER MUST ALWAYS HAVE SOMEWHERE TO SEND THE OPERATOR.
// ---------------------------------------------------------------------------------------------

describe('SEARCH_ELSEWHERE covers every unanswerable kind and nothing that is answerable', () => {
  it('gives a destination to each kind the register refuses, and none to the ones it answers', () => {
    const kinds = Object.keys(SEARCH_KIND_LABELS) as SearchKind[];
    let unsearchableSeen = 0;
    for (const prefix of Object.values(ID_PREFIX)) {
      const r = classifySearch(prefix + '-2026-000001');
      if (r.searchable) {
        expect(r.belongsTo).toBeNull();
      } else {
        unsearchableSeen += 1;
        expect(r.belongsTo).toBe(SEARCH_ELSEWHERE[r.kind]);
        expect(String(r.belongsTo).length).toBeGreaterThan(0);
      }
    }
    expect(unsearchableSeen).toBeGreaterThan(0);
    // No orphan entry either: a destination for a kind that never turns up is dead copy.
    for (const k of Object.keys(SEARCH_ELSEWHERE)) expect(kinds).toContain(k as SearchKind);
  });

  it('never sends free text or an email anywhere else', () => {
    expect(classifySearch('Priya Nair').belongsTo).toBeNull();
    expect(classifySearch('priya@example.com').belongsTo).toBeNull();
    expect(classifySearch('').belongsTo).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// "NOBODY APPLIED" AND "WE COULD NOT READ WHO APPLIED" RENDER AS THE SAME BLANK SPACE AND MEAN
// OPPOSITE THINGS. This is the dominant defect class in this repository, and the register is where
// it costs the most: the card underneath an empty application list says "no application recorded
// against this person yet", which on a failed read tells a real candidate there is no record of
// them. toCandidate() must therefore report WHICH of the two happened, never just the empty list.
// ---------------------------------------------------------------------------------------------

describe('toCandidate tells an empty application list from an unreadable one', () => {
  const app = {
    application_id: 'a1', application_code: 'ERAI-APP-2026-000001',
    opportunity_id: 'o1', status: 'shortlisted', submitted_at: '2026-08-01T00:00:00Z',
  };
  const base = { id: 'p1', person_code: 'ERAI-PER-2026-000001', display_name: 'Priya Nair' };

  it('reads a nested array as applications, and calls that readable', () => {
    const c = toCandidate({ ...base, applications: [app] });
    expect(c.applicationCount).toBe(1);
    expect(c.applicationsUnreadable).toBe(false);
    expect(c.applications[0].applicationCode).toBe('ERAI-APP-2026-000001');
  });

  it('reads the same payload handed back as TEXT by the driver', () => {
    const c = toCandidate({ ...base, applications: JSON.stringify([app]) });
    expect(c.applicationCount).toBe(1);
    expect(c.applicationsUnreadable).toBe(false);
  });

  it('calls a genuinely empty list empty, and NOT unreadable', () => {
    // The honest empty. A person with a candidate profile and no application reaches this, and the
    // screen is right to say they have never applied.
    expect(toCandidate({ ...base, applications: [] }).applicationsUnreadable).toBe(false);
    expect(toCandidate({ ...base, applications: '[]' }).applicationsUnreadable).toBe(false);
    expect(toCandidate({ ...base, applications: [] }).applicationCount).toBe(0);
  });

  it('FLAGS a payload that will not parse instead of reporting no applications', () => {
    // THE ASSERTION THIS BLOCK EXISTS FOR. Before the flag, this row rendered identically to the
    // one above: a person with no applications. The count is still zero — there is nothing to
    // show — but the flag is what stops the screen making a claim about the candidate.
    const c = toCandidate({ ...base, applications: '{"not":' });
    expect(c.applicationCount).toBe(0);
    expect(c.applicationsUnreadable).toBe(true);
  });

  it('flags valid JSON that is not a list of applications', () => {
    // json_agg cannot produce these, so anything that does is a shape this code does not understand
    // and must not be read as an answer about the person.
    for (const payload of ['{}', '"text"', '42', 'null']) {
      expect(toCandidate({ ...base, applications: payload }).applicationsUnreadable).toBe(true);
    }
    expect(toCandidate({ ...base, applications: { a: 1 } }).applicationsUnreadable).toBe(true);
  });

  it('treats an absent column as nothing to report rather than as a failure', () => {
    // A row that never carried the aggregate at all is not evidence of a broken read.
    expect(toCandidate({ ...base }).applicationsUnreadable).toBe(false);
    expect(toCandidate({ ...base, applications: null }).applicationsUnreadable).toBe(false);
  });

  it('never invents a person out of a row it could not read', () => {
    const c = toCandidate({});
    expect(c.personId).toBe('');
    expect(c.applicationCount).toBe(0);
  });
});
