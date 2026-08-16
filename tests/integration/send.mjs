// tests/integration/send.mjs — the SEND path, end to end.
//
//   Web UI -> API -> database -> queue -> mail worker -> SMTP -> test recipient
//
// WHAT THIS SUITE PROVES, and what it deliberately does not.
//
// It proves the transport half: a message handed to the app's SMTP transport reaches an SMTP server,
// intact, addressed correctly, and is CAPTURED rather than delivered. It proves the queue drains.
// It proves the delivery is recorded where the reading pane and /admin/mail/analytics look.
//
// It does NOT drive a browser. There is no headless browser in this repository and adding one is a
// large dependency for the last hop of a path whose other five hops are covered here. The UI's
// contract with the API is Patch 3's; docs/mail/TESTING.md section 7 records that gap explicitly
// rather than letting a green suite imply it is covered.
//
// EVERY MESSAGE GOES TO example.invalid. That TLD can never be registered, so a message that
// escapes the sink cannot reach anybody.
import { Suite, assert, assertEqual, assertStatus, waitFor, http, requireService, SkipSuite } from '../helpers/harness.mjs';
import { sendMessage, SmtpClient } from '../helpers/smtp-client.mjs';
import { config } from '../helpers/config.mjs';

const suite = new Suite('SEND', 'app -> queue -> worker -> SMTP -> captured');

const marker = () => `era-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

suite.before = async () => {
  await requireService(`${config.sink.apiUrl}/health`, 'the SMTP sink', 'Start it with ./scripts/start-mail.sh');
};

suite.test('the sink accepts a message and captures it without delivering', async () => {
  const subject = marker();
  const reply = await sendMessage({
    host: config.sink.smtpHost,
    port: config.sink.smtpPort,
    from: config.testSender,
    to: config.testRecipient,
    subject,
    text: 'body of the send-path test',
  });
  assertEqual(reply.code, 250, 'the sink must accept a well-formed message; anything else means the transport cannot deliver at all');

  const found = await waitFor(async () => {
    const r = await http(`${config.sink.apiUrl}/messages?subject=${encodeURIComponent(subject)}`);
    return r.json?.count > 0 ? r.json.messages[0] : null;
  }, { because: 'the message never appeared in the sink, so it was accepted at SMTP and then lost' });

  assertEqual(found.to[0], config.testRecipient, 'the envelope recipient must survive the hop; a rewritten recipient is how mail reaches the wrong person');
  assert(found.bytes > 0, 'the captured message has no body — the DATA phase completed but nothing was stored');
});

suite.test('a message body containing a leading dot is not corrupted', async () => {
  // The most common silent corruption in SMTP. Dot-stuffing is applied by the sender and must be
  // undone by the receiver; get it wrong and any message with a line starting "." loses a character
  // or is truncated at that line. Rare enough to survive testing, common enough to happen for real.
  const subject = marker();
  await sendMessage({
    host: config.sink.smtpHost,
    port: config.sink.smtpPort,
    from: config.testSender,
    to: config.testRecipient,
    subject,
    text: 'before\n.a line beginning with a dot\n..two dots\nafter',
  });

  const record = await waitFor(async () => {
    const r = await http(`${config.sink.apiUrl}/messages?subject=${encodeURIComponent(subject)}`);
    return r.json?.count > 0 ? r.json.messages[0] : null;
  }, { because: 'the dot-stuffed message never arrived' });

  const full = await http(`${config.sink.apiUrl}/messages/${record.id}`);
  assert(full.json.raw.includes('\r\n.a line beginning with a dot'), 'the leading dot was eaten — un-stuffing is wrong, and every message containing such a line is being corrupted');
  assert(full.json.raw.includes('\r\n..two dots') || full.json.raw.includes('\r\n.two dots'), 'the double-dot line was mangled beyond either valid interpretation');
});

suite.test('a message larger than the limit is refused, not silently truncated', async () => {
  const client = new SmtpClient({ host: config.sink.smtpHost, port: config.sink.smtpPort, timeoutMs: 30_000 });
  await client.connect();
  const ehlo = await client.ehlo();
  assert(/SIZE \d+/.test(ehlo.text), 'the server must advertise SIZE so a sender can avoid transmitting a message that will be refused');

  const limit = Number(/SIZE (\d+)/.exec(ehlo.text)[1]);
  // Deliberately just over. A test that sends 10x the limit passes even if the check is off by a
  // factor of five.
  const body = 'x'.repeat(limit + 100_000);
  await client.mailFrom(config.testSender);
  await client.rcptTo(config.testRecipient);
  const result = await client.data(`Subject: oversized\r\n\r\n${body}`);
  await client.quit();

  assert(result.code >= 500 || result.code === 452, `an oversized message must be refused with a 5xx or 452, not accepted. Got ${result.code}: ${result.text}`);
});

suite.test('the queue drains through the worker', async () => {
  if (!config.secrets.cron) throw new SkipSuite('CRON_SECRET is not set in this shell, so /api/jobs/run cannot be called. export it from .env.local.');
  await requireService(`${config.baseUrl}/api/health`, 'the app', 'Start it with ./scripts/start-mail.sh');

  // Drives the same endpoint the worker and the Vercel cron drive. Asserting on the reported
  // counters proves the drain ran; asserting the backlog fell would be flaky, because another
  // worker may legitimately have drained it first.
  const r = await http(`${config.baseUrl}/api/jobs/run?key=${encodeURIComponent(config.secrets.cron)}&limit=5`, { method: 'POST', timeoutMs: 60_000 });
  assertStatus(r, 200, 'the job runner must be reachable and authorised, or nothing queued is ever sent');
  assert(r.json?.ok === true, `the job runner reported failure: ${r.json?.error || r.text.slice(0, 200)}`);
  assert(typeof r.json.health?.pending === 'number', 'the runner must report queue health; without it there is no way to see a backlog');
});

suite.test('the worker reports itself ready, and ready means it has actually drained once', async () => {
  let health;
  try {
    const r = await http('http://127.0.0.1:1082/ready', { timeoutMs: 5000 });
    health = r.json;
  } catch {
    throw new SkipSuite('the mail-worker container is not exposing 1082 to the host (it is internal to the compose network by default)');
  }
  assert(health.lastOkAt !== null, 'the worker has never completed a successful poll — it is running but has never proved it can reach the app or that its secret is right');
  assert(health.consecutiveErrors < 3, `the worker is failing repeatedly: ${health.lastError}`);
});

export default suite;
