// /admin/api/chat/members — RETIRED, both verbs.
//
// POST added or removed somebody from a channel; GET listed a channel's members and told the caller
// whether they could manage it. Neither has a caller left in the repository (the member panel was
// never wired into /admin/chat), and membership only decides who may write to a private channel — a
// question the archive no longer asks, because nobody writes to a channel.
//
// Both verbs checked `if (!user)` only. GET therefore returned the name, email and internal handle
// of every member of any channel — including a private one — to any signed-in account, applicants
// included, while the page it belongs to is gated on the `discussion` section. That is the same
// defect as send.ts and it is closed the same way: denyAdminApi() first, then the refusal.
//
// Existing chat_memberships rows are NOT deleted. They are what a future migration would need to
// carry these channels into threads.
import type { APIRoute } from 'astro';
import { denyAdminApi } from '@/lib/auth/api-guard';
import { chatArchivedResponse } from '@/lib/chat-schema';

export const POST: APIRoute = async ({ locals }) => {
  const denied = await denyAdminApi(locals, {
    section: 'discussion',
    action: 'edit',
    label: 'admin.api.chat.members.write',
  });
  if (denied) return denied;

  return chatArchivedResponse('Changing Discussion channel membership');
};

export const GET: APIRoute = async ({ locals }) => {
  const denied = await denyAdminApi(locals, {
    section: 'discussion',
    action: 'view',
    label: 'admin.api.chat.members.read',
  });
  if (denied) return denied;

  return chatArchivedResponse('The Discussion channel member list');
};
