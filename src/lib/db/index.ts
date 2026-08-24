// DB connection - simplified for Vercel (Node.js runtime)
// Local dev also uses Node, so single driver works everywhere
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { ddlPermitted, isDdlStatement, noteSuppressedDdl } from '@/lib/schema-bootstrap';

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
  //
  // max WAS 1, and that is what actually took the site down today. Under fluid/concurrent
  // invocations one instance serves many requests at once, and with a single connection they do not
  // run at once -- they queue, one whole request's worth of database work at a time. Measured on the
  // live site: twenty concurrent homepage requests, one fast SELECT each, all answered, slowest
  // 3.7s -- that is twenty queries serialised at ~150ms and it looks fine. Twenty with /careers in
  // the mix, which needs ~1.5-2s of database work per render, and twelve of them never answered
  // before the client gave up at thirty seconds. Same connection, arithmetic doing the rest.
  //
  // Five, not ten: enough that a slow page cannot block the fast ones behind it, few enough that the
  // transaction pooler is not the next thing to run out. What exhausted the pooler before was never
  // this number on its own -- it was postgres-js's default max:10 with idle_timeout:0, which never
  // hands a connection back at all, plus pages opening their own clients per request (ee96b2d).
  // Both of those are fixed; a bounded pool that returns what it borrows is not the same risk.
  //
  // idle_timeout drops from 300 to 60 because the reason for 300 no longer exists. It was raised
  // when the functions ran in iad1 and the database in ap-south-1, where re-establishing a
  // connection cost ~1.4s across two continents. The functions now run in bom1, next to the
  // database (19e34eb), so that handshake is local and cheap, and holding five idle connections per
  // instance for five minutes is a cost with nothing left to buy.
  // =================================================================================================
  // MEASURED AGAIN ON 2026-08-24, AND max:5 WITH idle_timeout:60 DID NOT HOLD
  // =================================================================================================
  //
  // The paragraph above reasoned that five was "few enough that the transaction pooler is not the
  // next thing to run out". It was the next thing to run out. Twelve concurrent requests to
  // /api/health — a route whose entire database cost is ONE ping — answered four and returned 503 on
  // the other eight, each after ~7.3s, with "database did not answer within 5000ms". A single
  // request at the same moment answered in 136ms.
  //
  // THAT SHAPE RULES OUT QUEUEING, which is what tells us the direction to move. If the eight were
  // simply waiting behind five busy connections they would have completed late, not timed out: one
  // ping is 136ms, so twelve of them serialised through even a single connection is under two
  // seconds. A five-second timeout on acquiring a connection is the pooler declining to give one
  // out. The bound that matters is not five per instance — it is five TIMES the number of instances
  // Vercel decides to run, and that number rises with exactly the concurrency that triggers this.
  //
  // idle_timeout:60 made it stick: every instance kept up to five connections for a full minute
  // after it stopped needing them, so a brief burst held the pooler down long after the burst ended.
  // That is the part the user actually experienced — the admin console, which fires several reads
  // per page, would not open, while /about stayed fast because it touches no database at all.
  //
  // TWO, NOT ONE. max:1 is what this was before 3a65d6fd, and it serialised a page's own queries
  // against each other — the bottleneck that commit correctly removed. Two keeps a slow query from
  // blocking the fast one behind it on the same instance while halving what each instance can hold.
  // Fifteen seconds is still comfortably longer than the local bom1 handshake this pool sits next
  // to, and four times faster at handing a connection back than sixty was.
  //
  // IF THIS IS STILL NOT ENOUGH, the next lever is the pooler's own ceiling (Supabase → Database →
  // Connection pooling), not another guess at this number. Re-measure with the burst above before
  // changing it again: twelve parallel requests to /api/health, and count the 503s.
  _client = postgres(connectionString, {
    prepare: false,
    max: 2,
    idle_timeout: 15,
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

// REQUEST-TIME DDL IS REFUSED HERE, AT THE ONE CHOKEPOINT EVERY BOOTSTRAP SHARES.
//
// src/lib/ensure-once.ts turned schema bootstrapping off in production after 2026-08-23, and that
// covered the ~192 modules that go through ensureOnce(). About forty others never did: they await an
// exported ensureXSchema() straight from a page's frontmatter, with no memo, so their ALTER TABLEs
// ran on EVERY request. src/lib/schema-bootstrap.ts sets out the full reckoning, including why that
// is what fires Supabase's pgrst_ddl_watch event trigger and produces the schema-cache reload storm.
//
// Whatever the statement was, the caller gets the same empty result postgres-js gives for DDL, so
// nothing downstream has to change. Everything is logged and counted; /api/health reports it.
//
// FAILS OPEN BY DESIGN. If the statement text cannot be recovered, or the guard itself throws, the
// statement is EXECUTED. A guard that silently drops a write it merely failed to classify would be a
// far worse outage than the one it is here to prevent.
function guardedExecute(real: any, query: any): Promise<any> {
  try {
    if (ddlPermitted()) return real.execute(query);
    const text = typeof query === 'string' ? query : String(real.dialect.sqlToQuery(query).sql || '');
    if (!isDdlStatement(text)) return real.execute(query);
    noteSuppressedDdl(text);
    return Promise.resolve([]);
  } catch {
    return real.execute(query);
  }
}

export const db = new Proxy({} as any, {
  get(_target, prop) {
    const real = connect();
    if (prop === 'execute') return (query: any) => guardedExecute(real, query);
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

// A DATABASE THAT NEVER ANSWERS MUST NOT BECOME A PAGE THAT NEVER LOADS.
//
// On 2026-08-23 at 07:01 UTC every route that queries Postgres stopped responding — not with an
// error, with nothing at all: no status, no body, requests held open past 100 seconds. Routes that
// touch no table (/about, /portal/login) kept serving in ~0.3s throughout, which is how we know the
// function was healthy and the database was not. /api/health, whose whole contract is to return 503
// when the database is unreachable, hung with the rest of them, so nothing anywhere reported an
// outage that had been running for a quarter of an hour.
//
// connect_timeout does not cover this case. The transaction pooler accepts the TCP connection and
// completes authentication perfectly well; it is the QUERY that never comes back, because the
// pooler has no upstream session to hand it to. From the client's side the connection looks
// healthy, so postgres-js waits — and it has no query timeout of its own to wait against.
//
// THE PRIMITIVE NOW LIVES IN src/lib/db-timeout.ts, which imports nothing.
//
// It was defined here, next to `postgres`, `drizzle` and `dotenv`, and that is precisely why it was
// used in ONE file on the whole deployment: a module that documents itself as touching no database
// (src/lib/page-safety.ts, where every guarded read on this site actually goes) cannot import the
// driver just to get a Promise.race. Moving it makes the bound available to the code that needs it;
// re-exporting it here keeps every existing import working unchanged.
export {
  DB_TIMEOUT_MS,
  DbTimeoutError,
  DbCircuitOpenError,
  isDbUnavailable,
  dbCircuitOpen,
  dbCircuitState,
  withDbTimeout,
} from '@/lib/db-timeout';
