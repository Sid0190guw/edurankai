// GET /api/mail/gov/export-download?job=<id>&token=<token>[&file=<name>]
//
// THE ONE ROUTE IN THIS CONSOLE WITH ITS OWN CREDENTIAL. Everything else authorises through the
// session and the governance role. A download link has to work when it is pasted into a terminal, a
// download manager, or a colleague's browser, so it carries a token instead — and that token is
// therefore held to the standard a credential is held to:
//
//   - compared in constant time against a stored SHA-256 (fetchExportFile does this);
//   - valid only while the job is `ready` and inside its window;
//   - counted, so "was this ever downloaded, and how often" has an answer;
//   - AUDITED ON EVERY USE, with the request's own IP and user agent — not the requester's, because
//     the interesting fact is where the file actually went.
//
// THE SESSION IS STILL CHECKED WHEN THERE IS ONE. A signed-in caller must also hold
// `export.download` for that tenant; the token alone is accepted only for a caller with no session,
// which is the download-manager case. A signed-in user from another tenant holding a leaked token is
// refused by the capability check, which is a real defence the token cannot provide on its own.
import type { APIRoute } from 'astro';
import { govJson, methodNotAllowed } from '@/lib/mailgov/http';
import { auditedWrite, resolveGovActor, requestFacts } from '@/lib/mailgov/guard';
import { AUDIT_ACTIONS } from '@/lib/mailgov/audit';
import { fetchExportFile } from '@/lib/mailgov/exports';
import { authorizeGov } from '@/lib/mailgov/policy';
import { secureHeaders } from '@/lib/http-guard';

export const GET: APIRoute = async ({ locals, request, url }) => {
  const jobId = (url.searchParams.get('job') || '').trim();
  const token = (url.searchParams.get('token') || '').trim();
  const file = (url.searchParams.get('file') || '').trim() || null;
  if (!jobId || !token) return govJson({ ok: false, error: 'Both job and token are required.' }, 400);

  const facts = requestFacts(request);
  const check = await fetchExportFile({ jobId, token, file });
  if (!check.ok) return govJson({ ok: false, error: check.error }, 403);

  // A signed-in caller is held to their governance role as well as to the token.
  const actor = await resolveGovActor((locals as any)?.user);
  if (actor.userId) {
    const decision = authorizeGov(actor, 'export.download', { orgId: check.job?.orgId });
    if (!decision.allowed) {
      return govJson({ ok: false, error: 'forbidden', code: decision.code, reason: decision.reason }, 403);
    }
  }

  // Listing the files in the export is not a download and is not audited as one.
  if (!file) {
    return govJson({ ok: true, job: { id: check.job?.id, status: check.job?.status, expiresAt: check.job?.expiresAt, manifest: check.job?.manifest }, files: check.files });
  }

  const write = await auditedWrite(
    {
      actor, action: AUDIT_ACTIONS.EXPORT_DOWNLOADED, orgId: check.job?.orgId || null,
      targetType: 'export', targetId: jobId,
      reason: 'Export file downloaded: ' + file,
      meta: { file, downloadCount: (check.job?.downloadCount || 0) + 1, anonymous: !actor.userId },
      facts,
    },
    async () => true,
  );
  if (!write.ok) return govJson({ ok: false, error: write.error }, 500);

  // Object-storage exports hand back a URL rather than bytes: the store serves the file, which is
  // what a store is for, and streaming it through here would double the bandwidth for no gain.
  if (check.contentType === 'text/uri-list') {
    return new Response(null, {
      status: 302,
      headers: { ...secureHeaders(), Location: String(check.body), 'cache-control': 'no-store' },
    });
  }

  return new Response(check.body || '', {
    status: 200,
    headers: {
      ...secureHeaders(),
      'Content-Type': check.contentType || 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="' + (check.filename || 'export') + '"',
      'cache-control': 'no-store',
    },
  });
};

export const ALL: APIRoute = async () => methodNotAllowed(['GET']);
