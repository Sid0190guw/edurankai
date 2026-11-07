// THE BRANDED DOCUMENTS THIS COMPANY PUTS ITS NAME ON: certificate, promotion letter, offer summary.
//
// =================================================================================================
// WHY ONE MODULE, AND WHY IT IS BUILT FROM TABLES
// =================================================================================================
//
// The completion certificate went out as a plain letter with the company name typed in a serif and a
// CSS circle reading "EDU RANK AI" where a seal should be. No logo, no frame, nothing a graduate would
// want to frame or post. The public credential page and the emailed copy were also two different
// renderings, so the thing an employer verified did not look like the thing the person was sent.
//
// Every document here is rendered by ONE function, and the same output is used on screen, in the
// email and on the public verification page. That is the rule letter-mail.ts already enforces for HR
// letters ("the preview is the document"), applied to the certificate as well.
//
// EMAIL-SAFE BY CONSTRUCTION. Mail clients ignore flexbox, grid, SVG, web fonts and <style> blocks,
// and src/lib/mailsec/html.ts strips several of them on the way out anyway. So: nested tables, inline
// styles only, system serif/sans stacks. THE WORDMARK IS THE LOGO: "EduRankAI" set in type, with no
// icon tile beside it and no seal under the signature - the name carries the house, as it does on the
// letters of any firm that does not need to tell you it is official.
//
// PURE. No database, no transport. Every value from a form or a row is escaped here, because the
// output lands in our own origin (/credentials/<serial>) as well as in an inbox.

export const BRAND = Object.freeze({
  name: 'EduRankAI',
  saffron: '#FF4F00',
  ink: '#0E0B08',
  paper: '#FFFDF8',
  cream: '#F7F1E6',
  gold: '#B8892D',
  muted: '#6B635C',
  rule: '#E7DCC8',
  // The house line, as the rest of the site writes it. The wordmark IS the logo: no tile, no seal.
  tagline: 'AI Research & Engineering',
  address: 'Guwahati, Assam, India',
  contact: 'hr@edurankai.in  |  edurankai.in',
  serif: "Georgia, 'Times New Roman', Times, serif",
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
});


export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];

/**
 * "2026-11-06" -> "6 November 2026".
 *
 * Read off the string, never through `new Date()`: a bare ISO date is parsed as UTC midnight, and on
 * a machine east or west of UTC the printed day moves. A date on a certificate is a claim.
 */
export function longDate(iso: unknown): string {
  const s = String(iso ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  const mon = MONTHS[Number(m[2]) - 1];
  if (!mon) return s;
  return Number(m[3]) + ' ' + mon + ' ' + m[1];
}

/** The wordmark as text, so it still reads when the mail client blocks images. */
function wordmark(size: number): string {
  return '<span style="font-family:' + BRAND.serif + ';font-size:' + size + 'px;font-weight:700;color:' + BRAND.ink
    + ';letter-spacing:-0.01em;">Edu<span style="color:' + BRAND.saffron + ';">Rank</span>AI</span>';
}


// -------------------------------------------------------------------------------------------------
// LETTERHEAD
// -------------------------------------------------------------------------------------------------

export interface LetterheadInput {
  refNumber?: string;
  issueDate?: string;
}

/** The top of every letter: the wordmark, the line, address, reference and date. A saffron rule beneath. */
export function letterheadHtml(h: LetterheadInput): string {
  return '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-bottom:3px solid ' + BRAND.saffron + ';">'
    + '<tr>'
    + '<td style="vertical-align:top;padding:0 0 18px;">'
    + '<p style="margin:0;line-height:1;">' + wordmark(30) + '</p>'
    + '<p style="margin:6px 0 0;font-family:' + BRAND.sans + ';font-size:9.5px;letter-spacing:0.2em;text-transform:uppercase;color:' + BRAND.saffron + ';font-weight:700;">' + esc(BRAND.tagline) + '</p>'
    + '<p style="margin:10px 0 0;font-family:' + BRAND.sans + ';font-size:11px;color:' + BRAND.muted + ';line-height:1.5;">'
    + esc(BRAND.address) + '<br />' + esc(BRAND.contact) + '</p>'
    + '</td>'
    + '<td align="right" style="vertical-align:top;padding:0 0 18px;font-family:' + BRAND.sans + ';">'
    + (h.refNumber
      ? '<p style="margin:0;font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:#9a9188;font-weight:700;">Reference</p>'
        + '<p style="margin:3px 0 0;font-family:Consolas,Menlo,monospace;font-size:12.5px;color:' + BRAND.ink + ';font-weight:600;">' + esc(h.refNumber) + '</p>'
      : '')
    + (h.issueDate ? '<p style="margin:6px 0 0;font-size:11.5px;color:' + BRAND.muted + ';">' + esc(longDate(h.issueDate)) + '</p>' : '')
    + '</td>'
    + '</tr></table>';
}

/** Signature block. Shared by letters so they sign off identically. No seal: the name and the house carry it. */
function signOff(name: string, title: string): string {
  return '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:30px;">'
    + '<tr><td style="vertical-align:bottom;font-family:' + BRAND.sans + ';">'
    + '<p style="margin:0 0 4px;font-size:13px;color:#3a332d;">With warm regards,</p>'
    + '<p style="margin:14px 0 0;font-family:' + BRAND.serif + ';font-style:italic;font-size:21px;color:' + BRAND.ink + ';">' + esc(name || 'EduRankAI') + '</p>'
    + '<p style="margin:6px 0 0;width:200px;border-top:1px solid ' + BRAND.ink + ';font-size:0;line-height:0;">&nbsp;</p>'
    + (title ? '<p style="margin:6px 0 0;font-size:12px;color:' + BRAND.muted + ';">' + esc(title) + '</p>' : '')
    + '<p style="margin:2px 0 0;font-size:12px;font-weight:700;color:' + BRAND.saffron + ';">EduRankAI</p>'
    + '</td></tr></table>';
}

// -------------------------------------------------------------------------------------------------
// CERTIFICATE
// -------------------------------------------------------------------------------------------------

export interface CertificateInput {
  recipientName: string;
  /** The large heading, e.g. "Certificate of Internship Completion". */
  heading: string;
  /** What was completed, e.g. "AI Research Internship". Printed prominently. */
  programme: string;
  /** The sentence fragment between the name and the programme. */
  verb?: string;
  department?: string;
  fromDate?: string;
  toDate?: string;
  /** A short distinction line, e.g. "with Distinction". Printed as a ribbon under the programme. */
  distinction?: string;
  /** The citation paragraph. Plain text; line breaks are kept. */
  citation?: string;
  achievements?: string[];
  /** A measured line such as credits or a score. Printed small, beneath the citation. */
  measureLine?: string;
  signatoryName?: string;
  signatoryTitle?: string;
  issueDate?: string;
  serial?: string;
  /** The public verification address. Printed in words AND linked. */
  verifyUrl?: string;
  /** Revoked certificates still render (the public page must show what was revoked), marked as such. */
  revoked?: boolean;
  /** Skills, from the job description and the issuer. Printed as a row, and offered for LinkedIn. */
  skills?: string[];
  /** ISO time of the last correction, when there has been one. Printed, because a certificate that
   *  changed after it was issued must say so. */
  amendedAt?: string;
}

/**
 * THE CERTIFICATE. One rendering for the screen, the inbox and the verification page.
 *
 * It states what was done and when, who signed it, and how to check it. It does NOT call itself a
 * degree or an academic award: EduRankAI is the technology platform, and academic credit where it
 * applies is awarded by accredited partners. That sentence is printed on the certificate itself,
 * because the certificate is the artefact somebody later reads as a claim about what we are.
 */
export function certificateHtml(c: CertificateInput): string {
  const name = esc(c.recipientName || '');
  const verb = esc(c.verb || 'has successfully completed the');
  const range = c.fromDate && c.toDate
    ? 'from <strong>' + esc(longDate(c.fromDate)) + '</strong> to <strong>' + esc(longDate(c.toDate)) + '</strong>'
    : c.toDate ? 'concluding on <strong>' + esc(longDate(c.toDate)) + '</strong>' : '';
  const dept = c.department ? ' in the <strong>' + esc(c.department) + '</strong> team' : '';

  const achievements = (c.achievements || []).map((a) => String(a || '').trim()).filter(Boolean).slice(0, 6);
  const achievementRows = achievements.map((a) =>
    '<tr><td width="16" style="vertical-align:top;padding:5px 0 0;"><div style="width:6px;height:6px;background:' + BRAND.saffron + ';font-size:0;line-height:0;">&nbsp;</div></td>'
    + '<td style="padding:0 0 6px;font-family:' + BRAND.sans + ';font-size:13px;line-height:1.6;color:#3a332d;">' + esc(a) + '</td></tr>').join('');

  const verifyText = c.verifyUrl ? esc(c.verifyUrl.replace(/^https?:\/\//, '')) : '';
  const skillCells = (c.skills || []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 12)
    .map((x) => '<span style="display:inline-block;margin:0 3px;padding:3px 11px;border:1px solid ' + BRAND.rule
      + ';border-radius:100px;font-family:' + BRAND.sans + ';font-size:11.5px;color:#3a332d;background:#ffffff;white-space:nowrap;">' + esc(x) + '</span>')
    .join(' ');

  return '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:' + BRAND.ink + ';border-radius:6px;">'
    + '<tr><td style="padding:9px;">'
    + '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:' + BRAND.paper + ';border:1px solid ' + BRAND.gold + ';">'
    + '<tr><td style="padding:5px;">'
    + '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ' + BRAND.rule + ';">'
    + '<tr><td align="center" style="padding:34px 30px 28px;text-align:center;">'

    // Revoked marker, above everything, so a printed copy of a withdrawn certificate says so.
    + (c.revoked
      ? '<p style="margin:0 0 16px;font-family:' + BRAND.sans + ';font-size:11px;letter-spacing:0.2em;font-weight:800;color:#b91c1c;">REVOKED. THIS CERTIFICATE IS NO LONGER VALID.</p>'
      : '')

    // Mark and wordmark
    + '<p style="margin:0;line-height:1;">' + wordmark(36) + '</p>'
    + '<p style="margin:7px 0 0;font-family:' + BRAND.sans + ';font-size:9.5px;letter-spacing:0.24em;text-transform:uppercase;color:' + BRAND.muted + ';font-weight:700;">' + esc(BRAND.tagline) + '</p>'

    // Heading
    + '<p style="margin:22px auto 0;width:64px;border-top:2px solid ' + BRAND.saffron + ';font-size:0;line-height:0;">&nbsp;</p>'
    + '<p style="margin:16px 0 0;font-family:' + BRAND.sans + ';font-size:11.5px;letter-spacing:0.28em;text-transform:uppercase;color:' + BRAND.gold + ';font-weight:800;">' + esc(c.heading || 'Certificate') + '</p>'

    // Name
    + '<p style="margin:20px 0 0;font-family:' + BRAND.serif + ';font-size:14px;font-style:italic;color:' + BRAND.muted + ';">This is to certify that</p>'
    + '<p style="margin:10px 0 0;font-family:' + BRAND.serif + ';font-size:34px;line-height:1.15;color:' + BRAND.ink + ';font-weight:700;">' + name + '</p>'
    + '<p style="margin:10px auto 0;width:70%;border-top:1px solid ' + BRAND.gold + ';font-size:0;line-height:0;">&nbsp;</p>'

    // What and when
    + '<p style="margin:16px 0 0;font-family:' + BRAND.serif + ';font-size:14.5px;line-height:1.7;color:#3a332d;">' + verb + '</p>'
    + '<p style="margin:6px 0 0;font-family:' + BRAND.serif + ';font-size:21px;line-height:1.3;color:' + BRAND.ink + ';font-weight:700;">' + esc(c.programme || '') + '</p>'
    + (c.distinction
      ? '<table cellpadding="0" cellspacing="0" border="0" align="center" style="margin-top:12px;"><tr><td style="background:' + BRAND.saffron + ';padding:5px 16px;border-radius:100px;font-family:' + BRAND.sans + ';font-size:10.5px;letter-spacing:0.16em;text-transform:uppercase;color:#ffffff;font-weight:800;">' + esc(c.distinction) + '</td></tr></table>'
      : '')
    + ((dept || range)
      ? '<p style="margin:14px 0 0;font-family:' + BRAND.serif + ';font-size:14px;line-height:1.7;color:#3a332d;">at <strong>EduRankAI</strong>' + dept + (range ? ', ' + range : '') + '.</p>'
      : '')

    // Citation
    + (c.citation && c.citation.trim()
      ? '<p style="margin:18px auto 0;max-width:470px;font-family:' + BRAND.serif + ';font-size:14px;font-style:italic;line-height:1.75;color:#4a4239;">' + esc(c.citation.trim()).replace(/\r?\n/g, '<br />') + '</p>'
      : '')

    + '</td></tr>'

    // Achievements
    + (achievementRows
      ? '<tr><td style="padding:0 40px 8px;">'
        + '<p style="margin:0 0 10px;font-family:' + BRAND.sans + ';font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:' + BRAND.gold + ';font-weight:800;text-align:center;">Key contributions</p>'
        + '<table width="100%" cellpadding="0" cellspacing="0" border="0">' + achievementRows + '</table>'
        + '</td></tr>'
      : '')

    + (skillCells
      ? '<tr><td align="center" style="padding:6px 34px 6px;text-align:center;">'
        + '<p style="margin:0 0 8px;font-family:' + BRAND.sans + ';font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:' + BRAND.gold + ';font-weight:800;">Skills demonstrated</p>'
        + '<p style="margin:0;line-height:2.1;">' + skillCells + '</p>'
        + '</td></tr>'
      : '')

    + (c.measureLine
      ? '<tr><td align="center" style="padding:6px 40px 0;font-family:' + BRAND.sans + ';font-size:11.5px;line-height:1.6;color:' + BRAND.muted + ';text-align:center;">' + esc(c.measureLine) + '</td></tr>'
      : '')

    // Signature / seal / date and serial
    + '<tr><td style="padding:26px 30px 8px;">'
    + '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
    + '<td width="55%" style="vertical-align:bottom;font-family:' + BRAND.sans + ';text-align:left;">'
    + '<p style="margin:0;font-family:' + BRAND.serif + ';font-style:italic;font-size:19px;color:' + BRAND.ink + ';">' + esc(c.signatoryName || 'EduRankAI') + '</p>'
    + '<p style="margin:6px 0 0;border-top:1px solid ' + BRAND.ink + ';font-size:0;line-height:0;">&nbsp;</p>'
    + (c.signatoryTitle ? '<p style="margin:6px 0 0;font-size:11px;color:' + BRAND.muted + ';">' + esc(c.signatoryTitle) + '</p>' : '')
    + '<p style="margin:2px 0 0;font-size:11px;font-weight:700;color:' + BRAND.saffron + ';">EduRankAI</p>'
    + '</td>'
    + '<td width="45%" style="vertical-align:bottom;font-family:' + BRAND.sans + ';text-align:right;">'
    + '<p style="margin:0;font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:#9a9188;font-weight:700;">Date of issue</p>'
    + '<p style="margin:3px 0 0;font-size:13px;color:' + BRAND.ink + ';font-weight:600;">' + esc(longDate(c.issueDate || '')) + '</p>'
    + (c.serial
      ? '<p style="margin:10px 0 0;font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:#9a9188;font-weight:700;">Certificate no.</p>'
        + '<p style="margin:3px 0 0;font-family:Consolas,Menlo,monospace;font-size:11.5px;color:' + BRAND.ink + ';font-weight:700;">' + esc(c.serial) + '</p>'
      : '')
    + '</td>'
    + '</tr></table>'
    + '</td></tr>'

    // Verification and standing
    + '<tr><td align="center" style="padding:16px 30px 22px;text-align:center;font-family:' + BRAND.sans + ';">'
    + (c.verifyUrl
      ? '<p style="margin:0;font-size:11px;color:' + BRAND.muted + ';">Verify this certificate at <a href="' + esc(c.verifyUrl) + '" style="color:' + BRAND.saffron + ';text-decoration:none;font-weight:700;">' + verifyText + '</a></p>'
      : '')
    + (c.amendedAt
      ? '<p style="margin:6px 0 0;font-size:10px;color:' + BRAND.muted + ';">Amended on ' + esc(longDate(c.amendedAt.slice(0, 10))) + '. The record of what changed is kept with this certificate.</p>'
      : '')
    + '<p style="margin:8px 0 0;font-size:9.5px;line-height:1.55;color:#9a9188;">This certificate records a professional engagement with EduRankAI. It is not an academic degree; EduRankAI is the technology platform, and academic credit, where it applies, is awarded by accredited partners.</p>'
    + '</td></tr>'

    + '</table></td></tr></table></td></tr></table>';
}

/** Kinds the certificate desk issues, mapped to a heading and the sentence that introduces them. */
export const CERTIFICATE_WORDING: ReadonlyArray<{ kind: string; heading: string; verb: string }> = Object.freeze([
  { kind: 'internship', heading: 'Certificate of Internship Completion', verb: 'has successfully completed the' },
  { kind: 'employment', heading: 'Certificate of Service', verb: 'has served with distinction as' },
  { kind: 'course', heading: 'Certificate of Completion', verb: 'has successfully completed' },
  { kind: 'test', heading: 'Certificate of Achievement', verb: 'has passed' },
  { kind: 'event', heading: 'Certificate of Participation', verb: 'has participated in' },
  { kind: 'lor', heading: 'Certificate of Recommendation', verb: 'is recommended for their work as' },
  { kind: 'custom', heading: 'Certificate of Recognition', verb: 'is recognised for' },
]);

export function certificateWording(kind: string): { heading: string; verb: string } {
  const hit = CERTIFICATE_WORDING.find((w) => w.kind === String(kind || ''));
  return hit || CERTIFICATE_WORDING[CERTIFICATE_WORDING.length - 1];
}

/**
 * A universal_certificates row as a certificate. The public verification page and the email both
 * call this, so the copy an employer opens is the copy the graduate was sent.
 */
export function certificateFromRecord(row: any, verifyUrl?: string): CertificateInput {
  let meta: any = row?.metadata;
  if (typeof meta === 'string') {
    // A JSONB value bound as text can come back as its string form, depending on the driver path.
    try { meta = JSON.parse(meta); } catch { meta = {}; }
  }
  if (!meta || typeof meta !== 'object') meta = {};
  const wording = certificateWording(String(row?.kind || 'custom'));
  const achievements = Array.isArray(meta.achievements) ? meta.achievements.map((a: any) => String(a || '')) : [];
  const skills = Array.isArray(meta.skills) ? meta.skills.map((a: any) => String(a || '')).filter(Boolean) : [];
  const revisions = Array.isArray(meta.revisions) ? meta.revisions : [];
  const amendedAt = revisions.length ? String(revisions[revisions.length - 1]?.at || '') : '';
  const score = row?.score_pct != null && row.score_pct !== '' && Number.isFinite(Number(row.score_pct))
    ? 'Score on record: ' + Number(row.score_pct).toFixed(1) + '%.' : '';
  const measure = [String(meta.measureLine || '').trim(), score].filter(Boolean).join(' ');
  return {
    recipientName: String(row?.recipient_name || ''),
    heading: String(meta.heading || '').trim() || wording.heading,
    verb: wording.verb,
    programme: String(row?.title || ''),
    department: meta.department ? String(meta.department) : undefined,
    fromDate: meta.fromDate ? String(meta.fromDate).slice(0, 10) : undefined,
    toDate: meta.toDate ? String(meta.toDate).slice(0, 10) : undefined,
    distinction: row?.achievement ? String(row.achievement) : undefined,
    citation: row?.body ? String(row.body) : undefined,
    achievements,
    measureLine: measure || undefined,
    signatoryName: row?.issued_by_name ? String(row.issued_by_name) : undefined,
    signatoryTitle: row?.issued_by_designation ? String(row.issued_by_designation) : undefined,
    issueDate: row?.signed_at ? isoDay(row.signed_at) : undefined,
    serial: row?.serial ? String(row.serial) : undefined,
    verifyUrl,
    revoked: !!row?.revoked,
    skills,
    amendedAt: amendedAt || undefined,
  };
}

/** A DATE column as YYYY-MM-DD. postgres-js hands back a Date at UTC midnight for a DATE. */
function isoDay(v: any): string {
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return String(v || '').slice(0, 10);
}

// -------------------------------------------------------------------------------------------------
// PROMOTION LETTER
// -------------------------------------------------------------------------------------------------

export interface PromotionLetterInput {
  recipientName: string;
  /** promotion | designation_change. A demotion is never written as a letter of this kind. */
  kind: string;
  fromDesignation?: string | null;
  toDesignation: string;
  fromGrade?: string | null;
  toGrade?: string | null;
  effectiveDate: string;
  /** The operator's own paragraph: what the new role covers, revised terms. Plain text. */
  personalNote?: string;
  signatoryName: string;
  signatoryTitle?: string;
  refNumber: string;
  issueDate: string;
}

export function promotionLetterTitle(kind: string): string {
  return kind === 'designation_change' ? 'Letter of Re-designation' : 'Letter of Promotion';
}

/** The kinds a letter may be written for. A demotion is a conversation, not a congratulations. */
export function promotionLetterAllowed(kind: string): boolean {
  return kind === 'promotion' || kind === 'designation_change';
}

export function promotionLetterHtml(p: PromotionLetterInput): string {
  const first = esc(String(p.recipientName || '').trim().split(/\s+/)[0] || 'colleague');
  const isPromotion = p.kind !== 'designation_change';
  const row = (k: string, v: string) =>
    '<tr><td style="padding:9px 14px;border-bottom:1px solid ' + BRAND.rule + ';font-family:' + BRAND.sans + ';font-size:10.5px;letter-spacing:0.12em;text-transform:uppercase;color:#9a9188;font-weight:700;width:42%;">' + k + '</td>'
    + '<td style="padding:9px 14px;border-bottom:1px solid ' + BRAND.rule + ';font-family:' + BRAND.sans + ';font-size:13.5px;color:' + BRAND.ink + ';font-weight:600;">' + v + '</td></tr>';

  const facts = (p.fromDesignation ? row('Previous designation', esc(p.fromDesignation)) : '')
    + row('New designation', '<span style="color:' + BRAND.saffron + ';">' + esc(p.toDesignation) + '</span>')
    + (p.toGrade ? row('Grade', (p.fromGrade ? esc(p.fromGrade) + ' to ' : '') + esc(p.toGrade)) : '')
    + row('Effective from', esc(longDate(p.effectiveDate)));

  const para = (html: string) =>
    '<p style="margin:0 0 14px;font-family:' + BRAND.sans + ';font-size:14px;line-height:1.8;color:#3a332d;">' + html + '</p>';

  return '<div style="background:' + BRAND.paper + ';padding:30px 32px;border:1px solid ' + BRAND.rule + ';border-radius:8px;">'
    + letterheadHtml({ refNumber: p.refNumber, issueDate: p.issueDate })
    + '<p style="margin:22px 0 0;font-family:' + BRAND.sans + ';font-size:9.5px;letter-spacing:0.18em;text-transform:uppercase;color:#9a9188;font-weight:700;">Private and confidential</p>'
    + '<p style="margin:8px 0 0;font-family:' + BRAND.serif + ';font-size:26px;color:' + BRAND.ink + ';font-weight:700;">' + esc(promotionLetterTitle(p.kind)) + '</p>'
    + '<p style="margin:8px 0 22px;width:56px;border-top:2px solid ' + BRAND.saffron + ';font-size:0;line-height:0;">&nbsp;</p>'
    + para('Dear ' + first + ',')
    + (isPromotion
      ? para('<strong>Congratulations.</strong> We are delighted to confirm your promotion to the position of <strong>'
          + esc(p.toDesignation) + '</strong>, effective <strong>' + esc(longDate(p.effectiveDate)) + '</strong>.')
        + para('This promotion recognises the commitment, judgement and quality of work you have brought to EduRankAI. '
          + 'It has been reviewed and approved through our standard approval chain, and your record has been updated accordingly.')
      : para('This letter confirms that your designation changes to <strong>' + esc(p.toDesignation)
          + '</strong>, effective <strong>' + esc(longDate(p.effectiveDate)) + '</strong>. It has been approved through our standard approval chain.'))
    + '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 20px;background:#ffffff;border:1px solid ' + BRAND.rule + ';border-radius:6px;">' + facts + '</table>'
    + (p.personalNote && p.personalNote.trim() ? para(esc(p.personalNote.trim()).replace(/\r?\n/g, '<br />')) : '')
    + para('All other terms of your engagement remain unchanged unless stated in this letter. '
      + (isPromotion ? 'We look forward to everything you will build in your new role.' : 'Thank you for everything you continue to bring to the team.'))
    + signOff(p.signatoryName, p.signatoryTitle || '')
    + '</div>';
}

// -------------------------------------------------------------------------------------------------
// OFFER SUMMARY (the email, not the letter)
// -------------------------------------------------------------------------------------------------

export interface OfferSummaryInput {
  candidateName?: string;
  roleTitle?: string;
  department?: string;
  employmentType?: string;
  workMode?: string;
  duration?: string;
  joiningDate?: string;
  responseDeadline?: string;
  expiryDate?: string;
  refNumber?: string;
  offerDate?: string;
}

/**
 * The offer at a glance, for the email that carries the signing link.
 *
 * DELIBERATELY NOT THE LETTER. The binding document is the signable copy at /portal/offer/<token>; a
 * full copy in the inbox is the same words with none of the consequence, and a candidate who treats
 * it as the artefact never signs. This card states the headline facts and says plainly where the
 * letter is.
 *
 * COMPENSATION IS NOT ON IT. Paid or unpaid is decided by the slug allowlist and is stated in the
 * letter in its own words; repeating it here from a free-text field is how a role once advertised
 * itself as paid when it was not.
 */
export function offerSummaryHtml(o: OfferSummaryInput): string {
  const facts: Array<[string, string]> = [];
  if (o.roleTitle) facts.push(['Role', o.roleTitle + (o.department ? ', ' + o.department : '')]);
  if (o.employmentType) facts.push(['Engagement', o.employmentType]);
  if (o.workMode) facts.push(['Work mode', o.workMode]);
  if (o.duration) facts.push(['Duration', o.duration]);
  if (o.joiningDate) facts.push(['Joining date', longDate(o.joiningDate)]);
  if (o.responseDeadline) facts.push(['Please respond by', longDate(o.responseDeadline)]);
  else if (o.expiryDate) facts.push(['Offer open until', longDate(o.expiryDate)]);
  if (o.refNumber) facts.push(['Reference', o.refNumber]);

  const rows = facts.map(([k, v]) =>
    '<tr><td style="padding:9px 14px;border-bottom:1px solid ' + BRAND.rule + ';font-family:' + BRAND.sans + ';font-size:10.5px;letter-spacing:0.12em;text-transform:uppercase;color:#9a9188;font-weight:700;width:40%;">' + esc(k) + '</td>'
    + '<td style="padding:9px 14px;border-bottom:1px solid ' + BRAND.rule + ';font-family:' + BRAND.sans + ';font-size:13.5px;color:' + BRAND.ink + ';font-weight:600;">' + esc(v) + '</td></tr>').join('');

  return '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:' + BRAND.paper + ';border:1px solid ' + BRAND.rule + ';border-radius:8px;">'
    + '<tr><td style="padding:22px 22px 6px;">'
    + '<p style="margin:0;font-family:' + BRAND.sans + ';font-size:9.5px;letter-spacing:0.2em;text-transform:uppercase;color:' + BRAND.saffron + ';font-weight:800;">Offer of engagement</p>'
    + '<p style="margin:4px 0 0;font-family:' + BRAND.serif + ';font-size:20px;color:' + BRAND.ink + ';font-weight:700;">' + esc(o.candidateName || 'Your offer') + '</p>'
    + '</td></tr>'
    + '<tr><td style="padding:12px 22px 4px;">'
    + '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid ' + BRAND.rule + ';border-radius:6px;">' + rows + '</table>'
    + '</td></tr>'
    + '<tr><td style="padding:12px 22px 20px;font-family:' + BRAND.sans + ';font-size:12px;line-height:1.6;color:' + BRAND.muted + ';">'
    + 'This is a summary. Your full offer letter, with every term and the place to sign it, is at the button below. Please read it in full before signing.'
    + '</td></tr></table>';
}
