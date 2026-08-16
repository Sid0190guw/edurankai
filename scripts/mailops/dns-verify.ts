/**
 * scripts/mailops/dns-verify.ts — what is ACTUALLY published, asked of several resolvers.
 *
 *   npx tsx scripts/mailops/dns-verify.ts --domain edurankai.in
 *   npx tsx scripts/mailops/dns-verify.ts --domain edurankai.in --resolvers 1.1.1.1,8.8.8.8,9.9.9.9
 *   npx tsx scripts/mailops/dns-verify.ts --domain edurankai.in --dkim-selectors era1,era2 --json
 *
 * WHY SEVERAL RESOLVERS. Your own resolver is the one most likely to be holding a stale answer, or
 * a locally overridden one, and it is the one you will instinctively use. A record that looks right
 * from your desk and wrong from Cloudflare is the normal shape of a DNS incident, and a single
 * lookup cannot tell you that is what is happening.
 *
 * IT ONLY READS. Nothing in this repository writes DNS; see AUTOMATION_POLICY in
 * src/lib/mailops/dns-cutover.ts for why that is a decision rather than an omission.
 *
 * EXIT CODES. 0 every expectation met, 1 something is wrong, 2 bad arguments. So it can be a cron
 * check later without being reinterpreted.
 */
import { Resolver } from 'node:dns/promises';

interface Args {
  domain: string;
  resolvers: string[];
  dkimSelectors: string[];
  mxHost: string | null;
  spfInclude: string | null;
  json: boolean;
  timeoutMs: number;
}

function parseArgs(argv: string[]): Args {
  const get = (n: string): string | null => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  const csv = (v: string | null, fallback: string[]): string[] =>
    v ? v.split(',').map((s) => s.trim()).filter(Boolean) : fallback;

  return {
    domain: (get('domain') || process.env.MAIL_DOMAIN || '').trim(),
    resolvers: csv(get('resolvers'), ['1.1.1.1', '8.8.8.8', '9.9.9.9']),
    dkimSelectors: csv(get('dkim-selectors'), [process.env.MAIL_DKIM_SELECTOR || 'era1']),
    mxHost: get('expect-mx'),
    spfInclude: get('expect-spf-include'),
    json: argv.includes('--json'),
    timeoutMs: Number(get('timeout-ms') || 5000),
  };
}

interface Answer {
  resolver: string;
  values: string[];
  error: string | null;
}

interface Finding {
  check: string;
  host: string;
  type: string;
  /** One entry per resolver, so disagreement is visible rather than averaged away. */
  answers: Answer[];
  /** true = every resolver agreed and the expectation held. */
  ok: boolean;
  note: string;
}

function makeResolver(ip: string, timeoutMs: number): Resolver {
  const r = new Resolver({ timeout: timeoutMs, tries: 2 });
  r.setServers([ip]);
  return r;
}

async function lookup(
  resolvers: string[],
  timeoutMs: number,
  fn: (r: Resolver) => Promise<string[]>,
): Promise<Answer[]> {
  return Promise.all(
    resolvers.map(async (ip) => {
      try {
        return { resolver: ip, values: (await fn(makeResolver(ip, timeoutMs))).sort(), error: null };
      } catch (e: any) {
        // ENOTFOUND / ENODATA are ANSWERS, not failures of the tool: they mean the record is not
        // published. Reporting them as errors would make a missing SPF record look like a network
        // problem, which is the wrong thing to go and investigate.
        const code = String(e?.code || '');
        if (code === 'ENOTFOUND' || code === 'ENODATA') return { resolver: ip, values: [], error: null };
        return { resolver: ip, values: [], error: `${code || 'lookup failed'}: ${e?.message || e}` };
      }
    }),
  );
}

function agree(answers: Answer[]): boolean {
  const usable = answers.filter((a) => !a.error);
  if (usable.length < 2) return true; // cannot disagree with yourself
  const first = JSON.stringify(usable[0].values);
  return usable.every((a) => JSON.stringify(a.values) === first);
}

function firstValues(answers: Answer[]): string[] {
  return answers.find((a) => !a.error)?.values || [];
}

/**
 * Every resolver failed, so we learned nothing.
 *
 * THIS IS THE DISTINCTION THE WHOLE SCRIPT TURNS ON. A lookup that timed out and a record that is
 * not published both produce an empty answer, and reporting the first as the second is the same
 * mistake as a mail screen drawing "0 inbound" over a thrown query. "No SPF record" sends somebody
 * to the registrar to add one that is already there; "could not be determined" sends them to look
 * at the network, which is where the problem is.
 */
function unresolved(answers: Answer[]): boolean {
  return answers.length > 0 && answers.every((a) => !!a.error);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.domain) {
    console.error('Pass --domain <name> (or set MAIL_DOMAIN).');
    return 2;
  }

  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);

  // -- MX --------------------------------------------------------------------
  const mx = await lookup(args.resolvers, args.timeoutMs, async (r) =>
    (await r.resolveMx(args.domain)).map((m) => `${m.priority} ${m.exchange}`),
  );
  const mxValues = firstValues(mx);
  add({
    check: 'MX',
    host: args.domain,
    type: 'MX',
    answers: mx,
    ok: mxValues.length > 0 && agree(mx) && (!args.mxHost || mxValues.some((v) => v.includes(args.mxHost!))),
    note: mxValues.length === 0
      ? 'No MX published. Nobody can send mail to this domain at all.'
      : !agree(mx)
        ? 'Resolvers disagree — a change is mid-propagation, or one resolver is holding a stale answer.'
        : args.mxHost && !mxValues.some((v) => v.includes(args.mxHost!))
          ? `Published MX does not include the expected host ${args.mxHost}.`
          : 'Published and consistent.',
  });

  // The MX target must be an A/AAAA record, never a CNAME. This is invalid per RFC 5321 and some
  // senders refuse it outright — a failure that shows up as "some mail bounces" and nothing else.
  for (const value of mxValues.slice(0, 3)) {
    const host = value.split(/\s+/)[1];
    if (!host) continue;
    const cname = await lookup(args.resolvers, args.timeoutMs, (r) => r.resolveCname(host));
    const a = await lookup(args.resolvers, args.timeoutMs, (r) => r.resolve4(host));
    add({
      check: 'MX target resolves',
      host,
      type: 'A',
      answers: a,
      ok: firstValues(a).length > 0 && firstValues(cname).length === 0,
      note: firstValues(cname).length > 0
        ? 'The MX target is a CNAME. That is invalid for an MX target and some senders refuse it.'
        : firstValues(a).length === 0
          ? 'The MX target does not resolve to an address.'
          : 'Resolves to an address.',
    });
  }

  // -- SPF -------------------------------------------------------------------
  const txt = await lookup(args.resolvers, args.timeoutMs, async (r) =>
    (await r.resolveTxt(args.domain)).map((chunks) => chunks.join('')),
  );
  const spf = firstValues(txt).filter((v) => v.toLowerCase().startsWith('v=spf1'));
  add({
    check: 'SPF',
    host: args.domain,
    type: 'TXT',
    answers: txt,
    ok: spf.length === 1 && (!args.spfInclude || spf[0].includes(args.spfInclude)),
    note: spf.length === 0
      ? 'No SPF record. Mail from this domain will be treated as unauthenticated by most receivers.'
      : spf.length > 1
        ? `${spf.length} SPF records published. More than one is a permanent error and receivers treat SPF as broken entirely.`
        : args.spfInclude && !spf[0].includes(args.spfInclude)
          ? `SPF does not authorise ${args.spfInclude}. Mail sent from that host will fail authentication.`
          : 'One SPF record, as required.',
  });

  // -- DKIM ------------------------------------------------------------------
  for (const selector of args.dkimSelectors) {
    const host = `${selector}._domainkey.${args.domain}`;
    const dk = await lookup(args.resolvers, args.timeoutMs, async (r) =>
      (await r.resolveTxt(host)).map((chunks) => chunks.join('')),
    );
    const values = firstValues(dk);
    const hasKey = values.some((v) => /(^|;)\s*p=[A-Za-z0-9+/=]/.test(v));
    const revoked = values.some((v) => /(^|;)\s*p=\s*(;|$)/.test(v));
    add({
      check: `DKIM ${selector}`,
      host,
      type: 'TXT',
      answers: dk,
      ok: hasKey,
      note: values.length === 0
        ? 'Not published. Mail signed with this selector will fail DKIM at every receiver.'
        : revoked
          ? 'Published with an EMPTY p= value, which is the revocation form. If this selector was retired deliberately, that is correct.'
          : hasKey
            ? 'Public key published.'
            : 'Published but does not contain a usable p= value. Registrars sometimes re-quote or truncate long TXT values.',
    });
  }

  // -- DMARC -----------------------------------------------------------------
  const dmarcHost = `_dmarc.${args.domain}`;
  const dmarc = await lookup(args.resolvers, args.timeoutMs, async (r) =>
    (await r.resolveTxt(dmarcHost)).map((chunks) => chunks.join('')),
  );
  const dmarcValues = firstValues(dmarc).filter((v) => v.toLowerCase().startsWith('v=dmarc1'));
  add({
    check: 'DMARC',
    host: dmarcHost,
    type: 'TXT',
    answers: dmarc,
    ok: dmarcValues.length === 1,
    note: dmarcValues.length === 0
      ? 'No DMARC record. Nothing reports on mail sent as this domain, so a DKIM key compromise leaves no evidence trail.'
      : dmarcValues.length > 1
        ? 'More than one DMARC record. Receivers treat that as no policy at all.'
        : /rua=/.test(dmarcValues[0])
          ? 'Published with an aggregate report address.'
          : 'Published, but with no rua= address, so no aggregate reports are being sent anywhere.',
  });

  // Nothing above may report "absent" on the strength of a failed lookup. Applied once, here, so a
  // new check added later inherits it rather than having to remember.
  for (const f of findings) {
    if (!unresolved(f.answers)) continue;
    f.ok = false;
    f.note = `NOT DETERMINED — every resolver failed (${f.answers[0].error}). This is a lookup failure, not evidence that the record is absent. Check the network path to the resolvers before touching any DNS record.`;
  }

  // -- output ----------------------------------------------------------------
  if (args.json) {
    console.log(JSON.stringify({ domain: args.domain, resolvers: args.resolvers, findings }, null, 2));
  } else {
    console.log(`DNS verification for ${args.domain}`);
    console.log(`Resolvers: ${args.resolvers.join(', ')}`);
    console.log('');
    for (const f of findings) {
      console.log(`${f.ok ? '[ ok ]' : '[FAIL]'} ${f.check}  (${f.type} ${f.host})`);
      console.log(`        ${f.note}`);
      for (const a of f.answers) {
        if (a.error) console.log(`        ${a.resolver}: lookup error — ${a.error}`);
        else if (!a.values.length) console.log(`        ${a.resolver}: (no record)`);
        else for (const v of a.values) console.log(`        ${a.resolver}: ${v.length > 120 ? `${v.slice(0, 117)}...` : v}`);
      }
      console.log('');
    }
    const bad = findings.filter((f) => !f.ok);
    const undetermined = findings.filter((f) => unresolved(f.answers));
    if (undetermined.length === findings.length) {
      console.log('NOTHING WAS DETERMINED. Every lookup failed, so this run says nothing about the DNS records at all.');
    } else {
      console.log(bad.length ? `${bad.length} check(s) failed: ${bad.map((f) => f.check).join(', ')}` : 'All checks passed.');
      if (undetermined.length) console.log(`${undetermined.length} of those could not be determined rather than being wrong.`);
    }
    console.log('');
    console.log('A record being present is not the same as it validating. Send a message to an external mailbox and');
    console.log('read the Authentication-Results header before concluding that mail authentication works.');
  }

  return findings.some((f) => !f.ok) ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('dns-verify failed:', e?.message || e);
    process.exit(1);
  });
