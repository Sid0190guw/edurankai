// POST /admin/api/chat/upload — RETIRED WRITE. Same two reasons as send.ts, plus one of its own.
//
// GATE: it checked `if (!user)` only — weaker than /admin/chat, which the middleware gates on the
// `discussion` section — while accepting a 10 MB multipart upload and putting it in blob storage.
// denyAdminApi() now answers first, BEFORE request.formData() is read, so an unauthorised caller
// never gets to spend the upload.
//
// WRITE: it inserted the second shape into `chat_messages` (channel_id + body) and a row into
// chat_attachments. The channels are a read-only archive now; the one messenger that accepts new
// content is /portal/messages. Already-uploaded attachments are untouched and still render in the
// archive.
import type { APIRoute } from 'astro';
import { denyAdminApi } from '@/lib/auth/api-guard';
import { chatArchivedResponse } from '@/lib/chat-schema';

export const POST: APIRoute = async ({ locals }) => {
  const denied = await denyAdminApi(locals, {
    section: 'discussion',
    action: 'edit',
    label: 'admin.api.chat.upload',
  });
  if (denied) return denied;

  return chatArchivedResponse('Attaching a file to a Discussion channel');
};
