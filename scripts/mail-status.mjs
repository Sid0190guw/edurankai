#!/usr/bin/env node
// scripts/mail-status.mjs — render the health aggregator's JSON as something a person reads.
//
// Called by status-mail.sh and start-mail.sh. Separate from them because formatting JSON in bash
// means either jq (another dependency) or a sed pipeline that breaks on the first nested object,
// and because this way `node scripts/mail-status.mjs` works on its own.
//
// THE OUTPUT RULE: a component that is not deployed says so, in words. The single most misleading
// thing a status display can do is render an absent component the same way as a working one.
const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const port = portArg !== -1 ? args[portArg + 1] : process.env.PORT_MAILOPS || '9100';
const host = process.env.MAILOPS_HOST || '127.0.0.1';

const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `[${code}m${s}[0m` : s);
const green = (s) => c('32', s);
const red = (s) => c('31', s);
const dim = (s) => c('2', s);

const MARK = { ok: green('  ok  '), degraded: red(' FAIL '), 'not-configured': dim('  --  ') };

try {
  const res = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(8000) });
  const report = await res.json();

  const width = Math.max(...report.components.map((x) => x.name.length)) + 2;
  for (const comp of report.components) {
    const mark = MARK[comp.state] || '  ?   ';
    const name = comp.name.padEnd(width);
    const latency = typeof comp.latencyMs === 'number' ? dim(`${String(comp.latencyMs).padStart(5)}ms `) : '        ';
    const detail = comp.state === 'not-configured' ? dim(comp.detail) : comp.detail;
    process.stdout.write(`  ${mark} ${name}${latency}${detail}\n`);
  }

  if (report.degraded?.length) {
    process.stdout.write(`\n  ${red('DEGRADED')}: ${report.degraded.join(', ')}\n`);
    process.stdout.write(`  ${dim('These components are expected on this stack and are not answering.')}\n`);
  }
  // Exit code carries the verdict, so this is usable in a shell conditional or a cron.
  process.exit(report.status === 'ok' ? 0 : 1);
} catch (e) {
  const why = e?.name === 'TimeoutError' ? 'timed out' : e?.message || String(e);
  process.stdout.write(`  ${red('no answer')} from http://${host}:${port}/health (${why})\n`);
  process.stdout.write(`  ${dim('The stack is probably not running:  ./scripts/start-mail.sh')}\n`);
  process.exit(1);
}
