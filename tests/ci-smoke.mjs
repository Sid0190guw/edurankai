#!/usr/bin/env node
// tests/ci-smoke.mjs — the mail path, end to end, with no database and no Docker.
//
// WHY THIS EXISTS SEPARATELY FROM tests/run.mjs. Those suites need a running stack, so in CI they
// would all SKIP — and a skipped suite proves nothing. This one starts the two real services from
// this repository (the SMTP sink and the inbound bridge), stands a stub in for the app, and pushes
// a real message through real SMTP. It runs on any machine with Node and nothing else, which means
// it can be a required check rather than an aspiration.
//
// WHAT IT ACTUALLY PROVES, on every commit:
//   - the hand-written SMTP server accepts a real client conversation
//   - dot-stuffing is undone correctly (the silent corruption nobody notices)
//   - the bridge forwards RAW MIME with the envelope intact
//   - the HMAC signature it writes verifies with the app-side verifier
//   - when the app refuses, the sender is told 451 and NOT 250 — no silent mail loss
//
// WHAT IT DOES NOT PROVE: anything involving Postfix, Dovecot, the database, or the real app.
// docs/mail/TESTING.md section 7 lists those gaps rather than leaving them to be assumed.
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SECRET = 'ci-smoke-secret';
const PORTS = { sinkSmtp: 12525, sinkHttp: 12580, ingestSmtp: 12526, ingestHttp: 12581, stub: 12599 };

const tty = process.stdout.isTTY;
const paint = (c, s) => (tty ? `\x1b[${c}m${s}\x1b[0m` : s);
const green = (s) => paint('32', s);
const red = (s) => paint('31', s);

let passed = 0;
const failures = [];
const children = [];
let stubServer = null;
const workDir = mkdtempSync(join(tmpdir(), 'era-ci-smoke-'));

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    process.stdout.write(`  ${green('pass')}  ${name}\n`);
  } else {
    failures.push(`${name}${detail ? `\n        ${detail}` : ''}`);
    process.stdout.write(`  ${red('FAIL')}  ${name}\n${detail ? `        ${detail}\n` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal SMTP client — enough to send one message and read every reply code. */
async function sendVia(port, { from, to, body }) {
  const socket = net.connect({ port, host: '127.0.0.1' });
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', (c) => { buffer += c; });
  const read = () => new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const tick = () => {
      const lines = buffer.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1];
      if (last && /^\d{3} /.test(last)) { const r = { code: Number(last.slice(0, 3)), text: lines.join(' | ') }; buffer = ''; return resolve(r); }
      if (Date.now() > deadline) return reject(new Error(`SMTP read timeout, buffer=${JSON.stringify(buffer.slice(0, 200))}`));
      setTimeout(tick, 20);
    };
    tick();
  });
  const cmd = async (line) => { socket.write(line + '\r\n'); return read(); };

  await new Promise((res, rej) => { socket.once('connect', res); socket.once('error', rej); });
  await read();
  await cmd('EHLO ci.invalid');
  const mf = await cmd(`MAIL FROM:<${from}>`);
  const rt = await cmd(`RCPT TO:<${to}>`);
  const dataOpen = await cmd('DATA');
  const stuffed = body.split(/\r?\n/).map((l) => (l.startsWith('.') ? '.' + l : l)).join('\r\n');
  socket.write(stuffed + '\r\n.\r\n');
  const final = await read();
  socket.write('QUIT\r\n');
  socket.destroy();
  return { mf, rt, dataOpen, final };
}

function startService(script, env) {
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stderr.on('data', (d) => process.stderr.write(`[${script}] ${d}`));
  return child;
}

async function waitForHttp(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error(`${url} never became ready`);
}

// --- the stub app -----------------------------------------------------------------------------------
let appBehaviour = 'accept';
const received = [];

function startStub() {
  return new Promise((resolve) => {
    stubServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (req.url === '/api/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"status":"ok"}'); }
        if (req.url === '/api/mail/inbound') {
          received.push({ headers: req.headers, body });
          if (appBehaviour === 'refuse') { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end('{"ok":false,"error":"rejected by stub"}'); }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end('{"ok":true}');
        }
        res.writeHead(404); res.end('{}');
      });
    });
    stubServer.listen(PORTS.stub, '127.0.0.1', resolve);
  });
}

function cleanup() {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* already gone */ } }
  try { stubServer?.close(); } catch { /* already closed */ }
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.on('exit', cleanup);

// --- run --------------------------------------------------------------------------------------------
process.stdout.write('\nCI smoke — the mail path with no database and no Docker\n\n');

await startStub();

startService('docker/mailops/sink.mjs', {
  MAIL_SINK_SMTP_PORT: String(PORTS.sinkSmtp),
  MAIL_SINK_HTTP_PORT: String(PORTS.sinkHttp),
  MAIL_SINK_DIR: join(workDir, 'sink'),
});
startService('docker/mailops/ingest.mjs', {
  INGEST_SMTP_PORT: String(PORTS.ingestSmtp),
  INGEST_HTTP_PORT: String(PORTS.ingestHttp),
  APP_URL: `http://127.0.0.1:${PORTS.stub}`,
  MAIL_WEBHOOK_SECRET: SECRET,
  INGEST_MAX_ATTEMPTS: '1',
});

await waitForHttp(`http://127.0.0.1:${PORTS.sinkHttp}/health`);
await waitForHttp(`http://127.0.0.1:${PORTS.ingestHttp}/health`);

// 1. outbound capture, including the dot-stuffing case
const subject = `ci-smoke-${Date.now()}`;
const outbound = await sendVia(PORTS.sinkSmtp, {
  from: 'sender@example.invalid',
  to: 'recipient@example.invalid',
  body: `From: sender@example.invalid\r\nTo: recipient@example.invalid\r\nSubject: ${subject}\r\n\r\nfirst line\n.a dot-led line\nlast line`,
});
check('the sink accepts a well-formed message', outbound.final.code === 250, `got ${outbound.final.code}: ${outbound.final.text}`);

const listed = await (await fetch(`http://127.0.0.1:${PORTS.sinkHttp}/messages?subject=${encodeURIComponent(subject)}`)).json();
check('the captured message is retrievable by subject', listed.count === 1, `count=${listed.count}`);

if (listed.count === 1) {
  const full = await (await fetch(`http://127.0.0.1:${PORTS.sinkHttp}/messages/${listed.messages[0].id}`)).json();
  check('dot-stuffing is undone, so a dot-led body line survives intact',
    full.raw.includes('\r\n.a dot-led line') && !full.raw.includes('\r\n..a dot-led line'),
    'the leading dot was eaten or doubled — every message containing such a line is being corrupted');
  check('the envelope recipient is recorded', listed.messages[0].to[0] === 'recipient@example.invalid');
}

// 2. inbound forward, signed
const beforeForward = await (await fetch(`http://127.0.0.1:${PORTS.ingestHttp}/health`)).json();
const inbound = await sendVia(PORTS.ingestSmtp, {
  from: 'outsider@example.invalid',
  to: 'connect@edurankai.in',
  body: 'From: outsider@example.invalid\r\nTo: connect@edurankai.in\r\nSubject: inbound smoke\r\n\r\nhello',
});
check('the bridge accepts an inbound message', inbound.final.code === 250, `got ${inbound.final.code}: ${inbound.final.text}`);

await sleep(400);
const afterForward = await (await fetch(`http://127.0.0.1:${PORTS.ingestHttp}/health`)).json();
check('the bridge forwarded it to the app', afterForward.forwarded === beforeForward.forwarded + 1,
  `forwarded went ${beforeForward.forwarded} -> ${afterForward.forwarded}`);

const delivered = received[received.length - 1];
check('the forward carries raw MIME, not a re-encoded body', delivered?.headers['content-type'] === 'message/rfc822');
check('the envelope survives the hop', delivered?.headers['x-mail-to'] === 'connect@edurankai.in' && delivered?.headers['x-mail-from'] === 'outsider@example.invalid');
check('the original Subject header is intact', /^Subject: inbound smoke$/im.test(delivered?.body || ''));

// 3. the signature the container writes verifies with the app's own verifier
const { verifyInbound } = await import('../src/lib/mailops/webhook.ts').catch(async () => {
  const { register } = await import('tsx/esm/api');
  register();
  return import('../src/lib/mailops/webhook.ts');
});
const verdict = await verifyInbound(new Headers(delivered.headers), delivered.body, { hmacSecret: SECRET });
check('the app-side verifier accepts the container-side signature', verdict.ok === true && verdict.scheme === 'hmac',
  `verdict: ${JSON.stringify(verdict)} — docker/mailops/sign.mjs and src/lib/mailops/webhook.ts have diverged`);

const tampered = await verifyInbound(new Headers(delivered.headers), delivered.body + 'x', { hmacSecret: SECRET });
check('a tampered body fails verification', tampered.ok === false);

// 4. no silent loss: when the app refuses, the SENDER must be told
appBehaviour = 'refuse';
const refused = await sendVia(PORTS.ingestSmtp, {
  from: 'outsider@example.invalid',
  to: 'connect@edurankai.in',
  body: 'From: outsider@example.invalid\r\nTo: connect@edurankai.in\r\nSubject: will be refused\r\n\r\nx',
});
check('a message the app refuses is NOT acknowledged as delivered', refused.final.code !== 250,
  `the bridge answered ${refused.final.code}. Answering 250 here discards a message the app never accepted — silent mail loss.`);
check('the refusal is TEMPORARY (4xx), so the sending server keeps the message', refused.final.code >= 400 && refused.final.code < 500,
  `got ${refused.final.code}: a 5xx tells the sender to give up and bounce a message that was merely undeliverable right now`);

// --- report -------------------------------------------------------------------------------------------
process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  process.stdout.write(`\n${red('Failures:')}\n`);
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.stdout.write('\n');
  process.exit(1);
}
process.stdout.write(`${green('The mail path works end to end.')}\n\n`);
process.exit(0);
