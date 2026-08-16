// docker/mailops/ingest.mjs — the inbound bridge. SMTP in, HTTP out. This is `mail-parser`.
//
//   internet -> Postfix (MX, spam, DKIM verify) -> ingest (this) -> POST /api/mail/inbound -> app
//
// WHY IT DOES NOT PARSE MIME. The app's /api/mail/inbound route ALREADY accepts raw MIME and parses
// it with postal-mime, and it already resolves recipients, threads the message, applies inbound
// rules and notifies. Parsing here too would be a second implementation of the delivery path — the
// exact fault that route's own header records as having cost this project a thread-splitting bug and
// a rules engine that never fired. So this service forwards the RAW message and the envelope, and
// the app remains the only place that decides what a message means.
//
// WHAT IT ADDS, and why it is a service rather than a Postfix pipe script:
//   - RETRY WITH BACKOFF. If the app is redeploying, a pipe script exits non-zero and Postfix
//     bounces or defers per its own rules; here the message is held and retried, and only a
//     genuinely unacceptable message is refused at SMTP time so the SENDING server keeps it.
//   - SIGNED DELIVERY. HMAC over body and timestamp (docker/mailops/sign.mjs), so the app can tell
//     a real MTA from anyone who found the URL, and can reject a replay.
//   - VISIBLE FAILURE. Counters at /metrics and a log line per message. A pipe script that fails
//     silently is how inbound mail disappears with nothing anywhere saying so.
//
// BACKPRESSURE IS DELIBERATE. A failed forward answers 451 (temporary) at SMTP, so the upstream MTA
// retains the message and retries. Answering 250 and dropping it would be silent mail loss, which
// the brief forbids and which is the single worst failure mode an inbound path has.
import { createSmtpServer } from './smtp-server.mjs';
import { signedHeaders } from './sign.mjs';
import http from 'node:http';

const SMTP_PORT = Number(process.env.INGEST_SMTP_PORT || 1025);
const HTTP_PORT = Number(process.env.INGEST_HTTP_PORT || 1081);
const BIND = process.env.INGEST_BIND || (process.env.IN_CONTAINER === '1' ? '0.0.0.0' : '127.0.0.1');
const APP_URL = (process.env.APP_URL || 'http://app:4321').replace(/\/+$/, '');
const INBOUND_PATH = process.env.INBOUND_PATH || '/api/mail/inbound';
const WEBHOOK_SECRET = process.env.MAIL_WEBHOOK_SECRET || '';
const LEGACY_SECRET = process.env.MAIL_INBOUND_SECRET || '';
const MAX_ATTEMPTS = Number(process.env.INGEST_MAX_ATTEMPTS || 4);

const log = (o) => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), svc: 'ingest', ...o }) + '\n');

const counters = { received: 0, forwarded: 0, refused: 0, retries: 0, lastError: '' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function forward(msg) {
  const body = msg.raw;
  // Raw MIME, not JSON: the route branches on Content-Type and takes the envelope from headers.
  // Sending JSON here would mean re-encoding the message and losing exactly the header fidelity
  // (DKIM-Signature, Received chain) that makes an inbound message verifiable.
  const headers = {
    'Content-Type': 'message/rfc822',
    'x-mail-to': msg.to.join(','),
    'x-mail-from': msg.from,
  };
  if (WEBHOOK_SECRET) {
    const signed = signedHeaders(WEBHOOK_SECRET, body, { deliveryId: msg.id });
    // Keep the real content type; only take the signature fields from the helper.
    headers['x-era-signature'] = signed['x-era-signature'];
    headers['x-era-timestamp'] = signed['x-era-timestamp'];
    headers['x-era-delivery-id'] = signed['x-era-delivery-id'];
  }
  // The legacy shared secret goes alongside the signature, not instead of it, so this container
  // works against an app deployment that has not yet been given MAIL_WEBHOOK_SECRET.
  if (LEGACY_SECRET) headers['x-mail-secret'] = LEGACY_SECRET;

  let lastError = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const res = await fetch(APP_URL + INBOUND_PATH, { method: 'POST', headers, body, signal: ctrl.signal });
      const text = await res.text().catch(() => '');
      if (res.ok) return { ok: true, attempt };
      // 4xx is the app saying the message itself is unacceptable — retrying cannot change that, and
      // retrying a 400 for an hour just delays the bounce the sender needs to see. 5xx is our
      // problem and IS worth retrying.
      if (res.status >= 400 && res.status < 500) return { ok: false, permanent: true, status: res.status, detail: text.slice(0, 300) };
      lastError = `app returned ${res.status}: ${text.slice(0, 200)}`;
    } catch (e) {
      lastError = e && e.name === 'AbortError' ? 'app did not respond within 20s' : String(e && e.message);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < MAX_ATTEMPTS) {
      counters.retries++;
      const backoff = Math.min(30_000, 1000 * 2 ** attempt);
      log({ level: 'warn', event: 'ingest.retry', attempt, backoffMs: backoff, error: lastError });
      await sleep(backoff);
    }
  }
  return { ok: false, permanent: false, detail: lastError };
}

const server = createSmtpServer({
  hostname: process.env.MAIL_HOST || 'era-ingest',
  onLog: log,
  onMessage: async (msg) => {
    counters.received++;
    const r = await forward(msg);
    if (r.ok) {
      counters.forwarded++;
      log({ level: 'info', event: 'ingest.forwarded', id: msg.id, to: msg.to, attempt: r.attempt, bytes: Buffer.byteLength(msg.raw) });
      return;
    }
    counters.lastError = r.detail || '';
    if (r.permanent) {
      counters.refused++;
      log({ level: 'error', event: 'ingest.refused', id: msg.id, to: msg.to, status: r.status, detail: r.detail });
      // A permanent refusal still throws: the SMTP layer answers 451 rather than 250, so the
      // upstream MTA keeps the message and a human can look at it. Accepting-then-discarding is
      // the one outcome that must never happen here.
      throw new Error(`app refused message (${r.status}): ${r.detail}`);
    }
    log({ level: 'error', event: 'ingest.failed', id: msg.id, to: msg.to, detail: r.detail });
    throw new Error(r.detail || 'forward failed');
  },
});

server.listen(SMTP_PORT, BIND, () => log({
  level: 'info',
  event: 'ingest.listening',
  port: SMTP_PORT,
  bind: BIND,
  app: APP_URL + INBOUND_PATH,
  auth: WEBHOOK_SECRET ? 'hmac' : LEGACY_SECRET ? 'shared-secret (legacy)' : 'NONE — the app will refuse every delivery',
}));

const api = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, ...counters }));
  }
  if (url.pathname === '/ready') {
    // Ready means the app is reachable. An ingest bridge that accepts SMTP while its only
    // downstream is unreachable will accept mail it cannot deliver — better to be marked unready
    // and let the MTA hold the queue.
    const ready = !!(WEBHOOK_SECRET || LEGACY_SECRET);
    res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ready, reason: ready ? 'ok' : 'no inbound secret configured — every delivery would be refused' }));
  }
  if (url.pathname === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    return res.end(
      `# HELP era_ingest_received Messages accepted at SMTP.\n# TYPE era_ingest_received counter\nera_ingest_received ${counters.received}\n` +
      `# HELP era_ingest_forwarded Messages successfully handed to the app.\n# TYPE era_ingest_forwarded counter\nera_ingest_forwarded ${counters.forwarded}\n` +
      `# HELP era_ingest_refused Messages the app permanently refused.\n# TYPE era_ingest_refused counter\nera_ingest_refused ${counters.refused}\n` +
      `# HELP era_ingest_retries Forward attempts after the first.\n# TYPE era_ingest_retries counter\nera_ingest_retries ${counters.retries}\n`,
    );
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});
api.listen(HTTP_PORT, BIND, () => log({ level: 'info', event: 'ingest.http_listening', port: HTTP_PORT }));

const shutdown = () => { log({ level: 'info', event: 'ingest.shutdown' }); server.close(); api.close(); setTimeout(() => process.exit(0), 200).unref(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
