import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('@/lib/db', () => ({ db: { execute: async () => [] } }));

import {
  experienceLetterHtml, nocHtml, relievingLetterHtml, renderHrDocument, documentProblems, letterLikeTitle,
  documentSerial, isDocumentSerial, amountInWords, wordsIndian, maskTail, inputFromForm, HR_DOC_TYPES, type HrDocInput,
} from '@/lib/hr/hr-documents';
import { HR_DOCUMENTS_DDL } from '@/lib/hr/hr-documents-store';
import { renderPayslipHtml } from '@/lib/hr-payslip';
import { LETTER_TYPES } from '@/lib/hr/letter-mail';

// A made-up person. Never a name or number from a real document.
const base: HrDocInput = {
  serial: 'ERA-NOC-2026-ABCDEF', issueDate: '2026-11-11', employeeName: 'Asha Verma', employeeCode: 'ERA-0042',
  designation: 'Executive Assistant', department: 'Executive Office', joiningDate: '2026-05-28', endDate: '2026-11-11',
  signatoryName: 'A Signatory', signatoryTitle: 'Founder & CEO', verifyUrl: 'https://edurankai.in/verify/document/ERA-NOC-2026-ABCDEF',
};

describe('three documents, three formats', () => {
  const exp = experienceLetterHtml({ ...base, responsibilities: ['Managed correspondence'] });
  const noc = nocHtml({ ...base, purpose: 'employment' });
  const rel = relievingLetterHtml({ ...base, resignationDate: '2026-10-10' });

  it('gives each its own structure, not a retitled copy', () => {
    expect(exp).toContain('To whom it may concern');
    expect(exp).toContain('was employed with EduRankAI');
    expect(exp).toContain('Managed correspondence');
    expect(exp).not.toContain('Subject:');

    expect(noc).toContain('No Objection Certificate');
    expect(noc).toContain('Subject:');
    expect(noc).toContain('Employment status');
    expect(noc).toContain('For EduRankAI');
    expect(noc).toContain('Authorised signatory');
    expect(noc).toContain('no objection');

    expect(rel).toContain('Dear Asha Verma,');
    expect(rel).toContain('relieved from the services of EduRankAI');
    expect(rel).toContain('10 October 2026');

    expect(new Set([exp, noc, rel]).size).toBe(3);
    // None of them is a certificate of achievement.
    for (const h of [exp, noc, rel]) expect(h).not.toMatch(/Certificate of Recognition|is recognised for/);
  });

  it('prints the number and the verification link on every document', () => {
    for (const h of [exp, noc, rel]) {
      expect(h).toContain('ERA-NOC-2026-ABCDEF');
      expect(h).toContain('edurankai.in/verify/document/ERA-NOC-2026-ABCDEF');
    }
  });

  it('never uses a gendered pronoun chosen from data', () => {
    for (const h of [exp, noc, rel]) expect(h).not.toMatch(/\b(he|she|his|her|him|hers)\b/i);
  });

  it('escapes every value', () => {
    const evil = { ...base, employeeName: '<script>alert(1)</script>', designation: '"><img src=x onerror=1>', purpose: 'employment', endDate: '2026-11-11' };
    for (const t of HR_DOC_TYPES) {
      const h = renderHrDocument(t.value, evil);
      expect(h, t.value).not.toContain('<script>');
      expect(h, t.value).not.toContain('<img src=x');
    }
  });

  it('states no dues only when HR confirmed it', () => {
    expect(nocHtml({ ...base, purpose: 'passport' })).not.toMatch(/no outstanding dues/);
    expect(nocHtml({ ...base, purpose: 'passport', duesCleared: true })).toMatch(/no outstanding dues/);
    expect(relievingLetterHtml(base)).not.toMatch(/full and final settlement has been completed/);
    expect(relievingLetterHtml({ ...base, duesCleared: true })).toMatch(/full and final settlement has been completed/);
  });

  it('tells the reader an NOC for a current employee is not a relieving letter', () => {
    const current = nocHtml({ ...base, endDate: '', purpose: 'employment' });
    expect(current).toContain('Currently employed');
    expect(current).toContain('This certificate is not a relieving letter');
    expect(nocHtml({ ...base, endDate: '', purpose: 'visa_travel' })).toContain('remains an employee of EduRankAI');
  });

  it('prints the performance remark only when one was written', () => {
    // "Yours sincerely" is the sign-off, not a judgement; the words below would be.
    expect(experienceLetterHtml(base)).not.toMatch(/\b(sincere|diligent|outstanding|hardworking)\b/i);
    expect(experienceLetterHtml({ ...base, remarks: 'A dependable colleague.' })).toContain('A dependable colleague.');
  });
});

describe('validation before issue', () => {
  it('needs a last working day for a relieving letter', () => {
    expect(documentProblems('relieving', { ...base, endDate: '' }).join(' ')).toMatch(/last working day/);
  });
  it('refuses dates in the wrong order', () => {
    expect(documentProblems('experience', { ...base, endDate: '2026-01-01' }).join(' ')).toMatch(/before the date of joining/);
    expect(documentProblems('noc', { ...base, purpose: 'loan', validUntil: '2026-01-01' }).join(' ')).toMatch(/expire before/);
  });
  it('needs a stated purpose for an NOC', () => {
    expect(documentProblems('noc', { ...base, purpose: '' }).length).toBeGreaterThan(0);
    expect(documentProblems('noc', { ...base, purpose: 'other', purposeText: '' }).join(' ')).toMatch(/Describe the purpose/);
    expect(documentProblems('noc', { ...base, purpose: 'other', purposeText: 'attending a conference abroad' })).toEqual([]);
  });
  it('reads the form the same way for preview and issue', () => {
    const f: Record<string, string> = { employee_name: ' Asha Verma ', designation: 'Analyst', joining_date: '2026-01-05', issue_date: '2026-11-11', signatory_name: 'S', signatory_title: 'T', responsibilities: '- One\n\n* Two', dues_cleared: 'yes', honorific: 'Sir' };
    const i = inputFromForm((n) => f[n] || '');
    expect(i.employeeName).toBe('Asha Verma');
    expect(i.responsibilities).toEqual(['One', 'Two']);
    expect(i.duesCleared).toBe(true);
    expect(i.honorific).toBe('');
  });
});

describe('the certificate desk refuses letters', () => {
  it('recognises letters and pay documents by their title', () => {
    for (const t of ['No Objection Certificate (NOC)', 'NOC', 'Experience Letter', 'experience certificate', 'Relieving letter', 'Payslip', 'Pay slip', 'Salary certificate']) {
      expect(letterLikeTitle(t), t).toBe(true);
    }
    for (const t of ['AI Research Internship', 'Certificate of Participation', 'Economics Olympiad', 'Knowledge Management Internship', 'Innocent title']) {
      expect(letterLikeTitle(t), t).toBe(false);
    }
  });
});

describe('serials', () => {
  it('reads the type from the number and avoids confusable characters', () => {
    const s = documentSerial('noc', 2026, [0, 1, 2, 3, 4, 250]);
    expect(s).toMatch(/^ERA-NOC-2026-[A-HJ-NP-Z2-9]{6}$/);
    expect(isDocumentSerial(s)).toBe(true);
    expect(documentSerial('experience', 2026, [1, 1, 1, 1, 1, 1]).startsWith('ERA-EXP-2026-')).toBe(true);
    expect(isDocumentSerial('ERA-CU-2026-ABC234')).toBe(false);
  });
});

describe('payslip amounts in words', () => {
  it('uses Indian grouping for rupees', () => {
    expect(amountInWords(45250, 'INR')).toBe('Rupees Forty-Five Thousand Two Hundred and Fifty Only');
    expect(amountInWords(1234567.5, 'INR')).toBe('Rupees Twelve Lakh Thirty-Four Thousand Five Hundred and Sixty-Seven and Fifty Paise Only');
    expect(amountInWords(10000000, 'INR')).toBe('Rupees One Crore Only');
    expect(amountInWords(0, 'INR')).toBe('Rupees Zero Only');
    expect(wordsIndian(100000)).toBe('One Lakh');
  });
  it('uses international grouping for other currencies', () => {
    expect(amountInWords(1000, 'USD')).toBe('USD One Thousand Only');
    expect(amountInWords(2500000.25, 'usd')).toBe('USD Two Million Five Hundred Thousand and Twenty-Five Cents Only');
  });
  it('masks account and identity numbers', () => {
    expect(maskTail('123456789012')).toBe('XXXXXX9012');
    expect(maskTail('12')).toBe('12');
    expect(maskTail('')).toBe('');
  });
});

describe('the payslip document', () => {
  const ps = {
    id: 'p1', employee_id: 'e1', full_name: '<b>Asha</b> Verma', employee_code: 'ERA-0042', designation: 'Analyst', dept_name: 'Research',
    month: 11, year: 2026, currency: 'INR', basic: 30000, hra: 12000, special_allowance: 3250, gross_salary: 45250,
    pf_employee: 1800, total_deductions: 1800, net_salary: 43450, days_worked: 22, status: 'paid', lines: [],
    extra: { joining_date: '2026-01-05', bank_name: 'Bank', bank_account_number: '123456789012', pan_number: 'ABCDE1234F' },
  };
  const html = renderPayslipHtml(ps, { autoPrint: false });
  it('is a formal payslip with net pay in words', () => {
    expect(html).toContain('Payslip');
    expect(html).toContain('For the month of <strong>November 2026</strong>');
    expect(html).toContain('Rupees Forty-Three Thousand Four Hundred and Fifty Only');
    expect(html).toContain('Gross earnings');
    expect(html).toContain('XXXXXX9012');
    expect(html).not.toContain('123456789012');
    expect(html).not.toContain('ABCDE1234F');
  });
  it('escapes names and makes no statutory rate claim', () => {
    expect(html).not.toContain('<b>Asha</b>');
    expect(html).not.toMatch(/12%|0\.75%/);
  });
});

describe('wiring', () => {
  it('keeps db/hr-documents-schema.sql identical to the DDL in code', () => {
    expect(readFileSync('db/hr-documents-schema.sql', 'utf8')).toContain(HR_DOCUMENTS_DDL.trim());
  });
  it('emails every document type with a verify link and its own frame', () => {
    for (const t of HR_DOC_TYPES) {
      expect(LETTER_TYPES[t.letterKey], t.letterKey).toBeTruthy();
      expect(LETTER_TYPES[t.letterKey].framed).toBe(false);
    }
  });
});
