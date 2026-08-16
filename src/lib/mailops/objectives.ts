// src/lib/mailops/objectives.ts — RPO and RTO, with the difference between a target, a design
// intent and a measurement kept visible at all times.
//
// THE FAILURE THIS FILE IS BUILT AGAINST is the recovery objective that was written down once, in a
// document, by someone reasoning about what would be nice. "RPO: 15 minutes" then gets quoted in a
// meeting, then to a customer, and nobody involved has ever restored anything. The number is not
// wrong exactly — it is unfounded, which is worse, because an unfounded number is indistinguishable
// from a measured one after it has been copied twice.
//
// So every objective here carries a `basis`:
//
//   'measured'      — a real restore was performed and timed. This is the only basis that may be
//                     described to anyone outside the team as what the system does.
//   'design-intent' — the architecture supports it and nothing contradicts it, but it has not been
//                     demonstrated. Internal planning only.
//   'aspiration'    — the target for a later phase. Not true today, and labelled so on the screen.
//
// A surface rendering these MUST print the basis next to the number. objectiveClaim() below returns
// the sentence that is safe to say for each, and it is deliberately blunt about the two that are
// not measurements.
//
// TARGETS ARE CONFIGURABLE, and the defaults below are the starting point, not a policy. The founder
// can change them on /admin/mail/continuity; what cannot be changed from a screen is the basis,
// because that is a fact about what has been done, not a preference.

export type AssetClass =
  | 'database'
  | 'spool'
  | 'mailboxes'
  | 'dkim_keys'
  | 'mail_config'
  | 'object_storage'
  | 'secrets';

export type ObjectiveBasis = 'measured' | 'design-intent' | 'aspiration';

export interface Objective {
  assetClass: AssetClass;
  label: string;
  /** Recovery Point Objective: the most data, in seconds, we accept losing. */
  rpoSeconds: number;
  /** Recovery Time Objective: how long, in seconds, until the asset is serving again. */
  rtoSeconds: number;
  basis: ObjectiveBasis;
  /** Why these numbers and not others. Written for the person who will be asked to defend them. */
  rationale: string;
  /** What has to change for the basis to become 'measured'. Empty when it already is. */
  toProve: string;
}

export const DEFAULT_OBJECTIVES: readonly Objective[] = [
  {
    assetClass: 'database',
    label: 'Postgres (all application and mail data)',
    rpoSeconds: 24 * 3600,
    rtoSeconds: 4 * 3600,
    basis: 'aspiration',
    rationale:
      'A daily encrypted dump gives an RPO of one day at worst. The RTO is dominated by restoring 258 tables into a fresh instance and repointing DATABASE_URL, not by the download. Both numbers are aspirational because the backup is not yet scheduled — today the honest RPO is "since whenever a dump was last taken by hand", which may be never.',
    toProve: 'Schedule the dump, then run one full restore into a scratch database and time it end to end.',
  },
  {
    assetClass: 'spool',
    label: 'Outbound mail spool',
    rpoSeconds: 0,
    rtoSeconds: 300,
    basis: 'design-intent',
    rationale:
      'RPO zero is a real claim, not a wish: enqueue() fsyncs the entry and only then acknowledges, so an accepted message survives a power cut by construction. It is design-intent rather than measured because the power-cut test has not been run, and because on a Windows host the directory fsync is unavailable and the guarantee weakens (see durabilityMode() in the spool). RTO is one reclaim interval — the lease has to expire before another worker may take an abandoned entry.',
    toProve: 'Kill -9 the worker mid-delivery and confirm the entry returns to queued/ and is delivered exactly once or twice, never zero times.',
  },
  {
    assetClass: 'mailboxes',
    label: 'Delivered mail (maildirs and message rows)',
    rpoSeconds: 24 * 3600,
    rtoSeconds: 8 * 3600,
    basis: 'aspiration',
    rationale:
      'Message bodies are in Postgres, so this mostly rides on the database objective. The separate entry exists because the IMAP maildirs on the mail host are NOT in Postgres and are not backed up at all today — that is the gap, and it is what makes this an aspiration rather than a derived number.',
    toProve: 'Back up the maildir tree, restore it onto a clean host, and open a mailbox over IMAP against the restored copy.',
  },
  {
    assetClass: 'dkim_keys',
    label: 'DKIM private keys',
    rpoSeconds: 0,
    rtoSeconds: 3600,
    basis: 'design-intent',
    rationale:
      'Keys change only when they are rotated, so RPO zero means "the escrow copy is made at rotation time, in the same procedure". RTO is an hour because recovery is a file copy plus a service restart — but if the escrow copy does not exist, the real recovery is generating a NEW key and publishing a new DNS record, which is a DNS-propagation problem measured in hours and a deliverability problem measured in days.',
    toProve: 'Restore a key from escrow onto a scratch host and verify a signature it produces validates against the published selector.',
  },
  {
    assetClass: 'mail_config',
    label: 'Mail configuration, templates, campaigns, automations',
    rpoSeconds: 24 * 3600,
    rtoSeconds: 4 * 3600,
    basis: 'aspiration',
    rationale:
      'All of this lives in Postgres tables, so it inherits the database objective. It is listed separately because losing it has a different shape of consequence — an in-flight campaign that half-sent is worse than one that never started, and the restore has to be reasoned about rather than just executed.',
    toProve: 'Included in the database restore test; verify campaign and template counts against the pre-restore inventory.',
  },
  {
    assetClass: 'object_storage',
    label: 'Attachments and raw MIME',
    rpoSeconds: 0,
    rtoSeconds: 3600,
    basis: 'aspiration',
    rationale:
      'RPO zero is achievable only with bucket versioning plus cross-bucket replication, and neither is configured. Until one of them is, the honest RPO for object storage is "everything since the bucket was created", because there is no second copy at all.',
    toProve: 'Enable versioning, then delete an object and restore it from a version.',
  },
  {
    assetClass: 'secrets',
    label: 'Environment secrets and encryption keys',
    rpoSeconds: 0,
    rtoSeconds: 1800,
    basis: 'design-intent',
    rationale:
      'DATA_ENCRYPTION_KEY_* is the one asset where a perfect database backup does not help: lose the key and every column encrypted under it is permanently unreadable. RPO zero means the escrow copy is updated in the same procedure that adds or rotates a key, and there is no acceptable window at all.',
    toProve: 'Decrypt one encrypted column in a scratch restore using only the escrow copy of the key.',
  },
] as const;

export interface Measurement {
  assetClass: AssetClass;
  /** Seconds of data that would have been lost, as observed. */
  measuredRpoSeconds: number | null;
  /** Seconds the restore actually took, as observed. */
  measuredRtoSeconds: number | null;
  /** When the measurement was taken. */
  at: string | null;
  /** What produced it: 'restore-test', 'incident', or a script name. */
  source: string | null;
}

export type ObjectiveState = 'met' | 'missed' | 'unmeasured';

export interface ObjectiveStatus {
  objective: Objective;
  measurement: Measurement | null;
  rpoState: ObjectiveState;
  rtoState: ObjectiveState;
  /** True when the measurement is old enough that it no longer describes the current system. */
  stale: boolean;
  /** The sentence that is safe to say about this objective right now. */
  claim: string;
}

/** How long a measurement stays credible before it has to be redone. */
export const MEASUREMENT_VALID_DAYS = 90;

export function objectiveStatus(
  objective: Objective,
  measurement: Measurement | null,
  now: Date = new Date(),
): ObjectiveStatus {
  const rpoState: ObjectiveState =
    measurement?.measuredRpoSeconds == null ? 'unmeasured'
      : measurement.measuredRpoSeconds <= objective.rpoSeconds ? 'met' : 'missed';
  const rtoState: ObjectiveState =
    measurement?.measuredRtoSeconds == null ? 'unmeasured'
      : measurement.measuredRtoSeconds <= objective.rtoSeconds ? 'met' : 'missed';

  const ageDays = measurement?.at ? (now.getTime() - Date.parse(measurement.at)) / 86_400_000 : Infinity;
  const stale = !Number.isFinite(ageDays) ? false : ageDays > MEASUREMENT_VALID_DAYS;

  return { objective, measurement, rpoState, rtoState, stale, claim: objectiveClaim(objective, measurement, stale) };
}

/**
 * The only sentence that may be printed for this objective.
 *
 * Blunt on purpose. A target with no measurement behind it is a plan, and calling a plan a
 * capability in front of a customer is the specific harm this module exists to prevent.
 */
export function objectiveClaim(objective: Objective, measurement: Measurement | null, stale = false): string {
  const rpo = formatDuration(objective.rpoSeconds);
  const rto = formatDuration(objective.rtoSeconds);
  const measured = measurement?.measuredRtoSeconds != null || measurement?.measuredRpoSeconds != null;

  if (objective.basis === 'measured' && measured && !stale) {
    const parts: string[] = [];
    if (measurement?.measuredRpoSeconds != null) parts.push(`lost at most ${formatDuration(measurement.measuredRpoSeconds)} of data`);
    if (measurement?.measuredRtoSeconds != null) parts.push(`recovered in ${formatDuration(measurement.measuredRtoSeconds)}`);
    return `Demonstrated: the last restore test ${parts.join(' and ')}. Target is ${rpo} / ${rto}.`;
  }
  if (objective.basis === 'measured' && stale) {
    return `Last demonstrated more than ${MEASUREMENT_VALID_DAYS} days ago. Treat ${rpo} / ${rto} as unproven until it is retested.`;
  }
  if (objective.basis === 'design-intent') {
    return `Target ${rpo} / ${rto}. The design supports it; it has not been demonstrated. Internal planning figure — do not quote it as a guarantee.`;
  }
  return `Target ${rpo} / ${rto} is an aspiration for a later phase. It is NOT what the system does today.`;
}

/**
 * RPO implied by the age of the newest usable backup.
 *
 * "Usable" is doing real work in that sentence: an unverified backup does not reduce your RPO,
 * because you do not know it restores. Callers pass the timestamp of the newest VERIFIED backup,
 * and pass null when there is none — in which case the answer is null, meaning "unbounded", and
 * not zero.
 */
export function rpoFromBackupAge(newestVerifiedAt: string | Date | null, now: Date = new Date()): number | null {
  if (!newestVerifiedAt) return null;
  const t = newestVerifiedAt instanceof Date ? newestVerifiedAt.getTime() : Date.parse(String(newestVerifiedAt));
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((now.getTime() - t) / 1000));
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'zero';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) {
    const h = seconds / 3600;
    return `${h % 1 === 0 ? h : h.toFixed(1)} hours`;
  }
  const d = seconds / 86_400;
  return `${d % 1 === 0 ? d : d.toFixed(1)} days`;
}

/** Roll the per-asset objectives into one honest headline for a status banner. */
export function posture(statuses: readonly ObjectiveStatus[]): {
  state: 'proven' | 'partial' | 'unproven';
  headline: string;
  unmeasured: number;
  missed: number;
} {
  const missed = statuses.filter((s) => s.rpoState === 'missed' || s.rtoState === 'missed').length;
  const unmeasured = statuses.filter((s) => s.rpoState === 'unmeasured' && s.rtoState === 'unmeasured').length;

  if (missed > 0) {
    return { state: 'partial', headline: `${missed} objective${missed === 1 ? '' : 's'} missed at the last measurement.`, unmeasured, missed };
  }
  if (unmeasured === statuses.length) {
    return { state: 'unproven', headline: 'No recovery objective has ever been measured. Every number on this page is a target, not a capability.', unmeasured, missed };
  }
  if (unmeasured > 0) {
    return { state: 'partial', headline: `${statuses.length - unmeasured} of ${statuses.length} objectives measured; the rest are targets only.`, unmeasured, missed };
  }
  return { state: 'proven', headline: 'Every objective has been measured and met.', unmeasured, missed };
}
