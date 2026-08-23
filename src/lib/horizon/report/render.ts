// src/lib/horizon/report/render.ts — THE DOCUMENT AS HTML, RENDERED ON THE SERVER.
//
// WHY A STRING RENDERER RATHER THAN COMPONENTS.
//
// Three surfaces show these documents: the console, the run detail page, and anything that later
// wants a print or export view. A renderer they share is the only way the advisory notice, the
// section boundaries and the provenance blocks cannot drift apart between them — and drifting apart
// is the specific failure that matters here, because a reader who sees an unlabelled section on one
// screen learns that the labels elsewhere are decoration.
//
// It also keeps the whole thing out of `.astro` expression syntax, which on this project cannot
// carry a bare `<` inside a JSX expression and has taken pages down for less.
//
// NO CLIENT JAVASCRIPT. Nothing here emits a script tag, a handler or a fetch. A report is a
// document; it does not need to be an application, and a page that renders somebody's professional
// record should have as little running on it as possible.
//
// THE SIX SECTIONS ARE ALWAYS ALL RENDERED, INCLUDING THE EMPTY ONES. An empty section says "nothing
// was found here"; a missing section says nothing at all, and a reader cannot tell the second from a
// report that never had that section. Each empty one states why it is empty.
import {
  CONFIDENCE_LABELS, SECTION_ORDER,
  type Claim, type Provenance, type ReportDocument, type ReportSection, type SectionKind,
} from './types';

export function escapeHtml(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return 'not recorded';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

/**
 * The provenance block. Rendered under every claim, not just the interesting ones.
 *
 * It is a `<details>` so a document with sixty claims is readable, and it is CLOSED by default for
 * ordinary claims and OPEN for major ones — the conclusions somebody might act on show their working
 * without anybody having to click.
 */
function renderProvenance(p: Provenance, major: boolean): string {
  const conf = p.confidence;
  const score = typeof conf.score === 'number' ? ' (' + conf.score.toFixed(2) + ')' : '';
  const sources = p.sources.map((s) =>
    '<li><span class="hzn-k">' + escapeHtml(s.system) + '</span> · '
    + escapeHtml(s.table)
    + (s.recordId ? ' · row ' + escapeHtml(s.recordId) : '')
    + '<br><span class="hzn-muted">owned by ' + escapeHtml(s.ownedBy) + '</span></li>').join('');
  const evidence = p.evidence.length
    ? p.evidence.map((e) =>
      '<li><span class="hzn-k">' + escapeHtml(e.kind) + '</span> · ' + escapeHtml(e.label)
      + ' · <span class="hzn-muted">' + escapeHtml(e.ref) + '</span></li>').join('')
    : '<li class="hzn-muted">No record pointer is attached to this claim.</li>';

  const engine = p.engine;
  const model = engine.model
    ? escapeHtml(engine.model.name) + ' ' + escapeHtml(engine.model.version)
      + ' <span class="hzn-muted">(' + escapeHtml(engine.model.provider === 'first_party'
        ? 'computed here; no data left this system' : 'external connector') + ')</span>'
    : '<span class="hzn-muted">no interpreter involved in this claim</span>';

  return ''
    + '<details class="hzn-prov"' + (major ? ' open' : '') + '>'
    + '<summary>'
    + '<span class="hzn-conf hzn-conf-' + escapeHtml(conf.level) + '">'
    + escapeHtml(CONFIDENCE_LABELS[conf.level]) + score + '</span>'
    + '<span class="hzn-muted"> — evidence, source and version</span>'
    + '</summary>'
    + '<div class="hzn-prov-body">'
    + '<p class="hzn-basis">' + escapeHtml(conf.basis) + '</p>'
    + '<div class="hzn-prov-grid">'
    + '<div><h5>Evidence</h5><ul>' + evidence + '</ul></div>'
    + '<div><h5>Source</h5><ul>' + sources + '</ul></div>'
    + '</div>'
    + '<p class="hzn-stamp">Generated ' + escapeHtml(fmtDate(p.generatedAt))
    + ' &middot; engine ' + escapeHtml(engine.engineId) + ' ' + escapeHtml(engine.engineVersion)
    + (engine.interpreterId
      ? ' &middot; interpreter ' + escapeHtml(engine.interpreterId) + ' ' + escapeHtml(engine.interpreterVersion || '')
      : '')
    + ' &middot; model ' + model
    + '</p>'
    + '</div>'
    + '</details>';
}

/** The body of one claim, which differs per section — that is the whole point of the six types. */
function renderClaimBody(claim: Claim): string {
  switch (claim.kind) {
    case 'facts':
      return '<p class="hzn-claim-line"><span class="hzn-label">' + escapeHtml(claim.label) + '</span>'
        + '<span class="hzn-value">' + escapeHtml(claim.value) + '</span></p>'
        + (claim.occurredAt ? '<p class="hzn-muted">Occurred ' + escapeHtml(fmtDate(claim.occurredAt)) + '</p>' : '');

    case 'derived':
      return '<p class="hzn-claim-line"><span class="hzn-label">' + escapeHtml(claim.label) + '</span>'
        + '<span class="hzn-value">' + escapeHtml(String(claim.value))
        + (claim.unit ? ' <span class="hzn-unit">' + escapeHtml(claim.unit) + '</span>' : '') + '</span></p>'
        + '<p class="hzn-method"><strong>How:</strong> ' + escapeHtml(claim.method) + '</p>'
        + '<p class="hzn-muted">Counted ' + escapeHtml(String(claim.basisCount)) + ' record'
        + (claim.basisCount === 1 ? '' : 's')
        + (claim.window ? ' between ' + escapeHtml(claim.window.from) + ' and ' + escapeHtml(claim.window.to) : '')
        + '.</p>';

    case 'human_feedback':
      return '<p class="hzn-claim-line"><span class="hzn-label">' + escapeHtml(claim.author.name)
        + ' <span class="hzn-muted">(' + escapeHtml(claim.author.relation) + ')</span></span>'
        + '<span class="hzn-value">' + escapeHtml(claim.theme) + '</span></p>'
        + '<blockquote class="hzn-quote">' + escapeHtml(claim.body) + '</blockquote>'
        + '<p class="hzn-muted">Recorded ' + escapeHtml(fmtDate(claim.recordedAt))
        + ' &middot; weight ' + escapeHtml(claim.weight.toFixed(2))
        + (claim.dissent ? ' &middot; <strong>disagrees with the majority on this theme</strong>' : '')
        + (claim.outlier ? ' &middot; <strong>raised by this person alone</strong>' : '')
        + '</p>';

    case 'ai_interpretation':
      return '<p class="hzn-claim-line"><span class="hzn-value">' + escapeHtml(claim.statement) + '</span></p>'
        + '<p><strong>Reasoning:</strong> ' + escapeHtml(claim.reasoning) + '</p>'
        + '<p><strong>Assumes:</strong> ' + escapeHtml(claim.assumptions) + '</p>'
        + '<p><strong>Unsure about:</strong> ' + escapeHtml(claim.uncertainty) + '</p>'
        + '<p class="hzn-muted">Act: ' + escapeHtml(claim.act)
        + ' &middot; rests on ' + escapeHtml(claim.restsOn.join(', ')) + '</p>';

    case 'recommendation':
      return '<p class="hzn-claim-line"><span class="hzn-value">' + escapeHtml(claim.statement) + '</span></p>'
        + '<p><strong>Suggested:</strong> ' + escapeHtml(claim.suggestedAction) + '</p>'
        + (claim.forDecisionKind
          ? '<p class="hzn-warn">This touches a decision only a named person may make ('
            + escapeHtml(claim.forDecisionKind) + '). It is shown as recorded and it decides nothing.</p>'
          : '')
        + '<p class="hzn-muted">Advisory and overridable. A person decides.</p>';

    case 'human_decision':
      return '<p class="hzn-claim-line"><span class="hzn-label">' + escapeHtml(claim.decidedByName) + '</span>'
        + '<span class="hzn-value">' + escapeHtml(claim.decisionKind) + '</span></p>'
        + '<blockquote class="hzn-quote">' + escapeHtml(claim.decision) + '</blockquote>'
        + '<p class="hzn-muted">Decided ' + escapeHtml(fmtDate(claim.decidedAt))
        + (claim.followedRecommendation === true ? ' &middot; followed the recommendation' : '')
        + (claim.followedRecommendation === false ? ' &middot; <strong>departed from the recommendation</strong>' : '')
        + (claim.followedRecommendation === null ? ' &middot; no recommendation is recorded against this decision' : '')
        + '</p>'
        + (claim.overrideReason
          ? '<p><strong>Reason for departing:</strong> ' + escapeHtml(claim.overrideReason) + '</p>'
          : '');
  }
}

function renderSection(section: ReportSection): string {
  const claims = section.claims.length
    ? section.claims.map((c) =>
      '<li class="hzn-claim' + (c.major ? ' hzn-major' : '') + '">'
      + renderClaimBody(c as Claim)
      + renderProvenance(c.provenance, c.major === true)
      + '</li>').join('')
    : '';

  const emptyReason = section.coverage.missing.length
    ? 'Nothing was found here. ' + escapeHtml(section.coverage.missing.map((m) => m.reason).join(' '))
    : 'Nothing is recorded in this section for this subject.';

  return ''
    + '<section class="hzn-section hzn-section-' + escapeHtml(section.kind) + '">'
    + '<h3>' + escapeHtml(section.title) + '</h3>'
    + '<p class="hzn-section-desc">' + escapeHtml(section.description) + '</p>'
    + (section.redacted && section.redactionReason
      ? '<p class="hzn-redaction">' + escapeHtml(section.redactionReason) + '</p>' : '')
    + (claims
      ? '<ul class="hzn-claims">' + claims + '</ul>'
      : '<p class="hzn-empty">' + emptyReason + '</p>')
    + '</section>';
}

export interface RenderOptions {
  /** Shown above the document. Used by the run detail page to say when it was generated. */
  subtitle?: string | null;
}

export function renderReportHtml(doc: ReportDocument, options: RenderOptions = {}): string {
  const sections = SECTION_ORDER
    .map((k: SectionKind) => renderSection(doc.sections[k] as ReportSection))
    .join('');

  const coverage = doc.coverage.missing.length
    ? '<div class="hzn-coverage"><h4>What this report could not see</h4><ul>'
      + doc.coverage.missing.map((m) =>
        '<li><span class="hzn-k">' + escapeHtml(m.capability) + '</span> — ' + escapeHtml(m.reason) + '</li>').join('')
      + '</ul></div>'
    : '<div class="hzn-coverage hzn-coverage-ok"><h4>Coverage</h4>'
      + '<p>Every source this report asked for answered.</p></div>';

  const rejected = doc.integrity.rejected.length
    ? '<div class="hzn-rejected"><h4>Claims refused before this document was shown</h4>'
      + '<p class="hzn-muted">These were produced and then dropped for failing the provenance rules. '
      + 'They are listed so a reviewer can see what was withheld and why.</p><ul>'
      + doc.integrity.rejected.map((r) =>
        '<li><span class="hzn-k">' + escapeHtml(r.section) + '</span> — '
        + escapeHtml(r.statement) + ' <span class="hzn-muted">' + escapeHtml(r.reason) + '</span></li>').join('')
      + '</ul></div>'
    : '';

  return ''
    + '<article class="hzn-report">'
    + '<header class="hzn-head">'
    + '<h2>' + escapeHtml(doc.title) + '</h2>'
    + '<p class="hzn-subject">' + escapeHtml(doc.subject.displayName)
    + ' <span class="hzn-muted">&middot; ' + escapeHtml(doc.subject.kind) + '</span></p>'
    + '<p class="hzn-purpose">' + escapeHtml(doc.purpose) + '</p>'
    + (options.subtitle ? '<p class="hzn-muted">' + escapeHtml(options.subtitle) + '</p>' : '')
    // THE NOTICE IS NOT OPTIONAL AND NOT COLLAPSIBLE. It comes off the document, so no caller can
    // render one of these without it.
    + '<p class="hzn-notice">' + escapeHtml(doc.notice) + '</p>'
    + '<p class="hzn-stamp">'
    + 'Generated ' + escapeHtml(fmtDate(doc.generatedAt))
    + ' &middot; engine ' + escapeHtml(doc.stamp.engineId) + ' ' + escapeHtml(doc.stamp.engineVersion)
    + (doc.stamp.interpreterId
      ? ' &middot; interpreter ' + escapeHtml(doc.stamp.interpreterId) + ' ' + escapeHtml(doc.stamp.interpreterVersion || '')
      : '')
    + ' &middot; ' + escapeHtml(String(doc.integrity.claimCount)) + ' claims, '
    + escapeHtml(String(doc.integrity.majorClaimCount)) + ' of them conclusions'
    + '</p>'
    + '</header>'
    + sections
    + coverage
    + rejected
    + '</article>';
}

/**
 * Styles for the above. A string rather than a stylesheet so the three surfaces cannot load one and
 * forget the other; the page drops it into a single style tag.
 *
 * The six sections are colour-coded down the left edge, and that is doing real work rather than
 * decoration: it is the fastest way for a reader skimming a long document to know whether they are
 * looking at a record or at a machine reading one. Deliberately no icons and no emoji.
 */
export const REPORT_STYLES = `
.hzn-report{max-width:60rem;font-size:0.95rem;line-height:1.55}
.hzn-head{border-bottom:2px solid var(--era-line,#e3ded6);padding-bottom:1rem;margin-bottom:1.5rem}
.hzn-head h2{margin:0 0 .25rem;font-size:1.5rem}
.hzn-subject{margin:0 0 .5rem;font-weight:600}
.hzn-purpose{margin:0 0 .75rem;color:var(--era-ink-soft,#5b5750)}
.hzn-notice{margin:.75rem 0;padding:.7rem .9rem;border-left:3px solid var(--era-rust,#b4522a);
  background:var(--era-paper-2,#f7f4ef);font-size:.85rem}
.hzn-stamp{margin:.5rem 0 0;font-size:.75rem;color:var(--era-ink-soft,#5b5750);font-variant-numeric:tabular-nums}
.hzn-section{margin:0 0 1.75rem;padding-left:.9rem;border-left:3px solid var(--era-line,#e3ded6)}
.hzn-section h3{margin:0 0 .2rem;font-size:1.05rem}
.hzn-section-desc{margin:0 0 .75rem;font-size:.8rem;color:var(--era-ink-soft,#5b5750)}
.hzn-section-facts{border-left-color:#2f6f4f}
.hzn-section-derived{border-left-color:#2c5d86}
.hzn-section-human_feedback{border-left-color:#7a5aa6}
.hzn-section-ai_interpretation{border-left-color:#b4522a}
.hzn-section-recommendation{border-left-color:#a8801f}
.hzn-section-human_decision{border-left-color:#1f1d1a}
.hzn-claims{list-style:none;margin:0;padding:0}
.hzn-claim{margin:0 0 .9rem;padding:.7rem .85rem;background:var(--era-paper-2,#f7f4ef);border-radius:4px}
.hzn-claim.hzn-major{background:var(--era-paper,#fffdf9);border:1px solid var(--era-line,#e3ded6)}
.hzn-claim p{margin:.2rem 0}
.hzn-claim-line{display:flex;flex-wrap:wrap;gap:.5rem;align-items:baseline;justify-content:space-between}
.hzn-label{font-weight:600}
.hzn-value{font-variant-numeric:tabular-nums}
.hzn-unit{font-weight:400;color:var(--era-ink-soft,#5b5750)}
.hzn-method{font-size:.82rem}
.hzn-quote{margin:.4rem 0;padding:.4rem .7rem;border-left:2px solid var(--era-line,#e3ded6);font-style:normal}
.hzn-muted{color:var(--era-ink-soft,#5b5750);font-size:.8rem}
.hzn-k{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.78rem}
.hzn-warn{font-size:.82rem;padding:.4rem .6rem;background:#fdf1e7;border-left:2px solid #b4522a}
.hzn-empty{font-size:.85rem;color:var(--era-ink-soft,#5b5750);font-style:italic}
.hzn-redaction{font-size:.8rem;padding:.4rem .6rem;background:#f0eef8;border-left:2px solid #7a5aa6;margin:0 0 .7rem}
.hzn-prov{margin-top:.5rem;font-size:.8rem}
.hzn-prov summary{cursor:pointer}
.hzn-prov-body{padding:.5rem 0 0}
.hzn-prov-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:.75rem}
.hzn-prov-grid h5{margin:0 0 .25rem;font-size:.75rem;text-transform:uppercase;letter-spacing:.04em}
.hzn-prov-grid ul{margin:0;padding-left:1rem}
.hzn-basis{margin:0 0 .5rem}
.hzn-conf{font-weight:600}
.hzn-conf-observed{color:#2f6f4f}
.hzn-conf-high{color:#2c5d86}
.hzn-conf-moderate{color:#a8801f}
.hzn-conf-low{color:#b4522a}
.hzn-conf-insufficient{color:#8a8580}
.hzn-coverage,.hzn-rejected{margin-top:1.5rem;padding:.8rem 1rem;background:var(--era-paper-2,#f7f4ef);border-radius:4px}
.hzn-coverage h4,.hzn-rejected h4{margin:0 0 .4rem;font-size:.9rem}
.hzn-coverage ul,.hzn-rejected ul{margin:0;padding-left:1.1rem;font-size:.85rem}
.hzn-coverage-ok{background:#eef5f0}
`;
