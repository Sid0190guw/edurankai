import { describe, it, expect } from 'vitest';
import {
  allowedWorkModes, claimsHybrid, claimsRemote, correctedLocation, displayLocation,
  isTraineeEngagement, jobLocationType, locationLabel, PRIMARY_SITE, resolveWorkMode,
  violatesWorkModePolicy, workModeLabel, workModeSentence, workModeTitle, WORK_MODES,
  isOfferWorkMode, offerableWorkModes, offerWorkModeTitle, resolveOfferWorkMode,
  offerWorkModeFromSavedContent,
} from './work-mode';

describe('the policy itself', () => {
  it('offers exactly two modes, and remote is not one of them', () => {
    expect([...WORK_MODES]).toEqual(['on-site', 'hybrid']);
  });

  it('allows a permanent role on site only', () => {
    expect([...allowedWorkModes('Full-Time', 'Senior')]).toEqual(['on-site']);
    expect([...allowedWorkModes('Full-Time', 'C-Level')]).toEqual(['on-site']);
    expect([...allowedWorkModes('Contract', 'Mid')]).toEqual(['on-site']);
    expect([...allowedWorkModes('Part-Time', 'Junior')]).toEqual(['on-site']);
  });

  it('allows hybrid on internships and apprenticeships', () => {
    expect([...allowedWorkModes('Internship', 'Intern')]).toEqual(['on-site', 'hybrid']);
    expect([...allowedWorkModes('Apprenticeship', 'Apprentice')]).toEqual(['on-site', 'hybrid']);
  });

  it('treats the level as trainee evidence when the engagement type is missing', () => {
    // Imported rows disagree: some carry the engagement, some only the level.
    expect(isTraineeEngagement(null, 'Intern')).toBe(true);
    expect(isTraineeEngagement('Internship', null)).toBe(true);
    expect(isTraineeEngagement(null, 'Senior')).toBe(false);
    expect(isTraineeEngagement(undefined, undefined)).toBe(false);
  });

  it('is case- and whitespace-insensitive about the engagement', () => {
    expect(isTraineeEngagement('  internship ', null)).toBe(true);
    expect(isTraineeEngagement('APPRENTICESHIP', null)).toBe(true);
  });
});

describe('resolveWorkMode clamps whatever is stored', () => {
  const LEGACY = 'Remote / Hybrid (India)';

  it('never returns remote for a permanent role, whatever the row says', () => {
    expect(resolveWorkMode('Full-Time', 'Senior', LEGACY)).toBe('on-site');
    expect(resolveWorkMode('Full-Time', 'Mid', 'Remote')).toBe('on-site');
    expect(resolveWorkMode('Full-Time', 'Lead', 'Work from home')).toBe('on-site');
    expect(resolveWorkMode('Full-Time', 'Junior', 'Hybrid, Bengaluru')).toBe('on-site');
  });

  it('reads a legacy trainee row as hybrid, not remote', () => {
    expect(resolveWorkMode('Internship', 'Intern', LEGACY)).toBe('hybrid');
    expect(resolveWorkMode('Apprenticeship', 'Apprentice', 'Remote / Any')).toBe('hybrid');
  });

  it('leaves an already-correct trainee row on site', () => {
    expect(resolveWorkMode('Internship', 'Intern', 'On-site — Kolkata, West Bengal, India')).toBe('on-site');
  });

  it('defaults to on-site when nothing is stored', () => {
    expect(resolveWorkMode('Full-Time', 'Senior', null)).toBe('on-site');
    expect(resolveWorkMode('Internship', 'Intern', '')).toBe('on-site');
  });
});

describe('detecting rows that need correcting', () => {
  it('flags any row that claims remote', () => {
    expect(violatesWorkModePolicy('Internship', 'Intern', 'Remote / Hybrid (India)')).toBe(true);
    expect(violatesWorkModePolicy('Full-Time', 'Senior', 'Remote')).toBe(true);
    expect(violatesWorkModePolicy('Full-Time', 'Senior', 'Anywhere in India')).toBe(true);
  });

  it('flags a permanent role that claims hybrid, but not a trainee one', () => {
    expect(violatesWorkModePolicy('Full-Time', 'Mid', 'Hybrid — Pune')).toBe(true);
    expect(violatesWorkModePolicy('Internship', 'Intern', 'On-site / Hybrid — Kolkata')).toBe(false);
  });

  it('leaves a genuine bespoke on-site location alone', () => {
    expect(violatesWorkModePolicy('Full-Time', 'Mid', 'Dum Dum, Kolkata, West Bengal (on-site)')).toBe(false);
    expect(violatesWorkModePolicy('Internship', 'Intern', 'On-site — your own campus (India)')).toBe(false);
    expect(violatesWorkModePolicy('Full-Time', 'Mid', 'On-site, India (exact location disclosed on selection)')).toBe(false);
  });

  it('does not fire on the word remote inside an unrelated word', () => {
    // "Remote Sensing Intern" is a job title, not a work arrangement. The location column is what
    // is tested, but the word-boundary matters for any caller that passes a longer string.
    expect(claimsRemote('Remote Sensing lab, Kolkata')).toBe(true);   // the standalone word does count
    expect(claimsRemote('Kolkata')).toBe(false);
    expect(claimsHybrid('On-site — Kolkata')).toBe(false);
  });
});

describe('what a candidate is shown', () => {
  it('rewrites a legacy row rather than repeating its claim', () => {
    expect(displayLocation('Full-Time', 'Senior', 'Remote / Hybrid (India)'))
      .toBe('On-site — Kolkata, West Bengal, India');
    expect(displayLocation('Internship', 'Intern', 'Remote / Hybrid (India)'))
      .toBe('On-site / Hybrid — Kolkata, West Bengal, India');
  });

  it('keeps a bespoke on-site location exactly as written', () => {
    const field = 'On-site — field-based, Kolkata and client sites across India, with travel';
    expect(displayLocation('Full-Time', 'Mid', field)).toBe(field);
    const campus = 'On-site — your own campus (India)';
    expect(displayLocation('Internship', 'Intern', campus)).toBe(campus);
  });

  it('fills an empty location with the on-site default', () => {
    expect(displayLocation('Full-Time', 'Senior', '')).toBe('On-site — Kolkata, West Bengal, India');
    expect(displayLocation('Full-Time', 'Senior', null)).toBe('On-site — Kolkata, West Bengal, India');
  });

  it('never produces a string a candidate could read as remote', () => {
    const rows = [
      ['Full-Time', 'Senior', 'Remote / Hybrid (India)'],
      ['Full-Time', 'C-Level', 'Remote'],
      ['Internship', 'Intern', 'Remote / Any'],
      ['Apprenticeship', 'Apprentice', 'Work from home'],
      ['Full-Time', 'Mid', null],
    ] as const;
    for (const [e, l, loc] of rows) {
      expect(claimsRemote(displayLocation(e, l, loc))).toBe(false);
    }
  });
});

describe('labels', () => {
  it('names the modes for a job advert and for an agreed term differently', () => {
    expect(workModeLabel('on-site')).toBe('On-site');
    expect(workModeLabel('hybrid')).toBe('On-site / Hybrid');
    expect(workModeTitle('on-site')).toBe('On-Site');
    expect(workModeTitle('hybrid')).toBe('Hybrid');
  });

  it('builds the stored location line from the site', () => {
    expect(locationLabel('on-site')).toBe('On-site — ' + PRIMARY_SITE.locality + ', West Bengal, India');
    expect(locationLabel('hybrid', 'your own campus (India)')).toBe('On-site / Hybrid — your own campus (India)');
  });

  it('says plainly that the role is not remote', () => {
    expect(workModeSentence('on-site', 'Full-Time')).toMatch(/not remote and not hybrid/);
    expect(workModeSentence('hybrid', 'Internship')).toMatch(/not a remote position/);
    expect(workModeSentence('hybrid', 'Apprenticeship')).toMatch(/apprenticeship/);
  });

  it('names the company site only when the role is actually at it', () => {
    // The default: no location given, so the sentence may name the site.
    expect(workModeSentence('on-site', 'Full-Time')).toContain(PRIMARY_SITE.locality);
    expect(workModeSentence('on-site', 'Full-Time', 'On-site — Kolkata, West Bengal, India'))
      .toContain(PRIMARY_SITE.locality);
  });

  it('does not name Kolkata for a role whose site is somewhere else', () => {
    // The campus ambassador works at their own college; a sentence naming Kolkata directly under a
    // badge that says "your own campus" reads as an instruction to relocate.
    const campus = workModeSentence('hybrid', 'Internship', 'On-site / Hybrid — your own campus (India)');
    expect(campus).not.toContain(PRIMARY_SITE.locality);
    expect(campus).toMatch(/not a remote position/);

    // The flagship programme withholds its site on purpose; naming the city publishes it.
    const withheld = workModeSentence('on-site', 'Internship', 'On-site, India (exact location disclosed on selection)');
    expect(withheld).not.toContain(PRIMARY_SITE.locality);
    expect(withheld).toMatch(/not remote and not hybrid/);

    const field = workModeSentence('on-site', 'Full-Time', 'On-site — field-based across India, with travel');
    expect(field).not.toContain(PRIMARY_SITE.locality);
  });

  it('treats a stale remote row as the default site, not a bespoke one', () => {
    // "Remote / Any" is a legacy row, not a real place. It must not be read as a bespoke site and
    // silence the sentence -- the role is on site at the company site and should say so.
    expect(workModeSentence('on-site', 'Full-Time', 'Remote / Any')).toContain(PRIMARY_SITE.locality);
    expect(workModeSentence('on-site', 'Full-Time', '')).toContain(PRIMARY_SITE.locality);
  });

  it('corrects a location to what the engagement allows', () => {
    expect(correctedLocation('Full-Time', 'Senior', 'Remote')).toBe('On-site — Kolkata, West Bengal, India');
    expect(correctedLocation('Internship', 'Intern', 'Remote')).toBe('On-site / Hybrid — Kolkata, West Bengal, India');
  });
});

describe('structured data', () => {
  it('never marks a posting TELECOMMUTE', () => {
    // Google reads TELECOMMUTE as "away from any employer site". Setting it on every posting is
    // what listed the whole careers portal as remote work in job search.
    expect(jobLocationType('on-site')).toBeNull();
    expect(jobLocationType('hybrid')).toBeNull();
  });
});

describe('the catalogue no longer advertises remote work', () => {
  it('has no role whose location claims remote, and no permanent role that claims hybrid', async () => {
    const { ROLE_CATALOG } = await import('@/data/role-catalog');
    const offenders = (ROLE_CATALOG as any[])
      .filter((r) => violatesWorkModePolicy(r.engagementType, r.level, r.location))
      .map((r) => r.slug + ': ' + r.location);
    expect(offenders).toEqual([]);
  });

  it('covers every role in the catalogue, not an empty list', () => {
    // Guards the assertion above from passing because the import silently yielded nothing.
    return import('@/data/role-catalog').then(({ ROLE_CATALOG }) => {
      expect((ROLE_CATALOG as any[]).length).toBeGreaterThan(100);
    });
  });
});

// -------------------------------------------------------------------------------------------
// WHAT AN OFFER MAY AGREE TO, which is not what a posting may advertise.
//
// Added 2026-09-06. The Custom Offer builder (/admin/offer/blank) had never been moved onto this
// module: it carried its own <select> with Remote pre-selected, so every letter generated there
// defaulted to the exact value this file was written to remove — while the applications-side letter
// asked this module and offered On-Site alone. Two offer screens, two different answers.
//
// The resolution keeps the two questions apart. A public posting still cannot say remote; an offer
// letter, which is written for one named person by somebody who has spoken to them, can.
describe('the offer path', () => {
  it('offers all three modes, because an offer is an agreement and not an advert', () => {
    expect(offerableWorkModes()).toEqual(['on-site', 'hybrid', 'remote']);
  });

  it('does NOT let remote leak into the advertising path', () => {
    // The guarantee that makes the split safe: everything candidate-facing still speaks in
    // WorkMode, which has no remote member.
    expect(WORK_MODES).toEqual(['on-site', 'hybrid']);
    expect(allowedWorkModes('Full-Time', 'Senior')).not.toContain('remote');
    expect(allowedWorkModes('Internship', 'Intern')).not.toContain('remote');
    expect(resolveWorkMode('Internship', 'Intern', 'Remote / Anywhere')).not.toBe('remote');
  });

  it('honours each of the three modes an admin can actually select', () => {
    expect(resolveOfferWorkMode('Full-Time', 'Senior', 'Remote')).toBe('remote');
    expect(resolveOfferWorkMode('Full-Time', 'Senior', 'Hybrid')).toBe('hybrid');
    expect(resolveOfferWorkMode('Full-Time', 'Senior', 'On-Site')).toBe('on-site');
  });

  it('accepts the spellings a form or an older letter might carry', () => {
    expect(resolveOfferWorkMode('Full-Time', null, 'remote')).toBe('remote');
    expect(resolveOfferWorkMode('Full-Time', null, '  REMOTE  ')).toBe('remote');
    expect(resolveOfferWorkMode('Full-Time', null, 'onsite')).toBe('on-site');
    expect(resolveOfferWorkMode('Full-Time', null, 'On Site')).toBe('on-site');
  });

  it('falls back to what the engagement would ADVERTISE when nothing usable was submitted', () => {
    // A tampered POST, an empty field or a value from a form that no longer exists must never
    // become remote by accident. The conservative answer is the advertised one.
    expect(resolveOfferWorkMode('Full-Time', 'Senior', '')).toBe('on-site');
    expect(resolveOfferWorkMode('Full-Time', 'Senior', null)).toBe('on-site');
    expect(resolveOfferWorkMode('Full-Time', 'Senior', 'work from the moon')).toBe('on-site');
    expect(resolveOfferWorkMode('Internship', 'Intern', 'nonsense')).toBe('on-site');
  });

  it('prints the single word an offer letter shows', () => {
    expect(offerWorkModeTitle('remote')).toBe('Remote');
    expect(offerWorkModeTitle('hybrid')).toBe('Hybrid');
    expect(offerWorkModeTitle('on-site')).toBe('On-Site');
  });

  it('recognises exactly the three, and nothing else', () => {
    expect(isOfferWorkMode('remote')).toBe(true);
    expect(isOfferWorkMode('telecommute')).toBe(false);
    expect(isOfferWorkMode('')).toBe(false);
    expect(isOfferWorkMode(null)).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------
// /admin/offer/blank REOPENING AN EXISTING APPLICATION.
//
// Added 2026-09-06. The Custom Offer builder already asked resolveOfferWorkMode for its picker's
// initial value, but always with `submitted: null` — so it re-derived a fresh policy-default mode
// EVERY time the page was opened, discarding whatever an admin had actually chosen and saved on
// that application's offer letter. An admin who deliberately picked Remote for one candidate saw
// On-Site the next time they reopened that exact application, with nothing on screen saying their
// choice had been overwritten.
//
// offer_letters.content is a jsonb column with no schema of its own, so `content.workMode` is
// exactly the kind of value the task calls out: it can be missing (a row from before this field
// existed), empty, not a string, or simply absent because there is no saved offer at all. Each case
// below is one of those, named.
describe('offerWorkModeFromSavedContent: reading a saved offer\'s mode out of an untyped jsonb blob', () => {
  it('extracts each of the three real values, trimmed', () => {
    expect(offerWorkModeFromSavedContent({ workMode: 'Remote' })).toBe('Remote');
    expect(offerWorkModeFromSavedContent({ workMode: 'Hybrid' })).toBe('Hybrid');
    expect(offerWorkModeFromSavedContent({ workMode: 'On-Site' })).toBe('On-Site');
    expect(offerWorkModeFromSavedContent({ workMode: '  Remote  ' })).toBe('Remote');
  });

  it('is null when there is no saved offer at all', () => {
    expect(offerWorkModeFromSavedContent(null)).toBeNull();
    expect(offerWorkModeFromSavedContent(undefined)).toBeNull();
  });

  it('is null for a LEGACY row whose content predates this field — not an accidental empty string', () => {
    expect(offerWorkModeFromSavedContent({})).toBeNull();
    expect(offerWorkModeFromSavedContent({ candidateName: 'A Candidate', roleTitle: 'Something' })).toBeNull();
  });

  it('is null for an empty or whitespace-only saved value', () => {
    expect(offerWorkModeFromSavedContent({ workMode: '' })).toBeNull();
    expect(offerWorkModeFromSavedContent({ workMode: '   ' })).toBeNull();
  });

  it('is null for a value that is not a string, rather than coercing it into one', () => {
    expect(offerWorkModeFromSavedContent({ workMode: 42 as any })).toBeNull();
    expect(offerWorkModeFromSavedContent({ workMode: null as any })).toBeNull();
    expect(offerWorkModeFromSavedContent({ workMode: {} as any })).toBeNull();
  });

  it('is null when content itself is not an object', () => {
    expect(offerWorkModeFromSavedContent('not an object' as any)).toBeNull();
    expect(offerWorkModeFromSavedContent(42 as any)).toBeNull();
  });
});

describe('the full chain blank.astro runs to hydrate its picker: saved content -> resolveOfferWorkMode', () => {
  // Exactly the expression in src/pages/admin/offer/blank.astro's `defaults.workMode`:
  //   resolveOfferWorkMode(engagementType, level, offerWorkModeFromSavedContent(savedOffer?.content))
  const hydrate = (engagementType: string, level: string | null, content: Record<string, unknown> | null) =>
    resolveOfferWorkMode(engagementType, level, offerWorkModeFromSavedContent(content));

  it('preserves an existing ON-SITE selection', () => {
    expect(hydrate('Full-Time', 'Senior', { workMode: 'On-Site' })).toBe('on-site');
  });

  it('preserves an existing HYBRID selection', () => {
    expect(hydrate('Internship', 'Intern', { workMode: 'Hybrid' })).toBe('hybrid');
  });

  it('preserves an existing REMOTE selection — the exact case that was being discarded', () => {
    expect(hydrate('Full-Time', 'Senior', { workMode: 'Remote' })).toBe('remote');
    // Even for an engagement that could never ADVERTISE hybrid: the offer path does not narrow by
    // engagement, and a saved Remote choice must survive regardless of what the role is.
    expect(hydrate('Contract', 'Mid', { workMode: 'Remote' })).toBe('remote');
  });

  it('a brand-new blank offer (no application at all) gets the policy default, never remote', () => {
    // resolveWorkMode's own default is "the most restrictive mode the engagement is allowed" — for
    // an internship that is on-site, even though hybrid is ALLOWED; hybrid has to be chosen, not
    // assumed, exactly as src/lib/work-mode.test.ts already asserts for resolveWorkMode itself
    // ("defaults to on-site when nothing is stored"). This is that same, unchanged policy, reached
    // through the offer path with nothing saved to prefer.
    expect(hydrate('Full-Time', 'Senior', null)).toBe('on-site');
    expect(hydrate('Internship', 'Intern', null)).toBe('on-site');
  });

  it('a LEGACY application — a saved offer exists, but from before this field was recorded — falls to the policy default, never remote', () => {
    expect(hydrate('Full-Time', 'Senior', {})).toBe('on-site');
    expect(hydrate('Internship', 'Intern', { candidateName: 'Old Row' })).toBe('on-site');
  });

  it('missing engagement type on the application itself does not produce remote either', () => {
    expect(hydrate('', null as any, {})).toBe('on-site');
    expect(hydrate(null as any, null, { workMode: '' })).toBe('on-site');
  });

  it('a corrupted saved value is treated as absent, not trusted verbatim', () => {
    expect(hydrate('Full-Time', 'Senior', { workMode: 'sitting on a beach' })).toBe('on-site');
  });
});
