// The branded documents: what they must carry, and what nothing on a form may turn them into.
import { describe, it, expect } from 'vitest';
import {
  certificateHtml, certificateFromRecord, certificateWording, promotionLetterHtml,
  promotionLetterAllowed, promotionLetterTitle, offerSummaryHtml, letterheadHtml, longDate, brandLogoUrl,
} from './brand-doc';
import { sanitizeEmailHtml, OUTBOUND } from '@/lib/mailsec/html';

const cert = {
  recipientName: 'Anita Sharma',
  heading: 'Certificate of Internship Completion',
  programme: 'AI Research Internship',
  department: 'Applied AI',
  fromDate: '2026-05-04',
  toDate: '2026-11-06',
  distinction: 'With Distinction',
  citation: 'Anita built the evaluation harness.\nShe did it carefully.',
  achievements: ['Shipped the evaluation harness', 'Cut ranking latency by a third'],
  signatoryName: 'Siddharth Prasad',
  signatoryTitle: 'Founder & CEO',
  issueDate: '2026-11-06',
  serial: 'ERA-IN-2026-ABC234',
  verifyUrl: 'https://edurankai.in/credentials/ERA-IN-2026-ABC234',
};

const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;

describe('longDate', () => {
  it('reads the calendar date off the string, never through a time zone', () => {
    expect(longDate('2026-11-06')).toBe('6 November 2026');
    expect(longDate('2026-01-31T23:30:00Z')).toBe('31 January 2026');
    expect(longDate('')).toBe('');
    expect(longDate('not a date')).toBe('not a date');
  });
});

describe('certificateHtml', () => {
  const html = certificateHtml(cert);

  it('carries the logo, the person, the programme, the dates, the signatory and the serial', () => {
    expect(html).toContain(brandLogoUrl());
    expect(brandLogoUrl()).toMatch(/^https?:\/\/.+\/icon-192\.png$/);
    expect(html).toContain('alt="EduRankAI"');
    expect(html).toContain('Anita Sharma');
    expect(html).toContain('AI Research Internship');
    expect(html).toContain('4 May 2026');
    expect(html).toContain('6 November 2026');
    expect(html).toContain('Siddharth Prasad');
    expect(html).toContain('ERA-IN-2026-ABC234');
    expect(html).toContain('With Distinction');
    expect(html).toContain('Shipped the evaluation harness');
    expect(html).toContain('href="https://edurankai.in/credentials/ERA-IN-2026-ABC234"');
  });

  it('says what it is not: no degree, partners award academic credit', () => {
    expect(html).toContain('It is not an academic degree');
    expect(html).toContain('accredited partners');
  });

  it('survives the outbound sanitiser untouched, so the inbox copy is the reviewed copy', () => {
    const clean = sanitizeEmailHtml(html, OUTBOUND);
    expect(clean.removed).toEqual([]);
    expect(clean.html).toContain(brandLogoUrl());
  });

  it('escapes every field, so a name cannot become markup on the public page', () => {
    const hostile = certificateHtml({
      ...cert,
      recipientName: '<script>alert(1)</script>',
      programme: '<img src=x onerror=alert(1)>',
      citation: '"><svg onload=alert(1)>',
      achievements: ['<b>bold</b>'],
    });
    expect(hostile).not.toContain('<script');
    expect(hostile).not.toMatch(/<img[^>]*onerror/i);
    expect(hostile).not.toContain('<svg');
    expect(hostile).toContain('&lt;script&gt;');
  });

  it('marks a revoked certificate on its face', () => {
    expect(certificateHtml({ ...cert, revoked: true })).toContain('REVOKED');
    expect(html).not.toContain('REVOKED');
  });

  it('has no emoji', () => {
    expect(emoji.test(html)).toBe(false);
  });
});

describe('certificateFromRecord', () => {
  it('maps a universal_certificates row, metadata included', () => {
    const row = {
      serial: 'ERA-IN-2026-XYZ234', kind: 'internship', recipient_name: 'Ravi K', title: 'Data Internship',
      body: 'Citation', achievement: 'With Merit', issued_by_name: 'S P', issued_by_designation: 'Founder',
      signed_at: new Date('2026-11-06T00:00:00Z'), score_pct: null, revoked: false,
      metadata: { fromDate: '2026-06-01', toDate: '2026-11-01', department: 'Data', achievements: ['A', 'B'], measureLine: '20 credits' },
    };
    const c = certificateFromRecord(row, 'https://edurankai.in/credentials/ERA-IN-2026-XYZ234');
    expect(c.heading).toBe('Certificate of Internship Completion');
    expect(c.programme).toBe('Data Internship');
    expect(c.issueDate).toBe('2026-11-06');
    expect(c.fromDate).toBe('2026-06-01');
    expect(c.achievements).toEqual(['A', 'B']);
    expect(c.measureLine).toBe('20 credits');
    expect(c.distinction).toBe('With Merit');
  });

  it('reads metadata that came back as a JSON string, and survives garbage', () => {
    const c = certificateFromRecord({ kind: 'course', metadata: '{"department":"X"}' });
    expect(c.department).toBe('X');
    const bad = certificateFromRecord({ kind: 'course', metadata: '{not json' });
    expect(bad.department).toBeUndefined();
  });

  it('states a score only when one is on record', () => {
    expect(certificateFromRecord({ kind: 'test', score_pct: '94.5' }).measureLine).toBe('Score on record: 94.5%.');
    expect(certificateFromRecord({ kind: 'test', score_pct: null }).measureLine).toBeUndefined();
  });

  it('falls back to neutral wording for an unknown kind', () => {
    expect(certificateWording('nonsense').heading).toBe('Certificate of Recognition');
  });
});

describe('promotion letter', () => {
  const base = {
    recipientName: 'Meera Das', kind: 'promotion', fromDesignation: 'AI Research Intern',
    toDesignation: 'AI Research Engineer', fromGrade: 'I1', toGrade: 'E1', effectiveDate: '2026-12-01',
    signatoryName: 'Siddharth Prasad', signatoryTitle: 'Founder & CEO', refNumber: 'PRO-2026-ABC123', issueDate: '2026-11-06',
  };

  it('never writes a letter for a demotion', () => {
    expect(promotionLetterAllowed('promotion')).toBe(true);
    expect(promotionLetterAllowed('designation_change')).toBe(true);
    expect(promotionLetterAllowed('demotion')).toBe(false);
  });

  it('states the change that was approved, with the logo and the date it takes effect', () => {
    const html = promotionLetterHtml(base);
    expect(html).toContain('Letter of Promotion');
    expect(html).toContain('Dear Meera,');
    expect(html).toContain('AI Research Intern');
    expect(html).toContain('AI Research Engineer');
    expect(html).toContain('I1 to E1');
    expect(html).toContain('1 December 2026');
    expect(html).toContain('PRO-2026-ABC123');
    expect(html).toContain(brandLogoUrl());
    expect(sanitizeEmailHtml(html, OUTBOUND).removed).toEqual([]);
  });

  it('words a re-designation as one, not as a promotion', () => {
    const html = promotionLetterHtml({ ...base, kind: 'designation_change' });
    expect(promotionLetterTitle('designation_change')).toBe('Letter of Re-designation');
    expect(html).toContain('Letter of Re-designation');
    expect(html).not.toContain('Congratulations.');
  });

  it('escapes the personal paragraph', () => {
    const html = promotionLetterHtml({ ...base, personalNote: '<script>x()</script>\nline two' });
    expect(html).not.toContain('<script');
    expect(html).toContain('line two');
  });
});

describe('offer summary', () => {
  it('names the role and dates and never states compensation', () => {
    const html = offerSummaryHtml({
      candidateName: 'Kabir', roleTitle: 'LLM Engineering Intern', department: 'AI',
      employmentType: 'Internship', workMode: 'Hybrid', joiningDate: '2026-12-01',
      responseDeadline: '2026-11-20', refNumber: 'ERA-2026-ABC123',
    });
    expect(html).toContain('LLM Engineering Intern, AI');
    expect(html).toContain('1 December 2026');
    expect(html).toContain('20 November 2026');
    expect(html.toLowerCase()).not.toContain('stipend');
    expect(html.toLowerCase()).not.toContain('compensation');
    expect(html).toContain('This is a summary');
    expect(sanitizeEmailHtml(html, OUTBOUND).removed).toEqual([]);
  });

  it('leaves out a fact that was not recorded rather than printing a blank', () => {
    const html = offerSummaryHtml({ candidateName: 'A', roleTitle: 'Role' });
    expect(html).not.toContain('Joining date');
    expect(html).not.toContain('Work mode');
  });
});

describe('letterhead', () => {
  it('passes the sanitiser and carries the mark', () => {
    const html = letterheadHtml({ refNumber: 'X-1', issueDate: '2026-11-06' });
    expect(html).toContain(brandLogoUrl());
    expect(sanitizeEmailHtml(html, OUTBOUND).removed).toEqual([]);
  });
});
