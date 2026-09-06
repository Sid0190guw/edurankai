// src/lib/work-mode.ts
//
// THE ONE PLACE A ROLE'S WORK MODE IS DECIDED.
//
// Why this file exists
// --------------------
// Every advertised role said "Remote / Hybrid (India)". It was a single constant, copy-pasted as
// `REMOTE_IN` into eleven catalogue files, and from there it went into the roles table, the careers
// card, the JobPosting structured data (as `jobLocationType: 'TELECOMMUTE'`), the public jobs feed
// (`remote: true`) and the offer-letter default. Candidates applied for remote work and employees
// were offered it in writing. That is not how the company works: permanent roles are on site, and
// hybrid exists only for people who are here to learn.
//
// THE POLICY, in one sentence: permanent engagements are ON SITE; internships and apprenticeships
// may be on site or hybrid; nothing is remote.
//
// The mode is therefore NOT free text and NOT sniffed out of a location string at each call site.
// It is derived from the engagement, here, and every surface asks this module. A stored location
// string that still says "remote" cannot re-introduce remote work: `resolveWorkMode` clamps it.
//
// No database, no I/O. Pure data and pure functions, safe to import from .astro frontmatter,
// from API routes and from tests.

/* ------------------------------------------------------------------------------------- modes */

/** The only work modes this company ADVERTISES. 'remote' is deliberately absent from the union. */
export type WorkMode = 'on-site' | 'hybrid';

export const WORK_MODES: readonly WorkMode[] = ['on-site', 'hybrid'] as const;

/* ------------------------------------------------------------------ what an OFFER may agree to */

/**
 * WHAT IS ADVERTISED AND WHAT IS AGREED ARE NOT THE SAME QUESTION, and this is where they part.
 *
 * Everything above is about a PUBLIC POSTING: what /careers shows, what the jobs feed publishes,
 * what Google is told. That stays exactly as it was — permanent work is on site, trainees may be
 * hybrid, and nothing is advertised as remote. The reasons in this file's header have not changed:
 * candidates applied for remote work because the adverts said so, and were then offered it in
 * writing.
 *
 * An OFFER LETTER is a different act. It is written for one named person, by a human who has
 * already spoken to them, and it records the arrangement those two agreed. Remote belongs there and
 * not on a job board, so it lives in a separate union that the advertising path cannot reach.
 *
 * The practical guarantee: adding 'remote' here CANNOT put remote work back on a public page.
 * `allowedWorkModes`, `resolveWorkMode`, `displayLocation` and `jobLocationType` all still speak in
 * `WorkMode`, which has no remote member, so a stale database row still resolves to on-site or
 * hybrid on every candidate-facing surface.
 */
export type OfferWorkMode = WorkMode | 'remote';

/** Every mode an individually negotiated offer letter may record. */
export const OFFER_WORK_MODES: readonly OfferWorkMode[] = ['on-site', 'hybrid', 'remote'] as const;

/**
 * The modes an offer letter may choose from. Unlike `allowedWorkModes` this does not narrow by
 * engagement: the engagement decides what may be ADVERTISED, and a signed arrangement with one
 * person is not an advert.
 */
export function offerableWorkModes(): readonly OfferWorkMode[] {
  return OFFER_WORK_MODES;
}

export function isOfferWorkMode(v: unknown): v is OfferWorkMode {
  return typeof v === 'string' && (OFFER_WORK_MODES as readonly string[]).includes(v);
}

/** "On-Site" / "Hybrid" / "Remote" — the single word an offer letter prints. */
export function offerWorkModeTitle(mode: OfferWorkMode): string {
  if (mode === 'remote') return 'Remote';
  return workModeTitle(mode);
}

/**
 * What an offer letter should record, given what the admin submitted.
 *
 * A submitted value is honoured when it is one of the three real modes — that is the whole point of
 * the control. Anything unrecognised (an empty form field, a tampered POST, a stale value from an
 * older letter) falls back to what the ENGAGEMENT would advertise, which is the conservative answer
 * and never remote.
 */
export function resolveOfferWorkMode(
  engagementType?: string | null,
  level?: string | null,
  submitted?: string | null,
): OfferWorkMode {
  const raw = String(submitted || '').trim().toLowerCase().replace(/\s+/g, '-');
  if (raw === 'remote') return 'remote';
  if (raw === 'hybrid') return 'hybrid';
  if (raw === 'on-site' || raw === 'onsite') return 'on-site';
  return resolveWorkMode(engagementType, level, null);
}

/**
 * The work mode a PREVIOUSLY SAVED offer letter recorded, read out of its `content` jsonb — or
 * `null` when there is nothing usable to read.
 *
 * WHY THIS EXISTS AS ITS OWN FUNCTION, rather than inline where it is used. `offer_letters.content`
 * is a jsonb column with no schema of its own — "so we can change template fields without
 * migrations", per its own table comment — which means every value coming out of it is untyped and
 * every one of these is a real, seen shape: `content` can be `null` on a row from before this field
 * existed, `content.workMode` can be `undefined` on a row saved before an earlier version of the
 * builder wrote it, or it can hold whatever a hand-edited or malformed row happens to contain. None
 * of those are errors — they are exactly what "an application created before the current work-mode
 * architecture" looks like on disk — and the one honest answer to all of them is `null`: "nothing
 * saved to prefer", which resolveOfferWorkMode already turns into the safe, non-remote,
 * engagement-derived default rather than into remote by accident.
 *
 * This does not decide anything — it only answers "was there a usable value here at all". The
 * decision belongs to resolveOfferWorkMode, called with this as its `submitted` argument.
 */
export function offerWorkModeFromSavedContent(content: Record<string, unknown> | null | undefined): string | null {
  if (!content || typeof content !== 'object') return null;
  const v = content.workMode;
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Engagement names as they are stored on `roles.engagement_type` and on applications. */
export type EngagementName =
  | 'Internship' | 'Apprenticeship' | 'Full-Time' | 'Part-Time' | 'Contract';

/** Levels as stored on `roles.level`. Only the two trainee levels matter to this policy. */
export type RoleLevel =
  | 'C-Level' | 'Lead' | 'Senior' | 'Mid' | 'Junior' | 'Intern' | 'Apprentice';

/* -------------------------------------------------------------------------------------- site */

/**
 * The company's working site. Structured rather than a sentence, because JobPosting structured data
 * needs the parts separately and a regex over a display string is how "On-site, India (exact
 * location disclosed on selection)" once ended up published as a city name.
 */
export const PRIMARY_SITE = {
  locality: 'Kolkata',
  region: 'West Bengal',
  country: 'India',
  countryCode: 'IN',
} as const;

/** "Kolkata, West Bengal, India" -- the site, spelled out, with no mode attached. */
export const PRIMARY_SITE_TEXT =
  PRIMARY_SITE.locality + ', ' + PRIMARY_SITE.region + ', ' + PRIMARY_SITE.country;

/* ------------------------------------------------------------------------------------ policy */

const TRAINEE_ENGAGEMENTS: readonly string[] = ['internship', 'apprenticeship'];
const TRAINEE_LEVELS: readonly string[] = ['intern', 'apprentice'];

/**
 * True when the engagement is one that is here to learn. Checks the level as well as the
 * engagement type because the two disagree in the data: some catalogue rows carry level 'Intern'
 * with engagement 'Internship', others were imported with only one of the two set.
 */
export function isTraineeEngagement(
  engagementType?: string | null,
  level?: string | null,
): boolean {
  const e = (engagementType || '').trim().toLowerCase();
  const l = (level || '').trim().toLowerCase();
  return TRAINEE_ENGAGEMENTS.includes(e) || TRAINEE_LEVELS.includes(l);
}

/**
 * The modes a given engagement is ALLOWED to be advertised as. Permanent work is on site, full
 * stop. Hybrid is available to trainees only, and is a concession to people who are studying
 * elsewhere at the same time -- not a general option a permanent role can be edited into.
 */
export function allowedWorkModes(
  engagementType?: string | null,
  level?: string | null,
): readonly WorkMode[] {
  return isTraineeEngagement(engagementType, level)
    ? (['on-site', 'hybrid'] as const)
    : (['on-site'] as const);
}

/** The mode a role gets when nothing usable is stored: the most restrictive one it is allowed. */
export function defaultWorkMode(): WorkMode {
  return 'on-site';
}

/**
 * Does this stored location text claim remote working? Used to find legacy rows and to decide
 * whether a stored string may be trusted. Matches the wording the old catalogues used
 * ("Remote / Hybrid (India)", "Remote", "Remote / Any", "Work from home", "Telecommute").
 */
export function claimsRemote(location?: string | null): boolean {
  return /\b(remote|telecommut\w*|work[\s-]?from[\s-]?home|wfh|anywhere|worldwide)\b/i
    .test(String(location || ''));
}

/** Does this stored location text claim hybrid working? */
export function claimsHybrid(location?: string | null): boolean {
  return /\bhybrid\b/i.test(String(location || ''));
}

/**
 * The role's real work mode. Reads what is stored, then CLAMPS it to what the engagement allows,
 * so a stale "Remote / Hybrid (India)" row still in the database resolves to 'on-site' for a
 * permanent role and to 'hybrid' for an internship. Nothing resolves to remote, ever -- that is
 * the point of returning a two-value union rather than the stored string.
 */
export function resolveWorkMode(
  engagementType?: string | null,
  level?: string | null,
  location?: string | null,
): WorkMode {
  const allowed = allowedWorkModes(engagementType, level);
  if (!allowed.includes('hybrid')) return 'on-site';
  // A trainee row may legitimately be hybrid. Legacy "Remote / Hybrid" rows land here too, and
  // hybrid is the honest reading of them: partly on site, partly not.
  const text = String(location || '');
  if (claimsHybrid(text) || claimsRemote(text)) return 'hybrid';
  return 'on-site';
}

/**
 * True when the stored location string contradicts the policy and needs rewriting. The admin
 * diagnostics surface uses this to list rows that still advertise remote work.
 */
export function violatesWorkModePolicy(
  engagementType?: string | null,
  level?: string | null,
  location?: string | null,
): boolean {
  const text = String(location || '');
  if (claimsRemote(text)) return true;
  if (claimsHybrid(text) && !allowedWorkModes(engagementType, level).includes('hybrid')) return true;
  return false;
}

/* ------------------------------------------------------------------------------------ labels */

/** "On-site" / "On-site / Hybrid" -- the mode alone, for a badge or a table cell. */
export function workModeLabel(mode: WorkMode): string {
  return mode === 'hybrid' ? 'On-site / Hybrid' : 'On-site';
}

/**
 * The single-word label an offer letter, an HR record or a requisition uses: "On-Site" / "Hybrid".
 * Distinct from `workModeLabel` because an offer sentence reads "You will work On-Site, for 12
 * Months" -- "On-site / Hybrid" is a job-advert phrase and cannot be an agreed term.
 */
export function workModeTitle(mode: WorkMode): string {
  return mode === 'hybrid' ? 'Hybrid' : 'On-Site';
}

/**
 * The full location line stored on a role and shown on the careers card:
 * "On-site -- Kolkata, West Bengal, India".
 *
 * `site` overrides the default for roles that are genuinely somewhere else -- a field role, or the
 * campus ambassador who works at their own college.
 */
export function locationLabel(mode: WorkMode, site: string = PRIMARY_SITE_TEXT): string {
  return workModeLabel(mode) + ' — ' + site;
}

/**
 * What a candidate should SEE for this role, right now.
 *
 * Reads the stored string, and rewrites it only when it contradicts the policy. That distinction
 * matters: roles with a real bespoke site ("On-site -- field-based ... with travel", "On-site --
 * your own campus") keep their own wording, while a legacy "Remote / Hybrid (India)" row is shown
 * as what it actually is. Rendering through this means a database row that has not been corrected
 * yet cannot advertise remote work on a live page.
 */
export function displayLocation(
  engagementType?: string | null,
  level?: string | null,
  location?: string | null,
): string {
  const text = String(location || '').trim();
  if (!text) return correctedLocation(engagementType, level, text);
  if (!violatesWorkModePolicy(engagementType, level, text)) return text;
  return correctedLocation(engagementType, level, text);
}

/** The location line a role SHOULD carry, given its engagement. Used by the repair path. */
export function correctedLocation(
  engagementType?: string | null,
  level?: string | null,
  location?: string | null,
  site: string = PRIMARY_SITE_TEXT,
): string {
  return locationLabel(resolveWorkMode(engagementType, level, location), site);
}

/**
 * True when this role's own location line describes somewhere other than the company site -- the
 * campus ambassador at their own college, a field role that travels, the flagship programme whose
 * site is deliberately not published. `locationLabel` and `correctedLocation` already take a
 * `site` parameter for exactly these, so the sentence below must not assume the default one.
 */
function hasBespokeSite(location?: string | null): boolean {
  const text = String(location || '').trim();
  if (!text) return false;
  if (claimsRemote(text)) return false; // a stale row, not a real bespoke site
  return !text.includes(PRIMARY_SITE_TEXT) && !text.includes(PRIMARY_SITE.locality);
}

/**
 * The sentence under the engagement type on a job page.
 *
 * `location` is the role's stored line, and it is read for ONE reason: a role whose site is not
 * the company site must not be told it is "on site at Kolkata" directly beneath a location badge
 * that says otherwise. The campus-ambassador internship exists precisely because the student is at
 * their own college; the flagship programme withholds its site on purpose. Naming the default
 * locality for either contradicts the line above it, and for the flagship role it also publishes
 * the very city the posting is written to keep unpublished. When the site is bespoke the sentence
 * states the mode and stays silent about the place, which the badge above has already given.
 */
export function workModeSentence(
  mode: WorkMode,
  engagementType?: string | null,
  location?: string | null,
): string {
  const e = (engagementType || '').trim();
  const bespoke = hasBespokeSite(location);
  if (mode === 'hybrid') {
    const what = /apprentice/i.test(e) ? 'apprenticeship' : 'internship';
    const where = bespoke ? '' : ' at ' + PRIMARY_SITE.locality;
    return 'This ' + what + ' is on site' + where
      + ', with hybrid days available by prior arrangement. It is not a remote position.';
  }
  const where = bespoke ? ' at the location given above' : ' at ' + PRIMARY_SITE.locality;
  return 'This is an on-site role' + where + '. It is not remote and not hybrid.';
}

/**
 * Why a location line was rejected, in words an admin can act on. Returned by the role forms
 * instead of silently rewriting what was typed: the location line is the admin's wording, and
 * quietly changing it is how a posting and an offer letter come to disagree.
 */
export function workModePolicyMessage(
  engagementType?: string | null,
  level?: string | null,
): string {
  if (allowedWorkModes(engagementType, level).includes('hybrid')) {
    return 'location: internships and apprenticeships are on site or hybrid, never remote. '
      + 'Use "' + locationLabel('on-site') + '" or "' + locationLabel('hybrid') + '".';
  }
  return 'location: permanent roles are on site -- not remote, not hybrid. '
    + 'Only internships and apprenticeships may be hybrid. Use "' + locationLabel('on-site') + '".';
}

/* -------------------------------------------------------------------- structured data (Google) */

/**
 * schema.org `jobLocationType`. Always null.
 *
 * Google uses TELECOMMUTE to mean the work is done away from any employer site, and its own
 * guidance is that a hybrid role is NOT TELECOMMUTE -- it has a real place of work. Since nothing
 * here is remote, this property is never emitted. The previous code set it whenever the location
 * string merely contained the word "hybrid", which advertised every internship as remote work in
 * search results, and that is the mismatch candidates were acting on.
 */
export function jobLocationType(_mode: WorkMode): null {
  return null;
}

/** The `PostalAddress` for a JobPosting at the company's own site. */
export function jobPostalAddress(site: { countryCode: string; region: string; locality: string } = PRIMARY_SITE) {
  return {
    '@type': 'PostalAddress',
    addressCountry: site.countryCode,
    addressRegion: site.region,
    addressLocality: site.locality,
  };
}
