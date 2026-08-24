// scripts/sql-split.mjs — split a .sql file into the statements to send, one at a time.
//
// EXTRACTED FROM apply-sql.mjs SO IT CAN BE TESTED WITHOUT A DATABASE ANYWHERE NEAR IT.
// See src/lib/sql-split.test.ts. It could not be tested in place: apply-sql.mjs connects and
// executes at module scope, so importing it to reach the function would run a migration.
//
// THE BUG THIS REWRITE FIXES, WHICH WAS LIVE AND SILENT.
//
// The previous version scanned line by line and split the accumulated buffer at the END of any line
// where it was not inside a quote or a dollar-quoted block:
//
//     buf += stripped + '\n';
//     if (!inSingle && !inDollar) {
//       while ((idx = buf.indexOf(';')) !== -1) { out.push(buf.slice(0, idx)); ... }
//     }
//
// Tracking `inDollar` was correct, and while it was true no split happened — but the semicolons
// inside the block were still piling up in `buf`. The moment the block CLOSED, that `while` loop
// went back and split on every one of them retroactively. So
//
//     DO $$ BEGIN ... ALTER TABLE ...; END IF; EXCEPTION WHEN others THEN RAISE NOTICE ...; END $$;
//
// arrived as FOUR statements: the block up to its first semicolon, then `END IF`, then
// `EXCEPTION WHEN others THEN RAISE NOTICE ...`, then `END $$`. The first is an unterminated
// PL/pgSQL body and the other three are not statements at all. Every one fails.
//
// apply-sql.mjs runs statements independently and continues past failures, so the visible result is
// a migration that reports "26 ok, 4 FAIL" and looks like it mostly worked. It did not: whatever the
// DO block was there to do — add a constraint, guard a backfill, skip work on a database that does
// not have the table — silently did not happen.
//
// Eight files in db/ contain a dollar-quoted block, including org-graph-rollback.sql and
// workflow-rollback.sql. Those are the two you reach for in the middle of an incident.
//
// THE FIX: split where the semicolon actually is, at the moment it is read, instead of deferring the
// decision to the end of a line and then re-examining text that was already decided.

/**
 * Split SQL text into executable statements.
 *
 * - `--` line comments are stripped, except inside a string or a dollar-quoted body.
 * - Semicolons inside `'...'` and inside `$$...$$` / `$tag$...$tag$` do NOT split.
 * - A doubled quote (`''`) needs no special case: it toggles off and straight back on.
 * - Trailing text with no final semicolon is returned as a statement.
 */
export function splitStatements(text) {
  const out = [];
  let buf = '';
  let inSingle = false;
  let inDollar = false;
  let dollarTag = '';
  let inLineComment = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inLineComment) {
      // Keep the newline so statements stay readable when they are echoed back to the operator.
      if (ch === '\n') { inLineComment = false; buf += '\n'; }
      continue;
    }

    if (!inSingle && !inDollar && ch === '-' && text[i + 1] === '-') {
      inLineComment = true;
      i++;
      continue;
    }

    if (!inDollar && ch === "'") {
      inSingle = !inSingle;
      buf += ch;
      continue;
    }

    if (!inSingle && ch === '$') {
      const m = /^\$[A-Za-z_0-9]*\$/.exec(text.slice(i));
      if (m) {
        if (!inDollar) { inDollar = true; dollarTag = m[0]; }
        else if (m[0] === dollarTag) { inDollar = false; dollarTag = ''; }
        buf += m[0];
        i += m[0].length - 1;
        continue;
      }
    }

    // The only place a statement ends. Inside a string or a dollar body this is just a character.
    if (ch === ';' && !inSingle && !inDollar) {
      const stmt = buf.trim();
      if (stmt) out.push(stmt);
      buf = '';
      continue;
    }

    buf += ch;
  }

  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}
