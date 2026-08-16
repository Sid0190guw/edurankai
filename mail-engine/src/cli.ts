// mail-engine/src/cli.ts — the operator's hands. `node --import tsx mail-engine/src/cli.ts <cmd>`.
//
// Every command here answers a question an operator actually asks at 2am, and each one works
// against the spool and the key store DIRECTLY rather than through the HTTP API — because the first
// question at 2am is usually "why is the API not answering".

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from './engine.js';
import { loadDotEnv } from './index.js';
import { generateDkimKey, dnsRecordFor } from './dkim.js';
import { humanDuration, maximumQueueLifetimeMs } from './queue/retry.js';
import { classifySmtpReply } from './smtp/classify.js';

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `
mail-engine — operator commands

  check                      configuration, DKIM keys, queue depth, what is and is not working
  queue                      queue depth and the next few messages due
  dead                       dead-lettered messages
  requeue <messageId>        put a dead letter back on the queue
  flush                      run one delivery pass now, then publish events
  keygen <domain>            generate a DKIM key and print the DNS record to publish
  dns <domain>               print every DNS record this domain needs (SPF, DKIM, DMARC, MX)
  suppressions               list suppressed recipients
  unsuppress <address>       remove one recipient from the suppression list
  classify <code> <text>     explain how a given SMTP reply would be classified
  send <from> <to> <subject> queue one message (uses the real pipeline; delivery obeys config)
`.trim();

async function main(): Promise<number> {
  await loadDotEnv(path.join(ENGINE_ROOT, '.env'));
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE);
    return 0;
  }

  const engine = createEngine();
  const { config, spool, publisher, keys, pipeline, worker, inbound } = engine;

  switch (command) {
    case 'check': {
      const stats = await spool.stats();
      const dkim = await keys.status(config.domains);
      console.log('hostname          ', config.hostname);
      console.log('domains           ', config.domains.join(', '));
      console.log('transport         ', engine.transport.name);
      console.log('delivery enabled  ', config.deliveryEnabled ? 'yes' : 'NO — messages will queue and stay queued');
      console.log('spool             ', path.resolve(config.spoolDir));
      console.log('queue             ', `${stats.ready} ready, ${stats.deferred} deferred, ${stats.processing} in flight, ${stats.dead} dead`);
      console.log('events pending    ', await publisher.pending());
      console.log('inbound pending   ', await inbound.pending());
      console.log('suppressions      ', (await publisher.listSuppressions()).length);
      console.log('retry schedule    ', `${config.maxAttempts} attempts over up to ${humanDuration(maximumQueueLifetimeMs({
        maxAttempts: config.maxAttempts, baseDelayMs: config.retryBaseDelayMs, factor: config.retryFactor,
        maxDelayMs: config.retryMaxDelayMs, jitter: config.retryJitter,
      }))}`);
      for (const d of dkim) {
        console.log(`dkim ${d.domain.padEnd(18)}`, d.signed ? `signing with ${d.selector}` : `NO KEY — run: cli keygen ${d.domain}`);
      }
      if (engine.warnings.length) {
        console.log('\nwarnings:');
        for (const w of engine.warnings) console.log('  -', w);
      }
      return 0;
    }

    case 'queue': {
      // READ-ONLY, deliberately. An operator running `queue` to see what is waiting must not cause
      // the messages to be claimed by the CLI process and then released a second later — that would
      // reset their leases and briefly hide them from the worker that was about to send them.
      const stats = await spool.stats();
      console.log(`${stats.ready} ready · ${stats.deferred} deferred · ${stats.processing} in flight · ${stats.dead} dead`);
      if (stats.dead) console.log(`\n${stats.dead} dead letter(s) — see: cli dead`);
      return 0;
    }

    case 'dead': {
      const entries = await spool.listDead(50);
      if (!entries.length) { console.log('no dead letters'); return 0; }
      for (const e of entries) {
        console.log(`${e.messageId}  ${e.pending.join(', ')}  "${e.message.subject}"  after ${e.attempt} attempts  — ${e.deadReason || 'no reason recorded'}`);
      }
      return 0;
    }

    case 'requeue': {
      const id = args[0];
      if (!id) { console.error('usage: requeue <messageId>'); return 2; }
      const ok = await spool.requeueDead(id);
      console.log(ok ? `requeued ${id}` : `no dead letter matching ${id}`);
      return ok ? 0 : 1;
    }

    case 'flush': {
      const pass = await worker.runOnce();
      const events = await publisher.flush();
      const delivered = await inbound.flushInbound();
      console.log(`claimed ${pass.claimed}: ${pass.delivered} delivered, ${pass.deferred} deferred, ${pass.bounced} bounced, ${pass.deadLettered} dead-lettered`);
      console.log(`published ${events} events, delivered ${delivered} inbound messages to the application`);
      await engine.transport.close();
      return 0;
    }

    case 'keygen': {
      const domain = args[0];
      if (!domain) { console.error('usage: keygen <domain>'); return 2; }
      const existing = await keys.get(domain);
      if (existing && !args.includes('--force')) {
        console.error(`a key already exists at ${keys.keyPath(domain)}`);
        console.error('Rotating a key means publishing the NEW record, waiting for DNS to propagate, and only');
        console.error('then switching the selector. Pass --force if that is what you are doing.');
        return 1;
      }
      const pair = generateDkimKey(domain, config.dkimSelector);
      const file = await keys.write(pair);
      const record = dnsRecordFor(pair);
      console.log(`private key written to ${file} (keep it there; it is gitignored)\n`);
      console.log('Publish this TXT record, then verify with:  dig +short TXT ' + record.name + '\n');
      console.log('  name : ' + record.name);
      console.log('  type : TXT');
      console.log('  value: ' + record.value);
      console.log('\nIf your DNS panel rejects the length, use the split form:');
      console.log('  ' + record.quoted);
      return 0;
    }

    case 'dns': {
      const domain = args[0] || config.domains[0];
      const key = await keys.get(domain);
      console.log(`DNS for ${domain} — see mail-engine/docs/dns.md for what each record does\n`);
      console.log(`MX     @                        10 ${config.hostname}.`);
      console.log(`A      ${config.hostname.padEnd(24)} <the public IP of the mail host>`);
      console.log(`TXT    @                        "v=spf1 mx a:${config.hostname} -all"`);
      if (key) {
        const record = dnsRecordFor(key);
        console.log(`TXT    ${record.name.padEnd(24)} "${record.value.slice(0, 60)}..."   (full value: cli keygen output, or the key file)`);
      } else {
        console.log(`TXT    ${config.dkimSelector}._domainkey.${domain}   NOT GENERATED — run: cli keygen ${domain}`);
      }
      console.log(`TXT    _dmarc                   "v=DMARC1; p=none; rua=mailto:dmarc@${domain}; adkim=s; aspf=s"`);
      console.log(`\nPTR (reverse DNS) for the sending IP must resolve to ${config.hostname}.`);
      console.log('That record is set by whoever owns the IP address — your hosting provider or ISP.');
      console.log('It CANNOT be set from here, and it cannot be set at all on a domestic connection.');
      return 0;
    }

    case 'suppressions': {
      const entries = await publisher.listSuppressions();
      if (!entries.length) { console.log('no suppressed recipients'); return 0; }
      for (const e of entries) {
        console.log(`${e.recipient.padEnd(40)} ${e.reason.padEnd(20)} ${e.permanent ? 'permanent' : `until ${e.expiresAt}`}  ${e.detail || ''}`);
      }
      return 0;
    }

    case 'unsuppress': {
      const address = args[0];
      if (!address) { console.error('usage: unsuppress <address>'); return 2; }
      const removed = await publisher.unsuppress(address);
      console.log(removed ? `removed ${address}` : `${address} was not suppressed`);
      return removed ? 0 : 1;
    }

    case 'classify': {
      const code = Number(args[0]);
      const text = args.slice(1).join(' ');
      const result = classifySmtpReply(Number.isFinite(code) ? code : null, text || null);
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }

    case 'send': {
      const [from, to, ...subjectParts] = args;
      if (!from || !to) { console.error('usage: send <from> <to> <subject...>'); return 2; }
      const result = await pipeline.submit({
        messageId: '',
        from,
        to: [to],
        subject: subjectParts.join(' ') || 'Test message from the EduRankAI mail engine',
        text: 'This message was queued by mail-engine/src/cli.ts.',
      });
      console.log(JSON.stringify(result, null, 2));
      if (!result.accepted) return 1;
      console.log('\nQueued. It is not sent until a delivery worker claims it — run `cli flush` or start the engine.');
      return 0;
    }

    default:
      console.error(`unknown command: ${command}\n`);
      console.log(USAGE);
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[mail-engine cli]', err?.message || err);
    process.exit(1);
  });
