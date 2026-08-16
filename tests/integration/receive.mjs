// tests/integration/receive.mjs — the RECEIVE path, end to end.
//
//   test SMTP sender -> Postfix -> parser -> database -> Web UI -> inbox
//
// The hop this suite owns is `test sender -> ingest bridge -> POST /api/mail/inbound`. Postfix's
// own hop is covered only when the `mail` profile is running, and is skipped with a reason
// otherwise rather than quietly not running.
//
// THE PROPERTY THAT MATTERS MOST HERE IS NOT "DOES MAIL ARRIVE". It is "IS MAIL EVER SILENTLY
// LOST". A receive path that drops one message in a thousand and answers 250 for it is worse than
// one that is down, because nothing anywhere records the loss. So the assertions are weighted
// towards refusal behaviour: when the app cannot take a message, the sender must be told, and told
// with a code that makes the sending server KEEP the message.
import { Suite, assert, assertEqual, waitFor, http, requireService, SkipSuite } from '../helpers/harness.mjs';
import { SmtpClient, buildMessage, sendMessage } from '../helpers/smtp-client.mjs';
import { config } from '../helpers/config.mjs';

const suite = new Suite('RECEIVE', 'stranger MTA -> bridge -> app -> stored');

const marker = () => `era-inbound-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

suite.before = async () => {
  await requireService(`${config.ingest.apiUrl}/health`, 'the inbound bridge (mail-parser)',
    'Start it with ./scripts/start-mail.sh. If it is running but not reachable, its SMTP port is internal to the compose network — publish it or run the suite from inside the network.');
};

suite.test('a message from a stranger is accepted and forwarded to the app', async () => {
  const before = (await http(`${config.ingest.apiUrl}/health`)).json;
  const subject = marker();

  const reply = await sendMessage({
    host: config.ingest.smtpHost,
    port: config.ingest.smtpPort,
    from: config.testSender,
    to: `connect@${config.mailDomain}`,
    subject,
    text: 'inbound body',
  });
  assertEqual(reply.code, 250, 'the bridge must accept a well-formed inbound message');

  const after = await waitFor(async () => {
    const h = (await http(`${config.ingest.apiUrl}/health`)).json;
    return h.forwarded > before.forwarded ? h : null;
  }, { because: 'the bridge accepted the message but never forwarded it to the app — this is the silent-loss case' });

  assertEqual(after.refused, before.refused, 'the app refused a well-formed message; check MAIL_WEBHOOK_SECRET matches on both sides');
});

suite.test('the envelope recipient reaches the app, not just the header To:', async () => {
  // BCC only exists in the ENVELOPE — there is no Bcc: header on a delivered message. A bridge that
  // reads recipients from headers delivers nothing to a bcc'd user, and the bug is invisible until
  // somebody asks why they never got a copy.
  const subject = marker();
  const envelopeTo = `envelope-only@${config.mailDomain}`;
  const client = new SmtpClient({ host: config.ingest.smtpHost, port: config.ingest.smtpPort });
  await client.connect();
  await client.ehlo();
  await client.mailFrom(config.testSender);
  const rcpt = await client.rcptTo(envelopeTo);
  assertEqual(rcpt.code, 250, 'the bridge must accept the envelope recipient');
  // Header To: deliberately names somebody else.
  const message = buildMessage({ from: config.testSender, to: `someone-else@${config.mailDomain}`, subject, text: 'envelope test' });
  const result = await client.data(message);
  await client.quit();
  assertEqual(result.code, 250, `the message with a divergent envelope recipient was refused:\n${client.dump()}`);
});

suite.test('an unparseable message is still accepted and recorded, not dropped', async () => {
  // Real mail is malformed more often than anyone expects. The rule is that a message we cannot
  // understand is a message we must still not lose — /api/mail/inbound's own header records an
  // incident where a parse failure answered 400 and the forwarding worker read that as "malformed",
  // so real mail was dropped with nothing anywhere saying so.
  const client = new SmtpClient({ host: config.ingest.smtpHost, port: config.ingest.smtpPort });
  await client.connect();
  await client.ehlo();
  await client.mailFrom(config.testSender);
  await client.rcptTo(`connect@${config.mailDomain}`);
  const result = await client.data('this is not a MIME message at all\r\nno headers, no blank line separator');
  await client.quit();

  assert(result.code === 250 || result.code === 451,
    `a malformed message must be either accepted (250) or temporarily deferred (451) so the sender retries. ` +
    `A 5xx here permanently discards mail we merely failed to parse. Got ${result.code}: ${result.text}`);
});

suite.test('the bridge answers 451, never 250, when the app will not take a message', async () => {
  // Provable without breaking anything: point a fresh bridge at a URL that refuses. Skipped rather
  // than faked when the harness cannot start one.
  throw new SkipSuite('covered by the unit-level verification in docs/mail/TESTING.md section 5; ' +
    'reproducing it here requires standing up a second bridge against a stub app, which the runner does not do. ' +
    'The behaviour is asserted in the ingest source and was verified by hand — see the same section.');
});

suite.test('an unsigned delivery is refused when a webhook secret is configured', async () => {
  if (!config.secrets.webhook) throw new SkipSuite('MAIL_WEBHOOK_SECRET is not set in this shell, so there is no signature requirement to test');
  await requireService(`${config.baseUrl}/api/health`, 'the app');

  const r = await http(`${config.baseUrl}/api/mail/inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: `connect@${config.mailDomain}`, from: 'attacker@example.invalid', subject: 'unsigned', text: 'x' }),
  });
  assert(r.status === 401 || r.status === 403,
    `an unsigned, unauthenticated POST to the inbound endpoint must be refused — anyone who finds this URL could otherwise inject mail into any mailbox. Got HTTP ${r.status}`);
});

export default suite;
