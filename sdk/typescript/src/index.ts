/**
 * @edurankai/mail — the official TypeScript client for the EduRankAI Mail transactional API.
 *
 * ZERO DEPENDENCIES, ON PURPOSE. It uses `fetch` and `node:crypto`, both of which are in every
 * runtime this could plausibly run on. An SDK that drags a dependency tree into a customer's service
 * is an SDK that eventually breaks their build for a reason that has nothing to do with email.
 *
 * The webhook verifier at the bottom is the most important thing in this file. It is a byte-for-byte
 * counterpart of the signer in src/lib/mailapi/webhooks.ts, and the same assertions cover both — a
 * verifier that differs from its signer by one character is the single most common webhook
 * integration failure, and it fails in the direction of accepting forged events.
 */

export const SDK_VERSION = '1.0.0';
export const PAYLOAD_VERSION = '2026-08-16';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Environment = 'development' | 'staging' | 'production';

export type MessageStatus =
  | 'queued' | 'processing' | 'sent' | 'delivered' | 'deferred' | 'bounced' | 'failed' | 'cancelled';

export type EventType =
  | 'email.queued' | 'email.sent' | 'email.delivered' | 'email.deferred' | 'email.bounced'
  | 'email.failed' | 'email.opened' | 'email.clicked' | 'email.unsubscribed' | 'email.complained';

/** Attachments are LINKS. The API refuses base64 content — see the platform rule in the docs. */
export interface LinkAttachment {
  url: string;
  filename?: string;
}

export interface SendOptions {
  /** Use an unpublished template version in production. Recorded on the message and its event. */
  allow_draft?: boolean;
  track_opens?: boolean;
  track_clicks?: boolean;
  include_unsubscribe?: boolean;
  /** Retries an address that hard bounced. Cannot override an unsubscribe or a complaint. */
  skip_suppression?: boolean;
}

export interface SendRequest {
  from?: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  reply_to?: string;
  subject?: string;
  text?: string;
  html?: string;
  template_id?: string;
  template_version?: number;
  variables?: Record<string, unknown>;
  attachments?: LinkAttachment[];
  metadata?: Record<string, unknown>;
  tags?: string[];
  headers?: Record<string, string>;
  idempotency_key?: string;
  scheduled_at?: string;
  options?: SendOptions;
}

export interface Message {
  id: string;
  object: 'message' | 'message_status';
  status: MessageStatus;
  environment: Environment;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  template?: { key: string; version: number | null; state?: string };
  tags?: string[];
  metadata?: Record<string, unknown>;
  scheduled_at?: string;
  attempts: number;
  last_error?: string;
  queued_at: string;
  sent_at?: string;
  delivered_at?: string;
  failed_at?: string;
  created_at: string;
  /** Present when the platform has something to tell you: a rewritten From, a skipped recipient. */
  warnings?: string[];
  events?: MessageEvent[];
}

export interface MessageEvent {
  id: string;
  type: EventType;
  recipient: string | null;
  occurred_at: string;
  data: Record<string, unknown>;
}

export interface Template {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  environment: Environment;
  archived?: boolean;
  published_version: number | null;
  latest_version: number | null;
  versions?: TemplateVersion[];
}

export interface TemplateVersion {
  version: number;
  state: 'draft' | 'published' | 'archived';
  subject: string;
  html?: string;
  text?: string | null;
  variables: string[];
  published_at?: string | null;
  created_at: string;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  description?: string | null;
  events: string[];
  status: 'pending_verification' | 'active' | 'disabled' | 'dead';
  /** Present only in the create and rotate responses. Store it then; it is never retrievable. */
  secret?: string;
}

export interface EventEnvelope<T = Record<string, unknown>> {
  id: string;
  type: EventType;
  api_version: string;
  created_at: string;
  environment: Environment;
  organization: string;
  data: T;
}

export interface RateLimit {
  limit: number;
  remaining: number;
  resetSeconds: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class EduRankAIMailError extends Error {
  readonly status: number;
  readonly code: string;
  readonly param?: string;
  readonly requestId?: string;
  readonly body: any;
  readonly rateLimit?: RateLimit;

  constructor(status: number, body: any, rateLimit?: RateLimit) {
    const err = body?.error || {};
    super(err.message || 'EduRankAI Mail request failed with status ' + status);
    this.name = 'EduRankAIMailError';
    this.status = status;
    this.code = err.type || 'unknown_error';
    this.param = err.param;
    this.requestId = err.request_id;
    this.body = body;
    this.rateLimit = rateLimit;
  }

  /** True when waiting and trying the identical request again is the right response. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500 || this.code === 'idempotency_in_progress';
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
  /**
   * Automatic retries for 429 and 5xx. Default 2.
   *
   * A retried send reuses the SAME Idempotency-Key, so a retry after a timeout can never produce a
   * second message. If you do not pass a key, sendEmail() generates one — which is why retrying is
   * safe to have on by default.
   */
  maxRetries?: number;
  fetch?: typeof fetch;
}

function randomKey(): string {
  const g: any = globalThis as any;
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

export class EduRankAIMail {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  /** The rate-limit state seen on the most recent response. Useful for pacing a bulk loop. */
  lastRateLimit: RateLimit | null = null;

  constructor(options: ClientOptions | string) {
    const o: ClientOptions = typeof options === 'string' ? { apiKey: options } : options;
    if (!o.apiKey) throw new Error('An API key is required. Create one at /admin/mail/api.');
    this.apiKey = o.apiKey;
    this.baseUrl = (o.baseUrl || 'https://www.edurankai.in').replace(/\/$/, '');
    this.timeoutMs = o.timeoutMs ?? 30_000;
    this.maxRetries = o.maxRetries ?? 2;
    this.fetchImpl = o.fetch || globalThis.fetch;
    if (!this.fetchImpl) throw new Error('No fetch implementation available. Pass one via options.fetch.');
  }

  /** The environment this key belongs to, read from the key itself. No network call. */
  get environment(): Environment | null {
    const m = /^erm_(dev|stg|live)_/.exec(this.apiKey);
    return m ? ({ dev: 'development', stg: 'staging', live: 'production' } as const)[m[1] as 'dev' | 'stg' | 'live'] : null;
  }

  private async request<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    let lastError: EduRankAIMailError | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const waitMs = lastError?.rateLimit?.resetSeconds
          ? Math.min(30_000, lastError.rateLimit.resetSeconds * 1000)
          : Math.min(8_000, 500 * 2 ** attempt);
        await new Promise((r) => setTimeout(r, waitMs));
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(this.baseUrl + path, {
          method,
          signal: controller.signal,
          headers: {
            Authorization: 'Bearer ' + this.apiKey,
            'Content-Type': 'application/json',
            'User-Agent': 'edurankai-mail-node/' + SDK_VERSION,
            ...extraHeaders,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (e: any) {
        clearTimeout(timer);
        // A network failure or a timeout is retryable, and on the LAST attempt it is reported as
        // what it is rather than being dressed up as an API error.
        if (attempt < this.maxRetries) { lastError = null; continue; }
        throw new Error(e?.name === 'AbortError' ? 'Request timed out after ' + this.timeoutMs + 'ms' : String(e?.message || e));
      }
      clearTimeout(timer);

      const limit = Number(response.headers.get('RateLimit-Limit'));
      if (Number.isFinite(limit) && limit > 0) {
        this.lastRateLimit = {
          limit,
          remaining: Number(response.headers.get('RateLimit-Remaining')) || 0,
          resetSeconds: Number(response.headers.get('RateLimit-Reset')) || 0,
        };
      }

      const text = await response.text();
      const parsed = text ? safeParse(text) : {};

      if (response.ok) return parsed as T;

      lastError = new EduRankAIMailError(response.status, parsed, this.lastRateLimit || undefined);
      if (!lastError.isRetryable || attempt === this.maxRetries) throw lastError;
    }

    throw lastError || new Error('Request failed');
  }

  // ---- email ----

  /**
   * Send a message.
   *
   * An Idempotency-Key is generated when you do not supply one, so the automatic retries above can
   * never turn a slow network into two rejection letters.
   */
  async sendEmail(request: SendRequest): Promise<Message> {
    const key = request.idempotency_key || randomKey();
    const { idempotency_key, ...rest } = request;
    return this.request<Message>('POST', '/api/v1/email/send', rest, { 'Idempotency-Key': key });
  }

  async getMessage(id: string, opts: { includeBody?: boolean; includeBcc?: boolean } = {}): Promise<Message> {
    const q = new URLSearchParams();
    if (opts.includeBody) q.set('include_body', 'true');
    if (opts.includeBcc) q.set('include_bcc', 'true');
    return this.request<Message>('GET', '/api/v1/messages/' + encodeURIComponent(id) + (q.size ? '?' + q : ''));
  }

  async getMessageStatus(id: string): Promise<Message> {
    return this.request<Message>('GET', '/api/v1/messages/' + encodeURIComponent(id) + '/status');
  }

  /** Cancel a scheduled send. Only possible before it is handed to a mail server. */
  async cancelMessage(id: string): Promise<{ cancelled: boolean; reason?: string }> {
    return this.request('DELETE', '/api/v1/messages/' + encodeURIComponent(id));
  }

  /**
   * List messages. `metadata` is the correlation filter:
   *
   *   listMessages({ metadata: { application_id: 'app_01H8…' } })
   */
  async listMessages(query: {
    status?: MessageStatus; tag?: string; recipient?: string;
    metadata?: Record<string, string>; before?: string; limit?: number;
  } = {}): Promise<{ data: Message[]; count: number; next_before: string | null }> {
    const q = new URLSearchParams();
    if (query.status) q.set('status', query.status);
    if (query.tag) q.set('tag', query.tag);
    if (query.recipient) q.set('recipient', query.recipient);
    if (query.before) q.set('before', query.before);
    if (query.limit) q.set('limit', String(query.limit));
    const meta = Object.entries(query.metadata || {})[0];
    if (meta) { q.set('metadata_key', meta[0]); q.set('metadata_value', meta[1]); }
    return this.request('GET', '/api/v1/messages' + (q.size ? '?' + q : ''));
  }

  async listEvents(query: { type?: EventType; messageId?: string; before?: string; limit?: number } = {}): Promise<{ data: (EventEnvelope & { message_id: string })[]; next_before: string | null }> {
    const q = new URLSearchParams();
    if (query.type) q.set('type', query.type);
    if (query.messageId) q.set('message_id', query.messageId);
    if (query.before) q.set('before', query.before);
    if (query.limit) q.set('limit', String(query.limit));
    return this.request('GET', '/api/v1/events' + (q.size ? '?' + q : ''));
  }

  // ---- templates ----

  async listTemplates(includeArchived = false): Promise<{ data: Template[] }> {
    return this.request('GET', '/api/v1/templates' + (includeArchived ? '?include_archived=true' : ''));
  }

  async getTemplate(idOrKey: string): Promise<Template> {
    return this.request('GET', '/api/v1/templates/' + encodeURIComponent(idOrKey));
  }

  async createTemplate(input: {
    key: string; name?: string; description?: string; subject: string; html: string; text?: string; publish?: boolean;
  }): Promise<Template & { variables: string[] }> {
    return this.request('POST', '/api/v1/templates', input);
  }

  /** Any content change creates a NEW draft version; an existing version is never rewritten. */
  async updateTemplate(idOrKey: string, input: {
    name?: string; description?: string; subject?: string; html?: string; text?: string; publish?: boolean;
  }): Promise<Template> {
    return this.request('PATCH', '/api/v1/templates/' + encodeURIComponent(idOrKey), input);
  }

  async publishTemplate(idOrKey: string, version?: number): Promise<Template> {
    return this.request('POST', '/api/v1/templates/' + encodeURIComponent(idOrKey) + '/publish', { version });
  }

  /** Render without sending. Returns the exact subject, html and text a send would produce. */
  async previewTemplate(idOrKey: string, variables: Record<string, unknown>, version?: number): Promise<{
    subject: string; html: string; text: string; required_variables: string[]; missing_variables: string[]; would_send: boolean;
  }> {
    return this.request('POST', '/api/v1/templates/' + encodeURIComponent(idOrKey) + '/preview', { variables, version });
  }

  /** Promote a template into another environment. */
  async copyTemplate(idOrKey: string, toEnvironment: Environment, publish = false): Promise<Template> {
    return this.request('POST', '/api/v1/templates/' + encodeURIComponent(idOrKey) + '/copy', { to_environment: toEnvironment, publish });
  }

  async archiveTemplate(idOrKey: string): Promise<{ archived: boolean }> {
    return this.request('DELETE', '/api/v1/templates/' + encodeURIComponent(idOrKey));
  }

  // ---- webhooks ----

  async listWebhooks(): Promise<{ data: WebhookEndpoint[]; available_events: EventType[] }> {
    return this.request('GET', '/api/v1/webhooks');
  }

  async createWebhook(input: { url: string; events?: EventType[]; description?: string; verify?: boolean }): Promise<WebhookEndpoint> {
    return this.request('POST', '/api/v1/webhooks', input);
  }

  async updateWebhook(id: string, input: { url?: string; events?: EventType[]; description?: string; status?: 'active' | 'disabled' }): Promise<WebhookEndpoint> {
    return this.request('PATCH', '/api/v1/webhooks/' + encodeURIComponent(id), input);
  }

  async deleteWebhook(id: string): Promise<{ deleted: boolean }> {
    return this.request('DELETE', '/api/v1/webhooks/' + encodeURIComponent(id));
  }

  async rotateWebhookSecret(id: string, overlapMinutes = 1440): Promise<{ secret: string; previous_secret_valid_until: string }> {
    return this.request('POST', '/api/v1/webhooks/' + encodeURIComponent(id) + '/rotate', { overlap_minutes: overlapMinutes });
  }

  async testWebhook(id: string): Promise<{ ok: boolean; response_status: number | null; error?: string }> {
    return this.request('POST', '/api/v1/webhooks/' + encodeURIComponent(id) + '/test');
  }

  async listWebhookDeliveries(id: string, status?: string): Promise<{ data: any[] }> {
    return this.request('GET', '/api/v1/webhooks/' + encodeURIComponent(id) + '/deliveries' + (status ? '?status=' + status : ''));
  }

  async replayWebhookDelivery(webhookId: string, deliveryId: string): Promise<{ requeued: number }> {
    return this.request('POST', '/api/v1/webhooks/' + encodeURIComponent(webhookId) + '/deliveries', { delivery_id: deliveryId });
  }

  async replayDeadWebhookDeliveries(webhookId: string): Promise<{ requeued: number; found: number }> {
    return this.request('POST', '/api/v1/webhooks/' + encodeURIComponent(webhookId) + '/deliveries', { replay_dead: true });
  }

  // ---- suppression + domains ----

  async listSuppressions(): Promise<{ data: { email: string; reason: string; created_at: string }[] }> {
    return this.request('GET', '/api/v1/suppressions');
  }

  async suppress(email: string, reason: 'bounce' | 'complaint' | 'unsubscribe' | 'manual' = 'manual', detail?: string): Promise<{ created: boolean }> {
    return this.request('POST', '/api/v1/suppressions', { email, reason, detail });
  }

  async unsuppress(email: string): Promise<{ removed: boolean }> {
    return this.request('DELETE', '/api/v1/suppressions?email=' + encodeURIComponent(email));
  }

  async listDomains(): Promise<{ data: any[] }> {
    return this.request('GET', '/api/v1/domains');
  }

  async addDomain(domain: string): Promise<any> {
    return this.request('POST', '/api/v1/domains', { domain });
  }
}

function safeParse(text: string): any {
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// ---------------------------------------------------------------------------
// Webhook verification
// ---------------------------------------------------------------------------

export interface VerifyInput {
  secret: string;
  id: string;
  timestamp: string | number;
  /** The full `Webhook-Signature` header. It may hold several signatures during a rotation. */
  signature: string;
  /** The RAW request body. Re-serialising a parsed object changes the bytes and breaks the check. */
  body: string;
  toleranceSeconds?: number;
  nowMs?: number;
}

export type VerifyResult = { ok: true } | { ok: false; reason: 'bad_timestamp' | 'stale' | 'future' | 'no_match' };

/**
 * Verify a webhook delivery.
 *
 * Signed content is `{id}.{timestamp}.{raw body}`, HMAC-SHA256, base64, prefixed `v1,`.
 *
 * A valid signature proves the delivery is ours; it does NOT prove it is new. Dedupe on the
 * `Webhook-Id` header as well — a retry of a genuine delivery reuses its id, which is what makes
 * both our retries and a dead-letter replay safe for you to receive.
 */
export function verifyWebhookSignature(input: VerifyInput): VerifyResult {
  const tolerance = input.toleranceSeconds ?? 300;
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return { ok: false, reason: 'bad_timestamp' };
  const now = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (now - ts > tolerance) return { ok: false, reason: 'stale' };
  if (ts - now > tolerance) return { ok: false, reason: 'future' };

  const expected = signWebhookPayload(input.secret, input.id, input.timestamp, input.body);
  for (const presented of String(input.signature || '').split(/\s+/).filter(Boolean)) {
    if (timingSafeEqual(presented, expected)) return { ok: true };
  }
  return { ok: false, reason: 'no_match' };
}

export function signWebhookPayload(secret: string, id: string, timestamp: string | number, body: string): string {
  // Required lazily so the client half of this SDK works in a browser or an edge runtime that has
  // no node:crypto. Verification is a server-side act by definition.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHmac } = require('node:crypto');
  return 'v1,' + createHmac('sha256', secret).update(id + '.' + timestamp + '.' + body, 'utf8').digest('base64');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default EduRankAIMail;
