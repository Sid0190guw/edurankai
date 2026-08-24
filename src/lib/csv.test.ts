// src/lib/csv.test.ts — the formula guard is the point of this module, so it is what is tested.
import { describe, it, expect } from 'vitest';
import { csvCell, csvRow, toCsv } from '@/lib/csv';

describe('csvCell — formula injection', () => {
  it('neutralises the four characters a spreadsheet reads as a formula', () => {
    expect(csvCell('=HYPERLINK("http://evil","Payroll")')).toBe('"\'=HYPERLINK(""http://evil"",""Payroll"")"');
    expect(csvCell('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)");
    expect(csvCell('=cmd|\' /C calc\'!A0')).toBe("'=cmd|' /C calc'!A0");
    expect(csvCell('-2+3+cmd|\' /C calc\'!A0')).toBe("'-2+3+cmd|' /C calc'!A0");
    expect(csvCell('+cmd|\' /C calc\'!A0')).toBe("'+cmd|' /C calc'!A0");
  });

  it('guards the control characters used to slip past a naive leading-character check', () => {
    expect(csvCell('\t=1+1')).toBe("'\t=1+1");
    expect(csvCell('\r=1+1')).toBe('"\'\r=1+1"');
  });

  it('leaves real negative and signed numbers as numbers', () => {
    // postgres-js hands numeric columns back as strings, so this is the payroll case exactly:
    // quoting these would turn the accountant's column into text and break the total under it.
    expect(csvCell('-1500')).toBe('-1500');
    expect(csvCell('-1500.00')).toBe('-1500.00');
    expect(csvCell('-0.4')).toBe('-0.4');
    expect(csvCell('+1500')).toBe('+1500');
    expect(csvCell(-1500)).toBe('-1500');
    expect(csvCell('-1e5')).toBe('-1e5');
  });

  it('still quotes for the ordinary reasons', () => {
    expect(csvCell('Kumar, Ananya')).toBe('"Kumar, Ananya"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('quotes AND guards when a value needs both', () => {
    expect(csvCell('=A1,B1')).toBe('"\'=A1,B1"');
  });

  it('renders empties, dates and objects so a reader can get the value back', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell('')).toBe('');
    expect(csvCell(new Date('2026-08-24T00:00:00.000Z'))).toBe('2026-08-24T00:00:00.000Z');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });
});

describe('csvRow / toCsv', () => {
  it('writes a row in column order', () => {
    expect(csvRow(['Ananya', '=1+1', 8.4])).toBe("Ananya,'=1+1,8.4");
  });

  it('writes a BOM and CRLF so Excel on Windows opens it correctly', () => {
    const out = toCsv([{ name: '=evil', score: '-4' }], ['name', 'score']);
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out).toContain('\r\n');
    expect(out).toContain("'=evil,-4");
  });

  it('emits a header-only file for no rows rather than an empty one', () => {
    expect(toCsv([], ['name'])).toBe('﻿name\r\n');
  });

  it('renders a missing column as empty, not as the string undefined', () => {
    expect(toCsv([{ name: 'Ananya' }], ['name', 'absent'])).toContain('Ananya,\r\n');
  });
});
