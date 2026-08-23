// src/lib/talent/sources.ts — THE RECRUITMENT SOURCE REGISTRY. Spec section 15, finding F5.
//
// PROVENANCE, NOT ATTRIBUTION. These are two different questions about the same application, and a
// report that adds them together double-counts every channel:
//
//   ATTRIBUTION   "How did you hear about us?"  Candidate-declared, deliberately unverified, an
//                 option on the application form. That is src/lib/application-sources.ts
//                 (`application_sources`, `listActiveSources`, `recordSourceUse`,
//                 `recordSuggestion`), it stays exactly where it is, and NOTHING IN THIS FILE
//                 DUPLICATES OR READS IT.
//
//   PROVENANCE    "Which system did this application actually arrive through?"  Asserted by the
//                 ingestion path — an authenticated partner key, a signed webhook, a CSV an
//                 administrator confirmed, or a manual entry — and carrying an external application
//                 identifier that has to survive forever so the two systems can be reconciled.
//                 That is this file: `tal_recruitment_source`, `tal_source_key`,
//                 `tal_external_application_ref`, `tal_ingest_quarantine`.
//
// A candidate can truthfully say a friend told them about us AND have arrived through a partner
// portal. Both are recorded. Neither answer is the other one.
//
// SOURCE NAMES ARE INTERNAL. NO FUNCTION IN THIS MODULE RETURNS ANYTHING INTENDED FOR A PUBLIC PAGE.
// `name` is admin display only — spec 15 rule 6 ("No source name appears in candidate-facing copy")
// and the standing project rule that no outside company is named in user-facing copy. The public
// careers portal renders no source at all, and the seed below is deliberately generic channel
// categories rather than platform names, so a fresh database cannot leak one by accident.
//
// THE SECRET IS SHOWN ONCE. issueSourceKey() returns the only plaintext copy that will ever exist;
// the row keeps a sha256 and a sixteen-character display prefix. There is no reveal path to build,
// no support process that can leak one, and a database dump hands nobody a live ingest credential.
// Same shape as src/lib/mailapi/keys.ts and src/lib/api-keys.ts — the reference the spec names.
import crypto from 'node:crypto';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { ensureTalent } from '@/lib/talent/schema';
import { logAudit, logAuditOrThrow } from '@/lib/audit';
import {
  SOURCE_CATEGORIES, INGEST_MODES,
  okResult, failResult, rowsOf, reasonOf,
  type RecruitmentSource, type SourceCategory, type IngestMode, type TalentResult,
} from '@/lib/talent/types';

// ---------------------------------------------------------------------------------------------
// MODULE CONSTANTS. Declared before anything that reads them: `const` is not hoisted, and a
// handler that reached a later declaration has taken pages down on this project.
// ---------------------------------------------------------------------------------------------

const SEED_KEY = 'talent_recruitment_sources_seed_v1';

/** The token every source key starts with. Distinct from erk_ (partner REST) and erm_ (mail API). */
const KEY_TOKEN = 'ersk_';
const KEY_RANDOM_BYTES = 32;
/** What the console shows instead of a key. Enough to name one in a ticket, useless for ingest. */
const KEY_PREFIX_LEN = 16;
/** tal_source_key.key_prefix is UNIQUE; a collision is astronomically unlikely but is retried, not
 *  reported to an operator as a mysterious database complaint about their own click. */
const KEY_MINT_ATTEMPTS = 3;

const SOURCE_KEY_RE = new RegExp('^' + KEY_TOKEN + '[0-9a-f]{' + KEY_RANDOM_BYTES * 2 + '}$');

/**
 * Compared against when the presented prefix matches no row, so an unknown prefix costs the same
 * hash comparison as a known one. Without it the endpoint answers "does this prefix exist?" in
 * microseconds, which is an oracle for enumerating live sources.
 */
const ABSENT_KEY_HASH = crypto.createHash('sha256').update('tal_source_key:absent').digest('hex');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SOURCE_NAME_MAX = 120;
/** External identifiers are opaque and length-capped — spec 15 validation rules. */
export const EXTERNAL_ID_MAX = 200;
/** A partner that posts a 40MB body must not be able to put 40MB in a JSONB column per delivery. */
export const PAYLOAD_MAX_BYTES = 256 * 1024;
const QUARANTINE_REASON_MAX = 500;
const LIST_LIMIT_DEFAULT = 100;
const LIST_LIMIT_MAX = 500;

/**
 * What a source key is allowed to do. NO WILDCARDS, in the grant or the requirement: an ingest
 * credential held by an outside system has exactly the powers it was issued, and `*` on a partner
 * key is how a narrow integration quietly becomes a broad one. (src/lib/mailapi/keys.ts supports
 * wildcards because its keys are first-party product keys; these are not.)
 */
export const SOURCE_KEY_SCOPES = ['candidate.ingest', 'candidate.status.read'] as const;
export type SourceKeyScope = (typeof SOURCE_KEY_SCOPES)[number];

/** A partner pushing candidates needs one power. Reading status back is asked for separately. */
export const DEFAULT_SOURCE_KEY_SCOPES: SourceKeyScope[] = ['candidate.ingest'];

/**
 * Seeded once so the registry is never empty on a fresh database; ADMIN-OWNED FROM THEN ON, in the
 * style of DEFAULTS in src/lib/application-sources.ts.
 *
 * DELIBERATELY GENERIC. These are channel categories, not partner names. A source row is created
 * per real integration by an administrator who knows which one it is; hard-coding platform names
 * into the product would put an outside company's name in the tree for every deployment, and one
 * copy-paste onto an admin export away from a public surface.
 */
export const DEFAULT_SOURCES: ReadonlyArray<{
  slug: string; name: string; category: SourceCategory; ingestMode: IngestMode; note: string;
}> = [
  {
    slug: 'careers-site', name: 'EduRankAI careers site', category: 'direct', ingestMode: 'manual',
    // The default provenance for an application that arrived through our own form. `manual` is the
    // honest mode: no external system asserted anything, our own apply flow recorded it.
    note: 'Applications submitted directly through the EduRankAI careers portal.',
  },
  {
    slug: 'hiring-platform', name: 'External hiring platform', category: 'platform', ingestMode: 'csv',
    note: 'Candidates arriving from a third-party hiring platform. Rename or add one row per platform.',
  },
  {
    slug: 'government-portal', name: 'Government internship or employment portal', category: 'government', ingestMode: 'csv',
    note: 'National or state portals that forward candidate records.',
  },
  {
    slug: 'institution-partnership', name: 'Institution partnership or placement cell', category: 'institution', ingestMode: 'csv',
    note: 'Placement cells and training partners that send cohorts.',
  },
  {
    slug: 'employee-referral', name: 'Internal referral', category: 'referral', ingestMode: 'manual',
    note: 'Referred by someone already inside the organisation. Attribution is recorded separately.',
  },
  {
    slug: 'community-outreach', name: 'Community outreach', category: 'community', ingestMode: 'manual',
    note: 'Meetups, communities and outreach programmes.',
  },
  {
    slug: 'partner-integration', name: 'Partner integration', category: 'partner', ingestMode: 'api',
    note: 'A partner system pushing candidates over the authenticated ingest API.',
  },
];

// ---------------------------------------------------------------------------------------------
// PURE HELPERS. No database, no clock, no randomness except where the name says so — so the
// validation this registry depends on is testable without a connection.
// ---------------------------------------------------------------------------------------------

export function isSourceCategory(v: unknown): v is SourceCategory {
  return typeof v === 'string' && (SOURCE_CATEGORIES as readonly string[]).includes(v);
}

export function isIngestMode(v: unknown): v is IngestMode {
  return typeof v === 'string' && (INGEST_MODES as readonly string[]).includes(v);
}

/**
 * Every id in these tables is a Postgres uuid. A non-uuid string bound into a uuid comparison makes
 * Postgres raise 22P02, which src/lib/api-keys.ts already learned reaches the operator as a database
 * complaint about their own click. Checked here instead, so the answer is "that is not a source id".
 */
export function isUuid(v: unknown): boolean {
  return typeof v === 'string' && UUID_RE.test(v.trim());
}

/**
 * PURE. The stable key for a source. Returns '' when the name contains nothing usable — the caller
 * is expected to have run sourceProblems() first, which reports exactly that.
 *
 * There is deliberately no timestamp fallback here (application-sources.ts has one): a slug that
 * depends on the clock is not a function of its input, cannot be tested, and produces a different
 * key every time an operator retries a failed create.
 */
export function sourceSlug(name: unknown): string {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

/**
 * PURE. EVERY problem with a proposed source, not the first one. Iterative single-error validation
 * is how somebody spends four submissions discovering four things — the same reason spec 5A requires
 * publish to list every failing precondition at once.
 */
export function sourceProblems(input: {
  name?: unknown; category?: unknown; ingestMode?: unknown;
}): string[] {
  const problems: string[] = [];
  const name = String(input.name || '').trim();

  if (!name) {
    problems.push('A source name is required.');
  } else {
    if (name.length > SOURCE_NAME_MAX) {
      problems.push('A source name must be ' + SOURCE_NAME_MAX + ' characters or fewer.');
    }
    if (!sourceSlug(name)) {
      problems.push('A source name must contain at least one letter or number.');
    }
  }

  if (!isSourceCategory(input.category)) {
    problems.push('Category must be one of: ' + SOURCE_CATEGORIES.join(', ') + '.');
  }
  if (!isIngestMode(input.ingestMode)) {
    problems.push('Ingest mode must be one of: ' + INGEST_MODES.join(', ') + '.');
  }
  return problems;
}

/**
 * PURE. An external application identifier is OPAQUE — trimmed and length-capped, never parsed for
 * meaning and never case-folded. Lower-casing it would collapse two genuinely distinct identifiers
 * from a case-sensitive partner system into one candidate, which is the exact failure the UNIQUE
 * index on (source_id, external_application_id) exists to make impossible.
 */
export function normalizeExternalId(raw: unknown): string {
  return String(raw ?? '').trim().slice(0, EXTERNAL_ID_MAX);
}

/** PURE. Format check only. Says nothing about whether the key exists. */
export function looksLikeSourceKey(raw: unknown): boolean {
  return SOURCE_KEY_RE.test(String(raw || '').trim());
}

/** Generate a source key. 32 bytes of CSPRNG output; the only plaintext copy that will ever exist. */
export function mintSourceKey(): string {
  return KEY_TOKEN + crypto.randomBytes(KEY_RANDOM_BYTES).toString('hex');
}

/** PURE. The displayable head of a key. Stored in `key_prefix` and shown on the admin console. */
export function sourceKeyPrefix(key: unknown): string {
  return String(key || '').trim().slice(0, KEY_PREFIX_LEN);
}

/** PURE. The only form of a key this system stores. */
export function hashSourceKey(key: unknown): string {
  return crypto.createHash('sha256').update(String(key || '').trim(), 'utf8').digest('hex');
}

/** PURE. What a screen or a log line may show: prefix, ellipsis, last four. Never the body. */
export function maskSourceKey(key: unknown): string {
  const k = String(key || '').trim();
  if (k.length < KEY_PREFIX_LEN + 8) return sourceKeyPrefix(k) + '...';
  return sourceKeyPrefix(k) + '...' + k.slice(-4);
}

/**
 * Constant-time hash comparison that ALWAYS RUNS. `crypto.timingSafeEqual` throws on a length
 * mismatch, so the mismatch branch burns an equivalent comparison rather than returning early —
 * an early return is a measurable difference and this function's whole job is not to have one.
 */
export function hashesMatch(a: unknown, b: unknown): boolean {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length || ba.length === 0) {
    if (ba.length > 0) crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * PURE. Validate a requested scope set, reporting every unknown scope. Order is normalised and
 * duplicates removed so two keys granted the same powers store the same array.
 */
export function normalizeScopes(raw: unknown): { scopes: SourceKeyScope[]; problems: string[] } {
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { scopes: DEFAULT_SOURCE_KEY_SCOPES.slice(), problems };
  if (!Array.isArray(raw)) return { scopes: [], problems: ['Scopes must be a list.'] };

  const seen = new Set<string>();
  for (const s of raw) {
    const v = String(s || '').trim();
    if (!v) continue;
    if (!(SOURCE_KEY_SCOPES as readonly string[]).includes(v)) {
      problems.push('Unknown scope "' + v + '". Source keys may hold: ' + SOURCE_KEY_SCOPES.join(', ') + '.');
      continue;
    }
    seen.add(v);
  }
  if (!problems.length && seen.size === 0) problems.push('A key must carry at least one scope.');
  // Ordered by the canonical list, not by what the caller happened to type.
  return { scopes: SOURCE_KEY_SCOPES.filter((s) => seen.has(s)), problems };
}

/** PURE. Exact match only — see SOURCE_KEY_SCOPES on why there is no wildcard here. */
export function hasSourceScope(granted: readonly string[] | null | undefined, required: SourceKeyScope): boolean {
  return Array.isArray(granted) && granted.includes(required);
}

/**
 * PURE. JSON text that Postgres will always accept into a jsonb column, for a payload that arrived
 * malformed by definition.
 *
 * THE POINT OF QUARANTINE IS THAT NOTHING IS DROPPED, so this never throws and never returns
 * nothing. A payload that cannot be serialised at all, or that is larger than a column should hold,
 * is replaced by a marker object that says so — an administrator reading the quarantine table can
 * then tell "the partner sent something unserialisable" from "we lost it".
 */
export function safeJsonPayload(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value === undefined ? null : value) as string;
  } catch (e: any) {
    return JSON.stringify({ __unserializable: true, reason: String(e?.message || 'could not be serialised') });
  }
  // JSON.stringify returns undefined for a function or a bare undefined; jsonb needs a value.
  if (typeof text !== 'string') return 'null';
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > PAYLOAD_MAX_BYTES) {
    return JSON.stringify({
      __truncated: true,
      bytes,
      limit: PAYLOAD_MAX_BYTES,
      preview: text.slice(0, 2000),
    });
  }
  return text;
}

function clampLimit(limit: number | undefined, fallback = LIST_LIMIT_DEFAULT): number {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), LIST_LIMIT_MAX);
}

/**
 * The DDL defaults `category` to 'other' (src/lib/talent/schema.ts) and 'other' is NOT a member of
 * SOURCE_CATEGORIES in types.ts. A row written outside this module can therefore carry a value the
 * union does not name. It is PRESERVED, not rewritten: mapping it onto some nearby member would
 * silently move rows in every provenance report, and a report that quietly reassigns its own inputs
 * is worse than one showing a value somebody has to explain. Every write from this module validates
 * against the union, so the only rows this can affect are ones this module did not create.
 */
function mapSource(r: any): RecruitmentSource {
  return {
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.name),
    category: String(r.category) as SourceCategory,
    ingestMode: String(r.ingest_mode) as IngestMode,
    isActive: r.is_active !== false,
  };
}

// ---------------------------------------------------------------------------------------------
// SEED. Read-path only: the registry must never be empty on a fresh database, and a write path
// that seeded would race an administrator's own first row. Seeds ONLY when the table is empty, so
// a re-run never resurrects a source somebody deliberately deactivated or renamed.
// ---------------------------------------------------------------------------------------------

export function ensureSeedSources(): Promise<void> {
  return ensureOnce(SEED_KEY, async () => {
    await ensureTalent();
    const rows = rowsOf(await db.execute(sql`SELECT COUNT(*)::int AS n FROM tal_recruitment_source`));
    const n = Number(rows[0]?.n ?? 0);
    if (n > 0) return;
    for (const d of DEFAULT_SOURCES) {
      await db.execute(sql`
        INSERT INTO tal_recruitment_source (slug, name, category, ingest_mode, is_active)
        VALUES (${d.slug}, ${d.name}, ${d.category}, ${d.ingestMode}, TRUE)
        ON CONFLICT (slug) DO NOTHING`);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// SOURCES — read
// ---------------------------------------------------------------------------------------------

/** Every source. INTERNAL: `name` is admin display and belongs on no public page. */
export async function listSources(includeInactive = false): Promise<RecruitmentSource[]> {
  try {
    await ensureTalent();
    await ensureSeedSources();
    const res = includeInactive
      ? await db.execute(sql`SELECT * FROM tal_recruitment_source ORDER BY is_active DESC, name ASC`)
      : await db.execute(sql`SELECT * FROM tal_recruitment_source WHERE is_active = TRUE ORDER BY name ASC`);
    return rowsOf(res).map(mapSource);
  } catch (e: any) {
    // Read paths return an empty list rather than throwing into a page render, but NEVER silently:
    // an empty registry and an unreachable one look identical on screen, and this project has
    // already paid for a zero-state that actually meant "the database is down".
    console.error('[talent-sources] listSources: ' + reasonOf(e));
    return [];
  }
}

export async function getSource(id: string): Promise<RecruitmentSource | null> {
  if (!isUuid(id)) return null;
  try {
    await ensureTalent();
    const r = rowsOf(await db.execute(sql`
      SELECT * FROM tal_recruitment_source WHERE id = ${id.trim()} LIMIT 1`))[0];
    return r ? mapSource(r) : null;
  } catch (e: any) {
    console.error('[talent-sources] getSource ' + String(id) + ': ' + reasonOf(e));
    return null;
  }
}

/**
 * Provenance counts for the admin dashboard tile (spec 14A, "Candidates by recruitment source").
 *
 * LEFT JOIN from the source, so a source nobody has arrived through appears with 0 rather than
 * vanishing — a tile that silently omits its empty rows reads as if those channels do not exist.
 * This counts `tal_external_application_ref`, which is PROVENANCE. It is not comparable with
 * `application_sources.usage_count`, which is attribution, and the two must never be summed.
 */
export async function sourceCounts(): Promise<Array<{ sourceId: string; name: string; count: number }>> {
  try {
    await ensureTalent();
    await ensureSeedSources();
    return rowsOf(await db.execute(sql`
      SELECT s.id AS source_id, s.name AS name, COUNT(r.id)::int AS count
      FROM tal_recruitment_source s
      LEFT JOIN tal_external_application_ref r ON r.source_id = s.id
      GROUP BY s.id, s.name
      ORDER BY COUNT(r.id) DESC, s.name ASC`))
      .map((r: any) => ({ sourceId: String(r.source_id), name: String(r.name), count: Number(r.count) || 0 }));
  } catch (e: any) {
    console.error('[talent-sources] sourceCounts: ' + reasonOf(e));
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
// SOURCES — write
// ---------------------------------------------------------------------------------------------

/**
 * Create a source. The slug is derived from the name ONCE and never changes afterwards — see
 * updateSource. A duplicate slug is refused by name rather than absorbed: two sources called the
 * same thing make every provenance report ambiguous.
 */
export async function createSource(
  input: { name: string; category: SourceCategory; ingestMode: IngestMode },
  actorUserId: string,
): Promise<TalentResult<RecruitmentSource>> {
  if (!isUuid(actorUserId)) return failResult('An administrator must be identified to create a source.');
  const problems = sourceProblems(input);
  if (problems.length) return failResult(problems.join(' '));

  const name = String(input.name).trim();
  const slug = sourceSlug(name);

  try {
    await ensureTalent();
    const inserted = rowsOf(await db.execute(sql`
      INSERT INTO tal_recruitment_source (slug, name, category, ingest_mode, is_active, created_by)
      VALUES (${slug}, ${name}, ${input.category}, ${input.ingestMode}, TRUE, ${actorUserId.trim()})
      ON CONFLICT (slug) DO NOTHING
      RETURNING *`))[0];

    if (!inserted) {
      // DO NOTHING returned nothing, so the slug is taken. Say which one, and by what — an operator
      // hitting this has usually just deactivated that source and is trying to recreate it.
      const existing = rowsOf(await db.execute(sql`
        SELECT name, is_active FROM tal_recruitment_source WHERE slug = ${slug} LIMIT 1`))[0];
      return failResult(existing
        ? 'A recruitment source with that name already exists ("' + String(existing.name) + '"'
          + (existing.is_active === false ? ', currently inactive' : '') + '). Reactivate or rename it.'
        : 'That recruitment source could not be created.');
    }

    const source = mapSource(inserted);
    await logAudit({
      userId: actorUserId.trim(),
      action: 'source.created',
      entity: 'tal_recruitment_source',
      entityId: source.id,
      diff: { slug: source.slug, name: source.name, category: source.category, ingestMode: source.ingestMode },
    });
    return okResult(source);
  } catch (e: any) {
    const reason = reasonOf(e);
    console.error('[talent-sources] createSource: ' + reason);
    return failResult('Could not create that recruitment source: ' + reason);
  }
}

/**
 * Update a source's display and behaviour. `slug` and `id` are NOT editable: the slug is the stable
 * key an integration, a CSV header and every historical report refer to, and rewriting it would
 * silently repoint provenance that has already been reported. A rename changes `name` only.
 */
export async function updateSource(
  id: string,
  patch: Partial<RecruitmentSource>,
  actorUserId: string,
): Promise<TalentResult> {
  if (!isUuid(id)) return failResult('That is not a recruitment source id.');
  if (!isUuid(actorUserId)) return failResult('An administrator must be identified to change a source.');

  const problems: string[] = [];
  let name: string | null = null;
  let category: string | null = null;
  let ingestMode: string | null = null;
  let isActive: boolean | null = null;

  if (patch.slug !== undefined) {
    problems.push('A recruitment source slug cannot be changed; it is the key every existing reference uses.');
  }
  if (patch.name !== undefined) {
    const n = String(patch.name || '').trim();
    if (!n) problems.push('A source name is required.');
    else if (n.length > SOURCE_NAME_MAX) problems.push('A source name must be ' + SOURCE_NAME_MAX + ' characters or fewer.');
    else if (!sourceSlug(n)) problems.push('A source name must contain at least one letter or number.');
    else name = n;
  }
  if (patch.category !== undefined) {
    if (!isSourceCategory(patch.category)) problems.push('Category must be one of: ' + SOURCE_CATEGORIES.join(', ') + '.');
    else category = patch.category;
  }
  if (patch.ingestMode !== undefined) {
    if (!isIngestMode(patch.ingestMode)) problems.push('Ingest mode must be one of: ' + INGEST_MODES.join(', ') + '.');
    else ingestMode = patch.ingestMode;
  }
  if (patch.isActive !== undefined) isActive = !!patch.isActive;

  if (problems.length) return failResult(problems.join(' '));
  if (name === null && category === null && ingestMode === null && isActive === null) {
    return failResult('Nothing to change — no editable field was supplied.');
  }

  try {
    await ensureTalent();

    // A rename must not produce two rows an administrator cannot tell apart on the console. The
    // slug does not move, so this is a display-name collision check, not a key check.
    if (name !== null) {
      const clash = rowsOf(await db.execute(sql`
        SELECT id FROM tal_recruitment_source
        WHERE lower(name) = lower(${name}) AND id <> ${id.trim()} LIMIT 1`))[0];
      if (clash) return failResult('Another recruitment source already uses that name.');
    }

    // Explicit casts on every parameter: a bare NULL in COALESCE leaves Postgres to infer a
    // parameter type it has no context for, which fails as "could not determine data type".
    const updated = rowsOf(await db.execute(sql`
      UPDATE tal_recruitment_source SET
        name        = COALESCE(${name}::text, name),
        category    = COALESCE(${category}::text, category),
        ingest_mode = COALESCE(${ingestMode}::text, ingest_mode),
        is_active   = COALESCE(${isActive}::boolean, is_active)
      WHERE id = ${id.trim()}
      RETURNING id, slug`))[0];

    if (!updated) return failResult('No recruitment source with that id.');

    await logAudit({
      userId: actorUserId.trim(),
      action: 'source.updated',
      entity: 'tal_recruitment_source',
      entityId: String(updated.id),
      diff: { name, category, ingestMode, isActive },
    });
    return okResult();
  } catch (e: any) {
    const reason = reasonOf(e);
    console.error('[talent-sources] updateSource ' + String(id) + ': ' + reason);
    return failResult('Could not save that recruitment source: ' + reason);
  }
}

/**
 * DEACTIVATE IS THE ONLY REMOVAL. Spec 15 rule 2: a source is never hard-deleted while a
 * `tal_external_application_ref` points at it — and because provenance is meant to survive forever,
 * that reference is never expected to go away. THIS MODULE THEREFORE EXPOSES NO DELETE AT ALL:
 * deleting the row would orphan every reference and quietly rewrite where a real person came from.
 * The same rule is already implemented one level over for `application_sources` (attribution).
 *
 * Live keys are revoked with the source. A deactivated source that still authenticates an ingest
 * credential is not deactivated, and authenticateSourceKey() refuses on `is_active` as well, so the
 * two controls agree rather than depending on which one a caller remembered.
 */
export async function deactivateSource(id: string, actorUserId: string): Promise<TalentResult> {
  if (!isUuid(id)) return failResult('That is not a recruitment source id.');
  if (!isUuid(actorUserId)) return failResult('An administrator must be identified to deactivate a source.');

  try {
    await ensureTalent();
    // `is_active = TRUE` is in the WHERE so "deactivated" means THIS call did it — the lesson
    // src/lib/api-keys.ts records about revokeApiKey reporting success for a no-op.
    const row = rowsOf(await db.execute(sql`
      UPDATE tal_recruitment_source SET is_active = FALSE
      WHERE id = ${id.trim()} AND is_active = TRUE
      RETURNING id, name`))[0];

    if (!row) {
      const existing = rowsOf(await db.execute(sql`
        SELECT is_active FROM tal_recruitment_source WHERE id = ${id.trim()} LIMIT 1`))[0];
      return failResult(existing
        ? 'That recruitment source was already inactive.'
        : 'No recruitment source with that id.');
    }

    const revoked = rowsOf(await db.execute(sql`
      UPDATE tal_source_key SET revoked_at = NOW()
      WHERE source_id = ${id.trim()} AND revoked_at IS NULL
      RETURNING id`)).length;

    await logAudit({
      userId: actorUserId.trim(),
      action: 'source.deactivated',
      entity: 'tal_recruitment_source',
      entityId: String(row.id),
      diff: { name: String(row.name), keysRevoked: revoked },
    });
    return okResult();
  } catch (e: any) {
    const reason = reasonOf(e);
    console.error('[talent-sources] deactivateSource ' + String(id) + ': ' + reason);
    return failResult('Could not deactivate that recruitment source: ' + reason);
  }
}

// ---------------------------------------------------------------------------------------------
// SOURCE KEYS
// ---------------------------------------------------------------------------------------------

/**
 * Issue an ingest key for one source. THE RETURNED SECRET IS THE ONLY PLAINTEXT COPY THAT WILL EVER
 * EXIST — it is shown once to the issuing administrator and is not recoverable from anywhere
 * afterwards, because only its sha256 is stored.
 *
 * The audit row IS THE CONTROL here: this hands an outside system a live credential against our
 * candidate intake. logAuditOrThrow, and if the audit cannot be written the key row is removed
 * again, so there is no window in which a working credential exists with no record of who issued it.
 */
export async function issueSourceKey(
  sourceId: string,
  actorUserId: string,
  scopes?: string[],
): Promise<TalentResult<{ prefix: string; secret: string }>> {
  if (!isUuid(sourceId)) return failResult('That is not a recruitment source id.');
  if (!isUuid(actorUserId)) return failResult('An administrator must be identified to issue a source key.');

  const { scopes: granted, problems } = normalizeScopes(scopes);
  if (problems.length) return failResult(problems.join(' '));

  try {
    await ensureTalent();
    const source = rowsOf(await db.execute(sql`
      SELECT s.id, s.name, s.slug, s.is_active,
             (SELECT COUNT(*)::int FROM tal_source_key k
               WHERE k.source_id = s.id AND k.revoked_at IS NULL) AS live_keys
      FROM tal_recruitment_source s WHERE s.id = ${sourceId.trim()} LIMIT 1`))[0];

    if (!source) return failResult('No recruitment source with that id.');
    if (source.is_active === false) {
      return failResult('That recruitment source is inactive. Reactivate it before issuing a key.');
    }

    // Retry on a prefix collision rather than surfacing a unique-violation to the operator. The
    // UNIQUE index on key_prefix is what makes the prefix lookup in authenticateSourceKey() a
    // single-row read; minting a fresh key is cheaper than explaining a 23505 to somebody.
    let secret = '';
    let keyId = '';
    for (let attempt = 0; attempt < KEY_MINT_ATTEMPTS && !keyId; attempt++) {
      const candidate = mintSourceKey();
      const row = rowsOf(await db.execute(sql`
        INSERT INTO tal_source_key (source_id, key_prefix, key_hash, scopes, created_by)
        VALUES (${sourceId.trim()}, ${sourceKeyPrefix(candidate)}, ${hashSourceKey(candidate)},
                ${JSON.stringify(granted)}::jsonb, ${actorUserId.trim()})
        ON CONFLICT (key_prefix) DO NOTHING
        RETURNING id`))[0];
      if (row) { keyId = String(row.id); secret = candidate; }
    }
    if (!keyId) return failResult('Could not allocate a key prefix. Try again.');

    const prefix = sourceKeyPrefix(secret);
    try {
      await logAuditOrThrow({
        userId: actorUserId.trim(),
        // A source with a live key already is having that key ROTATED; the first one is an
        // ISSUANCE. Both are in the spec's vocabulary and the distinction is the useful part of
        // the line when somebody is reading back what happened to a partner integration.
        action: Number(source.live_keys) > 0 ? 'source.key_rotated' : 'source.key_issued',
        entity: 'tal_source_key',
        entityId: keyId,
        // The prefix, never the secret, and never any part of it beyond the prefix — spec 16.1's
        // rule for the onboarding code, applied to every secret this platform issues.
        diff: { sourceId: String(source.id), sourceSlug: String(source.slug), keyPrefix: prefix, scopes: granted },
      });
    } catch (auditError: any) {
      // UNDO. A live ingest credential with no audit row is exactly the state this control exists
      // to prevent, so the key goes away and the administrator is told to try again.
      await db.execute(sql`DELETE FROM tal_source_key WHERE id = ${keyId}`)
        .catch((e: any) => console.error('[talent-sources] could not roll back unaudited key ' + keyId + ': ' + reasonOf(e)));
      const reason = reasonOf(auditError);
      console.error('[talent-sources] issueSourceKey audit failed, key rolled back: ' + reason);
      return failResult('The key was not issued: its audit record could not be written (' + reason + ').');
    }

    return okResult({ prefix, secret });
  } catch (e: any) {
    const reason = reasonOf(e);
    console.error('[talent-sources] issueSourceKey ' + String(sourceId) + ': ' + reason);
    return failResult('Could not issue a source key: ' + reason);
  }
}

/**
 * Revoke a key. Revocable without a deploy — spec 15 rule 5.
 *
 * `revoked_at IS NULL` is in the WHERE, so a second click on a key somebody already revoked in
 * another tab says so instead of reporting a fresh success.
 *
 * NOTE THE ASYMMETRY WITH ISSUE. Issuance rolls back when its audit fails; revocation does not. A
 * key that is genuinely dead must stay dead, and reinstating a live credential because a log write
 * hiccuped would be the worse failure by a distance. The audit failure is logged loudly instead.
 */
export async function revokeSourceKey(keyId: string, actorUserId: string): Promise<TalentResult> {
  if (!isUuid(keyId)) return failResult('That is not a source key id.');
  if (!isUuid(actorUserId)) return failResult('An administrator must be identified to revoke a source key.');

  try {
    await ensureTalent();
    const row = rowsOf(await db.execute(sql`
      UPDATE tal_source_key SET revoked_at = NOW()
      WHERE id = ${keyId.trim()} AND revoked_at IS NULL
      RETURNING id, source_id, key_prefix`))[0];

    if (!row) {
      const existing = rowsOf(await db.execute(sql`
        SELECT revoked_at FROM tal_source_key WHERE id = ${keyId.trim()} LIMIT 1`))[0];
      return failResult(existing ? 'That key was already revoked.' : 'No source key with that id.');
    }

    const audit = await logAudit({
      userId: actorUserId.trim(),
      action: 'source.key_revoked',
      entity: 'tal_source_key',
      entityId: String(row.id),
      diff: { sourceId: String(row.source_id), keyPrefix: String(row.key_prefix) },
    });
    if (!audit.ok) {
      console.error('[talent-sources] key ' + String(row.key_prefix)
        + ' was revoked but the audit row failed: ' + String(audit.error || 'unknown reason'));
    }
    return okResult();
  } catch (e: any) {
    const reason = reasonOf(e);
    console.error('[talent-sources] revokeSourceKey ' + String(keyId) + ': ' + reason);
    return failResult('Could not revoke that key: ' + reason);
  }
}

/** What an authenticated ingest request actually needs: who, and with what powers. */
export interface SourceKeyContext {
  keyId: string;
  scopes: string[];
  source: RecruitmentSource;
}

/**
 * Authenticate a presented key and return its full context.
 *
 * ADDITIVE TO THE CONTRACT, and the one an ingest route should call: authenticateSourceKey() below
 * returns only the source, which cannot answer "may this key ingest?" without a second lookup.
 *
 * THE HASH COMPARISON ALWAYS RUNS. The prefix lookup tells us which row to compare against; when it
 * finds nothing we compare against a constant instead, so an unknown prefix takes the same path and
 * the same work as a known one. Without that, response time answers "is this a real key prefix?"
 * for anybody willing to measure it, which is an enumeration oracle over live partner credentials.
 */
export async function authenticateSourceKeyContext(raw: string): Promise<SourceKeyContext | null> {
  const presented = String(raw || '').trim();
  // Format is public knowledge (it is in the integration docs), so failing fast on it discloses
  // nothing an attacker did not already have.
  if (!looksLikeSourceKey(presented)) return null;

  try {
    await ensureTalent();
    const presentedHash = hashSourceKey(presented);
    const row = rowsOf(await db.execute(sql`
      SELECT k.id, k.key_hash, k.key_prefix, k.scopes, k.revoked_at,
             s.id AS source_id, s.slug, s.name, s.category, s.ingest_mode, s.is_active
      FROM tal_source_key k
      JOIN tal_recruitment_source s ON s.id = k.source_id
      WHERE k.key_prefix = ${sourceKeyPrefix(presented)} LIMIT 1`))[0];

    const match = hashesMatch(row ? String(row.key_hash) : ABSENT_KEY_HASH, presentedHash);
    if (!row || !match) return null;

    // Past this point the caller HAS proved possession of a real key, so naming the reason in the
    // server log is not an oracle — it is the only way an operator can tell a partner why their
    // integration stopped working.
    if (row.revoked_at) {
      console.error('[talent-sources] revoked key ' + String(row.key_prefix) + ' was presented for ingest');
      return null;
    }
    if (row.is_active === false) {
      console.error('[talent-sources] key ' + String(row.key_prefix) + ' belongs to inactive source ' + String(row.slug));
      return null;
    }

    return {
      keyId: String(row.id),
      scopes: Array.isArray(row.scopes) ? row.scopes.map((s: any) => String(s)) : [],
      source: mapSource({
        id: row.source_id, slug: row.slug, name: row.name,
        category: row.category, ingest_mode: row.ingest_mode, is_active: row.is_active,
      }),
    };
  } catch (e: any) {
    // A database failure must not read as "your key is fine". Null is a refusal, and the reason is
    // on the record rather than dying in a swallowed catch.
    console.error('[talent-sources] authenticateSourceKey: ' + reasonOf(e));
    return null;
  }
}

/** The contract shape: the source a valid, unrevoked key belongs to, or null for every refusal. */
export async function authenticateSourceKey(raw: string): Promise<RecruitmentSource | null> {
  const ctx = await authenticateSourceKeyContext(raw);
  return ctx ? ctx.source : null;
}

// ---------------------------------------------------------------------------------------------
// EXTERNAL REFERENCES — the provenance record itself
// ---------------------------------------------------------------------------------------------

/**
 * Record that an external application maps to ours. THE UNIQUE INDEX ON
 * (source_id, external_application_id) IS THE MECHANISM: a webhook that is re-delivered — which
 * every webhook eventually is — UPDATES the existing row and never creates a second candidate.
 * Spec 15 rule 1.
 *
 * `isNew` is reported from `xmax = 0`, the standard Postgres way to tell an INSERT from an
 * ON CONFLICT DO UPDATE within one statement (a row inserted by the current command has xmax 0).
 * Doing it with a prior SELECT would race two concurrent deliveries of the same payload and report
 * "new" twice; doing it by counting affected rows cannot distinguish them at all.
 *
 * Fields are merged with COALESCE, not overwritten: a re-delivery that omits the person id must not
 * erase the person somebody has since resolved by hand.
 */
export async function recordExternalRef(input: {
  sourceId: string;
  externalApplicationId: string;
  personId?: string | null;
  applicationId?: string | null;
  rawPayload?: any;
  ingestedBy?: string | null;
}): Promise<TalentResult<{ id: string; isNew: boolean }>> {
  const problems: string[] = [];
  if (!isUuid(input.sourceId)) problems.push('A valid recruitment source id is required.');

  const externalId = normalizeExternalId(input.externalApplicationId);
  if (!externalId) problems.push('An external application identifier is required.');

  if (input.personId != null && !isUuid(input.personId)) problems.push('That is not a person id.');
  if (input.applicationId != null && !isUuid(input.applicationId)) problems.push('That is not an application id.');
  if (input.ingestedBy != null && !isUuid(input.ingestedBy)) problems.push('That is not a user id for ingested_by.');
  if (problems.length) return failResult(problems.join(' '));

  const personId = input.personId ? String(input.personId).trim() : null;
  const applicationId = input.applicationId ? String(input.applicationId).trim() : null;
  const ingestedBy = input.ingestedBy ? String(input.ingestedBy).trim() : null;
  // undefined means "this delivery carried no payload", which must leave the stored one alone.
  const payload = input.rawPayload === undefined ? null : safeJsonPayload(input.rawPayload);

  try {
    await ensureTalent();

    // There is no foreign key here — schema.ts declines FKs to tables with a contested id type — so
    // the existence check is the application-level equivalent. An inactive source is refused rather
    // than recorded: deactivation means "nothing new arrives through this channel", and the caller
    // is expected to quarantine what it was holding.
    const source = rowsOf(await db.execute(sql`
      SELECT id, slug, is_active FROM tal_recruitment_source WHERE id = ${String(input.sourceId).trim()} LIMIT 1`))[0];
    if (!source) return failResult('No recruitment source with that id.');
    if (source.is_active === false) {
      return failResult('That recruitment source is inactive; nothing new can be ingested through it.');
    }

    const row = rowsOf(await db.execute(sql`
      INSERT INTO tal_external_application_ref
        (source_id, external_application_id, application_id, person_id, raw_payload, ingested_by)
      VALUES (${String(input.sourceId).trim()}, ${externalId}, ${applicationId}, ${personId},
              ${payload}::jsonb, ${ingestedBy})
      ON CONFLICT (source_id, external_application_id) DO UPDATE SET
        application_id = COALESCE(EXCLUDED.application_id, tal_external_application_ref.application_id),
        person_id      = COALESCE(EXCLUDED.person_id, tal_external_application_ref.person_id),
        raw_payload    = COALESCE(EXCLUDED.raw_payload, tal_external_application_ref.raw_payload),
        ingested_by    = COALESCE(EXCLUDED.ingested_by, tal_external_application_ref.ingested_by)
      RETURNING id, (xmax = 0) AS is_new`))[0];

    if (!row) return failResult('The external reference could not be recorded.');
    const id = String(row.id);
    const isNew = row.is_new === true || row.is_new === 't';

    // logAudit, NOT logAuditOrThrow. Here the ref row itself is the durable provenance record and
    // the audit line is secondary; failing a partner's webhook because a log write hiccuped would
    // lose the delivery entirely, which is the outcome this whole module exists to prevent. Key
    // issuance is the opposite case and uses the strict sink.
    await logAudit({
      userId: ingestedBy,
      action: isNew ? 'application.imported' : 'application.import_redelivered',
      entity: 'tal_external_application_ref',
      entityId: id,
      // The external id and the source, never the payload: audit diffs carry values, and a raw
      // partner payload is candidate PII that already has a home in a narrower table.
      diff: { sourceSlug: String(source.slug), externalApplicationId: externalId, personId, applicationId },
    });

    return okResult({ id, isNew });
  } catch (e: any) {
    const reason = reasonOf(e);
    console.error('[talent-sources] recordExternalRef ' + externalId + ': ' + reason);
    return failResult('Could not record that external reference: ' + reason);
  }
}

// ---------------------------------------------------------------------------------------------
// QUARANTINE — nothing is dropped silently. Spec 15 failure states.
// ---------------------------------------------------------------------------------------------

/**
 * Store a payload that could not be accepted, so an administrator can correct and replay it.
 *
 * Returns void by contract, which means it cannot report failure to its caller — so it must not
 * fail quietly either. A quarantine insert that itself fails is logged with the real Postgres
 * reason, the source and the payload SIZE. The payload CONTENT is deliberately not echoed to the
 * process log: it is candidate data, `tal_ingest_quarantine` is admin-only by design, and stdout is
 * a wider, longer-lived and less controlled audience than the table it failed to reach.
 */
export async function quarantineIngest(sourceId: string | null, reason: string, payload: any): Promise<void> {
  const reasonText = String(reason || 'unspecified').trim().slice(0, QUARANTINE_REASON_MAX) || 'unspecified';
  const source = sourceId && isUuid(sourceId) ? String(sourceId).trim() : null;
  const body = safeJsonPayload(payload);

  try {
    await ensureTalent();
    const row = rowsOf(await db.execute(sql`
      INSERT INTO tal_ingest_quarantine (source_id, reason, raw_payload)
      VALUES (${source}, ${reasonText}, ${body}::jsonb)
      RETURNING id`))[0];

    await logAudit({
      // No human actor: a malformed delivery is a system event. The row id is what an administrator
      // needs to find it, and it is in entityId rather than in prose.
      userId: null,
      action: 'import.quarantined',
      entity: 'tal_ingest_quarantine',
      entityId: row ? String(row.id) : undefined,
      diff: { sourceId: source, reason: reasonText, payloadBytes: Buffer.byteLength(body, 'utf8') },
    });
  } catch (e: any) {
    console.error('[talent-sources] QUARANTINE WRITE FAILED for source ' + String(source)
      + ' (' + reasonText + ', ' + Buffer.byteLength(body, 'utf8') + ' bytes): ' + reasonOf(e));
  }
}

/**
 * The quarantine queue for the admin console. ADMIN-ONLY — spec 15 rule 4.
 *
 * `raw_payload` is NOT selected here on purpose: a payload can be a quarter of a megabyte and a
 * list of fifty of them is a page nobody can load. getQuarantineItem() fetches one.
 */
export async function listQuarantine(limit = 50): Promise<any[]> {
  const lim = clampLimit(limit, 50);
  try {
    await ensureTalent();
    return rowsOf(await db.execute(sql`
      SELECT q.id, q.source_id, s.name AS source_name, s.slug AS source_slug,
             q.reason, q.replayed_at, q.created_at,
             pg_column_size(q.raw_payload) AS payload_bytes
      FROM tal_ingest_quarantine q
      LEFT JOIN tal_recruitment_source s ON s.id = q.source_id
      ORDER BY q.replayed_at IS NOT NULL, q.created_at DESC
      LIMIT ${lim}`))
      .map((r: any) => ({
        id: String(r.id),
        sourceId: r.source_id ? String(r.source_id) : null,
        sourceName: r.source_name ? String(r.source_name) : null,
        sourceSlug: r.source_slug ? String(r.source_slug) : null,
        reason: String(r.reason),
        replayedAt: r.replayed_at ? String(r.replayed_at) : null,
        createdAt: String(r.created_at),
        payloadBytes: Number(r.payload_bytes) || 0,
      }));
  } catch (e: any) {
    console.error('[talent-sources] listQuarantine: ' + reasonOf(e));
    return [];
  }
}

/**
 * ADDITIVE TO THE CONTRACT. One quarantined item WITH its payload, so the administrator replaying
 * it can see what the partner actually sent. Spec 15 requires the replay path to exist; without a
 * reader it does not.
 */
export async function getQuarantineItem(id: string): Promise<any | null> {
  if (!isUuid(id)) return null;
  try {
    await ensureTalent();
    const r = rowsOf(await db.execute(sql`
      SELECT q.*, s.name AS source_name, s.slug AS source_slug
      FROM tal_ingest_quarantine q
      LEFT JOIN tal_recruitment_source s ON s.id = q.source_id
      WHERE q.id = ${id.trim()} LIMIT 1`))[0];
    return r || null;
  } catch (e: any) {
    console.error('[talent-sources] getQuarantineItem ' + String(id) + ': ' + reasonOf(e));
    return null;
  }
}

/**
 * ADDITIVE TO THE CONTRACT. Mark a quarantined payload as replayed, once the administrator has
 * recorded it properly through recordExternalRef(). Separate from the replay itself so a payload is
 * never marked handled by the same call that might have failed to handle it.
 */
export async function markQuarantineReplayed(id: string, actorUserId: string): Promise<TalentResult> {
  if (!isUuid(id)) return failResult('That is not a quarantine id.');
  if (!isUuid(actorUserId)) return failResult('An administrator must be identified to replay a payload.');
  try {
    await ensureTalent();
    const row = rowsOf(await db.execute(sql`
      UPDATE tal_ingest_quarantine SET replayed_at = NOW()
      WHERE id = ${id.trim()} AND replayed_at IS NULL
      RETURNING id, source_id`))[0];
    if (!row) {
      const existing = rowsOf(await db.execute(sql`
        SELECT replayed_at FROM tal_ingest_quarantine WHERE id = ${id.trim()} LIMIT 1`))[0];
      return failResult(existing ? 'That payload was already marked replayed.' : 'No quarantined payload with that id.');
    }
    await logAudit({
      userId: actorUserId.trim(),
      action: 'import.replayed',
      entity: 'tal_ingest_quarantine',
      entityId: String(row.id),
      diff: { sourceId: row.source_id ? String(row.source_id) : null },
    });
    return okResult();
  } catch (e: any) {
    const reason = reasonOf(e);
    console.error('[talent-sources] markQuarantineReplayed ' + String(id) + ': ' + reason);
    return failResult('Could not mark that payload replayed: ' + reason);
  }
}

/**
 * ADDITIVE TO THE CONTRACT. The keys on a source, for the admin console. NO SECRET IS RETURNED OR
 * RETURNABLE — only the stored prefix, which is what the console shows.
 */
export async function listSourceKeys(sourceId: string): Promise<Array<{
  id: string; keyPrefix: string; scopes: string[]; revokedAt: string | null; createdAt: string;
}>> {
  if (!isUuid(sourceId)) return [];
  try {
    await ensureTalent();
    return rowsOf(await db.execute(sql`
      SELECT id, key_prefix, scopes, revoked_at, created_at
      FROM tal_source_key WHERE source_id = ${sourceId.trim()}
      ORDER BY revoked_at IS NOT NULL, created_at DESC`))
      .map((r: any) => ({
        id: String(r.id),
        keyPrefix: String(r.key_prefix),
        scopes: Array.isArray(r.scopes) ? r.scopes.map((s: any) => String(s)) : [],
        revokedAt: r.revoked_at ? String(r.revoked_at) : null,
        createdAt: String(r.created_at),
      }));
  } catch (e: any) {
    console.error('[talent-sources] listSourceKeys ' + String(sourceId) + ': ' + reasonOf(e));
    return [];
  }
}
