// POST /api/aquintutor/lms/upload-url — mint a one-object, few-minute upload authorisation.
//
// THIS IS THE ANSWER TO "WE CANNOT UPLOAD A FULL VIDEO", and it is worth stating exactly why the
// obvious approach does not work. Posting a file to a serverless function means the whole file
// travels inside one HTTP request that the function receives, and that request has a body ceiling
// of a few megabytes on this host. A forty-minute lecture is three orders of magnitude past it.
// Chunking inside the function does not help, because the ceiling is on the request, not on us.
//
// So the bytes do not come here at all. This route signs a PUT for ONE object key, valid for a few
// minutes, and the browser uploads straight to object storage. The file never passes through this
// function, and the size limit becomes the storage service's rather than the platform's.
//
// WHAT THIS ROUTE IS CAREFUL ABOUT
//   - Who is asking. A signed-in person with a teaching claim on the named course. Nobody else.
//   - What key they get. WE choose it, from a random id and a sanitised extension. The caller never
//     names the object, so a signature can never be aimed at an existing file.
//   - What they claim to be sending. Extension and declared type must both be media, and the
//     declared size must be under the cap — checked before signing, because after signing the
//     upload is between the browser and the bucket and we are not in the conversation.
//   - Saying "storage is not configured" as its own answer, never as a failed upload. They are
//     different problems with different fixes.
import type { APIRoute } from 'astro';
import { teachClaim } from '@/lib/lms/access';
import { presignedUpload, directUploadStatus, storageKey } from '@/lib/storage';

export const prerender = false;

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });
}

/** What a lesson may be. Extension AND declared type must agree that this is media. */
const ALLOWED: Array<{ ext: string; types: string[] }> = [
  { ext: 'mp4', types: ['video/mp4'] },
  { ext: 'm4v', types: ['video/mp4', 'video/x-m4v'] },
  { ext: 'mov', types: ['video/quicktime'] },
  { ext: 'webm', types: ['video/webm'] },
  { ext: 'ogv', types: ['video/ogg'] },
  { ext: 'mp3', types: ['audio/mpeg', 'audio/mp3'] },
  { ext: 'm4a', types: ['audio/mp4', 'audio/x-m4a', 'audio/aac'] },
  { ext: 'wav', types: ['audio/wav', 'audio/x-wav'] },
  { ext: 'opus', types: ['audio/opus', 'audio/ogg'] },
  { ext: 'flac', types: ['audio/flac', 'audio/x-flac'] },
];

/** Five gigabytes. Large enough for a long lecture at sensible quality, small enough that a mistake
 *  is not a bill. Raise it deliberately, not by accident. */
const MAX_BYTES = 5 * 1024 * 1024 * 1024;

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user?.id) return json({ ok: false, error: 'Sign in required.' }, 401);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Bad request body.' }, 400); }

  const courseId = String(body.courseId || '');
  if (!courseId) return json({ ok: false, error: 'A course is required.' }, 400);

  const claim = await teachClaim(user, courseId);
  if (!claim.canTeach) return json({ ok: false, error: 'You do not have teaching access to this course.' }, 403);

  const filename = String(body.filename || '');
  const contentType = String(body.contentType || '').toLowerCase().split(';')[0].trim();
  const size = Number(body.sizeBytes || 0);

  const ext = (filename.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const allowed = ALLOWED.find((a) => a.ext === ext);
  if (!allowed) {
    return json({ ok: false, error: 'That file type cannot be uploaded here. Allowed: ' + ALLOWED.map((a) => a.ext).join(', ') + '.' }, 400);
  }
  if (contentType && !allowed.types.includes(contentType)) {
    return json({ ok: false, error: 'The file\'s name says ' + ext + ' but the browser reports it as ' + contentType + '. Re-export it or rename it to match.' }, 400);
  }
  if (!Number.isFinite(size) || size <= 0) return json({ ok: false, error: 'The file size was not reported, so it cannot be checked against the limit.' }, 400);
  if (size > MAX_BYTES) {
    return json({ ok: false, error: 'That file is ' + (size / 1073741824).toFixed(2) + ' GB. The limit here is 5 GB — export it at a lower bitrate, or host it and paste the link instead.' }, 413);
  }

  const status = directUploadStatus();
  if (!status.available) {
    // NOT an error about the file. A configuration answer, said plainly, so nobody spends an hour
    // re-exporting a video to fix a missing environment variable.
    return json({ ok: false, error: status.reason, storageConfigured: false, backend: status.backend }, 503);
  }

  // The key is ours. Random id, sanitised extension, namespaced by course so a bucket listing is
  // navigable and a course deletion has something to sweep.
  const id = crypto.randomUUID();
  const key = 'lesson-media/' + courseId + '/' + storageKey('video', id, ext).split('/').pop();

  try {
    const signed = await presignedUpload(key, { expiresInSeconds: 900 });
    if (!signed) return json({ ok: false, error: status.reason, storageConfigured: false }, 503);
    return json({
      ok: true,
      uploadUrl: signed.uploadUrl,
      publicUrl: signed.publicUrl,
      key: signed.key,
      expiresInSeconds: signed.expiresInSeconds,
      contentType: contentType || allowed.types[0],
      // The address the browser will hold after the upload is a plain media file on https, which is
      // exactly what the link resolver already accepts — so an upload and a pasted link converge on
      // one code path rather than becoming a second kind of lesson video.
      note: 'Upload with a single PUT to uploadUrl, then save publicUrl as the lesson video address.',
    });
  } catch (e: any) {
    console.error('[lms/upload-url]', e?.cause?.message || e?.message);
    return json({ ok: false, error: 'The upload could not be authorised: ' + (e?.cause?.message || e?.message || 'unknown error') }, 500);
  }
};

export const GET: APIRoute = async ({ locals }) => {
  const user = (locals as any)?.user;
  if (!user?.id) return json({ ok: false, error: 'Sign in required.' }, 401);
  const status = directUploadStatus();
  return json({ ok: true, ...status, maxBytes: MAX_BYTES, allowed: ALLOWED.map((a) => a.ext) });
};
