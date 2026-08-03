// POST /admin/api/chat/send — RETIRED WRITE. See src/lib/chat-schema.ts for why exactly one chat
// system survives; this file is the channel system's send, and the channels are now a read-only
// archive.
//
// TWO SEPARATE DEFECTS ARE FIXED HERE, and the first still matters even though the second closes
// the write entirely.
//
// 1. THE GATE WAS WEAKER THAN THE PAGE IT SERVED. This endpoint checked `if (!user)` and nothing
//    else. The page that calls it, /admin/chat, is gated by src/middleware.ts on the `discussion`
//    section (PATH_SECTION, middleware.ts:57) — so an account whose role does not hold `discussion`
//    was redirected away from the page and could still POST here and be heard in the channel.
//    `if (!user)` is also the exact test src/lib/auth/permissions.ts warns against: it passes for
//    every authenticated principal, applicants included, and resolveAdminSection() never matches
//    `/admin/api/chat/send`, so the middleware's section gate does not cover this URL either.
//    denyAdminApi() asks the SAME question as the page's own door — canOpenAdmin plus the
//    `discussion` section, custom roles from the registry included — and it fails closed.
//
// 2. IT WAS THE SECOND WRITER OF `chat_messages`. Two modules CREATEd that table with incompatible
//    shapes, so exactly one shape is live and one of the two systems has been throwing on every
//    INSERT. The repair keeps ONE messenger: /portal/messages, which is end-to-end encrypted, is
//    offered to every workspace member by src/lib/workforce/navigation.ts:204, and is the shape
//    src/lib/legal-hold.ts is written against. This endpoint therefore stops writing.
//
// The guard runs FIRST and the 410 second, on purpose: an unauthorised caller gets 403 and learns
// nothing about what this endpoint used to do.
import type { APIRoute } from 'astro';
import { denyAdminApi } from '@/lib/auth/api-guard';
import { chatArchivedResponse } from '@/lib/chat-schema';

export const POST: APIRoute = async ({ locals }) => {
  const denied = await denyAdminApi(locals, {
    section: 'discussion',
    action: 'edit',
    label: 'admin.api.chat.send',
  });
  if (denied) return denied;

  return chatArchivedResponse('Sending to a Discussion channel');
};
