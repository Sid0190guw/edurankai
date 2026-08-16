// mail-engine/test/helpers/fake-smtp.ts — a real SMTP server, small enough to script.
//
// The tests that matter most in a mail system are the ones where a REAL SMTP conversation happens
// and the far end behaves badly on purpose: rejects one recipient out of three, answers 421 to the
// whole transaction, drops the connection after DATA. Mocking nodemailer would test that the mock
// was configured correctly. This speaks the protocol over a real socket, so what is being tested is
// the code that will run in production.
//
// It implements exactly the subset RFC 5321 requires of a receiver for these tests — greeting,
// EHLO/HELO, MAIL, RCPT, DATA, RSET, NOOP, QUIT — and nothing else. It is not a mail server and it
// must never be pointed at anything real.

import net from 'node:net';
import { once } from 'node:events';

export interface FakeSmtpOptions {
  /** Reply to send instead of the 220 greeting (e.g. '421 too busy'). */
  greeting?: string;
  /** Per-recipient replies. Any address not listed is accepted with 250. */
  rcptReplies?: Record<string, string>;
  /** Reply to the DATA command's final dot. Default '250 2.0.0 Ok: queued as ABC123'. */
  dataReply?: string;
  /** Reply to MAIL FROM. Default '250 2.1.0 Ok'. */
  mailReply?: string;
  /** Close the socket abruptly at this stage, to test connection failures. */
  dropAt?: 'greeting' | 'ehlo' | 'mail' | 'rcpt' | 'data';
  /** Delay (ms) before the greeting, to test connection timeouts. */
  greetingDelayMs?: number;
}

export interface CapturedMessage {
  mailFrom: string;
  rcptTo: string[];
  /** The DATA payload, dot-unstuffed, with CRLF preserved. */
  data: string;
  /** Headers parsed out of the payload, lowercased keys, unfolded. */
  headers: Record<string, string>;
}

export class FakeSmtpServer {
  readonly messages: CapturedMessage[] = [];
  readonly transcripts: string[][] = [];
  private server: net.Server;
  private opts: FakeSmtpOptions;
  private _port = 0;

  constructor(opts: FakeSmtpOptions = {}) {
    this.opts = opts;
    this.server = net.createServer((socket) => this.handle(socket));
  }

  get port(): number {
    return this._port;
  }

  async listen(): Promise<number> {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    this._port = (this.server.address() as net.AddressInfo).port;
    return this._port;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Change the script between attempts — this is how a retry test makes the second attempt succeed. */
  configure(opts: FakeSmtpOptions): void {
    this.opts = opts;
  }

  private handle(socket: net.Socket): void {
    const transcript: string[] = [];
    this.transcripts.push(transcript);

    let buffer = '';
    let inData = false;
    let dataLines: string[] = [];
    let mailFrom = '';
    let rcptTo: string[] = [];

    const send = (line: string) => {
      transcript.push('S: ' + line);
      socket.write(line + '\r\n');
    };

    const drop = (stage: FakeSmtpOptions['dropAt']) => {
      if (this.opts.dropAt === stage) {
        socket.destroy();
        return true;
      }
      return false;
    };

    const greet = () => {
      if (drop('greeting')) return;
      send(this.opts.greeting || '220 fake.test ESMTP ready');
    };
    if (this.opts.greetingDelayMs) setTimeout(greet, this.opts.greetingDelayMs);
    else greet();

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            const data = dataLines.join('\r\n');
            this.messages.push({ mailFrom, rcptTo: [...rcptTo], data, headers: parseHeaders(data) });
            dataLines = [];
            if (drop('data')) return;
            send(this.opts.dataReply || '250 2.0.0 Ok: queued as ABC123');
            continue;
          }
          // Dot-unstuffing, per RFC 5321 section 4.5.2.
          dataLines.push(line.startsWith('..') ? line.slice(1) : line);
          continue;
        }

        transcript.push('C: ' + line);
        const upper = line.toUpperCase();

        if (upper.startsWith('EHLO')) {
          if (drop('ehlo')) return;
          // No STARTTLS and no AUTH advertised: these tests run in cleartext on loopback, and a
          // capability the fake cannot honour would just make nodemailer fail confusingly.
          send('250-fake.test greets you');
          send('250-8BITMIME');
          send('250-PIPELINING');
          send('250 SIZE 36700160');
        } else if (upper.startsWith('HELO')) {
          send('250 fake.test');
        } else if (upper.startsWith('MAIL FROM')) {
          if (drop('mail')) return;
          mailFrom = extractAddress(line);
          send(this.opts.mailReply || '250 2.1.0 Ok');
        } else if (upper.startsWith('RCPT TO')) {
          if (drop('rcpt')) return;
          const address = extractAddress(line).toLowerCase();
          const scripted = this.opts.rcptReplies?.[address];
          if (scripted) {
            send(scripted);
          } else {
            rcptTo.push(address);
            send('250 2.1.5 Ok');
          }
        } else if (upper === 'DATA') {
          if (!rcptTo.length) {
            send('554 5.5.1 Error: no valid recipients');
            continue;
          }
          inData = true;
          send('354 End data with <CR><LF>.<CR><LF>');
        } else if (upper === 'RSET') {
          mailFrom = '';
          rcptTo = [];
          send('250 2.0.0 Ok');
        } else if (upper === 'NOOP') {
          send('250 2.0.0 Ok');
        } else if (upper === 'QUIT') {
          send('221 2.0.0 Bye');
          socket.end();
        } else {
          send('502 5.5.2 Command not implemented');
        }
      }
    });

    socket.on('error', () => { /* a client that hangs up mid-test is not a failure */ });
  }
}

function extractAddress(line: string): string {
  const m = /<([^>]*)>/.exec(line);
  if (m) return m[1];
  const parts = line.split(':');
  return (parts[1] || '').trim().split(' ')[0];
}

export function parseHeaders(data: string): Record<string, string> {
  const headerBlock = data.split('\r\n\r\n')[0] || '';
  const out: Record<string, string> = {};
  let current = '';
  for (const line of headerBlock.split('\r\n')) {
    if (/^[ \t]/.test(line) && current) {
      out[current] += ' ' + line.trim();
      continue;
    }
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    current = line.slice(0, colon).toLowerCase();
    out[current] = line.slice(colon + 1).trim();
  }
  return out;
}
