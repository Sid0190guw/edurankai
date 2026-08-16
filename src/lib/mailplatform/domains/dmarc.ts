// src/lib/mailplatform/domains/dmarc.ts — READ A DMARC RECORD, JUDGE IT, AND REFUSE TO CHANGE IT
// QUIETLY.
//
// Pure. No network, no database.
//
// DMARC is the one record in this subsystem where a confident recommendation can destroy a
// customer's mail. `p=reject` tells every receiver in the world to THROW AWAY mail that fails
// alignment — so a tool that helpfully proposes `p=reject` for a domain whose payroll provider is
// not yet aligned has just deleted the payslips, silently, at the receiver, with no bounce the
// sender ever sees. And the opposite move is just as bad in the other direction: a customer who has
// spent six months getting to `p=reject` must never have it walked back to `p=none` because an
// onboarding wizard thought that was the friendly default.
//
// So this module recommends, and it guards:
//   - the recommendation for a NEW domain is always `p=none` with reporting on,
//   - any proposal that WEAKENS a published policy is marked as requiring explicit confirmation,
//   - any proposal that strengthens one is marked as requiring explicit confirmation too,
//   - and nothing here writes DNS. We do not hold the customer's registrar credentials, and the
//     policy in the database is a RECORD OF INTENT, never an instruction that took effect.
//
// Reference: RFC 7489.

export type DmarcPolicy = 'none' | 'quarantine' | 'reject';
export type AlignmentMode = 'r' | 's';

export interface DmarcParse {
  ok: boolean;
  raw: string;
  tags: Record<string, string>;
  policy: DmarcPolicy | null;
  /** Policy for subdomains. Falls back to `policy` when absent, which is the RFC behaviour. */
  subdomainPolicy: DmarcPolicy | null;
  /** Percentage of mail the policy is applied to. Defaults to 100. */
  pct: number;
  /** DKIM alignment: `r` relaxed (organisational domain match), `s` strict (exact match). */
  adkim: AlignmentMode;
  aspf: AlignmentMode;
  rua: string[];
  ruf: string[];
  errors: string[];
  warnings: string[];
}

const POLICIES: DmarcPolicy[] = ['none', 'quarantine', 'reject'];
/** Strength order, used by the change guard. Higher means more mail is thrown away on failure. */
const STRENGTH: Record<DmarcPolicy, number> = { none: 0, quarantine: 1, reject: 2 };

/** The record name DMARC is published at. */
export function dmarcHost(domain: string): string {
  return '_dmarc.' + String(domain || '').trim().toLowerCase().replace(/\.$/, '');
}

/** Every v=DMARC1 record among a name's TXT records. More than one is a fault, as with SPF. */
export function selectDmarcRecords(txtValues: string[]): string[] {
  return (txtValues || []).map((t) => String(t || '').trim()).filter((t) => /^v=DMARC1(\s*;|$)/i.test(t));
}

function parseUriList(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Never throws. A record it cannot parse comes back described, not thrown. */
export function parseDmarc(record: string): DmarcParse {
  const raw = String(record || '').trim();
  const out: DmarcParse = {
    ok: false, raw, tags: {}, policy: null, subdomainPolicy: null, pct: 100,
    adkim: 'r', aspf: 'r', rua: [], ruf: [], errors: [], warnings: [],
  };
  if (!raw) {
    out.errors.push('The record is empty.');
    return out;
  }

  const parts = raw.split(';').map((s) => s.trim()).filter(Boolean);
  const order: string[] = [];
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq === -1) {
      out.errors.push('"' + p + '" is not a tag=value pair.');
      continue;
    }
    const name = p.slice(0, eq).trim().toLowerCase();
    const value = p.slice(eq + 1).trim();
    if (out.tags[name] !== undefined) {
      out.errors.push('The tag "' + name + '" appears more than once.');
      continue;
    }
    out.tags[name] = value;
    order.push(name);
  }

  if (order[0] !== 'v' || !/^DMARC1$/i.test(out.tags.v || '')) {
    out.errors.push('A DMARC record must start with "v=DMARC1;". Receivers ignore anything that does not.');
    return out;
  }
  if (out.tags.p === undefined) {
    out.errors.push('The required "p=" policy tag is missing. Without it the record does nothing at all.');
  } else if (!POLICIES.includes(out.tags.p.toLowerCase() as DmarcPolicy)) {
    out.errors.push('"p=' + out.tags.p + '" is not a valid policy. Use none, quarantine or reject.');
  } else {
    out.policy = out.tags.p.toLowerCase() as DmarcPolicy;
    if (order[1] !== 'p') {
      out.warnings.push('"p=" should be the second tag. Some receivers are strict about the ordering.');
    }
  }

  if (out.tags.sp !== undefined) {
    if (POLICIES.includes(out.tags.sp.toLowerCase() as DmarcPolicy)) out.subdomainPolicy = out.tags.sp.toLowerCase() as DmarcPolicy;
    else out.errors.push('"sp=' + out.tags.sp + '" is not a valid subdomain policy.');
  }
  if (out.tags.pct !== undefined) {
    const n = Number(out.tags.pct);
    if (!Number.isInteger(n) || n < 0 || n > 100) out.errors.push('"pct=' + out.tags.pct + '" must be a whole number from 0 to 100.');
    else out.pct = n;
  }
  for (const tag of ['adkim', 'aspf'] as const) {
    const v = (out.tags[tag] || 'r').toLowerCase();
    if (v !== 'r' && v !== 's') out.errors.push('"' + tag + '=' + out.tags[tag] + '" must be r (relaxed) or s (strict).');
    else out[tag] = v as AlignmentMode;
  }
  out.rua = parseUriList(out.tags.rua);
  out.ruf = parseUriList(out.tags.ruf);
  for (const uri of [...out.rua, ...out.ruf]) {
    if (!/^mailto:/i.test(uri) && !/^https?:/i.test(uri)) {
      out.warnings.push('Report address "' + uri + '" is not a mailto: or https: URI, so reports will not be delivered to it.');
    }
  }

  out.ok = out.errors.length === 0;
  return out;
}

export interface DmarcAudit {
  records: string[];
  effective: string | null;
  parse: DmarcParse | null;
  errors: string[];
  warnings: string[];
  /** Advice that is true but not a fault: things worth doing next. */
  advice: string[];
  healthy: boolean;
}

/** Judge what is published, including the things that are legal but almost never intended. */
export function auditDmarc(txtValues: string[]): DmarcAudit {
  const records = selectDmarcRecords(txtValues);
  const errors: string[] = [];
  const warnings: string[] = [];
  const advice: string[] = [];

  if (records.length === 0) {
    return {
      records, effective: null, parse: null,
      errors: ['No DMARC record is published.'],
      warnings: [],
      advice: ['Without DMARC, a receiver has no instruction about what to do when a message claiming to be from this domain fails SPF and DKIM. Publishing "p=none" changes nothing about delivery and starts the reports that tell you who is sending as you.'],
      healthy: false,
    };
  }
  if (records.length > 1) {
    errors.push('There are ' + records.length + ' DMARC records at this name. Receivers that find more than one treat the domain as having no DMARC policy at all. Keep exactly one.');
  }

  const parse = parseDmarc(records[0]);
  errors.push(...parse.errors);
  warnings.push(...parse.warnings);

  if (parse.policy === 'none') {
    advice.push('The policy is "p=none": nothing is quarantined or rejected. That is the correct place to start. Move to quarantine once the aggregate reports show your own mail passing.');
  }
  if (parse.policy && parse.policy !== 'none' && parse.rua.length === 0) {
    warnings.push('The policy is "' + parse.policy + '" but no "rua=" report address is set, so mail is being quarantined or rejected and nobody is receiving the reports that say whose it was.');
  }
  if (parse.rua.length === 0) {
    advice.push('No aggregate report address ("rua=") is set. Reports are the only way to see who is sending mail as this domain.');
  }
  if (parse.pct < 100 && parse.policy && parse.policy !== 'none') {
    warnings.push('"pct=' + parse.pct + '" applies the ' + parse.policy + ' policy to only ' + parse.pct + '% of failing mail. That is a deliberate ramp-up setting; if it was not deliberate, remove it.');
  }
  if (parse.policy === 'reject' && parse.subdomainPolicy === null) {
    advice.push('"p=reject" also applies to subdomains unless "sp=" says otherwise. If any subdomain sends mail from a system that is not aligned yet, add "sp=none" until it is.');
  }

  return { records, effective: records[0], parse, errors, warnings, advice, healthy: records.length === 1 && parse.ok };
}

export interface DmarcRecommendation {
  record: string;
  policy: DmarcPolicy;
  action: 'create' | 'update' | 'unchanged';
  /** True when a human must confirm before this is presented as a thing to publish. */
  requiresConfirmation: boolean;
  confirmationReason: string | null;
  warnings: string[];
}

/**
 * Build a DMARC record for a domain.
 *
 * `desired` defaults to `none` and that default is not an accident: a domain being onboarded has
 * not yet proved that its own mail passes alignment, and the first policy must never throw mail
 * away. Anything stronger is a decision the operator makes with the reports in front of them.
 */
export function recommendDmarc(
  published: string[] | null,
  opts: { rua?: string | null; desired?: DmarcPolicy; subdomainPolicy?: DmarcPolicy | null } = {},
): DmarcRecommendation {
  const desired: DmarcPolicy = opts.desired || 'none';
  const existing = selectDmarcRecords(published || []);
  const current = existing.length === 1 ? parseDmarc(existing[0]) : null;
  const warnings: string[] = [];

  const tags = ['v=DMARC1', 'p=' + desired];
  if (opts.subdomainPolicy) tags.push('sp=' + opts.subdomainPolicy);
  const rua = (opts.rua || current?.rua[0] || '').trim();
  if (rua) tags.push('rua=' + (rua.startsWith('mailto:') || /^https?:/i.test(rua) ? rua : 'mailto:' + rua));
  else warnings.push('No aggregate report address is configured for this deployment, so the recommended record has no "rua=". Set MAIL_DMARC_RUA, or add your own reporting mailbox to the record before publishing it.');
  // Alignment is left at the relaxed default deliberately. Strict alignment breaks any subdomain
  // sender that is otherwise correct, and this is not the screen on which to spring that.
  const record = tags.join('; ');

  if (existing.length === 0) {
    return { record, policy: desired, action: 'create', requiresConfirmation: false, confirmationReason: null, warnings };
  }
  if (existing.length > 1) {
    return {
      record, policy: desired, action: 'update', requiresConfirmation: true,
      confirmationReason: 'This domain publishes ' + existing.length + ' DMARC records. Replacing them means deleting records somebody added on purpose; check who owns them first.',
      warnings,
    };
  }
  if (current && current.raw.replace(/\s+/g, ' ') === record.replace(/\s+/g, ' ')) {
    return { record, policy: desired, action: 'unchanged', requiresConfirmation: false, confirmationReason: null, warnings };
  }

  const guard = policyChangeGuard(current?.policy ?? null, desired);
  return {
    record, policy: desired, action: 'update',
    requiresConfirmation: guard.requiresConfirmation,
    confirmationReason: guard.reason,
    warnings,
  };
}

/**
 * Should a human confirm this policy change?
 *
 * The brief's rule is "do not automatically change a customer's production DMARC policy without
 * explicit confirmation", and the honest reading is that BOTH directions need it:
 *
 *   - WEAKENING (reject -> none) silently removes protection the customer built up over months,
 *     and nothing visible breaks, so nobody notices until a lookalike domain is being used against
 *     their students.
 *   - STRENGTHENING (none -> reject) starts throwing away real mail from any sender that is not
 *     aligned yet, at the receiver, invisibly to the sender.
 *
 * Only publishing a FIRST policy on a domain that has none is safe to propose unprompted, and even
 * then the proposal is `p=none`.
 */
export function policyChangeGuard(
  current: DmarcPolicy | null,
  next: DmarcPolicy,
): { requiresConfirmation: boolean; direction: 'first' | 'weaken' | 'strengthen' | 'same'; reason: string | null } {
  if (current === null) {
    return { requiresConfirmation: false, direction: 'first', reason: null };
  }
  if (current === next) {
    return { requiresConfirmation: false, direction: 'same', reason: null };
  }
  if (STRENGTH[next] < STRENGTH[current]) {
    return {
      requiresConfirmation: true,
      direction: 'weaken',
      reason: 'This weakens a policy that is already published: "' + current + '" becomes "' + next + '". Mail that is currently being ' + (current === 'reject' ? 'rejected' : 'quarantined') + ' when it fails alignment would start being delivered, including mail sent by somebody impersonating this domain.',
    };
  }
  return {
    requiresConfirmation: true,
    direction: 'strengthen',
    reason: 'This strengthens a published policy: "' + current + '" becomes "' + next + '". Receivers will start ' + (next === 'reject' ? 'rejecting' : 'quarantining') + ' any mail from this domain that fails both SPF and DKIM alignment — including mail from systems that are legitimate but not yet aligned. Read the aggregate reports before you do this.',
  };
}

/** Everything needed to decide whether one message would have passed DMARC. */
export interface AlignmentInput {
  /** The domain in the visible From: header. */
  fromDomain: string;
  /** The `d=` domain of a DKIM signature that VERIFIED, or null when none did. */
  dkimDomain?: string | null;
  /** The MAIL FROM (return-path) domain, when SPF passed for it. */
  spfDomain?: string | null;
  adkim?: AlignmentMode;
  aspf?: AlignmentMode;
}

export interface AlignmentResult {
  dkimAligned: boolean;
  spfAligned: boolean;
  /** DMARC passes when EITHER mechanism aligns and passes. */
  passes: boolean;
  detail: string;
}

/**
 * Organisational-domain comparison for relaxed alignment.
 *
 * This uses the last two labels rather than a public-suffix list, and says so. It is right for
 * `edurankai.in` vs `mail.edurankai.in` and wrong for a domain under a multi-label suffix such as
 * `co.uk`, where it would call `example.co.uk` and `other.co.uk` aligned. Callers get the
 * `approximate` flag; the verification engine only uses this for EXPLANATION, never to mark a
 * domain verified.
 */
export function organizationalDomain(domain: string): { value: string; approximate: boolean } {
  const d = String(domain || '').trim().toLowerCase().replace(/\.$/, '');
  const labels = d.split('.').filter(Boolean);
  if (labels.length <= 2) return { value: d, approximate: false };
  const twoLabelSuffixes = ['co.uk', 'ac.uk', 'org.uk', 'gov.uk', 'co.in', 'ac.in', 'net.in', 'org.in', 'gov.in', 'edu.in', 'com.au', 'co.nz', 'co.za', 'com.br'];
  const lastTwo = labels.slice(-2).join('.');
  if (twoLabelSuffixes.includes(lastTwo)) {
    return { value: labels.slice(-3).join('.'), approximate: true };
  }
  return { value: lastTwo, approximate: true };
}

export function checkAlignment(input: AlignmentInput): AlignmentResult {
  const adkim = input.adkim || 'r';
  const aspf = input.aspf || 'r';
  const from = String(input.fromDomain || '').toLowerCase().replace(/\.$/, '');
  const fromOrg = organizationalDomain(from).value;

  const aligns = (candidate: string | null | undefined, mode: AlignmentMode): boolean => {
    if (!candidate) return false;
    const c = candidate.toLowerCase().replace(/\.$/, '');
    if (mode === 's') return c === from;
    return c === from || organizationalDomain(c).value === fromOrg;
  };

  const dkimAligned = aligns(input.dkimDomain, adkim);
  const spfAligned = aligns(input.spfDomain, aspf);
  const passes = dkimAligned || spfAligned;

  const detail = passes
    ? 'Aligned via ' + [dkimAligned ? 'DKIM' : null, spfAligned ? 'SPF' : null].filter(Boolean).join(' and ') + '.'
    : 'Neither DKIM (' + (input.dkimDomain || 'no verified signature') + ') nor SPF (' + (input.spfDomain || 'no pass') + ') aligns with the From domain ' + from + '.';

  return { dkimAligned, spfAligned, passes, detail };
}
