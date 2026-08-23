// The admission rules of the signal engine, asserted against the code that enforces them.
//
// WHY THIS SUITE IS THE BIG ONE. Every rule this patch exists to uphold — nothing high-impact from
// inference alone, Attention costs more, non-evidential input is never load-bearing, a closed signal
// reopens only on new evidence — is a pure function in signal-contract.ts, and a pure function is the
// only kind of rule that can be tested exhaustively before it is ever pointed at a real person. If
// these pass, the engine's job is reduced to moving rows.
import { describe, it, expect } from 'vitest';
import { DEFAULT_ORGANISATION_ID, employeeSubject, newHorizonId, validateSignal, type Evidence } from '@/lib/horizon';
import {
  admit,
  ATTENTION_RANK,
  BAND_SEVERITY,
  BAND_TTL_DAYS,
  confidenceFor,
  cooldownEndsAt,
  COOLDOWN_HOURS,
  decisionNamedIn,
  dedupeKeyFor,
  escalates,
  evidenceProfile,
  evidenceRefOf,
  explain,
  newEvidenceRefs,
  notificationDecision,
  reactivatingEvidence,
  toSharedSignal,
  ATTENTION_BANDS,
  CONFIDENCE_CEILING,
  type AdmittedSignal,
  type ExistingSignalState,
  type SignalCandidate,
} from './signal-contract';

const NOW = new Date('2026-08-23T10:00:00.000Z');
const EMP = '11111111-1111-1111-1111-111111111111';

/** `sourceId` is given bare in these tests and namespaced here, so the stored form is compared. */
function ev(over: Partial<Evidence> & { sourceId?: string } = {}): Evidence {
  const { sourceId, ...rest } = over;
  return {
    id: newHorizonId('evidence'),
    sourceType: 'training_record',
    sourceId: 'hr_events:' + (sourceId || 'a1'),
    timestamp: '2026-08-01T00:00:00.000Z',
    relevance: { value: 0.8, band: 'high', basis: 'Inside the window this signal covers.' },
    reliability: { value: 0.9, band: 'high', basis: 'Recorded by this platform at the time.' },
    summary: 'Completed a course',
    rawReference: { ownerModule: 'src/lib/hr-events.ts', table: 'hr_events', recordId: sourceId || 'a1' },
    evidenceClass: 'demonstrated',
    layer: 'raw',
    collectedUnder: 'organisational_record',
    organisationId: DEFAULT_ORGANISATION_ID,
    ...rest,
  } as Evidence;
}

function candidate(over: Partial<SignalCandidate> = {}): SignalCandidate {
  return {
    detectorKey: 'test_detector',
    detectorVersion: '1.0.0',
    band: 'blue',
    category: 'growth_opportunity',
    dimension: 'capability',
    title: 'Something Changed',
    whatChanged: 'Two evidenced things happened in the last ninety days.',
    subject: employeeSubject(EMP as any),
    evidence: [ev()],
    inputs: [{ source: 'hr_events', description: 'CourseCompleted rows in the window.' }],
    processing: 'Counted the rows in one window and compared them with a named threshold.',
    recommendedActions: [
      { key: 'talk', label: 'Have a conversation about what this makes possible.', addressedTo: 'reporting_manager' },
    ],
    periodStart: '2026-05-25T00:00:00.000Z',
    periodEnd: NOW.toISOString(),
    touchesDecision: null,
    ...over,
  };
}

function admitted(over: Partial<SignalCandidate> = {}): AdmittedSignal {
  const r = admit(candidate(over), NOW);
  if (!r.ok) throw new Error('expected admit to succeed: ' + r.refusals.join(' / '));
  return r.signal;
}

// -------------------------------------------------------------------------------------------------
describe('the band vocabulary sits on the shared severity', () => {
  it('has four bands, one per shared severity', () => {
    expect(ATTENTION_BANDS.length).toBe(4);
    expect(BAND_SEVERITY.green).toBe('info');
    expect(BAND_SEVERITY.blue).toBe('low');
    expect(BAND_SEVERITY.yellow).toBe('medium');
    expect(BAND_SEVERITY.red).toBe('high');
  });

  it('ranks attention rather than goodness', () => {
    expect(ATTENTION_RANK.red).toBeGreaterThan(ATTENTION_RANK.yellow);
    // Opportunity sits at the bottom because it can wait until Tuesday, not because it is bad news.
    expect(ATTENTION_RANK.green).toBeLessThan(ATTENTION_RANK.blue);
  });

  it('escalates only upward', () => {
    expect(escalates('yellow', 'red')).toBe(true);
    expect(escalates('red', 'yellow')).toBe(false);
    expect(escalates('blue', 'blue')).toBe(false);
  });

  it('gives Attention the shortest cooldown and the shortest life', () => {
    expect(COOLDOWN_HOURS.red).toBeLessThan(COOLDOWN_HOURS.yellow);
    expect(BAND_TTL_DAYS.red).toBeLessThan(BAND_TTL_DAYS.green);
    expect(cooldownEndsAt('red', NOW)).toBe(new Date(NOW.getTime() + 12 * 3600000).toISOString());
  });
});

// -------------------------------------------------------------------------------------------------
describe('evidence is read without being flattered', () => {
  it('counts distinct source types, not distinct items', () => {
    const p = evidenceProfile([
      ev({ sourceId: 'a' }),
      ev({ sourceId: 'b' }),
      ev({ sourceId: 'c', sourceType: 'capability_evidence' }),
    ]);
    expect(p.total).toBe(3);
    expect(p.distinctSourceTypes.length).toBe(2);
    expect(p.loadBearingCount).toBe(3);
  });

  it('sets non-evidential context aside entirely', () => {
    const p = evidenceProfile([
      ev({ sourceId: 'a' }),
      ev({ sourceId: 'x', sourceType: 'system_computation', evidenceClass: 'non_evidential' }),
    ]);
    expect(p.nonEvidentialCount).toBe(1);
    expect(p.weighted).toBe(1);
    expect(p.strongestClass).toBe('demonstrated');
    expect(p.distinctSourceTypes).toEqual(['training_record']);
  });

  it('knows when there is nothing but context', () => {
    const p = evidenceProfile([ev({ sourceId: 'x', evidenceClass: 'non_evidential' })]);
    expect(p.nonEvidentialOnly).toBe(true);
    expect(p.weighted).toBe(0);
  });

  it('identifies evidence by the row it points at, not by its wording', () => {
    expect(evidenceRefOf(ev({ sourceId: 'a' }))).toBe('training_record:hr_events:a');
    expect(evidenceRefOf(ev({ sourceId: 'a', summary: 'reworded entirely' }))).toBe('training_record:hr_events:a');
  });
});

// -------------------------------------------------------------------------------------------------
describe('confidence shows its working and never reaches certainty', () => {
  it('never exceeds the ceiling', () => {
    const c = confidenceFor(
      evidenceProfile([
        ev({ sourceId: 'a' }),
        ev({ sourceId: 'b', sourceType: 'capability_evidence' }),
        ev({ sourceId: 'c', sourceType: 'performance_review' }),
        ev({ sourceId: 'd', sourceType: 'interview' }),
      ]),
      NOW,
    );
    expect(c.value).toBeLessThanOrEqual(CONFIDENCE_CEILING);
  });

  it('states every term that produced the number, and the shared basis is those terms', () => {
    const c = confidenceFor(evidenceProfile([ev()]), NOW);
    expect(c.terms.length).toBeGreaterThan(1);
    expect(c.basis).toBe(c.terms.join(' '));
  });

  it('drops for stale evidence', () => {
    const fresh = confidenceFor(evidenceProfile([ev({ timestamp: '2026-08-20T00:00:00.000Z' })]), NOW);
    const stale = confidenceFor(evidenceProfile([ev({ timestamp: '2026-01-01T00:00:00.000Z' })]), NOW);
    expect(stale.value).toBeLessThan(fresh.value);
  });

  it('sits at the floor when nothing carries weight', () => {
    const c = confidenceFor(evidenceProfile([ev({ evidenceClass: 'non_evidential' })]), NOW);
    expect(c.value).toBe(0.05);
  });

  it('is not moved either way by non-evidential context', () => {
    const without = confidenceFor(evidenceProfile([ev({ sourceId: 'a' })]), NOW);
    const with_ = confidenceFor(
      evidenceProfile([ev({ sourceId: 'a' }), ev({ sourceId: 'x', evidenceClass: 'non_evidential' })]),
      NOW,
    );
    expect(with_.value).toBe(without.value);
  });
});

// -------------------------------------------------------------------------------------------------
describe('admission refuses rather than half-raising', () => {
  it('refuses a signal with no evidence', () => {
    const r = admit(candidate({ evidence: [] }), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals.join(' ')).toContain('at least one piece of evidence');
  });

  it('refuses a signal built only on non-evidential context', () => {
    const r = admit(candidate({ evidence: [ev({ evidenceClass: 'non_evidential' })] }), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals.join(' ')).toContain('non-evidential');
  });

  it('refuses a signal that cannot say what changed or how it was computed', () => {
    expect(admit(candidate({ whatChanged: 'up' }), NOW).ok).toBe(false);
    expect(admit(candidate({ processing: '' }), NOW).ok).toBe(false);
  });

  it('refuses a signal with no recommended action addressed to anybody', () => {
    expect(admit(candidate({ recommendedActions: [] }), NOW).ok).toBe(false);
  });

  it('refuses a recommended action that is really a decision', () => {
    const r = admit(
      candidate({
        recommendedActions: [
          { key: 'x', label: 'Terminate the contract at the end of the month.', addressedTo: 'hr_leadership' },
        ],
      }),
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals.join(' ')).toContain('reads as a decision');
  });

  it('refuses forbidden terminology anywhere in its own words', () => {
    const r = admit(candidate({ whatChanged: 'Their birth chart indicates a change in direction.' }), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals.join(' ')).toContain('forbidden terminology');
  });

  it('names the decision words it will not accept', () => {
    expect(decisionNamedIn('We should promote her')).toBe('promote');
    expect(decisionNamedIn('Consider a wider brief')).toBe(null);
  });
});

// -------------------------------------------------------------------------------------------------
describe('nothing high-impact rests on inference alone', () => {
  it('refuses a promotion-adjacent signal with only derived evidence', () => {
    const r = admit(
      candidate({
        touchesDecision: 'promotion',
        evidence: [ev({ sourceId: 'd1', sourceType: 'system_computation', evidenceClass: 'inferred' })],
      }),
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals.join(' ')).toContain('no demonstrated or observed evidence');
  });

  it('refuses one built on what somebody merely stated', () => {
    const r = admit(
      candidate({ touchesDecision: 'compensation', evidence: [ev({ evidenceClass: 'stated' })] }),
      NOW,
    );
    expect(r.ok).toBe(false);
  });

  it('admits one that carries a demonstrated record, and forces HR review on it', () => {
    const r = admit(candidate({ touchesDecision: 'promotion' }), NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.signal.humanReviewRequired).toBe(true);
      expect(r.signal.reviewerKind).toBe('hr');
    }
  });
});

// -------------------------------------------------------------------------------------------------
describe('Attention costs more', () => {
  it('downgrades an Attention with one source type to a Watch, and says why', () => {
    const r = admit(candidate({ band: 'red' }), NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.signal.band).toBe('yellow');
      expect(r.signal.downgradedFrom).toBe('red');
      expect(String(r.signal.downgradeReason)).toContain('distinct source types');
    }
  });

  it('downgrades an Attention whose corroboration is only derived', () => {
    const r = admit(
      candidate({
        band: 'red',
        evidence: [
          ev({ sourceId: 'a', sourceType: 'task', evidenceClass: 'stated' }),
          ev({ sourceId: 'b', sourceType: 'system_computation', evidenceClass: 'inferred' }),
        ],
      }),
      NOW,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.signal.band).toBe('yellow');
  });

  it('admits an Attention with two source types and a demonstrated record', () => {
    const r = admit(
      candidate({
        band: 'red',
        evidence: [
          ev({ sourceId: 'a' }),
          ev({ sourceId: 'b', sourceType: 'system_computation', evidenceClass: 'inferred' }),
        ],
      }),
      NOW,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.signal.band).toBe('red');
      expect(r.signal.severity).toBe('high');
      expect(r.signal.downgradedFrom).toBe(null);
      expect(r.signal.humanReviewRequired).toBe(true);
      expect(r.signal.reviewerKind).toBe('hr');
    }
  });

  it('leaves an Opportunity needing no review', () => {
    const r = admit(candidate({ band: 'green' }), NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.signal.humanReviewRequired).toBe(false);
      expect(r.signal.reviewerKind).toBe('none');
    }
  });
});

// -------------------------------------------------------------------------------------------------
describe('what it hands the shared contract', () => {
  it('produces a Signal the shared validator accepts', () => {
    const s = admitted();
    const shared = toSharedSignal(s, {
      id: newHorizonId('signal'),
      evidenceIds: s.evidence.map((e) => String(e.id)),
      organisationId: DEFAULT_ORGANISATION_ID,
    });
    const v = validateSignal(shared);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('always expires, because a signal that never expires is a permanent mark', () => {
    const s = admitted();
    expect(Date.parse(s.expiresAt)).toBeGreaterThan(Date.parse(s.periodEnd));
  });

  it('never claims it may decide anything', () => {
    for (const band of ATTENTION_BANDS) {
      const s = admit(
        candidate({
          band,
          evidence: [
            ev({ sourceId: 'a' }),
            ev({ sourceId: 'b', sourceType: 'system_computation', evidenceClass: 'inferred' }),
          ],
        }),
        NOW,
      );
      // Compared as a STRING. The builder narrows decisionUse to the two values it can currently
      // produce, so `=== 'may_decide'` is a type error rather than an assertion — and the assertion
      // is the point: it has to keep failing loudly if a third value is ever admitted.
      if (s.ok) expect(String(s.signal.decisionUse) === 'may_decide').toBe(false);
    }
  });
});

// -------------------------------------------------------------------------------------------------
describe('the dedupe key is the finding, not the reading of it', () => {
  it('is the same when the band and the evidence change', () => {
    const a = dedupeKeyFor(candidate({ band: 'yellow' }));
    const b = dedupeKeyFor(candidate({ band: 'red', evidence: [ev({ sourceId: 'zzz' })] }));
    expect(a).toBe(b);
  });

  it('differs by person, by detector and by dimension', () => {
    const base = dedupeKeyFor(candidate());
    expect(base).not.toBe(dedupeKeyFor(candidate({ detectorKey: 'other' })));
    expect(base).not.toBe(dedupeKeyFor(candidate({ dimension: 'learning' })));
    expect(base).not.toBe(
      dedupeKeyFor(candidate({ subject: employeeSubject('22222222-2222-2222-2222-222222222222' as any) })),
    );
  });
});

// -------------------------------------------------------------------------------------------------
describe('nobody is told the same thing twice', () => {
  function existing(over: Partial<ExistingSignalState> = {}): ExistingSignalState {
    return {
      signalId: 'sig-1',
      band: 'yellow',
      status: 'open',
      evidenceRefs: ['training_record:hr_events:a1'],
      lastNotifiedAt: '2026-08-22T10:00:00.000Z',
      cooldownUntil: '2026-08-25T10:00:00.000Z',
      closedAt: null,
      occurrenceCount: 1,
      ...over,
    };
  }

  const worse = () =>
    admitted({
      band: 'red',
      evidence: [ev({ sourceId: 'a1' }), ev({ sourceId: 'b', sourceType: 'system_computation', evidenceClass: 'inferred' })],
    });

  it('notifies the first time', () => {
    const d = notificationDecision(null, admitted(), NOW);
    expect(d.action).toBe('insert');
    expect(d.notify).toBe(true);
  });

  it('says nothing when the same evidence comes round again', () => {
    const d = notificationDecision(existing(), admitted(), NOW);
    expect(d.action).toBe('update');
    expect(d.notify).toBe(false);
    expect(d.newEvidenceRefs.length).toBe(0);
  });

  it('holds new evidence quiet inside the cooldown', () => {
    const d = notificationDecision(existing(), admitted({ evidence: [ev({ sourceId: 'new1' })] }), NOW);
    expect(d.action).toBe('update');
    expect(d.notify).toBe(false);
    expect(d.reason).toContain('cooldown');
    expect(d.newEvidenceRefs).toEqual(['training_record:hr_events:new1']);
  });

  it('speaks again once the cooldown has passed', () => {
    const d = notificationDecision(
      existing({ cooldownUntil: '2026-08-01T00:00:00.000Z' }),
      admitted({ evidence: [ev({ sourceId: 'new1' })] }),
      NOW,
    );
    expect(d.notify).toBe(true);
  });

  it('breaks its own cooldown when the finding gets worse', () => {
    const d = notificationDecision(existing(), worse(), NOW);
    expect(d.action).toBe('escalate');
    expect(d.notify).toBe(true);
  });

  it('does not re-notify somebody who has already acknowledged it', () => {
    const d = notificationDecision(
      existing({ status: 'acknowledged', cooldownUntil: '2026-08-01T00:00:00.000Z' }),
      admitted({ evidence: [ev({ sourceId: 'new1' })] }),
      NOW,
    );
    expect(d.action).toBe('update');
    expect(d.notify).toBe(false);
    expect(d.newEvidenceRefs).toEqual(['training_record:hr_events:new1']);
  });

  it('still escalates past an acknowledgement', () => {
    expect(notificationDecision(existing({ status: 'acknowledged' }), worse(), NOW).action).toBe('escalate');
  });
});

// -------------------------------------------------------------------------------------------------
describe('a closed signal stays closed unless something new happened', () => {
  const closed: ExistingSignalState = {
    signalId: 'sig-2',
    band: 'yellow',
    status: 'resolved',
    evidenceRefs: ['training_record:hr_events:a1'],
    lastNotifiedAt: '2026-07-01T00:00:00.000Z',
    cooldownUntil: null,
    closedAt: '2026-08-10T00:00:00.000Z',
    occurrenceCount: 3,
  };

  it('suppresses a re-detection with the same evidence', () => {
    const d = notificationDecision(closed, admitted(), NOW);
    expect(d.action).toBe('suppress');
    expect(d.notify).toBe(false);
  });

  it('suppresses evidence that is new to the row but predates the resolution', () => {
    const backfilled = admitted({ evidence: [ev({ sourceId: 'old', timestamp: '2026-06-01T00:00:00.000Z' })] });
    expect(newEvidenceRefs(closed, backfilled).length).toBe(1);
    expect(reactivatingEvidence(closed, backfilled).length).toBe(0);
    expect(notificationDecision(closed, backfilled, NOW).action).toBe('suppress');
  });

  it('reopens on evidence dated after it was resolved', () => {
    const fresh = admitted({ evidence: [ev({ sourceId: 'new', timestamp: '2026-08-20T00:00:00.000Z' })] });
    const d = notificationDecision(closed, fresh, NOW);
    expect(d.action).toBe('reactivate');
    expect(d.notify).toBe(true);
    expect(d.newEvidenceRefs).toEqual(['training_record:hr_events:new']);
  });

  it('treats a dismissal and an expiry the same way as a resolution', () => {
    expect(notificationDecision({ ...closed, status: 'dismissed' }, admitted(), NOW).action).toBe('suppress');
    expect(notificationDecision({ ...closed, status: 'expired' }, admitted(), NOW).action).toBe('suppress');
  });
});

// -------------------------------------------------------------------------------------------------
describe('every signal can explain itself', () => {
  it('answers all six parts of the chain', () => {
    const e = explain(admitted(), NOW);
    expect(e.inputs.length).toBeGreaterThan(0);
    expect(e.processing.length).toBeGreaterThan(10);
    expect(e.output.title).toBe('Something Changed');
    expect(e.evidence.length).toBe(1);
    expect(e.confidence.terms.length).toBeGreaterThan(0);
    expect(e.timestamp.computedAt).toBe(NOW.toISOString());
    expect(e.timestamp.expiresAt.length).toBeGreaterThan(0);
    expect(e.humanReview.note).toContain('human');
  });

  it('says out loud when context was present and excluded', () => {
    const e = explain(admitted({ evidence: [ev({ sourceId: 'a' }), ev({ sourceId: 'x', evidenceClass: 'non_evidential' })] }), NOW);
    expect(String(e.contextNote)).toContain('excluded');
  });

  it('says nothing about context when there was none', () => {
    expect(explain(admitted(), NOW).contextNote).toBe(null);
  });
});
