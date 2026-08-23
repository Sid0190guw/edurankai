// The language rule and the notice-integrity rule, both enforced here rather than promised in a
// comment. A rule nothing checks is a rule that lasts until the next hurried edit.
import { describe, expect, it } from 'vitest';
import {
  CURRENT_NOTICE,
  CURRENT_NOTICE_VERSION,
  INTAKE_LABELS,
  NOTICE_VERSIONS,
  assertNeutralLanguage,
  findProhibitedTerms,
  isNoticeCurrent,
  noticeByVersion,
  noticeCanonicalText,
  noticeHash,
  noticeIntegrity,
} from './notice';

describe('prohibited vocabulary', () => {
  it('catches the terms the brief forbids', () => {
    expect(findProhibitedTerms('This uses astrology.').length).toBe(1);
    expect(findProhibitedTerms('Your birth chart says').length).toBeGreaterThan(0);
    expect(findProhibitedTerms('kundli matching').length).toBe(1);
    expect(findProhibitedTerms('what is your star sign').length).toBe(1);
  });

  it('matches on word boundaries so ordinary copy is not a false positive', () => {
    // "star" inside "start", "fate" inside "fateful" would both be wrong to flag on a substring test.
    expect(findProhibitedTerms('Start the application when you are ready.')).toEqual([]);
    expect(findProhibitedTerms('Predictable delivery of your development plan.')).toEqual([]);
  });

  it('throws with a findable context, not just a boolean', () => {
    expect(() => assertNeutralLanguage('test copy', 'We consult your horoscope.')).toThrow(/horoscope/);
  });
});

describe('every user-facing string in this patch', () => {
  // THE POINT OF THIS SUITE. Copy drifts; this walks the actual exported strings, so new copy is
  // covered the moment it is added rather than when somebody remembers to check it.
  it('the notice text uses neutral professional language', () => {
    for (const n of NOTICE_VERSIONS) {
      expect(() => assertNeutralLanguage('notice ' + n.version, noticeCanonicalText(n))).not.toThrow();
    }
  });

  it('the form and portal labels use neutral professional language', () => {
    for (const [key, value] of Object.entries(INTAKE_LABELS)) {
      expect(() => assertNeutralLanguage('INTAKE_LABELS.' + key, value)).not.toThrow();
    }
  });

  it('describes the information the way the brief requires', () => {
    const text = noticeCanonicalText(CURRENT_NOTICE).toLowerCase();
    expect(text).toContain('optional');
    expect(text).toContain('professional and long-term development insights');
  });

  // The three promises that decide whether the consent is real, asserted rather than assumed.
  it('states that declining costs the applicant nothing', () => {
    expect(CURRENT_NOTICE.limits.some((l) => /no effect on your application/i.test(l))).toBe(true);
  });

  it('states that a person, not a computation, makes every employment decision', () => {
    expect(CURRENT_NOTICE.limits.some((l) => /decision a person makes/i.test(l))).toBe(true);
  });

  it('states that withdrawal deletes what is held, not merely its future use', () => {
    expect(CURRENT_NOTICE.retention.some((r) => /deletes what is stored/i.test(r))).toBe(true);
    expect(CURRENT_NOTICE.withdrawalUrl).toBe('/portal/personal-profile-data');
  });

  it('says demonstrated evidence outweighs anything inferred', () => {
    expect(CURRENT_NOTICE.limits.some((l) => /demonstrated, job-related evidence/i.test(l))).toBe(true);
  });

  it('makes no claim to scientific fact and no claim about health', () => {
    expect(CURRENT_NOTICE.limits.some((l) => /scientific fact/i.test(l) && /health/i.test(l))).toBe(true);
  });
});

describe('notice integrity', () => {
  it('hashes the canonical text deterministically', () => {
    expect(noticeHash(CURRENT_NOTICE)).toBe(noticeHash(CURRENT_NOTICE));
    expect(noticeHash(CURRENT_NOTICE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a stored pair from this build verifies', () => {
    expect(noticeIntegrity(CURRENT_NOTICE_VERSION, noticeHash(CURRENT_NOTICE))).toEqual({ ok: true });
  });

  // The two failures need different humans, so they are different answers.
  it('distinguishes an unknown version from edited copy', () => {
    expect(noticeIntegrity('pf-1999-01-01.v1', 'whatever')).toMatchObject({ ok: false, problem: 'unknown-version' });
    expect(noticeIntegrity(CURRENT_NOTICE_VERSION, 'deadbeef')).toMatchObject({ ok: false, problem: 'mismatch' });
  });

  it('never silently falls back to the current notice for an unknown version', () => {
    expect(noticeByVersion('pf-1999-01-01.v1')).toBeNull();
    expect(noticeByVersion(null)).toBeNull();
  });

  it('knows which version is current', () => {
    expect(isNoticeCurrent(CURRENT_NOTICE_VERSION)).toBe(true);
    expect(isNoticeCurrent('pf-1999-01-01.v1')).toBe(false);
    expect(isNoticeCurrent(null)).toBe(false);
  });

  it('keeps every version ever shipped, including superseded ones', () => {
    expect(NOTICE_VERSIONS.length).toBeGreaterThanOrEqual(1);
    expect(NOTICE_VERSIONS.map((n) => n.version)).toContain(CURRENT_NOTICE_VERSION);
    // Versions must be unique: two notices under one version make the stored hash unresolvable.
    const versions = NOTICE_VERSIONS.map((n) => n.version);
    expect(new Set(versions).size).toBe(versions.length);
  });
});
