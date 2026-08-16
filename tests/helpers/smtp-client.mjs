// tests/helpers/smtp-client.mjs — a dependency-free SMTP client for the test suites.
//
// The suites need to BE a mail server talking to ours: send a message the way a stranger's MTA
// would, try to relay through us the way a spammer would, and authenticate the way a client would.
// nodemailer can do the first; it cannot easily do the second, because it is built to send mail
// correctly, and the security suite needs to send it INcorrectly on purpose — an unauthenticated
// MAIL FROM, a RCPT TO for a domain we do not host, a command out of order.
//
// So this speaks raw SMTP and returns every reply code, including the ones a well-behaved client
// would never provoke. That is the whole point: `tests/security/open-relay.mjs` asserts on the
// numeric code our server gives a relay attempt, and a client that refuses to make the attempt
// cannot test it.
import net from 'node:net';

const CRLF = '\r\n';

export class SmtpClient {
  constructor({ host = '127.0.0.1', port = 1025, timeoutMs = 10_000 } = {}) {
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.buffer = '';
    this.transcript = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.connect({ host: this.host, port: this.port });
      this.socket.setTimeout(this.timeoutMs);
      this.socket.setEncoding('utf8');
      this.socket.on('data', (chunk) => { this.buffer += chunk; });
      this.socket.once('error', reject);
      this.socket.once('timeout', () => reject(new Error(`SMTP connect to ${this.host}:${this.port} timed out`)));
      this.socket.once('connect', () => {
        this.readReply().then(resolve).catch(reject);
      });
    });
  }

  /**
   * Read one complete reply. Multi-line replies (EHLO) use "250-" on every line but the last,
   * which uses "250 ". Treating the first line as the whole reply is the classic bug: the client
   * then reads the SECOND line of EHLO as the response to MAIL FROM and everything after is
   * off-by-one, producing failures that look like server bugs.
   */
  readReply() {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + this.timeoutMs;
      const check = () => {
        const lines = this.buffer.split(CRLF).filter(Boolean);
        const last = lines[lines.length - 1];
        if (last && /^\d{3} /.test(last)) {
          const reply = { code: Number(last.slice(0, 3)), lines: [...lines], text: lines.join('\n') };
          this.transcript.push({ direction: 'S', text: reply.text });
          this.buffer = '';
          return resolve(reply);
        }
        if (Date.now() > deadline) return reject(new Error(`SMTP read timed out; partial buffer: ${JSON.stringify(this.buffer.slice(0, 200))}`));
        setTimeout(check, 25);
      };
      check();
    });
  }

  async command(line) {
    this.transcript.push({ direction: 'C', text: line });
    this.socket.write(line + CRLF);
    return this.readReply();
  }

  async ehlo(name = 'test.invalid') { return this.command(`EHLO ${name}`); }
  async mailFrom(addr) { return this.command(`MAIL FROM:<${addr}>`); }
  async rcptTo(addr) { return this.command(`RCPT TO:<${addr}>`); }

  async authPlain(user, pass) {
    const token = Buffer.from(`\0${user}\0${pass}`).toString('base64');
    return this.command(`AUTH PLAIN ${token}`);
  }

  async data(message) {
    const opening = await this.command('DATA');
    if (opening.code !== 354) return opening;
    // Dot-stuff on the way out: a body line starting with "." must be sent as "..", or the server
    // reads it as the end-of-data marker and truncates the message.
    const stuffed = message.split(/\r?\n/).map((l) => (l.startsWith('.') ? '.' + l : l)).join(CRLF);
    this.transcript.push({ direction: 'C', text: `<${Buffer.byteLength(stuffed)} bytes of message>` });
    this.socket.write(stuffed + CRLF + '.' + CRLF);
    return this.readReply();
  }

  async quit() {
    try { await this.command('QUIT'); } catch { /* the server may close first, which is legal */ }
    this.close();
  }

  close() {
    try { this.socket?.destroy(); } catch { /* already gone */ }
  }

  /** The full conversation, for a failure message. A reply code without its context is unreadable. */
  dump() {
    return this.transcript.map((t) => `${t.direction}: ${t.text}`).join('\n');
  }
}

/** Build an RFC 5322 message. Minimal on purpose — the suites assert on headers they set here. */
export function buildMessage({ from, to, subject, text = 'test body', headers = {} }) {
  const lines = [
    `From: ${from}`,
    `To: ${Array.isArray(to) ? to.join(', ') : to}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@test.invalid>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ];
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  return lines.join(CRLF) + CRLF + CRLF + text;
}

/** Send one message, return the final reply. Used by the happy-path suites. */
export async function sendMessage({ host, port, from, to, subject, text, auth = null, headers = {} }) {
  const client = new SmtpClient({ host, port });
  try {
    await client.connect();
    await client.ehlo();
    if (auth) {
      const r = await client.authPlain(auth.user, auth.pass);
      if (r.code !== 235) throw new Error(`authentication failed: ${r.text}\n${client.dump()}`);
    }
    const mf = await client.mailFrom(from);
    if (mf.code !== 250) throw new Error(`MAIL FROM refused: ${mf.text}\n${client.dump()}`);
    for (const addr of [].concat(to)) {
      const rt = await client.rcptTo(addr);
      if (rt.code !== 250) throw new Error(`RCPT TO ${addr} refused: ${rt.text}\n${client.dump()}`);
    }
    const result = await client.data(buildMessage({ from, to, subject, text, headers }));
    await client.quit();
    return result;
  } catch (e) {
    client.close();
    throw e;
  }
}
