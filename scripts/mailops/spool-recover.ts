/**
 * scripts/mailops/spool-recover.ts — inspect and recover the outbound mail spool.
 *
 *   npx tsx scripts/mailops/spool-recover.ts --spool <dir> [--stats-only] [--sweep-tmp] [--json]
 *   npx tsx scripts/mailops/spool-recover.ts --spool <dir> --requeue <entry-id>
 *
 * WHAT IT IS FOR. Two of the runbooks send you here. After a crash, a reboot or a killed worker,
 * entries can be sitting in sending/ holding a lease from a process that no longer exists; they are
 * not lost and they are not moving, and reclaim() is what puts them back. After a crash mid-write
 * there can be debris in tmp/, which is not mail and never was.
 *
 * IT IMPORTS THE ENGINE'S OWN SPOOL. It does not re-implement reclaim, sweep or the state machine.
 * A recovery tool with its own copy of the queue logic is a second, divergent queue, and the two
 * disagree about what "sending" means on exactly the day you need them not to.
 *
 * IT TOUCHES NO DATABASE AND SENDS NO MAIL. The most destructive thing it can do is move an entry
 * from failed/ back to queued/, and only when asked by id.
 */
import { Spool, describeStats } from '../../mail-engine/src/queue/spool.js';

interface Args {
  spool: string;
  statsOnly: boolean;
  sweepTmp: boolean;
  json: boolean;
  requeue: string | null;
  list: string | null;
  sweepOlderThanMs: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);

  const spool = get('spool') || process.env.MAIL_SPOOL_DIR || '';
  return {
    spool,
    statsOnly: has('stats-only'),
    sweepTmp: has('sweep-tmp'),
    json: has('json'),
    requeue: get('requeue'),
    list: get('list'),
    sweepOlderThanMs: Number(get('sweep-older-than-minutes') || 60) * 60_000,
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.spool) {
    console.error('No spool directory. Pass --spool <dir> or set MAIL_SPOOL_DIR.');
    console.error('The engine default is mail-engine/.spool; inside the container it is whatever MAIL_SPOOL_DIR says.');
    return 2;
  }

  const spool = new Spool({ root: args.spool, workerId: 'spool-recover' });
  await spool.init();

  const before = await spool.stats();

  if (args.list) {
    const state = args.list as 'queued' | 'sending' | 'sent' | 'failed';
    if (!['queued', 'sending', 'sent', 'failed'].includes(state)) {
      console.error(`--list must be one of queued, sending, sent, failed (got ${state})`);
      return 2;
    }
    const entries = await spool.list(state, 200);
    if (args.json) {
      console.log(JSON.stringify(entries, null, 2));
    } else {
      console.log(`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} in ${state}/`);
      for (const e of entries) {
        console.log(`  ${e.id}  attempts=${e.attempts}  to=${e.recipients.join(',')}  next=${new Date(e.nextAttemptAt).toISOString()}`);
        if (e.lastError) console.log(`      last error: ${e.lastError}${e.lastSmtpCode ? ` (${e.lastSmtpCode})` : ''}`);
      }
    }
    return 0;
  }

  if (args.requeue) {
    // Deliberately one at a time and by id. "Requeue everything in failed/" is available as a shell
    // loop for somebody who has decided to do it, and is not offered as a flag — a bulk requeue of
    // dead-lettered mail is how one incident becomes a duplicate-delivery incident.
    const ok = await spool.requeueFailed(args.requeue);
    console.log(ok ? `Requeued ${args.requeue}. It will be attempted with a fresh attempt budget.` : `No dead-lettered entry with id ${args.requeue}.`);
    return ok ? 0 : 1;
  }

  if (args.statsOnly) {
    if (args.json) console.log(JSON.stringify(before, null, 2));
    else report(before, args.spool);
    return 0;
  }

  const reclaimed = await spool.reclaim();
  const swept = args.sweepTmp ? await spool.sweepTmp(args.sweepOlderThanMs) : 0;
  const after = await spool.stats();

  if (args.json) {
    console.log(JSON.stringify({ before, reclaimed, swept, after }, null, 2));
    return 0;
  }

  report(after, args.spool);
  console.log('');
  if (reclaimed.reclaimed.length) {
    console.log(`Reclaimed ${reclaimed.reclaimed.length} abandoned entr${reclaimed.reclaimed.length === 1 ? 'y' : 'ies'}:`);
    for (const id of reclaimed.reclaimed) console.log(`  ${id}`);
    console.log('These were claimed by a worker that never reported an outcome. They are now due again.');
  } else {
    console.log('Nothing to reclaim.');
  }
  if (reclaimed.stillLeased) {
    console.log(`${reclaimed.stillLeased} entr${reclaimed.stillLeased === 1 ? 'y is' : 'ies are'} still within a live lease and were left alone — a worker may be mid-delivery.`);
  }
  if (args.sweepTmp) {
    console.log(swept ? `Swept ${swept} incomplete write(s) from tmp/. Nothing in tmp/ was ever acknowledged to a caller.` : 'No debris in tmp/ old enough to sweep.');
  } else if (before.orphanedTmp) {
    console.log(`${before.orphanedTmp} file(s) in tmp/. Re-run with --sweep-tmp to clear ones older than ${args.sweepOlderThanMs / 60_000} minutes.`);
  }
  return 0;
}

function report(stats: Awaited<ReturnType<Spool['stats']>>, dir: string): void {
  console.log(`Spool: ${dir}`);
  console.log(`  ${describeStats(stats)}`);
  console.log(`  delivered (awaiting prune): ${stats.sent}`);
  if (stats.oldestQueuedAgeMs != null) {
    const hours = stats.oldestQueuedAgeMs / 3_600_000;
    console.log(`  oldest queued entry: ${hours < 1 ? `${Math.round(stats.oldestQueuedAgeMs / 60_000)} minutes` : `${hours.toFixed(1)} hours`} old`);
  }
  if (stats.durability === 'file-only') {
    console.log('  DURABILITY: file-only. Directory fsync is unavailable on this platform, so a power cut can lose an');
    console.log('              entry the API already acknowledged. Run the spool on Linux (container or WSL2).');
  } else if (stats.durability === 'unknown') {
    console.log('  DURABILITY: not yet observed — nothing has been written through this process, so the guarantee is');
    console.log('              unmeasured rather than weak. It resolves on the first enqueue.');
  }
  if (stats.failed) {
    console.log(`  ${stats.failed} dead-lettered entr${stats.failed === 1 ? 'y' : 'ies'} in failed/. These need a decision, not a retry loop.`);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('spool-recover failed:', e?.message || e);
    process.exit(1);
  });
