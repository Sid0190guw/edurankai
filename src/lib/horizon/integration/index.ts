// src/lib/horizon/integration/index.ts — THE ONE CALL A SURFACE MAKES.
//
// A page asks one question and gets one answer that already knows how to describe its own failure.
// Nothing that renders the report needs to know whether the filesystem was readable, whether Patch
// 19's probe loaded, or what to print when neither is true.

import { buildReport, type IntegrationReport } from './assess';
import { collectEvidence, nodeSourceReader, unreadableEvidence } from './collect';

export * from './map';
export * from './concepts';
export * from './assess';
export {
  collectEvidence,
  nodeSourceReader,
  unreadableEvidence,
  tablesDeclaredIn,
  hasRuntimeCode,
  scanUnterminatedStrings,
  importSpecifiersOf,
  exactSpecifiersFor,
  type SourceReader,
} from './collect';

/**
 * Assess the integration state of the HORIZON build.
 *
 * NEVER THROWS, AND NEVER REPORTS ABSENCE IT CANNOT PROVE. A serverless bundle does not ship src/ as
 * readable files, so the same code that reports honestly in CI would, in production, find nothing
 * and conclude that twenty-one patches do not exist. The catch below turns that into `verdict:
 * 'unknown'` with the reason attached — the precedent src/lib/evidence-graph.ts set by printing
 * EVIDENCE UNREADABLE rather than an empty chain it could not read.
 *
 * `nowIso` is injected so two runs over the same tree produce the same report.
 */
export async function horizonIntegrationReport(
  nowIso: string = new Date().toISOString(),
): Promise<IntegrationReport> {
  try {
    const reader = await nodeSourceReader();
    // Prove the reader actually works before trusting an empty result from it. A reader that returns
    // [] for every directory looks identical to a repository with no HORIZON code in it.
    const probeFiles = reader.filesUnder('src/lib/horizon');
    if (probeFiles.length === 0) {
      return buildReport(unreadableEvidence(
        'The source tree is not readable from this process. This is expected in a deployed serverless '
        + 'function, which does not ship src/ as files. Run `node scripts/horizon-check.mjs` in a '
        + 'checkout or in CI to get a real assessment.',
        nowIso,
      ));
    }
    return buildReport(collectEvidence(reader, nowIso));
  } catch (e: any) {
    return buildReport(unreadableEvidence(
      'The source tree could not be read: ' + (e?.cause?.message || e?.message || String(e)),
      nowIso,
    ));
  }
}
