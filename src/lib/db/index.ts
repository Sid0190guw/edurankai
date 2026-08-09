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

// CONNECT ON FIRST USE, NOT ON IMPORT.
//
// This threw at module scope, so merely IMPORTING anything that imports this module — directly or
// six levels up a chain — failed outright without DATABASE_URL. The cost was not theoretical: the
// internship credit arithmetic is pure functions with no database in them, and its tests could not
// execute at all, because a transitive import of the organisation graph pulled this in and threw
// before the first assertion ran. Pure logic became untestable without a production connection.
//
// The error is unchanged and still loud; it now fires when a query is actually attempted, which in
// production is the same instant it did before, since the first request queries immediately.
let _client: ReturnType<typeof postgres> | null = null;
let _real: any = null;

function connect(): any {
  if (_real) return _real;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  _client = postgres(connectionString, { prepare: false });
  _real = drizzle(_client, { schema });
  return _real;
}

// postgres-js's execute() resolves to a plain array (a RowList), never a
// { rows } object. Because that return type IS an array, `Array.isArray(r)`
// narrows the defensive `r?.rows || []` fallback branch to `never`, so every
// such normalize site fails to typecheck (TS2339 "rows on never"). Raw-SQL
// results are inherently dynamic, so we type execute() as `any` — matching how
// the codebase already consumes it via the rows()/Array.isArray helpers.
// A Proxy so every existing call site keeps working untouched: db.select(...), db.execute(...) and
// the rest all reach the real handle, which is built the first time any property is read.
type RealDb = ReturnType<typeof drizzle<typeof schema>>;
export const db = new Proxy({} as any, {
  get(_target, prop) {
    const real = connect();
    const value = real[prop];
    return typeof value === 'function' ? value.bind(real) : value;
  },
}) as Omit<RealDb, 'execute'> & { execute: (query: any) => Promise<any> };
export { schema };

// Compatibility: getDb is no longer needed but exported as no-op
// so existing middleware/code that calls it doesn't break
export async function getDb(_runtimeEnv?: any) {
  return db;
}
