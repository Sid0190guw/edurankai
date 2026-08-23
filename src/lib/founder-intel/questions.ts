// src/lib/founder-intel/questions.ts — THE SEVEN QUESTIONS, ASKED OF A SIGNAL THAT ALREADY EXISTS.
//
// =================================================================================================
// WHAT THIS ADDS THAT THE DEPTH LADDER DOES NOT
// =================================================================================================
//
// Patch 11 has a five-rung ladder — summary, signal, pattern, evidence, record — and it answers HOW
// FAR a reader may walk from a given tab. It does not answer WHAT they may ask when they get there.
// The founder brief names seven questions and requires every score and signal to support all of
// them:
//
//   WHY?                    the statement, its weight class, and the working behind its confidence
//   WHICH SOURCES?          the owning modules and tables, named
//   WHICH RECORDS?          the rows, each with a route to the original
//   WHO PROVIDED IT?        grouped by what kind of statement each record is
//   WHEN?                   when the thing happened, and when the signal was observed
//   WHAT ACTION WAS TAKEN?  the human decisions that name this signal as considered
//   WHAT WAS THE OUTCOME?   what followed each of those decisions
//
// =================================================================================================
// EVERY ANSWER IS A PURE FUNCTION OF THE SIGNAL. NOTHING HERE QUERIES.
// =================================================================================================
//
// If "why is this 14?" went back to the database, the answer could come back describing fifteen
// rows: the figure and its justification would be two reads of a moving table, and the founder would
// be shown a contradiction and told it was an explanation. So the answers are computed from the
// Signal object Patch 11 already produced, which is also why the page needs no client JavaScript to
// open one.
//
// =================================================================================================
// AN UNANSWERABLE QUESTION GETS THE REASON, NEVER AN EMPTY PANEL
// =================================================================================================
//
// "What was the outcome?" against a signal with no decision recorded returns the sentence saying so.
// An empty panel reads as "there was no outcome", which is a claim about the organisation that
// nobody made. The distinction this file keeps hardest is between NOTHING ON RECORD and COULD NOT BE
// READ, because they are the same shape on a screen and opposite facts about a person.

import type { DecisionRecord, EvidenceRef, InterventionRecord, Signal } from '@/lib/horizon/contracts';
import { DATA_CLASS_MEANING, SIGNAL_WEIGHT_LABELS, SIGNAL_WEIGHT_MEANING } from '@/lib/horizon/contracts';

export const QUESTIONS = ['why', 'sources', 'records', 'who', 'when', 'action', 'outcome'] as const;
export type Question = (typeof QUESTIONS)[number];

export const QUESTION_LABELS: Record<Question, string> = {
  why: 'Why?',
  sources: 'Which sources?',
  records: 'Which records?',
  who: 'Who provided it?',
  when: 'When?',
  action: 'What action was taken?',
  outcome: 'What was the outcome?',
};

export function isQuestion(v: unknown): v is Question {
  return typeof v === 'string' && (QUESTIONS as readonly string[]).indexOf(v) >= 0;
}

export interface AnswerLine {
  text: string;
  href?: string | null;
  /** A short qualifier printed beside the line: a date, a count, a verification status. */
  note?: string | null;
}

export interface Answer {
  question: Question;
  label: string;
  /** One sentence that stands on its own even when nothing is listed underneath it. */
  headline: string;
  lines: AnswerLine[];
}

/** Decisions and interventions, as the patch that recorded them stored them. */
export interface LinkedActions {
  decisions: DecisionRecord[];
  interventions: InterventionRecord[];
}

const NONE: LinkedActions = { decisions: [], interventions: [] };

/** A short, unambiguous date. Never a relative phrase, which ages badly behind a cache. */
export function dayLabel(at: string | null | undefined): string {
  if (!at) return 'no date on record';
  const t = Date.parse(String(at));
  if (!Number.isFinite(t)) return 'no usable date on record';
  const d = new Date(t);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return String(d.getUTCDate()).padStart(2, '0') + ' ' + mon + ' ' + d.getUTCFullYear();
}

const refLabel = (e: EvidenceRef): string =>
  e.sentence || [e.sourceTable, e.sourceId].filter(Boolean).join(' ') || 'A record with no description';

const refId = (e: EvidenceRef): string =>
  [e.sourceTable, e.sourceId].filter(Boolean).join(':') || e.ownerModule;

/** All seven answers for one signal, in reading order. */
export function askAll(signal: Signal, linked: LinkedActions = NONE): Answer[] {
  return QUESTIONS.map((q) => ask(signal, q, linked));
}

export function ask(signal: Signal, question: Question, linked: LinkedActions = NONE): Answer {
  const label = QUESTION_LABELS[question];
  const evidence = signal.evidence || [];

  switch (question) {
    case 'why':
      return {
        question, label,
        headline: signal.statement,
        lines: [
          { text: SIGNAL_WEIGHT_LABELS[signal.weightClass] + ': ' + SIGNAL_WEIGHT_MEANING[signal.weightClass] },
          { text: 'Confidence ' + signal.confidence.band + '. ' + (signal.confidence.basis || 'No working was recorded.') },
          { text: DATA_CLASS_MEANING[signal.dataClass] },
          { text: 'Produced by ' + signal.producedBy + '. A disputed signal has an owner to take it to.' },
          ...(signal.disputed
            ? [{ text: 'A named human has DISPUTED this signal. It is kept on record and shown, not withdrawn.' }]
            : []),
        ],
      };

    case 'sources': {
      if (!evidence.length) {
        return {
          question, label,
          headline:
            'No source is attached to this signal, which is why nothing underneath it can be opened. ' +
            'A statement with no source is the weakest thing this system will show, and it is shown as one.',
          lines: [],
        };
      }
      const byModule = new Map<string, { module: string; tables: Set<string>; count: number }>();
      for (const e of evidence) {
        const found = byModule.get(e.ownerModule);
        if (found) {
          found.count += 1;
          if (e.sourceTable) found.tables.add(e.sourceTable);
        } else {
          byModule.set(e.ownerModule, {
            module: e.ownerModule,
            tables: new Set(e.sourceTable ? [e.sourceTable] : []),
            count: 1,
          });
        }
      }
      return {
        question, label,
        headline:
          byModule.size + ' module(s) own the records behind this. Each is named by the module that OWNS ' +
          'the fact, not the one that happened to read it, so the same figure can be checked where it lives.',
        lines: [...byModule.values()].map((m) => ({
          text: m.module,
          note: (m.tables.size ? [...m.tables].join(', ') + ' — ' : '') + m.count + ' record(s)',
        })),
      };
    }

    case 'records': {
      if (!evidence.length) {
        return {
          question, label,
          headline:
            'There is no record behind this signal to open. That is a statement about the evidence, not ' +
            'about the person, and it is why this signal cannot carry more weight than it does.',
          lines: [],
        };
      }
      return {
        question, label,
        headline:
          evidence.length + ' record(s) are behind this. Each one opens where it lives, at the screen ' +
          'that owns it, with that screen\'s own permissions and audit.',
        lines: evidence.map((e) => ({
          text: refLabel(e),
          href: e.href || e.documentUrl || null,
          note: [refId(e), e.locator, e.verificationStatus].filter(Boolean).join(' — ') || null,
        })),
      };
    }

    case 'who': {
      if (!evidence.length) {
        return {
          question, label,
          headline: 'Nobody is named, because no record is attached to this signal.',
          lines: [],
        };
      }
      // Grouped by the verification status the producing patch recorded, because "confirmed by a
      // named reviewer" and "as submitted" are different kinds of statement and must not be counted
      // together into one reassuring total.
      const groups = new Map<string, { status: string; modules: Set<string>; count: number }>();
      for (const e of evidence) {
        const status = e.verificationStatus || 'no verification status recorded';
        const found = groups.get(status);
        if (found) {
          found.count += 1;
          found.modules.add(e.ownerModule);
        } else {
          groups.set(status, { status, modules: new Set([e.ownerModule]), count: 1 });
        }
      }
      return {
        question, label,
        headline:
          'Grouped by what kind of statement each record is. A record somebody confirmed and a record ' +
          'somebody submitted are never counted together here.',
        lines: [...groups.values()]
          .sort((a, b) => b.count - a.count)
          .map((g) => ({
            text: g.status,
            note: g.count + ' record(s), via ' + [...g.modules].join(', '),
          })),
      };
    }

    case 'when': {
      const dates = evidence
        .map((e) => e.occurredAt)
        .filter((d): d is string => !!d && Number.isFinite(Date.parse(String(d))))
        .sort();
      const undated = evidence.length - dates.length;
      return {
        question, label,
        headline:
          'Observed ' + dayLabel(signal.observedAt) + '. ' +
          (dates.length
            ? 'The records behind it run from ' + dayLabel(dates[0]) + ' to ' + dayLabel(dates[dates.length - 1]) + '.'
            : 'No record behind it carries a usable date, so the age of this signal cannot be checked against its evidence.'),
        lines: [
          ...(undated
            ? [{
              text: undated + ' record(s) carry no usable date. They are reported rather than placed in the most recent window.',
            }]
            : []),
          ...evidence
            .filter((e) => e.occurredAt)
            .map((e) => ({
              text: refLabel(e),
              href: e.href || null,
              note: dayLabel(e.occurredAt),
            })),
        ],
      };
    }

    case 'action': {
      const acted = linked.decisions.filter((d) => (d.consideredSignalIds || []).indexOf(signal.id) >= 0);
      const open = linked.interventions;
      if (!acted.length && !open.length) {
        return {
          question, label,
          headline:
            'No human decision names this signal as something they considered, and no intervention is ' +
            'open against it. Nothing in this system can act on a signal by itself: a decision is a ' +
            'human act, recorded by the screen that owns it.',
          lines: [],
        };
      }
      return {
        question, label,
        headline:
          acted.length + ' recorded decision(s) name this signal as considered, and ' + open.length +
          ' intervention(s) are on record for this person. Naming it is attribution, not causation: ' +
          'the decider said they took it into account.',
        lines: [
          ...acted.map((d) => ({
            text: d.decision,
            href: (d.evidence && d.evidence[0] && d.evidence[0].href) || null,
            note: (d.decidedByName || 'a named human') +
              (d.decidedByRole ? ' (' + d.decidedByRole + ')' : '') +
              ', ' + dayLabel(d.decidedAt) +
              (d.reason ? '' : ' — no written reason on record'),
          })),
          ...open.map((i) => ({
            text: i.kind + ': ' + i.summary,
            href: (i.evidence && i.evidence[0] && i.evidence[0].href) || null,
            note: i.status + ', opened ' + dayLabel(i.openedAt) +
              (i.closedAt ? ', closed ' + dayLabel(i.closedAt) : ', still open'),
          })),
        ],
      };
    }

    case 'outcome': {
      const acted = linked.decisions.filter((d) => (d.consideredSignalIds || []).indexOf(signal.id) >= 0);
      const closed = linked.interventions.filter((i) => i.closedAt);
      const stillOpen = linked.interventions.filter((i) => !i.closedAt);

      if (!acted.length && !linked.interventions.length) {
        return {
          question, label,
          headline: 'There is no outcome, because no decision or intervention has been recorded against this signal.',
          lines: [],
        };
      }
      const uninformed = acted.filter((d) => !d.subjectInformed);
      return {
        question, label,
        headline:
          closed.length + ' intervention(s) closed, ' + stillOpen.length + ' still open. ' +
          (uninformed.length
            ? uninformed.length + ' decision(s) are recorded as NOT yet communicated to the person they are about.'
            : 'Every recorded decision here is marked as communicated to the person.'),
        lines: [
          ...acted.map((d) => ({
            text: d.decision,
            href: (d.evidence && d.evidence[0] && d.evidence[0].href) || null,
            note: d.subjectInformed ? 'the person has been told' : 'the person has NOT been told',
          })),
          ...linked.interventions.map((i) => ({
            text: i.kind + ': ' + i.summary,
            href: (i.evidence && i.evidence[0] && i.evidence[0].href) || null,
            note: i.closedAt ? 'closed ' + dayLabel(i.closedAt) : 'open since ' + dayLabel(i.openedAt),
          })),
        ],
      };
    }
  }
}

/** Look one signal up by id. Returns null rather than guessing at a near match. */
export function findSignal(signals: readonly Signal[], id: string): Signal | null {
  return signals.find((s) => s.id === id) ?? null;
}
