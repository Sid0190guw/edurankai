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
  // Serverless pool sizing. Every warm Vercel instance builds its own client, and postgres-js
  // defaults to max:10 with idle_timeout:0 — ten connections per instance, held open for the life
  // of the instance and never returned while it idles. Multiplied across warm instances and the
  // nineteen daily crons, that exhausts the transaction pooler's client slots; once it is full,
  // every query on every route waits for a slot that never frees and the function dies at the
  // gateway timeout. One connection per instance is enough, because an invocation runs its queries
  // in sequence anyway. idle_timeout hands it back between bursts, max_lifetime recycles it, and
  // connect_timeout turns a saturated pooler into a fast, loggable error rather than a hang that
  // reads from outside as the whole site being down.
  //
  // idle_timeout WAS 20, and that was measurably wrong. The function region and the database region
  // differ, so re-establishing a connection costs a TCP handshake, a TLS handshake and Postgres auth
  // across that distance -- measured at ~1.4s against a ~177ms warm round trip. At 20 seconds, an
  // instance serving anything less than constant traffic dropped its connection between almost every
  // request and paid that 1.4s again, which is a worse experience than the leak this was fixing.
  // 300s keeps a working instance warm while still handing the connection back when it goes quiet;
  // max:1 is what actually bounds pooler usage, so a longer idle window costs nothing there.
  _client = postgres(connectionString, {
    prepare: false,
    max: 1,
    idle_timeout: 300,
    max_lifetime: 60 * 30,
    connect_timeout: 10,
  });
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

// The raw postgres-js handle behind `db`, for the few call sites that write tagged-template SQL
// instead of going through Drizzle. They previously each opened their own postgres() client, which
// on a page rendered per request meant a new connection per page view; sharing this one keeps them
// inside the single pooled connection above. Do not call .end() on it — it belongs to the module,
// and closing it takes down every subsequent query in the same instance.
export function sqlClient(): ReturnType<typeof postgres> {
  connect();
  return _client!;
}

// Compatibility: getDb is no longer needed but exported as no-op
// so existing middleware/code that calls it doesn't break
export async function getDb(_runtimeEnv?: any) {
  return db;
}
