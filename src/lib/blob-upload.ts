// src/lib/blob-upload.ts — the ONE bounded way this codebase uploads to Vercel Blob.
//
// WHY THIS FILE EXISTS: SEVENTEEN MINUTES OF RETRYING, INSIDE ONE REQUEST.
//
// `put()` from @vercel/blob takes its retry count from the environment and defaults it to TEN
// (node_modules/@vercel/blob/dist/chunk-WLMB4XQD.js, getRetries: `process.env.VERCEL_BLOB_RETRIES ||
// "10"`). That number is handed to async-retry, whose own defaults (node_modules/retry/lib/retry.js)
// are factor 2, minTimeout 1000ms and maxTimeout **Infinity** — so the backoff runs
// 1, 2, 4, 8, 16, 32, 64, 128, 256, 512 seconds. About seventeen minutes of retrying inside a single
// serverless invocation, on top of each attempt's own fetch, which had no timeout either because no
// call site passed an abortSignal.
//
// None of that is reachable. The platform kills the function long before, so the retries buy nothing
// and the caller learns nothing: the upload neither succeeds nor reports a failure it could show
// somebody. It is the same shape as the database problem this incident was about — an unbounded wait
// dressed up as resilience — and it sat on seven routes, including the profile photo and the ID
// document, which is the face-2FA enrolment src/middleware.ts forces EVERY signed-in user through.
//
// TWO BOUNDS, BECAUSE ONE IS NOT ENOUGH:
//
//   abortSignal bounds the operation. It is a real `put()` option (it is documented on every method
//   in @vercel/blob's own .d.ts) and it aborts the in-flight request.
//
//   VERCEL_BLOB_RETRIES bounds the RETRYING. It is NOT a per-call option — getRetries() reads only
//   the environment — so the count cannot be passed at the call site, and a signal that aborts one
//   attempt does not on its own stop the next attempt being scheduled. Defaulting the variable here,
//   at module scope, is what actually caps the ladder; it is read lazily by the library on every
//   call, so setting it before the first upload is sufficient.
//
// `||=` NOT `=`: an operator who has deliberately set VERCEL_BLOB_RETRIES in the platform keeps
// their value. This only supplies a sane default where there was none.
if (!process.env.VERCEL_BLOB_RETRIES) process.env.VERCEL_BLOB_RETRIES = '2';

/** How long a single upload may take, end to end, before it is aborted. */
export function blobTimeoutMs(): number {
  const n = Number(process.env.BLOB_UPLOAD_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 20000;
}

/**
 * Upload to Vercel Blob with a bound on how long it may take.
 *
 * A drop-in for `put()`: same arguments, same return, so a call site changes only its import and
 * gains a timeout. Options the caller passes win, EXCEPT that an absent abortSignal is supplied —
 * a caller that brings its own signal (a streamed upload that wants to cancel on client disconnect)
 * keeps it.
 *
 * Twenty seconds is generous for a resized 320px JPEG and a document, and short enough to leave the
 * handler room to return a real error rather than being killed mid-flight. It does not need to be
 * anywhere near the platform limit, because a slow upload that eventually succeeds after a minute is
 * a request the visitor has already given up on.
 *
 * NOT SWALLOWED HERE. An abort surfaces as a rejection so each route reports its own honest failure;
 * the routes already have that error path, they simply never used to reach it.
 */
export async function putBounded(
  key: string,
  body: unknown,
  options: Record<string, unknown> = {},
): Promise<any> {
  const { put } = await import('@vercel/blob');
  const signal = (options as any).abortSignal ?? AbortSignal.timeout(blobTimeoutMs());
  return put(key as any, body as any, { ...(options as any), abortSignal: signal } as any);
}
