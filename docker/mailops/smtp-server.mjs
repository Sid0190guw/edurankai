// docker/mailops/smtp-server.mjs — a minimal, dependency-free SMTP server.
//
// WHY HAND-WRITTEN. Two services in this stack need to ACCEPT SMTP: the test sink (captures
// outbound mail and delivers nothing) and the ingest bridge (accepts inbound mail from Postfix and
// hands it to the app). Both are infrastructure, both must run in a container built from this
// repository, and neither needs the 90% of a real MTA that is queueing and delivery. `smtp-server`
// from npm would work and would also add a dependency tree to a component whose entire job is to
// be boring and auditable.
//
// WHAT IT IMPLEMENTS: EHLO/HELO, MAIL FROM, RCPT TO, DATA, RSET, NOOP, QUIT, and optional AUTH
// PLAIN/LOGIN. That is the subset every sending client uses.
//
// WHAT IT DELIBERATELY DOES NOT IMPLEMENT, so nobody mistakes it for an MTA:
//   - relaying. It never opens an outbound connection. It cannot be an open relay because it has
//     no way to relay anything; onMessage() decides what happens and the two implementations here
//     write to disk and POST to an HTTP endpoint respectively.
//   - STARTTLS. It listens on the compose network or on loopback. Putting a certificate in here
//     would invite exposing it, and a plaintext port that is obviously plaintext is safer than a
//     TLS port with a self-signed certificate that everyone learns to click through.
//   - real address validation, quotas, spam filtering. Postfix and Rspamd do that upstream.
//
// LINE DISCIPLINE IS THE PART THAT BITES. SMTP is CRLF-delimited, DATA ends with a lone ".", and a
// line inside the body that begins with "." arrives with an extra one prepended (dot-stuffing). Get
// the un-stuffing wrong and every message containing a line starting with a period is silently
// corrupted — which is rare enough to survive testing and common enough to happen in production.
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const CRLF = '\r\n';

/** RFC 5321 says a server MUST accept 1000-octet command lines and 1000-octet body lines. */
const MAX_LINE_BYTES = 4096;

export function createSmtpServer(options = {}) {
  const {
    hostname = 'era-smtp',
    maxMessageBytes = 30 * 1024 * 1024,
    requireAuth = false,
    // (user, pass) => boolean. Only consulted when requireAuth is true.
    authenticate = () => false,
    // async ({ from, to, raw, id, remoteAddress }) => void | throws to reject with 451
    onMessage = async () => {},
    onLog = () => {},
  } = options;

  const server = net.createServer((socket) => {
    const session = {
      id: randomUUID(),
      remoteAddress: socket.remoteAddress || 'unknown',
      helo: '',
      from: '',
      to: [],
      authenticated: !requireAuth,
      inData: false,
      // AUTH is a multi-line conversation; this holds which continuation we are expecting.
      awaiting: null,
      authUser: '',
    };

    let buffer = '';
    let dataChunks = [];
    let dataBytes = 0;
    let closed = false;

    const write = (line) => { if (!closed) socket.write(line + CRLF); };
    const reset = () => { session.from = ''; session.to = []; dataChunks = []; dataBytes = 0; session.inData = false; };

    socket.setTimeout(120_000);
    socket.on('timeout', () => { write('421 4.4.2 timeout'); socket.end(); });
    socket.on('error', (e) => { onLog({ level: 'warn', event: 'smtp.socket_error', session: session.id, error: String(e && e.message) }); });
    socket.on('close', () => { closed = true; });

    write(`220 ${hostname} ESMTP ready`);

    socket.on('data', async (chunk) => {
      buffer += chunk.toString('utf8');

      // DATA mode: consume until the lone-dot terminator. Handled before line parsing because
      // body content is not commands and must never be interpreted as one.
      while (session.inData) {
        const end = buffer.indexOf(CRLF + '.' + CRLF);
        // A message whose very first line is "." is a legal empty body.
        const startsWithDot = buffer.startsWith('.' + CRLF);
        if (end === -1 && !startsWithDot) {
          if (dataBytes + buffer.length > maxMessageBytes) {
            // Stop reading rather than buffering an unbounded body into memory. 552 is the code a
            // sender is expected to understand as "too big", and it will not retry forever.
            write('552 5.3.4 message exceeds size limit');
            reset();
            buffer = '';
            return;
          }
          return; // wait for more
        }
        const bodyRaw = startsWithDot ? '' : buffer.slice(0, end);
        buffer = buffer.slice(startsWithDot ? 3 : end + 5);
        session.inData = false;

        // Un-stuff: a body line that began with "." was sent as "..".
        const raw = bodyRaw.split(CRLF).map((l) => (l.startsWith('..') ? l.slice(1) : l)).join(CRLF);
        const message = { id: session.id, from: session.from, to: [...session.to], raw, remoteAddress: session.remoteAddress, receivedAt: new Date().toISOString() };
        dataChunks = [];
        dataBytes = 0;
        try {
          await onMessage(message);
          write(`250 2.0.0 Ok: queued as ${message.id}`);
        } catch (e) {
          // 451 is a TEMPORARY failure, so the sender retries. A permanent 5xx here would discard a
          // message because our own downstream (the app's inbound API) was briefly unavailable —
          // that is silent mail loss caused by a bug on our side, and it is the exact outcome the
          // brief calls out.
          onLog({ level: 'error', event: 'smtp.handler_failed', session: session.id, error: String(e && e.message) });
          write('451 4.3.0 local handler failed, try again later');
        }
        session.from = '';
        session.to = [];
      }

      let idx;
      while (!session.inData && (idx = buffer.indexOf(CRLF)) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (line.length > MAX_LINE_BYTES) { write('500 5.5.6 line too long'); continue; }
        try {
          await handleLine(line);
        } catch (e) {
          onLog({ level: 'error', event: 'smtp.command_failed', session: session.id, error: String(e && e.message) });
          write('421 4.3.0 internal error');
          socket.end();
        }
      }
    });

    async function handleLine(line) {
      // AUTH continuations are base64 payloads, not commands.
      if (session.awaiting) {
        const step = session.awaiting;
        session.awaiting = null;
        const decoded = Buffer.from(line.trim(), 'base64').toString('utf8');
        if (step === 'plain') {
          const [, user, pass] = decoded.split('\0');
          return finishAuth(user, pass);
        }
        if (step === 'login-user') {
          session.authUser = decoded;
          session.awaiting = 'login-pass';
          return write('334 UGFzc3dvcmQ6');
        }
        if (step === 'login-pass') return finishAuth(session.authUser, decoded);
      }

      const [verbRaw, ...rest] = line.trim().split(' ');
      const verb = (verbRaw || '').toUpperCase();
      const arg = rest.join(' ');

      switch (verb) {
        case 'EHLO': {
          session.helo = arg;
          const ext = ['250-' + hostname, `250-SIZE ${maxMessageBytes}`, '250-8BITMIME'];
          if (requireAuth) ext.push('250-AUTH PLAIN LOGIN');
          ext.push('250 ENHANCEDSTATUSCODES');
          return write(ext.join(CRLF));
        }
        case 'HELO':
          session.helo = arg;
          return write(`250 ${hostname}`);

        case 'AUTH': {
          if (!requireAuth) return write('503 5.5.1 authentication not enabled');
          const [mech, initial] = arg.split(' ');
          const m = (mech || '').toUpperCase();
          if (m === 'PLAIN') {
            if (initial) {
              const [, user, pass] = Buffer.from(initial, 'base64').toString('utf8').split('\0');
              return finishAuth(user, pass);
            }
            session.awaiting = 'plain';
            return write('334 ');
          }
          if (m === 'LOGIN') {
            session.awaiting = 'login-user';
            return write('334 VXNlcm5hbWU6');
          }
          return write('504 5.5.4 unrecognised authentication mechanism');
        }

        case 'MAIL': {
          // THE OPEN-RELAY GATE. Refusing before RCPT rather than after is what makes an
          // unauthenticated probe fail on its first useful command; tests/security/open-relay.mjs
          // asserts this and asserts that no message body is ever accepted without auth.
          if (requireAuth && !session.authenticated) return write('530 5.7.0 authentication required');
          const m = /FROM:\s*<([^>]*)>/i.exec(arg);
          if (!m) return write('501 5.5.4 syntax: MAIL FROM:<address>');
          session.from = m[1];
          session.to = [];
          return write('250 2.1.0 Ok');
        }

        case 'RCPT': {
          if (requireAuth && !session.authenticated) return write('530 5.7.0 authentication required');
          if (!session.from) return write('503 5.5.1 need MAIL before RCPT');
          const m = /TO:\s*<([^>]*)>/i.exec(arg);
          if (!m || !m[1]) return write('501 5.5.4 syntax: RCPT TO:<address>');
          if (session.to.length >= 100) return write('452 4.5.3 too many recipients');
          session.to.push(m[1]);
          return write('250 2.1.5 Ok');
        }

        case 'DATA': {
          if (requireAuth && !session.authenticated) return write('530 5.7.0 authentication required');
          if (!session.from || !session.to.length) return write('503 5.5.1 need MAIL and RCPT before DATA');
          session.inData = true;
          return write('354 End data with <CR><LF>.<CR><LF>');
        }

        case 'RSET':
          reset();
          return write('250 2.0.0 Ok');
        case 'NOOP':
          return write('250 2.0.0 Ok');
        case 'VRFY':
          // Never confirm whether an address exists. VRFY is a free directory-harvest tool.
          return write('252 2.5.2 cannot verify');
        case 'QUIT':
          write('221 2.0.0 Bye');
          return socket.end();
        default:
          return write('502 5.5.2 command not implemented');
      }
    }

    function finishAuth(user, pass) {
      let ok = false;
      try { ok = !!authenticate(user, pass); } catch { ok = false; }
      session.authenticated = ok;
      onLog({ level: ok ? 'info' : 'warn', event: ok ? 'smtp.auth_ok' : 'smtp.auth_failed', session: session.id, user: String(user || '').slice(0, 80) });
      // The failure response says nothing about WHICH half was wrong. "no such user" versus "bad
      // password" is a free account-enumeration oracle.
      return write(ok ? '235 2.7.0 Authentication successful' : '535 5.7.8 Authentication credentials invalid');
    }
  });

  return server;
}
