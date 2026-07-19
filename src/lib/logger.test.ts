// src/lib/logger.test.ts — run: npx tsx src/lib/logger.test.ts
// Structured logging + error tracking (Prompt AP7b): secrets are REDACTED before anything is logged
// or stored; logs are structured JSON; the error hook is fired but can never break the request.
import { redactMeta, formatLog } from './logger';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

console.log('\n== redaction: secrets never reach the logs ==');
const red = redactMeta({ userId: 'u1', apiKey: 'sk-ABCDEFGHIJKLMNOPQRSTUVWX', token: 'longtokenvalue123', note: 'hello' });
ok('a secret-shaped value is redacted', red.apiKey === '[redacted]');
ok('a key/token/secret-named field is redacted', red.token === '[redacted]');
ok('ordinary fields pass through', red.userId === 'u1' && red.note === 'hello');
ok('a razorpay/db-url secret is redacted', redactMeta({ db: 'postgres://u:supersecretpw@host/db' }).db === '[redacted]');

console.log('\n== structured logs ==');
const line = formatLog('error', 'checkout.failed', { userId: 'u9', reason: 'card declined' });
const parsed = JSON.parse(line);
ok('log is valid structured JSON', parsed.level === 'error' && parsed.event === 'checkout.failed' && parsed.userId === 'u9');
ok('log carries a timestamp', typeof parsed.ts === 'string' && parsed.ts.includes('T'));
ok('a secret in log meta is redacted in the line', !JSON.parse(formatLog('info', 'x', { key: 'sk-ABCDEFGHIJKLMNOPQRSTUVWX' })).key.includes('sk-'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
