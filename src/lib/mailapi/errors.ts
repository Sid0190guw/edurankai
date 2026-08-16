// src/lib/mailapi/errors.ts — one error shape for the whole transactional API.
//
// THE SHAPE IS PART OF THE CONTRACT, NOT DECORATION. An SDK cannot branch on prose. Every failure
// here carries a stable machine `code`, a human `message`, an optional `param` naming the field that
// caused it, and the `request_id` that appears in our logs — which is the only way a developer can
// ask us about a specific failed call without quoting the recipient's address to us.
//
// NOTHING INTERNAL LEAVES. src/lib/http-guard.ts already decided the house rule for this: SQL,
// stack frames, connection strings and driver text never reach a caller. sanitizeError() from that
// module is reused rather than re-implemented, so there is one definition of "safe to return".
import { sanitizeError, secureHeaders } from '@/lib/http-guard';

/**
 * Stable error codes. Adding one is additive; changing the meaning of one is a breaking change,
 * because an integration will have written `if (err.code === 'template_not_found')`.
 */
export type ErrorCode =
  | 'invalid_request'
  | 'invalid_json'
  | 'payload_too_large'
  | 'missing_api_key'
  | 'invalid_api_key'
  | 'expired_api_key'
  | 'revoked_api_key'
  | 'insufficient_scope'
  | 'environment_mismatch'
  | 'organization_inactive'
  | 'not_found'
  | 'template_not_found'
  | 'template_not_published'
  | 'template_variable_missing'
  | 'message_not_found'
  | 'webhook_not_found'
  | 'idempotency_key_reused'
  | 'idempotency_in_progress'
  | 'all_recipients_suppressed'
  | 'attachment_not_a_link'
  | 'no_transport'
  | 'rate_limit_exceeded'
  | 'method_not_allowed'
  | 'internal_error';

const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  invalid_json: 400,
  payload_too_large: 413,
  missing_api_key: 401,
  invalid_api_key: 401,
  expired_api_key: 401,
  revoked_api_key: 401,
  insufficient_scope: 403,
  environment_mismatch: 403,
  organization_inactive: 403,
  not_found: 404,
  template_not_found: 404,
  template_not_published: 422,
  template_variable_missing: 422,
  message_not_found: 404,
  webhook_not_found: 404,
  idempotency_key_reused: 409,
  idempotency_in_progress: 409,
  all_recipients_suppressed: 422,
  attachment_not_a_link: 422,
  no_transport: 503,
  rate_limit_exceeded: 429,
  method_not_allowed: 405,
  internal_error: 500,
};

/** The HTTP status a code maps to. Pure — the tests assert the whole table. */
export function statusFor(code: ErrorCode): number {
  return STATUS[code] || 500;
}

export interface ApiErrorBody {
  error: { type: ErrorCode; message: string; param?: string; doc_url: string; request_id: string };
}

export class ApiError extends Error {
  code: ErrorCode;
  param?: string;
  /** Extra fields merged into the response body (e.g. the conflicting message_id). */
  extra?: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, opts: { param?: string; extra?: Record<string, unknown> } = {}) {
    super(message);
    this.code = code;
    this.param = opts.param;
    this.extra = opts.extra;
  }
}

const DOCS = 'https://www.edurankai.in/developers/mail';

/** CORS for the developer API. Kept narrow: these are server-to-server calls with a secret key. */
export const API_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, Idempotency-Key',
  'Access-Control-Expose-Headers': 'RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After, X-Request-Id, Idempotent-Replayed',
  'Access-Control-Max-Age': '86400',
};

/**
 * A request id for correlation. Generated per request, echoed in the X-Request-Id header, returned
 * inside every error body and written to the log line for the same request.
 */
export function newRequestId(): string {
  // Not a uuid on purpose — it is meant to be typed into a support message.
  const r = Math.random().toString(36).slice(2, 10);
  const t = Date.now().toString(36);
  return 'req_' + t + r;
}

export function apiJson(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...secureHeaders(), ...API_CORS, ...headers },
  });
}

export function apiError(
  code: ErrorCode,
  message: string,
  opts: { param?: string; requestId?: string; headers?: Record<string, string>; extra?: Record<string, unknown> } = {},
): Response {
  const body: ApiErrorBody & Record<string, unknown> = {
    error: {
      type: code,
      message,
      ...(opts.param ? { param: opts.param } : {}),
      doc_url: DOCS,
      request_id: opts.requestId || newRequestId(),
    },
    ...(opts.extra || {}),
  };
  return apiJson(body, statusFor(code), opts.headers);
}

/**
 * Turn anything thrown inside a handler into a response.
 *
 * An ApiError is intentional and its message is written for the caller, so it passes through. Any
 * other throw is a bug or a database fault: the real reason is logged with the request id (so it can
 * be found), and the caller gets a generic 500. This is the rule from http-guard.ts, applied at the
 * one place every route funnels through, rather than re-decided per endpoint.
 */
export function handleApiError(e: unknown, requestId: string, route: string): Response {
  if (e instanceof ApiError) {
    return apiError(e.code, e.message, { param: e.param, requestId, extra: e.extra });
  }
  const reason = String((e as any)?.cause?.message || (e as any)?.message || e);
  console.error('[mailapi] ' + route + ' ' + requestId + ' failed:', reason);
  return apiError('internal_error', sanitizeError(e), { requestId });
}

/** 204 for a CORS preflight. */
export function preflight(): Response {
  return new Response(null, { status: 204, headers: API_CORS });
}

/**
 * Read and parse a JSON body with a hard size ceiling.
 *
 * The ceiling is checked against the ACTUAL bytes read, not the Content-Length header — a header is
 * a claim, and a client that lies about it would otherwise stream an unbounded body into memory.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<any> {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared && declared > maxBytes) {
    throw new ApiError('payload_too_large', 'Request body is larger than the ' + Math.floor(maxBytes / 1024) + ' KB limit.');
  }
  let raw: string;
  try {
    raw = await request.text();
  } catch (_) {
    throw new ApiError('invalid_request', 'Request body could not be read.');
  }
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
    throw new ApiError('payload_too_large', 'Request body is larger than the ' + Math.floor(maxBytes / 1024) + ' KB limit.');
  }
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (e: any) {
    throw new ApiError('invalid_json', 'Request body is not valid JSON: ' + String(e?.message || 'parse error').slice(0, 120));
  }
}
