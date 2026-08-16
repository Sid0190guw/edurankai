// mail-engine/src/index.ts — the daemon entry point. `node --import tsx mail-engine/src/index.ts`.
//
// ENVIRONMENT. The engine reads mail-engine/.env and NOTHING ELSE. It never touches the
// application's .env, .env.local or .env.production — those hold live database credentials, and the
// working rule in CLAUDE.md is that nothing running locally opens them. The mail engine has no
// business knowing a database password; it talks to the application over HTTP with one shared
// secret, and that is the whole of its access to anything.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from './engine.js';
import { startEngine } from './server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = path.resolve(HERE, '..');

/**
 * A three-line .env reader. dotenv would do, but the engine is meant to be copyable to a bare host
 * and run, and a dependency-free entry point is one fewer reason for it not to start.
 * Existing process environment always wins — that is how the container passes its configuration.
 */
export async function loadDotEnv(file: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return 0;
  }
  let loaded = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || key in env) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
    loaded += 1;
  }
  return loaded;
}

async function main(): Promise<void> {
  await loadDotEnv(path.join(ENGINE_ROOT, '.env'));
  const engine = createEngine();
  const shutdown = await startEngine(engine);

  // SIGTERM is what `docker stop` sends. Draining on it is the difference between a restart that
  // costs nothing and one that leaves every in-flight message waiting out a ten-minute lease.
  let shuttingDown = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void shutdown().then(() => process.exit(0));
    });
  }

  process.on('unhandledRejection', (reason) => {
    engine.logger.error('unhandled rejection', { reason: String(reason) });
  });
  process.on('uncaughtException', (err) => {
    // Log and keep running. A mail server that exits on one bad message stops delivering every other
    // message too; the spool means nothing is lost by staying up, and everything is delayed by dying.
    engine.logger.error('uncaught exception', { reason: err?.message, stack: err?.stack?.split('\n').slice(0, 5).join(' | ') });
  });
}

// Only run when executed directly, so the tests can import this module for loadDotEnv().
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[mail-engine] failed to start:', err?.message || err);
    process.exit(1);
  });
}
