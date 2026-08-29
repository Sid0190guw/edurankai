// DB connection - simplified for Vercel (Node.js runtime)
// Local dev also uses Node, so single driver works everywhere
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { ddlPermitted, isDdlStatement, noteSuppressedDdl } from '@/lib/schema-bootstrap';
import { DbCircuitOpenError, dbCircuitOpen, registerAbortedTransactionHealer, registerPoolResetter } from '@/lib/db-timeout';
import { currentDbScope, scopeRefusesQuery } from '@/lib/db-scope';

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

/**
 * How many connections this instance's pool may hold. Declared here, above every reader — `const`
 * is not hoisted and that has taken pages down on this project.
 *
 * It is a CONSTANT and not a knob because two things have to agree on it: the postgres() options
 * below, and healAbortedTransactions(), which has to be able to reach EVERY open connection.
 */
export const POOL_MAX = 5;

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
  //
  // A SERVER-SIDE BOUND, BECAUSE withDbTimeout() SHEDS THE WAIT AND NOT THE CONNECTION.
  //
  // src/lib/db-timeout.ts says it in its own words: "The losing promise keeps running; only the
  // WAITING stops." postgres-js does not cancel the statement and does not return the connection to
  // the pool until the server answers. So the client-side race turns a hung page into a fast 503 --
  // and leaves one of only TWO connections on this instance reserved for as long as the pooler
  // ignores it. Two abandoned reads wedge the whole instance for every other request it is serving,
  // which is the same connection-exhaustion shape this file's history is entirely about.
  //
  // statement_timeout makes the SERVER give up and hand the slot back. It is sent in the startup
  // packet, which the transaction pooler forwards, so it applies to every statement on the
  // connection without a session-level SET (which transaction pooling would not keep).
  //
  // 30 SECONDS, DELIBERATELY GENEROUS, AND NOT A LATENCY BOUND. The latency bound is DB_TIMEOUT_MS
  // (8s) on the client, which is what makes a page degrade quickly; this is only the backstop that
  // stops a connection being held forever. Setting it near 8s instead would have killed the client
  // race -- an error at 8s is an ordinary query failure, which deliberately does NOT open the
  // circuit breaker, so /admin would go back to paying twelve separate failures instead of one --
  // and it would kill legitimately long work in the nightly crons, which share this client. Nothing
  // in a request can usefully run past 30s anyway: the platform gateway ends the invocation first.
  //
  // NOT AN ANSWER TO A SLOW QUERY. If something legitimately needs longer than this, the fix is the
  // query, not this number.
  // =================================================================================================
  // AND max:2 WAS TOO FAR THE OTHER WAY. THE THIRD MEASUREMENT BRACKETS IT.
  // =================================================================================================
  //
  //   max:5, idle_timeout:60  ->  the pooler ran out. Each instance HOARDED five connections for a
  //                               full minute after it stopped needing them.
  //   max:2, idle_timeout:15  ->  the pooler was fine and the PAGES starved. /admin fans out about a
  //                               dozen reads and readSetupStatus() fires six at once; through two
  //                               slots the surplus queued, blew the 8s fuse, and — with the breaker
  //                               opening on a single timeout — refused everything after it. The site
  //                               answered "we cannot reach the database" while psql was getting
  //                               143ms replies from the same database.
  //
  // Five slots with a fifteen-second idle is neither: enough concurrency that a page's own queries do
  // not queue behind each other, and connections handed back four times faster than the setting that
  // exhausted the pooler. The hoarding was always the idle window, not the count — that is the part
  // the first measurement got wrong about itself.
  //
  // The breaker change in src/lib/db-timeout.ts is the other half and matters more: no pool size is
  // safe while one slow read can refuse every subsequent read in the instance.
  // =================================================================================================
  // FOURTH MEASUREMENT, 2026-08-24. IT WAS NEVER `max`. IT IS THE HANDSHAKE.
  // =================================================================================================
  //
  // Everything above tunes how many connections an instance may hold. Measured against the live site
  // with the burst this file keeps prescribing, the answers separate on a different axis entirely —
  // whether the instance had to OPEN one:
  //
  //   /api/health, two statements, bounded at 5s:
  //     latencyMs 132-154   connection reused        every single one answered
  //     latencyMs 950-991   connection opened        answered, ~810ms of it the handshake alone
  //     no answer at 5000ms                          about a QUARTER of the ones that had to open
  //
  //   Concurrency ladder, same endpoint:  N=2 -> 1 failed.  N=6 -> 0.  N=8 -> 0.  N=10 -> 0.
  //   N=14 -> 3.  A single sequential request answered in 132ms throughout.
  //
  // TWO PARALLEL REQUESTS FAILING WHILE TEN SUCCEED IS NOT POOL EXHAUSTION. Queueing and pooler
  // saturation are load-proportional by definition; this is not proportional to anything. It is a
  // roughly fixed failure rate per CONNECTION ATTEMPT. That is why three rounds of tuning this
  // number — 1, then 5/60, then 2/15, then 5/15 — each looked reasonable, shipped, and changed
  // nothing: every one of them was tuning the wrong variable, and each was diagnosed from the same
  // 5s-timeout symptom that all four settings produce.
  //
  // WHICH MAKES idle_timeout:15 THE ACTIVE MISTAKE, not a neutral one. It was lowered from 300 on
  // the reasoning quoted above — "The functions now run in bom1, next to the database (19e34eb), so
  // that handshake is local and cheap". The handshake is 810ms. It is not cheap, and a warm instance
  // was throwing away a connection that works every time, fifteen seconds after its last request, to
  // re-roll a one-in-four chance of a multi-second stall on the next one. An admin opening a page a
  // minute apart paid that gamble on every single navigation, which is exactly the report this is
  // being fixed for.
  //
  // So: 300, back where it was, for the reason that was true then and is still true now. `max` stays
  // at 5 — the hoarding argument against it was the misdiagnosis above, and five is what keeps a
  // page's own reads from queueing behind each other.
  //
  // WHAT WOULD ACTUALLY REMOVE THE REMAINING FAILURES, in order, none of them this number:
  //   1. The handshake itself. 810ms to a pooler in the same AWS region as the functions is not a
  //      network distance, it is the pooler's per-connection cost. Fewer connections is the only
  //      lever this file has over it; the rest is a Supabase-side setting.
  //   2. src/lib/db-timeout.ts withDbRetry(), which asks a second time instead of waiting longer.
  //      That is what turns the remaining quarter into a slower page instead of a dead one.
  //
  // RE-MEASURE BEFORE CHANGING THIS AGAIN, and measure the right thing. Not "how many 503s" — that
  // number is the same for every setting here. Read `database.latencyMs` out of /api/health across a
  // burst and count how many are in the ~950ms population: that is how many connections were opened,
  // and it is the only quantity in this file that anything above actually moves.
  _client = postgres(connectionString, {
    prepare: false,
    max: POOL_MAX,
    idle_timeout: 300,
    max_lifetime: 60 * 30,
    connect_timeout: 10,
    connection: {
      // A bare number is milliseconds to Postgres, which is what both of these want. postgres-js
      // types them as numbers and stringifies them into the startup packet itself.
      statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS) > 0
        ? Number(process.env.PG_STATEMENT_TIMEOUT_MS) : 30000,
      // A transaction left open by a crashed handler holds its locks AND its slot. Bounded for the
      // same reason: this deployment cannot afford either.
      idle_in_transaction_session_timeout: Number(process.env.PG_IDLE_TXN_TIMEOUT_MS) > 0
        ? Number(process.env.PG_IDLE_TXN_TIMEOUT_MS) : 15000,
    },
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
  // THE SCOPED REFUSAL, ASKED FIRST AND ASKED OF ALMOST NOBODY.
  //
  // Outside a scope opened by src/lib/db-scope.ts this is one undefined lookup and nothing else, so
  // every ordinary query in the deployment is unaffected — which is the entire design constraint.
  // Inside one, it is what stops a fan-out member that was ALREADY RUNNING when the circuit opened
  // from sending its second and third statements into a database every other read is being refused
  // for. src/lib/db-fanout.ts opens the scope; src/lib/db-scope.ts explains why the alternative — a
  // gate on this function for everyone, writes included — is the wrong shape.
  //
  // BEFORE THE DDL GUARD, deliberately. A refused statement must not be classified, counted as
  // suppressed DDL, or reported as an empty result: the caller asked for a read and is owed an error
  // it can degrade on, not silence.
  try {
    const scope = currentDbScope();
    if (scope && scopeRefusesQuery(dbCircuitOpen(), scope)) {
      return Promise.reject(new DbCircuitOpenError(scope.label));
    }
  } catch { /* a guard may never become the failure; fall through and run the statement */ }
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

// -------------------------------------------------------------------------------------------------
// GETTING A POISONED CONNECTION BACK, BECAUSE ONE OF THEM POISONS A FIFTH OF THE SITE
// -------------------------------------------------------------------------------------------------
//
// SQLSTATE 25P02 — "current transaction is aborted, commands ignored until end of transaction block"
// — does not describe the query that received it. It describes the CONNECTION: something opened a
// transaction on it, a statement inside failed, and nothing ever sent ROLLBACK. Postgres will now
// refuse every statement on that session until one arrives.
//
// src/lib/ensure-once.ts records the shape that produced this on 2026-08-24 and closes it: DDL
// batches no longer write their own BEGIN/COMMIT into a simple-protocol message. This is the net
// under that fix, for anything else that can leave a session in a transaction — a handler killed
// mid-transaction, a pooler that hands back a session it had pinned.
//
// WHY IT SWEEPS RATHER THAN TARGETS. postgres-js chooses the connection; a caller never learns which
// one answered, so there is no way to send ROLLBACK to the one that failed. Issuing POOL_MAX
// ROLLBACKs CONCURRENTLY is what reaches all of them: each concurrent query takes a different free
// connection, so every open session in the pool gets one. On a healthy session ROLLBACK is a no-op
// that returns a warning and changes nothing, which is what makes the sweep safe to fire blind.
//
// Verified against a real PostgreSQL (PGlite over TCP, never the production database): a connection
// answering 25P02 answers normally on the query after the ROLLBACK.
let _healingAt = 0;
let _healing: Promise<number> | null = null;

/**
 * Clear any aborted transaction left behind on this instance's pooled connections.
 *
 * Never throws and never rejects: it is called from failure paths, and a recovery that can itself
 * fail a request is worse than the fault it is recovering from. Returns how many ROLLBACKs the
 * database accepted, for the log.
 *
 * DEBOUNCED, and shared. A poisoned connection typically fails several queries in the same second;
 * one sweep answers all of them, and a second sweep on top of the first would only spend round
 * trips. Concurrent callers await the sweep already running.
 */
export function healAbortedTransactions(): Promise<number> {
  if (_healing) return _healing;
  const now = Date.now();
  if (now - _healingAt < 2000) return Promise.resolve(0);
  _healingAt = now;
  _healing = (async () => {
    if (!_client) return 0;
    const client = _client;
    // Fired together, not in sequence: sequential ROLLBACKs would all be served by the FIRST free
    // connection and never reach the poisoned one.
    const results = await Promise.all(
      Array.from({ length: POOL_MAX }, () =>
        client.unsafe('ROLLBACK').simple().then(() => 1).catch(() => 0)),
    );
    const healed = results.reduce((a: number, b: number) => a + b, 0);
    console.warn(JSON.stringify({
      ts: new Date().toISOString(), level: 'warn', event: 'db.aborted_txn_swept',
      rolledBack: healed, poolMax: POOL_MAX,
      note: 'a connection was left inside an aborted transaction; the pool was swept with ROLLBACK',
    }));
    return healed;
  })().catch(() => 0).finally(() => { _healing = null; });
  return _healing;
}

// -------------------------------------------------------------------------------------------------
// THROWING THE POOL AWAY, BECAUSE A CONNECTION THAT IS NEVER ANSWERED IS NEVER GIVEN BACK
// -------------------------------------------------------------------------------------------------
//
// The measurement and the reasoning are in src/lib/db-timeout.ts, above registerPoolResetter().
// The short version, from the live site on 2026-08-25: one warm instance answering every request
// with `{"database":{"ok":false,"latencyMs":-1},"dbCircuit":{"timeouts":29},"lastDbFailure":null}`
// while eleven of twelve fresh instances read the same database in 129-138ms.
//
// `lastDbFailure: null` after twenty-nine timeouts is the proof: the driver never errored. The
// pooler swallowed the queries, postgres-js is still waiting for answers that are not coming, and
// every one of those waits is holding one of the five slots this file spends its entire header
// arguing about. Neither connect_timeout (10s) nor statement_timeout (30s) can end a statement the
// upstream server never received. healAbortedTransactions() above cannot help either — there is no
// aborted transaction, and the ROLLBACK it would send would queue behind the same swallowed query.
//
// So the only recovery is to stop using those sockets. This is that.
//
// LAZY, WHICH IS WHAT MAKES IT SAFE. Nothing is reconnected here: `_client` and `_real` are dropped
// and the next connect() builds a fresh pool on demand. If the instance is about to be recycled
// anyway, the reset costs nothing at all.
//
// THE OLD CLIENT IS DESTROYED IN THE BACKGROUND AND NEVER AWAITED. end() without options waits for
// in-flight queries to finish, and the queries in flight here are by definition the ones that never
// finish — awaiting it would hang the very request that is trying to recover. `{ timeout: 0 }`
// destroys the sockets immediately, and even that is fired and forgotten, because a recovery path
// that can itself hang is not a recovery path.
//
// DEBOUNCED, and deliberately by a window longer than the circuit's own cooldown. An instance whose
// database is genuinely gone re-opens the circuit every cooldown; without this it would rebuild its
// pool every cooldown too, paying an ~810ms handshake each time to discover the same thing.
const POOL_RESET_DEBOUNCE_MS = 30_000;
let _poolResetAt = 0;
let _poolResetCount = 0;

/**
 * Drop this instance's connection pool. The next query builds a new one.
 *
 * Returns true if a pool was actually discarded. Never throws: every caller is a failure path.
 */
export function resetDbPool(reason: string): boolean {
  const now = Date.now();
  if (now - _poolResetAt < POOL_RESET_DEBOUNCE_MS) return false;
  const old = _client;
  // Nothing to throw away. Not an error: an instance can open the circuit before it ever connected.
  if (!old) return false;
  _poolResetAt = now;
  _poolResetCount += 1;
  _client = null;
  _real = null;
  try {
    Promise.resolve(old.end({ timeout: 0 })).catch(() => {});
  } catch { /* the sockets are being abandoned either way */ }
  console.error(JSON.stringify({
    ts: new Date().toISOString(), level: 'error', event: 'db.pool_reset',
    reason, resets: _poolResetCount, poolMax: POOL_MAX,
    note: 'the pool was discarded; the next query opens a new one',
  }));
  return true;
}

/** For /api/health: how many times this instance has had to discard its pool. */
export function dbPoolResets(): number {
  return _poolResetCount;
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
  dbPoolResetState,
  withDbTimeout,
  isAbortedTransaction,
} from '@/lib/db-timeout';

// THE SWEEP IS HANDED TO THE MODULE THAT CANNOT IMPORT IT.
//
// db-timeout.ts imports nothing on purpose, so withDbRetry() cannot reach the pool it needs to
// ROLLBACK. Registering it here, at load, is what lets a gate recover from a poisoned connection
// instead of turning it into "Sign-in is temporarily unavailable". Importing this module is already
// unavoidable for anything that queries, so there is no path where a query runs and this has not.
registerAbortedTransactionHealer(() => healAbortedTransactions());

// AND SO IS THE POOL REPLACEMENT, for the same reason and by the same route. POOL_MAX is passed
// rather than imported: db-timeout.ts imports nothing, and a second copy of that number in a module
// that cannot see this one is a number that drifts.
registerPoolResetter((reason: string) => resetDbPool(reason), POOL_MAX);
