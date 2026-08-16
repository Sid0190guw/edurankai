// src/lib/live-egress.ts — PUTTING A CLASS ON AN EXTERNAL STREAMING PLATFORM, FROM OUR OWN ADMIN.
//
// WHAT THIS IS
//
// A swappable provider interface with one adapter behind it, in the shape src/lib/storage.ts
// already established: a getter that reports whether the thing is configured, a typed refusal when
// it is not, and callers that never learn which vendor is on the other end. That shape is not
// decoration — the Sovereignty Constitution for this project says proprietary services are optional
// connectors behind interfaces we own, and this is what that means in code.
//
// WHAT IT CANNOT DO, STATED FIRST SO NOBODY BUILDS ON A MISREADING
//
// It does not move video. Not one byte of the class passes through this module or through this
// platform. A browser cannot speak RTMP — RTMP opens with a raw TCP handshake and a web page has no
// raw socket — and the platform this adapter talks to accepts exactly `dash`, `hls` and `rtmp` as
// ingestion types. There is no WebRTC ingest to push to. So the video goes from the teacher's own
// encoder straight to the platform, and what we do here is the CONTROL plane: schedule the event,
// hand the teacher the address and key their encoder needs, know when it is live, and show it in
// the right place to the right people.
//
// THE MODEL: PLATFORM-OWNED CHANNEL NOW, PER-TEACHER LATER
//
// Every call takes a `LiveCredentials` rather than reading the environment itself. Today
// platformCredentials() returns the one channel the platform owns, from environment secrets. When
// per-teacher channels are wanted, a second resolver returns that teacher's stored token and
// nothing else in this file changes. That is the whole reason credentials are a parameter and not
// a module-level constant.
//
// THE FAILURE NOBODY SEES COMING
//
// A refresh token issued while the OAuth consent screen is still in "Testing" expires in seven
// days, silently. It also dies after six months unused. When it dies, every call here returns
// `invalid_grant` and a class simply does not start. `refusalOf()` names that case specifically
// instead of reporting it as a generic failure, because the fix — republish the consent screen and
// re-consent — is nothing like the fix for any other error.

export type LiveEgressErrorKind =
  | 'not_configured'      // no credentials in this deployment
  | 'auth_expired'        // the stored consent died; a human must re-consent
  | 'not_permitted'       // the channel is not allowed to stream right now
  | 'quota'               // the daily API allocation is exhausted
  | 'stream_inactive'     // asked to go live before the encoder started pushing
  | 'upstream'            // the platform said no, for some other reason
  | 'bad_input';

export interface LiveEgressRefusal {
  ok: false;
  kind: LiveEgressErrorKind;
  /** A complete sentence for a person. Brand-free — it never names the platform. */
  reason: string;
  /**
   * True when the request failed only because the outcome had already happened. Callers treat that
   * as success. It is a FIELD rather than something read out of `reason`, because `reason` is copy
   * shown to a person: rewording it — which somebody will, it is a sentence — would silently turn
   * "already ended" back into a failure a teacher sees.
   */
  alreadyThere?: boolean;
  /** What the platform actually said, for the log. Never rendered. */
  detail?: string;
}

export interface LiveEvent {
  ok: true;
  eventId: string;          // also the id the player embeds
  title: string;
  scheduledStartIso: string | null;
  lifecycle: string;        // created | ready | testing | live | complete | revoked
  privacy: string;
}

export interface LiveIngest {
  ok: true;
  streamId: string;
  /** The full address a teacher pastes into their encoder. Secret: host-only, never stored. */
  ingestUrl: string;
  /** The key alone, shown separately because most encoders ask for the two parts apart. */
  streamKey: string;
  serverUrl: string;
  /** Whether the platform is currently receiving video on this stream. */
  receiving: boolean;
  health: string;
}

export interface LiveState {
  ok: true;
  lifecycle: string;
  live: boolean;
  /** Absent when hidden or zero — and absent is NOT zero. Never present this as attendance. */
  concurrentViewers: number | null;
  actualStartIso: string | null;
  actualEndIso: string | null;
}

export type LiveEgressResult<T> = T | LiveEgressRefusal;

export interface LiveCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Which channel this consent belongs to. Informational; the token decides. */
  label: string;
}

// ================================================================================================
// CONFIGURATION
// ================================================================================================

/**
 * The one channel this deployment owns, from environment secrets. Returns null when any part is
 * missing — a half-configured connector must read as "not configured", never as a broken one.
 */
export function platformCredentials(): LiveCredentials | null {
  const clientId = process.env.LIVE_EGRESS_CLIENT_ID || '';
  const clientSecret = process.env.LIVE_EGRESS_CLIENT_SECRET || '';
  const refreshToken = process.env.LIVE_EGRESS_REFRESH_TOKEN || '';
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, clientSecret, refreshToken, label: process.env.LIVE_EGRESS_CHANNEL_LABEL || 'platform channel' };
}

export function liveEgressConfigured(): boolean {
  return !!platformCredentials();
}

/** Reported on the admin screen so "nothing happened" is never mistaken for "it is broken". */
export function liveEgressStatus(): { available: boolean; reason: string } {
  if (liveEgressConfigured()) {
    return { available: true, reason: 'A streaming channel is connected to this deployment.' };
  }
  return {
    available: false,
    reason: 'No streaming channel is connected. Set LIVE_EGRESS_CLIENT_ID, LIVE_EGRESS_CLIENT_SECRET and LIVE_EGRESS_REFRESH_TOKEN, and make sure the consent screen was published before the refresh token was issued — a token minted while consent is still in testing stops working after seven days.',
  };
}

const NOT_CONFIGURED: LiveEgressRefusal = {
  ok: false,
  kind: 'not_configured',
  reason: 'No streaming channel is connected to this deployment, so a live event cannot be created.',
};

// ================================================================================================
// PURE HELPERS — tested without a network
// ================================================================================================

/**
 * Turn an upstream error into a refusal that names the ACTIONABLE case.
 *
 * The distinctions here are the whole value of the function: a dead consent, a channel that is not
 * allowed to stream, an exhausted daily allocation and "you pressed go-live before the encoder
 * connected" have four different fixes, and collapsing them into "something went wrong" makes every
 * one of them a support ticket. Pure.
 */
export function refusalOf(status: number, body: any): LiveEgressRefusal {
  const raw = typeof body === 'string' ? body : JSON.stringify(body || {});
  const errs: string[] = [];
  try {
    const e = typeof body === 'string' ? JSON.parse(body) : body;
    const list = e?.error?.errors || [];
    for (const it of list) if (it?.reason) errs.push(String(it.reason));
    if (e?.error === 'invalid_grant' || e?.error?.status) errs.push(String(e.error === 'invalid_grant' ? 'invalid_grant' : e.error.status));
  } catch { /* the reason list is a bonus; status still classifies */ }
  const has = (r: string) => errs.some((x) => x.toLowerCase().includes(r));

  if (has('invalid_grant') || (status === 400 && /invalid_grant/.test(raw))) {
    return {
      ok: false, kind: 'auth_expired', detail: raw,
      reason: 'The connection to the streaming channel has expired and has to be authorised again by the account that owns it. This happens on its own if the consent was never published out of testing.',
    };
  }
  if (status === 401) {
    return { ok: false, kind: 'auth_expired', detail: raw, reason: 'The streaming channel rejected our credentials. It has to be connected again.' };
  }
  if (has('livepermissionblocked') || has('liveStreamingNotEnabled'.toLowerCase())) {
    return { ok: false, kind: 'not_permitted', detail: raw, reason: 'The channel is not currently allowed to stream live. Check that live streaming is enabled on it and that there is no active restriction.' };
  }
  if (has('quotaexceeded') || has('ratelimitexceeded') || status === 429) {
    return { ok: false, kind: 'quota', detail: raw, reason: 'The daily allowance for talking to the streaming service is used up. It resets on its own; scheduling will work again after that.' };
  }
  if (has('errorstreaminactive')) {
    return { ok: false, kind: 'stream_inactive', detail: raw, reason: 'The class cannot go live yet because the streaming software has not started sending video. Start the encoder first, then try again.' };
  }
  if (has('redundanttransition')) {
    // Not a failure: it is already where we asked it to go. Callers treat this as success, and they
    // find that out from `alreadyThere`, NOT by reading the sentence — see isAlreadyThere().
    return { ok: false, kind: 'upstream', alreadyThere: true, detail: raw, reason: 'The class was already in that state.' };
  }
  if (status === 403) {
    return { ok: false, kind: 'not_permitted', detail: raw, reason: 'The streaming service refused this action for the connected channel.' };
  }
  return { ok: false, kind: 'upstream', detail: raw, reason: 'The streaming service could not complete that request.' };
}

/** True when a refusal means "already done", which callers should treat as success. Pure. */
export function isAlreadyThere(r: LiveEgressRefusal): boolean {
  return r.alreadyThere === true;
}

/**
 * The encoder address, assembled from the two halves the platform returns separately.
 * Prefers the TLS form, because a stream key travelling in clear text is a stream key anybody on
 * the path can take. Pure.
 */
export function encoderAddress(ingestion: { ingestionAddress?: string; rtmpsIngestionAddress?: string; streamName?: string }): { serverUrl: string; streamKey: string; ingestUrl: string } {
  const server = String(ingestion.rtmpsIngestionAddress || ingestion.ingestionAddress || '').replace(/\/+$/, '');
  const key = String(ingestion.streamName || '');
  return { serverUrl: server, streamKey: key, ingestUrl: server && key ? server + '/' + key : '' };
}

/** Whether a broadcast lifecycle string means "people can watch right now". Pure. */
export function isLive(lifecycle: string): boolean {
  return String(lifecycle || '').toLowerCase() === 'live';
}

/** Whether the state is one the platform sets mid-transition and a poller must wait through. Pure. */
export function isTransitioning(lifecycle: string): boolean {
  const s = String(lifecycle || '').toLowerCase();
  return s === 'teststarting' || s === 'livestarting';
}

/**
 * The settings a class broadcast is created with, in one place.
 *
 * `unlisted` rather than `private` is a decision with a reason: a private broadcast genuinely
 * cannot be embedded, so students would be sent off-platform to sign in, and `enableEmbed` is
 * meaningless without it. Unlisted is a secret address, NOT access control — our own page enforces
 * enrolment and nothing about this object does. Never describe it to anyone as private. Pure.
 */
export function classBroadcastBody(title: string, startIso: string, description = ''): any {
  return {
    snippet: { title: String(title || 'Live class').slice(0, 100), scheduledStartTime: startIso, description: String(description || '').slice(0, 5000) },
    status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: false },
    contentDetails: {
      enableAutoStart: true,     // goes live when the encoder connects — no transition call needed
      enableAutoStop: true,      // ends about a minute after the encoder stops
      recordFromStart: true,
      enableEmbed: true,
      enableDvr: true,
      latencyPreference: 'low',
      monitorStream: { enableMonitorStream: false },
    },
  };
}

// ================================================================================================
// THE ADAPTER
// ================================================================================================

const API = 'https://www.googleapis.com/youtube/v3';

/** Exchange the long-lived consent for a short-lived access token. Never cached to disk. */
async function accessToken(cred: LiveCredentials): Promise<{ token: string } | LiveEgressRefusal> {
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cred.clientId, client_secret: cred.clientSecret,
        refresh_token: cred.refreshToken, grant_type: 'refresh_token',
      }).toString(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body?.access_token) {
      const refusal = refusalOf(res.status, body);
      console.error('[live-egress] token exchange failed:', refusal.kind, refusal.detail);
      return refusal;
    }
    return { token: String(body.access_token) };
  } catch (e: any) {
    console.error('[live-egress] token exchange:', e?.message);
    return { ok: false, kind: 'upstream', reason: 'The streaming service could not be reached.', detail: e?.message };
  }
}

async function call(cred: LiveCredentials, method: string, path: string, body?: any): Promise<any | LiveEgressRefusal> {
  const tok = await accessToken(cred);
  if ((tok as LiveEgressRefusal).ok === false) return tok as LiveEgressRefusal;
  try {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + (tok as { token: string }).token,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const refusal = refusalOf(res.status, json);
      console.error('[live-egress] ' + method + ' ' + path.split('?')[0] + ':', refusal.kind, refusal.detail);
      return refusal;
    }
    return json;
  } catch (e: any) {
    console.error('[live-egress] ' + method + ' ' + path.split('?')[0] + ':', e?.message);
    return { ok: false, kind: 'upstream', reason: 'The streaming service could not be reached.', detail: e?.message };
  }
}

function isRefusal(v: any): v is LiveEgressRefusal {
  return v && v.ok === false && typeof v.kind === 'string';
}

/**
 * The reusable ingest stream — created once and re-bound to every class.
 *
 * `isReusable: true` is what makes one address and one key serve a whole term, so a teacher pastes
 * them into their encoder once rather than before every lesson.
 *
 * THE KEY IS NEVER STORED. It is fetched here, shown once, and forgotten. A stream key in our
 * database is a credential we did not need to hold and would have to protect.
 */
export async function ensureIngest(cred: LiveCredentials | null, streamId?: string | null): Promise<LiveEgressResult<LiveIngest>> {
  if (!cred) return NOT_CONFIGURED;

  if (streamId) {
    // part=cdn is not optional. Without it the response is a valid-looking stream with NO ingestion
    // information at all, which reads as "the platform gave us no key" and is really "we did not ask".
    const got = await call(cred, 'GET', '/liveStreams?part=snippet,cdn,status&id=' + encodeURIComponent(streamId));
    if (isRefusal(got)) return got;
    const item = got?.items?.[0];
    if (item) return ingestFrom(item);
  }

  const made = await call(cred, 'POST', '/liveStreams?part=snippet,cdn,contentDetails,status', {
    snippet: { title: 'AquinTutor class encoder' },
    cdn: { ingestionType: 'rtmp', resolution: 'variable', frameRate: 'variable' },
    contentDetails: { isReusable: true },
  });
  if (isRefusal(made)) return made;
  return ingestFrom(made);
}

function ingestFrom(item: any): LiveEgressResult<LiveIngest> {
  const info = item?.cdn?.ingestionInfo || {};
  const addr = encoderAddress(info);
  if (!addr.ingestUrl) {
    return { ok: false, kind: 'upstream', reason: 'The streaming service did not return an address for the encoder.', detail: JSON.stringify(item?.cdn || {}) };
  }
  const status = item?.status || {};
  return {
    ok: true,
    streamId: String(item.id),
    ingestUrl: addr.ingestUrl,
    streamKey: addr.streamKey,
    serverUrl: addr.serverUrl,
    receiving: String(status.streamStatus || '') === 'active',
    health: String(status.healthStatus?.status || 'unknown'),
  };
}

/** Create the event for one class. Its id is also the id the player embeds. */
export async function createEvent(cred: LiveCredentials | null, title: string, startIso: string, description = ''): Promise<LiveEgressResult<LiveEvent>> {
  if (!cred) return NOT_CONFIGURED;
  if (!title || !startIso) return { ok: false, kind: 'bad_input', reason: 'A live class needs a title and a start time.' };
  const d = new Date(startIso);
  if (isNaN(d.getTime())) return { ok: false, kind: 'bad_input', reason: 'That start time could not be read.' };

  const made = await call(cred, 'POST', '/liveBroadcasts?part=snippet,contentDetails,status', classBroadcastBody(title, d.toISOString(), description));
  if (isRefusal(made)) return made;
  return {
    ok: true,
    eventId: String(made.id),
    title: String(made?.snippet?.title || title),
    scheduledStartIso: made?.snippet?.scheduledStartTime || d.toISOString(),
    lifecycle: String(made?.status?.lifeCycleStatus || 'created'),
    privacy: String(made?.status?.privacyStatus || 'unlisted'),
  };
}

/** Attach the encoder stream to the event. Without this the event stays in `created` forever. */
export async function bind(cred: LiveCredentials | null, eventId: string, streamId: string): Promise<LiveEgressResult<{ ok: true; lifecycle: string }>> {
  if (!cred) return NOT_CONFIGURED;
  if (!eventId || !streamId) return { ok: false, kind: 'bad_input', reason: 'Both the class and the encoder stream are needed to connect them.' };
  const done = await call(cred, 'POST', '/liveBroadcasts/bind?part=id,contentDetails,status&id=' + encodeURIComponent(eventId) + '&streamId=' + encodeURIComponent(streamId));
  if (isRefusal(done)) return done;
  return { ok: true, lifecycle: String(done?.status?.lifeCycleStatus || 'ready') };
}

/** Where the event is now. This is what the poller writes into our own table. */
export async function state(cred: LiveCredentials | null, eventId: string): Promise<LiveEgressResult<LiveState>> {
  if (!cred) return NOT_CONFIGURED;
  const got = await call(cred, 'GET', '/liveBroadcasts?part=status,snippet,liveStreamingDetails&id=' + encodeURIComponent(eventId));
  if (isRefusal(got)) return got;
  const item = got?.items?.[0];
  if (!item) return { ok: false, kind: 'upstream', reason: 'That live class no longer exists on the streaming service.' };
  const lifecycle = String(item?.status?.lifeCycleStatus || 'created');
  const details = item?.liveStreamingDetails || {};
  // concurrentViewers is ABSENT when hidden or zero, and stops being reported the moment the
  // broadcast ends. Absent is not zero, and neither is an attendance record.
  const viewers = details.concurrentViewers != null ? Number(details.concurrentViewers) : null;
  return {
    ok: true,
    lifecycle,
    live: isLive(lifecycle),
    concurrentViewers: Number.isFinite(viewers as number) ? viewers : null,
    actualStartIso: details.actualStartTime || null,
    actualEndIso: details.actualEndTime || null,
  };
}

/** End the class. With auto-stop on, this is the manual override, not the normal path. */
export async function end(cred: LiveCredentials | null, eventId: string): Promise<LiveEgressResult<{ ok: true; lifecycle: string }>> {
  if (!cred) return NOT_CONFIGURED;
  const done = await call(cred, 'POST', '/liveBroadcasts/transition?part=id,status&broadcastStatus=complete&id=' + encodeURIComponent(eventId));
  if (isRefusal(done)) {
    // "already complete" is the outcome we wanted, not a failure to report to a teacher.
    if (isAlreadyThere(done)) return { ok: true, lifecycle: 'complete' };
    return done;
  }
  return { ok: true, lifecycle: String(done?.status?.lifeCycleStatus || 'complete') };
}
