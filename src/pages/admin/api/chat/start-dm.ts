// POST /admin/api/chat/start-dm — RETIRED WRITE, and the one whose retirement is the whole point.
//
// This created a SECOND kind of direct message: a private is_dm channel holding plaintext bodies in
// `chat_messages`. The other kind — end-to-end encrypted threads — lives at /portal/messages, and
// src/lib/legal-hold.ts:214-223 states as a property of the system that direct-message content is
// not recoverable server-side. That statement is true of the thread messenger and false of an
// is_dm channel. Two DM mechanisms with opposite privacy properties behind one word is not a
// duplicated feature, it is a false guarantee, and this is the half that goes.
//
// GATE, fixed for the same reason as its siblings: `if (!user)` plus `role !== 'applicant'` is
// weaker than the `discussion` section gate the middleware applies to the page that calls it.
//
// A direct message is now started in one place: /portal/messages, "Start new conversation".
import type { APIRoute } from 'astro';
import { denyAdminApi } from '@/lib/auth/api-guard';
import { chatArchivedResponse } from '@/lib/chat-schema';

export const POST: APIRoute = async ({ locals }) => {
  const denied = await denyAdminApi(locals, {
    section: 'discussion',
    action: 'edit',
    label: 'admin.api.chat.start-dm',
  });
  if (denied) return denied;

  return chatArchivedResponse('Starting a Discussion direct message');
};
