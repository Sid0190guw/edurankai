// src/lib/knowledge-acquisition/source-trust.ts — Block 08: the "Rank Reliability", "Filter",
// and "Cross Verification" stages. Pure and deterministic (no I/O, clock is injectable).
import type { SourceRecord, ScoredSource, FilterPolicy, Claim, VerificationResult } from './types';

const TYPE_WEIGHT: Record<string, number> = {
  peer_reviewed: 1.00, standards_body: 0.95, textbook: 0.92, gov: 0.88, edu: 0.82,
  reference_encyclopedia: 0.72, org: 0.60, news: 0.45, blog: 0.25, forum: 0.15, unknown: 0.10,
};
const TIER_WEIGHT: Record<number, number> = { 1: 1.0, 2: 0.8, 3: 0.55, 4: 0.3 };
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// Subject-aware half-life (years) — older physics/maths stays valid; tech/current-affairs decays fast.
const HALF_LIFE_YEARS: Record<string, number> = {
  mathematics: 40, physics: 25, chemistry: 20, biology: 12,
  'computer-science': 6, medicine: 5, technology: 4, 'current-affairs': 1, default: 12,
};

export function domainFamily(domain: string): string {
  const d = (domain || '').toLowerCase().trim();
  return d in HALF_LIFE_YEARS ? d : 'default';
}

export function recencyScore(publishedAt: string | null | undefined, family: string, now: Date): number {
  if (!publishedAt) return 0.5;                          // unknown date = neutral, not penalised
  const t = Date.parse(publishedAt);
  if (Number.isNaN(t)) return 0.5;
  const ageYears = Math.max(0, (now.getTime() - t) / (365.25 * 864e5));
  const hl = HALF_LIFE_YEARS[family] ?? HALF_LIFE_YEARS.default;
  return clamp01(Math.pow(0.5, ageYears / hl));
}

/** Deterministic reliability in [0,1]. Weighted blend of source type, domain tier, recency, and
 *  authority, discounted for plain HTTP. */
export function scoreSource(s: SourceRecord, family = 'default', now = new Date()): number {
  const type = TYPE_WEIGHT[s.sourceType] ?? TYPE_WEIGHT.unknown;
  const tier = s.domainTier ? (TIER_WEIGHT[s.domainTier] ?? 0.3) : 0.5;   // unknown tier = neutral
  const recency = recencyScore(s.publishedAt, family, now);
  const authority =
    (s.hasAuthor ? 0.5 : 0) +
    (s.citationCount && s.citationCount > 0 ? Math.min(0.5, s.citationCount / 40) : 0);
  const httpsPenalty = s.https ? 1 : 0.6;
  const base = 0.45 * type + 0.30 * tier + 0.15 * recency + 0.10 * authority;
  return clamp01(base * httpsPenalty);
}

/** Score a batch (convenience) with a shared clock. */
export function scoreSources(sources: SourceRecord[], family = 'default', now = new Date()): ScoredSource[] {
  return sources.map((s) => ({ ...s, reliability: scoreSource(s, family, now) }));
}

export function defaultFilterPolicy(over: Partial<FilterPolicy> = {}): FilterPolicy {
  return {
    minReliability: 0.55, requireAllowlist: true,
    allowDomains: new Set(), denyDomains: new Set(), maxSources: 8, ...over,
  };
}

/** The "Filter Sources" stage: deny wins, then (optional) allowlist, then reliability floor,
 *  sorted best-first and capped. */
export function filterSources(scored: ScoredSource[], p: FilterPolicy): ScoredSource[] {
  return scored
    .filter((s) => !p.denyDomains.has(s.domain))
    .filter((s) => !p.requireAllowlist || p.allowDomains.has(s.domain))
    .filter((s) => s.reliability >= p.minReliability)
    .sort((a, b) => b.reliability - a.reliability)
    .slice(0, p.maxSources);
}

/** The "Cross Verification" stage. A claim is corroborated only when supported by
 *  >= minIndependentDomains distinct domains, at least one clearing minClaimTrust. */
export function crossVerify(
  claims: Claim[], sources: ScoredSource[],
  minIndependentDomains = 2, minClaimTrust = 0.55,
): VerificationResult {
  const verified = claims.map((c) => {
    const supp = c.supportIdx.map((i) => sources[i]).filter(Boolean);   // guard bad indexes
    const domains = new Set(supp.map((s) => s.domain));
    const supportTrust = supp.reduce((a, s) => a + s.reliability, 0);
    const corroborated = domains.size >= minIndependentDomains && supp.some((s) => s.reliability >= minClaimTrust);
    return { ...c, independentDomains: domains.size, supportTrust, corroborated };
  });
  const corr = verified.filter((v) => v.corroborated);
  const consensusScore = verified.length ? corr.length / verified.length : 0;
  return { claims: verified, consensusScore, corroboratedCount: corr.length, passed: corr.length > 0 && consensusScore >= 0.5 };
}
