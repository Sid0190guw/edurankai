// src/lib/mailplatform/adapters/channel.ts — THE CHANNEL INTERFACE. One shape for every way a
// workflow can reach a person.
//
// Email is implemented (email.ts) because email is what this platform sends today. SMS, push,
// WhatsApp and Slack are DECLARED here and refuse to send, on purpose:
//
//   - Declaring them fixes the shape now, while there is one implementation to design against.
//     Retrofitting a second channel later is where the accidental `if (channel === 'sms')` branches
//     get scattered through the action executor.
//   - Refusing them means an author cannot build a workflow that silently sends nothing. A node
//     pointing at an unavailable channel fails validation before activation and, if it somehow
//     reaches a run, raises a PERMANENT failure with a sentence naming the channel — it does not
//     quietly succeed, which is the one outcome that would make an operator believe candidates were
//     being texted when nobody was.
//
// Wiring one up is implementing send() and flipping available(). Nothing in engine.ts, actions.ts
// or the builder changes.
import { PermanentFailure } from '../errors';

export type ChannelId = 'email' | 'sms' | 'push' | 'whatsapp' | 'slack';

export interface ChannelMessage {
  /** Address in whatever form the channel uses: an email address, a phone number, a channel id. */
  to: string;
  subject?: string;
  html?: string;
  text?: string;
  /**
   * Stable for this run and this node. Passed to the transport so a channel that can deduplicate
   * does; the engine's own guarantee does not depend on it (see the step ledger in store.ts), but a
   * transport that honours it closes the last small window.
   */
  idempotencyKey: string;
  /** For the log and for a reply-to. Never used to decide anything. */
  meta?: Record<string, unknown>;
}

export interface ChannelResult {
  ok: boolean;
  /** What the transport called it — a message id. Recorded on the step as evidence it happened. */
  ref?: string;
  error?: string;
}

export interface ChannelAdapter {
  id: ChannelId;
  label: string;
  /** Configured and usable right now. A channel can be implemented and still unavailable — email is
   *  unavailable on a deployment with no SMTP host, and saying so is better than a failed send. */
  available(): Promise<boolean>;
  /** Why it is unavailable, in a sentence for an operator. Empty when it is available. */
  unavailableReason(): Promise<string>;
  send(m: ChannelMessage): Promise<ChannelResult>;
}

/** The base every not-yet-built channel uses, so all four refuse identically and none of them can
 *  drift into a silent success. */
export function declaredButUnbuilt(id: ChannelId, label: string, note: string): ChannelAdapter {
  return {
    id,
    label,
    async available() { return false; },
    async unavailableReason() { return label + ' is not built on this platform. ' + note; },
    async send() {
      throw new PermanentFailure(
        label + ' is not built on this platform, so nothing was sent. ' + note +
        ' Remove the ' + id + ' step from the workflow, or implement src/lib/mailplatform/adapters/' + id + '.ts.',
      );
    },
  };
}
