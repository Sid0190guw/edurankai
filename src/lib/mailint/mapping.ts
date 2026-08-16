// src/lib/mailint/mapping.ts — EXTERNAL SHAPE -> CANONICAL EVENT. Pure; no database, no network.
//
// Section 8 of the brief, in one worked example:
//
//     external:  { "event": "candidate.moved", "candidate": { "id": "c_9", "stage": 3 } }
//        |                                    mapping
//        v
//     canonical: application.stage.changed  { application_id: "c_9", stage: "assessment" }
//        |                                    router
//        v
//     the stage-3 workflow sends the assessment invitation
//
// WHY A DATA DSL RATHER THAN A FUNCTION PER SYSTEM. A connector written in code has to be deployed
// to change; a mapping is a row, editable in the console by whoever is doing the integration, and
// testable against a captured payload before it is saved. The systems this platform has to meet
// (an ATS, a university SIS, a government portal) each spell the same fact differently and none of
// them will change their spelling for us — so the variation belongs in data.
//
// EVERYTHING HERE IS TOTAL. A mapping never throws: a missing path yields `undefined`, an
// unmappable value yields an error in the returned list. A transformation step that throws inside a
// webhook handler is a 500 to the sending system, which then RETRIES the same unmappable payload
// forever — the loop this design exists to avoid.

import { canonicalEventType, eventDescriptor, type CanonicalEvent, type EventSource } from './events';

// ---------------------------------------------------------------------------------------------
// Path extraction
// ---------------------------------------------------------------------------------------------

/**
 * Read `$.candidate.stage`, `candidate.stage`, `$.items[0].email` out of a parsed JSON body.
 *
 * Deliberately NOT a JSONPath library: the supported grammar is dotted keys and numeric indices,
 * which covers every real webhook payload and cannot express a filter expression that walks an
 * attacker-supplied structure into a stack overflow.
 */
export function getPath(obj: unknown, path: string): unknown {
  const p = String(path || '').trim();
  if (!p) return undefined;
  const cleaned = p.startsWith('$.') ? p.slice(2) : p.startsWith('$') ? p.slice(1) : p;
  if (!cleaned) return obj;
  let cur: any = obj;
  // Split on dots, then peel [n] indices off each segment.
  for (const rawSeg of cleaned.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    const m = /^([^[\]]*)((\[\d+\])*)$/.exec(rawSeg);
    if (!m) return undefined;
    const key = m[1];
    if (key) {
      if (typeof cur !== 'object') return undefined;
      cur = (cur as any)[key];
    }
    const idx = m[2];
    if (idx) {
      for (const im of idx.matchAll(/\[(\d+)\]/g)) {
        if (!Array.isArray(cur)) return undefined;
        cur = cur[Number(im[1])];
      }
    }
  }
  return cur;
}

/** Is a path syntactically storable? Checked when a mapping is saved, not when it runs. */
export function validPath(path: string): boolean {
  return /^\$?\.?[A-Za-z0-9_]+(\[\d+\])*(\.[A-Za-z0-9_]+(\[\d+\])*)*$/.test(String(path || '').trim());
}

// ---------------------------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------------------------

/**
 * The closed set of value transforms.
 *
 * Closed on purpose. An "eval this expression" step would make a mapping row a code-execution
 * surface reachable by anyone who can edit an integration — which, on this platform, is a
 * console-authenticated admin, and that is exactly one compromised session away from arbitrary
 * server-side code.
 */
export type TransformName =
  | 'string' | 'number' | 'integer' | 'boolean'
  | 'trim' | 'lowercase' | 'uppercase'
  | 'email'
  | 'iso_date' | 'epoch_seconds' | 'epoch_millis'
  | 'first' | 'join_comma' | 'count'
  | 'json';

export const TRANSFORMS: readonly TransformName[] = [
  'string', 'number', 'integer', 'boolean',
  'trim', 'lowercase', 'uppercase',
  'email',
  'iso_date', 'epoch_seconds', 'epoch_millis',
  'first', 'join_comma', 'count',
  'json',
] as const;

export interface TransformResult { ok: boolean; value?: unknown; error?: string }

export function applyTransform(name: TransformName, value: unknown): TransformResult {
  switch (name) {
    case 'string':
      return { ok: true, value: value === null || value === undefined ? '' : String(value) };
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: 'not a number: ' + short(value) };
    }
    case 'integer': {
      const n = Number(value);
      return Number.isFinite(n) ? { ok: true, value: Math.trunc(n) } : { ok: false, error: 'not a number: ' + short(value) };
    }
    case 'boolean': {
      if (typeof value === 'boolean') return { ok: true, value };
      const s = String(value).trim().toLowerCase();
      if (['true', '1', 'yes', 'y', 'on'].includes(s)) return { ok: true, value: true };
      if (['false', '0', 'no', 'n', 'off', ''].includes(s)) return { ok: true, value: false };
      return { ok: false, error: 'not a boolean: ' + short(value) };
    }
    case 'trim':
      return { ok: true, value: String(value ?? '').trim() };
    case 'lowercase':
      return { ok: true, value: String(value ?? '').toLowerCase() };
    case 'uppercase':
      return { ok: true, value: String(value ?? '').toUpperCase() };
    case 'email': {
      const s = String(value ?? '').trim().toLowerCase();
      // The same shape check the contact importer uses. An address that fails here is REFUSED, not
      // repaired: a mapping that guesses at an address sends somebody else's mail to a stranger.
      if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(s)) return { ok: false, error: 'not an email address: ' + short(value) };
      return { ok: true, value: s };
    }
    case 'iso_date': {
      const t = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
      if (!Number.isFinite(t)) return { ok: false, error: 'not a date: ' + short(value) };
      return { ok: true, value: new Date(t).toISOString() };
    }
    case 'epoch_seconds': {
      const n = Number(value);
      if (!Number.isFinite(n)) return { ok: false, error: 'not a number: ' + short(value) };
      return { ok: true, value: new Date(n * 1000).toISOString() };
    }
    case 'epoch_millis': {
      const n = Number(value);
      if (!Number.isFinite(n)) return { ok: false, error: 'not a number: ' + short(value) };
      return { ok: true, value: new Date(n).toISOString() };
    }
    case 'first':
      return { ok: true, value: Array.isArray(value) ? value[0] : value };
    case 'join_comma':
      return { ok: true, value: Array.isArray(value) ? value.map((v) => String(v)).join(', ') : String(value ?? '') };
    case 'count':
      return { ok: true, value: Array.isArray(value) ? value.length : (value ? 1 : 0) };
    case 'json':
      return { ok: true, value: JSON.stringify(value ?? null) };
    default:
      return { ok: false, error: 'unknown transform: ' + String(name) };
  }
}

function short(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? null);
  return String(s).slice(0, 60);
}

// ---------------------------------------------------------------------------------------------
// The mapping shape
// ---------------------------------------------------------------------------------------------

/** One condition that decides whether a mapping applies to an incoming payload. */
export interface MatchRule {
  path: string;
  /** Exactly one of these. `equals` compares as strings so 3 and "3" match, which webhooks do. */
  equals?: string | number | boolean;
  in?: (string | number)[];
  exists?: boolean;
  matches?: string; // anchored, case-insensitive regex source; length-capped when saved
}

export interface FieldRule {
  /** Canonical payload key to write, e.g. `application_id`. */
  to: string;
  /** Where to read it. Omit when using `value`. */
  from?: string;
  /** A literal, for constants the external system does not send. */
  value?: string | number | boolean | null;
  /** Applied left to right after reading. */
  transforms?: TransformName[];
  /** Named lookup applied after transforms. Misses fall through to `default` or fail. */
  valueMap?: string;
  default?: string | number | boolean | null;
  /** Fail the whole mapping when this field cannot be produced. */
  required?: boolean;
}

export interface EventMapping {
  id?: string;
  name: string;
  /** The connector/source this mapping belongs to; becomes the event's `source`. */
  source: EventSource | string;
  /** All rules must hold for the mapping to apply. An empty list matches every payload. */
  match: MatchRule[];
  /**
   * The canonical event to produce. Either a fixed type, or a lookup: read a field and translate
   * it through a value map, which is how one endpoint carrying twelve external event names becomes
   * twelve canonical events without twelve mappings.
   */
  canonicalType: string | { from: string; valueMap: string; default?: string };
  fields: FieldRule[];
  /** Named lookup tables, shared by canonicalType and by any field rule. */
  valueMaps?: Record<string, Record<string, string>>;
  /** Where the SENDER's own event id lives. This is what makes their retry our duplicate. */
  eventIdPath?: string;
  /** Where the fact's own timestamp lives. Falls back to receipt time, and says so. */
  occurredAtPath?: string;
  /** Where the entity id lives, when it is not `<entity>_id` in the mapped payload. */
  entityIdPath?: string;
  isActive?: boolean;
  /** Lower runs first. Ties break on name, so evaluation order is total and stable. */
  priority?: number;
}

export interface MappingResult {
  ok: boolean;
  /** True when the payload did not match this mapping at all — not an error, just a miss. */
  skipped?: boolean;
  event?: Partial<CanonicalEvent>;
  errors: string[];
  /** Every field the mapping produced, for the console's "explain this mapping" view. */
  trace?: { to: string; from?: string; raw?: unknown; value?: unknown; note?: string }[];
}

// ---------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------

export function matchRuleHolds(rule: MatchRule, payload: unknown): boolean {
  const v = getPath(payload, rule.path);
  if (rule.exists !== undefined) return rule.exists ? v !== undefined && v !== null : v === undefined || v === null;
  if (rule.equals !== undefined) return v !== undefined && v !== null && String(v) === String(rule.equals);
  if (rule.in !== undefined) return v !== undefined && v !== null && rule.in.map(String).includes(String(v));
  if (rule.matches !== undefined) {
    if (v === undefined || v === null) return false;
    try {
      // Anchored and length-capped. An unanchored, unbounded pattern from a config row is a
      // catastrophic-backtracking denial of service on the inbound path.
      return new RegExp('^(?:' + String(rule.matches).slice(0, 200) + ')$', 'i').test(String(v));
    } catch { return false; }
  }
  return false;
}

export function mappingMatches(mapping: EventMapping, payload: unknown): boolean {
  if (mapping.isActive === false) return false;
  const rules = mapping.match || [];
  if (!rules.length) return true;
  return rules.every((r) => matchRuleHolds(r, payload));
}

/** Order mappings deterministically: priority, then name. */
export function orderMappings(mappings: EventMapping[]): EventMapping[] {
  return [...mappings].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || String(a.name).localeCompare(String(b.name)));
}

/** The first mapping that claims this payload, or null. */
export function selectMapping(mappings: EventMapping[], payload: unknown): EventMapping | null {
  for (const m of orderMappings(mappings)) if (mappingMatches(m, payload)) return m;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------------------------

/**
 * Turn one external payload into one canonical event.
 *
 * The result is a PARTIAL event: orgId comes from the authenticated key, never from the body (a
 * payload that could name its own tenant is a cross-tenant write waiting to happen), and the final
 * validation against the catalogue happens in validateEvent(). This function's job is shape, not
 * authority.
 */
export function applyMapping(
  mapping: EventMapping,
  payload: unknown,
  opts: { receivedAt?: string } = {},
): MappingResult {
  const errors: string[] = [];
  const trace: NonNullable<MappingResult['trace']> = [];

  if (!mappingMatches(mapping, payload)) return { ok: false, skipped: true, errors: [] };

  // ---- the canonical type -------------------------------------------------------------------
  let type = '';
  if (typeof mapping.canonicalType === 'string') {
    type = canonicalEventType(mapping.canonicalType);
  } else {
    const raw = getPath(payload, mapping.canonicalType.from);
    const table = (mapping.valueMaps || {})[mapping.canonicalType.valueMap] || {};
    const hit = raw === undefined || raw === null ? undefined : table[String(raw)];
    type = canonicalEventType(String(hit || mapping.canonicalType.default || ''));
    trace.push({ to: '(type)', from: mapping.canonicalType.from, raw, value: type });
    if (!type) {
      // NOT an error. An external system that sends us twelve event kinds and has been mapped for
      // four must be able to acknowledge the other eight rather than 400 and be retried forever.
      return {
        ok: false,
        skipped: true,
        errors: [],
        trace,
      };
    }
  }

  const desc = eventDescriptor(type);
  if (!desc) errors.push('"' + type + '" is not an event in the catalogue.');

  // ---- fields -------------------------------------------------------------------------------
  const out: Record<string, unknown> = {};
  for (const rule of mapping.fields || []) {
    if (!rule || !rule.to) continue;
    let value: unknown;
    let raw: unknown;

    if (rule.from) {
      raw = getPath(payload, rule.from);
      value = raw;
    } else {
      value = rule.value;
      raw = rule.value;
    }

    let note: string | undefined;

    if (value === undefined || value === null || value === '') {
      if (rule.default !== undefined) { value = rule.default; note = 'default'; }
      else if (rule.required) { errors.push(rule.to + ': required, but ' + (rule.from || '(literal)') + ' produced nothing.'); continue; }
      else { trace.push({ to: rule.to, from: rule.from, raw, value: undefined, note: 'absent' }); continue; }
    }

    let failed = false;
    for (const t of rule.transforms || []) {
      const r = applyTransform(t, value);
      if (!r.ok) {
        // A failed transform on an OPTIONAL field drops the field; on a required one it fails the
        // mapping. Both are stated; neither is silently ignored.
        if (rule.required) errors.push(rule.to + ': ' + t + ' failed — ' + r.error);
        else note = t + ' failed (' + r.error + '), field dropped';
        failed = true;
        break;
      }
      value = r.value;
    }
    if (failed) { trace.push({ to: rule.to, from: rule.from, raw, value: undefined, note }); continue; }

    if (rule.valueMap) {
      const table = (mapping.valueMaps || {})[rule.valueMap];
      if (!table) {
        errors.push(rule.to + ': value map "' + rule.valueMap + '" is not defined on this mapping.');
        continue;
      }
      const mapped = table[String(value)];
      if (mapped === undefined) {
        if (rule.default !== undefined) { value = rule.default; note = 'value map miss, default used'; }
        else if (rule.required) { errors.push(rule.to + ': "' + short(value) + '" is not in value map "' + rule.valueMap + '".'); continue; }
        else { trace.push({ to: rule.to, from: rule.from, raw, value: undefined, note: 'value map miss' }); continue; }
      } else {
        value = mapped;
      }
    }

    out[rule.to] = value;
    trace.push({ to: rule.to, from: rule.from, raw, value, note });
  }

  // ---- envelope fields ----------------------------------------------------------------------
  const externalEventId = mapping.eventIdPath ? stringOrNull(getPath(payload, mapping.eventIdPath)) : null;

  let occurredAt = opts.receivedAt || new Date().toISOString();
  if (mapping.occurredAtPath) {
    const rawTs = getPath(payload, mapping.occurredAtPath);
    if (rawTs !== undefined && rawTs !== null && rawTs !== '') {
      const r = applyTransform('iso_date', rawTs);
      if (r.ok) occurredAt = String(r.value);
      // A bad timestamp is NOT fatal — receipt time is a defensible answer and the fact still
      // matters. It is recorded in the trace so the integration can be fixed.
      else trace.push({ to: '(occurred_at)', from: mapping.occurredAtPath, raw: rawTs, value: occurredAt, note: 'unparseable, receipt time used' });
    }
  }

  const entityId = mapping.entityIdPath
    ? stringOrNull(getPath(payload, mapping.entityIdPath))
    : (desc ? stringOrNull(out[desc.entityType + '_id']) : null);

  if (errors.length) return { ok: false, errors, trace };

  return {
    ok: true,
    errors: [],
    trace,
    event: {
      type,
      source: mapping.source,
      entityType: desc?.entityType ?? null,
      entityId,
      actorType: 'connector',
      actorId: mapping.id || mapping.name,
      payload: out,
      occurredAt,
      externalEventId,
    },
  };
}

function stringOrNull(v: unknown): string | null {
  return v === undefined || v === null || v === '' ? null : String(v);
}

// ---------------------------------------------------------------------------------------------
// Validation of the mapping itself
// ---------------------------------------------------------------------------------------------

/**
 * Check a mapping before it is stored.
 *
 * The expensive failure this prevents: a mapping saved with a typo in a path produces events whose
 * required fields are missing, which validateEvent() then refuses ONE AT A TIME, at 3am, per
 * inbound webhook. Catching it at save time costs one function call.
 */
export function validateMapping(m: EventMapping): string[] {
  const errors: string[] = [];
  if (!m.name || !String(m.name).trim()) errors.push('name is required.');
  if (!m.source) errors.push('source is required.');

  const fixedType = typeof m.canonicalType === 'string' ? m.canonicalType : null;
  if (fixedType !== null) {
    if (!eventDescriptor(fixedType)) errors.push('"' + fixedType + '" is not an event in the catalogue.');
  } else if (m.canonicalType && typeof m.canonicalType === 'object') {
    if (!validPath(m.canonicalType.from)) errors.push('canonicalType.from is not a valid path.');
    const table = (m.valueMaps || {})[m.canonicalType.valueMap];
    if (!table) errors.push('canonicalType.valueMap "' + m.canonicalType.valueMap + '" is not defined.');
    else {
      for (const [k, v] of Object.entries(table)) {
        if (!eventDescriptor(v)) errors.push('value map "' + m.canonicalType.valueMap + '" sends ' + k + ' to "' + v + '", which is not an event.');
      }
    }
    if (m.canonicalType.default && !eventDescriptor(m.canonicalType.default)) {
      errors.push('canonicalType.default "' + m.canonicalType.default + '" is not an event.');
    }
  } else {
    errors.push('canonicalType is required.');
  }

  for (const r of m.match || []) {
    if (!validPath(r.path)) errors.push('match path "' + r.path + '" is not valid.');
    if (r.equals === undefined && r.in === undefined && r.exists === undefined && r.matches === undefined) {
      errors.push('match rule on "' + r.path + '" states no condition.');
    }
    if (r.matches !== undefined) {
      try { new RegExp(String(r.matches)); } catch { errors.push('match pattern on "' + r.path + '" is not a valid expression.'); }
    }
  }

  const seen = new Set<string>();
  for (const f of m.fields || []) {
    if (!f.to) { errors.push('a field rule has no target key.'); continue; }
    if (seen.has(f.to)) errors.push('field "' + f.to + '" is written twice; the later rule would win silently.');
    seen.add(f.to);
    if (!f.from && f.value === undefined) errors.push('field "' + f.to + '" has neither a source path nor a literal value.');
    if (f.from && !validPath(f.from)) errors.push('field "' + f.to + '": "' + f.from + '" is not a valid path.');
    for (const t of f.transforms || []) {
      if (!TRANSFORMS.includes(t)) errors.push('field "' + f.to + '": "' + t + '" is not a transform.');
    }
    if (f.valueMap && !(m.valueMaps || {})[f.valueMap]) {
      errors.push('field "' + f.to + '": value map "' + f.valueMap + '" is not defined.');
    }
  }

  // Required-field coverage, but only for a fixed canonical type: with a lookup type the required
  // set depends on the payload, and refusing to save on that basis would block a correct mapping.
  if (fixedType) {
    const desc = eventDescriptor(fixedType);
    if (desc) {
      const produced = new Set((m.fields || []).map((f) => f.to));
      for (const need of desc.required) {
        if (!produced.has(need)) errors.push('every ' + desc.type + ' needs payload.' + need + ', and no field rule produces it.');
      }
    }
  }

  if (m.eventIdPath && !validPath(m.eventIdPath)) errors.push('eventIdPath is not a valid path.');
  if (m.occurredAtPath && !validPath(m.occurredAtPath)) errors.push('occurredAtPath is not a valid path.');
  if (m.entityIdPath && !validPath(m.entityIdPath)) errors.push('entityIdPath is not a valid path.');

  return errors;
}

/**
 * Run a mapping against a captured payload without emitting anything.
 *
 * This is what the console's "test this mapping" button calls, and what a connector's own test
 * fixtures assert against — one code path, so a mapping that previews correctly behaves correctly.
 */
export function dryRun(mapping: EventMapping, payload: unknown): MappingResult {
  return applyMapping(mapping, payload, { receivedAt: new Date().toISOString() });
}
