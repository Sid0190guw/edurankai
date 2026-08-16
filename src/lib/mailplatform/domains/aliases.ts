// src/lib/mailplatform/domains/aliases.ts — ALIAS EXPANSION, AND THE LOOP THAT MUST NEVER SHIP.
//
// Pure. Graph in, delivery set out.
//
// WHY THIS IS ITS OWN FILE WITH ITS OWN TESTS: an alias loop is not a bug that produces a wrong
// screen. `support@` forwards to `help@`, somebody later points `help@` back at `support@`, and the
// next message addressed to either one is expanded, re-expanded, and delivered until something runs
// out — disk, queue, or the patience of the receiving server, which starts refusing our mail and
// keeps refusing it after the loop is fixed. The loop is created by an ordinary two-field form
// filled in by somebody who cannot see the other half of the cycle. So the check belongs in code,
// on the write path, and it must consider the WHOLE graph rather than the row being edited.
//
// Forwarding is part of the same graph. A mailbox that forwards to an address that aliases back to
// the mailbox is exactly the same cycle with two different table names, and checking aliases alone
// would miss it.

export interface AliasEdge {
  /** The address people send to. Lower-cased by normalise(). */
  source: string;
  /** One or more addresses it expands to. The brief requires "one or more". */
  targets: string[];
  isActive: boolean;
}

export type MailboxDeliveryStatus = 'active' | 'disabled' | 'suspended' | 'deleted';

export interface MailboxNode {
  address: string;
  status: MailboxDeliveryStatus;
  /** Addresses this mailbox forwards to. Part of the same cycle graph as aliases. */
  forwardTo?: string[];
  /** When forwarding, does a copy still land in this mailbox? */
  keepCopy?: boolean;
}

export interface DeliveryGraph {
  aliases: AliasEdge[];
  mailboxes: MailboxNode[];
  /** Expansion depth ceiling. Reaching it is reported, never silently truncated. */
  maxDepth?: number;
  /** Fan-out ceiling across the whole expansion. */
  maxTargets?: number;
}

export const DEFAULT_MAX_DEPTH = 10;
export const DEFAULT_MAX_TARGETS = 100;

export function normalizeAddress(address: string): string {
  return String(address || '').trim().toLowerCase();
}

export function addressDomain(address: string): string {
  const at = normalizeAddress(address).lastIndexOf('@');
  return at === -1 ? '' : normalizeAddress(address).slice(at + 1);
}

export interface Expansion {
  /** Mailboxes that will actually receive the message. */
  mailboxes: string[];
  /** Addresses that are not local mailboxes — external forwarding destinations. */
  external: string[];
  /** Every cycle found, as the path that closes it. Non-empty means DO NOT SAVE. */
  loops: string[][];
  /** Addresses that resolved to nothing: no mailbox, no alias. */
  dead: string[];
  /** Addresses skipped because the mailbox is not accepting mail. */
  undeliverable: { address: string; reason: string }[];
  /** True when a ceiling was hit; the result is then incomplete and says so. */
  truncated: boolean;
  /** Order of traversal, useful for showing an operator why mail goes where it goes. */
  path: string[];
}

/**
 * Expand an address to the set of mailboxes that will receive it.
 *
 * Cycle handling is the interesting part. A visited-set alone would silently swallow the loop and
 * return a plausible answer, which is how a loop survives review: everything looks fine. Here the
 * traversal carries its own STACK, so re-entering an address that is currently being expanded is
 * recorded as a cycle with the path that closes it, and the caller can refuse the write.
 */
export function expand(address: string, graph: DeliveryGraph): Expansion {
  const maxDepth = graph.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxTargets = graph.maxTargets ?? DEFAULT_MAX_TARGETS;

  const aliasBySource = new Map<string, AliasEdge>();
  for (const a of graph.aliases || []) {
    if (a.isActive === false) continue;
    aliasBySource.set(normalizeAddress(a.source), a);
  }
  const mailboxByAddress = new Map<string, MailboxNode>();
  for (const m of graph.mailboxes || []) mailboxByAddress.set(normalizeAddress(m.address), m);

  const out: Expansion = { mailboxes: [], external: [], loops: [], dead: [], undeliverable: [], truncated: false, path: [] };
  const seen = new Set<string>();
  const stack: string[] = [];

  const addMailbox = (addr: string, node: MailboxNode) => {
    if (node.status !== 'active') {
      out.undeliverable.push({
        address: addr,
        reason: node.status === 'deleted' ? 'the mailbox has been deleted' : 'the mailbox is ' + node.status,
      });
      return;
    }
    if (!out.mailboxes.includes(addr)) out.mailboxes.push(addr);
  };

  const walk = (raw: string, depth: number): void => {
    const addr = normalizeAddress(raw);
    if (!addr) return;
    if (out.mailboxes.length + out.external.length >= maxTargets) {
      out.truncated = true;
      return;
    }
    if (stack.includes(addr)) {
      out.loops.push([...stack.slice(stack.indexOf(addr)), addr]);
      return;
    }
    if (depth > maxDepth) {
      out.truncated = true;
      out.loops.push([...stack, addr]);
      return;
    }
    // A diamond (two aliases both pointing at one mailbox) is not a loop and must not be reported
    // as one — but it also must not be expanded twice.
    if (seen.has(addr)) return;
    seen.add(addr);
    out.path.push(addr);

    stack.push(addr);
    try {
      const alias = aliasBySource.get(addr);
      if (alias) {
        const targets = (alias.targets || []).map(normalizeAddress).filter(Boolean);
        if (targets.length === 0) out.dead.push(addr);
        for (const t of targets) walk(t, depth + 1);
        // An alias whose source is ALSO a mailbox delivers to that mailbox as well; this is how
        // `support@` can be both a shared mailbox and a fan-out to two people.
        const own = mailboxByAddress.get(addr);
        if (own) addMailbox(addr, own);
        return;
      }
      const box = mailboxByAddress.get(addr);
      if (box) {
        const forwards = (box.forwardTo || []).map(normalizeAddress).filter(Boolean);
        if (forwards.length === 0) {
          addMailbox(addr, box);
          return;
        }
        if (box.keepCopy !== false) addMailbox(addr, box);
        for (const f of forwards) walk(f, depth + 1);
        return;
      }
      // Not a local alias and not a local mailbox: an external destination, which is a legitimate
      // end state for forwarding and a suspicious one for an alias. The caller decides.
      out.external.push(addr);
    } finally {
      stack.pop();
    }
  };

  walk(address, 0);
  return out;
}

export interface LoopVerdict {
  loop: boolean;
  /** The cycle, as addresses in order, when there is one. */
  cycle: string[];
  reason: string | null;
}

/**
 * Would adding or editing this alias create a loop?
 *
 * Call this BEFORE the write, with the candidate already substituted into the graph — which is what
 * withAlias() does. Checking the graph as it stands and then writing is a race with any other admin
 * doing the same thing; the store re-runs it inside the same transaction for that reason.
 */
export function wouldCreateLoop(candidate: AliasEdge, graph: DeliveryGraph): LoopVerdict {
  const source = normalizeAddress(candidate.source);
  const targets = (candidate.targets || []).map(normalizeAddress).filter(Boolean);

  if (targets.includes(source)) {
    return { loop: true, cycle: [source, source], reason: 'The alias points at itself.' };
  }
  const merged = withAlias(graph, candidate);
  const result = expand(source, merged);
  if (result.loops.length > 0) {
    return {
      loop: true,
      cycle: result.loops[0],
      reason: 'This would create a delivery loop: ' + result.loops[0].join(' -> ') + '. Mail addressed to any address in that chain would be expanded forever.',
    };
  }
  // The other direction: something already points AT this alias, and this alias now points back
  // into the chain that reaches it. expand() from every existing source catches it.
  for (const edge of merged.aliases) {
    const r = expand(edge.source, merged);
    if (r.loops.length > 0) {
      return {
        loop: true,
        cycle: r.loops[0],
        reason: 'This would complete an existing chain into a loop: ' + r.loops[0].join(' -> ') + '.',
      };
    }
  }
  return { loop: false, cycle: [], reason: null };
}

/** The graph with `candidate` added or replacing the alias with the same source. */
export function withAlias(graph: DeliveryGraph, candidate: AliasEdge): DeliveryGraph {
  const source = normalizeAddress(candidate.source);
  return {
    ...graph,
    aliases: [...(graph.aliases || []).filter((a) => normalizeAddress(a.source) !== source), { ...candidate, source }],
  };
}

/** The graph with a mailbox's forwarding replaced, for the same pre-write check on that form. */
export function withForwarding(graph: DeliveryGraph, address: string, forwardTo: string[], keepCopy: boolean): DeliveryGraph {
  const addr = normalizeAddress(address);
  const existing = (graph.mailboxes || []).find((m) => normalizeAddress(m.address) === addr);
  const node: MailboxNode = {
    address: addr,
    status: existing?.status || 'active',
    forwardTo: forwardTo.map(normalizeAddress).filter(Boolean),
    keepCopy,
  };
  return { ...graph, mailboxes: [...(graph.mailboxes || []).filter((m) => normalizeAddress(m.address) !== addr), node] };
}

export interface AliasValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** Targets that are not mailboxes in this organization. */
  externalTargets: string[];
}

/**
 * Validate an alias against the graph and the organization's own domains.
 *
 * The brief says an alias routes to "one or more AUTHORIZED mailboxes". Enforced literally: a target
 * that is not a mailbox in this organization is refused unless the caller explicitly allows external
 * targets. An alias silently forwarding a university's admissions mail to a personal address at
 * another provider is a data-exfiltration path that looks like a typo.
 */
export function validateAlias(
  candidate: AliasEdge,
  graph: DeliveryGraph,
  opts: { orgDomains: string[]; allowExternal?: boolean } = { orgDomains: [] },
): AliasValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const source = normalizeAddress(candidate.source);
  const targets = (candidate.targets || []).map(normalizeAddress).filter(Boolean);
  const domains = (opts.orgDomains || []).map((d) => String(d).toLowerCase());

  if (!source.includes('@')) errors.push('The alias address must be a full email address.');
  if (targets.length === 0) errors.push('An alias must have at least one destination.');
  if (new Set(targets).size !== targets.length) warnings.push('The same destination is listed more than once; duplicates are ignored.');

  const sourceDomain = addressDomain(source);
  if (domains.length > 0 && sourceDomain && !domains.includes(sourceDomain)) {
    errors.push('"' + source + '" is not on a domain this organization has verified. You can only create aliases on your own domains.');
  }

  const known = new Set((graph.mailboxes || []).map((m) => normalizeAddress(m.address)));
  const aliasSources = new Set((graph.aliases || []).map((a) => normalizeAddress(a.source)));
  const externalTargets = targets.filter((t) => !known.has(t) && !aliasSources.has(t));
  if (externalTargets.length > 0 && !opts.allowExternal) {
    errors.push('These destinations are not mailboxes in this organization: ' + externalTargets.join(', ') + '. An alias may only deliver to mailboxes you administer.');
  }

  for (const t of targets) {
    const box = (graph.mailboxes || []).find((m) => normalizeAddress(m.address) === t);
    if (box && box.status !== 'active') {
      warnings.push('"' + t + '" is a mailbox that is ' + box.status + ', so mail routed to it will not be delivered.');
    }
  }

  const loop = wouldCreateLoop({ ...candidate, source, targets }, graph);
  if (loop.loop) errors.push(loop.reason || 'This alias would create a delivery loop.');

  return { ok: errors.length === 0, errors, warnings, externalTargets };
}
