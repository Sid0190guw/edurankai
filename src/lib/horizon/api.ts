// src/lib/horizon/api.ts — THE HORIZON API RESPONSE CONTRACT.
//
// Spec: docs/horizon/HORIZON_CONTRACTS.md section 6.
//
// =================================================================================================
// ONE SHAPE, SO A CALLER CAN TELL FAILURE FROM EMPTINESS
// =================================================================================================
//
// The failure this contract exists to prevent is specific and this codebase has met it: a route that
// returns `[]` when a query throws is indistinguishable, at the caller, from a person who genuinely
// has no records. In an HR intelligence system that is not a cosmetic bug — an empty capability list
// rendered as "no evidence of anything" is a statement about a human being, made by a failed
// database call.
//
// So every HORIZON endpoint answers with a discriminated union. `ok: false` is a first-class,
// typed outcome, not an exception that leaked, and `ok: true` with an empty array means the empty
// array is the answer.
//
// =================================================================================================
// AND A THIRD STATE THE USUAL TWO CANNOT EXPRESS: WITHHELD
// =================================================================================================
//
// Rule 18: do not expose internal computation details to roles that do not have permission. The
// naive implementation deletes the field, and then a manager and an auditor looking at the same
// record see two different documents with no way to tell that one of them is redacted. That is how
// a redacted record silently becomes the record.
//
// This contract separates two cases, because they are genuinely different:
//
//   WITHHELD  The field exists and this reader may know it exists, but may not see the value.
//             Reported in `meta.withheld` so the screen can print "restricted" instead of nothing.
//   OMITTED   The field's EXISTENCE is itself restricted. It is absent and it is not announced,
//             because announcing it discloses the thing the restriction protects. The access LOG
//             still records that the read happened — invisible to the reader is not invisible to
//             the auditor.
//
// Nothing about a person is ever silently dropped without landing in one of those two buckets, and
// access.ts decides which bucket a field falls into. This module only defines the vocabulary.

import type { OrganisationId, SubjectRef } from './ids';

// -------------------------------------------------------------------------------------------------
// CONSTANTS. Declared before anything that reads them.
// -------------------------------------------------------------------------------------------------

/**
 * The contract version every response carries.
 *
 * Bumped only for a BREAKING change to the envelope. Additive fields — a new optional member of
 * `meta`, a new error code — do not bump it, because a client that ignores a field it does not know
 * about is not broken.
 */
export const HORIZON_API_VERSION = '1' as const;

/** Cursor pagination default and ceiling. A caller that asks for everything gets the ceiling. */
export const PAGE_DEFAULT_SIZE = 25;
export const PAGE_MAX_SIZE = 200;

// -------------------------------------------------------------------------------------------------
// ERRORS
// -------------------------------------------------------------------------------------------------

/**
 * The complete error vocabulary. A const object rather than loose strings so a client can switch on
 * it exhaustively, and so a typo is a build error rather than an error nobody handles.
 *
 * `not_computed` and `unreadable` are ERRORS ONLY WHEN THE WHOLE REQUEST FAILS. When one dimension
 * out of twelve could not be computed, that is a successful response containing a result whose
 * scoreOrLevel is `not_computed` — see types.ts. Collapsing the two would throw away eleven good
 * answers because of one bad one.
 */
export const API_ERROR_CODES = {
  UNAUTHENTICATED: 'unauthenticated',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  INVALID_REQUEST: 'invalid_request',
  SUBJECT_UNRESOLVED: 'subject_unresolved',
  CONSENT_REQUIRED: 'consent_required',
  PURPOSE_REQUIRED: 'purpose_required',
  ACCESS_LOG_FAILED: 'access_log_failed',
  UNREADABLE: 'unreadable',
  RATE_LIMITED: 'rate_limited',
  UPSTREAM_UNAVAILABLE: 'upstream_unavailable',
  INTERNAL: 'internal',
} as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];

export interface ApiError {
  code: ApiErrorCode;
  /** For a human reading a screen. Must never contain a database statement or a stack trace. */
  message: string;
  /** The request field at fault, for invalid_request. */
  field?: string | null;
  /** True when the same request may succeed later without any change. */
  retryable: boolean;
}

/**
 * The HTTP status for an error code.
 *
 * `access_log_failed` is 503 and NOT 500, deliberately. The read was refused because the system
 * could not record that it happened — the service is degraded, the request is valid, and a retry is
 * the right response. This is src/lib/legal-hold.ts's rule generalised: logAccess() must SUCCEED
 * before anything renders, so a failure to log is a failure to serve.
 */
export function httpStatusFor(code: ApiErrorCode): number {
  switch (code) {
    case API_ERROR_CODES.UNAUTHENTICATED: return 401;
    case API_ERROR_CODES.FORBIDDEN: return 403;
    case API_ERROR_CODES.NOT_FOUND: return 404;
    case API_ERROR_CODES.INVALID_REQUEST: return 400;
    case API_ERROR_CODES.SUBJECT_UNRESOLVED: return 404;
    case API_ERROR_CODES.CONSENT_REQUIRED: return 403;
    case API_ERROR_CODES.PURPOSE_REQUIRED: return 400;
    case API_ERROR_CODES.ACCESS_LOG_FAILED: return 503;
    case API_ERROR_CODES.UNREADABLE: return 503;
    case API_ERROR_CODES.RATE_LIMITED: return 429;
    case API_ERROR_CODES.UPSTREAM_UNAVAILABLE: return 503;
    case API_ERROR_CODES.INTERNAL: return 500;
    default: return 500;
  }
}

export function isRetryable(code: ApiErrorCode): boolean {
  return code === API_ERROR_CODES.ACCESS_LOG_FAILED
    || code === API_ERROR_CODES.UNREADABLE
    || code === API_ERROR_CODES.RATE_LIMITED
    || code === API_ERROR_CODES.UPSTREAM_UNAVAILABLE;
}

// -------------------------------------------------------------------------------------------------
// REDACTION VOCABULARY
// -------------------------------------------------------------------------------------------------

export interface WithheldField {
  /** Dotted path into the response body. e.g. 'results[3].sourceBreakdown'. */
  path: string;
  /** Why, in words a reader may see. Never names the value, never names the rule's internals. */
  reason: string;
  /** The audience that WOULD be able to see it, so a reader knows who to ask. May be null. */
  availableTo?: string | null;
}

// -------------------------------------------------------------------------------------------------
// THE ENVELOPE
// -------------------------------------------------------------------------------------------------

export interface ResponseMeta {
  /** Correlates this response with its access-log rows and its server logs. */
  requestId: string;
  generatedAt: string;
  contractVersion: typeof HORIZON_API_VERSION;
  organisationId: OrganisationId;
  /** Who the response was shaped for. The same data shaped for two audiences is two responses. */
  audience: string;
  /** Who it is about, when the endpoint is about a person. */
  subject?: SubjectRef | null;
  /** Fields the reader may know exist but may not see. Empty array, never absent. */
  withheld: readonly WithheldField[];
  /**
   * True when the access log row for this read was written. A response that reached a reader without
   * a log row is a compliance defect, and it must be visible in the response rather than only in a
   * server log nobody reads.
   */
  accessLogged: boolean;
  /** Present when part of the answer could not be read. Never silently omitted. */
  degraded?: readonly string[];
}

export type ApiResponse<T> =
  | { ok: true; data: T; meta: ResponseMeta }
  | { ok: false; error: ApiError; meta: ResponseMeta };

export interface PageInfo {
  /** Opaque. Pass it back verbatim; never construct or parse one. */
  nextCursor: string | null;
  pageSize: number;
  /**
   * DELIBERATELY ABSENT: a total count.
   *
   * `COUNT(*) OVER ()` beside a LIMIT makes the database compute the whole result set to answer a
   * number nobody acts on, and it is already recorded in this repository as an index-defeating
   * pattern. An endpoint that genuinely needs a total asks for one explicitly.
   */
  hasMore: boolean;
}

export interface Page<T> {
  items: readonly T[];
  page: PageInfo;
}

// -------------------------------------------------------------------------------------------------
// CONSTRUCTORS
// -------------------------------------------------------------------------------------------------

export interface MetaInput {
  requestId: string;
  organisationId: OrganisationId;
  audience: string;
  subject?: SubjectRef | null;
  withheld?: readonly WithheldField[];
  accessLogged?: boolean;
  degraded?: readonly string[];
  generatedAt?: string;
}

export function responseMeta(input: MetaInput): ResponseMeta {
  return {
    requestId: input.requestId,
    generatedAt: input.generatedAt || new Date().toISOString(),
    contractVersion: HORIZON_API_VERSION,
    organisationId: input.organisationId,
    audience: input.audience,
    subject: input.subject ?? null,
    withheld: input.withheld ?? [],
    // DEFAULTS TO FALSE. A caller that forgot to log has not logged, and the response says so
    // rather than claiming a control that did not run.
    accessLogged: input.accessLogged === true,
    degraded: input.degraded,
  };
}

export function apiOk<T>(data: T, meta: MetaInput): ApiResponse<T> {
  return { ok: true, data, meta: responseMeta(meta) };
}

export function apiErr<T = never>(
  code: ApiErrorCode,
  message: string,
  meta: MetaInput,
  field?: string | null,
): ApiResponse<T> {
  return {
    ok: false,
    error: { code, message, field: field ?? null, retryable: isRetryable(code) },
    meta: responseMeta(meta),
  };
}

/**
 * Turn a caught exception into a response WITHOUT leaking what it was.
 *
 * The real Postgres reason lives on `e.cause` and it is exactly the thing that must reach the server
 * log and must NOT reach the client: it contains table names, column names and sometimes values. So
 * the reason is returned separately for the caller to log, and the client gets a sentence.
 */
export function apiErrFromException<T = never>(
  e: any,
  meta: MetaInput,
): { response: ApiResponse<T>; logReason: string } {
  const logReason = String(e?.cause?.message || e?.message || e || 'unknown error');
  return {
    response: apiErr<T>(
      API_ERROR_CODES.INTERNAL,
      'This could not be read right now. Nothing has been changed.',
      meta,
    ),
    logReason,
  };
}

export function clampPageSize(requested: unknown): number {
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return PAGE_DEFAULT_SIZE;
  return Math.min(PAGE_MAX_SIZE, Math.floor(n));
}

/**
 * Build a page from one extra row.
 *
 * The convention every HORIZON endpoint uses: SELECT pageSize + 1, and if the extra row came back
 * there is more. One row of overfetch instead of a second COUNT query over the whole table.
 */
export function pageFrom<T>(
  rows: readonly T[],
  pageSize: number,
  cursorOf: (row: T) => string,
): Page<T> {
  const hasMore = rows.length > pageSize;
  const items = hasMore ? rows.slice(0, pageSize) : rows.slice();
  const last = items.length ? items[items.length - 1] : null;
  return {
    items,
    page: { pageSize, hasMore, nextCursor: hasMore && last ? cursorOf(last) : null },
  };
}
