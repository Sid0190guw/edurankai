// LTI 1.1 provider — lets an LMS (Canvas / Moodle / Blackboard) launch a lab as
// an external tool with a signed OAuth 1.0 request, and receive a grade back via
// LTI Basic Outcomes. Consumer key/secret pairs are managed by a super-admin.
// Hand-written OAuth 1.0 HMAC-SHA1 (no libraries).
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { createHmac, createHash, randomBytes } from 'node:crypto';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

let ready: Promise<void> | null = null;
export function ensureLtiSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS lti_consumers (
        consumer_key TEXT PRIMARY KEY, secret TEXT NOT NULL, name TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS lti_launches (
        token TEXT PRIMARY KEY, consumer_key TEXT, lab TEXT,
        outcome_url TEXT, sourcedid TEXT, user_name TEXT, context TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    } catch (_) { ready = null; }
  })();
  return ready;
}

// ---- OAuth 1.0 signature (RFC 5849, HMAC-SHA1) ----
function pe(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
function baseString(method: string, url: string, params: Record<string, string>): string {
  const norm = Object.keys(params).filter((k) => k !== 'oauth_signature')
    .map((k) => [pe(k), pe(params[k] ?? '')])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : 1)))
    .map((kv) => kv[0] + '=' + kv[1]).join('&');
  return method.toUpperCase() + '&' + pe(url) + '&' + pe(norm);
}
function sign(base: string, consumerSecret: string, tokenSecret = ''): string {
  return createHmac('sha1', pe(consumerSecret) + '&' + pe(tokenSecret)).update(base).digest('base64');
}
function timingEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function getConsumerSecret(key: string): Promise<string | null> {
  await ensureLtiSchema();
  const r = rows(await db.execute(sql`SELECT secret FROM lti_consumers WHERE consumer_key = ${key} LIMIT 1`))[0];
  return r ? r.secret : null;
}

// Verify an incoming LTI 1.1 launch. url = the exact launch URL the LMS posted to.
export async function verifyLaunch(method: string, url: string, params: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
  const key = params.oauth_consumer_key;
  if (!key) return { ok: false, error: 'missing oauth_consumer_key' };
  if (params.oauth_signature_method !== 'HMAC-SHA1') return { ok: false, error: 'unsupported signature method' };
  const secret = await getConsumerSecret(key);
  if (!secret) return { ok: false, error: 'unknown consumer key' };
  const ts = Number(params.oauth_timestamp || 0);
  if (!ts || Math.abs(Date.now() / 1000 - ts) > 600) return { ok: false, error: 'stale timestamp (>10 min)' };
  const expected = sign(baseString(method, url, params), secret);
  if (!timingEq(expected, params.oauth_signature || '')) return { ok: false, error: 'invalid signature' };
  return { ok: true };
}

export async function createConsumer(name: string): Promise<{ key: string; secret: string }> {
  await ensureLtiSchema();
  const key = 'era-' + randomBytes(6).toString('hex');
  const secret = randomBytes(24).toString('hex');
  await db.execute(sql`INSERT INTO lti_consumers (consumer_key, secret, name) VALUES (${key}, ${secret}, ${name || null})`);
  return { key, secret };
}
export async function listConsumers(): Promise<any[]> { await ensureLtiSchema(); return rows(await db.execute(sql`SELECT consumer_key, secret, name, created_at FROM lti_consumers ORDER BY created_at DESC`)); }
export async function deleteConsumer(key: string): Promise<void> { await ensureLtiSchema(); await db.execute(sql`DELETE FROM lti_consumers WHERE consumer_key = ${key}`); }

export async function storeLaunch(l: { consumerKey: string; lab: string; outcomeUrl: string; sourcedid: string; userName: string; context: string }): Promise<string> {
  await ensureLtiSchema();
  const token = randomBytes(18).toString('hex');
  await db.execute(sql`INSERT INTO lti_launches (token, consumer_key, lab, outcome_url, sourcedid, user_name, context)
    VALUES (${token}, ${l.consumerKey}, ${l.lab}, ${l.outcomeUrl || null}, ${l.sourcedid || null}, ${l.userName || null}, ${l.context || null})`);
  return token;
}
export async function getLaunch(token: string): Promise<any | null> {
  await ensureLtiSchema();
  return rows(await db.execute(sql`SELECT * FROM lti_launches WHERE token = ${token} LIMIT 1`))[0] || null;
}

// LTI Basic Outcomes: POST replaceResult, score in [0,1], signed OAuth1 with a body hash.
export async function sendGrade(token: string, score: number): Promise<{ ok: boolean; error?: string }> {
  const l = await getLaunch(token);
  if (!l || !l.outcome_url || !l.sourcedid) return { ok: false, error: 'no outcome service for this launch' };
  const secret = await getConsumerSecret(l.consumer_key);
  if (!secret) return { ok: false, error: 'consumer gone' };
  const s = Math.max(0, Math.min(1, Number(score) || 0));
  const msgId = randomBytes(8).toString('hex');
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<imsx_POXEnvelopeRequest xmlns="http://www.imsglobal.org/services/ltiv1p1/xsd/imsoms_v1p0">
  <imsx_POXHeader><imsx_POXRequestHeaderInfo><imsx_version>V1.0</imsx_version><imsx_messageIdentifier>${msgId}</imsx_messageIdentifier></imsx_POXRequestHeaderInfo></imsx_POXHeader>
  <imsx_POXBody><replaceResultRequest><resultRecord><sourcedGUID><sourcedId>${l.sourcedid}</sourcedId></sourcedGUID>
  <result><resultScore><language>en</language><textString>${s}</textString></resultScore></result></resultRecord></replaceResultRequest></imsx_POXBody>
</imsx_POXEnvelopeRequest>`;
  const bodyHash = createHash('sha1').update(body).digest('base64');
  const oauth: Record<string, string> = {
    oauth_consumer_key: l.consumer_key, oauth_signature_method: 'HMAC-SHA1', oauth_version: '1.0',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)), oauth_nonce: randomBytes(8).toString('hex'), oauth_body_hash: bodyHash,
  };
  oauth.oauth_signature = sign(baseString('POST', l.outcome_url, oauth), secret);
  const auth = 'OAuth ' + Object.keys(oauth).map((k) => pe(k) + '="' + pe(oauth[k]) + '"').join(',');
  try {
    const resp = await fetch(l.outcome_url, { method: 'POST', headers: { 'Content-Type': 'application/xml', Authorization: auth }, body });
    if (!resp.ok) return { ok: false, error: 'LMS returned ' + resp.status };
    return { ok: true };
  } catch (e: any) { return { ok: false, error: e?.message || 'network error' }; }
}
