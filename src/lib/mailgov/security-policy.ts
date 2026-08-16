// src/lib/mailgov/security-policy.ts — ONE VOCABULARY FOR SECURITY EVENTS, AND WHAT A SIGNAL MAY DO.
//
// PURE. No database. ./security-events.ts records and queries; this decides what the types ARE, how
// severe each one is, and where the line sits between "worth showing a human" and "act on it".
//
// WHY A CATALOGUE RATHER THAN FREE-TEXT TYPES. A security screen is only useful if the same thing is
// always called the same thing. Free-text event names produce `login_failed`, `failed_login` and
// `auth.fail` in three modules, a filter that silently misses two thirds of the traffic, and an
// operator who concludes the platform is quiet. The type is a closed set; adding to it is a one-line
// edit here and nothing else.
//
// DETECTION IS ADVISORY. THIS IS A PRODUCT RULE, NOT A PREFERENCE. Nothing in this file — no score,
// no threshold, no anomaly — is permitted to suspend an account, block a campaign or penalise
// anybody on its own. Every function returns a FINDING with a recommendation attached, and a person
// decides. The same rule already governs proctoring in this repository, for the same reason: a false
// positive from an automated judgement lands on a real person who did nothing wrong, and there is no
// appeal against a system that has already acted.

export const SECURITY_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type SecuritySeverity = (typeof SECURITY_SEVERITIES)[number];

export const SEVERITY_RANK: Record<SecuritySeverity, number> = {
  info: 0, low: 1, medium: 2, high: 3, critical: 4,
};

/**
 * The seven families the brief names, spelled as concrete events.
 *
 * `family` is what the console groups by; `type` is what code records. Both are closed sets so a
 * filter cannot silently miss a spelling.
 */
export const SECURITY_FAMILIES = [
  'failed_login', 'api_abuse', 'smtp_abuse', 'suspicious_campaign',
  'credential_anomaly', 'permission_change', 'domain_change',
] as const;
export type SecurityFamily = (typeof SECURITY_FAMILIES)[number];

export interface SecurityEventSpec {
  type: string;
  family: SecurityFamily;
  severity: SecuritySeverity;
  label: string;
  /** What an operator should actually do. Empty is not an option — see the note below. */
  recommendation: string;
}

/**
 * Every event carries a recommendation, and none of them says "investigate".
 *
 * A security console that lists events without saying what to do about them trains people to close
 * the tab. The recommendation is the difference between a log and an alarm somebody answers.
 */
export const SECURITY_EVENTS: Record<string, SecurityEventSpec> = {
  'auth.login_failed': {
    type: 'auth.login_failed', family: 'failed_login', severity: 'low',
    label: 'Failed sign-in',
    recommendation: 'Normal in ones and twos. Look at the rate and the source addresses before acting.',
  },
  'auth.login_failed_burst': {
    type: 'auth.login_failed_burst', family: 'failed_login', severity: 'high',
    label: 'Repeated failed sign-ins',
    recommendation: 'Many failures against one account or from one address. Confirm with the account holder, then consider a session revoke and a password reset.',
  },
  'auth.session_revoked': {
    type: 'auth.session_revoked', family: 'credential_anomaly', severity: 'info',
    label: 'Sessions revoked',
    recommendation: 'Recorded so a revoke that nobody remembers requesting is visible.',
  },
  'auth.new_location': {
    type: 'auth.new_location', family: 'credential_anomaly', severity: 'medium',
    label: 'Sign-in from an unfamiliar address',
    recommendation: 'Not proof of anything on its own; people travel. Ask the account holder before acting.',
  },
  'api.key_invalid': {
    type: 'api.key_invalid', family: 'api_abuse', severity: 'low',
    label: 'Invalid API key presented',
    recommendation: 'Usually a stale key in a deployment. A sustained rate from one address is worth a look.',
  },
  'api.key_revoked_used': {
    type: 'api.key_revoked_used', family: 'api_abuse', severity: 'high',
    label: 'Revoked API key used',
    recommendation: 'Somebody still holds a key that was withdrawn. Find out who, and whether the revocation reason still applies.',
  },
  'api.rate_limited': {
    type: 'api.rate_limited', family: 'api_abuse', severity: 'low',
    label: 'Rate limit hit',
    recommendation: 'Ordinary under load. Repeated across environments may mean a retry loop with no backoff.',
  },
  'api.scope_denied': {
    type: 'api.scope_denied', family: 'api_abuse', severity: 'medium',
    label: 'Key used outside its scopes',
    recommendation: 'Either an integration doing more than it was given, or a key being probed. Check which endpoint was called.',
  },
  'smtp.relay_refused': {
    type: 'smtp.relay_refused', family: 'smtp_abuse', severity: 'medium',
    label: 'Relay attempt refused',
    recommendation: 'Somebody tried to send through the platform for a domain it does not own.',
  },
  'smtp.auth_failed_burst': {
    type: 'smtp.auth_failed_burst', family: 'smtp_abuse', severity: 'high',
    label: 'Repeated SMTP authentication failures',
    recommendation: 'Credential guessing against the mail transport. Rotate the affected credential.',
  },
  'campaign.suspicious': {
    type: 'campaign.suspicious', family: 'suspicious_campaign', severity: 'medium',
    label: 'Campaign flagged for review',
    recommendation: 'ADVISORY. A person reviews the campaign and decides. Nothing is paused automatically.',
  },
  'campaign.complaint_spike': {
    type: 'campaign.complaint_spike', family: 'suspicious_campaign', severity: 'high',
    label: 'Complaint rate above threshold',
    recommendation: 'Complaints damage the sending reputation of every tenant on the domain. Contact the organization before the rate rises further.',
  },
  'credential.anomaly': {
    type: 'credential.anomaly', family: 'credential_anomaly', severity: 'medium',
    label: 'Credential used unusually',
    recommendation: 'A key or account used from a pattern of addresses it has not used before. Confirm with the owner.',
  },
  'permission.changed': {
    type: 'permission.changed', family: 'permission_change', severity: 'medium',
    label: 'Permissions changed',
    recommendation: 'Check the change was requested. Role changes are the step every account takeover eventually takes.',
  },
  'permission.escalation_refused': {
    type: 'permission.escalation_refused', family: 'permission_change', severity: 'high',
    label: 'Privilege escalation refused',
    recommendation: 'Somebody attempted to grant a role at or above their own and was refused. Worth a conversation.',
  },
  'domain.added': {
    type: 'domain.added', family: 'domain_change', severity: 'low',
    label: 'Sending domain added',
    recommendation: 'Confirm the organization owns it. Verification does that, but an added domain is worth seeing.',
  },
  'domain.dns_changed': {
    type: 'domain.dns_changed', family: 'domain_change', severity: 'medium',
    label: 'Domain DNS changed',
    recommendation: 'SPF, DKIM or DMARC moved. If it moved to something weaker, ask why.',
  },
  'domain.verification_lost': {
    type: 'domain.verification_lost', family: 'domain_change', severity: 'high',
    label: 'Domain verification lost',
    recommendation: 'The records that authorise us to send for this domain are gone. Sending from it will start failing.',
  },
  'admin.access_denied': {
    type: 'admin.access_denied', family: 'permission_change', severity: 'medium',
    label: 'Governance access refused',
    recommendation: 'Somebody reached an administration surface they do not hold. One is a wrong link; a pattern is not.',
  },
  'support.content_accessed': {
    type: 'support.content_accessed', family: 'permission_change', severity: 'high',
    label: 'Message content read under authorisation',
    recommendation: 'Legitimate and recorded. It is here so it is impossible to do quietly.',
  },
};

export const SECURITY_TYPES = Object.keys(SECURITY_EVENTS);

/**
 * Look up a type. An UNKNOWN type is recorded rather than dropped — losing a signal because a caller
 * misspelled it is worse than an unlabelled row — but it is marked so the catalogue gap is visible.
 */
export function classify(type: string): SecurityEventSpec {
  return SECURITY_EVENTS[type] || {
    type, family: 'api_abuse', severity: 'low',
    label: type,
    recommendation: 'Unrecognised event type. Add it to SECURITY_EVENTS in src/lib/mailgov/security-policy.ts so it can be filtered and triaged.',
  };
}

export function isKnownSecurityType(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(SECURITY_EVENTS, type);
}

export type SecurityEventStatus = 'new' | 'acknowledged' | 'resolved' | 'false_positive';

export interface Finding {
  /** Whether a human should be shown this at all. */
  flag: boolean;
  severity: SecuritySeverity;
  /** What was observed, in numbers. Never a verdict. */
  observation: string;
  recommendation: string;
  /** ALWAYS true. Present in the shape so no caller can treat a finding as an action. */
  advisoryOnly: true;
}

const finding = (flag: boolean, severity: SecuritySeverity, observation: string, recommendation: string): Finding =>
  ({ flag, severity, observation, recommendation, advisoryOnly: true });

/**
 * Failed sign-ins: a burst is many failures in a short window against one account or from one
 * address. Thresholds are arguments with defaults, so an operator tuning them does not have to edit
 * this file and a test can pin them.
 */
export function assessFailedLogins(input: {
  failures: number;
  windowMinutes: number;
  distinctAccounts: number;
  threshold?: number;
}): Finding {
  const threshold = input.threshold ?? 10;
  if (input.failures < threshold) {
    return finding(false, 'low', input.failures + ' failed sign-ins in ' + input.windowMinutes + ' minutes.', 'Below the review threshold of ' + threshold + '.');
  }
  const spread = input.distinctAccounts > 5;
  return finding(
    true, spread ? 'critical' : 'high',
    input.failures + ' failed sign-ins in ' + input.windowMinutes + ' minutes across ' + input.distinctAccounts + ' account(s).',
    spread
      ? 'Failures spread across many accounts look like credential stuffing rather than one person mistyping. Check the source addresses.'
      : 'Concentrated on one account. Contact the account holder before locking anything.',
  );
}

/**
 * A campaign worth a human's attention.
 *
 * Every threshold here is a REVIEW threshold. Nothing in this function pauses a campaign, and the
 * return type has no field with which it could — deliberately, so a future caller cannot start
 * treating a high score as an instruction.
 */
export function assessCampaign(input: {
  recipients: number;
  complaintRate: number;
  bounceRate: number;
  newDomainAgeDays: number | null;
  firstCampaignForOrg: boolean;
}): Finding {
  const reasons: string[] = [];
  let severity: SecuritySeverity = 'info';

  if (input.complaintRate >= 0.003) {
    reasons.push('complaint rate ' + (input.complaintRate * 100).toFixed(2) + '% (0.30% is where mailbox providers start throttling)');
    severity = 'high';
  }
  if (input.bounceRate >= 0.05) {
    reasons.push('bounce rate ' + (input.bounceRate * 100).toFixed(1) + '%, which usually means an unverified list');
    if (SEVERITY_RANK[severity] < SEVERITY_RANK.medium) severity = 'medium';
  }
  if (input.firstCampaignForOrg && input.recipients >= 5000) {
    reasons.push('a first campaign of ' + input.recipients.toLocaleString('en-IN') + ' recipients with no sending history');
    if (SEVERITY_RANK[severity] < SEVERITY_RANK.medium) severity = 'medium';
  }
  if (input.newDomainAgeDays !== null && input.newDomainAgeDays < 7 && input.recipients >= 1000) {
    reasons.push('a domain verified ' + input.newDomainAgeDays + ' day(s) ago sending to ' + input.recipients.toLocaleString('en-IN') + ' recipients');
    if (SEVERITY_RANK[severity] < SEVERITY_RANK.medium) severity = 'medium';
  }

  if (!reasons.length) {
    return finding(false, 'info', 'Nothing unusual: ' + input.recipients.toLocaleString('en-IN') + ' recipients.', 'No review needed.');
  }
  return finding(
    true, severity, reasons.join('; ') + '.',
    'Show this to a person before anything is paused. A legitimate first big send from a new customer looks exactly like this.',
  );
}

/**
 * A credential used from somewhere it has not been used before.
 *
 * `knownIps` is the history; the finding is that something is NEW, which is a fact. Whether it
 * matters is a judgement, and the recommendation says so — a laptop on a train produces this every
 * morning.
 */
export function assessCredentialUse(input: {
  keyLabel: string;
  knownIps: string[];
  currentIp: string;
  daysActive: number;
}): Finding {
  const known = new Set(input.knownIps.filter(Boolean));
  if (!input.currentIp) return finding(false, 'info', 'No source address recorded.', 'Nothing to compare.');
  if (known.has(input.currentIp)) {
    return finding(false, 'info', 'Address already seen for ' + input.keyLabel + '.', 'Nothing unusual.');
  }
  if (known.size === 0) {
    return finding(false, 'info', 'First recorded use of ' + input.keyLabel + '.', 'Nothing to compare against yet.');
  }
  const severity: SecuritySeverity = input.daysActive > 30 && known.size <= 3 ? 'medium' : 'low';
  return finding(
    true, severity,
    input.keyLabel + ' used from a new address; ' + known.size + ' address(es) seen before over ' + input.daysActive + ' days.',
    'Confirm with the owner. A settled integration changing address is worth a question; a laptop is not.',
  );
}

/** Sort helper for the console: severest first, then most recent. */
export function bySeverityThenTime<T extends { severity: SecuritySeverity; occurredAt: string }>(a: T, b: T): number {
  const d = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (d !== 0) return d;
  return String(b.occurredAt).localeCompare(String(a.occurredAt));
}
