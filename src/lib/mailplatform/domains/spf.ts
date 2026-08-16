// src/lib/mailplatform/domains/spf.ts — READ AN SPF RECORD, JUDGE IT, AND PROPOSE A MERGE.
//
// Pure. No network in the parser, no database anywhere — the recursive lookup counter is the only
// async function and it takes a resolver, so every judgement in this file is testable.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: WE NEVER PROPOSE REPLACING AN SPF RECORD.
// A domain's SPF record is the authorisation list for every system that sends mail as that domain —
// the payroll provider, the ticketing system, the CRM, the university's own relay. Telling a
// customer to "set your SPF to this" is telling them to silently unauthorise all of it, and the
// failure is delayed and diffuse: mail keeps flowing for hours from warm caches, then invoices
// start landing in spam. So recommend() MERGES: it takes what is published, adds only what is
// missing, keeps every existing mechanism and keeps the existing `all` qualifier.
//
// Reference: RFC 7208. The limits enforced here are §4.6.4 (ten DNS-lookup terms) and §4.6.4's
// two-void-lookup rule, plus the fact — §3.2, and the single most common real fault — that a domain
// publishing TWO SPF records has no valid SPF at all.

export type SpfQualifier = '+' | '-' | '~' | '?';

export interface SpfTerm {
  /** The raw term as written, e.g. `include:_spf.example.com`. */
  raw: string;
  kind: 'mechanism' | 'modifier';
  qualifier: SpfQualifier;
  /** Lower-cased mechanism or modifier name: `include`, `ip4`, `all`, `redirect`, `exp`. */
  name: string;
  /** Everything after the `:` or `=`, or null when the term takes no value. */
  value: string | null;
  /** Does evaluating this term cost a DNS lookup against the RFC 7208 limit of ten? */
  costsLookup: boolean;
}

export interface SpfParse {
  ok: boolean;
  raw: string;
  terms: SpfTerm[];
  /** The qualifier on the final `all`, or null when the record has no `all` term. */
  allQualifier: SpfQualifier | null;
  /** A `redirect=` value, which replaces the `all` semantics when there is no `all`. */
  redirect: string | null;
  /** Fatal problems: the record does not mean what its author intended. */
  errors: string[];
  /** Non-fatal problems worth a human's attention. */
  warnings: string[];
  /** Lookup-costing terms in THIS record only. Nested includes are counted by countLookups(). */
  directLookups: number;
}

const MECHANISMS = ['all', 'include', 'a', 'mx', 'ptr', 'ip4', 'ip6', 'exists'] as const;
const MODIFIERS = ['redirect', 'exp'] as const;
/** Terms that cost one DNS lookup each against the limit of ten (RFC 7208 §4.6.4). */
const LOOKUP_TERMS = new Set(['include', 'a', 'mx', 'ptr', 'exists', 'redirect']);

export const SPF_LOOKUP_LIMIT = 10;
export const SPF_VOID_LOOKUP_LIMIT = 2;

/** Every `v=spf1` record among a name's TXT records. This is how "multiple SPF" is detected. */
export function selectSpfRecords(txtValues: string[]): string[] {
  return (txtValues || []).map((t) => String(t || '').trim()).filter((t) => /^v=spf1(\s|$)/i.test(t));
}

function isIpv4Cidr(v: string): boolean {
  const m = v.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/);
  if (!m) return false;
  if (m.slice(1, 5).map(Number).some((n) => n > 255)) return false;
  return m[5] === undefined || Number(m[5]) <= 32;
}

function isIpv6Cidr(v: string): boolean {
  const [addr, prefix] = v.split('/');
  if (prefix !== undefined && (!/^\d{1,3}$/.test(prefix) || Number(prefix) > 128)) return false;
  return /^[0-9a-f:]+$/i.test(addr) && addr.includes(':');
}

/**
 * Parse one SPF record.
 *
 * Never throws. A record it cannot make sense of comes back with `ok: false` and the reasons — a
 * malformed record is a thing we must be able to DESCRIBE to the customer, not a thing that takes
 * the health page down.
 */
export function parseSpf(record: string): SpfParse {
  const raw = String(record || '').trim();
  const out: SpfParse = {
    ok: false, raw, terms: [], allQualifier: null, redirect: null, errors: [], warnings: [], directLookups: 0,
  };
  if (!raw) {
    out.errors.push('The record is empty.');
    return out;
  }
  if (!/^v=spf1(\s|$)/i.test(raw)) {
    out.errors.push('An SPF record must begin with "v=spf1".');
    return out;
  }
  if (raw.length > 450) {
    out.warnings.push('The record is ' + raw.length + ' characters. TXT strings are limited to 255 bytes each, so this must be published as multiple quoted chunks; some DNS panels will not do that correctly.');
  }

  const tokens = raw.split(/\s+/).slice(1).filter(Boolean);
  let sawAll = false;
  let termsAfterAll = 0;

  for (const token of tokens) {
    // A modifier is `name=value` and carries no qualifier.
    const mod = token.match(/^([a-z0-9_-]+)=(.*)$/i);
    if (mod && (MODIFIERS as readonly string[]).includes(mod[1].toLowerCase())) {
      const name = mod[1].toLowerCase();
      const value = mod[2];
      if (name === 'redirect') {
        if (out.redirect) out.errors.push('More than one "redirect=" modifier. Only the first is evaluated.');
        else out.redirect = value;
      }
      out.terms.push({ raw: token, kind: 'modifier', qualifier: '+', name, value, costsLookup: name === 'redirect' });
      if (name === 'redirect') out.directLookups++;
      continue;
    }

    let qualifier: SpfQualifier = '+';
    let body = token;
    if (/^[+\-~?]/.test(token)) {
      qualifier = token[0] as SpfQualifier;
      body = token.slice(1);
    }
    const colon = body.indexOf(':');
    const name = (colon === -1 ? body : body.slice(0, colon)).toLowerCase();
    let value: string | null = colon === -1 ? null : body.slice(colon + 1);

    // `a` and `mx` accept a bare CIDR suffix: `a/24`. Split it off so the name stays recognisable.
    const slash = name.indexOf('/');
    const bareName = slash === -1 ? name : name.slice(0, slash);

    if (!(MECHANISMS as readonly string[]).includes(bareName)) {
      out.errors.push('Unknown term "' + token + '". Receivers stop evaluating at a term they cannot parse, so everything after it is ignored.');
      out.terms.push({ raw: token, kind: 'mechanism', qualifier, name: bareName, value, costsLookup: false });
      continue;
    }
    if (sawAll) termsAfterAll++;

    if (bareName === 'all') {
      if (sawAll) out.errors.push('More than one "all" term. Only the first is evaluated.');
      else out.allQualifier = qualifier;
      sawAll = true;
    }
    if (bareName === 'ip4' && (!value || !isIpv4Cidr(value))) {
      out.errors.push('"' + token + '" is not a valid IPv4 address or CIDR range.');
    }
    if (bareName === 'ip6' && (!value || !isIpv6Cidr(value))) {
      out.errors.push('"' + token + '" is not a valid IPv6 address or CIDR range.');
    }
    if (bareName === 'include' && !value) {
      out.errors.push('"include" needs a domain, as in "include:mail.example.com".');
    }
    if (bareName === 'ptr') {
      out.warnings.push('The "ptr" mechanism is deprecated (RFC 7208 §5.5): it is slow, and several large receivers ignore it entirely.');
    }

    const costsLookup = LOOKUP_TERMS.has(bareName);
    if (costsLookup) out.directLookups++;
    out.terms.push({ raw: token, kind: 'mechanism', qualifier, name: bareName, value, costsLookup });
  }

  if (termsAfterAll > 0) {
    out.warnings.push(termsAfterAll + ' term(s) appear after "all" and will never be evaluated. Move them before it.');
  }
  if (!sawAll && !out.redirect) {
    out.warnings.push('The record has no "all" term, so it neither passes nor fails unlisted senders. Add "~all" (soft fail) or "-all" (hard fail).');
  }
  if (out.allQualifier === '+') {
    out.errors.push('"+all" authorises every server on the internet to send as this domain. That is strictly worse than having no SPF record.');
  }
  if (out.directLookups > SPF_LOOKUP_LIMIT) {
    out.errors.push('This record alone costs ' + out.directLookups + ' DNS lookups; the limit is ' + SPF_LOOKUP_LIMIT + '. Receivers return permerror and SPF fails for every message.');
  }

  out.ok = out.errors.length === 0;
  return out;
}

/** The result of following every `include:` and `redirect=` to the bottom. */
export interface SpfLookupCount {
  /** Total lookup-costing terms across the whole tree. */
  total: number;
  /** Terms whose lookup could not be performed, so `total` is a floor, not a fact. */
  unresolved: string[];
  /** Includes that resolved to no SPF record at all — the RFC's "void lookups". */
  voidLookups: string[];
  overLimit: boolean;
  /** True when at least one branch could not be followed; `total` is then a minimum. */
  partial: boolean;
  visited: string[];
}

/**
 * Count DNS lookups across the include tree.
 *
 * The brief asks for a warning "where detectable" — and it IS detectable, by following the tree,
 * which is what a receiver does. The honest part is `partial`: when a nested include cannot be
 * resolved the total is reported as a FLOOR, never as a verdict, for the same reason the resolver
 * distinguishes an unchecked lookup from an absent record.
 */
export async function countLookups(
  record: string,
  domain: string,
  resolver: { txt(name: string): Promise<{ checked: boolean; values: string[]; error: string | null }> },
  opts: { maxDepth?: number; visited?: Set<string> } = {},
): Promise<SpfLookupCount> {
  const maxDepth = opts.maxDepth ?? 10;
  const visited = opts.visited ?? new Set<string>();
  const out: SpfLookupCount = { total: 0, unresolved: [], voidLookups: [], overLimit: false, partial: false, visited: [] };

  const walk = async (rec: string, host: string, depth: number): Promise<void> => {
    const key = host.toLowerCase();
    if (visited.has(key)) return; // an include cycle costs lookups but must not hang the checker
    visited.add(key);
    out.visited.push(key);
    if (depth > maxDepth) {
      out.partial = true;
      out.unresolved.push(host + ' (nesting deeper than ' + maxDepth + ' levels)');
      return;
    }
    const parsed = parseSpf(rec);
    for (const term of parsed.terms) {
      if (!term.costsLookup) continue;
      out.total++;
      const target = term.name === 'include' || term.name === 'redirect' ? (term.value || '').trim() : null;
      if (!target) continue; // a/mx/ptr/exists cost one lookup and do not branch
      const lookup = await resolver.txt(target);
      if (!lookup.checked) {
        out.partial = true;
        out.unresolved.push(target + ' (' + (lookup.error || 'lookup failed') + ')');
        continue;
      }
      const nested = selectSpfRecords(lookup.values);
      if (nested.length === 0) {
        out.voidLookups.push(target);
        continue;
      }
      await walk(nested[0], target, depth + 1);
    }
  };

  await walk(record, domain, 0);
  out.overLimit = out.total > SPF_LOOKUP_LIMIT;
  return out;
}

export interface SpfAudit {
  /** Every v=spf1 record found at the name. */
  records: string[];
  /** The one that will be evaluated, or null. */
  effective: string | null;
  parse: SpfParse | null;
  errors: string[];
  warnings: string[];
  /** True only when exactly one well-formed record is published. */
  healthy: boolean;
}

/**
 * Judge what is published at a name.
 *
 * TWO RECORDS IS THE FAULT THIS FUNCTION EXISTS FOR. It is the most common SPF mistake by a wide
 * margin, it is invisible in most DNS panels, and its effect is not "the second record is ignored"
 * — it is that the domain has NO valid SPF policy and every receiver treats SPF as permerror.
 */
export function auditSpf(txtValues: string[]): SpfAudit {
  const records = selectSpfRecords(txtValues);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (records.length === 0) {
    return { records, effective: null, parse: null, errors: ['No SPF record is published.'], warnings, healthy: false };
  }
  if (records.length > 1) {
    errors.push(
      'There are ' + records.length + ' SPF records on this name. A domain may publish only one; receivers treat this as permerror and SPF fails for EVERY message. Merge them into a single record.',
    );
  }
  const parse = parseSpf(records[0]);
  errors.push(...parse.errors);
  warnings.push(...parse.warnings);
  return { records, effective: records[0], parse, errors, warnings, healthy: records.length === 1 && parse.ok };
}

export interface SpfRecommendation {
  /** The record we suggest publishing. */
  record: string;
  action: 'create' | 'merge' | 'unchanged' | 'manual';
  /** Terms this proposal ADDS. Never empty for `merge`. */
  additions: string[];
  /** Terms carried over untouched from what is already published. */
  preserved: string[];
  /** Why a human has to do this one by hand. */
  manualReason: string | null;
  warnings: string[];
  /** Lookup cost of the PROPOSAL, counting only its own terms. */
  directLookups: number;
}

export interface SpfSource {
  includes: string[];
  ip4: string[];
  ip6: string[];
}

/**
 * Propose an SPF record for a domain that must be authorised to send through `source`.
 *
 * Merge rules, in order of how much damage getting them wrong does:
 *   1. Nothing already published is ever removed.
 *   2. The existing `all` qualifier is kept. Tightening `~all` to `-all` is a deliverability
 *      decision with real consequences and it is not ours to make silently.
 *   3. New terms are inserted BEFORE `all`, because terms after it are dead.
 *   4. Two published records are never merged automatically. Which mechanisms belong to which
 *      sender is a judgement about systems we cannot see, and a wrong merge unauthorises a live
 *      sender. We show both records and ask.
 */
export function recommendSpf(published: string[] | null, source: SpfSource): SpfRecommendation {
  const wanted: string[] = [
    ...(source.includes || []).map((i) => 'include:' + i),
    ...(source.ip4 || []).map((i) => 'ip4:' + i),
    ...(source.ip6 || []).map((i) => 'ip6:' + i),
  ];
  const existing = selectSpfRecords(published || []);
  const warnings: string[] = [];

  if (wanted.length === 0) {
    return {
      record: '',
      action: 'manual',
      additions: [],
      preserved: existing[0] ? parseSpf(existing[0]).terms.map((t) => t.raw) : [],
      manualReason: 'This deployment has not been told how its outbound mail is authorised (no SPF include and no sending IP is configured), so there is nothing to recommend. Set MAIL_SPF_INCLUDE or MAIL_SPF_IP4 first.',
      warnings,
      directLookups: 0,
    };
  }

  if (existing.length === 0) {
    const record = ['v=spf1', ...wanted, '~all'].join(' ');
    return {
      record,
      action: 'create',
      additions: wanted,
      preserved: [],
      manualReason: null,
      warnings: ['Start with "~all" (soft fail). Once you have confirmed for a week that nothing legitimate is failing SPF, tighten it to "-all".'],
      directLookups: parseSpf(record).directLookups,
    };
  }

  if (existing.length > 1) {
    return {
      record: '',
      action: 'manual',
      additions: wanted,
      preserved: existing,
      manualReason: 'This domain publishes ' + existing.length + ' SPF records, which is itself a fault. Merging them means deciding which mechanisms belong to which of your senders, and getting that wrong stops mail from a system we cannot see from here. Merge them by hand into one record, then re-check.',
      warnings,
      directLookups: 0,
    };
  }

  const parse = parseSpf(existing[0]);
  const have = new Set(parse.terms.map((t) => t.raw.replace(/^[+\-~?]/, '').toLowerCase()));
  const additions = wanted.filter((w) => !have.has(w.toLowerCase()));

  if (additions.length === 0) {
    return {
      record: existing[0],
      action: 'unchanged',
      additions: [],
      preserved: parse.terms.map((t) => t.raw),
      manualReason: null,
      warnings: parse.warnings,
      directLookups: parse.directLookups,
    };
  }

  const before: string[] = [];
  const allTerms: string[] = [];
  for (const t of parse.terms) {
    if (t.name === 'all' && t.kind === 'mechanism') allTerms.push(t.raw);
    else before.push(t.raw);
  }
  const record = ['v=spf1', ...before, ...additions, ...allTerms].join(' ');
  const merged = parseSpf(record);
  warnings.push(...merged.warnings);
  if (merged.directLookups > SPF_LOOKUP_LIMIT) {
    warnings.push('This merged record costs ' + merged.directLookups + ' DNS lookups before counting nested includes; the limit is ' + SPF_LOOKUP_LIMIT + '. Replace some "include:" terms with the "ip4:" ranges behind them.');
  } else if (merged.directLookups >= SPF_LOOKUP_LIMIT - 2) {
    warnings.push('This merged record already costs ' + merged.directLookups + ' of the ' + SPF_LOOKUP_LIMIT + ' permitted DNS lookups, before nested includes are counted. Check the total with the lookup counter.');
  }

  return {
    record,
    action: 'merge',
    additions,
    preserved: parse.terms.map((t) => t.raw),
    manualReason: null,
    warnings,
    directLookups: merged.directLookups,
  };
}

/** Does the published record already authorise this deployment? Used by the verification engine. */
export function spfAuthorises(published: string[] | null, source: SpfSource): { authorised: boolean; missing: string[] } {
  const records = selectSpfRecords(published || []);
  const wanted = [
    ...(source.includes || []).map((i) => 'include:' + i),
    ...(source.ip4 || []).map((i) => 'ip4:' + i),
    ...(source.ip6 || []).map((i) => 'ip6:' + i),
  ];
  if (wanted.length === 0) return { authorised: false, missing: [] };
  if (records.length !== 1) return { authorised: false, missing: wanted };
  const have = new Set(parseSpf(records[0]).terms.map((t) => t.raw.replace(/^[+\-~?]/, '').toLowerCase()));
  const missing = wanted.filter((w) => !have.has(w.toLowerCase()));
  return { authorised: missing.length === 0, missing };
}
