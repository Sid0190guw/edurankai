// src/lib/schema-bootstrap.test.ts
//
// The two mechanisms the 2026-08-24 incident fix rests on, tested against the statement shapes this
// repository actually sends and the failure this deployment actually has.
//
// WHY THESE TWO NEED A TEST MORE THAN MOST. Both are guards, and a guard that is wrong in the
// permissive direction is invisible: the DDL classifier misjudging a SELECT would silently drop a
// read, and the circuit breaker failing to close would leave a recovered database looking dead. The
// repository's own history is the argument — a bootstrap here once reported "ok: true, ran: 8,
// failed: 0" while ten tables were missing, because nothing checked what it actually did.
import { describe, it, expect, afterEach } from 'vitest';
import { isDdlStatement, schemaBootstrapEnabled, ddlPermitted, allowingDdl } from './schema-bootstrap';
import {
  withDbTimeout, dbCircuitOpen, dbCircuitState, isDbUnavailable,
  DbTimeoutError, DbCircuitOpenError,
} from './db-timeout';

const ENV = {
  NODE_ENV: process.env.NODE_ENV,
  SCHEMA_BOOTSTRAP: process.env.SCHEMA_BOOTSTRAP,
  DB_CIRCUIT_COOLDOWN_MS: process.env.DB_CIRCUIT_COOLDOWN_MS,
};
const restore = (k: keyof typeof ENV) => {
  if (ENV[k] === undefined) delete process.env[k];
  else process.env[k] = ENV[k] as string;
};
/**
 * Put the environment back after every case.
 *
 * Registered INSIDE each suite that mutates it, not once at the top of the file: a file-level
 * afterEach() does not collect under this repository's Vitest setup (it throws "failed to find the
 * current suite" before a single test runs), so a hook written there would silently take the whole
 * suite with it. These cases set NODE_ENV and SCHEMA_BOOTSTRAP, and leaking either into another
 * suite would make an unrelated test pass or fail for the wrong reason.
 */
function restoreEnvAfterEach(): void {
  afterEach(() => { restore('NODE_ENV'); restore('SCHEMA_BOOTSTRAP'); restore('DB_CIRCUIT_COOLDOWN_MS'); });
}

describe('isDdlStatement recognises what this repository actually sends', () => {
  // Every one of these is a real statement shape copied from a module in src/lib. If the classifier
  // misses one, that statement keeps running on the request path in production.
  const ddl: [string, string][] = [
    ['CREATE TABLE IF NOT EXISTS', 'CREATE TABLE IF NOT EXISTS edu_error_log (id bigserial PRIMARY KEY)'],
    ['ADD COLUMN IF NOT EXISTS', 'ALTER TABLE edu_error_log ADD COLUMN IF NOT EXISTS fingerprint text'],
    // The one that fires the PostgREST reload every single time, because it has no IF NOT EXISTS
    // form to skip: src/lib/study-abroad.ts ends its 37-statement reconciliation with this.
    ['ALTER COLUMN DROP NOT NULL', 'ALTER TABLE study_abroad_requests ALTER COLUMN applicant_user_id DROP NOT NULL'],
    ['CREATE INDEX IF NOT EXISTS', 'CREATE INDEX IF NOT EXISTS edu_error_log_fp_idx ON edu_error_log (fingerprint)'],
    ['CREATE OR REPLACE FUNCTION', 'CREATE OR REPLACE FUNCTION mp_touch_updated_at() RETURNS trigger AS $mp$ BEGIN RETURN NEW; END; $mp$ LANGUAGE plpgsql'],
    ['CREATE TRIGGER', 'CREATE TRIGGER hr_events_no_update_delete BEFORE UPDATE ON hr_events FOR EACH ROW EXECUTE FUNCTION f()'],
    ['DROP TRIGGER IF EXISTS', 'DROP TRIGGER IF EXISTS mti_actions_no_change ON mti_manager_actions'],
    ['COMMENT ON', "COMMENT ON TABLE hr_events IS 'append only'"],
    // sql.raw() strings in this repo are template literals that start with a newline and indentation.
    // Testing the trimmed form only would have passed while the real thing sailed through.
    ['leading newline and indentation', '\n    ALTER TABLE xp_events ADD COLUMN IF NOT EXISTS delta INTEGER\n  '],
    ['leading SQL line comment', '-- additive, observability\nALTER TABLE edu_error_log ADD COLUMN IF NOT EXISTS "release" text'],
    ['leading block comment', '/* generated */ CREATE TABLE IF NOT EXISTS mp_schema_migrations (version int)'],
    ['lower case', 'create table if not exists foo (id int)'],
    // src/lib/mailplatform/schema.ts and src/lib/hr-events.ts both wrap DDL in a DO block, which is
    // where the trigger churn on ~47 mp_* tables comes from.
    ['DO block containing CREATE TRIGGER', 'DO $mp$ BEGIN CREATE TRIGGER t BEFORE UPDATE ON mp_x FOR EACH ROW EXECUTE FUNCTION f(); END $mp$'],
  ];
  for (const [name, stmt] of ddl) {
    it('treats ' + name + ' as DDL', () => expect(isDdlStatement(stmt)).toBe(true));
  }
});

describe('isDdlStatement leaves real work alone', () => {
  // FAILING OPEN IS THE WHOLE SAFETY ARGUMENT. A statement this misclassifies as DDL is a query that
  // silently returns no rows — which on an admin surface reads as "there is none of that" and is
  // precisely the confident-empty-list lie page-safety.ts exists to prevent.
  const notDdl: [string, string][] = [
    ['SELECT', 'SELECT COUNT(*) FROM applications WHERE is_archived = false'],
    ['INSERT', "INSERT INTO edu_error_log (event) VALUES ('x')"],
    ['UPDATE', "UPDATE users SET role = 'applicant' WHERE id = $1"],
    ['DELETE', 'DELETE FROM sessions WHERE id = $1'],
    ['WITH', 'WITH t AS (SELECT 1) SELECT * FROM t'],
    ['BEGIN', 'BEGIN'],
    ['COMMIT', 'COMMIT'],
    ['SET LOCAL', "SET LOCAL lock_timeout = '3s'"],
    // The words appear, but not as the command. A keyword-anywhere test would have eaten these.
    ['a SELECT mentioning create', "SELECT 1 FROM pg_tables WHERE tablename = 'create_me'"],
    ['a SELECT of a column named alter', 'SELECT alter_count FROM audit_log'],
    ['a DO block with no DDL in it', 'DO $$ BEGIN RAISE NOTICE $$'],
    ['empty', ''],
    ['whitespace only', '   \n  '],
  ];
  for (const [name, stmt] of notDdl) {
    it('does not treat ' + name + ' as DDL', () => expect(isDdlStatement(stmt)).toBe(false));
  }
});

describe('schemaBootstrapEnabled keeps the policy it was given', () => {
  restoreEnvAfterEach();
  // The policy is not being changed by this incident fix, only enforced in a second place. If this
  // matrix drifts, request-time DDL comes back on in production without anybody deciding to.
  it('is OFF in production by default', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.SCHEMA_BOOTSTRAP;
    expect(schemaBootstrapEnabled()).toBe(false);
  });
  it('is ON outside production by default, so dev and vitest still build their own schema', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.SCHEMA_BOOTSTRAP;
    expect(schemaBootstrapEnabled()).toBe(true);
  });
  it('SCHEMA_BOOTSTRAP=on overrides production, without a deploy', () => {
    process.env.NODE_ENV = 'production';
    process.env.SCHEMA_BOOTSTRAP = 'on';
    expect(schemaBootstrapEnabled()).toBe(true);
  });
  it('SCHEMA_BOOTSTRAP=off overrides development', () => {
    process.env.NODE_ENV = 'development';
    process.env.SCHEMA_BOOTSTRAP = 'off';
    expect(schemaBootstrapEnabled()).toBe(false);
  });
  it('is case-insensitive, because an environment variable is typed by a human', () => {
    process.env.NODE_ENV = 'production';
    process.env.SCHEMA_BOOTSTRAP = 'ON';
    expect(schemaBootstrapEnabled()).toBe(true);
  });
});

describe('allowingDdl scopes the escape hatch to one call chain', () => {
  restoreEnvAfterEach();
  it('permits DDL inside, and only inside', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SCHEMA_BOOTSTRAP = 'off';
    expect(ddlPermitted()).toBe(false);
    const inside = await allowingDdl(async () => {
      // Across an await too: an operator repair is asynchronous, and a scope that did not survive one
      // would permit the first statement and refuse the rest, which is the worst of both.
      await Promise.resolve();
      return ddlPermitted();
    });
    expect(inside).toBe(true);
    expect(ddlPermitted()).toBe(false);
  });

  it('does not leak into concurrent work outside the scope', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SCHEMA_BOOTSTRAP = 'off';
    // The reason this is AsyncLocalStorage and not a module-level boolean: one warm serverless
    // instance serves concurrent invocations, and a flag set by an admin repair would have let an
    // unrelated visitor's page render DDL for as long as the repair took.
    let outsideSawPermitted: boolean | null = null;
    const outside = (async () => {
      await Promise.resolve();
      outsideSawPermitted = ddlPermitted();
    })();
    await Promise.all([allowingDdl(async () => { await Promise.resolve(); }), outside]);
    expect(outsideSawPermitted).toBe(false);
  });
});

describe('the database circuit breaker', () => {
  restoreEnvAfterEach();

  /** A promise that never settles — exactly what the pooler does when it has no upstream session. */
  const hang = () => new Promise<never>(() => {});

  /**
   * Put the breaker back in the closed state.
   *
   * The state is per-module and deliberately so (it is a property of this serverless instance, not of
   * one request), which means the cases below have to establish their own starting point rather than
   * inherit whatever the previous one left. A lapsed cooldown plus one SUCCESSFUL wait is the only
   * thing that closes it, so that is what this does — which also exercises the recovery path.
   */
  async function closeCircuit(): Promise<void> {
    process.env.DB_CIRCUIT_COOLDOWN_MS = '1';
    await new Promise((r) => setTimeout(r, 5));
    await withDbTimeout(Promise.resolve('ok'), 'test.reset', 1000);
    expect(dbCircuitOpen()).toBe(false);
  }

  it('a timeout rejects with DbTimeoutError and opens the circuit', async () => {
    await closeCircuit();
    process.env.DB_CIRCUIT_COOLDOWN_MS = '5000';
    await expect(withDbTimeout(hang(), 'test.hang', 20)).rejects.toBeInstanceOf(DbTimeoutError);
    expect(dbCircuitOpen()).toBe(true);
    expect(dbCircuitState().timeouts).toBeGreaterThan(0);
    expect(dbCircuitState().msRemaining).toBeGreaterThan(0);
  });

  it('while open, the next wait is refused INSTANTLY instead of waiting again', async () => {
    // This is the property that makes a per-query bound sufficient on a page with a dozen reads.
    // /admin issues roughly twelve sequential reads, and twelve consecutive 8-second timeouts is
    // ninety-six seconds — a gateway timeout reached by a slower route. One timeout, eleven instant
    // refusals, and the page renders its "could not be read" states instead.
    await closeCircuit();
    process.env.DB_CIRCUIT_COOLDOWN_MS = '5000';
    await withDbTimeout(hang(), 'test.hang', 20).catch(() => {});
    expect(dbCircuitOpen()).toBe(true);
    const started = Date.now();
    await expect(withDbTimeout(hang(), 'test.refused', 5000)).rejects.toBeInstanceOf(DbCircuitOpenError);
    // Refused without waiting: nowhere near the five-second bound it was handed.
    expect(Date.now() - started).toBeLessThan(250);
  });

  it('both failures report as database-unavailable; an ordinary query error does not', async () => {
    await closeCircuit();
    process.env.DB_CIRCUIT_COOLDOWN_MS = '5000';
    const seen: any[] = [];
    await withDbTimeout(hang(), 'test.hang', 20).catch((e) => seen.push(e));
    await withDbTimeout(hang(), 'test.refused', 5000).catch((e) => seen.push(e));
    expect(seen.length).toBe(2);
    expect(seen.every((e) => isDbUnavailable(e))).toBe(true);
    // A real query error is NOT this, and that distinction is load-bearing: tripping the breaker on a
    // missing table would take working pages down over a schema that was simply never applied, and
    // the middleware gates would answer 503 instead of doing their job.
    expect(isDbUnavailable(new Error('relation "foo" does not exist'))).toBe(false);
  });

  it('a success closes the circuit again, so recovery needs no deploy', async () => {
    process.env.DB_CIRCUIT_COOLDOWN_MS = '5000';
    await withDbTimeout(hang(), 'test.hang', 20).catch(() => {});
    expect(dbCircuitOpen()).toBe(true);
    // The cooldown lapses, one probe is let through, it answers — and the breaker is closed.
    process.env.DB_CIRCUIT_COOLDOWN_MS = '1';
    await new Promise((r) => setTimeout(r, 5));
    await expect(withDbTimeout(Promise.resolve('answered'), 'test.recovered', 1000)).resolves.toBe('answered');
    process.env.DB_CIRCUIT_COOLDOWN_MS = '5000';
    expect(dbCircuitOpen()).toBe(false);
  });

  it('observes the promise it refuses, so a rejection cannot crash the instance', async () => {
    // An unhandled rejection on a promise nobody awaits can take a Node process down. The refusal
    // path attaches a catch precisely so that telling a caller "circuit open" cannot kill the
    // serverless instance that is still trying to serve everyone else.
    await closeCircuit();
    process.env.DB_CIRCUIT_COOLDOWN_MS = '5000';
    await withDbTimeout(hang(), 'test.hang', 20).catch(() => {});
    let unhandled: unknown = null;
    const onUnhandled = (e: unknown) => { unhandled = e; };
    process.on('unhandledRejection', onUnhandled);
    try {
      await withDbTimeout(Promise.reject(new Error('boom')), 'test.refused', 1000).catch(() => {});
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toBe(null);
  });
});
