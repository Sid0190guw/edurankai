// src/lib/mailplatform/providers.ts — the wiring.
//
// THE ONLY FILE THAT NAMES BOTH SIDES. Services import interfaces; adapters implement them; this
// file is where an interface is bound to an implementation. Migrating from local SMTP to an
// EduRankAI MTA cluster, or from Postgres events to Kafka, is a change here and nowhere else.
//
// Selection is by environment variable so a deployment — not a code change — decides. Each variable
// has a default that matches what this deployment runs today, so an unset environment behaves
// exactly as it does now.

import type { PlatformProviders } from './interfaces';
import { nullTransport, smtpTransport } from './adapters/transport-smtp';
import { imapInbound, pushOnlyInbound } from './adapters/inbound-imap';
import { postgresMessageStore } from './adapters/message-store-postgres';
import { objectAttachmentStore } from './adapters/attachment-store';
import { postgresQueue } from './adapters/queue-postgres';
import { postgresAnalytics, postgresEventBus } from './adapters/event-bus-postgres';
import { platformAuth } from './adapters/auth-platform';
import { systemDnsProvider } from './adapters/domain-dns';

/** Every swap point, its variable, and what it accepts. Rendered by the ops screen and the docs. */
export const PROVIDER_SETTINGS = [
  { slot: 'transport', env: 'MAIL_TRANSPORT', values: ['smtp', 'none'], default: 'smtp' },
  { slot: 'inbound', env: 'MAIL_INBOUND', values: ['imap', 'push'], default: 'imap' },
  { slot: 'messages', env: 'MAIL_MESSAGE_STORE', values: ['postgres'], default: 'postgres' },
  { slot: 'attachments', env: 'MAIL_ATTACHMENT_STORE', values: ['object'], default: 'object' },
  { slot: 'queue', env: 'MAIL_QUEUE', values: ['postgres'], default: 'postgres' },
  { slot: 'events', env: 'MAIL_EVENT_BUS', values: ['postgres'], default: 'postgres' },
  { slot: 'auth', env: 'MAIL_AUTH', values: ['platform'], default: 'platform' },
  { slot: 'analytics', env: 'MAIL_ANALYTICS', values: ['postgres'], default: 'postgres' },
  { slot: 'dns', env: 'MAIL_DNS', values: ['system'], default: 'system' },
] as const;

let cached: PlatformProviders | null = null;

/**
 * The wired platform.
 *
 * Built once per process. Adapters are cheap constructors that do no I/O — every one of them
 * imports its dependencies lazily inside a method — so building this never opens a connection and
 * is safe to call from a module that a test imports.
 */
export function providers(): PlatformProviders {
  if (cached) return cached;

  const transportKind = (process.env.MAIL_TRANSPORT || 'smtp').toLowerCase();
  const inboundKind = (process.env.MAIL_INBOUND || 'imap').toLowerCase();

  cached = {
    transport: transportKind === 'none' ? nullTransport() : smtpTransport(),
    inbound: inboundKind === 'push' ? pushOnlyInbound() : imapInbound(),
    messages: postgresMessageStore(),
    attachments: objectAttachmentStore(),
    queue: postgresQueue(),
    events: postgresEventBus(),
    auth: platformAuth(),
    analytics: postgresAnalytics(),
    dns: systemDnsProvider(),
  };
  return cached;
}

/**
 * Replace one or more providers. Tests only.
 *
 * Exported rather than reached for through module mocking, because a test that swaps a provider
 * should say so in its own body. Call `resetProviders()` afterwards.
 */
export function setProviders(overrides: Partial<PlatformProviders>): PlatformProviders {
  cached = { ...providers(), ...overrides };
  return cached;
}

export function resetProviders(): void {
  cached = null;
}

/**
 * What is actually wired, for an ops screen.
 *
 * Reports each slot's `info()` verbatim, including `enabled: false` and the reason. A status page
 * that shows only green when nothing is configured is worse than no status page — this one is
 * built so the honest answer is the easy one.
 */
export function providerStatus(): { slot: string; kind: string; enabled: boolean; detail: string }[] {
  const p = providers();
  const slots: [string, { info(): { kind: string; enabled: boolean; detail: string } }][] = [
    ['transport', p.transport],
    ['inbound', p.inbound],
    ['messages', p.messages],
    ['attachments', p.attachments],
    ['queue', p.queue],
    ['events', p.events],
    ['auth', p.auth],
    ['analytics', p.analytics],
    ['dns', p.dns],
  ];
  return slots.map(([slot, provider]) => {
    try {
      const info = provider.info();
      return { slot, kind: info.kind, enabled: info.enabled, detail: info.detail };
    } catch (e: any) {
      return {
        slot,
        kind: 'error',
        enabled: false,
        detail: 'This provider could not report its own status: ' + String(e?.message || e),
      };
    }
  });
}
