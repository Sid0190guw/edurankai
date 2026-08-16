/**
 * scripts/mailops/migration-report.ts — compare two inventories and decide whether cutover is allowed.
 *
 *   npx tsx scripts/mailops/migration-report.ts --source inv-old.json --target inv-new.json
 *   npx tsx scripts/mailops/migration-report.ts --source a.json --target b.json \
 *       --migration zbook-to-dedicated --markdown report.md --report-to https://www.edurankai.in
 *
 * INVENTORY FILE FORMAT (produced by the migrate scripts, or by hand):
 *
 *   {
 *     "label": "ZBook maildirs, 2026-08-16",
 *     "takenAt": "2026-08-16T09:00:00Z",
 *     "counts":  { "messages": 12043, "mailboxes": 7, "folders": 41, "flags": 9021, "attachments": 318 },
 *     "perMailbox": { "sid@edurankai.in": { "messages": 8021, "folders": 12 } },
 *     "sampleChecksums": { "sid/INBOX/1234.eml": "sha256:..." }
 *   }
 *
 * WHY IT IS A SEPARATE STEP FROM THE COPY. A copy tool reports what it copied. That is the wrong
 * question: what matters is what is THERE afterwards, counted independently on both sides. rsync
 * exiting 0 is not evidence that the target has every folder — it is evidence that rsync did not
 * error, which is a much weaker statement and is the one people accept because it arrives first.
 *
 * EXIT CODES. 0 the report passed and cutover is allowed; 1 it did not; 2 bad arguments. So this can
 * gate a cutover script rather than being read and forgotten.
 */
import { readFile, writeFile } from 'node:fs/promises';
import {
  compareInventories,
  cutoverAllowed,
  migrationPlan,
  reportToMarkdown,
  type Inventory,
  type MigrationId,
} from '../../src/lib/mailops/migration.js';

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null;
}

async function loadInventory(path: string, which: string): Promise<Inventory> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e: any) {
    throw new Error(`Could not read the ${which} inventory at ${path}: ${e?.message || e}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (e: any) {
    throw new Error(`The ${which} inventory at ${path} is not valid JSON: ${e?.message || e}`);
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.counts) {
    throw new Error(`The ${which} inventory at ${path} has no "counts" object. An inventory with nothing counted proves nothing.`);
  }
  return {
    label: String(parsed.label || path),
    takenAt: String(parsed.takenAt || 'unknown'),
    counts: parsed.counts,
    perMailbox: parsed.perMailbox,
    sampleChecksums: parsed.sampleChecksums,
  };
}

async function main(): Promise<number> {
  const sourcePath = arg('source');
  const targetPath = arg('target');
  if (!sourcePath || !targetPath) {
    console.error('Usage: --source <inventory.json> --target <inventory.json> [--migration <id>] [--markdown <out.md>] [--json] [--report-to <base-url>]');
    return 2;
  }

  const source = await loadInventory(sourcePath, 'source');
  const target = await loadInventory(targetPath, 'target');
  const migrationId = arg('migration') as MigrationId | null;
  const plan = migrationId ? migrationPlan(migrationId) : undefined;

  if (migrationId && !plan) {
    console.error(`Unknown migration id: ${migrationId}`);
    return 2;
  }

  const report = compareInventories(source, target, { migrationId: migrationId ?? null });
  const gate = plan ? cutoverAllowed(plan, report) : null;

  if (arg('json') !== null || process.argv.includes('--json')) {
    console.log(JSON.stringify({ report, gate }, null, 2));
  } else {
    console.log(`Source: ${source.label}  (${source.takenAt})`);
    console.log(`Target: ${target.label}  (${target.takenAt})`);
    console.log('');
    const w = Math.max(...report.entities.map((e) => e.label.length), 10);
    for (const e of report.entities) {
      const mark = e.verdict === 'match' || e.verdict === 'within-tolerance' ? ' ok ' : 'FAIL';
      console.log(`[${mark}] ${e.label.padEnd(w)}  source ${String(e.source ?? '—').padStart(8)}  target ${String(e.target ?? '—').padStart(8)}  ${e.note}`);
    }
    if (report.mailboxDiffs.length) {
      console.log('');
      console.log(`${report.mailboxDiffs.length} per-mailbox difference(s):`);
      for (const d of report.mailboxDiffs.slice(0, 25)) {
        console.log(`  ${d.mailbox}  ${d.entity}: source ${d.source}, target ${d.target}`);
      }
      if (report.mailboxDiffs.length > 25) console.log(`  …and ${report.mailboxDiffs.length - 25} more`);
    }
    if (report.checksumMismatches.length) {
      console.log('');
      console.log('Content differences:');
      for (const c of report.checksumMismatches.slice(0, 25)) console.log(`  ${c}`);
    }
    console.log('');
    console.log(report.passed ? 'REPORT PASSED.' : 'REPORT DID NOT PASS.');
    if (gate) {
      console.log(gate.allowed
        ? `Cutover gate for "${plan!.title}": ALLOWED.`
        : `Cutover gate for "${plan!.title}": BLOCKED.`);
      for (const r of gate.reasons) console.log(`  - ${r}`);
      if (gate.allowed) {
        console.log(`  Keep the source reachable for ${plan!.soakDays} days after cutover. It is the rollback.`);
      }
    } else {
      console.log('No --migration given, so no cutover gate was evaluated. A passing report on its own is not permission.');
    }
  }

  const markdownPath = arg('markdown');
  if (markdownPath) {
    await writeFile(markdownPath, reportToMarkdown(report), 'utf8');
    console.log(`\nWrote ${markdownPath}`);
  }

  // Optional: file the report against the platform ledger so /admin/mail/continuity shows it.
  // Requires CRON_SECRET in the environment. Failure to report is logged and does NOT change the
  // exit code — the verification result is a fact about the migration, not about the network.
  const reportTo = arg('report-to');
  if (reportTo && migrationId) {
    const secret = (process.env.CRON_SECRET || '').trim();
    if (!secret) {
      console.error('\n--report-to given but CRON_SECRET is not set. The report was NOT filed.');
    } else {
      try {
        const res = await fetch(`${reportTo.replace(/\/+$/, '')}/api/mailops/report`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
          body: JSON.stringify({
            kind: 'migration',
            id: `${migrationId}-${report.generatedAt}`,
            migrationId,
            status: report.passed ? 'verified' : 'verifying',
            stage: 'verify',
            report,
            reportedBy: 'migration-report.ts',
          }),
        });
        console.log(res.ok ? '\nFiled to the continuity ledger.' : `\nCould not file the report: HTTP ${res.status}`);
      } catch (e: any) {
        console.error(`\nCould not file the report: ${e?.message || e}`);
      }
    }
  }

  return report.passed && (!gate || gate.allowed) ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e?.message || e);
    process.exit(2);
  });
