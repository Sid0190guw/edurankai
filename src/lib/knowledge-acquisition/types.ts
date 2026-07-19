// src/lib/knowledge-acquisition/types.ts — Block 08: shared types + the source-search port.
import { z } from 'zod';

export type SourceType =
  | 'peer_reviewed' | 'standards_body' | 'textbook' | 'gov' | 'edu'
  | 'reference_encyclopedia' | 'org' | 'news' | 'blog' | 'forum' | 'unknown';

export interface SourceRecord {
  url: string; domain: string; title?: string;
  sourceType: SourceType; domainTier?: 1 | 2 | 3 | 4;
  publishedAt?: string | null; fetchedAt: string;
  hasAuthor: boolean; citationCount?: number; https: boolean;
  excerpt: string;
}
export interface ScoredSource extends SourceRecord { reliability: number; }

export type RunStatus =
  | 'queued' | 'classifying' | 'searching' | 'verifying'
  | 'extracting' | 'drafted' | 'pending_review'
  | 'approved' | 'rejected' | 'failed';

export interface Claim { text: string; supportIdx: number[]; }
export interface VerifiedClaim extends Claim { independentDomains: number; supportTrust: number; corroborated: boolean; }
export interface VerificationResult {
  claims: VerifiedClaim[];
  consensusScore: number; corroboratedCount: number; passed: boolean;
}

export interface FilterPolicy {
  minReliability: number;      // default 0.55
  requireAllowlist: boolean;   // default true — only registry listing='allow' domains survive
  allowDomains: Set<string>;
  denyDomains: Set<string>;    // listing='deny' always wins
  maxSources: number;          // default 8
}

/** The "Search Trusted Sources" port. Default NullSourceSearch returns nothing (no built-in crawler). */
export interface SourceSearchProvider {
  search(query: string, subject: string, domain: string, limit: number): Promise<SourceRecord[]>;
}
export const NullSourceSearch: SourceSearchProvider = {
  async search() { return []; },
};

// ---- provenance stamped on every candidate object (metadata.acquisition) ----
export interface AcquisitionProvenance {
  runId: string;
  query: string;
  subject: string;
  domain: string;
  model: string;
  consensusScore: number;
  sources: { url: string; domain: string; reliability: number }[];
  extractedAt: string;
  pending: boolean;
}
export const ProvenanceSchema = z.object({
  runId: z.string().uuid(),
  query: z.string().min(1).max(2000),
  subject: z.string().max(80),
  domain: z.string().max(80),
  model: z.string().max(120),
  consensusScore: z.number().min(0).max(1),
  sources: z.array(z.object({
    url: z.string().url().max(2000), domain: z.string().max(255), reliability: z.number().min(0).max(1),
  })).max(50),
  extractedAt: z.string(),
  pending: z.boolean(),
});
