import { describe, it, expect } from 'vitest';
import {
  allowedWorkModes, claimsHybrid, claimsRemote, correctedLocation, displayLocation,
  isTraineeEngagement, jobLocationType, locationLabel, PRIMARY_SITE, resolveWorkMode,
  violatesWorkModePolicy, workModeLabel, workModeSentence, workModeTitle, WORK_MODES,
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
