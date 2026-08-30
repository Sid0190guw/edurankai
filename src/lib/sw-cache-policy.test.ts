// src/lib/sw-cache-policy.test.ts — what the service worker is allowed to serve from cache.
//
// WHY THIS EXISTS. A candidate kept being shown the PRE-DEPLOY /apply/gateway after the fix for it
// had shipped, and no query string could clear it. public/sw.js falls back to the page cache when a
// navigation takes longer than 3.5s and matches with `ignoreSearch: true`, so on a slow connection
// the stale copy won every time. Worse, /invite/<token> signs the gate pass in a Set-Cookie HEADER:
// replaying it from cache hands back the HTML without the header, so Continue bounces the invited
// person straight back to the gate — our own cache re-creating the bug we had just fixed.
//
// THIS RUNS THE REAL FILE, it does not grep it. public/sw.js is copied verbatim to production and is
// compiled by nothing, so a text assertion would be the only other option and would pass on a file
// that no longer parses. The worker is loaded in a VM with a stubbed ServiceWorkerGlobalScope, its
// fetch listener is captured, and each path is put through it. A path the worker declines to handle
// never calls respondWith — that is exactly what "goes to the network, always" means.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script, createContext } from 'node:vm';

let fetchHandler: (e: any) => void;
let source: string;

beforeAll(() => {
  source = readFileSync(join(process.cwd(), 'public/sw.js'), 'utf8');
  const listeners: Record<string, (e: any) => void> = {};
  const noopPromise = () => Promise.resolve(undefined);
  const self: any = {
    addEventListener: (name: string, fn: (e: any) => void) => { listeners[name] = fn; },
    skipWaiting: () => {},
    clients: { claim: noopPromise, matchAll: () => Promise.resolve([]), openWindow: noopPromise },
    location: { origin: 'https://www.edurankai.in' },
    registration: { showNotification: noopPromise },
  };
  const ctx: any = {
    self,
    caches: {
      open: () => Promise.resolve({ put: noopPromise, addAll: noopPromise, match: noopPromise }),
      match: noopPromise,
      keys: () => Promise.resolve([]),
      delete: noopPromise,
    },
    // Never actually called in these assertions, but the handler closes over it.
    fetch: () => Promise.resolve({ ok: true, type: 'basic', clone: () => ({}) }),
    Response: class { constructor(public body?: any, public init?: any) {} },
    URL,
    setTimeout,
    clearTimeout,
    Promise,
    console,
  };
  ctx.globalThis = ctx;
  new Script(source).runInContext(createContext(ctx));
  fetchHandler = listeners.fetch;
  expect(typeof fetchHandler).toBe('function');
});

/** Put one GET navigation through the worker; true means the worker took it over (cached it). */
function handled(pathname: string, method = 'GET'): boolean {
  let took = false;
  fetchHandler({
    request: { url: 'https://www.edurankai.in' + pathname, method, mode: 'navigate' },
    respondWith: (p: any) => { took = true; if (p && p.catch) p.catch(() => {}); },
    waitUntil: () => {},
  });
  return took;
}

describe('the service worker never caches a credential flow', () => {
  // Each of these is a page whose correctness depends on something the cached HTML does not carry.
  it.each([
    ['/invite', 'the code entry page'],
    ['/invite/aBcD-token_123', 'signs the gate pass in a Set-Cookie header'],
    ['/apply', 'redirects by draft state'],
    ['/apply/gateway', 'redirects anyone already holding a pass'],
    ['/apply/step-1', 'a part-filled form'],
    ['/apply/confirmation', 'reached once, after submitting'],
    ['/onboarding', 'spends a single-use code'],
    ['/onboarding/form', 'a part-filled form'],
    ['/onboarding/submitted', 'reached once'],
  ])('goes to the network for %s (%s)', (path) => {
    expect(handled(path)).toBe(false);
  });

  it('still refuses the admin panel and the API, which is why those were never stale', () => {
    expect(handled('/admin')).toBe(false);
    expect(handled('/admin/applications/invitations')).toBe(false);
    expect(handled('/api/talent/gateway')).toBe(false);
  });

  // The exclusion must be surgical. Caching is what makes the site work offline, and a prefix that
  // swallowed ordinary pages would trade one bug for a worse one.
  it('still caches the ordinary pages the site is installed for', () => {
    for (const p of ['/', '/careers', '/careers/executive-assistant-to-ceo', '/ecosystem',
      '/portal/worklog', '/aquintutor/labs/flight-sim']) {
      expect(handled(p)).toBe(true);
    }
  });

  // A near-miss must not be caught by the prefix: these are different resources entirely.
  it('does not over-match paths that merely start with the same letters', () => {
    expect(handled('/applying-tips')).toBe(true);
    expect(handled('/invitations-policy')).toBe(true);
  });

  it('ignores non-GET entirely, so a form post is never answered from a cache', () => {
    expect(handled('/careers', 'POST')).toBe(false);
  });
});

describe('the cache version', () => {
  // Evicting the stale copies already on candidates' devices is the ONLY thing that clears them:
  // activate() deletes every cache not in `keep`. If the three names ever drift apart, one of the
  // three old caches survives the bump and keeps serving.
  it('is the same on all three cache names, or a bump leaves one behind', () => {
    const names = Array.from(source.matchAll(/'edurankai-(?:static-|pages-)?(v\d+)'/g)).map((m) => m[1]);
    expect(names.length).toBe(3);
    expect(new Set(names).size).toBe(1);
  });
});
