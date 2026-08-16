// mail-engine/test/helpers/harness.ts — the shared scaffolding: a config, a publisher, a temp spool.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig, type EngineConfig } from '../../src/config.js';
import { createLogger, type Logger } from '../../src/logger.js';
import type { DeliveryEvent, DeliveryEventPublisher, SuppressionEntry, EventKind } from '../../src/contracts/index.js';

/** A config built from an explicit environment, so a developer's real .env can never leak into a test. */
export function testConfig(overrides: Record<string, string> = {}): EngineConfig {
  return loadConfig({
    MAIL_HOSTNAME: 'mail.test.invalid',
    MAIL_DOMAINS: 'edurankai.in,test.invalid',
    MAIL_DELIVERY_ENABLED: 'true',
    MAIL_APP_SHARED_SECRET: 'test-secret',
    MAIL_INBOUND_SECRET: 'test-inbound-secret',
    MAIL_SPOOL_DIR: '/tmp/never-used-directly',
    MAIL_LOG_LEVEL: 'error',
    ...overrides,
  } as NodeJS.ProcessEnv);
}

/** A logger that keeps its lines instead of printing them. */
export function testLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: createLogger({ level: 'debug', sink: (l) => lines.push(l) }), lines };
}

/** A publisher that records everything, so a test can assert on the event stream itself. */
export class MemoryPublisher implements DeliveryEventPublisher {
  events: DeliveryEvent[] = [];
  suppressions = new Map<string, SuppressionEntry>();
  flushed = 0;
  /** Set to make publish() throw, to prove a delivery still completes when publishing fails. */
  failPublish = false;

  async publish(events: DeliveryEvent[]): Promise<void> {
    if (this.failPublish) throw new Error('publisher is down');
    this.events.push(...events);
  }

  async isSuppressed(recipient: string): Promise<boolean> {
    const e = this.suppressions.get(recipient.toLowerCase());
    if (!e) return false;
    if (e.permanent) return true;
    return !e.expiresAt || new Date(e.expiresAt).getTime() > Date.now();
  }

  async suppress(entry: SuppressionEntry): Promise<void> {
    this.suppressions.set(entry.recipient.toLowerCase(), entry);
  }

  async flush(): Promise<number> {
    this.flushed += 1;
    return 0;
  }

  async pending(): Promise<number> {
    return 0;
  }

  kinds(): EventKind[] {
    return this.events.map((e) => e.kind);
  }

  of(kind: EventKind): DeliveryEvent[] {
    return this.events.filter((e) => e.kind === kind);
  }

  reset(): void {
    this.events = [];
    this.suppressions.clear();
  }
}

/** A throwaway directory under the OS temp dir, cleaned up by the caller. */
export async function tempDir(prefix = 'mail-engine-test'): Promise<string> {
  const dir = path.join(os.tmpdir(), `${prefix}-${randomUUID().slice(0, 8)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function removeDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => { /* best effort on Windows */ });
}

/** A deterministic "random" source, so jittered numbers can be asserted exactly. */
export function fixedRandom(value = 0.5): () => number {
  return () => value;
}
