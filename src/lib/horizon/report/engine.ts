// src/lib/horizon/report/engine.ts — ONE CODE PATH FOR ALL NINE REPORTS.
//
// The order of the steps below is the whole design, and none of them may be reordered:
//
//   1. resolve the definition        a report id nobody declared does not exist
//   2. resolve the subject           a name and a real row, or the run stops here
//   3. DECIDE ACCESS                 before a single record is read, not after
//   4. load sources                  facts, derived measures, recorded feedback and decisions
//   5. read the boundary             recommendations and decisions already stored by people
//   6. interpret                     the only step that adds a machine opinion
//   7. screen every claim            provenance, forbidden subjects, confidence ceilings
//   8. redact                        what this viewer specifically may not see
//   9. assemble, persist, audit      in that order, and a persist failure does not lose the document
//
// STEP 3 SITS WHERE IT DOES ON PURPOSE. Generating first and filtering afterwards is the pattern that
// puts somebody's performance record into a serverless function's memory, and then into a log line,
// for a viewer who was never allowed to see it. Nothing is read until it is established that this
// person may read it.
//
// STEP 7 IS NOT A FORMALITY. Every claim from every provider and from the interpreter goes through
// validateClaim(). A claim that fails is DROPPED and the drop is recorded in the document's
// integrity block. It is never printed unvalidated and it never fails the whole report: a report
// missing one metric is useful, a report with one unsourced sentence in it is not trustworthy
// anywhere.
import { logAudit } from '@/lib/audit';
import { decisionsFor, recommendationsFor, type ConsequentialDecision } from '@/lib/ai-boundary';
import { screenTerminology } from '@/lib/horizon/contracts';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { dbReason, toRows, uuidish } from '@/lib/page-safety';
import { decideAccess, type AccessDecision } from './access';
import { deterministicInterpreter } from './interpret';
import { EVIDENCE_WEIGHT, SECTION_DESCRIPTIONS, SECTION_TITLES } from './types';
import {
  capConfidence, engineStamp, evidenceRef, humanDecisionClaim, screenClaims, sourceRef,
} from './provenance';
import { ORGANISATION_SUBJECT_ID, reportDefinition } from './registry';
import { registerBuiltInProviders } from './providers';
import { planSources, runSource } from './sources';
import { recordRun } from './runs';
import { ADVISORY_NOTICE } from './version';
import type {
  AiInterpretationClaim, Claim, DerivedClaim, DocumentCoverage, DocumentIntegrity, EngineStamp,
  FactClaim, GenerateOptions, GenerateResult, HumanDecisionClaim, HumanFeedbackClaim, Interpreter,
  RecommendationClaim, ReportDefinition, ReportDocument, ReportSection, ReportSubject, SectionKind,
} from './types';

// =================================================================================================
// SUBJECT RESOLUTION
// =================================================================================================

async function resolveSubject(
  definition: ReportDefinition,
  subjectId: string,
): Promise<{ subject: ReportSubject | null; error: string | null }> {
  if (definition.subjectKind === 'organisation') {
    // No row to point at, so a sentinel rather than an empty string — an accidental blank must never
    // resolve to the most disclosive subject there is.
    return {
      subject: {
        kind: 'organisation',
        id: ORGANISATION_SUBJECT_ID,
        displayName: 'The organisation',
        ref: { employeeId: null, applicationId: null, userId: null },
      },
      error: null,
    };
  }

  const id = uuidish(subjectId);
  if (!id) return { subject: null, error: 'That is not a valid identifier for a report subject.' };

  try {
    if (definition.subjectKind === 'applicant') {
      const rows = toRows(await db.execute(sql`
        SELECT a.id::text AS id, p.display_name
          FROM tal_application a
          JOIN tal_person p ON p.id = a.person_id
         WHERE a.id = ${id}::uuid
         LIMIT 1`));
      const r: any = rows[0];
      if (!r) return { subject: null, error: 'No application exists with that identifier.' };
      return {
        subject: {
          kind: 'applicant',
          id: String(r.id),
          displayName: String(r.display_name || 'An applicant'),
          ref: { employeeId: null, applicationId: String(r.id), userId: null },
        },
        error: null,
      };
    }

    // employee and manager both resolve against hr_employees. They differ in what the report asks
    // for, not in what the subject is.
    const rows = toRows(await db.execute(sql`
      SELECT id::text AS id, full_name, user_id::text AS user_id
        FROM hr_employees
       WHERE id = ${id}::uuid
       LIMIT 1`));
    const r: any = rows[0];
    if (!r) return { subject: null, error: 'No employment record exists with that identifier.' };
    return {
      subject: {
        kind: definition.subjectKind,
        id: String(r.id),
        displayName: String(r.full_name || 'An employee'),
        ref: {
          employeeId: String(r.id),
          applicationId: null,
          userId: r.user_id ? String(r.user_id) : null,
        },
      },
      error: null,
    };
  } catch (e: any) {
    return { subject: null, error: dbReason(e) };
  }
}

// =================================================================================================
// WINDOW
// =================================================================================================

/** Calendar dates, inclusive, in the ISO form every provider's SQL casts to ::date. */
function windowFor(definition: ReportDefinition, now: Date): { from: string; to: string } | null {
  if (!definition.windowDays) return null;
  const to = new Date(now.getTime());
  const from = new Date(now.getTime() - definition.windowDays * 24 * 60 * 60 * 1000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

// =================================================================================================
// NEUTRAL TERMINOLOGY — THE SHARED RULE, APPLIED RATHER THAN REIMPLEMENTED
// =================================================================================================
//
// screenTerminology() belongs to src/lib/horizon/contracts.ts and carries the canonical list for the
// whole HORIZON system. This walks the readable strings of a claim through it. Nothing else in this
// patch keeps a copy of that vocabulary; provenance.ts says so out loud where its own list would
// otherwise have grown one.
//
// The replacement is per-string and total: a string naming a birth-based method becomes NEUTRAL_TERM
// in full rather than having the word cut out of it, which is their choice and the safer one — a
// sentence with a word removed can read as an accusation with a gap in it.
function clean(value: string): string {
  const checked = screenTerminology(value);
  return checked.clean ? value : checked.text;
}

function neutraliseTerminology<T extends Claim>(claim: T): T {
  const next: any = { ...claim, statement: clean(claim.statement) };
  switch (claim.kind) {
    case 'facts':
      next.label = clean(claim.label); next.value = clean(claim.value); break;
    case 'derived':
      next.label = clean(claim.label); next.method = clean(claim.method);
      if (typeof claim.value === 'string') next.value = clean(claim.value);
      break;
    case 'human_feedback':
      next.theme = clean(claim.theme); next.body = clean(claim.body); break;
    case 'ai_interpretation':
      next.reasoning = clean(claim.reasoning);
      next.assumptions = clean(claim.assumptions);
      next.uncertainty = clean(claim.uncertainty);
      break;
    case 'recommendation':
      next.suggestedAction = clean(claim.suggestedAction); break;
    case 'human_decision':
      next.decision = clean(claim.decision);
      if (claim.overrideReason) next.overrideReason = clean(claim.overrideReason);
      break;
  }
  return next as T;
}

// =================================================================================================
// REDACTION
// =================================================================================================

const WITHHELD = '(withheld at your permission level)';

/**
 * Strip record pointers while leaving every statement, confidence and explanation intact.
 *
 * The policy is stated in access.ts: identifiers are withheld, explanations are not. What actually
 * has to go is the material that lets somebody navigate to OTHER people's rows — relation names and
 * primary keys. A claim keeps its label, its value, its method, its reasoning and its confidence,
 * because a conclusion about a person with the reasoning removed is precisely the unexplained
 * assertion this engine exists to prevent.
 */
function withholdIdentifiers<T extends Claim>(claim: T): T {
  const provenance = {
    ...claim.provenance,
    sources: claim.provenance.sources.map((s) => ({
      ...s,
      table: WITHHELD,
      recordId: null,
    })),
    evidence: claim.provenance.evidence.map((e) => ({
      ...e,
      // The label survives — "Review for H1 2026" is the part a reader needs. The ref is the part
      // that is a key into somebody's table.
      ref: WITHHELD,
      url: null,
    })),
  };
  return { ...claim, provenance };
}

/** Remove the name from a feedback claim, keeping the relation and every word of the content. */
function anonymiseAuthor(claim: HumanFeedbackClaim): HumanFeedbackClaim {
  return {
    ...claim,
    author: { id: null, name: 'A colleague', relation: claim.author.relation },
    statement: 'A colleague (' + claim.author.relation + ') on ' + claim.theme,
  };
}

// =================================================================================================
// INFERENCE-ONLY PROVIDERS
// =================================================================================================

/**
 * Cap every claim from a provider that declared itself inference-only.
 *
 * The programme rule is that demonstrated job-related evidence outweighs anything inferred. A
 * provider this patch did not write cannot be trusted to apply that to itself, so it is applied to
 * the provider: whatever section its claims land in, their confidence is capped at the interpretation
 * tier and the cap says so in the basis. The claim still appears; it simply cannot outrank a record.
 */
function capInferredClaim<T extends Claim>(claim: T): T {
  const ceiling = EVIDENCE_WEIGHT.ai_interpretation;
  return {
    ...claim,
    provenance: {
      ...claim.provenance,
      confidence: capConfidence(
        claim.provenance.confidence.level === 'observed'
          // An inference-only provider may not report anything as `observed`. It did not observe it.
          ? { level: 'moderate', score: ceiling, basis: claim.provenance.confidence.basis }
          : claim.provenance.confidence,
        ceiling,
      ),
    },
  } as T;
}

// =================================================================================================
// SECTION ASSEMBLY
// =================================================================================================

function sectionOf<K extends SectionKind>(
  kind: K,
  claims: ReportSection<K>['claims'],
  coverage: ReportSection<K>['coverage'],
  redactions: { section: SectionKind; reason: string }[],
): ReportSection<K> {
  const mine = redactions.filter((r) => r.section === kind);
  return {
    kind,
    title: SECTION_TITLES[kind],
    description: SECTION_DESCRIPTIONS[kind],
    claims,
    coverage,
    redacted: mine.length > 0,
    redactionReason: mine.length ? mine.map((r) => r.reason).join(' ') : null,
  };
}

// =================================================================================================
// THE ENTRY POINT
// =================================================================================================

export async function generateReport(
  options: GenerateOptions,
  opts: { locals?: any } = {},
): Promise<GenerateResult> {
  const nowDate = new Date();
  const now = nowDate.toISOString();

  // ---- 1. DEFINITION -------------------------------------------------------------------------
  const definition = reportDefinition(options.reportId);
  if (!definition) {
    return { ok: false, runId: null, document: null, error: 'There is no report with that identifier.' };
  }

  // ---- 2. SUBJECT ----------------------------------------------------------------------------
  const resolved = await resolveSubject(definition, options.subjectId);
  if (!resolved.subject) {
    return { ok: false, runId: null, document: null, error: resolved.error || 'The subject could not be resolved.' };
  }
  const subject = resolved.subject;

  // ---- 3. ACCESS, BEFORE ANY RECORD IS READ ---------------------------------------------------
  const access: AccessDecision = await decideAccess(definition, subject, options.viewer, { locals: opts.locals });
  if (!access.allowed) {
    // A REFUSED READ IS STILL A READ ATTEMPT AND IT IS LOGGED. Who tried to open whose report is
    // exactly the question an audit of this system would ask first.
    await logAudit({
      userId: options.viewer.id,
      action: 'intelligence_report.denied',
      entity: 'horizon_report',
      entityId: definition.id,
      diff: { subjectKind: subject.kind, subjectId: subject.id, reason: access.reason },
    });
    return { ok: false, runId: null, document: null, error: access.reason, denied: true };
  }

  const interpreter: Interpreter = options.interpreter || deterministicInterpreter;
  const stamp: EngineStamp = engineStamp(interpreter);
  const window = windowFor(definition, nowDate);

  // ---- 4. SOURCES ----------------------------------------------------------------------------
  registerBuiltInProviders();
  const plan = planSources(definition.requires);

  const facts: FactClaim[] = [];
  const derived: DerivedClaim[] = [];
  const humanFeedback: HumanFeedbackClaim[] = [];
  const humanDecisions: HumanDecisionClaim[] = [];
  // Interpretation and recommendation that OTHER patches produced and labelled, relayed through the
  // master-record adapter. Kept separate from this engine's own all the way to assembly, so the
  // interpreter is never handed another patch's conclusions as if they were input facts.
  const upstreamInterpretation: AiInterpretationClaim[] = [];
  const upstreamRecommendation: RecommendationClaim[] = [];
  const notes: string[] = [];
  const satisfied: string[] = [];
  const missing = plan.missing.slice();

  // SEQUENTIAL, DELIBERATELY. The postgres-js pool on this deployment is max:1 per instance, so
  // Promise.all over these loads would not overlap a single round trip — it would queue them behind
  // one connection while holding every provider's memory live at once. See the pool comment in
  // src/lib/db/index.ts for why max:1 is what bounds pooler usage here.
  for (const run of plan.runs) {
    const load = await runSource(run.provider, {
      subject, definition, window, now, stamp,
      viewer: access.viewer,
      capabilities: run.capabilities,
    });
    if (!load.ok || load.error) {
      for (const cap of run.capabilities) {
        missing.push({
          capability: cap,
          reason: 'The source for this failed: ' + (load.error || 'no reason given') + '.',
        });
      }
      continue;
    }
    satisfied.push(...run.capabilities);

    const inferred = run.provider.descriptor.inferenceOnly === true;
    const take = <T extends Claim>(list: T[]): T[] => (inferred ? list.map(capInferredClaim) : list);

    facts.push(...take(load.facts));
    derived.push(...take(load.derived));
    humanFeedback.push(...take(load.humanFeedback));
    if (load.humanDecisions) humanDecisions.push(...load.humanDecisions);
    if (load.upstreamInterpretation) upstreamInterpretation.push(...take(load.upstreamInterpretation));
    if (load.upstreamRecommendation) upstreamRecommendation.push(...take(load.upstreamRecommendation));
    for (const n of load.notes) notes.push(run.provider.descriptor.label + ': ' + n);
  }

  // ---- 5. THE BOUNDARY -----------------------------------------------------------------------
  //
  // Recommendations and decisions already stored by ai-boundary. Read even when the report declares
  // no decision context, because section 6 is about what people decided regardless of whether this
  // particular report was written to inform it.
  let boundaryRecommendations: Awaited<ReturnType<typeof recommendationsFor>> = [];
  try {
    boundaryRecommendations = await recommendationsFor(
      subject.ref,
      (definition.decisionContext || null) as ConsequentialDecision | null,
      20,
    );
  } catch (e: any) {
    notes.push('Stored recommendations could not be read: ' + dbReason(e) + '.');
  }

  try {
    const recorded = await decisionsFor(subject.ref, 25);
    for (const d of recorded) {
      humanDecisions.push(humanDecisionClaim({
        decidedByUserId: d.decidedByUserId,
        // ai_human_decisions stores the decider's id, not their name. Resolving it to a name would
        // be one extra round trip per decision on a page that already makes several; the id is shown
        // and the surface that owns people can resolve it.
        decidedByName: 'User ' + d.decidedByUserId.slice(0, 8),
        decidedAt: d.decidedAt,
        decision: d.decision,
        decisionKind: d.decisionKind,
        followedRecommendation: d.followedRecommendation,
        overrideReason: d.overrideReason,
        recommendationId: d.recommendationId,
        now, stamp,
        sources: [sourceRef({
          provider: 'ai_boundary', system: 'ai_boundary', table: 'ai_human_decisions',
          ownedBy: 'src/lib/ai-boundary.ts', recordId: d.id, capturedAt: d.decidedAt,
        })],
        evidence: [evidenceRef('human_decision', d.id, 'Decision recorded in ' + d.sourceModule)],
      }));
    }
  } catch (e: any) {
    notes.push('Recorded human decisions could not be read: ' + dbReason(e) + '.');
  }

  // ---- 6. INTERPRETATION ---------------------------------------------------------------------
  let interpretation: AiInterpretationClaim[] = [];
  let recommendations: RecommendationClaim[] = [];
  try {
    const result = await interpreter.interpret({
      definition, subject, facts, derived, humanFeedback, boundaryRecommendations, stamp, now,
    });
    if (result.ok) {
      interpretation = result.interpretation;
      recommendations = result.recommendations;
    } else {
      notes.push('The interpreter declined to run: ' + (result.error || 'no reason given') + '.');
    }
    for (const n of result.notes) notes.push(n);
  } catch (e: any) {
    // AN INTERPRETER THAT THROWS LEAVES A DOCUMENT WITH SECTIONS 1-3 AND 6, WHICH IS STILL A USEFUL
    // AND HONEST DOCUMENT. Sections 4 and 5 are the ones that carry machine opinion; losing them
    // loses the least trustworthy part of the report, and saying so is better than a 500.
    notes.push('The interpretation step failed and sections four and five are empty: ' + String(e?.message || e) + '.');
  }

  // ---- 7. SCREENING --------------------------------------------------------------------------
  //
  // Terminology is neutralised BEFORE validation, not after. src/lib/horizon/contracts.ts owns the
  // rule that a birth-based method is never named in copy a person reads, and its screenTerminology()
  // REPLACES the term rather than dropping the claim — which is the right behaviour for a system
  // that permits the underlying computation to exist while forbidding its vocabulary. Running it
  // first means validateClaim() never sees a term the shared rule would already have handled, and
  // this engine keeps only the stricter health and protected-attribute refusal of its own.
  const screenedFacts = screenClaims(facts.map(neutraliseTerminology));
  const screenedDerived = screenClaims(derived.map(neutraliseTerminology));
  const screenedFeedback = screenClaims(humanFeedback.map(neutraliseTerminology));
  const screenedInterpretation = screenClaims(
    [...upstreamInterpretation, ...interpretation].map(neutraliseTerminology),
  );
  const screenedRecommendations = screenClaims(
    [...upstreamRecommendation, ...recommendations].map(neutraliseTerminology),
  );
  const screenedDecisions = screenClaims(humanDecisions.map(neutraliseTerminology));

  const rejected = [
    ...screenedFacts.rejected, ...screenedDerived.rejected, ...screenedFeedback.rejected,
    ...screenedInterpretation.rejected, ...screenedRecommendations.rejected, ...screenedDecisions.rejected,
  ];

  // ---- 8. REDACTION --------------------------------------------------------------------------
  const hide = !access.viewer.canSeeInternals;
  const anon = access.anonymiseFeedbackAuthors;

  const finalFacts = hide ? screenedFacts.kept.map(withholdIdentifiers) : screenedFacts.kept;
  const finalDerived = hide ? screenedDerived.kept.map(withholdIdentifiers) : screenedDerived.kept;
  let finalFeedback = anon ? screenedFeedback.kept.map(anonymiseAuthor) : screenedFeedback.kept;
  if (hide) finalFeedback = finalFeedback.map(withholdIdentifiers);
  const finalInterpretation = hide ? screenedInterpretation.kept.map(withholdIdentifiers) : screenedInterpretation.kept;
  const finalRecommendations = hide ? screenedRecommendations.kept.map(withholdIdentifiers) : screenedRecommendations.kept;
  const finalDecisions = hide ? screenedDecisions.kept.map(withholdIdentifiers) : screenedDecisions.kept;

  // ---- 9. ASSEMBLY ---------------------------------------------------------------------------
  const uniqueSatisfied = Array.from(new Set(satisfied)).sort();
  const coverage: DocumentCoverage = {
    satisfied: uniqueSatisfied,
    missing,
    complete: missing.length === 0,
  };

  /** Per-section coverage: only the capabilities that feed that section. */
  const coverageFor = (caps: string[]) => ({
    requested: caps,
    satisfied: caps.filter((c) => uniqueSatisfied.indexOf(c) >= 0),
    missing: missing.filter((m) => caps.indexOf(m.capability) >= 0),
  });

  const allCaps = definition.requires.slice();
  const claimCount =
    finalFacts.length + finalDerived.length + finalFeedback.length
    + finalInterpretation.length + finalRecommendations.length + finalDecisions.length;
  const majorClaimCount = [
    ...finalFacts, ...finalDerived, ...finalFeedback,
    ...finalInterpretation, ...finalRecommendations, ...finalDecisions,
  ].filter((c) => c.major === true).length;

  let ceiling = 0;
  for (const c of finalInterpretation) {
    const s = c.provenance.confidence.score;
    if (typeof s === 'number' && s > ceiling) ceiling = s;
  }

  const integrity: DocumentIntegrity = {
    claimCount,
    majorClaimCount,
    rejected,
    confidenceCeiling: Number(ceiling.toFixed(2)),
  };

  const document: ReportDocument = {
    reportId: definition.id,
    title: definition.title,
    purpose: definition.purpose,
    subject,
    audience: definition.audience,
    sections: {
      facts: sectionOf('facts', finalFacts, coverageFor(allCaps), access.redactions),
      derived: sectionOf('derived', finalDerived, coverageFor(allCaps), access.redactions),
      human_feedback: sectionOf('human_feedback', finalFeedback, coverageFor(allCaps), access.redactions),
      // Sections 4-6 are not fed by capabilities; their coverage is empty rather than misleading.
      ai_interpretation: sectionOf('ai_interpretation', finalInterpretation, coverageFor([]), access.redactions),
      recommendation: sectionOf('recommendation', finalRecommendations, coverageFor([]), access.redactions),
      human_decision: sectionOf('human_decision', finalDecisions, coverageFor([]), access.redactions),
    },
    coverage,
    integrity,
    stamp,
    generatedAt: now,
    generatedForUserId: options.viewer.id,
    notice: ADVISORY_NOTICE,
    redactions: access.redactions,
  };

  // Provider notes ride in the coverage block rather than in a section, because they are statements
  // about the RUN and not claims about the subject. Putting them in a section would be the first
  // blur: a sentence with no provenance sitting beside sentences that all have one.
  for (const n of notes) {
    if (!coverage.missing.some((m) => m.reason === n)) coverage.missing.push({ capability: 'note', reason: n });
  }

  // ---- PERSIST AND AUDIT ----------------------------------------------------------------------
  let runId: string | null = null;
  if (options.persist !== false) {
    const stored = await recordRun({ document, access });
    runId = stored.id;
    if (stored.error) {
      coverage.missing.push({
        capability: 'audit_trail',
        reason: 'This document was shown but could not be recorded: ' + stored.error + '.',
      });
    }
  }

  await logAudit({
    userId: options.viewer.id,
    action: 'intelligence_report.generate',
    entity: 'hzn_report_run',
    entityId: runId || definition.id,
    diff: {
      reportId: definition.id,
      subjectKind: subject.kind,
      subjectId: subject.id,
      accessBasis: access.basis,
      engine: stamp.engineId + '@' + stamp.engineVersion,
      interpreter: stamp.interpreterId + '@' + stamp.interpreterVersion,
      claims: claimCount,
      rejected: rejected.length,
    },
  });

  return { ok: true, runId, document, error: null };
}
