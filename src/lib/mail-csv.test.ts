import { describe, it, expect } from 'vitest';
import {
  parseCsv, detectDelimiter, autoMap, isValidEmail, coerceStatus, splitTags,
  validateRow, planImport, csvCell, toCsv, findDuplicateGroups, customKey, normalizeHeader,
} from '@/lib/mail-csv';

describe('parseCsv', () => {
  it('reads a plain file', () => {
    const p = parseCsv('email,first_name\na@x.com,Ana\nb@x.com,Bo\n');
    expect(p.headers).toEqual(['email', 'first_name']);
    expect(p.rows.map((r) => r.cells)).toEqual([['a@x.com', 'Ana'], ['b@x.com', 'Bo']]);
  });

  it('strips a UTF-8 BOM, so the email column still maps', () => {
    const p = parseCsv('﻿email,name\na@x.com,Ana\n');
    expect(p.headers[0]).toBe('email');
    expect(autoMap(p.headers)[0].field).toBe('email');
  });

  it('handles quoted fields, doubled quotes and embedded commas', () => {
    const p = parseCsv('email,org\na@x.com,"Rao, Sharma & Co"\nb@x.com,"He said ""hi"""\n');
    expect(p.rows[0].cells[1]).toBe('Rao, Sharma & Co');
    expect(p.rows[1].cells[1]).toBe('He said "hi"');
  });

  it('handles an embedded newline inside quotes', () => {
    const p = parseCsv('email,notes\na@x.com,"line one\nline two"\nb@x.com,plain\n');
    expect(p.rows).toHaveLength(2);
    expect(p.rows[0].cells[1]).toBe('line one\nline two');
  });

  it('handles CRLF', () => {
    const p = parseCsv('email\r\na@x.com\r\nb@x.com\r\n');
    expect(p.rows.map((r) => r.cells[0])).toEqual(['a@x.com', 'b@x.com']);
  });

  it('detects semicolon and tab delimiters', () => {
    expect(detectDelimiter('email;name')).toBe(';');
    expect(detectDelimiter('email\tname')).toBe('\t');
    expect(detectDelimiter('email')).toBe(',');
  });

  it('KEEPS a ragged row and reports it rather than throwing the file away', () => {
    const p = parseCsv('email,a,b\nx@x.com,1,2\ny@x.com,1,2,3\n');
    expect(p.rows).toHaveLength(2);
    expect(p.ragged).toEqual([{ line: 3, got: 4, expected: 3 }]);
  });

  it('drops blank trailing lines', () => {
    expect(parseCsv('email\na@x.com\n\n\n').rows).toHaveLength(1);
  });

  it('reports the real line number for error messages', () => {
    const p = parseCsv('email\na@x.com\n"multi\nline"\nc@x.com\n');
    expect(p.rows[2].line).toBe(5);
  });
});

describe('column mapping', () => {
  it('maps common aliases', () => {
    const m = autoMap(['E-mail Address', 'Given Name', 'Surname', 'Company', 'Mobile']);
    expect(m.map((x) => x.field)).toEqual(['email', 'first_name', 'last_name', 'organization', 'phone']);
  });

  it('splits a single Name column on the LAST space', () => {
    const m = autoMap(['email', 'Name']);
    expect(m[1].field).toBe('__fullname');
    const r = validateRow(['a@x.com', 'Ananya Devi Rao'], m, 2);
    expect(r.contact!.first_name).toBe('Ananya Devi');
    expect(r.contact!.last_name).toBe('Rao');
  });

  it('never silently drops an unknown column — it becomes a custom field', () => {
    const m = autoMap(['email', 'University Attended']);
    expect(m[1].field).toBe('custom:university_attended');
  });

  it('does not map two columns onto the same field', () => {
    const m = autoMap(['email', 'Email Address']);
    expect(m[0].field).toBe('email');
    expect(m[1].field).toBe('custom:email_address');
  });

  it('normalizes headers and slugs custom keys', () => {
    expect(normalizeHeader(' E-Mail_Address ')).toBe('emailaddress');
    expect(customKey('University Attended!')).toBe('university_attended');
  });
});

describe('email validation', () => {
  it('accepts ordinary addresses', () => {
    for (const e of ['a@x.com', 'first.last+tag@sub.domain.co.in', "o'brien@x.org"]) {
      expect(isValidEmail(e), e).toBe(true);
    }
  });

  it('rejects the shapes that actually turn up in spreadsheets', () => {
    for (const e of ['', 'nope', 'a@', '@x.com', 'a b@x.com', 'a@@x.com', 'a@x', 'a..b@x.com', '.a@x.com', 'a@-x.com', 'a@x..com', 'a@x.c1']) {
      expect(isValidEmail(e), e).toBe(false);
    }
  });
});

describe('status and tags', () => {
  it('coerces the words spreadsheets actually contain', () => {
    expect(coerceStatus('')).toBe('subscribed');
    expect(coerceStatus('Yes')).toBe('subscribed');
    expect(coerceStatus('opted out')).toBe('unsubscribed');
    expect(coerceStatus('FALSE')).toBe('unsubscribed');
    expect(coerceStatus('Hard Bounce')).toBe('bounced');
    expect(coerceStatus('spam')).toBe('complained');
  });

  it('splits, lower-cases and de-duplicates tags', () => {
    expect(splitTags('Intern; IITG |intern')).toEqual(['intern', 'iitg']);
  });
});

describe('row validation', () => {
  const m = autoMap(['email', 'first_name', 'status', 'tags', 'Consent Source']);

  it('rejects a row with no address', () => {
    const r = validateRow(['', 'Ana', '', '', ''], m, 2);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('No email');
  });

  it('rejects an unusable address and names it', () => {
    const r = validateRow(['not-an-email', 'Ana', '', '', ''], m, 2);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('not-an-email');
  });

  it('lower-cases and trims the address', () => {
    expect(validateRow(['  A@X.COM ', '', '', '', ''], m, 2).contact!.email).toBe('a@x.com');
  });

  it('warns about a subscribed contact with no consent source', () => {
    const r = validateRow(['a@x.com', 'Ana', 'yes', '', ''], m, 2);
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toContain('consent source');
  });

  it('warns when a row imports as unsubscribed', () => {
    const r = validateRow(['a@x.com', 'Ana', 'opted out', '', 'form'], m, 2);
    expect(r.contact!.status).toBe('unsubscribed');
    expect(r.warnings.join(' ')).toContain('excluded from every campaign');
  });

  it('keeps an unreadable date as a warning rather than an error', () => {
    const mm = autoMap(['email', 'Consent Date']);
    const r = validateRow(['a@x.com', 'sometime last year'], mm, 2);
    expect(r.ok).toBe(true);
    expect(r.contact!.consent_at).toBeNull();
    expect(r.warnings.join(' ')).toContain('not a date');
  });

  it('reads dd/mm/yyyy, which Date.parse gets wrong or refuses', () => {
    const mm = autoMap(['email', 'Consent Date']);
    const r = validateRow(['a@x.com', '20/08/2026'], mm, 2);
    expect(r.contact!.consent_at!.slice(0, 10)).toBe('2026-08-20');
  });
});

describe('planImport', () => {
  it('separates valid from invalid and counts the file', () => {
    const plan = planImport('email,first_name\na@x.com,Ana\nbroken,Bo\nc@x.com,Cy\n');
    expect(plan.totalRows).toBe(3);
    expect(plan.valid.map((v) => v.email)).toEqual(['a@x.com', 'c@x.com']);
    expect(plan.invalid).toHaveLength(1);
    expect(plan.invalid[0].line).toBe(3);
  });

  it('DEDUPLICATES inside the file and merges the later row into the first', () => {
    const plan = planImport([
      'email,first_name,organization,phone',
      'a@x.com,Ana,,',
      'A@X.COM,,IITG,+91 99',
      'b@x.com,Bo,,',
    ].join('\n'));
    expect(plan.valid).toHaveLength(2);
    expect(plan.duplicatesInFile).toEqual([{ line: 3, email: 'a@x.com', firstSeenLine: 2 }]);
    const a = plan.valid.find((v) => v.email === 'a@x.com')!;
    expect(a.first_name).toBe('Ana');
    expect(a.organization).toBe('IITG');
    expect(a.phone).toBe('+91 99');
  });

  it('lets the MOST RESTRICTIVE status win across duplicate rows', () => {
    const plan = planImport('email,status\na@x.com,subscribed\na@x.com,unsubscribed\n');
    expect(plan.valid[0].status).toBe('unsubscribed');
  });

  it('does not let a later subscribed row overturn an earlier unsubscribe', () => {
    const plan = planImport('email,status\na@x.com,unsubscribed\na@x.com,subscribed\n');
    expect(plan.valid[0].status).toBe('unsubscribed');
  });

  it('unions tags across duplicate rows', () => {
    const plan = planImport('email,tags\na@x.com,intern\na@x.com,iitg\n');
    expect(plan.valid[0].tags.sort()).toEqual(['iitg', 'intern']);
  });

  it('honours an overridden mapping', () => {
    const plan = planImport('col1,col2\na@x.com,Ana\n', [{ header: 'col1', field: 'email' }, { header: 'col2', field: 'first_name' }]);
    expect(plan.valid[0].first_name).toBe('Ana');
  });

  it('handles a large file without losing rows', () => {
    const lines = ['email,first_name'];
    for (let i = 0; i < 20000; i++) lines.push('user' + i + '@example.org,User' + i);
    const plan = planImport(lines.join('\n'));
    expect(plan.valid).toHaveLength(20000);
    expect(plan.invalid).toHaveLength(0);
  });
});

describe('export', () => {
  it('quotes what needs quoting', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe('');
  });

  it('neutralises a formula so an export cannot execute in a spreadsheet', () => {
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('@handle')).toBe("'@handle");
    expect(csvCell('-5')).toBe("'-5");
  });

  it('writes a BOM and CRLF so Excel opens UTF-8 names correctly', () => {
    const out = toCsv([{ email: 'a@x.com', name: 'Ananya' }], ['email', 'name']);
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out).toContain('\r\n');
  });

  it('round-trips through the parser', () => {
    const csv = toCsv([{ email: 'a@x.com', org: 'Rao, Sharma "and" Co' }], ['email', 'org']);
    const back = parseCsv(csv);
    expect(back.rows[0].cells).toEqual(['a@x.com', 'Rao, Sharma "and" Co']);
  });
});

describe('duplicate detection across records', () => {
  it('groups the same name at the same organisation', () => {
    const g = findDuplicateGroups([
      { id: '1', email: 'a@x.com', first_name: 'Ananya', last_name: 'Rao', organization: 'IIT Guwahati' },
      { id: '2', email: 'a@y.com', first_name: 'ananya', last_name: 'rao', organization: 'IIT  Guwahati' },
      { id: '3', email: 'b@x.com', first_name: 'Bo', last_name: 'Li', organization: 'IIT Guwahati' },
    ]);
    expect(g.filter((x) => x.reason === 'name+organization')).toHaveLength(1);
    expect(g[0].members.map((m) => m.id).sort()).toEqual(['1', '2']);
  });

  it('groups on the last ten digits of a phone number', () => {
    const g = findDuplicateGroups([
      { id: '1', email: 'a@x.com', phone: '+91 98765 43210' },
      { id: '2', email: 'b@x.com', phone: '098765-43210' },
    ]);
    expect(g.some((x) => x.reason === 'phone')).toBe(true);
  });

  it('does not group on a short or missing name', () => {
    expect(findDuplicateGroups([
      { id: '1', email: 'a@x.com', first_name: 'A', organization: 'X' },
      { id: '2', email: 'b@x.com', first_name: 'A', organization: 'X' },
    ])).toHaveLength(0);
  });
});
