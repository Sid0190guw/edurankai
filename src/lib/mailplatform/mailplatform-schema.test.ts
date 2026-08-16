// Schema and migration tests.
//
// These assert the INVARIANTS of the DDL, not the presence of particular columns. A test that
// re-lists every column is a second copy of the schema that has to be edited twice; a test that
// asserts "every table is prefixed, has timestamps, and collides with nothing that already exists"
// keeps holding as the schema grows — and catches the two mistakes that would actually hurt.

import { describe, it, expect } from 'vitest';
import { MP_DDL, MP_EXTENSIONS, MP_TABLES, MP_TRIGGERS, SCHEMA_VERSION, mailPlatformSchemaSql } from './schema';

/** Table names this repository already owns. A new table with one of these names breaks live code. */
const EXISTING_TABLES = [
  'users', 'sessions', 'roles', 'permissions', 'api_keys', 'events', 'departments',
  'mail_messages', 'mail_recipients', 'mail_box', 'mail_attachments', 'mail_settings',
  'mail_config', 'mail_labels', 'mail_rules', 'mail_groups', 'mail_scheduled', 'email_logs',
  'workflow_instances', 'workflow_steps', 'hr_employees', 'training_courses', 'edu_jobs',
];

describe('mail platform schema', () => {
  it('creates 40+ tables and every one is mp_-prefixed', () => {
    expect(MP_TABLES.length).toBeGreaterThanOrEqual(40);
    for (const table of MP_TABLES) {
      expect(table, `${table} must be mp_-prefixed`).toMatch(/^mp_/);
    }
  });

  it('collides with no table this repository already owns', () => {
    // The failure this prevents is not hypothetical: the brief asked for tables called `roles`,
    // `workflows`, `events` and `templates`, and three of those names are live here.
    for (const table of MP_TABLES) {
      expect(EXISTING_TABLES, `${table} collides with an existing table`).not.toContain(table);
    }
  });

  it('gives every entity table created_at and updated_at', () => {
    // Event and join tables are exempt: an append-only fact is never updated, so an updated_at on
    // one would always equal created_at and invite a reader to believe otherwise.
    const appendOnly = new Set([
      'mp_events', 'mp_delivery_events', 'mp_campaign_events', 'mp_contact_events',
      'mp_workflow_events', 'mp_message_headers', 'mp_message_labels', 'mp_contact_tag_members',
      'mp_role_permissions', 'mp_audit_logs', 'mp_bounce_events', 'mp_delivery_attempts',
      'mp_domain_verifications', 'mp_template_versions', 'mp_schema_migrations',
    ]);
    for (const stmt of MP_DDL) {
      const name = /CREATE TABLE IF NOT EXISTS ([a-z_]+)/.exec(stmt)?.[1];
      if (!name) continue;
      // mp_schema_migrations is bookkeeping, not an entity: `applied_at` IS its timestamp and
      // naming it created_at would say something less precise about what the row records.
      if (name === 'mp_schema_migrations') {
        expect(stmt).toContain('applied_at');
        continue;
      }
      expect(stmt, `${name} needs created_at`).toContain('created_at');
      if (!appendOnly.has(name)) {
        expect(stmt, `${name} needs updated_at`).toContain('updated_at');
      }
    }
  });

  it('uses uuid primary keys except where a monotonic id is the point', () => {
    // bigserial is correct for append-only streams: it IS the pagination cursor, and a uuid there
    // would need a separate ordering column.
    const bigserialAllowed = new Set([
      'mp_events', 'mp_delivery_events', 'mp_campaign_events', 'mp_contact_events',
      'mp_workflow_events', 'mp_message_headers',
    ]);
    for (const stmt of MP_DDL) {
      const name = /CREATE TABLE IF NOT EXISTS ([a-z_]+)/.exec(stmt)?.[1];
      if (!name || name === 'mp_schema_migrations') continue;
      const hasUuidPk = /id UUID PRIMARY KEY/.test(stmt) || /PRIMARY KEY \(/.test(stmt) || /UUID PRIMARY KEY/.test(stmt);
      const hasBigserial = /BIGSERIAL PRIMARY KEY/.test(stmt);
      if (hasBigserial) {
        expect(bigserialAllowed, `${name} uses bigserial but is not an append-only stream`).toContain(name);
      } else {
        expect(hasUuidPk, `${name} needs a uuid primary key`).toBe(true);
      }
    }
  });

  it('scopes every tenant-owned table by org_id', () => {
    const notTenantScoped = new Set([
      'mp_schema_migrations', 'mp_organizations', 'mp_message_labels', 'mp_contact_tag_members',
      'mp_role_permissions', 'mp_message_headers',
      // mp_roles allows a NULL org_id for system-wide roles, so it is checked separately below.
      'mp_roles',
    ]);
    for (const stmt of MP_DDL) {
      const name = /CREATE TABLE IF NOT EXISTS ([a-z_]+)/.exec(stmt)?.[1];
      if (!name || notTenantScoped.has(name)) continue;
      expect(stmt, `${name} must carry org_id — this is what stops one tenant reading another's data`).toMatch(/org_id UUID/);
    }
  });

  it('never stores a DKIM private key', () => {
    const dkim = MP_DDL.find((s) => s.includes('mp_dkim_keys')) || '';
    expect(dkim).toContain('public_key');
    expect(dkim).toContain('private_key_ref');
    // The column that must not exist. A signing key in a queryable column defeats DKIM entirely.
    expect(dkim).not.toMatch(/private_key\s+TEXT/);
    expect(dkim).not.toMatch(/private_key_pem/);
  });

  it('makes a campaign send idempotent per recipient', () => {
    // Without this index a resumed campaign mails the first half twice.
    const index = MP_DDL.find((s) => s.includes('mp_cr_campaign_addr_uk'));
    expect(index).toBeTruthy();
    expect(index).toContain('UNIQUE');
    expect(index).toContain('campaign_id, lower(address)');
  });

  it('allows exactly one default sending identity per organization', () => {
    const index = MP_DDL.find((s) => s.includes('mp_identity_default_uk'));
    expect(index).toBeTruthy();
    expect(index).toContain('WHERE is_default');
  });

  it('stops a contact entering the same workflow twice while a run is open', () => {
    const index = MP_DDL.find((s) => s.includes('mp_wfr_active_uk'));
    expect(index).toBeTruthy();
    expect(index).toContain("status IN ('running','waiting')");
  });

  it('deduplicates provider delivery events so a redelivered webhook cannot double-count', () => {
    const index = MP_DDL.find((s) => s.includes('mp_devent_provider_uk'));
    expect(index).toBeTruthy();
    expect(index).toContain('UNIQUE');
  });

  it('only ever ADDS to tables it does not own', () => {
    for (const stmt of MP_EXTENSIONS) {
      const touchesExisting = /ALTER TABLE (\w+)/.exec(stmt);
      if (touchesExisting) {
        expect(stmt, `"${stmt.slice(0, 60)}" must be additive`).toMatch(/ADD COLUMN IF NOT EXISTS/);
        expect(stmt).not.toMatch(/DROP COLUMN|ALTER COLUMN|RENAME/);
      }
      expect(stmt).not.toMatch(/DROP TABLE/);
    }
  });

  it('is idempotent — every statement can be re-run', () => {
    for (const stmt of [...MP_DDL, ...MP_EXTENSIONS]) {
      const safe =
        /IF NOT EXISTS/.test(stmt) ||
        /OR REPLACE/.test(stmt) ||
        /ON CONFLICT/.test(stmt);
      expect(safe, `not re-runnable: ${stmt.slice(0, 80)}`).toBe(true);
    }
  });

  it('maintains updated_at in the database rather than trusting every writer', () => {
    const joined = MP_TRIGGERS.join('\n');
    expect(joined).toContain('mp_touch_updated_at');
    expect(joined).toContain('BEFORE UPDATE');
  });

  it('renders a .sql file that is transactional and version-stamped', () => {
    const sql = mailPlatformSchemaSql();
    expect(sql).toContain('BEGIN;');
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain(`mp_schema_migrations (version, note) VALUES (${SCHEMA_VERSION}`);
    // Every statement must be terminated. A missing semicolon makes psql swallow the next statement
    // into this one and the migration fails in a way that names the wrong line.
    const bodyStatements = sql.split('\n\n').filter((chunk) => /^(CREATE|ALTER|DO|INSERT)/.test(chunk.trim()));
    for (const chunk of bodyStatements) {
      expect(chunk.trimEnd().endsWith(';'), `unterminated: ${chunk.slice(0, 60)}`).toBe(true);
    }
  });
});
