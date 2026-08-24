// THE QUEUE/WORKER COVERAGE GATE.
//
// THE DEFECT. src/lib/mailplatform enqueued four job kinds into edu_jobs — mp.send_message,
// mp.campaign_batch, mp.webhook_delivery, mp.workflow_step — and the worker's registry knew about
// none of them. processJobs() claimed each one, found no handler, and called fail(), which retries
// with backoff until max_attempts and then parks the job in `failed`.
//
// From outside, that looked like success. The API answered 202. The row really was written. Then it
// died over the next few hours in a table nobody reads. A scheduled message never sent. A campaign
// sent its first batch inline and never sent the second — indistinguishable, on screen, from a
// campaign that finished.
//
// The gate below scans the repository for enqueue() call sites and fails if any names a kind the
// registry cannot process. It is a source scan rather than a hand-maintained list because a list is
// wrong the moment somebody adds a queue call in a module nobody thought to update — which is
// precisely how the four went missing.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HANDLERS, HANDLED_KINDS, hasHandler } from '@/lib/job-handlers';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '.git' || name === '.astro') continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * Every literal job kind handed to an enqueue() call.
 *
 * Matches `enqueue('kind'` and `.enqueue('kind'` so both the direct helper and the QueueProvider
 * interface are covered. A kind built from a variable is invisible here — that is a real limit, and
 * it is why the mp.* handlers also validate their payload rather than trusting the dispatch.
 */
/**
 * Memoised, because the scan reads 2,389 files and two tests want the answer.
 *
 * THIS TEST TIMED OUT ON A CLEAN CHECKOUT. Vitest's per-test bound is 5s, and walking `src` and
 * `scripts` and reading every .ts/.tsx/.astro in them takes most of that on a cold filesystem — so
 * doing it twice put the second test over. It never showed up in a warm working tree, where the OS
 * cache makes the same walk a few hundred milliseconds, which is why it shipped: the failure needs a
 * checkout nobody has read yet, and that is precisely what CI and a fresh clone are.
 *
 * The scan is pure — same files, same answer — so computing it once is not a behaviour change. It
 * halves the I/O and takes the whole file comfortably under the bound.
 */
let cachedKinds: Map<string, string[]> | null = null;
function enqueuedKinds(): Map<string, string[]> {
  if (cachedKinds) return cachedKinds;
  cachedKinds = scanEnqueuedKinds();
  return cachedKinds;
}

function scanEnqueuedKinds(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const re = /\.?enqueue(?:<[^>]*>)?\s*\(\s*'([^']+)'/g;
  for (const dir of ['src', 'scripts']) {
    for (const f of walk(join(ROOT, dir))) {
      if (!/\.(ts|tsx|astro)$/.test(f)) continue;
      const rel = relative(ROOT, f).split('\\').join('/');
      // The queue's own implementation and its adapters pass the kind straight through; they are
      // plumbing, not call sites, and their generic parameter names are not job kinds.
      if (rel === 'src/lib/job-queue.ts') continue;
      if (rel === 'src/lib/mailplatform/adapters/queue-postgres.ts') continue;
      if (/\.test\.tsx?$/.test(rel)) continue;
      let src: string;
      try { src = readFileSync(f, 'utf8'); } catch { continue; }
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(src)) !== null) {
        const kind = m[1];
        // ReadableStream controllers also have an enqueue(); those take bytes, not a kind string,
        // so anything that does not look like a job kind is skipped rather than reported.
        if (!/^[a-z][a-z0-9._-]*$/i.test(kind) || kind.length > 60) continue;
        if (!found.has(kind)) found.set(kind, []);
        found.get(kind)!.push(rel);
      }
    }
  }
  return found;
}

describe('every enqueued job kind has a worker', () => {
  it('finds the enqueue call sites at all', () => {
    const kinds = enqueuedKinds();
    expect(kinds.size).toBeGreaterThan(0);
    // The four that were orphaned. If the scan stops seeing them the scan is broken, not fixed.
    for (const k of ['mp.send_message', 'mp.campaign_batch', 'mp.webhook_delivery', 'mp.workflow_step']) {
      expect([...kinds.keys()], `${k} is no longer detected as enqueued`).toContain(k);
    }
  });

  it('NO kind is enqueued without a handler', () => {
    const kinds = enqueuedKinds();
    const orphaned = [...kinds.entries()].filter(([kind]) => !hasHandler(kind));
    if (orphaned.length) {
      const lines = orphaned.map(([kind, files]) => `  '${kind}'  enqueued by ${files.join(', ')}`);
      throw new Error(
        `${orphaned.length} job kind(s) are enqueued with no worker able to process them:\n${lines.join('\n')}\n\n` +
        'processJobs() will claim each one, fail it with "no handler", retry it to exhaustion and\n' +
        'park it in `failed`. The caller sees a successful enqueue and never learns otherwise.\n' +
        'Add a handler to HANDLERS in src/lib/job-handlers.ts, or stop enqueueing the kind.',
      );
    }
    expect(orphaned).toEqual([]);
  });

  it('the four mail-platform kinds are registered', () => {
    for (const k of ['mp.send_message', 'mp.campaign_batch', 'mp.webhook_delivery', 'mp.workflow_step']) {
      expect(hasHandler(k), `${k} has no handler`).toBe(true);
      expect(typeof HANDLERS[k]).toBe('function');
    }
  });

  it('the original notification kinds still work', () => {
    for (const k of ['notify', 'notify-guardians', 'push']) {
      expect(hasHandler(k), `${k} regressed`).toBe(true);
    }
  });

  it('HANDLED_KINDS matches the registry', () => {
    expect([...HANDLED_KINDS].sort()).toEqual(Object.keys(HANDLERS).sort());
  });

  it('hasHandler does not answer true for an inherited property', () => {
    // `HANDLERS['toString']` is a function on every object. A naive truthiness check would report a
    // handler for a job kind called "toString" and then crash the worker on it.
    expect(hasHandler('toString')).toBe(false);
    expect(hasHandler('constructor')).toBe(false);
    expect(hasHandler('nonexistent-kind')).toBe(false);
  });
});
