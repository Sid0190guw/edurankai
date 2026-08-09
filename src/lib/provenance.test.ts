// Tests for the provenance layer. Storage is not exercised here — these are about the RULE, which
// is the part that decides what a screen is allowed to say about a person.
//
// The five properties every test below is really defending:
//   1. AN INFERENCE NEVER BECOMES A FACT. Not by mutation, not by construction, not by verification,
//      and not by a round trip through a row.
//   2. A VERIFIED ELEMENT EXISTS ONLY BECAUSE A NAMED HUMAN MADE IT, with a reason and a method.
//   3. AN ADVISORY ELEMENT NEVER CARRIES THE WEIGHT OF A RECORD ON A SCREEN.
//   4. A PROTECTED ATTRIBUTE IS NEVER DERIVED AND NEVER DECIDES ANYTHING.
//   5. A FIELD THIS PRODUCT PROMISED NOT TO HOLD CANNOT BE ANNOTATED INTO EXISTENCE.
import { describe, it, expect, vi } from 'vitest';

// The module reaches for the database, the audit log and the schema-ensure at import time through
// the @/ alias, which vitest does not resolve in this project (there is no vitest config, and the
// alias lives in tsconfig for Astro's benefit). Nothing tested below touches any of the three:
// these are tests of the RULE — what may be constructed, what may be verified, and what a screen is
// allowed to print — and the rule holds with no database anywhere near it. Same stubbing pattern as
// src/lib/legal-hold.test.ts.
vi.mock('@/lib/db', () => ({ db: { execute: vi.fn(async () => []) } }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock('@/lib/ensure-once', () => ({
  ensureOnce: async (_k: string, fn: () => Promise<void>) => { try { await fn(); } catch { /* the caller asks information_schema, never this */ } },
}));

import {
  recordFact, recordProvided, recordInference, recordCalculation, recordPrediction,
  recordRecommendation, verify, withdrawVerification, checkAgainstValue, elementFromRow,
  renderProvenance, provenanceSentence, renderUnreadable, explainElement, mayDecideOn,
  isProtectedField, isForbiddenField, isConsequentialDecision, fingerprintOf,
  ASSERTIONS, MIN_REASON_CHARS,
  type ElementInput, type ProvenanceElement, type UnverifiedElement, type VerifiedElement,
} from './provenance';

const ACTOR = '11111111-2222-4333-8444-555555555555';
const SUBJECT = '99999999-8888-4777-8666-555555555555';

const base = (over: Partial<ElementInput> = {}): ElementInput => ({
  entityType: 'hr_employee',
  entityId: SUBJECT,
  field: 'joining_date',
  value: '2026-01-05',
  source: { system: 'hire-completion', detail: null, actorUserId: null, actorName: null },
  owner: { kind: 'person', subjectKind: 'hr_employee', subjectId: SUBJECT, label: 'The employee' },
  ...over,
});

/** An inference with everything an inference owes the reader, so the test is about one thing. */
const goodInference = (over: Partial<ElementInput> = {}) => recordInference(base({
  field: 'primary_language',
  reasoning: 'Every submitted document on this record is in English.',
  basis: ['portal_submissions.language', 'applications.why_role'],
  uncertainty: 'Nobody has stated a language on this record; this is read off documents.',
  confidence: 0.6,
  ...over,
}));

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error('expected ok, got refusal: ' + r.error);
  return r.value;
};

const humanAct = (over: Record<string, unknown> = {}) => ({
  actorUserId: ACTOR,
  actorName: 'Priya Nair',
  reason: 'Checked against the signed offer letter on file.',
  method: 'document_seen' as const,
  ...over,
});

describe('the vocabulary', () => {
  it('has exactly the seven kinds, and each one says whether it may carry a confidence', () => {
    expect(ASSERTIONS.map((a) => a.key)).toEqual([
      'factual', 'explicitly_provided', 'inferred', 'calculated', 'verified', 'predicted', 'recommended',
    ]);
    for (const a of ASSERTIONS) {
      expect(a.needsConfidence && a.refusesConfidence).toBe(false);
    }
  });

  it('gives inferred, predicted and recommended advisory weight and nothing else', () => {
    const advisory = ASSERTIONS.filter((a) => a.weight === 'advisory').map((a) => a.key);
    expect(advisory).toEqual(['inferred', 'predicted', 'recommended']);
  });
});

describe('an inference cannot be promoted to a fact', () => {
  it('has no exported path from an element to a factual one', async () => {
    const mod: Record<string, unknown> = await import('./provenance');
    const suspicious = Object.keys(mod).filter((k) => /^(promote|upgrade|setAssertion|markFact|asFact)/i.test(k));
    expect(suspicious).toEqual([]);
  });

  it('refuses to record a capability as a fact of the platform, however it arrived', () => {
    const r = recordFact(base({ field: 'skill_level', value: 5 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('never a fact of this platform');
  });

  it('cannot be mutated into one', () => {
    const el = ok(goodInference());
    expect(Object.isFrozen(el)).toBe(true);
    try { (el as unknown as { assertion: string }).assertion = 'factual'; } catch { /* strict mode throws */ }
    expect(el.assertion).toBe('inferred');
  });

  it('stays an inference after a human verifies it, and says so in the sentence', () => {
    const el = ok(goodInference());
    const verified = ok(verify(el, humanAct({
      reason: 'Confirmed against the language declared on the signed contract.',
      evidence: [{ kind: 'document', id: null, label: 'Signed contract, clause 2', url: 'https://drive.google.com/file/d/abc/view' }],
    }), { relationship: 'reporting_manager' })) as VerifiedElement;

    expect(verified.assertion).toBe('verified');
    expect(verified.derivedFrom).toBe('inferred');
    expect(provenanceSentence(verified)).toContain('Before this it was an inference');
    expect(renderProvenance(verified).label).toBe('Verified');
    expect(provenanceSentence(verified)).not.toContain('record of its own act');
  });

  it('cannot be manufactured by a stored row either', () => {
    const refused = elementFromRow({
      entity_type: 'hr_employee', entity_id: SUBJECT, field: 'joining_date',
      assertion: 'verified', derived_from: null,
      verified_by_user_id: null, verification_reason: null, verified_at: null,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain('does not name who verified it');
  });

  it('refuses a stored verification that does not record what it was before', () => {
    const refused = elementFromRow({
      entity_type: 'hr_employee', entity_id: SUBJECT, field: 'joining_date',
      assertion: 'verified', derived_from: null,
      verified_by_user_id: ACTOR, verification_reason: 'Saw the letter.', verified_at: '2026-02-01T00:00:00Z',
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain('what it was before');
  });
});

describe('verification is a named human act or it does not happen', () => {
  const claim = () => ok(recordProvided(base({
    field: 'joining_date',
    source: { system: 'admin form', detail: null, actorUserId: ACTOR, actorName: 'Priya Nair' },
  })));

  it('refuses without an actor id', () => {
    const r = verify(claim(), humanAct({ actorUserId: 'not-a-uuid' }), { orgWide: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('name the person making it');
  });

  it('refuses without a name a record could be read with', () => {
    const r = verify(claim(), humanAct({ actorName: '' }), { orgWide: true });
    expect(r.ok).toBe(false);
  });

  it('refuses a reason too short to review later', () => {
    const r = verify(claim(), humanAct({ reason: 'ok' }), { orgWide: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(String(MIN_REASON_CHARS));
  });

  it('refuses without a method saying how it was checked', () => {
    const r = verify(claim(), humanAct({ method: undefined }), { orgWide: true });
    expect(r.ok).toBe(false);
  });

  it('refuses when neither a relationship nor the org-wide desk was passed', () => {
    const r = verify(claim(), humanAct(), {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Organization Graph');
  });

  it('refuses somebody confirming their own statement', () => {
    const r = verify(claim(), humanAct(), { self: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('does not verify it');
  });

  it('refuses to verify an inference with nothing named as evidence', () => {
    const r = verify(ok(goodInference()), humanAct({ evidence: [] }), { orgWide: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('not by agreeing with it');
  });

  it('refuses a prediction, a recommendation and a platform fact', () => {
    const prediction = ok(recordPrediction(base({
      field: 'projected_completion_date',
      owner: { kind: 'organization', subjectKind: null, subjectId: null, label: 'The organization' },
      reasoning: 'Two of four modules are complete at the current rate.',
      basis: ['training_enrollments.progress_pct'],
      uncertainty: 'The rate so far may not hold.',
      confidence: 0.5,
    })));
    expect(verify(prediction, humanAct(), { orgWide: true }).ok).toBe(false);

    const recommendation = ok(recordRecommendation(base({
      field: 'suggested_reviewer',
      owner: { kind: 'organization', subjectKind: null, subjectId: null, label: 'The organization' },
      reasoning: 'This reviewer has reviewed the same kind of work before.',
      basis: ['org_relationships.reviewer'],
      confidence: 0.4,
    })));
    expect(verify(recommendation, humanAct(), { orgWide: true }).ok).toBe(false);

    const fact = ok(recordFact(base({ field: 'record_created_at', value: '2026-01-05T09:00:00Z' })));
    expect(verify(fact, humanAct(), { orgWide: true }).ok).toBe(false);
  });

  it('refuses a second verification over an existing one', () => {
    const first = ok(verify(claim(), humanAct(), { orgWide: true }));
    const second = verify(first, humanAct({ actorName: 'Someone Else' }), { orgWide: true });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain('Withdraw');
  });

  it('records who, when, why and how, and keeps them all', () => {
    const v = ok(verify(claim(), humanAct(), { relationship: 'reporting_manager' })) as VerifiedElement;
    expect(v.verification.actorUserId).toBe(ACTOR);
    expect(v.verification.actorName).toBe('Priya Nair');
    expect(v.verification.method).toBe('document_seen');
    expect(v.verification.at.length).toBeGreaterThan(10);
    expect(v.history.map((h) => h.kind)).toEqual(['recorded', 'verified']);
  });

  it('puts the element back exactly where it was when a verification is withdrawn', () => {
    const v = ok(verify(claim(), humanAct(), { orgWide: true }));
    const back = ok(withdrawVerification(v, humanAct({ reason: 'The document turned out to be a draft.' }))) as UnverifiedElement;
    expect(back.assertion).toBe('explicitly_provided');
    expect(back.verification).toBeNull();
    expect(back.derivedFrom).toBeNull();
    expect(back.history.map((h) => h.kind)).toEqual(['recorded', 'verified', 'verification_withdrawn']);
  });

  it('refuses to withdraw what was never verified', () => {
    expect(withdrawVerification(claim(), humanAct({ reason: 'No longer needed at all.' })).ok).toBe(false);
  });
});

describe('what each kind owes the reader', () => {
  it('refuses an inference with no reasoning, no basis or no stated uncertainty', () => {
    expect(recordInference(base({ field: 'primary_language', basis: ['x'], uncertainty: 'y', confidence: 0.5 })).ok).toBe(false);
    expect(recordInference(base({ field: 'primary_language', reasoning: 'x', uncertainty: 'y', confidence: 0.5 })).ok).toBe(false);
    expect(recordInference(base({ field: 'primary_language', reasoning: 'x', basis: ['y'], confidence: 0.5 })).ok).toBe(false);
  });

  it('refuses an inference that will not say how sure it is', () => {
    const r = recordInference(base({ field: 'primary_language', reasoning: 'x', basis: ['y'], uncertainty: 'z' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('how sure');
  });

  it('refuses a confidence on a fact, because a fact is not a probability', () => {
    const r = recordFact(base({ field: 'record_created_at', confidence: 0.9 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('does not carry a confidence');
  });

  it('refuses a stated value that names nobody who stated it', () => {
    const r = recordProvided(base({ field: 'personal_email' }));
    expect(r.ok).toBe(false);
  });

  it('refuses a calculation that will not name its inputs', () => {
    expect(recordCalculation(base({ field: 'tenure_months', reasoning: 'Months between joining and today.' })).ok).toBe(false);
    expect(recordCalculation(base({
      field: 'tenure_months',
      reasoning: 'Months between joining and today.',
      basis: ['hr_employees.joining_date'],
    })).ok).toBe(true);
  });

  it('refuses a source that names nothing', () => {
    const r = recordFact(base({ field: 'record_created_at', source: { system: 'system' } }));
    expect(r.ok).toBe(false);
  });
});

describe('protected and sensitive attributes', () => {
  it('recognises them broadly', () => {
    for (const f of ['race', 'religion_declared', 'caste_category', 'sexual_orientation', 'disability_status',
      'health_condition', 'pregnancy_status', 'marital_status', 'political_affiliation']) {
      expect(isProtectedField(f)).toBe(true);
    }
  });

  it('refuses to infer, calculate, predict or recommend one', () => {
    for (const build of [recordInference, recordCalculation, recordRecommendation]) {
      const r = build(base({
        field: 'disability_status',
        reasoning: 'x', basis: ['y'], uncertainty: 'z', confidence: 0.5,
      }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('protected or sensitive attribute');
    }
  });

  it('allows only what the person provided themselves', () => {
    const r = recordProvided(base({
      field: 'disability_status',
      source: { system: 'accommodation request form', actorUserId: SUBJECT, actorName: 'The employee' },
    }));
    expect(r.ok).toBe(true);
  });

  it('never lets one decide anything, and never lets one be verified', () => {
    const el = ok(recordProvided(base({
      field: 'disability_status',
      source: { system: 'accommodation request form', actorUserId: SUBJECT, actorName: 'The employee' },
    })));
    expect(mayDecideOn(el, 'ordinary').allowed).toBe(false);
    expect(mayDecideOn(el, 'high').allowed).toBe(false);
    expect(verify(el, humanAct(), { orgWide: true }).ok).toBe(false);
  });
});

describe('fields this system will not hold at all', () => {
  it('recognises the person-outcome predictions and the surveillance signals', () => {
    for (const f of ['attrition_risk', 'flight_risk_score', 'culture_fit', 'personality_type',
      'engagement_score', 'sentiment_score', 'keystroke_count', 'activity_score',
      'communication_volume', 'productivity_score']) {
      expect(isForbiddenField(f)).toBe(true);
    }
  });

  it('refuses them in every assertion type, so no seam exists', () => {
    const builders = [recordFact, recordProvided, recordInference, recordCalculation, recordPrediction, recordRecommendation];
    for (const build of builders) {
      const r = build(base({
        field: 'attrition_risk',
        source: { system: 'analytics', actorUserId: ACTOR, actorName: 'Priya Nair' },
        reasoning: 'x', basis: ['y'], uncertainty: 'z', confidence: 0.5,
      }));
      expect(r.ok).toBe(false);
    }
  });

  it('refuses to predict anything about a person at all', () => {
    const r = recordPrediction(base({
      field: 'next_review_date',
      reasoning: 'x', basis: ['y'], uncertainty: 'z', confidence: 0.5,
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('does not predict things about people');
  });

  it('refuses to file a recommendation as one of the six decisions a human keeps', () => {
    for (const f of ['hiring_decision', 'rejection_reason', 'termination_decision',
      'promotion_decision', 'compensation', 'disciplinary_outcome']) {
      expect(isConsequentialDecision(f)).toBe(true);
      const r = recordRecommendation(base({
        field: f,
        owner: { kind: 'organization', subjectKind: null, subjectId: null, label: 'The organization' },
        reasoning: 'x', basis: ['y'], confidence: 0.5,
      }));
      expect(r.ok).toBe(false);
    }
  });
});

describe('the rendering contract', () => {
  const inference = () => ok(goodInference());
  const verified = () => ok(verify(
    ok(recordProvided(base({ source: { system: 'admin form', actorUserId: ACTOR, actorName: 'Priya Nair' } }))),
    humanAct(),
    { orgWide: true },
  ));

  it('never returns an empty sentence', () => {
    for (const el of [inference(), verified()]) {
      expect(renderProvenance(el).sentence.length).toBeGreaterThan(20);
    }
  });

  it('gives an inference a visibly different weight and class from a verified element', () => {
    const a = renderProvenance(inference());
    const b = renderProvenance(verified());
    expect(a.weight).toBe('advisory');
    expect(b.weight).toBe('record');
    expect(a.className).not.toBe(b.className);
    expect(a.advisoryOnly).toBe(true);
    expect(b.advisoryOnly).toBe(false);
  });

  it('says the word Inferred without anybody opening anything', () => {
    const r = renderProvenance(inference());
    expect(r.label).toBe('Inferred');
    expect(r.short).toContain('Inferred');
    expect(r.sentence).toContain('nobody has confirmed it');
  });

  it('stops calling a verification verified once the value has moved', () => {
    const v = verified();
    const moved = checkAgainstValue(v, 'a completely different joining date');
    expect(moved.stale).toBe(true);
    const r = renderProvenance(moved);
    expect(r.label).toBe('Verification out of date');
    expect(r.weight).toBe('advisory');
    expect(r.decisionUse).toBe('advisory_only');
    expect(r.sentence).toContain('no longer verified');
  });

  it('leaves an element alone when the value has not moved', () => {
    const v = verified();
    expect(checkAgainstValue(v, '2026-01-05').stale).toBe(false);
  });

  it('renders an unreadable row as unreadable rather than as anything else', () => {
    const r = renderUnreadable('the stored row names no verifier.');
    expect(r.weight).toBe('advisory');
    expect(r.decisionUse).toBe('advisory_only');
    expect(r.sentence).toContain('do not decide anything on it');
  });

  it('fingerprints a value without storing it', () => {
    expect(fingerprintOf('2026-01-05')).toBe(fingerprintOf('2026-01-05'));
    expect(fingerprintOf('2026-01-05')).not.toBe(fingerprintOf('2026-01-06'));
    expect(fingerprintOf({ a: 1, b: 2 })).toBe(fingerprintOf({ b: 2, a: 1 }));
    expect(fingerprintOf('2026-01-05')).not.toContain('2026');
  });
});

describe('the seven questions', () => {
  it('answers all seven for a verified claim', () => {
    const v = ok(verify(
      ok(recordProvided(base({ source: { system: 'admin form', actorUserId: ACTOR, actorName: 'Priya Nair' } }))),
      humanAct({ evidence: [{ kind: 'document', id: null, label: 'Signed offer letter', url: 'https://drive.google.com/file/d/x/view' }] }),
      { orgWide: true },
    ));
    const e = explainElement(v);
    expect(e.concluded.length).toBeGreaterThan(0);
    expect(e.why.length).toBeGreaterThan(0);
    expect(e.evidence.length).toBe(1);
    expect(e.uncertain.length).toBeGreaterThan(0);
    expect(e.override).toContain('withdraw');
    expect(e.unanswered).toEqual([]);
  });

  it('names the questions an element cannot answer, and refuses a high-impact use while any is missing', () => {
    const v = ok(verify(
      ok(recordProvided(base({ source: { system: 'admin form', actorUserId: ACTOR, actorName: 'Priya Nair' } }))),
      humanAct(),
      { orgWide: true },
    ));
    const e = explainElement(v);
    expect(e.unanswered).toContain('what evidence it rests on');
    expect(mayDecideOn(v, 'high').allowed).toBe(false);
  });

  it('refuses an advisory element as the reason for anything, at any impact', () => {
    const el = ok(goodInference());
    expect(mayDecideOn(el, 'high').allowed).toBe(false);
    expect(mayDecideOn(el, 'ordinary').allowed).toBe(false);
    expect(mayDecideOn(el, 'high').reason).toContain('advisory');
  });

  it('refuses a stated claim as the sole basis of a high-impact decision', () => {
    const el = ok(recordProvided(base({
      field: 'education',
      source: { system: 'application form', actorUserId: SUBJECT, actorName: 'The applicant' },
    })));
    const high = mayDecideOn(el, 'high');
    expect(high.allowed).toBe(false);
    expect(mayDecideOn(el, 'ordinary').allowed).toBe(true);
  });

  it('always answers yes to whether a human can override', () => {
    const els: ProvenanceElement[] = [
      ok(goodInference()),
      ok(recordProvided(base({ source: { system: 'admin form', actorUserId: ACTOR, actorName: 'Priya Nair' } }))),
    ];
    for (const el of els) expect(explainElement(el).override.startsWith('Yes')).toBe(true);
  });
});
