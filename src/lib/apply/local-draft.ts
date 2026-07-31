// src/lib/apply/local-draft.ts — the application draft, held on the applicant's own device.
//
// WHY LOCAL. A server-held draft is a shared mutable object with a schema the client cannot see,
// and on 2026-07-31 a bug in one step wrote the wrong shape over it, wiping step 1 and trapping
// live applicants in an endless step-1 -> step-2 loop with no way to submit. A draft is private
// working state; it belongs to the person filling the form, not to us. Keeping it on-device also
// means a half-finished application — which contains date of birth, family income, social handles
// — never reaches our servers unless the applicant actually submits.
//
// WHAT THIS COSTS, stated plainly because applicants must be warned:
//   - Clearing site data, or using private browsing, loses the draft.
//   - The draft does not follow them to another device or browser.
//   - Nothing can be recovered by support, because we do not have it.
//
// DESIGN. Pure functions over a plain object so the merge/validate logic is testable in Node with
// no browser. The storage binding is injected, which is what lets the tests run at all and would
// let the store move to IndexedDB later without touching any caller.

export const DRAFT_VERSION = 1;
export const DRAFT_KEY = 'era_apply_draft_v1';

export interface DraftEnvelope {
  v: number;
  updatedAt: string;
  roleSlug?: string;
  data: Record<string, any>;
}

/** The minimal storage surface used. localStorage satisfies it; tests pass a fake. */
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function emptyDraft(roleSlug = ''): DraftEnvelope {
  return { v: DRAFT_VERSION, updatedAt: new Date(0).toISOString(), roleSlug, data: {} };
}

/**
 * Read and validate. ANY problem returns an empty draft rather than throwing — a corrupt value in
 * localStorage (truncated write, another tab, a browser extension) must never make the application
 * form unusable. That failure mode is exactly what this module exists to prevent.
 */
export function readDraft(store: DraftStorage, key = DRAFT_KEY): DraftEnvelope {
  try {
    const raw = store.getItem(key);
    if (!raw) return emptyDraft();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyDraft();
    // A future version written by newer code is not safe to interpret with these rules.
    if (parsed.v !== DRAFT_VERSION) return emptyDraft();
    const data = parsed.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return emptyDraft();
    return {
      v: DRAFT_VERSION,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
      roleSlug: typeof parsed.roleSlug === 'string' ? parsed.roleSlug : '',
      data,
    };
  } catch {
    return emptyDraft();
  }
}

/**
 * Merge one step's values in and persist.
 *
 * Merges at the STEP level, never deep: a step owns its own object outright, so re-submitting a
 * step with a field cleared actually clears it. It also means one step can never reach into
 * another's data — the precise mistake that caused the outage.
 */
export function writeStep(
  store: DraftStorage,
  step: string,
  values: Record<string, any>,
  opts: { roleSlug?: string; key?: string; now?: () => Date } = {},
): DraftEnvelope {
  const key = opts.key || DRAFT_KEY;
  const current = readDraft(store, key);
  const next: DraftEnvelope = {
    v: DRAFT_VERSION,
    updatedAt: (opts.now ? opts.now() : new Date()).toISOString(),
    roleSlug: opts.roleSlug || current.roleSlug || '',
    data: { ...current.data, [step]: values },
  };
  try {
    store.setItem(key, JSON.stringify(next));
  } catch (e) {
    // Quota exceeded, or storage disabled entirely (Safari private browsing). Returning the value
    // anyway keeps the current page working; hasStorage() below is what warns the applicant.
  }
  return next;
}

export function clearDraft(store: DraftStorage, key = DRAFT_KEY): void {
  try { store.removeItem(key); } catch { /* nothing useful to do */ }
}

/** Which steps have been completed, for guards and the progress display. */
export function completedSteps(d: DraftEnvelope): string[] {
  return Object.keys(d.data).filter((k) => {
    const v = d.data[k];
    return !!v && typeof v === 'object' && Object.keys(v).length > 0;
  });
}

/**
 * The client-side equivalent of the old server guards: the first required step that is missing.
 * Returns null when everything up to `upTo` is present.
 */
export function firstMissingStep(d: DraftEnvelope, order: string[], upTo: string): string | null {
  const done = new Set(completedSteps(d));
  for (const s of order) {
    if (s === upTo) return null;
    if (!done.has(s)) return s;
  }
  return null;
}

/** Is persistent storage actually usable? False in private browsing or with storage disabled. */
export function hasStorage(store: DraftStorage | null | undefined): boolean {
  if (!store) return false;
  try {
    const probe = '__era_probe__';
    store.setItem(probe, '1');
    store.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/** Serialise for the single submit POST. This is the only time the draft leaves the device. */
export function toSubmitPayload(d: DraftEnvelope): string {
  return JSON.stringify({ v: d.v, roleSlug: d.roleSlug || '', data: d.data });
}

/**
 * Server-side counterpart: parse what the client posted.
 *
 * Treats the payload as UNTRUSTED. It arrives from the browser, so it is validated for shape and
 * capped for size — a draft is a handful of form fields, and anything far larger is either a bug or
 * an attempt to stuff the database through the application form.
 */
export function parseSubmitPayload(raw: unknown, maxBytes = 512_000): { ok: true; data: Record<string, any>; roleSlug: string } | { ok: false; error: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'No application data was received from your browser.' };
  if (raw.length > maxBytes) return { ok: false, error: 'The application data is too large to submit.' };
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, error: 'The application data could not be read.' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'The application data was not in the expected format.' };
  const data = parsed.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'The application data was empty.' };
  return { ok: true, data, roleSlug: typeof parsed.roleSlug === 'string' ? parsed.roleSlug : '' };
}
