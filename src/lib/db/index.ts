// DB connection - simplified for Vercel (Node.js runtime)
// Local dev also uses Node, so single driver works everywhere
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

// Try .env on local dev
try {
  const dotenv = await import('dotenv');
  dotenv.config();
} catch {}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

const client = postgres(connectionString, { prepare: false });
export const db = drizzle(client, { schema });
export { schema };

// Compatibility: getDb is no longer needed but exported as no-op
// so existing middleware/code that calls it doesn't break
export async function getDb(_runtimeEnv?: any) {
  return db;
}
