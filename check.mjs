import { splitSql } from './split.mjs';
import { readFileSync } from 'node:fs';
const files = ['db/mail-platform-schema.sql','db/mail-saas-schema.sql','db/mail-automation-schema.sql'];
let bad = 0;
for (const f of files) {
  const stmts = splitSql(readFileSync(f,'utf8'));
  const broken = stmts.filter(s => (s.match(/\$mp\$/g)||[]).length % 2 !== 0);
  const empty  = stmts.filter(s => !s.trim());
  console.log(`${f}: ${stmts.length} statements, ${broken.length} with unbalanced $mp$, ${empty.length} empty`);
  if (broken.length || empty.length) bad++;
  for (const s of stmts) {
    if (!/^(CREATE|ALTER|INSERT|DO|COMMENT|DROP|GRANT|SET)/i.test(s.replace(/^(--[^\n]*\n|\s)+/,''))) {
      console.log('   ODD START >', s.replace(/\s+/g,' ').slice(0,90)); bad++;
    }
  }
}
// The trigger body must survive as ONE statement with its inner semicolons intact.
const plat = splitSql(readFileSync('db/mail-platform-schema.sql','utf8'));
const fn = plat.find(s => /CREATE OR REPLACE FUNCTION mp_touch_updated_at/.test(s));
console.log('\ntrigger function kept whole:', !!fn && /RETURN NEW;/.test(fn) && /LANGUAGE plpgsql/.test(fn));
const doBlock = plat.find(s => /^DO \$mp\$/m.test(s.trim()));
console.log('DO block kept whole:        ', !!doBlock && /END\s*\$mp\$/.test(doBlock));
process.exit(bad ? 1 : 0);
