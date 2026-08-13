// src/lib/offer-clock.ts — how much time is left on an offer, and may it still be revoked?
//
// =================================================================================================
// WHY THIS EXISTS
// =================================================================================================
//
// offer_letters has carried expiry_date and response_deadline since the table was written, and the
// CANDIDATE'S page counts them down: /portal/offer/[token] warns at three days and refuses to show
// the signature panel once the expiry has passed. The admin side showed neither. Its status line
// read "Sent - awaiting signature" for an offer that had expired a fortnight earlier, so the only
// person who could act on it was the only person not told.
//
// And the revoke path was worse than missing. The `withdraw` action handler on the offer letter page
// is complete: it sets the status, records the reason, pushes the candidate and reports separately
// when the push fails. NOTHING IN THE PAGE EVER SUBMITTED IT. The handler had already been fixed
// once, for a ReferenceError that committed the withdrawal and then reported failure — fixed on a
// control that could not be reached from any screen.
//
// So this module answers both questions in one place, as a pure function over the row and today's
// civil date. Both admin surfaces read it and neither does date arithmetic of its own: two screens
// each computing "days left" is two chances to disagree about whether an offer is still open.
//
// =================================================================================================
// A TERMINAL STATE ALWAYS BEATS THE CALENDAR
// =================================================================================================
//
// A signed offer does not expire. A revoked one does not become "overdue" three days later. Those
// are facts about what happened, and a date can never overrule them — showing "expires in 2 days"
// over an offer somebody has already signed would be read as the signature not having counted.

/** Dates are stored as 'YYYY-MM-DD' strings, so they are compared as civil dates, never as instants. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type OfferState =
  | 'none'       // no letter exists yet
  | 'draft'      // written, not sent
  | 'signed'     // the candidate accepted
  | 'withdrawn'  // we revoked it
  | 'declined'   // the candidate declined
  | 'open'       // live, with time in hand
  | 'due_soon'   // live, and the nearer date is within WARN_DAYS
  | 'overdue'    // the response deadline has passed but the offer has not expired
  | 'expired'    // past the expiry date
  | 'undated';   // live, but nobody set a deadline or an expiry

/** Inside this many days the clock is worth acting on rather than watching. */
export const WARN_DAYS = 3;

export interface OfferRowLike {
  status?: string | null;
  expiryDate?: string | null;
  responseDeadline?: string | null;
  signedAt?: Date | string | null;
  withdrawnAt?: Date | string | null;
  declinedAt?: Date | string | null;
}

export interface OfferClock {
  state: OfferState;
  /** True while the offer could still be accepted. Terminal states and expiry are all false. */
  live: boolean;
  /** Whole days until the response deadline. Negative once it has passed. Null when unset. */
  deadlineDays: number | null;
  /** Whole days until expiry. Negative once it has passed. Null when unset. */
  expiryDays: number | null;
  responseDeadline: string | null;
  expiryDate: string | null;
  /** One sentence for the person looking at the screen, never a status code. */
  sentence: string;
  /** Short label for a chip. */
  label: string;
  /** Whether a revoke control should be offered. */
  canRevoke: boolean;
  /** Set when revoking would withdraw something the candidate has already accepted. */
  revokeIsRescission: boolean;
}

function isDate(v: unknown): v is string {
  return typeof v === 'string' && DATE_RE.test(v);
}

/** Whole days from `from` to `to`, both civil dates. Positive means `to` is in the future. */
export function daysBetween(from: string, to: string): number | null {
  if (!isDate(from) || !isDate(to)) return null;
  const f = from.split('-').map(Number);
  const t = to.split('-').map(Number);
  // UTC on both sides: these are calendar dates, so no zone may shift one of them by a day.
  return Math.round((Date.UTC(t[0], t[1] - 1, t[2]) - Date.UTC(f[0], f[1] - 1, f[2])) / 86400000);
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** "in 4 days" / "today" / "5 days ago" — the phrase people actually use. */
export function inDays(n: number): string {
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? 'in ' + n + ' days' : Math.abs(n) + ' days ago';
}

/**
 * Read the clock on one offer.
 *
 * `today` is the caller's civil date — pass civilToday() from page-safety so every surface agrees on
 * which day it is in Asia/Kolkata rather than in whatever zone the server happens to run in.
 *
 * NEVER THROWS. An unreadable date is treated as absent, because a malformed string must not take
 * down the one screen that would let somebody fix it.
 */
export function offerClock(offer: OfferRowLike | null | undefined, today: string): OfferClock {
  const base: OfferClock = {
    state: 'none', live: false, deadlineDays: null, expiryDays: null,
    responseDeadline: null, expiryDate: null,
    sentence: 'No offer letter has been created for this application yet.',
    label: 'Not sent', canRevoke: false, revokeIsRescission: false,
  };
  if (!offer) return base;

  const deadline = isDate(offer.responseDeadline) ? offer.responseDeadline : null;
  const expiry = isDate(offer.expiryDate) ? offer.expiryDate : null;
  const deadlineDays = deadline ? daysBetween(today, deadline) : null;
  const expiryDays = expiry ? daysBetween(today, expiry) : null;
  const dates = { responseDeadline: deadline, expiryDate: expiry, deadlineDays, expiryDays };

  const status = String(offer.status || '').toLowerCase();

  // ---- terminal states, which the calendar never overrules ----
  if (status === 'signed' || offer.signedAt) {
    return {
      ...base, ...dates, state: 'signed', label: 'Signed',
      sentence: 'The candidate signed this offer. It does not expire.',
      // Revoking after signature is a different act with different consequences, so it is offered
      // but named for what it is rather than quietly hidden.
      canRevoke: true, revokeIsRescission: true,
    };
  }
  if (status === 'withdrawn' || offer.withdrawnAt) {
    return {
      ...base, ...dates, state: 'withdrawn', label: 'Revoked',
      sentence: 'This offer was revoked. A corrected letter can still be issued from the form below.',
    };
  }
  if (status === 'declined' || offer.declinedAt) {
    return {
      ...base, ...dates, state: 'declined', label: 'Declined',
      sentence: 'The candidate declined this offer. A revised letter can still be issued below.',
    };
  }
  if (status === 'draft' || status === '') {
    return {
      ...base, ...dates, state: 'draft', label: 'Draft',
      sentence: 'This letter is saved but has not been sent, so no clock is running and the candidate cannot see it.',
    };
  }

  // ---- sent, and not yet answered ----
  const revoke = { canRevoke: true, revokeIsRescission: false };

  if (expiryDays !== null && expiryDays < 0) {
    return {
      ...base, ...dates, ...revoke, state: 'expired', label: 'Expired',
      sentence: 'This offer expired ' + inDays(expiryDays) + ' (' + expiry + '). The candidate can no longer sign it. '
        + 'Reissue it with a new date below, or revoke it so the record says what happened.',
    };
  }

  if (deadlineDays !== null && deadlineDays < 0) {
    return {
      ...base, ...dates, ...revoke, state: 'overdue', live: true, label: 'Past deadline',
      sentence: 'The reply was due ' + inDays(deadlineDays) + ' (' + deadline + ') and none has come. '
        + (expiryDays !== null
          ? 'The offer itself is still signable for another ' + expiryDays + ' ' + plural(expiryDays, 'day', 'days') + '.'
          : 'No expiry was set, so the offer stays signable until somebody revokes it.'),
    };
  }

  const nearest: number[] = [];
  if (deadlineDays !== null) nearest.push(deadlineDays);
  if (expiryDays !== null) nearest.push(expiryDays);

  if (!nearest.length) {
    return {
      ...base, ...dates, ...revoke, state: 'undated', live: true, label: 'Open, no deadline',
      sentence: 'This offer has neither a response deadline nor an expiry date, so nothing is counting down and it '
        + 'stays open until somebody revokes it. Add dates below if it should not.',
    };
  }

  const soonest = Math.min.apply(null, nearest);
  const deadlineIsNearer = deadlineDays !== null && deadlineDays === soonest;
  const which = deadlineIsNearer ? 'A reply is due' : 'It expires';
  const on = deadlineIsNearer ? deadline : expiry;
  let tail = '';
  if (deadlineDays !== null && expiryDays !== null && deadlineDays !== expiryDays) {
    tail = deadlineIsNearer
      ? ' The offer itself expires ' + inDays(expiryDays) + '.'
      : ' The reply was due ' + inDays(deadlineDays) + '.';
  }

  if (soonest <= WARN_DAYS) {
    return {
      ...base, ...dates, ...revoke, state: 'due_soon', live: true,
      label: soonest === 0 ? 'Due today' : soonest + ' ' + plural(soonest, 'day', 'days') + ' left',
      sentence: which + ' ' + inDays(soonest) + ' (' + on + ').' + tail,
    };
  }

  return {
    ...base, ...dates, ...revoke, state: 'open', live: true,
    label: soonest + ' days left',
    sentence: which + ' ' + inDays(soonest) + ' (' + on + ').' + tail,
  };
}
