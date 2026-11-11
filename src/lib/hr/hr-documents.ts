// HR DOCUMENTS: the experience letter, the no-objection certificate and the relieving letter, each in
// its OWN format, plus the helpers the payslip uses to print amounts in words.
//
// =================================================================================================
// WHY THIS MODULE EXISTS
// =================================================================================================
//
// All three letters used to come out of one template on /admin/hr/offboarding with only the title
// swapped, and none of them was recorded anywhere. When a no-objection certificate was needed, the
// only desk that could issue something verifiable was the certificate desk, and the result was a
// "Certificate of Recognition" reading "is recognised for No Objection Certificate (NOC)" - a
// document an embassy, a bank or a next employer would rightly reject.
//
// These are three different documents with three different readers:
//   - EXPERIENCE LETTER  a business letter to whoever is assessing the person's work history.
//                        Prose: tenure, designation, what the person did.
//   - NO-OBJECTION CERT. a declaration to an authority (an employer, a university, a passport or
//                        visa office, a bank). Particulars in a table, the purpose stated, the
//                        conditions and validity stated, signed "for" the company.
//   - RELIEVING LETTER   a letter TO the person, accepting the resignation and fixing the date they
//                        were relieved.
// So each has its own layout below, and they share only the letterhead and the verification line.
//
// WORDING RULES
//   - Never a pronoun chosen from data. Sentences use the person's name, an honorific HR picked on
//     the form (or none), or "you" in the relieving letter. Nothing here reads a gender column.
//   - Nothing is asserted that HR did not tick. "No dues" is printed only when HR confirmed it; the
//     performance remark is printed only when HR wrote one.
//   - Email-safe markup, as src/lib/hr/brand-doc.ts explains: nested tables, inline styles, system
//     font stacks. The same HTML is printed, emailed and shown on the public verification page.
//
// PURE. No database, no transport. Every value is escaped here.

import { BRAND, esc, longDate, letterheadHtml } from '@/lib/hr/brand-doc';

export type HrDocType = 'experience' | 'noc' | 'relieving';

export interface HrDocTypeDef {
  value: HrDocType;
  label: string;
  /** Three letters in the serial, so the type is readable from the number alone. */
  prefix: string;
  /** The key in src/lib/hr/letter-mail.ts LETTER_TYPES used to email it. */
  letterKey: string;
  /** One line on the issue form saying who the document is for. */
  forWhom: string;
}

export const HR_DOC_TYPES: readonly HrDocTypeDef[] = Object.freeze([
  { value: 'experience', label: 'Experience letter', prefix: 'EXP', letterKey: 'offboarding:experience', forWhom: 'For a future employer or anyone assessing the person\'s work history.' },
  { value: 'noc', label: 'No-objection certificate (NOC)', prefix: 'NOC', letterKey: 'offboarding:noc', forWhom: 'For an authority: another employer, a university, a passport or visa office, or a bank.' },
  { value: 'relieving', label: 'Relieving letter', prefix: 'REL', letterKey: 'offboarding:relieving', forWhom: 'Addressed to the person who resigned, confirming the date they were relieved.' },
] as HrDocTypeDef[]);

export function hrDocType(v: unknown): HrDocTypeDef | null {
  return HR_DOC_TYPES.find((t) => t.value === v) || null;
}

export const HONORIFICS: readonly string[] = Object.freeze(['', 'Mr.', 'Ms.', 'Mx.', 'Dr.']);

export type NocPurpose = 'employment' | 'higher_studies' | 'passport' | 'visa_travel' | 'loan' | 'other';

export const NOC_PURPOSES: readonly { value: NocPurpose; label: string; phrase: string }[] = Object.freeze([
  { value: 'employment', label: 'Taking up employment elsewhere', phrase: 'taking up employment with another organisation' },
  { value: 'higher_studies', label: 'Higher studies', phrase: 'pursuing higher studies' },
  { value: 'passport', label: 'Passport application or renewal', phrase: 'applying for, or renewing, a passport' },
  { value: 'visa_travel', label: 'Visa and travel abroad', phrase: 'applying for a visa and travelling abroad' },
  { value: 'loan', label: 'Loan or financial application', phrase: 'applying for a loan or other financial facility' },
  { value: 'other', label: 'Other (state the purpose)', phrase: '' },
] as { value: NocPurpose; label: string; phrase: string }[]);

/** Everything any of the three documents may print. Each renderer reads only what it needs. */
export interface HrDocInput {
  serial: string;
  issueDate: string;            // YYYY-MM-DD
  honorific?: string;
  employeeName: string;
  employeeCode?: string;
  designation: string;
  department?: string;
  employmentType?: string;
  joiningDate: string;          // YYYY-MM-DD
  /** Last working day. Empty means the person is still employed (experience letter and NOC only). */
  endDate?: string;
  signatoryName: string;
  signatoryTitle: string;
  /** Public verification address, printed at the foot. */
  verifyUrl?: string;
  // experience
  responsibilities?: string[];
  remarks?: string;
  requestPurpose?: string;
  // noc
  addressee?: string;
  purpose?: NocPurpose | string;
  purposeText?: string;
  purposeDetail?: string;
  validUntil?: string;
  conditions?: string[];
  // noc + relieving
  duesCleared?: boolean;
  // relieving
  resignationDate?: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v: unknown): v is string => typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));

/** The person as the letter names them: an honorific HR chose, then the name. */
export function personName(i: Pick<HrDocInput, 'honorific' | 'employeeName'>): string {
  const h = HONORIFICS.includes(String(i.honorific || '')) ? String(i.honorific || '') : '';
  return (h ? h + ' ' : '') + String(i.employeeName || '').trim();
}

/** Lines typed one per line into a textarea, trimmed, blank lines dropped, capped. */
export function lines(v: unknown, max = 12, each = 300): string[] {
  return String(v ?? '').split(/\r?\n/).map((s) => s.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean).slice(0, max).map((s) => s.slice(0, each));
}

/**
 * What is wrong with a document before it is issued, as sentences for the form. Empty means it may
 * be issued. Dates are checked against each other because a letter whose last working day precedes
 * the joining date is exactly the kind of error a verifier notices first.
 */
export function documentProblems(type: HrDocType, i: HrDocInput): string[] {
  const p: string[] = [];
  if (String(i.employeeName || '').trim().length < 2) p.push('Enter the person\'s full name.');
  if (!String(i.designation || '').trim()) p.push('Enter the designation.');
  if (!isDate(i.joiningDate)) p.push('Enter the date of joining.');
  if (!isDate(i.issueDate)) p.push('Enter the date of issue.');
  if (!String(i.signatoryName || '').trim() || !String(i.signatoryTitle || '').trim()) p.push('Enter the signatory\'s name and title.');
  if (i.endDate && !isDate(i.endDate)) p.push('The last working day is not a valid date.');
  if (isDate(i.joiningDate) && isDate(i.endDate) && i.endDate < i.joiningDate) p.push('The last working day is before the date of joining.');
  if (isDate(i.joiningDate) && isDate(i.issueDate) && i.issueDate < i.joiningDate) p.push('The date of issue is before the date of joining.');
  if (type === 'noc') {
    const purpose = NOC_PURPOSES.find((x) => x.value === i.purpose);
    if (!purpose) p.push('Choose the purpose of the certificate.');
    if (i.purpose === 'other' && String(i.purposeText || '').trim().length < 5) p.push('Describe the purpose of the certificate.');
    if (i.validUntil && !isDate(i.validUntil)) p.push('The validity date is not a valid date.');
    if (isDate(i.validUntil) && isDate(i.issueDate) && i.validUntil < i.issueDate) p.push('The certificate would expire before it is issued.');
  }
  if (type === 'relieving') {
    if (!isDate(i.endDate)) p.push('A relieving letter needs the last working day.');
    if (i.resignationDate && !isDate(i.resignationDate)) p.push('The resignation date is not a valid date.');
    if (isDate(i.resignationDate) && isDate(i.endDate) && i.endDate < i.resignationDate) p.push('The last working day is before the resignation date.');
  }
  return p;
}

// -------------------------------------------------------------------------------------------------
// SHARED FRAME: letterhead and foot. Everything between them differs per document.
// -------------------------------------------------------------------------------------------------

function frame(inner: string, i: HrDocInput, docLabel: string): string {
  const verify = i.verifyUrl
    ? 'Verify this ' + esc(docLabel.toLowerCase()) + ' at <a href="' + esc(i.verifyUrl) + '" style="color:' + BRAND.saffron + ';text-decoration:none;">' + esc(i.verifyUrl.replace(/^https?:\/\//, '')) + '</a>'
    : '';
  return ''
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid ' + BRAND.rule + ';border-collapse:separate;">'
    + '<tr><td style="padding:30px 36px 0 36px;">'
    // The house letterhead (wordmark, address, reference, date), shared with every HR letter.
    + letterheadHtml({ refNumber: i.serial, issueDate: i.issueDate })
    + '</td></tr>'
    + '<tr><td style="padding:22px 36px 8px 36px;">' + inner + '</td></tr>'
    + '<tr><td style="padding:10px 36px 26px 36px;">'
    + '<div style="border-top:1px solid ' + BRAND.rule + ';padding-top:10px;font-family:' + BRAND.sans + ';font-size:10px;line-height:1.6;color:' + BRAND.muted + ';">'
    + esc(docLabel) + ' No. <strong style="color:' + BRAND.ink + ';font-family:Consolas,Menlo,monospace;">' + esc(i.serial) + '</strong>'
    + (verify ? '<br>' + verify : '')
    + '<br>This document is valid only while the verification page above shows it as valid.'
    + '</div></td></tr>'
    + '</table>';
}

const P = (html: string) => '<p style="font-family:' + BRAND.serif + ';font-size:14.5px;line-height:1.75;color:#1d1a16;margin:0 0 14px 0;">' + html + '</p>';


function signature(i: HrDocInput, opts: { forCompany?: boolean; align?: 'left' | 'right'; authorised?: boolean } = {}): string {
  const align = opts.align || 'left';
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 6px 0;"><tr><td align="' + align + '">'
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="text-align:' + align + ';font-family:' + BRAND.sans + ';font-size:12.5px;line-height:1.6;color:#1d1a16;">'
    + (opts.forCompany ? '<div style="font-weight:700;margin-bottom:34px;">For EduRankAI</div>' : '<div style="margin-bottom:34px;">Yours sincerely,</div>')
    + '<div style="border-top:1px solid ' + BRAND.ink + ';width:220px;' + (align === 'right' ? 'margin-left:auto;' : '') + 'padding-top:6px;font-weight:700;font-size:13.5px;">' + esc(i.signatoryName) + '</div>'
    + '<div style="color:' + BRAND.muted + ';">' + esc(i.signatoryTitle) + (opts.forCompany ? '' : ', EduRankAI') + '</div>'
    + (opts.authorised ? '<div style="color:' + BRAND.muted + ';font-size:11px;letter-spacing:0.6px;text-transform:uppercase;margin-top:2px;">Authorised signatory</div>' : '')
    + '</td></tr></table></td></tr></table>';
}

const tenure = (i: HrDocInput): string => (i.endDate ? 'from ' + longDate(i.joiningDate) + ' to ' + longDate(i.endDate) : 'since ' + longDate(i.joiningDate));

// -------------------------------------------------------------------------------------------------
// 1. EXPERIENCE LETTER - a business letter in prose.
// -------------------------------------------------------------------------------------------------

export function experienceLetterHtml(i: HrDocInput): string {
  const name = esc(personName(i));
  const code = i.employeeCode ? ' (Employee ID ' + esc(i.employeeCode) + ')' : '';
  const team = i.department ? ' in the ' + esc(i.department) + ' team' : '';
  const kind = i.employmentType && !/full[\s-]?time/i.test(i.employmentType) ? ' on a ' + esc(i.employmentType.toLowerCase()) + ' basis' : '';
  const opening = i.endDate
    ? 'This is to certify that <strong>' + name + '</strong>' + code + ' was employed with EduRankAI' + kind + ' as <strong>' + esc(i.designation) + '</strong>' + team + ' ' + esc(tenure(i)) + '.'
    : 'This is to certify that <strong>' + name + '</strong>' + code + ' has been employed with EduRankAI' + kind + ' as <strong>' + esc(i.designation) + '</strong>' + team + ' ' + esc(tenure(i)) + ', and continues in that role on the date of this letter.';
  const duties = (i.responsibilities || []).filter(Boolean);
  const dutiesHtml = duties.length
    ? P('During ' + (i.endDate ? 'this period' : 'this time') + ', the responsibilities of ' + name + ' included:')
      + '<ul style="font-family:' + BRAND.serif + ';font-size:14.5px;line-height:1.7;color:#1d1a16;margin:0 0 16px 0;padding-left:22px;">'
      + duties.map((d) => '<li style="margin:0 0 4px 0;">' + esc(d) + '</li>').join('')
      + '</ul>'
    : '';
  const remarks = String(i.remarks || '').trim() ? P(esc(String(i.remarks).trim())) : '';
  const purpose = String(i.requestPurpose || '').trim();
  const closing = P('This letter is issued at the request of ' + name + (purpose ? ' for the purpose of ' + esc(purpose) : '') + '. We wish ' + name + ' every success.');
  const inner = ''
    + '<div style="font-family:' + BRAND.sans + ';font-size:11px;letter-spacing:2.4px;text-transform:uppercase;color:' + BRAND.saffron + ';font-weight:700;margin:0 0 6px 0;">Experience letter</div>'
    + '<div style="font-family:' + BRAND.serif + ';font-size:15px;font-weight:700;color:' + BRAND.ink + ';margin:0 0 18px 0;">To whom it may concern</div>'
    + P(opening) + dutiesHtml + remarks + closing
    + signature(i);
  return frame(inner, i, 'Experience letter');
}

// -------------------------------------------------------------------------------------------------
// 2. NO-OBJECTION CERTIFICATE - a declaration with particulars, purpose, conditions and validity.
// -------------------------------------------------------------------------------------------------

export function nocPurposeLabel(i: Pick<HrDocInput, 'purpose' | 'purposeText'>): string {
  if (i.purpose === 'other') return String(i.purposeText || '').trim();
  return NOC_PURPOSES.find((x) => x.value === i.purpose)?.label || '';
}

function nocPurposePhrase(i: HrDocInput): string {
  if (i.purpose === 'other') return String(i.purposeText || '').trim().replace(/\.$/, '');
  return NOC_PURPOSES.find((x) => x.value === i.purpose)?.phrase || '';
}

export function nocHtml(i: HrDocInput): string {
  const name = esc(personName(i));
  const current = !i.endDate;
  const row = (k: string, v: string) => v
    ? '<tr><td style="padding:7px 12px;border-bottom:1px solid ' + BRAND.rule + ';font-family:' + BRAND.sans + ';font-size:11.5px;color:' + BRAND.muted + ';width:38%;text-transform:uppercase;letter-spacing:0.6px;">' + esc(k) + '</td>'
      + '<td style="padding:7px 12px;border-bottom:1px solid ' + BRAND.rule + ';font-family:' + BRAND.sans + ';font-size:13.5px;color:' + BRAND.ink + ';font-weight:600;">' + esc(v) + '</td></tr>'
    : '';
  const particulars = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ' + BRAND.rule + ';border-bottom:0;margin:0 0 18px 0;background:' + BRAND.paper + ';">'
    + row('Name', personName(i))
    + row('Employee ID', i.employeeCode || '')
    + row('Designation', i.designation)
    + row('Department', i.department || '')
    + row('Date of joining', longDate(i.joiningDate))
    + row('Employment status', current ? 'Currently employed' : 'Employed until ' + longDate(i.endDate))
    + row('Purpose', nocPurposeLabel(i))
    + row('Details', String(i.purposeDetail || '').trim())
    + '</table>';
  const phrase = esc(nocPurposePhrase(i));
  const declaration = current
    ? 'EduRankAI certifies that ' + name + ' is employed with the company as ' + esc(i.designation) + ' ' + esc(tenure(i)) + ', and that the company has <strong>no objection</strong> to ' + name + ' ' + phrase + '.'
    : 'EduRankAI certifies that ' + name + ' was employed with the company as ' + esc(i.designation) + ' ' + esc(tenure(i)) + ', and that the company has <strong>no objection</strong> to ' + name + ' ' + phrase + '.';
  const conditions: string[] = [];
  if (current && i.purpose === 'employment') conditions.push('This certificate is not a relieving letter. It does not by itself release ' + personName(i) + ' from the notice period or any other obligation under the terms of employment.');
  if (current && i.purpose !== 'employment') conditions.push(personName(i) + ' remains an employee of EduRankAI, and this certificate does not change the terms of that employment.');
  if (i.duesCleared) conditions.push('As on the date of issue, there are no outstanding dues, liabilities or company assets pending from ' + personName(i) + '.');
  for (const c of i.conditions || []) if (c) conditions.push(c);
  if (isDate(i.validUntil)) conditions.push('This certificate is valid until ' + longDate(i.validUntil) + '.');
  const conditionsHtml = conditions.length
    ? '<div style="font-family:' + BRAND.sans + ';font-size:11px;letter-spacing:1.6px;text-transform:uppercase;color:' + BRAND.muted + ';font-weight:700;margin:4px 0 6px 0;">Conditions</div>'
      + '<ol style="font-family:' + BRAND.serif + ';font-size:13.5px;line-height:1.65;color:#1d1a16;margin:0 0 14px 0;padding-left:22px;">'
      + conditions.map((c) => '<li style="margin:0 0 4px 0;">' + esc(c) + '</li>').join('')
      + '</ol>'
    : '';
  const addressee = String(i.addressee || '').trim() || 'To whom it may concern';
  const inner = ''
    // A bordered title band: the certificate is recognisable at a glance and cannot be mistaken
    // for a letter or a certificate of achievement.
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px 0;"><tr><td align="center" style="border-top:2px solid ' + BRAND.ink + ';border-bottom:2px solid ' + BRAND.ink + ';padding:10px 0;">'
    + '<div style="font-family:' + BRAND.sans + ';font-size:17px;letter-spacing:4px;font-weight:800;color:' + BRAND.ink + ';text-transform:uppercase;">No Objection Certificate</div>'
    + '</td></tr></table>'
    + '<div style="font-family:' + BRAND.serif + ';font-size:14.5px;color:#1d1a16;margin:0 0 6px 0;font-weight:700;">' + esc(addressee) + '</div>'
    + '<div style="font-family:' + BRAND.serif + ';font-size:14.5px;color:#1d1a16;margin:0 0 16px 0;"><strong>Subject:</strong> No objection for ' + esc(nocPurposeLabel(i).toLowerCase() || 'the stated purpose') + '</div>'
    + particulars
    + P(declaration)
    + conditionsHtml
    + P('This certificate is issued at the request of ' + name + ' for the purpose stated above and for no other purpose.')
    + signature(i, { forCompany: true, align: 'right', authorised: true });
  return frame(inner, i, 'No-objection certificate');
}

// -------------------------------------------------------------------------------------------------
// 3. RELIEVING LETTER - addressed to the person.
// -------------------------------------------------------------------------------------------------

export function relievingLetterHtml(i: HrDocInput): string {
  const name = esc(personName(i));
  const inner = ''
    + '<div style="font-family:' + BRAND.sans + ';font-size:13px;line-height:1.6;color:#1d1a16;margin:0 0 18px 0;">'
    + '<strong>' + name + '</strong>' + (i.employeeCode ? '<br>Employee ID ' + esc(i.employeeCode) : '') + '<br>' + esc(i.designation) + (i.department ? ', ' + esc(i.department) : '')
    + '</div>'
    + '<div style="font-family:' + BRAND.serif + ';font-size:14.5px;color:#1d1a16;margin:0 0 16px 0;"><strong>Subject:</strong> Relieving letter</div>'
    + P('Dear ' + name + ',')
    + P((isDate(i.resignationDate) ? 'This refers to your resignation dated ' + esc(longDate(i.resignationDate)) + '. ' : 'This refers to your resignation. ')
      + 'Your resignation has been accepted, and you are relieved from the services of EduRankAI with effect from the close of business on <strong>' + esc(longDate(i.endDate)) + '</strong>.')
    + P('You were employed with EduRankAI ' + esc(tenure(i)) + '. At the time of leaving, your designation was <strong>' + esc(i.designation) + '</strong>' + (i.department ? ' in the ' + esc(i.department) + ' team' : '') + '.')
    + (i.duesCleared ? P('Your full and final settlement has been completed, and no dues are outstanding on either side.') : '')
    + P('We thank you for your contribution to EduRankAI and wish you success in the years ahead.')
    + signature(i);
  return frame(inner, i, 'Relieving letter');
}

export function renderHrDocument(type: HrDocType, i: HrDocInput): string {
  if (type === 'noc') return nocHtml(i);
  if (type === 'relieving') return relievingLetterHtml(i);
  return experienceLetterHtml(i);
}

// -------------------------------------------------------------------------------------------------
// SERIALS, AND THE GUARD THAT KEEPS LETTERS OUT OF THE CERTIFICATE DESK
// -------------------------------------------------------------------------------------------------

/** No 0/O, 1/I/L: a serial is read aloud and typed in by a verifier. */
const SERIAL_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** ERA-NOC-2026-K7Q2MX. `bytes` are random bytes from the caller (crypto in the store). */
export function documentSerial(type: HrDocType, year: number, bytes: ArrayLike<number>): string {
  const def = hrDocType(type);
  let tail = '';
  for (let k = 0; k < 6; k++) tail += SERIAL_ALPHABET[(bytes[k] ?? 0) % SERIAL_ALPHABET.length];
  return 'ERA-' + (def ? def.prefix : 'DOC') + '-' + year + '-' + tail;
}

export function isDocumentSerial(v: unknown): boolean {
  return /^ERA-(EXP|NOC|REL)-\d{4}-[A-HJ-NP-Z2-9]{6}$/.test(String(v || ''));
}

/**
 * True when a certificate title is really one of the letters above, or a pay document. The
 * certificate desk refuses these and points to /admin/hr/documents, so a no-objection certificate
 * can never again be issued as "a Certificate of Recognition for No Objection Certificate".
 */
export function letterLikeTitle(title: unknown): boolean {
  return /\b(no[\s-]*objection|n\.?\s?o\.?\s?c\.?|experience\s+(letter|certificate)|relieving|pay\s*-?\s*slip|salary\s+(slip|certificate))\b/i.test(String(title || ''));
}

// -------------------------------------------------------------------------------------------------
// AMOUNTS IN WORDS (payslip)
// -------------------------------------------------------------------------------------------------

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowThousand(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h) parts.push(ONES[h] + ' Hundred');
  if (r) parts.push(r < 20 ? ONES[r] : TENS[Math.floor(r / 10)] + (r % 10 ? '-' + ONES[r % 10] : ''));
  return parts.join(' and ');
}

/** Indian grouping: crore, lakh, thousand. 4520000 -> "Forty-Five Lakh Twenty Thousand". */
export function wordsIndian(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'Zero';
  const out: string[] = [];
  const crore = Math.floor(n / 10_000_000); n %= 10_000_000;
  const lakh = Math.floor(n / 100_000); n %= 100_000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  if (crore) out.push((crore >= 1000 ? wordsIndian(crore) : belowThousand(crore)) + ' Crore');
  if (lakh) out.push(belowThousand(lakh) + ' Lakh');
  if (thousand) out.push(belowThousand(thousand) + ' Thousand');
  if (n) out.push(belowThousand(n));
  return out.join(' ');
}

/** International grouping: billion, million, thousand. */
export function wordsInternational(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'Zero';
  const scales: [number, string][] = [[1_000_000_000, 'Billion'], [1_000_000, 'Million'], [1000, 'Thousand']];
  const out: string[] = [];
  for (const [v, w] of scales) { const q = Math.floor(n / v); if (q) { out.push(belowThousand(q) + ' ' + w); n %= v; } }
  if (n) out.push(belowThousand(n));
  return out.join(' ');
}

/** "Rupees Forty-Five Thousand Two Hundred and Fifty Paise Only", or "USD One Thousand Only". */
export function amountInWords(amount: unknown, currency = 'INR'): string {
  const v = Number(amount);
  if (!Number.isFinite(v)) return '';
  const cents = Math.round(Math.abs(v) * 100);
  const whole = Math.floor(cents / 100);
  const frac = cents % 100;
  if ((currency || 'INR').toUpperCase() === 'INR') {
    return 'Rupees ' + wordsIndian(whole) + (frac ? ' and ' + belowThousand(frac) + ' Paise' : '') + ' Only';
  }
  return currency.toUpperCase() + ' ' + wordsInternational(whole) + (frac ? ' and ' + belowThousand(frac) + ' Cents' : '') + ' Only';
}

/** "XXXXXX1234": what a payslip prints for a bank account or an identity number. */
export function maskTail(v: unknown, keep = 4): string {
  const s = String(v ?? '').replace(/\s+/g, '');
  if (!s) return '';
  if (s.length <= keep) return s;
  return 'X'.repeat(Math.min(6, s.length - keep)) + s.slice(-keep);
}

// -------------------------------------------------------------------------------------------------
// FORM -> INPUT. One reader for the issue form, so preview and issue can never read it differently.
// -------------------------------------------------------------------------------------------------

const clip = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);
const dateOrEmpty = (v: unknown) => (isDate(String(v ?? '').trim()) ? String(v).trim() : '');

export function inputFromForm(get: (name: string) => string, serial = 'ERA-XXX-0000-PREVIEW', verifyUrl = ''): HrDocInput {
  const honorific = HONORIFICS.includes(get('honorific')) ? get('honorific') : '';
  return {
    serial, verifyUrl,
    issueDate: dateOrEmpty(get('issue_date')),
    honorific,
    employeeName: clip(get('employee_name'), 200),
    employeeCode: clip(get('employee_code'), 60),
    designation: clip(get('designation'), 200),
    department: clip(get('department'), 200),
    employmentType: clip(get('employment_type'), 60),
    joiningDate: dateOrEmpty(get('joining_date')),
    endDate: dateOrEmpty(get('end_date')),
    signatoryName: clip(get('signatory_name'), 200),
    signatoryTitle: clip(get('signatory_title'), 200),
    responsibilities: lines(get('responsibilities'), 12, 300),
    remarks: clip(get('remarks'), 1200),
    requestPurpose: clip(get('request_purpose'), 300),
    addressee: clip(get('addressee'), 300),
    purpose: clip(get('purpose'), 40),
    purposeText: clip(get('purpose_text'), 300),
    purposeDetail: clip(get('purpose_detail'), 500),
    validUntil: dateOrEmpty(get('valid_until')),
    conditions: lines(get('conditions'), 8, 400),
    duesCleared: get('dues_cleared') === 'yes',
    resignationDate: dateOrEmpty(get('resignation_date')),
  };
}

/** The fields kept on the register row: everything on the form except the rendering-only values. */
export function storedFields(i: HrDocInput): Record<string, unknown> {
  const { serial: _s, verifyUrl: _v, ...rest } = i;
  return rest;
}
