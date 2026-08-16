/**
 * scripts/mailops/generate-runbooks-doc.ts — render docs/mail/RUNBOOKS.md from the runbook module.
 *
 *   npx tsx scripts/mailops/generate-runbooks-doc.ts
 *   npx tsx scripts/mailops/generate-runbooks-doc.ts --check      # CI-style: fail if out of date
 *
 * WHY GENERATE IT. The runbooks live in src/lib/mailops/runbooks.ts because that is what the admin
 * surface renders, and an operator mid-incident should not have to clone a repository. But a
 * printable copy is genuinely useful — the one incident where the admin console is unreachable is
 * the one where you need the database runbook. Two hand-maintained copies would drift, and the half
 * that drifts is always the one nobody is looking at. So: one source, one generator.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { RUNBOOKS, allRunbooksMarkdown, decisionPoints } from '../../src/lib/mailops/runbooks.js';

const OUT = 'docs/mail/RUNBOOKS.md';

const header = `# Mail disaster-recovery runbooks

<!-- GENERATED FILE. Do not edit by hand.
     Source: src/lib/mailops/runbooks.ts
     Regenerate: npx tsx scripts/mailops/generate-runbooks-doc.ts
     The same content renders on /admin/mail/continuity, which is where you should read it during an
     incident — this copy exists for the case where the admin console is the thing that is down. -->

Nine runbooks, six sections each, in the same order every time: **Detection, Containment, Recovery,
Verification, Rollback, Post-incident.** The section that gets dropped when runbooks are written as
prose is always Rollback, and it is the one you need most at the moment you need any of them.

Steps marked **[FOUNDER DECISION]** are hard or impossible to undo. There are ${RUNBOOKS.reduce((n, rb) => n + decisionPoints(rb).length, 0)} of them
across these runbooks, and they are the steps most likely to be taken quickly by somebody trying to
be helpful.

Two house rules these follow:

- **No step opens the production database.** Where a database action is genuinely required, the step
  hands over a command for a human to run.
- **Every Verification section checks a surface, not an exit code.** Reported success and observable
  result have diverged on this project often enough that it is a rule rather than a preference.

| Runbook | Trigger | Time |
| --- | --- | --- |
${RUNBOOKS.map((rb) => `| [${rb.title}](#${rb.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}) | ${rb.trigger} | ~${rb.expectedMinutes} min |`).join('\n')}

---

`;

async function main(): Promise<number> {
  const content = header + allRunbooksMarkdown() + '\n';

  if (process.argv.includes('--check')) {
    const existing = await readFile(OUT, 'utf8').catch(() => null);
    if (existing === content) {
      console.log(`${OUT} is up to date.`);
      return 0;
    }
    console.error(`${OUT} is out of date with src/lib/mailops/runbooks.ts. Regenerate it:`);
    console.error('  npx tsx scripts/mailops/generate-runbooks-doc.ts');
    return 1;
  }

  await writeFile(OUT, content, 'utf8');
  console.log(`Wrote ${OUT} (${RUNBOOKS.length} runbooks, ${content.split('\n').length} lines).`);
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e?.message || e); process.exit(1); });
