// src/lib/mailplatform/adapters/index.ts — the channel registry.
import type { ChannelAdapter, ChannelId } from './channel';
import { declaredButUnbuilt } from './channel';
import { emailAdapter } from './email';

/** Every channel the interface covers. Exactly one of them sends. */
export const CHANNELS: Record<ChannelId, ChannelAdapter> = {
  email: emailAdapter,
  sms: declaredButUnbuilt('sms', 'SMS', 'No SMS gateway is connected to this platform.'),
  push: declaredButUnbuilt('push', 'Push notification', 'Web push exists for signed-in platform users (src/lib/push.ts) but is not wired to marketing contacts, who have no subscription.'),
  whatsapp: declaredButUnbuilt('whatsapp', 'WhatsApp', 'No WhatsApp Business sender is connected to this platform.'),
  slack: declaredButUnbuilt('slack', 'Slack', 'No Slack workspace is connected to this platform.'),
};

export function channel(id: string): ChannelAdapter | null {
  return (CHANNELS as any)[String(id || '')] || null;
}

/** For the builder and the health screen: what can actually be sent right now, and why not. */
export async function channelStatus(): Promise<Array<{ id: ChannelId; label: string; available: boolean; reason: string }>> {
  const out = [] as Array<{ id: ChannelId; label: string; available: boolean; reason: string }>;
  for (const a of Object.values(CHANNELS)) {
    let available = false;
    let reason = '';
    try {
      available = await a.available();
      reason = available ? '' : await a.unavailableReason();
    } catch (e: any) {
      reason = 'This channel could not be checked: ' + String(e?.cause?.message || e?.message || e);
    }
    out.push({ id: a.id, label: a.label, available, reason });
  }
  return out;
}

export type { ChannelAdapter, ChannelId, ChannelMessage, ChannelResult } from './channel';
