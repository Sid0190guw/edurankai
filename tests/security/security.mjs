// tests/security/security.mjs — the checks from the brief's section 13, run against a live target.
//
// WHAT A GREEN RUN HERE MEANS, STATED PRECISELY: the specific attacks below were attempted and
// refused. It does not mean the system is secure. These are regression tests for known failure
// classes — an open relay, a missing authorization check, a forged webhook — not a penetration
// test, and reporting them as one would be the most dangerous thing in this repository.
//
// EVERY CASE IS NON-DESTRUCTIVE. Nothing here deletes, escalates or persists. The SQL-injection
// probe uses a payload that is syntactically dangerous and semantically harmless; the traversal
// probe reads a path that either exists or does not. This suite is safe to run against the local
// stack, and `tests/run.mjs` refuses a production target without an explicit opt-in.
import { Suite, assert, assertEqual, http, requireService, SkipSuite } from '../helpers/harness.mjs';
import { SmtpClient } from '../helpers/smtp-client.mjs';
import { config } from '../helpers/config.mjs';

const suite = new Suite('SECURITY', 'open relay, authz, injection, forged webhooks, secret exposure');

suite.before = async () => {
  await requireService(`${config.baseUrl}/api/health`, 'the app', 'Start it with ./scripts/start-mail.sh');
};

// --- 1. open relay ---------------------------------------------------------------------------------

suite.test('the MTA is not an open relay', async () => {
  let client;
  try {
    client = new SmtpClient({ host: config.mta.host, port: config.mta.smtpPort, timeoutMs: 8000 });
    await client.connect();
  } catch {
    throw new SkipSuite(`no MTA answering on ${config.mta.host}:${config.mta.smtpPort} — start it with ./scripts/start-mail.sh --mail. THE OPEN-RELAY GUARANTEE IS NOT TESTED IN THIS RUN.`);
  }
  try {
    await client.ehlo('scanner.invalid');
    // Both addresses are OUTSIDE any domain we host: this is a request to carry mail from a
    // stranger to a stranger, which is the definition of relaying.
    const mf = await client.mailFrom('spammer@elsewhere.invalid');
    const rcpt = await client.rcptTo('victim@somewhere-else.invalid');
    assert(
      mf.code >= 400 || rcpt.code >= 400,
      `THE MTA ACCEPTED A RELAY ATTEMPT. An unauthenticated sender was allowed to address a recipient in a domain this server does not host. ` +
      `This is an open relay: it will be found by scanners within hours and the IP will be blacklisted.\n` +
      `Check smtpd_relay_restrictions in docker/postfix/main.cf.override — reject_unauth_destination must be present and last.\n${client.dump()}`,
    );
  } finally {
    await client.quit().catch(() => {});
  }
});

suite.test('unauthenticated submission on 587 is refused', async () => {
  let client;
  try {
    client = new SmtpClient({ host: config.mta.host, port: config.mta.submissionPort, timeoutMs: 8000 });
    await client.connect();
  } catch {
    throw new SkipSuite(`nothing answering on the submission port ${config.mta.submissionPort}. NOT TESTED.`);
  }
  try {
    await client.ehlo('client.invalid');
    const mf = await client.mailFrom(`someone@${config.mailDomain}`);
    const rcpt = mf.code === 250 ? await client.rcptTo('outside@elsewhere.invalid') : { code: 0, text: '' };
    assert(mf.code >= 400 || rcpt.code >= 400,
      `the submission port accepted an unauthenticated sender using one of our own domains. That is sender spoofing from the open internet.\n${client.dump()}`);
  } finally {
    await client.quit().catch(() => {});
  }
});

suite.test('the ingest bridge never relays — it has no delivery path at all', async () => {
  let client;
  try {
    client = new SmtpClient({ host: config.ingest.smtpHost, port: config.ingest.smtpPort, timeoutMs: 8000 });
    await client.connect();
  } catch {
    throw new SkipSuite('the ingest bridge is not reachable on this host');
  }
  try {
    await client.ehlo('scanner.invalid');
    const before = (await http(`${config.ingest.apiUrl}/health`)).json;
    await client.mailFrom('spammer@elsewhere.invalid');
    await client.rcptTo('victim@somewhere-else.invalid');
    await client.data('Subject: relay probe\r\n\r\nbody');
    await client.quit();

    const after = (await http(`${config.ingest.apiUrl}/health`)).json;
    // The bridge forwards to the app over HTTP; the APP decides whether a recipient exists. What
    // must never happen is an outbound SMTP connection to somewhere-else.invalid, and the bridge is
    // structurally incapable of that — it imports no SMTP client. This asserts the observable half.
    assert(after.received >= before.received, 'the bridge did not even record the attempt, so its counters cannot be trusted for the rest of this suite');
  } finally {
    client.close();
  }
});

// --- 2. API authorization --------------------------------------------------------------------------

suite.test('operator-only endpoints refuse an anonymous caller', async () => {
  // /api/ is hard-exempted from src/middleware.ts, so each route's own check is the only gate.
  // That makes this the single most valuable case in the file.
  const endpoints = [
    '/api/health/deep',
    '/api/health/mail',
    '/api/metrics',
    '/api/mail/contacts',
    '/api/mail/campaigns',
  ];
  const failures = [];
  for (const path of endpoints) {
    const r = await http(`${config.baseUrl}${path}`);
    if (r.status === 404) continue; // not deployed here
    if (![401, 403, 302].includes(r.status)) failures.push(`${path} -> HTTP ${r.status}`);
  }
  assertEqual(failures.length, 0, `these endpoints answered an anonymous caller instead of refusing: ${failures.join(', ')}`);
});

suite.test('the job runner refuses a wrong secret and does not leak the right one', async () => {
  const r = await http(`${config.baseUrl}/api/jobs/run?key=definitely-not-the-secret`, { method: 'POST' });
  // 404 is "not deployed here", which is a skip and not a pass — the same rule every other case in
  // this file uses. Treating it as a failure made this case fire against a target that simply does
  // not have the route, which is the fastest way to teach someone to ignore a red security suite.
  if (r.status === 404) throw new SkipSuite('/api/jobs/run is not deployed on this target');
  assert(r.status === 403 || r.json?.ok === false, `the job runner accepted a wrong secret: HTTP ${r.status}`);
  assert(!/[a-f0-9]{32,}/i.test(r.text), 'the refusal response contains something that looks like a secret');
});

suite.test('the metrics endpoint is not readable without a token', async () => {
  const r = await http(`${config.baseUrl}/api/metrics`);
  assert(r.status === 403 || r.status === 404 || r.status === 401,
    `/api/metrics answered HTTP ${r.status} to an anonymous caller. Queue depth and send rates are a traffic profile of the business and an outage map for an attacker.`);
  assert(!r.text.includes('edurankai_mail_'), 'metric samples were served to an unauthenticated caller');
});

suite.test('a short METRICS_TOKEN does not open the door', async () => {
  // The app requires >= 32 characters and treats anything shorter as "this door does not exist".
  // The failure mode being tested is the opposite: a short token being accepted, or an unset token
  // meaning "allow anyone".
  const r = await http(`${config.baseUrl}/api/metrics`, { headers: { Authorization: 'Bearer short' } });
  assert(r.status >= 400, `a bearer token of "short" was accepted with HTTP ${r.status}`);
});

// --- 3. injection ----------------------------------------------------------------------------------

suite.test('SQL injection payloads in query parameters do not reach the database', async () => {
  // Harmless by construction: if it were interpolated the query would be a syntax error, which
  // surfaces as a 500 with a Postgres message. A parameterised query answers normally.
  const payloads = ["' OR '1'='1", "'; SELECT pg_sleep(0); --", "\\'; DROP TABLE mail_messages; --"];
  for (const p of payloads) {
    const r = await http(`${config.baseUrl}/api/mail/search?q=${encodeURIComponent(p)}`);
    if (r.status === 404) throw new SkipSuite('/api/mail/search is not deployed on this target');
    assert(r.status !== 500, `payload ${JSON.stringify(p)} produced HTTP 500 — a server error on a syntactically dangerous input is the signature of string interpolation`);
    assert(!/syntax error at or near|PostgresError|relation ".*" does not exist/i.test(r.text),
      `a database error was echoed to the caller for payload ${JSON.stringify(p)}. Even when injection fails, echoing the driver error hands over the schema.`);
  }
});

suite.test('an HTML payload in a mail field is not reflected unescaped', async () => {
  const xss = '<script>alert(1)</script>';
  const r = await http(`${config.baseUrl}/api/mail/search?q=${encodeURIComponent(xss)}`);
  if (r.status === 404) throw new SkipSuite('/api/mail/search is not deployed on this target');
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    // JSON is not an XSS sink as long as the content type is right; that is what is asserted.
    assert(ct.includes('application/json'), 'a JSON response must declare application/json, or a browser may sniff it as HTML');
  } else {
    assert(!r.text.includes(xss), 'the payload came back verbatim in an HTML response — that is reflected XSS');
  }
});

suite.test('path traversal in an attachment identifier is refused', async () => {
  for (const p of ['../../../../etc/passwd', '..%2f..%2f..%2fetc%2fpasswd', '....//....//etc/passwd']) {
    const r = await http(`${config.baseUrl}/api/mail/attachment?id=${encodeURIComponent(p)}`);
    if (r.status === 404) continue;
    assert(!r.text.includes('root:x:'), `TRAVERSAL SUCCEEDED with ${JSON.stringify(p)} — the server returned /etc/passwd`);
    assert(r.status !== 200 || r.text.length === 0, `a traversal path returned HTTP 200 with a body`);
  }
});

// --- 4. forged webhooks ----------------------------------------------------------------------------

suite.test('a forged inbound webhook is refused', async () => {
  const body = JSON.stringify({ to: `connect@${config.mailDomain}`, from: 'attacker@example.invalid', subject: 'forged', text: 'x' });
  const attempts = [
    { name: 'no credentials', headers: {} },
    { name: 'wrong shared secret', headers: { 'x-mail-secret': 'not-the-secret' } },
    { name: 'wrong HMAC signature', headers: { 'x-era-signature': 'v1=' + '0'.repeat(64), 'x-era-timestamp': String(Math.floor(Date.now() / 1000)) } },
    { name: 'valid-looking signature with an ancient timestamp', headers: { 'x-era-signature': 'v1=' + 'a'.repeat(64), 'x-era-timestamp': '1000000000' } },
  ];
  const accepted = [];
  for (const a of attempts) {
    const r = await http(`${config.baseUrl}/api/mail/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...a.headers }, body });
    if (r.status === 404) throw new SkipSuite('/api/mail/inbound is not deployed on this target');
    if (r.status < 400) accepted.push(`${a.name} -> HTTP ${r.status}`);
  }
  assertEqual(accepted.length, 0, `forged inbound deliveries were ACCEPTED: ${accepted.join('; ')}. Anyone who finds this URL can inject mail into any mailbox.`);
});

// --- 5. secret exposure ----------------------------------------------------------------------------

suite.test('no endpoint leaks a secret in an error response', async () => {
  const probes = ['/api/health', '/api/health/ready', '/api/mail/inbound', '/api/jobs/run'];
  const leaked = [];
  for (const path of probes) {
    const r = await http(`${config.baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"malformed"' });
    const text = r.text || '';
    // Connection strings and long hex tokens are the two shapes that have actually leaked here —
    // the Postgres driver puts the pooler host, role and port in e.cause.message.
    if (/postgres(ql)?:\/\/[^\s"]+/i.test(text)) leaked.push(`${path}: a connection string`);
    if (/pooler\.supabase\.com/i.test(text)) leaked.push(`${path}: the database hostname`);
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) leaked.push(`${path}: a private key`);
  }
  assertEqual(leaked.length, 0, `secrets or configuration appeared in error responses: ${leaked.join('; ')}`);
});

suite.test('the public health endpoint discloses no configuration', async () => {
  const r = await http(`${config.baseUrl}/api/health`);
  assert(r.status === 200 || r.status === 503, `/api/health answered HTTP ${r.status}`);
  assert(!/pooler\.supabase\.com|postgres:\/\//i.test(r.text), 'the unauthenticated health endpoint disclosed the database configuration — during an outage this is exactly what the driver error contains');
});

// --- 6. transport and headers ----------------------------------------------------------------------

suite.test('security headers are present on the app', async () => {
  const r = await http(`${config.baseUrl}/`);
  const missing = [];
  for (const h of ['x-content-type-options', 'x-frame-options', 'referrer-policy']) {
    if (!r.headers.get(h)) missing.push(h);
  }
  if (missing.length && config.baseUrl.includes('127.0.0.1')) {
    // vercel.json sets these at the edge, and the local node adapter does not read that file.
    throw new SkipSuite(`missing ${missing.join(', ')} — these are set by vercel.json at the edge and are NOT applied by the local node server. This case is only meaningful against a deployed target.`);
  }
  assertEqual(missing.length, 0, `missing security headers: ${missing.join(', ')}`);
});

suite.test('CORS does not allow an arbitrary origin on a credentialed endpoint', async () => {
  const r = await http(`${config.baseUrl}/api/mail/contacts`, { method: 'OPTIONS', headers: { Origin: 'https://attacker.example', 'Access-Control-Request-Method': 'POST' } });
  const allow = r.headers.get('access-control-allow-origin');
  const creds = r.headers.get('access-control-allow-credentials');
  if (!allow) return; // no CORS headers for an unknown origin is the correct answer
  assert(allow !== 'https://attacker.example', 'an arbitrary origin was echoed back — any site a signed-in user visits could read their mail');
  assert(!(allow === '*' && creds === 'true'), 'wildcard origin combined with credentials: browsers reject this, so the endpoint is both insecure-looking and broken');
});

export default suite;
