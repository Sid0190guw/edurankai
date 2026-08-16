// src/lib/mailplatform/conditions.ts — THE CONDITION EVALUATOR. Pure, total, and never throws.
//
// A condition decides which way a run branches. If evaluation could throw, one malformed condition
// saved months ago would fail every run that reached it, at the moment it reached it — long after
// the author had gone. So every function here returns an answer, and an unusable condition answers
// FALSE with a reason recorded in the trace rather than raising.
//
// FALSE IS THE SAFE ANSWER, and it is chosen deliberately. In this system the "true" branch of a
// condition is usually the one that sends something ("assessment incomplete? -> send reminder").
// Defaulting a broken comparison to false sends nothing and leaves the candidate where they were;
// defaulting it to true would mail people on the strength of a typo.
export type ConditionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'starts_with'
  | 'ends_with'
  | 'greater_than'
  | 'less_than'
  | 'exists'
  | 'does_not_exist';

export const CONDITION_OPERATORS: ReadonlyArray<{ id: ConditionOperator; label: string; takesValue: boolean }> = [
  { id: 'equals', label: 'equals', takesValue: true },
  { id: 'not_equals', label: 'does not equal', takesValue: true },
  { id: 'contains', label: 'contains', takesValue: true },
  { id: 'starts_with', label: 'starts with', takesValue: true },
  { id: 'ends_with', label: 'ends with', takesValue: true },
  { id: 'greater_than', label: 'is greater than', takesValue: true },
  { id: 'less_than', label: 'is less than', takesValue: true },
  { id: 'exists', label: 'exists', takesValue: false },
  { id: 'does_not_exist', label: 'does not exist', takesValue: false },
];

export interface ConditionLeaf {
  /** A dotted path into the facts: contact.email, event.stage, custom.cohort. */
  field: string;
  operator: ConditionOperator;
  value?: string | number | boolean | null;
  /**
   * String comparison is case-INSENSITIVE by default. Tags, stage names and email addresses are
   * typed by hand in a builder and by machine in an event, and "Stage 3" never matching "stage 3"
   * is a bug report every time, not a feature. Set this when the case genuinely carries meaning.
   */
  caseSensitive?: boolean;
}

export type ConditionNode =
  | ConditionLeaf
  | { and: ConditionNode[] }
  | { or: ConditionNode[] }
  | { not: ConditionNode };

export type Facts = Record<string, unknown>;

export interface TraceEntry {
  describe: string;
  result: boolean;
  /** Present when the answer was forced rather than compared — a missing field, an unusable rule. */
  note?: string;
}

export interface ConditionResult {
  result: boolean;
  trace: TraceEntry[];
}

export function isLeaf(n: ConditionNode): n is ConditionLeaf {
  return !!n && typeof n === 'object' && typeof (n as ConditionLeaf).field === 'string';
}

/**
 * Resolve a dotted path against the facts.
 *
 * Facts arrive already flattened by the engine (contact.*, event.*, run.*), but a path is walked
 * anyway so a nested payload posted to a webhook — event.payload.assessment.score — is reachable
 * without the engine having to guess in advance which keys a customer will send.
 */
export function resolveField(facts: Facts, path: string): unknown {
  if (!path || !facts) return undefined;
  // The LONGEST flat key first, then walk what is left.
  //
  // Both spellings exist in the facts object at once: the router flattens the payload to
  // `event.stage`, and it also puts the whole payload under `event`. Walking from the root alone
  // misses `event.payload` when only the flat key is present; reading the flat key alone misses
  // `event.payload.nested.deep`, which is a real path into a webhook body. Trying the longest
  // matching prefix handles both without the caller having to know which shape it got.
  const parts = String(path).split('.');
  for (let i = parts.length; i >= 1; i--) {
    const key = parts.slice(0, i).join('.');
    if (!Object.prototype.hasOwnProperty.call(facts, key)) continue;
    let cur: any = (facts as any)[key];
    for (const part of parts.slice(i)) {
      if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
      cur = cur[part];
    }
    return cur;
  }
  return undefined;
}

/** Present means: not null, not undefined, not an empty/whitespace string, not an empty array. */
export function isPresent(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

const asText = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
};

/**
 * Order two values for greater_than / less_than.
 *
 * Numbers first, then dates, then text — because the fields this is asked about are scores (number),
 * deadlines (date) and stage names (text), and comparing a score as text makes 9 greater than 10.
 * Returns null when the two sides cannot be ordered at all, and the caller answers false.
 */
export function compareValues(a: unknown, b: unknown): number | null {
  const na = typeof a === 'number' ? a : Number(asText(a).trim());
  const nb = typeof b === 'number' ? b : Number(asText(b).trim());
  const bothNumeric = asText(a).trim() !== '' && asText(b).trim() !== '' && Number.isFinite(na) && Number.isFinite(nb);
  if (bothNumeric) return na === nb ? 0 : na < nb ? -1 : 1;

  const da = a instanceof Date ? a.getTime() : Date.parse(asText(a));
  const db = b instanceof Date ? b.getTime() : Date.parse(asText(b));
  if (Number.isFinite(da) && Number.isFinite(db)) return da === db ? 0 : da < db ? -1 : 1;

  const sa = asText(a);
  const sb = asText(b);
  if (sa === '' || sb === '') return null;
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

/** One leaf, evaluated. Never throws. */
export function evaluateLeaf(leaf: ConditionLeaf, facts: Facts): TraceEntry {
  const raw = resolveField(facts, leaf.field);
  const describe = leaf.field + ' ' + leaf.operator + (leaf.operator === 'exists' || leaf.operator === 'does_not_exist' ? '' : ' ' + asText(leaf.value));

  if (leaf.operator === 'exists') return { describe, result: isPresent(raw) };
  if (leaf.operator === 'does_not_exist') return { describe, result: !isPresent(raw) };

  // A missing field is not an error and not a match. `not_equals` is the one operator where a
  // missing field is genuinely TRUE: "stage is not 3" is true of a contact with no stage at all,
  // and answering false there would silently exclude every contact the field was never set on.
  if (!isPresent(raw)) {
    return { describe, result: leaf.operator === 'not_equals', note: 'the field is not set on this contact or event' };
  }

  const fold = (s: string) => (leaf.caseSensitive ? s : s.toLowerCase());
  const left = fold(asText(raw));
  const right = fold(asText(leaf.value));

  switch (leaf.operator) {
    case 'equals': return { describe, result: left === right };
    case 'not_equals': return { describe, result: left !== right };
    case 'contains': return { describe, result: right !== '' && left.includes(right) };
    case 'starts_with': return { describe, result: right !== '' && left.startsWith(right) };
    case 'ends_with': return { describe, result: right !== '' && left.endsWith(right) };
    case 'greater_than': {
      const c = compareValues(raw, leaf.value);
      return c === null ? { describe, result: false, note: 'these two values cannot be ordered' } : { describe, result: c > 0 };
    }
    case 'less_than': {
      const c = compareValues(raw, leaf.value);
      return c === null ? { describe, result: false, note: 'these two values cannot be ordered' } : { describe, result: c < 0 };
    }
    default:
      return { describe, result: false, note: 'unknown operator "' + String((leaf as any).operator) + '"' };
  }
}

/**
 * Evaluate a whole condition tree with a trace of how each part answered.
 *
 * EMPTY GROUPS FOLLOW BOOLEAN ALGEBRA, and the choice matters more than it looks: an empty AND is
 * TRUE (nothing failed) and an empty OR is FALSE (nothing matched). A builder that saves a condition
 * before any rule has been typed therefore lets the run continue rather than silently stopping every
 * contact at a condition that looks empty on screen.
 */
export function evaluateCondition(node: ConditionNode | null | undefined, facts: Facts): ConditionResult {
  const trace: TraceEntry[] = [];
  const walk = (n: ConditionNode | null | undefined, depth: number): boolean => {
    if (depth > 20) { trace.push({ describe: 'nested too deeply', result: false, note: 'a condition may nest 20 levels' }); return false; }
    if (!n || typeof n !== 'object') { trace.push({ describe: 'empty condition', result: true, note: 'nothing to check, so the run continues' }); return true; }

    if (isLeaf(n)) { const e = evaluateLeaf(n, facts); trace.push(e); return e.result; }

    if (Array.isArray((n as any).and)) {
      const kids = (n as any).and as ConditionNode[];
      // Evaluated in full, NOT short-circuited: the trace is what an operator reads on the run
      // detail page to understand why a candidate went down one branch, and a half-filled trace
      // answers "why" with silence for every rule after the first failure.
      const results = kids.map((k) => walk(k, depth + 1));
      const r = results.every(Boolean);
      trace.push({ describe: 'ALL of ' + kids.length + ' must hold', result: r });
      return r;
    }
    if (Array.isArray((n as any).or)) {
      const kids = (n as any).or as ConditionNode[];
      const results = kids.map((k) => walk(k, depth + 1));
      const r = results.some(Boolean);
      trace.push({ describe: 'ANY of ' + kids.length + ' must hold', result: r });
      return r;
    }
    if ((n as any).not !== undefined) {
      const r = !walk((n as any).not, depth + 1);
      trace.push({ describe: 'NOT', result: r });
      return r;
    }

    trace.push({ describe: 'unusable condition', result: false, note: 'not a rule, and not an and/or/not group' });
    return false;
  };
  return { result: walk(node, 0), trace };
}

/** A one-line human summary for a builder and for the run log. */
export function describeCondition(node: ConditionNode | null | undefined): string {
  if (!node || typeof node !== 'object') return 'always';
  if (isLeaf(node)) {
    const op = CONDITION_OPERATORS.find((o) => o.id === node.operator);
    const label = op ? op.label : node.operator;
    return op && !op.takesValue ? node.field + ' ' + label : node.field + ' ' + label + ' "' + asText(node.value) + '"';
  }
  if (Array.isArray((node as any).and)) return '(' + ((node as any).and as ConditionNode[]).map(describeCondition).join(' AND ') + ')';
  if (Array.isArray((node as any).or)) return '(' + ((node as any).or as ConditionNode[]).map(describeCondition).join(' OR ') + ')';
  if ((node as any).not !== undefined) return 'NOT ' + describeCondition((node as any).not);
  return 'unusable condition';
}
