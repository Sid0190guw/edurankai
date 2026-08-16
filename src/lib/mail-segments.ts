// src/lib/mail-segments.ts — THE SEGMENTATION ENGINE.
//
// A segment is a tree of conditions joined by AND / OR / NOT. This module turns that tree into a
// Postgres predicate over `mail_contacts c`, and — separately — evaluates the same tree in memory
// against one contact. Both live here on purpose: SQL and in-memory answers that disagree are the
// classic segmentation bug (the preview says 412, the send goes to 3,000), and keeping the two
// implementations side by side with a shared test suite is what stops them drifting.
//
// EVERY SEGMENT IS EVALUATED SERVER-SIDE. The browser sends a tree; it never sends SQL, never sends
// a contact id list, and never decides who is in a segment.
//
// INJECTION. Column names never come from input — a field key is looked up in FIELDS and only its
// hard-coded expression is emitted. Values are ALWAYS parameters. The compiler returns
// `{ text, params }` with `$1`-style placeholders, which is what makes it a pure function and
// therefore testable without a database; toSql() splices that into a drizzle fragment.
//
// THE ARRAY TRAP. `= ANY(${jsArray}::text[])` DOES NOT WORK here — postgres-js serialises a JS
// array as a record literal and Postgres answers "cannot cast type record to text[]"
// (see src/lib/pg-array.ts, which was written about that exact fault). Every multi-value operator
// below therefore emits `IN (SELECT jsonb_array_elements_text($n::jsonb))` with ONE json string
// parameter, which is the repaired idiom used across this codebase.
import { sql } from 'drizzle-orm';
import { STAGES, CLOSED_STAGES, stageIndex } from '@/lib/application-stages';

// ── the tree ───────────────────────────────────────────────────────────────────────────────────

export type SegmentOp =
  | 'eq' | 'neq'
  | 'contains' | 'not_contains' | 'starts_with' | 'ends_with'
  | 'is_set' | 'is_empty'
  | 'in' | 'not_in'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'before' | 'after' | 'within_days' | 'older_than_days'
  | 'has' | 'not_has';

export interface SegmentCondition {
  type: 'cond';
  /** A key from FIELDS, or `custom:<key>`, or `activity:<kind>`. */
  field: string;
  op: SegmentOp;
  value?: unknown;
  /** Negate this single condition. Equivalent to wrapping it in a NOT group. */
  not?: boolean;
}

export interface SegmentGroup {
  type: 'group';
  op: 'and' | 'or';
  not?: boolean;
  children: SegmentNode[];
}

export type SegmentNode = SegmentCondition | SegmentGroup;

/** A root that matches every contact. Used as the starting point in the builder UI. */
export const EMPTY_SEGMENT: SegmentGroup = { type: 'group', op: 'and', children: [] };

export const MAX_DEPTH = 6;
export const MAX_NODES = 200;

// ── the field catalog ──────────────────────────────────────────────────────────────────────────

export type FieldKind = 'text' | 'enum' | 'date' | 'tag' | 'list' | 'custom' | 'activity' | 'stage' | 'usage';

export interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  ops: SegmentOp[];
  /** SQL expression over alias `c`. Only for kinds the plain-column path handles. */
  expr?: string;
  options?: { value: string; label: string }[];
  hint?: string;
}

const TEXT_OPS: SegmentOp[] = ['eq', 'neq', 'contains', 'not_contains', 'starts_with', 'ends_with', 'is_set', 'is_empty', 'in', 'not_in'];
const DATE_OPS: SegmentOp[] = ['before', 'after', 'within_days', 'older_than_days', 'is_set', 'is_empty'];

export const ACTIVITY_KINDS = ['sent', 'delivered', 'opened', 'clicked', 'bounced', 'unsubscribed', 'complained'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const ALL_STAGES = [...STAGES, ...CLOSED_STAGES];

export const FIELDS: ReadonlyArray<FieldDef> = [
  { key: 'email', label: 'Email address', kind: 'text', ops: TEXT_OPS, expr: 'c.email' },
  { key: 'name', label: 'Name (first + last)', kind: 'text', ops: TEXT_OPS, expr: "btrim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,''))" },
  { key: 'first_name', label: 'First name', kind: 'text', ops: TEXT_OPS, expr: 'c.first_name' },
  { key: 'last_name', label: 'Last name', kind: 'text', ops: TEXT_OPS, expr: 'c.last_name' },
  { key: 'organization', label: 'Organisation', kind: 'text', ops: TEXT_OPS, expr: 'c.organization' },
  { key: 'phone', label: 'Phone', kind: 'text', ops: TEXT_OPS, expr: 'c.phone' },
  { key: 'role_title', label: 'Role / title', kind: 'text', ops: TEXT_OPS, expr: 'c.role_title' },
  {
    key: 'status', label: 'Subscription status', kind: 'enum', ops: ['eq', 'neq', 'in', 'not_in'], expr: 'c.status',
    options: [
      { value: 'subscribed', label: 'Subscribed' },
      { value: 'unsubscribed', label: 'Unsubscribed' },
      { value: 'bounced', label: 'Bounced' },
      { value: 'complained', label: 'Complained' },
      { value: 'pending', label: 'Pending confirmation' },
    ],
  },
  { key: 'tag', label: 'Tag', kind: 'tag', ops: ['has', 'not_has'], hint: 'Matches one tag, case-insensitively.' },
  { key: 'list', label: 'List membership', kind: 'list', ops: ['has', 'not_has'], hint: 'Static list membership. Choose the list.' },
  { key: 'custom', label: 'Custom field', kind: 'custom', ops: TEXT_OPS, hint: 'Any column imported from CSV that was not a standard field.' },
  { key: 'created_at', label: 'Created date', kind: 'date', ops: DATE_OPS, expr: 'c.created_at' },
  { key: 'last_activity_at', label: 'Last activity', kind: 'date', ops: DATE_OPS, expr: 'c.last_activity_at' },
  { key: 'consent_at', label: 'Consent date', kind: 'date', ops: DATE_OPS, expr: 'c.consent_at' },
  { key: 'activity', label: 'Campaign activity', kind: 'activity', ops: ['has', 'not_has'], hint: 'Opened / clicked / bounced …, optionally for one campaign and within N days.' },
  {
    key: 'application_stage', label: 'Application stage', kind: 'stage', ops: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
    hint: 'Stage of a recruitment application filed with this email. Stage 1 is Submitted.',
    options: ALL_STAGES.map((s, i) => ({ value: s.key, label: (i < STAGES.length ? String(i + 1) + '. ' : '') + s.label })),
  },
  { key: 'product_usage', label: 'Product usage', kind: 'usage', ops: ['has', 'not_has'], hint: 'Has a platform account; optionally signed in within N days.' },
];

export function fieldDef(key: string): FieldDef | null {
  const k = String(key || '');
  if (k.startsWith('custom:')) return FIELDS.find((f) => f.key === 'custom') || null;
  if (k.startsWith('activity:')) return FIELDS.find((f) => f.key === 'activity') || null;
  return FIELDS.find((f) => f.key === k) || null;
}

export const OP_LABELS: ReadonlyArray<[SegmentOp, string]> = [
  ['eq', 'is'], ['neq', 'is not'],
  ['contains', 'contains'], ['not_contains', 'does not contain'],
  ['starts_with', 'starts with'], ['ends_with', 'ends with'],
  ['is_set', 'has any value'], ['is_empty', 'is empty'],
  ['in', 'is one of'], ['not_in', 'is none of'],
  ['gt', 'is after stage'], ['gte', 'is at or after stage'], ['lt', 'is before stage'], ['lte', 'is at or before stage'],
  ['before', 'is before'], ['after', 'is after'],
  ['within_days', 'is within the last N days'], ['older_than_days', 'is older than N days'],
  ['has', 'has'], ['not_has', 'does not have'],
];
export function opLabel(op: SegmentOp): string {
  const hit = OP_LABELS.find((o) => o[0] === op);
  return hit ? hit[1] : String(op);
}

const CUSTOM_KEY_RE = /^[a-z0-9_]{1,40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── validation ─────────────────────────────────────────────────────────────────────────────────

export interface SegmentIssue {
  /** `error` blocks saving and blocks a send. `warning` is shown but does not block. */
  level: 'error' | 'warning';
  path: string;
  message: string;
}

/**
 * Check a tree before it is compiled or stored.
 *
 * The two WARNINGS matter as much as the errors. An AND group with no conditions matches EVERY
 * contact, and an OR group with no conditions matches NOBODY — both are mathematically right
 * (they are the identity of their operator) and both are catastrophic to discover after a send. So
 * they are reported, and the campaign confirmation gate treats a match-everyone segment as large.
 */
export function validateSegment(node: SegmentNode, path = 'root', depth = 0, counter = { n: 0 }): SegmentIssue[] {
  const issues: SegmentIssue[] = [];
  counter.n++;
  if (counter.n > MAX_NODES) return [{ level: 'error', path, message: 'This segment has more than ' + MAX_NODES + ' conditions.' }];
  if (depth > MAX_DEPTH) return [{ level: 'error', path, message: 'Conditions are nested more than ' + MAX_DEPTH + ' deep.' }];
  if (!node || typeof node !== 'object') return [{ level: 'error', path, message: 'Not a condition.' }];

  if (node.type === 'group') {
    if (node.op !== 'and' && node.op !== 'or') {
      issues.push({ level: 'error', path, message: 'A group must join its conditions with AND or OR.' });
    }
    const kids = Array.isArray(node.children) ? node.children : [];
    if (kids.length === 0) {
      issues.push({
        level: 'warning',
        path,
        message: node.op === 'or'
          ? 'This OR group has no conditions, so it matches nobody.'
          : 'This group has no conditions, so it matches every contact.',
      });
    }
    kids.forEach((k, i) => issues.push(...validateSegment(k, path + '.' + i, depth + 1, counter)));
    return issues;
  }

  if (node.type !== 'cond') return [{ level: 'error', path, message: 'Unknown node type.' }];

  const def = fieldDef(node.field);
  if (!def) return [{ level: 'error', path, message: 'Unknown field "' + String(node.field) + '".' }];
  if (!def.ops.includes(node.op)) {
    issues.push({ level: 'error', path, message: '"' + def.label + '" does not support "' + opLabel(node.op) + '".' });
    return issues;
  }

  if (def.kind === 'custom') {
    const key = String(node.field).slice(7);
    if (!CUSTOM_KEY_RE.test(key)) issues.push({ level: 'error', path, message: 'Custom field key "' + key + '" is not valid (a-z, 0-9 and _ only).' });
  }
  if (def.kind === 'activity') {
    const kind = String(node.field).slice(9);
    if (!(ACTIVITY_KINDS as readonly string[]).includes(kind)) {
      issues.push({ level: 'error', path, message: 'Unknown campaign activity "' + kind + '".' });
    }
    const v = (node.value || {}) as any;
    if (v.campaignId && !UUID_RE.test(String(v.campaignId))) issues.push({ level: 'error', path, message: 'Campaign id is not valid.' });
    if (v.days !== undefined && v.days !== null && !Number.isFinite(Number(v.days))) issues.push({ level: 'error', path, message: 'Days must be a number.' });
  }
  if (def.kind === 'list') {
    if (!UUID_RE.test(String(node.value || ''))) issues.push({ level: 'error', path, message: 'Choose a list.' });
  }
  if (def.kind === 'stage') {
    const keys = stageKeysFor(node.op, node.value);
    if (keys === null) issues.push({ level: 'error', path, message: 'Stage "' + String(node.value) + '" is not one of ours.' });
    else if (keys.length === 0) issues.push({ level: 'warning', path, message: 'No stage satisfies that comparison, so this condition matches nobody.' });
  }
  if (node.op === 'within_days' || node.op === 'older_than_days') {
    const n = Number(node.value);
    if (!Number.isFinite(n) || n < 0) issues.push({ level: 'error', path, message: 'Days must be zero or more.' });
  }
  if (node.op === 'before' || node.op === 'after') {
    if (Number.isNaN(Date.parse(String(node.value)))) issues.push({ level: 'error', path, message: 'That is not a date we can read.' });
  }
  if ((node.op === 'in' || node.op === 'not_in')) {
    const list = Array.isArray(node.value) ? node.value : [];
    if (!list.length) issues.push({ level: 'error', path, message: '"' + opLabel(node.op) + '" needs at least one value.' });
  }
  const needsValue = !['is_set', 'is_empty'].includes(node.op) && def.kind !== 'activity' && def.kind !== 'usage';
  if (needsValue && (node.value === undefined || node.value === null || String(node.value) === '')) {
    if (node.op !== 'in' && node.op !== 'not_in') issues.push({ level: 'error', path, message: 'This condition has no value.' });
  }
  return issues;
}

export function segmentErrors(node: SegmentNode): string[] {
  return validateSegment(node).filter((i) => i.level === 'error').map((i) => i.message);
}

/** True when the tree places NO restriction at all — i.e. it would send to the entire contact book. */
export function matchesEveryone(node: SegmentNode): boolean {
  if (!node || typeof node !== 'object') return false;
  if (node.type !== 'group') return false;
  if (node.not) return false;
  const kids = Array.isArray(node.children) ? node.children : [];
  if (kids.length === 0) return node.op === 'and';
  return node.op === 'and' ? false : kids.some(matchesEveryone);
}

// ── stage arithmetic (pure, shared by SQL and in-memory) ───────────────────────────────────────

/**
 * The stage a value names, or null.
 *
 * ONE PLACE, because the value arrives in two shapes: the key an API sends (`assessment`) and the
 * 1-based number the builder UI shows (`3`). A second, near-identical resolution inside the
 * description renderer got this wrong and printed "at or after stage 3" back to the operator
 * instead of "…stage Assessment" — the number is exactly what they cannot check.
 */
export function resolveStageKey(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const i = Number(raw) - 1;
    return i >= 0 && i < STAGES.length ? STAGES[i].key : null;
  }
  return ALL_STAGES.some((s) => s.key === raw) ? raw : null;
}

/**
 * The stage keys satisfying `stage <op> value`.
 *
 * Returns null when the value names no stage we know. Comparisons are over the SIX OPEN STAGES
 * only: "stage >= 3" is a statement about progress through the funnel, and a withdrawn or closed
 * application has no position on it — including those in a `>=` would mail a rejection to somebody
 * as though they were mid-assessment. Closed keys are still matchable with `eq` / `neq`.
 */
export function stageKeysFor(op: SegmentOp, value: unknown): string[] | null {
  const key = resolveStageKey(value);
  if (!key) return null;

  if (op === 'eq') return [key];
  if (op === 'neq') return ALL_STAGES.filter((s) => s.key !== key).map((s) => s.key);

  const isOpen = STAGES.some((s) => s.key === key);
  if (!isOpen) return [];   // ordering is meaningless against a closed stage
  const i = stageIndex(key);
  const openKeys = STAGES.map((s) => s.key);
  if (op === 'gt') return openKeys.slice(i + 1);
  if (op === 'gte') return openKeys.slice(i);
  if (op === 'lt') return openKeys.slice(0, i);
  if (op === 'lte') return openKeys.slice(0, i + 1);
  return null;
}

// ── the compiler ───────────────────────────────────────────────────────────────────────────────

export interface CompiledSegment {
  /** SQL predicate over alias `c` (mail_contacts), using `$1`-style placeholders. */
  text: string;
  params: unknown[];
}

interface Ctx { params: unknown[] }
function bind(ctx: Ctx, v: unknown): string {
  ctx.params.push(v);
  return '$' + ctx.params.length;
}

/** Escape LIKE metacharacters in a user value. Emitted with an explicit ESCAPE clause. */
export function escapeLike(v: string): string {
  return String(v).replace(/([\\%_])/g, '\\$1');
}

function textPredicate(expr: string, op: SegmentOp, value: unknown, ctx: Ctx): string {
  const col = 'coalesce(' + expr + ", '')";
  switch (op) {
    case 'eq': return 'lower(' + col + ') = lower(' + bind(ctx, String(value ?? '')) + ')';
    case 'neq': return 'lower(' + col + ') <> lower(' + bind(ctx, String(value ?? '')) + ')';
    case 'contains': return col + " ILIKE ('%' || " + bind(ctx, escapeLike(String(value ?? ''))) + " || '%') ESCAPE '\\'";
    case 'not_contains': return 'NOT (' + col + " ILIKE ('%' || " + bind(ctx, escapeLike(String(value ?? ''))) + " || '%') ESCAPE '\\')";
    case 'starts_with': return col + ' ILIKE (' + bind(ctx, escapeLike(String(value ?? ''))) + " || '%') ESCAPE '\\'";
    case 'ends_with': return col + " ILIKE ('%' || " + bind(ctx, escapeLike(String(value ?? ''))) + ") ESCAPE '\\'";
    case 'is_set': return col + " <> ''";
    case 'is_empty': return col + " = ''";
    case 'in':
    case 'not_in': {
      const vals = (Array.isArray(value) ? value : [value]).map((v) => String(v ?? '').toLowerCase());
      if (!vals.length) return op === 'in' ? 'FALSE' : 'TRUE';
      const frag = 'lower(' + col + ') IN (SELECT jsonb_array_elements_text(' + bind(ctx, JSON.stringify(vals)) + '::jsonb))';
      return op === 'in' ? frag : 'NOT (' + frag + ')';
    }
    default: return 'FALSE';
  }
}

function datePredicate(expr: string, op: SegmentOp, value: unknown, ctx: Ctx): string {
  switch (op) {
    case 'before': return expr + ' < ' + bind(ctx, new Date(String(value)).toISOString()) + '::timestamptz';
    case 'after': return expr + ' > ' + bind(ctx, new Date(String(value)).toISOString()) + '::timestamptz';
    case 'within_days': return expr + ' >= now() - make_interval(days => ' + bind(ctx, Math.max(0, Math.floor(Number(value) || 0))) + '::int)';
    case 'older_than_days': return '(' + expr + ' IS NOT NULL AND ' + expr + ' < now() - make_interval(days => ' + bind(ctx, Math.max(0, Math.floor(Number(value) || 0))) + '::int))';
    case 'is_set': return expr + ' IS NOT NULL';
    case 'is_empty': return expr + ' IS NULL';
    default: return 'FALSE';
  }
}

function condSql(node: SegmentCondition, ctx: Ctx): string {
  const def = fieldDef(node.field);
  if (!def) return 'FALSE';
  let out = 'FALSE';

  if (def.kind === 'text' || def.kind === 'enum') {
    out = textPredicate(def.expr!, node.op, node.value, ctx);
  } else if (def.kind === 'date') {
    out = datePredicate(def.expr!, node.op, node.value, ctx);
  } else if (def.kind === 'custom') {
    const key = String(node.field).slice(7);
    if (!CUSTOM_KEY_RE.test(key)) return 'FALSE';
    // `fields` is the CORE SCHEMA'S column name for a contact's custom values
    // (src/lib/mail-product/schema.ts). The key is a PARAMETER, not spliced text.
    out = textPredicate('(c.fields ->> ' + bind(ctx, key) + ')', node.op, node.value, ctx);
  } else if (def.kind === 'tag') {
    // Tags live in a `text[]` column on the contact row, not in a join table — again the core
    // schema's shape. unnest() rather than `= ANY` because a case-insensitive comparison has to
    // happen per element, and because `= ANY(${jsArray})` is the postgres-js record-literal trap.
    const frag = 'EXISTS (SELECT 1 FROM unnest(c.tags) AS t(tag) WHERE lower(t.tag) = lower(' + bind(ctx, String(node.value ?? '')) + '))';
    out = node.op === 'has' ? frag : 'NOT ' + frag;
  } else if (def.kind === 'list') {
    const id = String(node.value ?? '');
    if (!UUID_RE.test(id)) return 'FALSE';
    const frag = 'EXISTS (SELECT 1 FROM mail_list_members m WHERE m.contact_id = c.id AND m.list_id = ' + bind(ctx, id) + '::uuid)';
    out = node.op === 'has' ? frag : 'NOT ' + frag;
  } else if (def.kind === 'activity') {
    const kind = String(node.field).slice(9);
    if (!(ACTIVITY_KINDS as readonly string[]).includes(kind)) return 'FALSE';
    const v = (node.value || {}) as { campaignId?: string; days?: number };
    let where = 'e.contact_id = c.id AND e.kind = ' + bind(ctx, kind);
    if (v.campaignId && UUID_RE.test(String(v.campaignId))) where += ' AND e.campaign_id = ' + bind(ctx, String(v.campaignId)) + '::uuid';
    if (v.days !== undefined && v.days !== null && Number.isFinite(Number(v.days))) {
      where += ' AND e.created_at >= now() - make_interval(days => ' + bind(ctx, Math.max(0, Math.floor(Number(v.days)))) + '::int)';
    }
    const frag = 'EXISTS (SELECT 1 FROM mail_campaign_events e WHERE ' + where + ')';
    out = node.op === 'has' ? frag : 'NOT ' + frag;
  } else if (def.kind === 'stage') {
    const keys = stageKeysFor(node.op, node.value);
    if (keys === null) return 'FALSE';
    if (keys.length === 0) return 'FALSE';
    out = 'EXISTS (SELECT 1 FROM applications a WHERE lower(a.email) = c.email AND a.stage IN (SELECT jsonb_array_elements_text('
      + bind(ctx, JSON.stringify(keys)) + '::jsonb)))';
  } else if (def.kind === 'usage') {
    const v = (node.value || {}) as { days?: number };
    let where = 'lower(u.email) = c.email';
    if (v.days !== undefined && v.days !== null && Number.isFinite(Number(v.days))) {
      where += ' AND u.last_login_at >= now() - make_interval(days => ' + bind(ctx, Math.max(0, Math.floor(Number(v.days)))) + '::int)';
    }
    const frag = 'EXISTS (SELECT 1 FROM users u WHERE ' + where + ')';
    out = node.op === 'has' ? frag : 'NOT ' + frag;
  }

  return node.not ? 'NOT (' + out + ')' : out;
}

function nodeSql(node: SegmentNode, ctx: Ctx, depth: number): string {
  if (depth > MAX_DEPTH) return 'FALSE';
  if (!node || typeof node !== 'object') return 'FALSE';
  if (node.type === 'cond') return condSql(node, ctx);
  const kids = (Array.isArray(node.children) ? node.children : []).filter(Boolean);
  if (!kids.length) {
    // Identity of the operator: AND of nothing is TRUE, OR of nothing is FALSE.
    const identity = node.op === 'and' ? 'TRUE' : 'FALSE';
    return node.not ? 'NOT (' + identity + ')' : identity;
  }
  const joiner = node.op === 'or' ? ' OR ' : ' AND ';
  const body = '(' + kids.map((k) => nodeSql(k, ctx, depth + 1)).join(joiner) + ')';
  return node.not ? 'NOT ' + body : body;
}

/** Compile a tree to a parameterised predicate. Pure — this is what the tests pin down. */
export function compileSegment(node: SegmentNode): CompiledSegment {
  const ctx: Ctx = { params: [] };
  const text = nodeSql(node, ctx, 0);
  return { text, params: ctx.params };
}

/**
 * The compiled predicate as a drizzle fragment, ready to splice into a WHERE clause over
 * `mail_contacts c`.
 *
 * `sql.raw` is used ONLY on the compiler's own output, which contains no input-derived text —
 * every value went through bind() and arrives here as a real parameter.
 */
export function segmentSql(node: SegmentNode) {
  const { text, params } = compileSegment(node);
  const parts = text.split(/\$(\d+)/);
  let frag = sql.empty();
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      if (parts[i]) frag = sql`${frag}${sql.raw(parts[i])}`;
    } else {
      const value = params[Number(parts[i]) - 1];
      frag = sql`${frag}${value}`;
    }
  }
  return sql`(${frag})`;
}

// ── in-memory evaluation (the same semantics, without a database) ──────────────────────────────

export interface EvalContact {
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  organization?: string | null;
  phone?: string | null;
  role_title?: string | null;
  status?: string | null;
  custom?: Record<string, unknown> | null;
  tags?: string[];
  /** List ids this contact belongs to. */
  lists?: string[];
  created_at?: string | Date | null;
  last_activity_at?: string | Date | null;
  consent_at?: string | Date | null;
  activity?: { kind: string; campaignId?: string; at?: string | Date }[];
  application_stage?: string | null;
  /** The platform account, when one exists for this address. */
  account?: { last_login_at?: string | Date | null } | null;
}

function s(v: unknown): string { return v === null || v === undefined ? '' : String(v); }
function ms(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
}
const DAY = 86400000;

function evalText(actual: string, op: SegmentOp, value: unknown): boolean {
  const a = actual.toLowerCase();
  const b = s(value).toLowerCase();
  switch (op) {
    case 'eq': return a === b;
    case 'neq': return a !== b;
    case 'contains': return b !== '' && a.includes(b);
    case 'not_contains': return !(b !== '' && a.includes(b));
    case 'starts_with': return b !== '' && a.startsWith(b);
    case 'ends_with': return b !== '' && a.endsWith(b);
    case 'is_set': return actual !== '';
    case 'is_empty': return actual === '';
    case 'in': {
      const vals = (Array.isArray(value) ? value : [value]).map((v) => s(v).toLowerCase());
      return vals.includes(a);
    }
    case 'not_in': {
      const vals = (Array.isArray(value) ? value : [value]).map((v) => s(v).toLowerCase());
      return !vals.includes(a);
    }
    default: return false;
  }
}

function evalDate(actual: number | null, op: SegmentOp, value: unknown, now: number): boolean {
  switch (op) {
    case 'is_set': return actual !== null;
    case 'is_empty': return actual === null;
    case 'before': { const t = ms(value); return actual !== null && t !== null && actual < t; }
    case 'after': { const t = ms(value); return actual !== null && t !== null && actual > t; }
    case 'within_days': { const d = Math.max(0, Math.floor(Number(value) || 0)); return actual !== null && actual >= now - d * DAY; }
    case 'older_than_days': { const d = Math.max(0, Math.floor(Number(value) || 0)); return actual !== null && actual < now - d * DAY; }
    default: return false;
  }
}

function evalCond(node: SegmentCondition, c: EvalContact, now: number): boolean {
  const def = fieldDef(node.field);
  if (!def) return false;
  let out = false;

  if (def.kind === 'text' || def.kind === 'enum') {
    const map: Record<string, string> = {
      email: s(c.email),
      name: (s(c.first_name) + ' ' + s(c.last_name)).trim(),
      first_name: s(c.first_name),
      last_name: s(c.last_name),
      organization: s(c.organization),
      phone: s(c.phone),
      role_title: s(c.role_title),
      status: s(c.status),
    };
    out = evalText(map[def.key] ?? '', node.op, node.value);
  } else if (def.kind === 'date') {
    const map: Record<string, number | null> = {
      created_at: ms(c.created_at),
      last_activity_at: ms(c.last_activity_at),
      consent_at: ms(c.consent_at),
    };
    out = evalDate(map[def.key] ?? null, node.op, node.value, now);
  } else if (def.kind === 'custom') {
    const key = String(node.field).slice(7);
    const raw = (c.custom || {})[key];
    out = evalText(raw === null || raw === undefined ? '' : String(raw), node.op, node.value);
  } else if (def.kind === 'tag') {
    const want = s(node.value).toLowerCase();
    const has = (c.tags || []).some((t) => String(t).toLowerCase() === want);
    out = node.op === 'has' ? has : !has;
  } else if (def.kind === 'list') {
    const has = (c.lists || []).some((l) => String(l) === s(node.value));
    out = node.op === 'has' ? has : !has;
  } else if (def.kind === 'activity') {
    const kind = String(node.field).slice(9);
    const v = (node.value || {}) as { campaignId?: string; days?: number };
    const has = (c.activity || []).some((e) => {
      if (String(e.kind) !== kind) return false;
      if (v.campaignId && String(e.campaignId || '') !== String(v.campaignId)) return false;
      if (v.days !== undefined && v.days !== null && Number.isFinite(Number(v.days))) {
        const t = ms(e.at);
        if (t === null || t < now - Math.max(0, Math.floor(Number(v.days))) * DAY) return false;
      }
      return true;
    });
    out = node.op === 'has' ? has : !has;
  } else if (def.kind === 'stage') {
    const keys = stageKeysFor(node.op, node.value);
    out = keys !== null && keys.length > 0 && keys.includes(s(c.application_stage));
  } else if (def.kind === 'usage') {
    const v = (node.value || {}) as { days?: number };
    let has = !!c.account;
    if (has && v.days !== undefined && v.days !== null && Number.isFinite(Number(v.days))) {
      const t = ms(c.account?.last_login_at);
      has = t !== null && t >= now - Math.max(0, Math.floor(Number(v.days))) * DAY;
    }
    out = node.op === 'has' ? has : !has;
  }

  return node.not ? !out : out;
}

/**
 * Does this contact match this segment? The in-memory twin of compileSegment(), with the same
 * AND/OR/NOT and empty-group semantics. `now` is injectable so date conditions are deterministic
 * under test.
 */
export function evaluateSegment(node: SegmentNode, c: EvalContact, now: number = Date.now(), depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'cond') return evalCond(node, c, now);
  const kids = (Array.isArray(node.children) ? node.children : []).filter(Boolean);
  let out: boolean;
  if (!kids.length) out = node.op === 'and';
  else if (node.op === 'or') out = kids.some((k) => evaluateSegment(k, c, now, depth + 1));
  else out = kids.every((k) => evaluateSegment(k, c, now, depth + 1));
  return node.not ? !out : out;
}

// ── human-readable description ─────────────────────────────────────────────────────────────────

function describeValue(node: SegmentCondition): string {
  const def = fieldDef(node.field);
  if (!def) return '';
  if (node.op === 'is_set' || node.op === 'is_empty') return '';
  if (def.kind === 'activity' || def.kind === 'usage') {
    const v = (node.value || {}) as { campaignId?: string; days?: number };
    const bits: string[] = [];
    if (def.kind === 'activity') bits.push(String(node.field).slice(9));
    if (v.days !== undefined && v.days !== null) bits.push('in the last ' + Number(v.days) + ' days');
    if (v.campaignId) bits.push('for one campaign');
    return bits.join(' ');
  }
  if (Array.isArray(node.value)) return node.value.map(String).join(', ');
  if (def.kind === 'stage') {
    const key = resolveStageKey(node.value);
    const hit = key ? ALL_STAGES.find((st) => st.key === key) : null;
    return hit ? hit.label : String(node.value ?? '');
  }
  return String(node.value ?? '');
}

/** A sentence per condition, indented by depth. What the operator reads back before saving. */
export function describeSegment(node: SegmentNode, depth = 0): string[] {
  const pad = '  '.repeat(depth);
  if (!node || typeof node !== 'object') return [pad + '(invalid condition)'];
  if (node.type === 'cond') {
    const def = fieldDef(node.field);
    const label = def
      ? (def.kind === 'custom' ? 'Custom field "' + String(node.field).slice(7) + '"'
        : def.kind === 'activity' ? 'Campaign activity'
          : def.label)
      : String(node.field);
    const v = describeValue(node);
    return [pad + (node.not ? 'NOT ' : '') + label + ' ' + opLabel(node.op) + (v ? ' ' + v : '')];
  }
  const kids = Array.isArray(node.children) ? node.children : [];
  const head = pad + (node.not ? 'NOT ' : '') + (kids.length ? node.op.toUpperCase() : node.op === 'and' ? 'EVERY CONTACT' : 'NOBODY');
  const lines = [head];
  kids.forEach((k) => lines.push(...describeSegment(k, depth + 1)));
  return lines;
}
