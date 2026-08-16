// docker/mailops/sink.mjs — the SMTP sink. Accepts mail, writes it to disk, DELIVERS NOTHING.
//
// This is what LOCAL_SMTP_MODE=sink points the app at, and it is the only SMTP endpoint the load
// tests are ever allowed to touch. The brief's rule — "do NOT actually send test spam to the public
// internet" — is enforced here structurally rather than by discipline: this process has no delivery
// path. It cannot forward a message even if configured to, because there is no code in it that
// opens an outbound connection.
//
// Captured mail is readable two ways: as files under MAIL_SINK_DIR (one .eml per message, openable
// in any mail client) and over a tiny HTTP API on MAIL_SINK_HTTP_PORT that the integration tests
// poll. The HTTP API is how tests assert "the message arrived, addressed to X, with subject Y"
// without parsing a maildir.
//
// It binds to 0.0.0.0 inside a container and to 127.0.0.1 when run bare on the ZBook — a test sink
// listening on every interface of a laptop on a café network is an open SMTP port to anyone on it.
import { createSmtpServer } from './smtp-server.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const SMTP_PORT = Number(process.env.MAIL_SINK_SMTP_PORT || 1025);
const HTTP_PORT = Number(process.env.MAIL_SINK_HTTP_PORT || 1080);
const DIR = process.env.MAIL_SINK_DIR || '.mailtest/sink';
const BIND = process.env.MAIL_SINK_BIND || (process.env.IN_CONTAINER === '1' ? '0.0.0.0' : '127.0.0.1');
const MAX_KEPT = Number(process.env.MAIL_SINK_MAX || 5000);

fs.mkdirSync(DIR, { recursive: true });

const log = (o) => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), svc: 'sink', ...o }) + '\n');

/** In-memory index for the test API. The .eml files on disk are the durable copy. */
const messages = [];

function headerOf(raw, name) {
  // Unfold continuation lines before matching: a long Subject is wrapped across lines and a naive
  // per-line regex returns only its first fragment, which makes an assertion on the full subject
  // fail for reasons that have nothing to do with the code under test.
  const unfolded = raw.replace(/\r\n[ \t]+/g, ' ');
  const m = new RegExp('^' + name + ':\\s*(.*)$', 'im').exec(unfolded.split('\r\n\r\n')[0] || unfolded);
  return m ? m[1].trim() : '';
}

const server = createSmtpServer({
  hostname: 'era-sink',
  onLog: log,
  onMessage: async (msg) => {
    const file = path.join(DIR, `${msg.receivedAt.replace(/[:.]/g, '-')}-${msg.id}.eml`);
    fs.writeFileSync(file, msg.raw, 'utf8');
    const record = {
      id: msg.id,
      receivedAt: msg.receivedAt,
      from: msg.from,
      to: msg.to,
      subject: headerOf(msg.raw, 'Subject'),
      messageId: headerOf(msg.raw, 'Message-ID'),
      dkim: /^DKIM-Signature:/im.test(msg.raw),
      bytes: Buffer.byteLength(msg.raw),
      file,
    };
    messages.push(record);
    // Bounded, or a 100k-message load test eats the container's memory and the run reports a crash
    // that looks like a defect in the system under test.
    if (messages.length > MAX_KEPT) messages.splice(0, messages.length - MAX_KEPT);
    log({ level: 'info', event: 'sink.captured', to: msg.to, subject: record.subject, bytes: record.bytes });
  },
});

server.listen(SMTP_PORT, BIND, () => log({ level: 'info', event: 'sink.smtp_listening', port: SMTP_PORT, bind: BIND, dir: DIR }));

// --- test API ------------------------------------------------------------------------------------
// GET /messages[?to=&subject=&since=]  GET /messages/:id  GET /health  DELETE /messages
const api = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === '/health') return send(200, { ok: true, captured: messages.length, smtpPort: SMTP_PORT });
  if (url.pathname === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    return res.end(`# HELP era_sink_messages Messages captured by the SMTP sink since start.\n# TYPE era_sink_messages gauge\nera_sink_messages ${messages.length}\n`);
  }
  if (req.method === 'DELETE' && url.pathname === '/messages') {
    messages.length = 0;
    return send(200, { ok: true, cleared: true });
  }
  if (url.pathname === '/messages') {
    const to = url.searchParams.get('to');
    const subject = url.searchParams.get('subject');
    const since = url.searchParams.get('since');
    let out = messages;
    if (to) out = out.filter((m) => m.to.some((a) => a.toLowerCase().includes(to.toLowerCase())));
    if (subject) out = out.filter((m) => (m.subject || '').toLowerCase().includes(subject.toLowerCase()));
    if (since) out = out.filter((m) => m.receivedAt > since);
    return send(200, { count: out.length, messages: out.slice(-200) });
  }
  const m = /^\/messages\/([^/]+)$/.exec(url.pathname);
  if (m) {
    const found = messages.find((x) => x.id === m[1]);
    if (!found) return send(404, { error: 'not found' });
    // Path traversal is impossible here because the filename is constructed from a UUID we
    // generated, never from the request — but the file is read only after the id matched a record.
    return send(200, { ...found, raw: fs.readFileSync(found.file, 'utf8') });
  }
  return send(404, { error: 'not found' });
});

api.listen(HTTP_PORT, BIND, () => log({ level: 'info', event: 'sink.http_listening', port: HTTP_PORT, bind: BIND }));

const shutdown = () => {
  log({ level: 'info', event: 'sink.shutdown' });
  server.close();
  api.close();
  setTimeout(() => process.exit(0), 200).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
