// Dual-driver DB connection
// Node (local dev): uses 'postgres' (TCP)
// Cloudflare Pages: uses '@neondatabase/serverless' (HTTP fetch)
// Detection: presence of process.env (Node) vs runtime hint

import { drizzle as drizzleNode } from 'drizzle-orm/postgres-js';
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-http';
import * as schema from './schema';

let dbInstance: any;

// Cloudflare Workers/Pages runtime detects globalThis.process is undefined OR
// has only stub. We use a try/catch approach.
function getConnectionString(): string {
  // Astro injects env via import.meta.env at build, runtime via process.env (Node) or PROCESS_ENV (Workers via wrangler)
  let url: string | undefined;
  try {
    url = import.meta.env?.DATABASE_URL;
  } catch {}
  if (!url && typeof process !== 'undefined') {
    url = process.env?.DATABASE_URL;
  }
  if (!url) throw new Error('DATABASE_URL is not set');
  return url;
}

function isCloudflareRuntime(): boolean {
  // navigator.userAgent === 'Cloudflare-Workers' on CF
  try {
    if (typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers') return true;
  } catch {}
  // Fallback: process.versions.node missing on Workers
  try {
    if (typeof process === 'undefined' || !process.versions?.node) return true;
  } catch {}
  return false;
}

const connectionString = getConnectionString();

if (isCloudflareRuntime()) {
  // Use Neon HTTP driver for Cloudflare Pages
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(connectionString);
  dbInstance = drizzleNeon(sql, { schema });
} else {
  // Use postgres TCP driver for local Node dev
  const postgres = (await import('postgres')).default;
  // dotenv load - only on Node
  try {
    const dotenv = await import('dotenv');
    dotenv.config();
  } catch {}
  const client = postgres(connectionString, { prepare: false });
  dbInstance = drizzleNode(client, { schema });
}

export const db = dbInstance;
export { schema };
