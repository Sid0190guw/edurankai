// src/lib/csv.ts — the one CSV cell writer for exports that are not the mail platform's.
//
// WHY THIS FILE EXISTS
//
// Every CSV exporter in this repo had written its own `escapeCSV`, and the copies agreed on the
// part that is obvious (quote a field containing a comma, a quote or a newline) and were silent on
// the part that is not: a spreadsheet reads a cell beginning with `=`, `+`, `-` or `@` as a
// FORMULA. An applicant who types `=HYPERLINK("http://evil","Payroll")` into the name field on
// /apply is not filling in a name, they are writing code that runs on the machine of whoever opens
// the export. Quoting does not help — CSV quotes are stripped when the file is parsed, so
// `"=cmd|..."` still reaches the cell as `=cmd|...`.
//
// The defence is a leading apostrophe, which every spreadsheet reads as "the rest of this cell is
// text". It is visible in the cell, and that is the honest trade: the alternative is either
// silently deleting characters out of somebody's data or shipping the formula.
//
// WHY THIS IS NOT `csvCell` FROM `src/lib/mail-csv.ts`
//
// That one guards a leading `-` unconditionally, which is right for contact text — an organisation
// name starting with a hyphen is not arithmetic anybody sums. The exports here carry MONEY and
// SCORES: a payroll deduction of -1500 and a CGPA delta of -0.4 arrive from postgres-js as the
// STRINGS "-1500" and "-0.4" (numeric columns are not converted), and prefixing those with an
// apostrophe turns the accountant's column into text and breaks the SUM at the bottom of it.
//
// So a value that is a finite number is written through untouched. That is safe, not a compromise:
// a formula needs an operator, a function name or a bang, and every one of those makes Number()
// return NaN. `-1500` parses; `-2+3+cmd|' /C calc'!A0` does not, and is quoted.
//
// The mail platform keeps its own copy on purpose — those modules are owned contracts.

/** Characters a spreadsheet reads as the start of a formula, plus the two control characters that
 *  can be used to slip past a naive check on them. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** True for a string a spreadsheet would treat as a plain number rather than an expression. */
function isPlainNumber(s: string): boolean {
  return s.trim() !== '' && Number.isFinite(Number(s));
}

/**
 * Render one value as a CSV field: formula-guarded, then quoted if it needs to be.
 *
 * Dates become ISO 8601 and objects become JSON, because both otherwise stringify to something a
 * reader cannot get the original value back out of ("[object Object]").
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';

  let s: string;
  if (value instanceof Date) s = value.toISOString();
  else if (typeof value === 'object') s = JSON.stringify(value);
  else s = String(value);

  if (FORMULA_START.test(s) && !isPlainNumber(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** One row. Values are rendered in the order given. */
export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(',');
}

/**
 * A whole file from row objects and an explicit column list.
 *
 * The BOM is what makes a spreadsheet open UTF-8 correctly instead of mojibake on a name, and CRLF
 * is what the CSV RFC asks for; both matter more here than they look, because the readers of these
 * files are Excel on Windows.
 */
export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const head = columns.map(csvCell).join(',');
  const body = rows.map((r) => columns.map((c) => csvCell(r[c])).join(','));
  return '﻿' + [head, ...body].join('\r\n') + '\r\n';
}
