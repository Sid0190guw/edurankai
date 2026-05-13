// Dual-driver DB connection
// Node (local dev): uses 'postgres' (TCP)
// Cloudflare Workers: uses '@neondatabase/serverless' (HTTP fetch)
import { drizzle as drizzleNode } from 'drizzle-orm/postgres-js';
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-http';
import * as schema from './schema';

let dbInstance: any;
let initialized = false;
let initPromise: Promise<any> | null = null;

function getConnectionString(runtimeEnv?: any): string {
  let url: string | undefined;

  // 1. Runtime env from Cloudflare (passed via middleware)
  if (runtimeEnv?.DATABASE_URL) {
    url = runtimeEnv.DATABASE_URL;
  }

  // 2. import.meta.env (build-time)
  if (!url) {
    try { url = import.meta.env?.DATABASE_URL; } catch {}
  }

  // 3. process.env (Node)
  if (!url && typeof process !== 'undefined') {
    url = process.env?.DATABASE_URL;
  }

  // 4. globalThis fallback
  if (!url && typeof globalThis !== 'undefined') {
    url = (globalThis as any).DATABASE_URL;
  }

  if (!url) throw new Error('DATABASE_URL is not set');
  return url;
}

function isCloudflareRuntime(): boolean {
  try {
    if (typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers') return true;
  } catch {}
  try {
    if (typeof process === 'undefined' || !process.versions?.node) return true;
  } catch {}
  return false;
}

async function initDb(runtimeEnv?: any) {
  if (initialized) return dbInstance;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const connectionString = getConnectionString(runtimeEnv);

    if (isCloudflareRuntime()) {
      const { neon } = await import('@neondatabase/serverless');
      const sql = neon(connectionString);
      dbInstance = drizzleNeon(sql, { schema });
    } else {
      const postgres = (await import('postgres')).default;
      try {
        const dotenv = await import('dotenv');
        dotenv.config();
      } catch {}
      const client = postgres(connectionString, { prepare: false });
      dbInstance = drizzleNode(client, { schema });
    }

    initialized = true;
    return dbInstance;
  })();

  return initPromise;
}

// Explicit init - called from middleware before any db usage
export async function getDb(runtimeEnv?: any) {
  return await initDb(runtimeEnv);
}

// Synchronous db export for code that uses `db.query(...)` directly
// IMPORTANT: getDb() must be called first (from middleware) before this is used
export const db: any = new Proxy({}, {
  get(_target, prop) {
    if (!initialized) {
      throw new Error('Database not initialized. Call getDb(runtimeEnv) first (in middleware).');
    }
    return dbInstance[prop];
  }
});

export { schema };
