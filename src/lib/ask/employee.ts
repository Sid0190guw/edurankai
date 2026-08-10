// src/lib/ask/employee.ts — THE EMPLOYEE ANSWER, ASSEMBLED FROM WHAT WAS RETRIEVED.
//
// =================================================================================================
// FOUR RULES, AND WHERE EACH ONE LIVES IN THIS FILE
// =================================================================================================
//
// GROUNDED OR SILENT. Every sentence below is built from a value that came back from a read, and the
// read is cited beside it. There is no branch in this file that composes an answer out of general
// knowledge, and there is no model call that supplies a fact — src/lib/ask/rephrase.ts only ever
// re-words text that this file has already assembled, behind a validator that discards any number it
// did not start with. When nothing retrieved answers the question, `clearedFloor` is false, the
// status is 'unknown', and the answer is a named human. A confident wrong answer about a notice
// period or a leave entitlement is a real harm to a real person, and it arrives wearing exactly the
// same clothes as a right one.
//
// AUTHORIZATION SCOPES RETRIEVAL, NOT OUTPUT. The handbook read goes through
// src/lib/knowledge-base.ts with a viewer built from THIS session, and visibilityClause() narrows it
// in the WHERE clause: an article this person may not read is never fetched, so there is no version
// of this answer with it hidden underneath. Nothing here fetches and then filters, and nothing here
// generates and then redacts.
//
// NEVER ANOTHER PERSON'S DATA. Every personal read in this file takes ONE employee id — the one
// resolved from the session by the caller — and there is no parameter, no query string and no form
// field that can change it. That is stronger than a per-row check, and it is stronger on purpose:
// there is no manager path here at all. A manager who needs to see a report's leave has
// /portal/approvals and /portal/team, where the organization graph already resolves it per row, and
// adding a second answer to that question in a question box would give this company two answers that
// disagree. Health and wellness data has no path from here of any kind, filtered or otherwise.
//
// IT ANSWERS, IT DOES NOT ACT. Nothing in this file writes. Every module it imports has write
// functions — applyLeave, submitClaim, acknowledgePolicy, decideStep — and not one of them is
// imported. What the reader gets instead is `doItHere`: the screen where a human does the thing.
//
// AND THE FIFTH, WHICH IS NOT A RULE SO MUCH AS A MANNER: escalation is on every answer, including
// the good ones. Nobody should be trapped in a conversation with software about their own pay.
import {
  makeViewer, searchArticlesRead, articleCorpusRead, passageFor, kbCategoryLabel, kindLabel,
  type KbViewer, type KbArticle,
} from '@/lib/knowledge-base';
import { getBalances, type LeaveBalance } from '@/lib/hr-leave';
import { resolveRoute, VIA_LABELS, type RouteVia } from '@/lib/workflow';
import { getManagerCompat } from '@/lib/org-graph';
import { learningPathRead } from '@/lib/performance-learning';
import { payslipsForEmployeeResult, payslipLines, describeLine } from '@/lib/payroll';
import { claimsForEmployee } from '@/lib/expenses';
import { catalogueFor, describeRules } from '@/lib/benefits';
import { resolveDeskRoute, categoryLabel, type TicketCategory } from '@/lib/helpdesk';
import {
  normalizeQuestion, classifyEmployee, isHealthQuestion, mentionsAnotherPerson, isActionRequest,
  QUESTION_MIN, type EmployeeIntent,
} from './intent';
import type { AskAnswer, Citation, DoItHere, Escalation, Look } from './types';

// The real Postgres reason is on e.cause; e.message is only the failed SQL.
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const logFail = (tag: string, e: any) => console.error('[ask/employee] ' + tag, reasonOf(e));

const KNOWLEDGE_PAGE = '/portal/employee/knowledge';
const SUPPORT_PAGE = '/portal/employee/support';

/** Who is asking, resolved server-side by the page from the session. Never from a request body. */
export interface EmployeeAsker {
  /** users.id. */
  userId: string;
  /** hr_employees.id, or null when no employee record is linked. An ordinary state, not an error. */
  employeeId: string | null;
  /** Does this account have a workspace at all? Decides whether the handbook is readable. */
  hasWorkspace: boolean;
  /** The resolved permission set, straight from resolvePermissions(). May contain the wildcard. */
  permissions: Iterable<string>;
  /** users.name or the employee's full name, for nothing but the greeting. Never used in a query. */
  displayName?: string | null;
}

export interface AskEmployeeOptions {
  /** Attempt a model rephrase. The caller passes the reader's own choice; default is off. */
  useModel?: boolean;
}

// -------------------------------------------------------------------------------------------------
// Small builders, declared before every handler that uses them. `const` is not hoisted, and a
// handler reaching a later declaration has taken pages down in this repo before.
// -------------------------------------------------------------------------------------------------

const look = (label: string, outcome: Look['outcome'], note: string, count = 0): Look =>
  ({ label, outcome, note, count });

const money = (n: any, currency: string): string =>
  (currency || 'INR') + ' ' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const dateText = (v: any): string => {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

/** The desk that owns a question of this shape. Vocabulary imported from helpdesk.ts, never restated. */
function deskFor(intent: EmployeeIntent): TicketCategory {
  if (intent === 'expense.claim') return 'finance';
  if (intent === 'payslip.where' || intent === 'payslip.line') return 'finance';
  return 'hr';
}

/** A handbook hit, as a citation with the sentences it matched on rather than the whole article. */
function articleCitation(article: KbArticle, why: string, question: string): Citation {
  return {
    kind: kindLabel(article.kind) + ' · ' + kbCategoryLabel(article.category),
    title: article.title + (article.version > 1 ? ' (version ' + article.version + ')' : ''),
    href: KNOWLEDGE_PAGE + '?a=' + encodeURIComponent(article.slug),
    passage: passageFor(article, question),
    why: 'In the staff handbook, and it ' + why + '.',
  };
}

// -------------------------------------------------------------------------------------------------
// THE HANDBOOK READ — run for every question that is not refused
// -------------------------------------------------------------------------------------------------
//
// THREE EMPTY STATES, KEPT APART, because they need three different things from the reader. "The
// handbook does not cover this" over a query that never completed tells somebody their company has
// no leave policy. "The handbook does not cover this" over a database in which nobody has ever
// published an article tells them the same lie in a different way — nothing seeds kb_articles in
// this repository, so on a fresh deployment the true answer to every policy question is "nobody has
// written one yet", and that is a job, not an absence.

interface HandbookResult {
  citations: Citation[];
  look: Look;
  degraded: boolean;
}

async function readHandbook(viewer: KbViewer, question: string, limit = 3): Promise<HandbookResult> {
  const LABEL = 'The staff handbook and company policies';

  if (!viewer.hasWorkspace) {
    return {
      citations: [],
      degraded: false,
      look: look(LABEL, 'out-of-scope', 'This account has no workspace here, so no company article was searched.'),
    };
  }

  const found = await searchArticlesRead(viewer, question, limit);
  if (found.read === 'unreadable') {
    return {
      citations: [],
      degraded: true,
      look: look(LABEL, 'unreadable', 'The handbook could not be searched just now, so something written down may be missing from this answer. The database said: ' + (found.reason || 'no reason given') + '.'),
    };
  }
  if (found.hits.length > 0) {
    return {
      citations: found.hits.map((h) => articleCitation(h.article, h.why, question)),
      degraded: false,
      look: look(LABEL, 'hit', found.hits.length === 1 ? 'One article matched, searched by title, summary, tags and body.' : found.hits.length + ' articles matched, searched by title, summary, tags and body.', found.hits.length),
    };
  }

  const corpus = await articleCorpusRead(viewer);
  if (corpus.read === 'unreadable') {
    return {
      citations: [], degraded: true,
      look: look(LABEL, 'unreadable', 'Nothing matched, and the handbook could not be counted either, so this may be an outage rather than a gap. The database said: ' + (corpus.reason || 'no reason given') + '.'),
    };
  }
  if (corpus.published === 0) {
    return {
      citations: [], degraded: false,
      look: look(LABEL, 'not-configured', 'There is no published article in the staff handbook at all — not none that match this question, none at all. Nothing has been written yet.'),
    };
  }
  return {
    citations: [], degraded: false,
    look: look(LABEL, 'empty', corpus.published + (corpus.published === 1 ? ' published article you may read was searched' : ' published articles you may read were searched') + ' by title, summary, tags and body. None of them mentioned this.'),
  };
}

// -------------------------------------------------------------------------------------------------
// ESCALATION — always present, resolved from the organization graph, never invented
// -------------------------------------------------------------------------------------------------

async function escalationFor(intent: EmployeeIntent, employeeId: string | null): Promise<Escalation[]> {
  const desk = deskFor(intent);
  const out: Escalation[] = [];
  try {
    const route = await resolveDeskRoute(desk, employeeId);
    out.push({
      label: 'Ask a person on the ' + categoryLabel(desk) + ' desk',
      href: SUPPORT_PAGE + '?category=' + encodeURIComponent(desk),
      note: route.ok && route.fullName
        ? 'This desk is owned by ' + route.fullName + '. Raising a request here reaches them.'
        : (route.routeNote || 'Raise a request here. Nobody is recorded as owning this desk yet, so it will sit visible until somebody picks it up.'),
    });
  } catch (e: any) {
    logFail('resolveDeskRoute', e);
    out.push({
      label: 'Ask a person on the ' + categoryLabel(desk) + ' desk',
      href: SUPPORT_PAGE + '?category=' + encodeURIComponent(desk),
      note: 'Who owns this desk could not be looked up just now, but the request form works and a request raised on it is not lost.',
    });
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// THE PERSONAL READS. Each one takes the session's own employee id and nothing else.
// -------------------------------------------------------------------------------------------------

interface FactResult {
  paragraphs: string[];
  citations: Citation[];
  looks: Look[];
  doItHere: DoItHere[];
  degraded: boolean;
}

const noFacts = (): FactResult => ({ paragraphs: [], citations: [], looks: [], doItHere: [], degraded: false });

/** LEAVE BALANCE. getBalances() with strict:true, so a failed read refuses rather than reporting
 *  every allowance as fully remaining — the tolerant path returns zeros for used and pending, which
 *  on a screen is merely wrong and in a sentence is an invitation to file leave somebody does not
 *  have. */
async function leaveBalanceFacts(employeeId: string): Promise<FactResult> {
  const LABEL = 'Your own leave record';
  const r = noFacts();
  let balances: LeaveBalance[] = [];
  try {
    balances = await getBalances(employeeId, undefined, { strict: true });
  } catch (e: any) {
    logFail('getBalances', e);
    r.degraded = true;
    r.looks.push(look(LABEL, 'unreadable', 'Your leave balances could not be read, so no number is given here. The database said: ' + reasonOf(e) + '. Open the leave screen rather than treating this as an empty balance.'));
    return r;
  }

  const shown = balances.filter((b) => b.allowance > 0 || b.used > 0 || b.pending > 0);
  if (shown.length === 0) {
    r.looks.push(look(LABEL, 'empty', 'Your leave record was read and it holds no allowance, no taken leave and nothing waiting for approval for this year.'));
    r.paragraphs.push('Your leave record was read and there is nothing on it for this year: no allowance recorded, nothing taken, nothing waiting for approval. If that is wrong, the people desk holds the record.');
    return r;
  }

  const lines = shown.map((b) => {
    const parts = [b.name + ': ' + b.remaining + ' of ' + b.allowance + ' remaining'];
    if (b.used > 0) parts.push(b.used + ' taken');
    if (b.pending > 0) parts.push(b.pending + ' waiting for approval');
    if (b.expiringSoon && b.expiringSoon > 0) parts.push(b.expiringSoon + ' expiring within a month');
    return parts.join(', ') + '.';
  });

  r.paragraphs.push('This is read from your own leave record, for the current leave year.');
  r.paragraphs.push(...lines);
  r.looks.push(look(LABEL, 'hit', shown.length + (shown.length === 1 ? ' leave type' : ' leave types') + ' with something recorded against them.', shown.length));
  r.citations.push({
    kind: 'Your own leave record',
    title: 'Leave balances, current leave year',
    href: '/portal/employee/leave',
    passage: lines.join(' '),
    why: 'Read from your own record. Nobody else can be read from here, and this is the same source the leave screen counts from.',
  });
  r.doItHere.push({ label: 'Apply for leave', href: '/portal/employee/leave', note: 'Filing a request is something you do. This assistant does not file it for you.' });
  return r;
}

/** WHO APPROVES IT. resolveRoute() is the approval engine itself, read-only: the same function that
 *  decides the chain when a request is actually filed. Never inferred from a role name. */
async function approverFacts(domain: 'leave' | 'expenses', employeeId: string, what: string): Promise<FactResult> {
  const LABEL = 'The approval route for ' + what + ', from the organization graph';
  const r = noFacts();
  try {
    const plan = await resolveRoute(domain, employeeId);
    if (!plan.initialized) {
      r.looks.push(look(LABEL, 'not-configured', 'The organization graph has no relationships recorded in it at all, so no approver can be named for anybody yet.'));
      r.paragraphs.push('Nobody can be named as your approver yet: the organization graph has no relationships recorded in it at all. That is a setup step, not something about you. A request you file still exists and stays visible — it waits rather than being approved by default.');
      r.degraded = false;
      return r;
    }
    if (!plan.ok || plan.approvers.length === 0) {
      r.looks.push(look(LABEL, 'empty', plan.haltReason || 'The graph is populated but names nobody for this route.'));
      r.paragraphs.push('The approval route could not name anybody for you. ' + (plan.haltReason || 'The organization graph is populated but has no relationship that covers this.') + ' A request you file is not lost and is not auto-approved — it waits, visibly, until the missing relationship is recorded.');
      return r;
    }
    const steps = plan.approvers.map((a, i) => {
      const via = VIA_LABELS[a.via as RouteVia] || String(a.via);
      return (i + 1) + '. ' + (a.fullName || 'a person with no name on their record') + (a.designation ? ', ' + a.designation : '') + ' — as your ' + via.toLowerCase() + '.';
    });
    r.paragraphs.push('Resolved from the organization graph, in order:');
    r.paragraphs.push(...steps);
    r.looks.push(look(LABEL, 'hit', plan.approvers.length + (plan.approvers.length === 1 ? ' rung resolved.' : ' rungs resolved, in order.'), plan.approvers.length));
    r.citations.push({
      kind: 'The approval engine',
      title: 'Approval route for ' + what,
      href: '/portal/employee/' + (domain === 'leave' ? 'leave' : 'expenses'),
      passage: steps.join(' '),
      why: 'Resolved per request from the organization graph by the same engine that routes the real request — not from a role name, and not from a list somebody typed.',
    });
  } catch (e: any) {
    logFail('resolveRoute', e);
    r.degraded = true;
    r.looks.push(look(LABEL, 'unreadable', 'The approval route could not be resolved just now. The system said: ' + reasonOf(e) + '.'));
  }
  return r;
}

/** WHO IS MY REPORTING MANAGER. The compatibility read, so the answer can SAY where it came from. */
async function managerFacts(employeeId: string): Promise<FactResult> {
  const LABEL = 'The organization graph';
  const r = noFacts();
  try {
    const answer = await getManagerCompat(employeeId);
    if (answer.source === 'none' || !answer.value) {
      r.looks.push(look(LABEL, answer.source === 'none' ? 'not-configured' : 'empty',
        answer.source === 'none'
          ? 'The organization graph has nothing recorded and no manager is on your employee record either.'
          : 'The organization graph was read and it records no reporting manager for you.'));
      r.paragraphs.push(answer.source === 'none'
        ? 'No reporting manager is recorded for you anywhere — not in the organization graph and not on your employee record. That is a gap in the records rather than a statement that you report to nobody.'
        : 'The organization graph was read and it records no reporting manager for you. If that is wrong, the people desk is where the relationship is recorded.');
      return r;
    }
    const person = answer.value;
    const name = person.fullName || 'a person whose name is not on their record';
    const sentence = name + (person.designation ? ', ' + person.designation : '') + ' is recorded as your reporting manager.';
    r.paragraphs.push(sentence);
    if (answer.source === 'legacy-column') {
      r.paragraphs.push('That came from the older manager column on your employee record rather than from the organization graph, because the graph has not been populated yet. It is the same answer the rest of the workspace uses today.');
    }
    r.looks.push(look(LABEL, 'hit', answer.source === 'graph' ? 'A reporting-manager relationship is recorded in the graph.' : 'The graph is empty; the answer came from the older column on the employee record.', 1));
    r.citations.push({
      kind: answer.source === 'graph' ? 'The organization graph' : 'Your employee record (older manager column)',
      title: 'Reporting manager',
      href: '/portal/organization',
      passage: sentence,
      why: 'Relationships are read from the organization graph, never from a role name.',
    });
  } catch (e: any) {
    logFail('getManagerCompat', e);
    r.degraded = true;
    r.looks.push(look(LABEL, 'unreadable', 'Who you report to could not be read just now. The database said: ' + reasonOf(e) + '.'));
  }
  return r;
}

/** ASSIGNED TRAINING. learningPathRead() distinguishes "nothing assigned" from "could not read", and
 *  the percentage is NEVER computed here: src/lib/learning-progress.ts reconciles two completion
 *  tables that two players write into, and a second arithmetic would disagree with it. */
async function trainingFacts(employeeId: string): Promise<FactResult> {
  const LABEL = 'Training assigned to you';
  const r = noFacts();
  const read = await learningPathRead(employeeId);
  if (read.read === 'unreadable') {
    r.degraded = true;
    r.looks.push(look(LABEL, 'unreadable', 'Your assigned training could not be read, so this is not a statement that nothing is assigned to you. Open the learning screen.'));
    return r;
  }
  if (read.items.length === 0) {
    r.looks.push(look(LABEL, 'empty', 'Your assignment list was read and it is empty.'));
    r.paragraphs.push('Your assignment list was read and nothing is assigned to you at the moment. Courses you can take without being assigned them are on the learning screen.');
    r.doItHere.push({ label: 'Your learning', href: '/portal/employee/learning', note: 'Where assignments appear and where you continue one.' });
    return r;
  }
  const lines = read.items.slice(0, 8).map((i) => {
    const bits = [i.courseTitle];
    bits.push(i.required ? 'required' : 'optional');
    if (i.dueOn) bits.push('due ' + dateText(i.dueOn) + (i.overdue ? ' — overdue' : ''));
    bits.push(i.state === 'complete' ? 'complete' : i.state === 'in_progress' ? 'in progress' : 'not started');
    return bits.join(' — ') + '.';
  });
  r.paragraphs.push(read.items.length === 1 ? 'One course is assigned to you.' : read.items.length + ' courses are assigned to you.');
  r.paragraphs.push(...lines);
  r.looks.push(look(LABEL, 'hit', read.items.length + (read.items.length === 1 ? ' assignment.' : ' assignments.'), read.items.length));
  r.citations.push({
    kind: 'Your own learning record',
    title: 'Training assigned to you',
    href: '/portal/employee/learning',
    passage: lines.join(' '),
    why: 'Read from your own assignment rows. Progress is counted by the reconciler that both course players write into, not recomputed here.',
  });
  r.doItHere.push({ label: 'Open your learning', href: '/portal/employee/learning', note: 'Where you continue or finish a course.' });
  return r;
}

/** PAYSLIPS. The *Result form, because "no payslip has been issued" and "we could not look" are
 *  different sentences and a person shown the first over the second concludes they were not paid. */
async function payslipFacts(employeeId: string, withLines: boolean): Promise<FactResult> {
  const LABEL = 'Your own payslips';
  const r = noFacts();
  const read = await payslipsForEmployeeResult(employeeId, 6);
  if (!read.ok) {
    r.degraded = true;
    r.looks.push(look(LABEL, 'unreadable', 'Your payslips could not be read, so nothing here says whether one exists. The database said: ' + (read.reason || 'no reason given') + '.'));
    return r;
  }
  if (read.rows.length === 0) {
    r.looks.push(look(LABEL, 'empty', 'Your payslip list was read and no payslip has been issued to you yet.'));
    r.paragraphs.push('Your payslip list was read and no payslip has been issued to you yet. Payslips appear once a payroll run that includes you has been completed.');
    r.doItHere.push({ label: 'Your payslips', href: '/portal/employee/payslips', note: 'Where they appear, and where each one can be opened and printed.' });
    return r;
  }

  const latest = read.rows[0];
  const listed = read.rows.slice(0, 4).map((p) => p.periodLabel + ' — net ' + money(p.net, p.currency) + (p.paidAt ? ', paid ' + dateText(p.paidAt) : ', not marked paid yet') + '.');
  r.paragraphs.push('Your payslips are on your own payslip screen. The most recent is ' + latest.periodLabel + '.');
  r.paragraphs.push(...listed);
  r.looks.push(look(LABEL, 'hit', read.rows.length + (read.rows.length === 1 ? ' payslip found.' : ' payslips found, newest first.'), read.rows.length));
  r.citations.push({
    kind: 'Your own payslips',
    title: 'Payslips issued to you',
    href: '/portal/employee/payslips',
    passage: listed.join(' '),
    why: 'Read from your own payslip rows, narrowed by your employee id in the query.',
  });
  r.doItHere.push({ label: 'Open your payslips', href: '/portal/employee/payslips', note: 'Each one opens in full and can be printed.' });

  if (withLines) {
    const LINE_LABEL = 'The lines on your most recent payslip';
    const lines = await payslipLines(latest.id);
    if (lines.length === 0) {
      r.looks.push(look(LINE_LABEL, 'empty', 'No line detail came back for ' + latest.periodLabel + '. That is either a payslip stored without its lines or a read that did not complete — this cannot tell which, so open the payslip itself.'));
      r.paragraphs.push('No line-by-line detail came back for ' + latest.periodLabel + '. Open the payslip itself: it prints every component in full.');
    } else {
      const described = lines.map((l) => {
        const basis = describeLine(l);
        return l.label + ' — ' + (l.kind === 'deduction' ? 'a deduction' : 'an earning') + ' of ' + money(l.amount, latest.currency) + (basis ? ', calculated as ' + basis : '') + (l.statutory ? ', statutory' : '') + '.';
      });
      r.paragraphs.push('The lines on your ' + latest.periodLabel + ' payslip, as they are stored:');
      r.paragraphs.push(...described.slice(0, 12));
      r.looks.push(look(LINE_LABEL, 'hit', lines.length + (lines.length === 1 ? ' line.' : ' lines.'), lines.length));
      r.citations.push({
        kind: 'Your own payslip',
        title: latest.periodLabel + ' payslip, line detail',
        href: '/portal/employee/payslips',
        passage: described.join(' '),
        why: 'The stored lines of your own payslip, with the basis each one was calculated on. Nothing here is recalculated and nothing is a general explanation of what a component usually means.',
      });
    }
  }
  return r;
}

/** EXPENSE CLAIMS. Read-only: submitClaim and decideClaim are not imported anywhere in this file. */
async function expenseFacts(employeeId: string): Promise<FactResult> {
  const LABEL = 'Your own expense claims';
  const r = noFacts();
  let claims: Awaited<ReturnType<typeof claimsForEmployee>> = [];
  try {
    claims = await claimsForEmployee(employeeId, 10);
  } catch (e: any) {
    logFail('claimsForEmployee', e);
    r.degraded = true;
    r.looks.push(look(LABEL, 'unreadable', 'Your claims could not be read. The database said: ' + reasonOf(e) + '.'));
    return r;
  }
  r.doItHere.push({ label: 'Your expenses', href: '/portal/employee/expenses', note: 'Where a claim is made, and where a claim you already made is tracked. This assistant does not submit one.' });
  if (claims.length === 0) {
    r.looks.push(look(LABEL, 'empty', 'Your claim list was read and you have not made one yet.'));
    r.paragraphs.push('Your claim list was read and you have not made a claim yet. The expenses screen is where one is started.');
    return r;
  }
  const listed = claims.slice(0, 5).map((c) => c.title + ' — ' + c.kindLabel.toLowerCase() + ', ' + money(c.amount, c.currency) + ', ' + c.statusLabel.toLowerCase() + (c.haltReason ? ' (' + c.haltReason + ')' : '') + '.');
  r.paragraphs.push(claims.length === 1 ? 'You have one claim on record.' : 'You have ' + claims.length + ' claims on record. The most recent:');
  r.paragraphs.push(...listed);
  r.looks.push(look(LABEL, 'hit', claims.length + (claims.length === 1 ? ' claim.' : ' claims.'), claims.length));
  r.citations.push({
    kind: 'Your own expense claims',
    title: 'Claims you have made',
    href: '/portal/employee/expenses',
    passage: listed.join(' '),
    why: 'Read from your own claim rows, narrowed by your employee id in the query.',
  });
  return r;
}

/** BENEFITS. catalogueFor() pairs each benefit with this person's own eligibility verdict, and
 *  describeRules() returns the rules AS SENTENCES — a ready-made citation rather than a paraphrase. */
async function benefitFacts(employeeId: string): Promise<FactResult> {
  const LABEL = 'The benefits catalogue, evaluated against your record';
  const r = noFacts();
  let catalogue: Awaited<ReturnType<typeof catalogueFor>>;
  try {
    catalogue = await catalogueFor(employeeId);
  } catch (e: any) {
    logFail('catalogueFor', e);
    r.degraded = true;
    r.looks.push(look(LABEL, 'unreadable', 'The benefits catalogue could not be read. The database said: ' + reasonOf(e) + '.'));
    return r;
  }
  r.doItHere.push({ label: 'Your benefits', href: '/portal/employee/benefits', note: 'Where an election is made. This assistant does not enrol you in anything.' });
  if (catalogue.entries.length === 0) {
    r.looks.push(look(LABEL, 'not-configured', 'The catalogue was read and no benefit has been set up yet — none that you are ineligible for, none at all.'));
    r.paragraphs.push('The benefits catalogue was read and no benefit has been set up on this workspace yet. That is nothing to do with your eligibility: there is nothing in the catalogue.');
    return r;
  }
  const eligible = catalogue.entries.filter((e) => e.eligibility.eligible);
  const not = catalogue.entries.filter((e) => !e.eligibility.eligible);
  const lines = eligible.slice(0, 6).map((e) => {
    const rules = describeRules(e.benefit.rules);
    return e.benefit.name + ' — you qualify.' + (rules.length ? ' Conditions: ' + rules.join(' ') : '') + (e.enrolment ? ' You are already on it.' : '');
  });
  const notLines = not.slice(0, 4).map((e) => e.benefit.name + ' — you do not qualify yet. ' + (e.eligibility.unmet || []).join(' '));

  r.paragraphs.push(eligible.length === 0
    ? 'None of the benefits in the catalogue match your record yet. They are listed below with the reason, so you can see what would change it.'
    : eligible.length + (eligible.length === 1 ? ' benefit applies to you.' : ' benefits apply to you.'));
  r.paragraphs.push(...lines);
  if (notLines.length > 0) r.paragraphs.push(...notLines);
  r.looks.push(look(LABEL, 'hit', catalogue.entries.length + ' benefits, each evaluated against your own record.', catalogue.entries.length));
  r.citations.push({
    kind: 'The benefits catalogue and your own record',
    title: 'Benefits, with your eligibility',
    href: '/portal/employee/benefits',
    passage: lines.concat(notLines).join(' '),
    why: 'Each benefit was evaluated against your own employee record by the eligibility rules stored with it. The conditions quoted are the stored rules, said as sentences.',
  });
  return r;
}

// -------------------------------------------------------------------------------------------------
// THE ENTRY POINT
// -------------------------------------------------------------------------------------------------

/**
 * ANSWER ONE EMPLOYEE QUESTION.
 *
 * Never throws. Every failure it can have is a shaped answer with a named human on it, because an
 * exception out of this function would be a blank screen where somebody asked about their pay.
 */
export async function askEmployee(
  rawQuestion: string,
  asker: EmployeeAsker,
  opts: AskEmployeeOptions = {},
): Promise<AskAnswer> {
  const question = normalizeQuestion(rawQuestion);
  const viewer = makeViewer(
    { id: asker.userId },
    { permissions: asker.permissions, employeeId: asker.employeeId, hasWorkspace: asker.hasWorkspace },
  );

  const base = {
    production: 'templated' as const,
    productionNote: 'This answer was assembled from the sources below.',
    degraded: false,
    clearedFloor: false,
    doItHere: [] as DoItHere[],
    citations: [] as Citation[],
    looked: [] as Look[],
  };

  if (question.length < QUESTION_MIN) {
    return {
      ...base,
      status: 'unknown',
      scopeClass: 'employee-general',
      intent: 'unknown',
      paragraphs: ['Ask a whole question and this will search the handbook and your own records for it. A word or two is not enough to search on.'],
      looked: [look('Nothing', 'not-searched', 'No search was run: the question was too short to retrieve anything on.')],
      escalation: await escalationFor('unknown', asker.employeeId),
    };
  }

  // ===============================================================================================
  // THE THREE REFUSALS. Before any retrieval, and none of them consults a capability — there is no
  // level of authority at which the first of them becomes answerable.
  // ===============================================================================================

  if (isHealthQuestion(question)) {
    return {
      ...base,
      status: 'refused',
      scopeClass: 'health',
      intent: 'health',
      paragraphs: [
        'This assistant has no access to health or wellness information, and that is deliberate rather than a limitation of what it happens to have been given.',
        'No administrator has it either, and neither does the founder. The wellness system is gated so that no individual record can be read by anybody, and this assistant deliberately has no path to it — not even a filtered one, because a filtered path is still a path.',
        'For anything you need on this, speak to a person directly. Nothing about this question has been stored against your name.',
      ],
      looked: [look('Health and wellness records', 'out-of-scope', 'Not searched, and there is no version of this assistant that would search them.')],
      escalation: [{
        label: 'Speak to the people desk',
        href: SUPPORT_PAGE + '?category=hr',
        note: 'Raise it with a person. This question has not been logged against you.',
      }],
    };
  }

  if (mentionsAnotherPerson(question)) {
    return {
      ...base,
      status: 'refused',
      scopeClass: 'about-another',
      intent: 'about-another',
      paragraphs: [
        'This reads as a question about somebody else, and this assistant only ever reads your own records.',
        'If you manage the person you are asking about, the answer is already on the screens built for it: approvals show what is waiting on you, and your team screen shows what your reports have shared with you. Those resolve the relationship per record from the organization graph, which is the right place for it to be decided.',
        'If it was your own record you meant, ask it again saying "my" — for example "how much leave do I have left".',
      ],
      looked: [look('Other people’s records', 'out-of-scope', 'Not searched. There is no path from this assistant to another person’s record, so this is a refusal rather than an empty result.')],
      doItHere: [
        { label: 'Approvals waiting on you', href: '/portal/approvals', note: 'Whatever is genuinely yours to decide.' },
        { label: 'Your team', href: '/portal/team', note: 'Resolved per person from the organization graph.' },
      ],
      escalation: await escalationFor('unknown', asker.employeeId),
    };
  }

  if (isActionRequest(question)) {
    return {
      ...base,
      status: 'refused',
      scopeClass: 'action',
      intent: 'action',
      paragraphs: [
        'This assistant explains and points; it does not do. It cannot approve anything, submit anything, or change a record — not for you and not for anybody.',
        'That is a deliberate limit rather than a missing feature. An assistant that can act is an assistant that can be talked into acting, and the things being asked for here are the things that need a person deciding them.',
        'The screens below are where each of them is actually done, by you.',
      ],
      looked: [look('Anything that would change a record', 'out-of-scope', 'Not attempted. Nothing in this assistant writes.')],
      doItHere: [
        { label: 'Leave', href: '/portal/employee/leave', note: 'Apply, and see what you have already filed.' },
        { label: 'Expenses', href: '/portal/employee/expenses', note: 'Make a claim, and track one you already made.' },
        { label: 'Approvals', href: '/portal/approvals', note: 'Decide what is waiting on you.' },
      ],
      escalation: await escalationFor('unknown', asker.employeeId),
    };
  }

  // ===============================================================================================
  // RETRIEVAL
  // ===============================================================================================

  const intent = classifyEmployee(question);
  const personal: EmployeeIntent[] = [
    'leave.balance', 'leave.approver', 'training.assigned', 'expense.claim',
    'payslip.where', 'payslip.line', 'benefits.mine', 'manager.who',
  ];
  const wantsPersonal = personal.indexOf(intent) >= 0;

  const looks: Look[] = [];
  const citations: Citation[] = [];
  const paragraphs: string[] = [];
  const doItHere: DoItHere[] = [];
  let degraded = false;

  // The handbook, for every question. A personal fact and what the policy says about it are two
  // different things and a person asking one usually wants both.
  const handbook = await readHandbook(viewer, question, wantsPersonal ? 2 : 4);
  looks.push(handbook.look);
  citations.push(...handbook.citations);
  degraded = degraded || handbook.degraded;

  let scopeClass: AskAnswer['scopeClass'] = wantsPersonal ? 'employee-self' : 'employee-general';

  if (wantsPersonal && !asker.employeeId) {
    scopeClass = 'no-workspace';
    looks.push(look('Your own employee record', 'not-configured', 'This account is not linked to an employee record, so there is nothing personal to read. That is the ordinary state for an administrator or a founder account, not a fault.'));
    paragraphs.push('This account is not linked to an employee record, so there is nothing personal to read for it — no leave balance, no payslip, no assignment list. That is normal for an administrator or founder account rather than something broken.');
  } else if (wantsPersonal && asker.employeeId) {
    const id = asker.employeeId;
    let facts: FactResult = noFacts();
    if (intent === 'leave.balance') facts = await leaveBalanceFacts(id);
    else if (intent === 'leave.approver') facts = await approverFacts('leave', id, 'a leave request');
    else if (intent === 'manager.who') facts = await managerFacts(id);
    else if (intent === 'training.assigned') facts = await trainingFacts(id);
    else if (intent === 'payslip.where') facts = await payslipFacts(id, false);
    else if (intent === 'payslip.line') facts = await payslipFacts(id, true);
    else if (intent === 'expense.claim') facts = await expenseFacts(id);
    else if (intent === 'benefits.mine') facts = await benefitFacts(id);
    paragraphs.push(...facts.paragraphs);
    citations.push(...facts.citations);
    looks.push(...facts.looks);
    doItHere.push(...facts.doItHere);
    degraded = degraded || facts.degraded;
  }

  // "HOW DO I APPLY FOR LEAVE" is two questions: where the screen is, and who it then goes to. The
  // second is a real retrieval — the approval engine resolving the route from the organization graph
  // — so it can be cited. The first is navigation, and navigation is not a fact claim: it is offered
  // as a link and it never counts toward the floor.
  if (intent === 'leave.apply') {
    doItHere.push({ label: 'Apply for leave', href: '/portal/employee/leave', note: 'The form is here. This assistant does not file it for you.' });
    if (asker.employeeId) {
      const route = await approverFacts('leave', asker.employeeId, 'a leave request');
      paragraphs.push(...route.paragraphs);
      citations.push(...route.citations);
      looks.push(...route.looks);
      degraded = degraded || route.degraded;
    } else {
      looks.push(look('The approval route, from the organization graph', 'out-of-scope', 'This account has no employee record, so no route can be resolved for it.'));
    }
  }
  if (intent === 'expense.claim') {
    if (asker.employeeId) {
      const route = await approverFacts('expenses', asker.employeeId, 'an expense claim');
      paragraphs.push(...route.paragraphs);
      citations.push(...route.citations);
      looks.push(...route.looks);
      degraded = degraded || route.degraded;
    }
  }

  if (handbook.citations.length > 0) {
    paragraphs.push(handbook.citations.length === 1
      ? 'What the handbook says about this is quoted below, with a link to the whole article.'
      : 'What the handbook says about this is quoted below, with links to the whole articles.');
  }

  // ===============================================================================================
  // THE FLOOR
  // ===============================================================================================
  //
  // Cleared by a citation and by nothing else. A link is not a citation, a suggestion is not a
  // citation, and a sentence this file wrote about how things generally work would not be a citation
  // either — which is why there are none of those. Below the floor the answer is "I do not know" and
  // a person, and the row it writes to the log is the most useful row in that table.

  const clearedFloor = citations.length > 0;
  const status: AskAnswer['status'] = clearedFloor
    ? (degraded ? 'partial' : 'answered')
    : (doItHere.length > 0 ? 'partial' : 'unknown');

  if (!clearedFloor) {
    paragraphs.push(
      degraded
        ? 'Nothing that answers this could be retrieved, and part of the search did not run — so this is not the same as "it is not written down". What could not be read is named under "where this looked".'
        : 'Nothing that answers this was found. Rather than put together something that sounds right, here is the person who will know.',
    );
    if (doItHere.length > 0) {
      paragraphs.push('The screen below is where this is done, but what the company\'s own policy says about it is not written down anywhere this could search.');
    }
  }

  let production: AskAnswer['production'] = 'templated';
  let productionNote = 'This answer was assembled from the sources below, word for word from what was retrieved. No language model was involved.';

  if (opts.useModel && paragraphs.length > 0) {
    const { rephrase } = await import('./rephrase');
    const verdict = await rephrase({
      text: paragraphs.join('\n\n'),
      feature: 'ask.employee',
      userId: asker.userId,
    });
    productionNote = verdict.note;
    if (verdict.accepted) {
      production = 'model-rephrased';
      paragraphs.length = 0;
      paragraphs.push(...verdict.text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean));
    }
  }

  return {
    status,
    paragraphs,
    citations,
    looked: looks,
    doItHere,
    production,
    productionNote,
    escalation: await escalationFor(intent, asker.employeeId),
    scopeClass,
    intent,
    clearedFloor,
    degraded,
  };
}
