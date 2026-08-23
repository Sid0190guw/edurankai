// scripts/horizon-check.mjs — PATCH 20's GATE. Run it; do not take its word for it.
//
//   npx tsx scripts/horizon-check.mjs           print the report
//   npx tsx scripts/horizon-check.mjs --json    machine-readable, for CI
//   npx tsx scripts/horizon-check.mjs --strict  exit 1 on a blocking finding
//
// WHAT IT PROVES AND WHAT IT DOES NOT.
//
// It reads the repository. It opens no database, exactly as this project's working rules require, so
// it establishes which tables the codebase INTENDS to exist rather than which ones do. It cannot
// prove a flow works end to end; the report says so on every item it cannot check, rather than
// leaving a reader to assume a blank means a pass.
//
// STRICT MODE FAILS ON TWO THINGS ONLY: a file that does not parse, and a duplicate store of a
// canonical concept with no stated reason. It deliberately does NOT fail on "unfinished" — this
// build is unfinished by design at this stage, and a gate that fails on incompleteness is a gate
// somebody turns off in week one.

import { horizonIntegrationReport, blockingFindings, VERDICT_LABELS, MODULE_STATE_LABELS } from '../src/lib/horizon/integration/index.ts';

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
const strict = args.has('--strict');

const report = await horizonIntegrationReport();

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const line = (s = '') => console.log(s);
  const rule = () => line('-'.repeat(96));

  line();
  line('HORIZON INTEGRATION REPORT   ' + report.collectedAt);
  rule();
  line('VERDICT: ' + VERDICT_LABELS[report.verdict].toUpperCase());
  line(wrap(report.headline, 96));
  line();

  const c = report.counts;
  line('MODULES   ' + c.total + ' declared  |  ' + c.reachable + ' reachable  '
    + c.implemented + ' implemented-unwired  ' + c.contractOnly + ' contract-only  '
    + c.absent + ' not started' + (c.unreadable ? '  ' + c.unreadable + ' unreadable' : ''));
  line('TABLES    ' + c.tables + ' declared  |  ' + c.duplicateDefects + ' unjustified duplicate store(s)');
  line();

  rule();
  line('MODULE STATUS');
  rule();
  for (const m of report.modules) {
    const tag = String(m.entry.patch).padStart(2, '0');
    const state = MODULE_STATE_LABELS[m.state].padEnd(24);
    line('P' + tag + '  ' + state + m.entry.title + (m.misplaced ? '   [outside src/lib/horizon]' : ''));
    line('      ' + wrap(m.sentence, 90, '      '));
    if (m.tableDrift.declaredUnexpected.length) {
      line('      tables not in the map: ' + m.tableDrift.declaredUnexpected.join(', '));
    }
  }
  line();

  if (report.duplicates.length) {
    rule();
    line('CANONICAL CONCEPT OWNERSHIP');
    rule();
    for (const d of report.duplicates) {
      const mark = d.severity === 'defect' ? 'DEFECT   ' : 'by design';
      line(mark + '  ' + d.conceptLabel + ': ' + d.duplicateTable + '  (canonical: ' + d.canonicalTable + ')');
      line('           ' + wrap(d.sentence, 84, '           '));
    }
    line();
  }

  if (report.unclassifiedTables.length) {
    line('UNCLASSIFIED TABLES (nobody has said which concept these belong to):');
    for (const t of report.unclassifiedTables) line('  ' + t);
    line();
  }

  if (report.parseFailures.length) {
    rule();
    line('FILES THAT DO NOT PARSE');
    rule();
    for (const p of report.parseFailures) line('  ' + p.file + ':' + p.line + '  ' + p.detail);
    line();
  }

  rule();
  line('DEFINITION OF DONE');
  rule();
  for (const d of report.dod) {
    const mark = d.met === true ? '[x]' : d.met === false ? '[ ]' : '[?]';
    line(mark + ' ' + d.label);
    line('    ' + wrap(d.detail, 90, '    '));
  }
  line();
  line('[x] proven by this run   [ ] disproven by this run   [?] needs a live run; not claimed either way');
  line();
}

const blocking = blockingFindings(report);
if (blocking.length && !asJson) {
  console.log('BLOCKING FINDINGS (' + blocking.length + '):');
  for (const b of blocking) console.log('  ' + b);
  console.log();
}

if (strict && blocking.length) process.exit(1);

function wrap(text, width, indent = '') {
  const words = String(text || '').split(/\s+/);
  const out = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur.length + 1 + w.length) > width) { out.push(cur); cur = w; }
    else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) out.push(cur);
  return out.join('\n' + indent);
}
