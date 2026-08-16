export function splitSql(text) {
  const out = [];
  let buf = '';
  let i = 0;
  let inSingle = false;
  let inLineComment = false;
  let dollarTag = null;

  while (i < text.length) {
    const ch = text[i];
    const rest = text.slice(i);

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      buf += ch; i++; continue;
    }
    if (dollarTag) {
      if (rest.startsWith(dollarTag)) { buf += dollarTag; i += dollarTag.length; dollarTag = null; continue; }
      buf += ch; i++; continue;
    }
    if (inSingle) {
      if (ch === "'" && text[i + 1] === "'") { buf += "''"; i += 2; continue; }
      if (ch === "'") { inSingle = false; }
      buf += ch; i++; continue;
    }
    if (ch === '-' && text[i + 1] === '-') { inLineComment = true; buf += ch; i++; continue; }
    if (ch === "'") { inSingle = true; buf += ch; i++; continue; }

    const dollar = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(rest);
    if (dollar) { dollarTag = dollar[0]; buf += dollarTag; i += dollarTag.length; continue; }

    if (ch === ';') { out.push(buf); buf = ''; i++; continue; }
    buf += ch; i++;
  }
  out.push(buf);

  // Drop anything that is only whitespace and comments — an empty statement is a syntax error.
  return out
    .map((s) => s.trim())
    .filter((s) => s && s.split('\n').some((l) => l.trim() && !l.trim().startsWith('--')));
}
