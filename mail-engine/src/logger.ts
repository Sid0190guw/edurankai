// mail-engine/src/logger.ts — structured logs, one JSON object per line.
//
// Mail debugging is almost always "what did the far end actually say, and when". That is a query,
// not a story, so the log is machine-readable first: `grep '"kind":"deferred"' | jq .smtpResponse`
// answers it without a human having to parse prose.
//
// REDACTION IS NOT OPTIONAL HERE. An SMTP transcript at debug level contains the AUTH line, and an
// AUTH PLAIN line contains the password in base64. Every string that goes through this logger is
// scrubbed of the patterns below before it is written.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACTIONS: { re: RegExp; with: string }[] = [
  // SMTP AUTH in all three shapes it appears in a transcript.
  { re: /\bAUTH\s+(PLAIN|LOGIN|CRAM-MD5|XOAUTH2)\s+\S+/gi, with: 'AUTH $1 [redacted]' },
  { re: /\bAUTH\s+(PLAIN|LOGIN)\b(?=\s*$)/gi, with: 'AUTH $1' },
  // password=... / "pass": "..." in any config dump that reaches a log line.
  { re: /("?(?:pass|password|passwd|secret|token|api[_-]?key)"?\s*[:=]\s*")([^"]*)(")/gi, with: '$1[redacted]$3' },
  { re: /\b(pass|password|passwd|secret|token)=([^\s&,;]+)/gi, with: '$1=[redacted]' },
  // PEM private keys, if one is ever interpolated into an error message.
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, with: '[redacted private key]' },
];

export function redact(value: string): string {
  let out = value;
  for (const r of REDACTIONS) out = out.replace(r.re, r.with);
  return out;
}

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return redact(value);
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (/^(pass|password|passwd|secret|token|apiKey|api_key|privateKey)$/i.test(k)) {
      out[k] = v ? '[redacted]' : v;
    } else {
      out[k] = scrub(v, depth + 1);
    }
  }
  return out;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  component?: string;
  /** Where lines go. Injectable so tests can read what was logged. */
  sink?: (line: string) => void;
  /** Injectable clock, for the same reason. */
  now?: () => Date;
}

export function createLogger(opts: LoggerOptions = {}, base: Record<string, unknown> = {}): Logger {
  const level = opts.level || 'info';
  const sink = opts.sink || ((line: string) => process.stdout.write(line + '\n'));
  const now = opts.now || (() => new Date());

  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const rec: Record<string, unknown> = {
      ts: now().toISOString(),
      level: lvl,
      component: opts.component || 'mail-engine',
      msg: redact(msg),
      ...base,
      ...(fields ? (scrub(fields) as Record<string, unknown>) : {}),
    };
    let line: string;
    try {
      line = JSON.stringify(rec);
    } catch {
      // A circular object in a log field must not take down the caller. Losing one line of
      // structure is survivable; an exception thrown from inside a catch block is not.
      line = JSON.stringify({ ts: rec.ts, level: lvl, msg: rec.msg, note: 'fields were not serialisable' });
    }
    sink(line);
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger(opts, { ...base, ...(scrub(fields) as Record<string, unknown>) }),
  };
}

/**
 * The real reason a Postgres or network error happened is rarely on e.message. This is the mail-engine
 * equivalent of the house rule in CLAUDE.md: reach for the cause before settling for the message.
 */
export function reasonOf(e: unknown): string {
  const err = e as { cause?: { message?: string }; message?: string; code?: string } | null;
  return String(err?.cause?.message || err?.message || err?.code || 'unknown error');
}
