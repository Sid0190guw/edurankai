// src/lib/era-export.test.ts — the browser-side export helper, tested by loading the shipped file.
//
// public/era/era-export.js is served to every admin page by AdminLayout and is the helper anyone
// adding an export button reaches for next. It had the same gap the server exporters had: it quoted
// for commas and let a leading `=` through. There is no build step in front of it, so the only way
// to know the shipped file is correct is to run the shipped file.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let escapeCSV: (v: unknown) => string;

beforeAll(() => {
  // The file is an IIFE that hangs itself off a global. Give it one, run it, take the function back
  // out — no bundler, no mock of its internals, the actual bytes that reach a browser.
  const src = readFileSync(resolve(process.cwd(), 'public/era/era-export.js'), 'utf8');
  const fakeGlobal: any = {};
  const fakeDocument: any = {
    readyState: 'complete',
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => ({ style: {}, click() {}, setAttribute() {} }),
    body: { appendChild() {}, removeChild() {} },
  };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'Blob', 'URL', src)(
    fakeGlobal,
    fakeDocument,
    class {},
    { createObjectURL: () => '', revokeObjectURL: () => {} },
  );
  escapeCSV = fakeGlobal.ERA.export._escape;
});

describe('era-export escapeCSV', () => {
  it('is reachable for testing at all', () => {
    expect(typeof escapeCSV).toBe('function');
  });

  it('neutralises the characters a spreadsheet reads as a formula', () => {
    expect(escapeCSV('=HYPERLINK("http://evil","x")')).toContain("'=HYPERLINK");
    expect(escapeCSV('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)");
    expect(escapeCSV("=cmd|' /C calc'!A0")).toBe("'=cmd|' /C calc'!A0");
    expect(escapeCSV("-2+3+cmd|' /C calc'!A0")).toBe("'-2+3+cmd|' /C calc'!A0");
  });

  it('leaves real numbers alone, so a column of money still adds up', () => {
    expect(escapeCSV('-1500')).toBe('-1500');
    expect(escapeCSV('-0.4')).toBe('-0.4');
    expect(escapeCSV('+1500')).toBe('+1500');
    expect(escapeCSV(-1500)).toBe('-1500');
  });

  it('still quotes for the ordinary reasons', () => {
    expect(escapeCSV('Kumar, Ananya')).toBe('"Kumar, Ananya"');
    expect(escapeCSV('say "hi"')).toBe('"say ""hi"""');
  });

  it('renders an empty value as empty rather than as the word null', () => {
    expect(escapeCSV(null)).toBe('');
    expect(escapeCSV(undefined)).toBe('');
  });
});
