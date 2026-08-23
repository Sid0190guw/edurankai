// src/lib/horizon/intake/types.ts — PATCH 01's OWNED CONTRACT. Extend additively; never re-shape.
//
// =================================================================================================
// WHAT PATCH 01 IS, AND WHERE ITS EDGES ARE
// =================================================================================================
//
// PATCH 01 is a CAPTURE layer and only that. It validates and normalises the optional personal
// profile information an applicant may authorise us to hold, records the consent that authorises
// it, writes it behind an encryption boundary, and ASKS — by event — for a recomputation.
//
// It owns exactly three tables:
//
//   hzn_consent_event         append-only consent ledger (grant / withdrawal)
//   hzn_personal_foundation   one encrypted record per subject
//   hzn_recompute_request     the durable half of `profile.recompute_requested`
//
// IT DOES NOT OWN, AND MUST NOT REDEFINE:
//   applications / application_intents  — src/lib/db/schema.ts. The existing recruitment fields,
//                                          including the plaintext dob / birth_time / birth_place
//                                          columns that src/pages/api/auth/forgot-password.ts reads,
//                                          are left exactly as they are. Nothing here rewrites them.
//   SubjectRef, ActorRef, organisation   — src/lib/horizon/ids.ts (the HORIZON contracts patch).
//   the computation of any insight       — PATCH 02. This module produces none and imports none.
//   the interpretation vocabulary        — src/lib/horizon/interpretation. Not referenced here.
//   who may open a console               — src/lib/auth/permissions.ts. Capabilities are per USER.
//   encryption keys                      — src/lib/crypto. This module borrows that boundary.
//
// =================================================================================================
// THE FIVE THINGS THIS MODULE KEEPS APART
// =================================================================================================
//
//   a) RAW SOURCE DATA   what the person typed: date, time, place, coordinates, zone. Kept verbatim
//                        in `place.raw` even after normalisation, because normalisation is lossy.
//   b) DERIVED DATA      DerivedInstant — the UTC offset that actually applied and the resulting UTC
//                        instant. Computed mechanically from (a) by the platform's own tz database,
//                        labelled derived, and never mistaken for something the person stated.
//   c) INTERPRETATION    NOT IN THIS MODULE. Nothing here reads meaning into anything.
//   d) HUMAN FEEDBACK    NOT IN THIS MODULE.
//   e) HUMAN DECISION    NOT IN THIS MODULE. No function here can advance, reject or rank anybody,
//                        and none may be added. Consent state gates STORAGE, never an outcome.
//
// =================================================================================================
// LANGUAGE
// =================================================================================================
//
// One prohibited-vocabulary rule applies to every string in this patch that a person can see, and
// notice.ts enforces it with a test rather than a promise: the information is described as optional
// personal profile information used for personalised professional and long-term development
// insights. See PROHIBITED_TERMS in ./notice.ts.
//
// HOUSE RULES OBSERVED: postgres-js returns PLAIN ARRAYS (rowsOf); the real Postgres reason lives on
// e.cause (reasonOf); every `const` is declared before the function that reads it; NOTHING in this
// file imports the database, so every pure function below is reachable from a test with no
// connection at all.
import type { ActorRef, SubjectRef } from '@/lib/horizon/ids';

/** postgres-js returns a plain array; the pg driver returns { rows }. Normalise both. */
export const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The REAL Postgres reason. `e.message` is only the failed SQL. */
export const reasonOf = (e: any): string =>
  String(e?.cause?.message || e?.message || e || 'unknown error');

// -------------------------------------------------------------------------------------------------
// CONSENT
// -------------------------------------------------------------------------------------------------

/**
 * The one consent scope this patch owns.
 *
 * A scope is a PURPOSE, not a table. This one authorises holding personal profile information for
 * personalised professional and long-term development insights. Any other purpose needs its own
 * scope, its own notice and its own grant — a single tick box cannot be stretched to cover a use
 * the person was never shown.
 */
export const CONSENT_SCOPE_PERSONAL_FOUNDATION = 'personal_foundation';
export type ConsentScope = typeof CONSENT_SCOPE_PERSONAL_FOUNDATION;

export type ConsentAction = 'granted' | 'withdrawn';

/** One row of the append-only ledger. Nothing in this module ever updates or deletes one. */
export interface ConsentEvent {
  id: string;
  subject: SubjectRef;
  scope: ConsentScope;
  action: ConsentAction;
  /** The notice version the person was actually shown. */
  noticeVersion: string;
  /** SHA-256 of that notice's canonical text, so a later edit to the copy is detectable. */
  noticeHash: string;
  occurredAt: string;
  actor: ActorRef | null;
  /** The surface the act happened on, e.g. 'apply/step-1'. */
  source: string;
  ipAddress: string | null;
  userAgent: string | null;
  reason: string | null;
}

/**
 * The current answer to "may we hold this?", DERIVED from the ledger rather than stored.
 *
 * Derived on purpose: a mutable `is_consented` boolean is a field somebody eventually updates
 * without leaving a trace of who or when, and consent is precisely the thing that must never be
 * unexplainable.
 */
export interface ConsentState {
  subject: SubjectRef;
  scope: ConsentScope;
  /** True only when the most recent event is a grant. */
  granted: boolean;
  /** The version the person saw on their most recent grant. Null when never asked. */
  noticeVersion: string | null;
  noticeHash: string | null;
  grantedAt: string | null;
  withdrawnAt: string | null;
  /**
   * A live grant against a SUPERSEDED notice version. Still a grant — it is not silently revoked —
   * but the person must be re-asked before the data is used under the newer notice.
   */
  stale: boolean;
  /** The id of the most recent event, so another layer can cite the exact consent record. */
  consentRef: string | null;
}

// -------------------------------------------------------------------------------------------------
// THE FOUNDATION INPUT — what the person stated, after validation and normalisation
// -------------------------------------------------------------------------------------------------

/**
 * How exactly the time of birth is known, as stated by the person.
 *
 * Recorded rather than assumed. "09:30" written from memory and "09:30:00" copied off a certificate
 * are not the same fact, and a later engine that cannot tell them apart will report a confidence it
 * has not earned. `unknown` is a first-class answer, not a missing value.
 */
export type TimePrecision = 'exact' | 'minute' | 'hour' | 'approximate' | 'unknown';

export const TIME_PRECISIONS: readonly TimePrecision[] =
  ['exact', 'minute', 'hour', 'approximate', 'unknown'];

export const TIME_PRECISION_LABELS: Record<TimePrecision, string> = {
  exact: 'To the second, from a record',
  minute: 'To the minute, from a record',
  hour: 'To the hour',
  approximate: 'Approximate, from memory',
  unknown: 'Not known',
};

/** How well the stated place resolved. `freetext` means nothing beyond the raw string is trusted. */
export type PlacePrecision = 'structured' | 'partial' | 'freetext';

/**
 * Where the timezone came from.
 *
 * `declared` — the person chose it. `device` — their browser reported it and they left it as-is.
 * `unresolved` — nobody knows, and NOTHING in this module guesses. A place name is not a timezone:
 * inventing one would silently manufacture a birth instant that is hours wrong.
 */
export type TimezoneSource = 'declared' | 'device' | 'unresolved';

/** Normalised place of birth. Every field is as stated; nothing here is geocoded or looked up. */
export interface BirthPlace {
  /** The raw string exactly as typed. Normalisation is lossy, so the source is kept beside it. */
  raw: string;
  city: string | null;
  region: string | null;
  country: string | null;
  /** ISO 3166-1 alpha-2, resolved from the country name or code the person gave. */
  countryCode: string | null;
  precision: PlacePrecision;
  /** Stable lookup key: lowercased, punctuation stripped, single-spaced. Not for display. */
  canonical: string;
}

/**
 * Coordinates, accepted ONLY when the person supplies them.
 *
 * There is no geocoder behind this interface and there is deliberately not going to be one in this
 * patch: sending a person's birth place to a third-party lookup service is a disclosure they did
 * not agree to, and this platform does not make one.
 */
export interface BirthCoordinates {
  latitude: number;
  longitude: number;
  /** Where the numbers came from, in the person's own words (certificate, map, family records). */
  statedSource: string | null;
}

/**
 * The DERIVED time facts — computed from the stated local time and zone by the platform's own tz
 * database (ICU, through Intl), with no external service involved.
 */
export interface DerivedInstant {
  /** The UTC offset in minutes that actually applied at that local wall time. History and DST included. */
  utcOffsetMinutes: number;
  /** The birth instant in UTC, ISO 8601. */
  utcIso: string;
  /**
   * The local wall time occurs TWICE in that zone (a DST fall-back). The EARLIER occurrence is used
   * and the flag is kept, because a reader must be able to see that a choice was made.
   */
  ambiguous: boolean;
  /** The local wall time does NOT exist in that zone (a DST spring-forward gap). Kept, never hidden. */
  nonexistent: boolean;
}

/** The complete validated block. This — and only this — is what gets encrypted. */
export interface PersonalFoundationInput {
  /** ISO yyyy-mm-dd, as stated. */
  dateOfBirth: string;
  /** 24-hour local wall time as stated, "HH:MM:SS". Null when not provided. */
  timeOfBirth: string | null;
  timePrecision: TimePrecision;
  place: BirthPlace;
  coordinates: BirthCoordinates | null;
  /** IANA zone id, e.g. "Asia/Kolkata". Null when unresolved. */
  timezoneId: string | null;
  timezoneSource: TimezoneSource;
  /** Present only when BOTH a time and a zone are known. Null otherwise — never a fabricated midnight. */
  derived: DerivedInstant | null;
}

/** Field-level validation outcome. `field` matches the form control name so a page can mark it. */
export interface FieldIssue {
  field: string;
  message: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T; warnings: FieldIssue[] }
  | { ok: false; errors: FieldIssue[]; warnings: FieldIssue[] };

/** The raw, untrusted shape a form or an API body arrives in. Every field is optional and unparsed. */
export interface RawFoundationSubmission {
  dateOfBirth?: unknown;
  timeOfBirth?: unknown;
  timePrecision?: unknown;
  birthPlace?: unknown;
  birthCity?: unknown;
  birthRegion?: unknown;
  birthCountry?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  coordinatesSource?: unknown;
  timezoneId?: unknown;
  timezoneSource?: unknown;
}

// -------------------------------------------------------------------------------------------------
// STORED RECORD
// -------------------------------------------------------------------------------------------------

/**
 * Lifecycle of the stored record.
 *
 * Tracked explicitly so that "we hold nothing for this person" and "we hold something we could not
 * process" are never the same answer. `blocked_encryption_unavailable` exists because a deployment
 * with no key material must fail visibly rather than quietly writing this data in the clear.
 */
export type ProcessingStatus =
  /** Consent given, input validated, ciphertext written. Nothing has been asked of it yet. */
  | 'captured'
  /** A recomputation has been asked for and no engine has reported back. */
  | 'recompute_requested'
  /** Consent withdrawn; ciphertext deleted. The row survives as the record THAT it was deleted. */
  | 'withdrawn'
  /** Encryption is not configured here, so NOTHING was stored. Never a silent pass. */
  | 'blocked_encryption_unavailable';

export const PROCESSING_STATUSES: readonly ProcessingStatus[] =
  ['captured', 'recompute_requested', 'withdrawn', 'blocked_encryption_unavailable'];

/**
 * The NON-SENSITIVE half of the row.
 *
 * Everything a status screen, an operator or a queue planner needs, with no decryption and therefore
 * no audit entry. Note what is deliberately absent: no date, no time, no place, no country, no zone,
 * no coordinates. Those exist only inside the ciphertext, and reading them is an audited act.
 */
export interface FoundationHoldings {
  subject: SubjectRef;
  processingStatus: ProcessingStatus;
  /** False once consent is withdrawn and the ciphertext is purged. */
  hasStoredData: boolean;
  hasBirthTime: boolean;
  timePrecision: TimePrecision | null;
  placePrecision: PlacePrecision | null;
  hasCoordinates: boolean;
  timezoneResolved: boolean;
  consentVersion: string | null;
  consentGrantedAt: string | null;
  /** Which encryption key the ciphertext is under, so a rotation can find what it must re-wrap. */
  keyId: string | null;
  source: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export type StoreOutcome =
  | { ok: true; holdings: FoundationHoldings; changed: boolean; inputHash: string | null }
  | { ok: false; reason: StoreDenial; message: string };

export type StoreDenial =
  | 'no-consent'
  | 'invalid-input'
  | 'encryption-unavailable'
  | 'storage-error';

// -------------------------------------------------------------------------------------------------
// RECOMPUTATION REQUESTS — the durable half of `profile.recompute_requested`
// -------------------------------------------------------------------------------------------------

export type RecomputeStatus = 'pending' | 'claimed' | 'completed' | 'failed' | 'cancelled';

export const RECOMPUTE_STATUSES: readonly RecomputeStatus[] =
  ['pending', 'claimed', 'completed', 'failed', 'cancelled'];

export type RecomputeReason =
  | 'application.submitted'
  | 'foundation.updated'
  | 'consent.granted'
  | 'manual';

export const RECOMPUTE_REASONS: readonly RecomputeReason[] =
  ['application.submitted', 'foundation.updated', 'consent.granted', 'manual'];

export interface RecomputeRequest {
  id: string;
  subject: SubjectRef;
  reason: RecomputeReason;
  status: RecomputeStatus;
  requestedAt: string;
  updatedAt: string;
  /** Keyed HMAC of the normalised input, so an engine can skip work it has already done. */
  inputHash: string | null;
  correlationId: string | null;
  /** An application id OR an application-intent id, as text: the two live in different tables. */
  applicationRef: string | null;
  attempts: number;
  lastError: string | null;
}

// -------------------------------------------------------------------------------------------------
// ACCESS
// -------------------------------------------------------------------------------------------------

/**
 * Why a caller wants the plaintext.
 *
 * There is no "because I can". Every read declares a purpose, the purpose is written to the audit
 * log before a value is returned, and a purpose that is not on this list is refused.
 */
export type ReadPurpose =
  /** The person looking at their own information. */
  | 'subject-self-service'
  /** A server-side engine computing a derived profile. Never a human. */
  | 'intelligence-computation'
  /** A named human answering a data-subject request or a compliance question. */
  | 'compliance-review';

export const READ_PURPOSES: readonly ReadPurpose[] =
  ['subject-self-service', 'intelligence-computation', 'compliance-review'];

/**
 * The capability a HUMAN needs to read somebody else's foundation record.
 *
 * DELIBERATELY NOT ADDED to the Permission union in src/lib/auth/permissions.ts. That union and its
 * grant matrix are a shared contract this patch does not own, and an uncatalogued key resolves
 * through hasPermission() to the super-admin WILDCARD and to nothing else — which is exactly the
 * conservative default this data deserves until a patch that actually ships a review surface
 * catalogues it with a written description and a deliberate grant.
 */
export const HORIZON_FOUNDATION_READ = 'horizon.foundation.read';

/**
 * WHO IS DOING THE READING, as the audit row records it.
 *
 * THIS TYPE WAS MISSING. foundation.ts imports `ReadActor` from this file at four call sites and it
 * was never defined here, so the whole intake read path typechecked as `any` at its most sensitive
 * boundary — the one that decides whose name goes on an access to somebody's personal record.
 *
 * The shape is taken verbatim from actorAsReader() in foundation.ts, which is the only constructor:
 * a `user` actor is recorded as a users.id; anything else (an engine, a service, an employee id that
 * is NOT users.id) is recorded in `service` as "kind:id" rather than being forced into a foreign-key
 * column it would violate.
 */
export interface ReadActor {
  /** users.id, and only when the actor really is a signed-in user. Null for every machine reader. */
  userId: string | null;
  /** "engine:horizon-foundation", "system:cron" — the non-user readers, kept out of userId. */
  service: string | null;
  ipAddress: string | null;
}

export type ReadResult =
  | { ok: true; value: PersonalFoundationInput; holdings: FoundationHoldings }
  | { ok: false; reason: ReadDenial; message: string };

export type ReadDenial =
  | 'not-found'
  | 'no-consent'
  | 'purged'
  | 'forbidden'
  | 'unknown-purpose'
  | 'encryption-unavailable'
  | 'storage-error';

// -------------------------------------------------------------------------------------------------
// THE EVENT CONTRACT — what other patches subscribe to
// -------------------------------------------------------------------------------------------------

/**
 * Published when an applicant completes and submits the application form.
 *
 * NO PERSONAL FOUNDATION VALUES TRAVEL IN THIS PAYLOAD, on purpose. An event is fanned out to every
 * subscriber, some of which log it; a payload carrying a date and place of birth would leak the very
 * data the storage boundary exists to protect. Subscribers that are entitled to the values fetch
 * them through readPersonalFoundation() and are audited for doing so.
 */
export interface ApplicationSubmittedPayload {
  subject: SubjectRef;
  /** Human-readable application number, e.g. EDU-2026-00042. Null before one is assigned. */
  applicationNumber: string | null;
  /** An application id or an application-intent id. `applicationRefKind` says which. */
  applicationRef: string | null;
  applicationRefKind: 'application' | 'application_intent' | null;
  roleId: string | null;
  roleTitle: string | null;
  submittedAt: string;
  /** True when this person authorised personal profile information at intake. */
  hasPersonalFoundation: boolean;
}

/**
 * Published when something has changed that a derived profile should be recomputed from.
 *
 * A REQUEST, never an instruction, and never a result. Nothing in this patch computes anything; a
 * subscriber is free to decide the request is not worth acting on.
 */
export interface ProfileRecomputeRequestedPayload {
  subject: SubjectRef;
  /** The hzn_recompute_request row, so a subscriber can report back through markRecomputeRequest(). */
  requestId: string;
  reason: RecomputeReason;
  requestedAt: string;
  /** Keyed HMAC of the normalised input. Null when nothing is stored for this subject. */
  inputHash: string | null;
  applicationRef: string | null;
  correlationId: string | null;
}

/**
 * An optional durable sink for HORIZON events.
 *
 * Rule 8 of the brief: where a dependency is missing, publish a typed boundary instead of building
 * somebody else's module. ids.ts records that `hzn_event` is a HORIZON-owned outbox, but no patch
 * has shipped it yet. Until one does, this patch emits on the in-process bus (src/lib/events.ts) and
 * records its own durable row in hzn_recompute_request. When the outbox lands, its patch implements
 * this interface and registers it with setHorizonEventSink() — no producer changes.
 */
export interface HorizonEventSink {
  publish(event: { name: string; payload: unknown; correlationId?: string | null }): Promise<void>;
}
