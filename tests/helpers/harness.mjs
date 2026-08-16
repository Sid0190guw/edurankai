// tests/helpers/harness.mjs — the test harness for everything that needs a running stack.
//
// WHY NOT VITEST. The suites under tests/ are not unit tests; they drive a live system over SMTP,
// IMAP and HTTP, they take minutes, and they must be runnable from a shell script on a machine that
// has not run `npm install` in the repository (a deploy host, the ZBook after a restore). Vitest is
// the right tool for src/**/*.test.ts and is used there. This is deliberately a different layer.
//
// THE PROPERTY THAT MATTERS MOST: SKIP IS NOT PASS.
//
// An integration suite that cannot reach the system it tests must not report success. That is the
// single most common way a test suite becomes decorative — it "passes" in CI for six months while
// every case silently no-ops because a service was never started. So:
//   - a suite that cannot reach its dependencies reports SKIPPED, loudly, with the reason;
//   - the runner's exit code is non-zero if anything was skipped, unless --allow-skip is passed;
//   - the summary always prints the skip count first when it is non-zero.
//
// Assertions carry a `because` string. "expected 200, got 403" tells you what happened;
// "because an unauthenticated caller must not reach the send API" tells you what it meant.

export class SkipSuite extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'SkipSuite';
  }
}

const tty = process.stdout.isTTY;
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const colour = {
  green: (s) => paint('32', s),
  red: (s) => paint('31', s),
  yellow: (s) => paint('33', s),
  dim: (s) => paint('2', s),
  bold: (s) => paint('1', s),
};

export class Suite {
  constructor(name, description = '') {
    this.name = name;
    this.description = description;
    this.cases = [];
  }

  test(name, fn) {
    this.cases.push({ name, fn });
    return this;
  }

  async run(ctx) {
    const results = [];
    process.stdout.write(`\n${colour.bold(this.name)}${this.description ? colour.dim('  ' + this.description) : ''}\n`);

    if (this.before) {
      try {
        await this.before(ctx);
      } catch (e) {
        if (e instanceof SkipSuite) {
          process.stdout.write(`  ${colour.yellow('SKIPPED')} ${e.message}\n`);
          return this.cases.map((c) => ({ suite: this.name, name: c.name, state: 'skipped', reason: e.message }));
        }
        // A setup that fails for any other reason is a FAILURE, not a skip. "Could not prepare the
        // fixture" is a real defect and must not be laundered into a yellow line.
        process.stdout.write(`  ${colour.red('SETUP FAILED')} ${e.message}\n`);
        return this.cases.map((c) => ({ suite: this.name, name: c.name, state: 'failed', reason: `setup failed: ${e.message}` }));
      }
    }

    for (const c of this.cases) {
      const t0 = Date.now();
      try {
        await c.fn(ctx);
        const ms = Date.now() - t0;
        results.push({ suite: this.name, name: c.name, state: 'passed', ms });
        process.stdout.write(`  ${colour.green('pass')}  ${c.name} ${colour.dim(ms + 'ms')}\n`);
      } catch (e) {
        const ms = Date.now() - t0;
        if (e instanceof SkipSuite) {
          results.push({ suite: this.name, name: c.name, state: 'skipped', reason: e.message });
          process.stdout.write(`  ${colour.yellow('skip')}  ${c.name} ${colour.dim('— ' + e.message)}\n`);
          continue;
        }
        results.push({ suite: this.name, name: c.name, state: 'failed', reason: e.message, ms });
        process.stdout.write(`  ${colour.red('FAIL')}  ${c.name}\n        ${colour.red(e.message)}\n`);
      }
    }

    if (this.after) {
      try { await this.after(ctx); } catch (e) {
        process.stdout.write(`  ${colour.yellow('cleanup failed')} ${e.message}\n`);
      }
    }
    return results;
  }
}

// --- assertions ------------------------------------------------------------------------------------
// Every one takes `because`: the sentence that says why this mattered. It is not optional padding —
// it is what a person reads at 2am when the assertion fires.

export function assert(condition, because) {
  if (!condition) throw new Error(because);
}

export function assertEqual(actual, expected, because) {
  if (actual !== expected) throw new Error(`${because}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
}

export function assertStatus(response, expected, because) {
  if (response.status !== expected) {
    throw new Error(`${because}\n        expected HTTP ${expected}, got ${response.status} from ${response.url}`);
  }
}

export function assertIncludes(haystack, needle, because) {
  if (!String(haystack).includes(needle)) {
    throw new Error(`${because}\n        looked for: ${JSON.stringify(needle)}\n        in: ${String(haystack).slice(0, 400)}`);
  }
}

export function assertNotIncludes(haystack, needle, because) {
  if (String(haystack).includes(needle)) {
    throw new Error(`${because}\n        found forbidden content: ${JSON.stringify(needle)}`);
  }
}

/**
 * Poll until a condition holds. Mail is asynchronous everywhere — queued, relayed, retried — so a
 * test that asserts immediately after a send is testing the speed of the machine it runs on. Every
 * cross-service assertion in these suites goes through here.
 */
export async function waitFor(fn, { timeoutMs = 30_000, intervalMs = 500, because = 'condition never became true' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`${because} (waited ${timeoutMs}ms)${lastError ? `\n        last error: ${lastError.message}` : ''}`);
}

/** fetch with a timeout, because a hung request in a test suite looks identical to a slow one. */
export async function http(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs || 15_000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, redirect: init.redirect || 'manual' });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON, keep the text */ }
    return { status: res.status, headers: res.headers, text, json, url, ok: res.ok };
  } finally {
    clearTimeout(timer);
  }
}

/** Assert a service is reachable, or skip the whole suite with a reason a person can act on. */
export async function requireService(url, name, hint) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    // Any answer proves the service is up. 401/403/404 are answers.
    if (res.status >= 500) throw new Error(`answered HTTP ${res.status}`);
    return true;
  } catch (e) {
    throw new SkipSuite(`${name} is not reachable at ${url} (${e.message}). ${hint || ''}`);
  }
}

export function summarise(results, { allowSkip = false } = {}) {
  const passed = results.filter((r) => r.state === 'passed').length;
  const failed = results.filter((r) => r.state === 'failed');
  const skipped = results.filter((r) => r.state === 'skipped');

  process.stdout.write('\n' + '-'.repeat(72) + '\n');
  if (skipped.length) {
    // First, and in colour: a skipped suite is the thing most likely to be mistaken for coverage.
    process.stdout.write(`${colour.yellow(`${skipped.length} SKIPPED`)} — these guarantees were NOT tested:\n`);
    const reasons = new Map();
    for (const s of skipped) {
      const key = s.reason || 'no reason given';
      reasons.set(key, (reasons.get(key) || 0) + 1);
    }
    for (const [reason, count] of reasons) process.stdout.write(`  ${colour.dim(`${count} case(s):`)} ${reason}\n`);
    process.stdout.write('\n');
  }
  if (failed.length) {
    process.stdout.write(`${colour.red(`${failed.length} FAILED`)}\n`);
    for (const f of failed) process.stdout.write(`  ${f.suite} > ${f.name}\n`);
    process.stdout.write('\n');
  }
  process.stdout.write(`${colour.green(`${passed} passed`)}, ${failed.length ? colour.red(`${failed.length} failed`) : '0 failed'}, ${skipped.length ? colour.yellow(`${skipped.length} skipped`) : '0 skipped'}\n\n`);

  if (failed.length) return 1;
  // Skips are a failure of the RUN, not of the code — but they must not read as success.
  if (skipped.length && !allowSkip) {
    process.stdout.write(colour.yellow('Exiting non-zero because cases were skipped. Start the stack, or pass --allow-skip if that is genuinely what you want.\n\n'));
    return 2;
  }
  return 0;
}
