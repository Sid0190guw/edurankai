// src/lib/test-shim.ts — describe/it/expect in the house style, so a test file reads like the
// hundreds already here and still runs with `npx tsx <file>`.
//
// The EIMS tests were written against vitest, which is not a dependency of this project and never
// has been: every other test in src/lib is a plain script with a hand-rolled ok() and an exit code.
// Adding a test runner to make two files compile would be a dependency taken on for the tooling's
// convenience rather than the product's. This shim is the smaller, honest answer.
//
// Failures are COUNTED, not thrown, so one bad assertion reports itself and the rest of the suite
// still runs. A thrown assertion hides every test after it, which is how a suite comes to report
// one failure when it has twelve.

let pass = 0;
let fail = 0;
let suite = '';

const show = (v: unknown): string => {
  try { return JSON.stringify(v); } catch { return String(v); }
};

const record = (name: string, good: boolean, detail?: string): void => {
  console.log((good ? '  ok  ' : 'FAIL  ') + name + (good || !detail ? '' : '  ' + detail));
  if (good) pass++; else fail++;
};

export function describe(name: string, fn: () => void): void {
  suite = name;
  console.log('\n== ' + name + ' ==');
  fn();
  suite = '';
}

export function it(name: string, fn: () => void): void {
  const label = suite ? suite + ' — ' + name : name;
  try {
    fn();
    // A test that made no assertion still counts as run; its own expects reported themselves.
  } catch (e: any) {
    record(label, false, 'threw: ' + (e?.message || String(e)));
  }
}

type Matchers = {
  toBe: (x: unknown) => void;
  toEqual: (x: unknown) => void;
  toBeNull: () => void;
  toBeCloseTo: (x: number, digits?: number) => void;
  toBeGreaterThan: (x: number) => void;
  toBeGreaterThanOrEqual: (x: number) => void;
  toBeLessThan: (x: number) => void;
  toBeLessThanOrEqual: (x: number) => void;
  toContain: (x: any) => void;
  toHaveLength: (n: number) => void;
  toMatch: (re: RegExp | string) => void;
  not: Omit<Matchers, 'not'>;
};

function build(actual: any, negate: boolean, label?: string): any {
  const check = (good: boolean, what: string) => {
    const ok = negate ? !good : good;
    const described = (label ? label + ': ' : '') + (negate ? 'not ' : '') + what;
    record(described, ok, ok ? undefined : 'got ' + show(actual));
  };
  return {
    toBe: (x: unknown) => check(Object.is(actual, x), 'is ' + show(x)),
    toEqual: (x: unknown) => check(show(actual) === show(x), 'equals ' + show(x)),
    toBeNull: () => check(actual === null, 'is null'),
    toBeCloseTo: (x: number, digits = 2) =>
      check(Math.abs(Number(actual) - x) < Math.pow(10, -digits) / 2, 'is close to ' + x),
    toBeGreaterThan: (x: number) => check(Number(actual) > x, 'is greater than ' + x),
    toBeGreaterThanOrEqual: (x: number) =>
      check(Number(actual) >= x, 'is at least ' + x),
    toBeLessThan: (x: number) => check(Number(actual) < x, 'is less than ' + x),
    toBeLessThanOrEqual: (x: number) =>
      check(Number(actual) <= x, 'is at most ' + x),
    toContain: (x: any) =>
      check(Array.isArray(actual) ? actual.includes(x) : String(actual).includes(String(x)),
        'contains ' + show(x)),
    toHaveLength: (n: number) => check(actual?.length === n, 'has length ' + n),
    toMatch: (re: RegExp | string) =>
      check(typeof re === 'string' ? String(actual).includes(re) : re.test(String(actual)),
        'matches ' + String(re)),
  };
}

/**
 * `expect(value)` or `expect(value, 'what this case is')`.
 *
 * THE SECOND ARGUMENT EXISTS BECAUSE SUITES WERE ALREADY PASSING ONE. Vitest accepts a label there,
 * so a test written against Vitest and later moved onto this shim compiles fine at runtime — JS
 * ignores the extra argument — and fails `tsc` with "Expected 1 arguments, but got 2". Four such
 * call sites appeared in notify-audience.test.ts, in a loop over eleven notification types where
 * the label is the ONLY thing distinguishing one assertion from the next.
 *
 * Dropping the labels would have typechecked and made the failure output useless. Accepting them
 * and printing them makes the two runners agree and the output better, so that is what this does.
 */
export function expect(actual: any, label?: string): Matchers {
  const m = build(actual, false, label);
  m.not = build(actual, true, label);
  return m as Matchers;
}

/** Call at the end of a test file. Exits non-zero on any failure so CI cannot pass a red suite. */
export function report(): void {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail > 0) process.exit(1);
}

process.on('exit', (code) => {
  if (code === 0 && fail > 0) process.exit(1);
});
