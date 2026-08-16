/**
 * scripts/gen-failure-modes-doc.ts — regenerate docs/mail-failure-modes.md from the catalogue.
 *
 *   npx tsx scripts/gen-failure-modes-doc.ts
 *
 * WHY GENERATED. §10 asks for documented expected behaviour. Documentation written by hand next to
 * code rots, silently and quickly, and a failure-mode document that has drifted is worse than none
 * — it is read during an incident, when nobody has time to check it against the source.
 *
 * src/lib/mailplatform/failure-modes.ts is the single source of truth. It is typed, it is asserted
 * by tests (every non-implemented entry must name its gap), and this script renders it. Edit the TS
 * file and re-run; never edit the Markdown.
 */
import { writeFileSync } from 'node:fs';
import { FAILURE_MODES, coverage, type FailureMode } from '../src/lib/mailplatform/failure-modes';

const DEP_LABEL: Record<string, string> = {
  database: 'Database', redis: 'Redis', queue: 'Queue', smtp: 'SMTP', worker: 'Worker',
  mta: 'MTA', network: 'Network', supabase_api: 'Supabase API', vercel_api: 'Vercel API', storage: 'Storage',
};
const STATUS_LABEL: Record<string, string> = {
  implemented: '**Implemented**',
  partial: '**Partial**',
  intended: '**Intended only**',
};

function section(f: FailureMode): string {
  const lines: string[] = [];
  lines.push(`### \`${f.id}\` — ${f.scenario}`);
  lines.push('');
  lines.push(`| | |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Dependency | ${DEP_LABEL[f.dependency] ?? f.dependency} |`);
  lines.push(`| Status | ${STATUS_LABEL[f.status] ?? f.status} |`);
  lines.push('');
  lines.push(`**Expected.** ${f.expected}`);
  lines.push('');
  lines.push(`**Must not happen.** ${f.mustNot}`);
  lines.push('');
  if (f.gap) {
    lines.push(`**Gap.** ${f.gap}`);
    lines.push('');
  }
  lines.push(`**Reproduce.** ${f.reproduce}`);
  lines.push('');
  lines.push(`**Where it lives.** ${f.evidence.map((e) => '`' + e + '`').join(', ')}`);
  lines.push('');
  return lines.join('\n');
}

function render(): string {
  const c = coverage();
  const byDep = new Map<string, FailureMode[]>();
  for (const f of FAILURE_MODES) {
    if (!byDep.has(f.dependency)) byDep.set(f.dependency, []);
    byDep.get(f.dependency)!.push(f);
  }

  const out: string[] = [];
  out.push('# Mail failure modes');
  out.push('');
  out.push('> **Generated file — do not edit.** The source of truth is');
  out.push('> `src/lib/mailplatform/failure-modes.ts`, which is typed and asserted by tests');
  out.push('> (`analysis.test.ts` enforces that every entry which is not fully implemented names its');
  out.push('> gap). Regenerate with `npx tsx scripts/gen-failure-modes-doc.ts`.');
  out.push('');
  out.push('The rule behind every entry below:');
  out.push('');
  out.push('> **A dependency failure may DELAY mail or REFUSE mail. It must never silently lose mail,');
  out.push('> and it must never report a success it did not have.**');
  out.push('');
  out.push('That second half is not hypothetical here. A send that failed at the SMTP layer once left');
  out.push('no trace at all, because the log INSERT threw into an empty catch — and the reading pane');
  out.push('claimed delivery. See the note in `src/lib/mail.ts` around `email_logs.rfc_message_id`.');
  out.push('');
  out.push('## Coverage');
  out.push('');
  out.push(`| Status | Count |`);
  out.push(`| --- | --- |`);
  out.push(`| Implemented | ${c.implemented} |`);
  out.push(`| Partial | ${c.partial} |`);
  out.push(`| Intended only | ${c.intended} |`);
  out.push(`| **Total** | **${c.total}** |`);
  out.push('');
  out.push(`**${c.percentImplemented}% fully implemented.** The remainder are listed with their gaps, and`);
  out.push('are rendered as an open work list on `/admin/mail/performance`. A catalogue that flatters');
  out.push('itself is worse than no catalogue.');
  out.push('');
  out.push('---');
  out.push('');

  for (const [dep, modes] of byDep) {
    out.push(`## ${DEP_LABEL[dep] ?? dep}`);
    out.push('');
    for (const m of modes) out.push(section(m));
    out.push('---');
    out.push('');
  }

  out.push('## Testing these');
  out.push('');
  out.push('Failures that can be simulated in a unit test already are — deferrals not tripping the');
  out.push('circuit breaker, a node dying mid-campaign, the event buffer surviving a failing sink.');
  out.push('See `src/lib/mailplatform/mta-pool.test.ts` and `events.test.ts`.');
  out.push('');
  out.push('Failures that need a real dependency (database down, SMTP refusing, storage unreachable)');
  out.push('are reproduced with the `Reproduce` line on each entry, **against staging with a throwaway');
  out.push('database**. Never against production, and never with a load generator pointed at anything');
  out.push('but a reserved test domain — `src/lib/mailplatform/loadgen.ts` throws rather than filtering');
  out.push('if you try.');
  out.push('');
  return out.join('\n');
}

const target = new URL('../docs/mail-failure-modes.md', import.meta.url);
writeFileSync(target, render());
console.log('wrote docs/mail-failure-modes.md — ' + FAILURE_MODES.length + ' failure modes, ' + coverage().percentImplemented + '% fully implemented');
