// src/lib/mailgov/search-parse.ts — WORKING OUT WHAT SOMEBODY TYPED INTO THE ADMIN SEARCH BOX.
//
// PURE. No database. ./search.ts runs the lookups this classification chooses; keeping the
// classification here means the rules are testable and the search box has one answer to "why did it
// look there and not there".
//
// WHY CLASSIFY AT ALL RATHER THAN SEARCH EVERYTHING. Two reasons, and the second is the important
// one. The cheap reason: eight `ILIKE '%term%'` queries across message, event and audit tables is a
// sequential scan per surface, on the tables that grow fastest. The real reason: a search that
// always looks everywhere is a search that will eventually return a row somebody was not supposed to
// see, from a table nobody remembered was in the list. A classified search asks a small number of
// precise questions, and each one is scoped by ./policy.ts before it runs.
//
// AN RFC MESSAGE ID IS NOT AN EMAIL ADDRESS, even though it contains an @. That single ambiguity is
// most of this file: `<abc123@edurankai.in>` and `abc123@edurankai.in` are the same characters minus
// two brackets, and looking one up in the other's table returns nothing while looking perfectly
// healthy.

export type SearchKind =
  | 'email'
  | 'rfc_message_id'
  | 'uuid'
  | 'domain'
  | 'api_key_prefix'
  | 'org_slug'
  | 'ip'
  | 'text';

export interface ParsedQuery {
  kind: SearchKind;
  /** The value to search WITH, normalised: trimmed, lowercased, brackets stripped. */
  value: string;
  /** What was typed, unchanged, for the "you searched for" line. */
  raw: string;
  /** Which stores this kind is worth asking. Ordered: the most likely answer first. */
  targets: SearchTarget[];
  /** Why it was classified this way, shown on the results page under the search box. */
  explain: string;
}

export type SearchTarget =
  | 'organizations'
  | 'members'
  | 'messages'
  | 'message_events'
  | 'domains'
  | 'api_keys'
  | 'security_events'
  | 'audit'
  | 'consent'
  | 'suppressions'
  | 'campaigns'
  | 'mailboxes';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Deliberately permissive on the local part and strict on the shape. This decides which TABLE to
// search, not whether an address is deliverable — rejecting a real address here would leave a
// support engineer unable to look up the customer in front of them.
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
// The key prefix format from src/lib/mailapi/schema.ts: the first 16 characters of a key, which is
// what the console lists and what a support conversation can safely quote.
//
// UNDERSCORES AND HYPHENS ARE PART OF IT. The keys this platform issues look like
// `erm_live_<base64url>` (see rotateOrgCredentials in ./orgs.ts), so a character class of
// [a-z0-9] alone stopped at the second underscore and classified a real key prefix as free text —
// which searched organization names for it and confidently found nothing. Caught by a test that
// pasted an actual key prefix rather than an invented one.
const KEY_PREFIX_RE = /^(erm|mk|sk|pk)_[a-z0-9][a-z0-9_-]+$/i;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,60}$/i;

export function parseSearch(input: string): ParsedQuery {
  const raw = String(input || '');
  let v = raw.trim();

  // An RFC message id first, BEFORE the email test — `<x@y>` matches neither cleanly once the
  // brackets are stripped, and stripping them first is how a message id becomes a fruitless address
  // lookup.
  const bracketed = v.startsWith('<') && v.endsWith('>');
  if (bracketed) {
    const inner = v.slice(1, -1).trim().toLowerCase();
    return {
      kind: 'rfc_message_id', value: inner, raw,
      targets: ['messages', 'message_events', 'audit'],
      explain: 'Angle brackets mean an RFC message identifier, so this looked in the message log rather than among addresses.',
    };
  }

  v = v.toLowerCase();

  if (UUID_RE.test(v)) {
    return {
      kind: 'uuid', value: v, raw,
      // Ordered by what an operator holding a bare UUID is most often holding: a message id from a
      // developer, then an organization, then everything else keyed by one.
      targets: ['messages', 'organizations', 'members', 'campaigns', 'api_keys', 'audit', 'security_events', 'mailboxes'],
      explain: 'A UUID. Every record type is keyed by one, so this asked each store whether it owns this id.',
    };
  }

  if (EMAIL_RE.test(v)) {
    return {
      kind: 'email', value: v, raw,
      targets: ['members', 'consent', 'suppressions', 'messages', 'message_events', 'mailboxes'],
      explain: 'An email address. Message bodies are never searched; this matched on envelopes, membership and consent records.',
    };
  }

  if (KEY_PREFIX_RE.test(v)) {
    return {
      kind: 'api_key_prefix', value: v, raw,
      targets: ['api_keys', 'security_events', 'audit'],
      explain: 'An API key prefix. Only the prefix is stored in a readable form, so a full key is never searchable and never needs to be.',
    };
  }

  if (IPV4_RE.test(v) || (v.includes(':') && /^[0-9a-f:]+$/.test(v))) {
    return {
      kind: 'ip', value: v, raw,
      targets: ['security_events', 'audit', 'api_keys'],
      explain: 'A network address, so this looked at security events and the audit trail.',
    };
  }

  if (DOMAIN_RE.test(v)) {
    return {
      kind: 'domain', value: v, raw,
      targets: ['domains', 'organizations', 'messages', 'suppressions', 'security_events'],
      explain: 'A domain name.',
    };
  }

  if (SLUG_RE.test(v)) {
    return {
      kind: 'org_slug', value: v, raw,
      targets: ['organizations', 'campaigns', 'audit'],
      explain: 'Read as an organization slug or a campaign name.',
    };
  }

  return {
    kind: 'text', value: v, raw,
    targets: ['organizations', 'campaigns'],
    explain: 'Free text. Names only — message subjects and bodies are not searched from this box.',
  };
}

/**
 * Is the query long enough to be worth running?
 *
 * A one-character search across every store returns most of the platform, which is both slow and a
 * disclosure. Three characters is the floor, except for a UUID or an address, which are exact.
 */
export function searchable(q: ParsedQuery): { ok: boolean; error?: string } {
  if (!q.value) return { ok: false, error: 'Type something to search for.' };
  const exact = q.kind === 'uuid' || q.kind === 'email' || q.kind === 'rfc_message_id' || q.kind === 'ip';
  if (!exact && q.value.length < 3) {
    return { ok: false, error: 'Search for at least three characters.' };
  }
  return { ok: true };
}

/**
 * Escape a value used inside a LIKE pattern.
 *
 * Not injection — the driver parameterises — but a customer name containing `%` otherwise matches
 * every row in the table, which on an admin search is a cross-tenant disclosure dressed up as a
 * typo.
 */
export function likeLiteral(value: string): string {
  return value.split('\\').join('\\\\').split('%').join('\\%').split('_').join('\\_');
}
