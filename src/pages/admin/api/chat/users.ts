// GET /admin/api/chat/users — RETIRED READ.
//
// This returned every active non-applicant account's name, email and internal handle to any caller
// that passed `if (!user)` — one line weaker than the page it served, which the middleware gates on
// the `discussion` section. Its only two callers were the "new channel" and "new direct message"
// pickers in /admin/chat; both are gone with the channel writes, so a staff directory dump would be
// left standing behind no feature at all.
//
// The gate is still applied before the refusal: an unauthorised caller gets 403, not a hint.
import type { APIRoute } from 'astro';
import { denyAdminApi } from '@/lib/auth/api-guard';
import { chatArchivedResponse } from '@/lib/chat-schema';

export const GET: APIRoute = async ({ locals }) => {
  const denied = await denyAdminApi(locals, {
    section: 'discussion',
    action: 'view',
    label: 'admin.api.chat.users',
  });
  if (denied) return denied;

  return chatArchivedResponse('The Discussion member picker');
};
