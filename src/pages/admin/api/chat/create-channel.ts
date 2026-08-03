// POST /admin/api/chat/create-channel — RETIRED WRITE.
//
// GATE: `if (!user)` plus `role !== 'applicant'`. src/lib/auth/permissions.ts warns against exactly
// that second test — every internal role passes it, including the `editor` handed to every intern
// by the 2026 offer-signing promotion, and including the partner/teacher scopes the middleware
// bounces off /admin entirely. The page this serves is gated on the `discussion` section; this now
// asks the same question through denyAdminApi().
//
// WRITE: a new channel is a new room in a system that no longer takes new messages. Existing
// channels stay readable at /admin/chat; a new conversation is a thread at /portal/messages.
import type { APIRoute } from 'astro';
import { denyAdminApi } from '@/lib/auth/api-guard';
import { chatArchivedResponse } from '@/lib/chat-schema';

export const POST: APIRoute = async ({ locals }) => {
  const denied = await denyAdminApi(locals, {
    section: 'discussion',
    action: 'edit',
    label: 'admin.api.chat.create-channel',
  });
  if (denied) return denied;

  return chatArchivedResponse('Creating a Discussion channel');
};
