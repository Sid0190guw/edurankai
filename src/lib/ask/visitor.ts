// src/lib/ask/visitor.ts — THE PUBLIC ANSWER. Same rules, a different corpus, and one extra rule.
//
// =================================================================================================
// WHAT A VISITOR MAY BE TOLD
// =================================================================================================
//
// Everything here comes from something published: a programme in the catalogue, a course marked
// published and public, a content page marked published. Nothing else is read, and there is no
// signed-in state to widen it — a visitor retrieval is a visitor retrieval whoever happens to be
// looking, because the corpus is selected by the absence of a session rather than filtered by it.
//
// THE EXTRA RULE IS ABOUT MONEY. A fee comes from the fee engine or it is not stated. Not from a
// price column read directly, not from a sentence somebody wrote on a page, not from a model, and
// never from an average or a range this file worked out. src/lib/fee-engine.ts is the only source,
// it returns integer minor units, and when a course has a stored price but no schedule it SAYS SO —
// `derivedFromLegacyPrice` — so the honest answer is "there is a price recorded but not a full fee
// schedule" rather than a confident total. Nothing here adds two numbers together.
//
// AND NO PRICE-FIRST FRAMING. A visitor who asks what something costs gets the answer. A visitor who
// asks what a programme is does not get a price bolted onto it.
//
// =================================================================================================
// WHAT THIS MAY NEVER SAY
// =================================================================================================
//
// EduRankAI is the technology platform. Accredited partners award credentials. This file never says
// "we award", never says "our degree", and never calls itself a university or an institution.
//
// IT ALSO NEVER NAMES A REAL COMPANY, and that took one specific decision. aquin_programs stores a
// `partner_type` per programme, and its seeded values name real organisations — so that column is
// read for nothing and quoted nowhere. What a visitor actually wanted to know is what the delivery
// model already says in this platform's own words, and that is what is quoted instead. A stored
// regulatory note IS quoted, because it is a statutory disclosure that the public programme
// catalogue already prints.
//
// src/lib/ask/rephrase.ts checks the awarding claim again on the way out of the model, because an
// instruction in a prompt is a request and a check on the output is a rule.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { listProgramsResult, modelByN, type Program } from '@/lib/aquin-programs';
import { courseFeeLines, formatMinor } from '@/lib/fee-engine';
import { rankResults, type IndexDoc } from '@/lib/search-index';
import {
  normalizeQuestion, classifyVisitor, isHealthQuestion, mentionsAnotherPerson, isActionRequest,
  QUESTION_MIN, type VisitorIntent,
} from './intent';
import type { AskAnswer, Citation, DoItHere, Escalation, Look } from './types';

// postgres-js resolves to a plain array, never a { rows } object. Declared at the top: `const` is
// not hoisted, and a handler reaching a later declaration has taken pages down in this repo before.
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const logFail = (tag: string, e: any) => console.error('[ask/visitor] ' + tag, reasonOf(e));

const look = (label: string, outcome: Look['outcome'], note: string, count = 0): Look =>
  ({ label, outcome, note, count });

/** The routes to a person on the public side. The founder's line is a PAID consultancy booking and
 *  is deliberately not among them: offering it as "talk to someone" would route a visitor with a
 *  question at a paywall. */
const PUBLIC_ESCALATION: readonly Escalation[] = [
  {
    label: 'Send a message and a person will answer',
    href: '/contact',
    note: 'It goes to the team rather than into a queue nobody reads.',
  },
  {
    label: 'Open the help panel on any page',
    href: null,
    note: 'The help button on this site is a conversation with a person, not with software.',
  },
];

const trimText = (v: any, max: number): string => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
};

// -------------------------------------------------------------------------------------------------
// THE THREE PUBLIC CORPORA. Each returns its own three states.
// -------------------------------------------------------------------------------------------------

interface CorpusResult {
  citations: Citation[];
  look: Look;
  degraded: boolean;
  /** Kept for the fee path, which needs the matched course rather than only its citation. */
  courses?: { id: string; title: string; slug: string }[];
}

/** PUBLISHED PROGRAMMES. listProgramsResult() distinguishes "not seeded" from "none" from "failed". */
async function readProgrammes(question: string, limit = 4): Promise<CorpusResult> {
  const LABEL = 'The published programme catalogue';
  const r = await listProgramsResult();
  if (!r.ok) {
    return { citations: [], degraded: true, look: look(LABEL, 'unreadable', 'The programme catalogue could not be read, so this answer may be missing programmes that exist. The database said: ' + r.reason + '.') };
  }
  if (r.programs.length === 0) {
    return { citations: [], degraded: false, look: look(LABEL, 'not-configured', 'No programme has been published yet — not none that match, none at all.') };
  }
  const docs: IndexDoc[] = r.programs.map((p) => ({
    id: p.slug, type: 'programme', title: p.name,
    body: [p.level, p.discipline, p.regulatoryNote].filter(Boolean).join(' '),
  }));
  const ranked = rankResults(question, docs).slice(0, limit);
  const chosen: Program[] = (ranked.length > 0 ? ranked.map((d) => d.id) : r.programs.slice(0, limit).map((p) => p.slug))
    .map((slug) => r.programs.find((p) => p.slug === slug))
    .filter((p): p is Program => !!p);

  return {
    degraded: false,
    look: look(LABEL, 'hit', ranked.length > 0
      ? ranked.length + (ranked.length === 1 ? ' programme matched out of ' : ' programmes matched out of ') + r.programs.length + ' published.'
      : 'Nothing matched the wording, so the ' + chosen.length + ' most recently ordered of ' + r.programs.length + ' published programmes are shown.', chosen.length),
    citations: chosen.map((p) => {
      const model = modelByN(p.deliveryModel);
      // THE STORED partner_type COLUMN IS NOT QUOTED, and that is deliberate rather than an
      // oversight. Its seeded values name real organisations, and this codebase does not name a real
      // company in anything a visitor reads. The delivery model's own description says the same
      // thing in the platform's own words, which is what a visitor actually wanted to know.
      const sentence = [
        p.name + ' is a ' + p.level.toLowerCase() + ' programme in ' + p.discipline + '.',
        'Delivery: ' + model.title + ' — academics ' + model.academics.toLowerCase() + ', practical work: ' + model.practical.toLowerCase() + '.',
        'The credential is awarded by the accredited partner the programme is delivered with, not by this platform.',
        p.regulatoryNote ? p.regulatoryNote : '',
      ].filter(Boolean).join(' ');
      return {
        kind: 'Programme catalogue',
        title: p.name,
        href: '/aquintutor/programs',
        passage: trimText(sentence, 400),
        why: 'A published programme in the catalogue.',
      };
    }),
  };
}

/** PUBLISHED, PUBLIC COURSES. The visibility predicate is the one the course catalogue itself uses,
 *  reused verbatim rather than restated: is_published AND access_type IN ('public','both'). */
async function readCourses(question: string, limit = 4): Promise<CorpusResult> {
  const LABEL = 'The published course catalogue';
  let all: any[] = [];
  try {
    all = rows(await db.execute(sql`
      SELECT c.id, c.title, c.slug, c.subtitle, c.short_desc
        FROM training_courses c
       WHERE c.is_published = true AND c.access_type IN ('public', 'both')
       ORDER BY c.created_at DESC
       LIMIT 300`));
  } catch (e: any) {
    logFail('readCourses', e);
    return { citations: [], degraded: true, look: look(LABEL, 'unreadable', 'The course catalogue could not be read, so this answer may be missing courses that exist. The database said: ' + reasonOf(e) + '.') };
  }
  if (all.length === 0) {
    return { citations: [], degraded: false, look: look(LABEL, 'not-configured', 'No course has been published for public view yet — not none that match, none at all.') };
  }
  const docs: IndexDoc[] = all.map((c) => ({
    id: String(c.id), type: 'course', title: String(c.title || ''),
    body: [c.subtitle, c.short_desc].filter(Boolean).join(' '),
  }));
  const ranked = rankResults(question, docs).slice(0, limit);
  if (ranked.length === 0) {
    return {
      citations: [], degraded: false, courses: [],
      look: look(LABEL, 'empty', all.length + (all.length === 1 ? ' published course was searched' : ' published courses were searched') + ' by title and description. None of them matched.'),
    };
  }
  const matched = ranked.map((d) => all.find((c) => String(c.id) === d.id)).filter(Boolean);
  return {
    degraded: false,
    courses: matched.map((c: any) => ({ id: String(c.id), title: String(c.title || ''), slug: String(c.slug || '') })),
    look: look(LABEL, 'hit', ranked.length + (ranked.length === 1 ? ' course matched out of ' : ' courses matched out of ') + all.length + ' published for public view.', ranked.length),
    citations: matched.map((c: any) => ({
      kind: 'Course catalogue',
      title: String(c.title || ''),
      href: c.slug ? '/aquintutor/courses/' + encodeURIComponent(String(c.slug)) : '/aquintutor/courses',
      passage: trimText([c.subtitle, c.short_desc].filter(Boolean).join(' ') || String(c.title || ''), 320),
      why: 'A published course that is open to the public.',
    })),
  };
}

/** PUBLISHED PAGES. is_published = true, which is exactly what /p/[slug] serves. */
async function readPages(question: string, limit = 3): Promise<CorpusResult> {
  const LABEL = 'Published pages on this site';
  let all: any[] = [];
  try {
    all = rows(await db.execute(sql`
      SELECT id, slug, title, meta_description, body
        FROM content_pages
       WHERE is_published = true
       ORDER BY updated_at DESC
       LIMIT 200`));
  } catch (e: any) {
    logFail('readPages', e);
    return { citations: [], degraded: true, look: look(LABEL, 'unreadable', 'The published pages could not be read, so something written down may be missing from this answer. The database said: ' + reasonOf(e) + '.') };
  }
  if (all.length === 0) {
    return { citations: [], degraded: false, look: look(LABEL, 'not-configured', 'No page has been published yet — not none that match, none at all.') };
  }
  const docs: IndexDoc[] = all.map((p) => ({
    id: String(p.id), type: 'page', title: String(p.title || ''),
    body: [p.meta_description, p.body].filter(Boolean).join(' '),
  }));
  const ranked = rankResults(question, docs).slice(0, limit);
  if (ranked.length === 0) {
    return {
      citations: [], degraded: false,
      look: look(LABEL, 'empty', all.length + (all.length === 1 ? ' published page was searched' : ' published pages were searched') + ' by title and text. None of them matched.'),
    };
  }
  return {
    degraded: false,
    look: look(LABEL, 'hit', ranked.length + (ranked.length === 1 ? ' page matched.' : ' pages matched.'), ranked.length),
    citations: ranked.map((d) => {
      const page = all.find((p) => String(p.id) === d.id);
      return {
        kind: 'Published page',
        title: String(page?.title || d.title),
        href: '/p/' + encodeURIComponent(String(page?.slug || '')),
        passage: passageOf(String(page?.body || page?.meta_description || ''), question),
        why: 'A published page on this site.',
      };
    }),
  };
}

/**
 * The sentences of a page that this question's words appear in. Same idea as passageFor() in
 * src/lib/knowledge-base.ts, and kept local rather than exported from there: that one takes a
 * KbArticle and this one takes a body, and giving the staff module a public-corpus entry point would
 * be one more door into a module whose whole job is deciding who may read what.
 */
function passageOf(body: string, question: string, max = 320): string {
  const flat = String(body || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[#>*_`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return '';
  const parts = flat.split(/(?<=[.!?])\s+/).filter((p) => p.trim().length > 0);
  const words = String(question || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2).slice(0, 8);
  let best = -1;
  let bestScore = 0;
  parts.forEach((p, i) => {
    const low = p.toLowerCase();
    let score = 0;
    for (const w of words) if (low.indexOf(w) >= 0) score += 1;
    if (score > bestScore) { bestScore = score; best = i; }
  });
  const start = best < 0 ? 0 : best;
  let passage = parts[start] || flat;
  let next = start + 1;
  while (passage.length < max - 60 && next < parts.length && passage.length + parts[next].length + 1 <= max) {
    passage = passage + ' ' + parts[next];
    next += 1;
  }
  return trimText(passage, max);
}

/**
 * THE FEE, FROM THE FEE ENGINE OR NOT AT ALL.
 *
 * courseFeeLines() THROWS on a course that does not exist and on a schedule that mixes currencies —
 * it refuses rather than averaging a rate — so both are caught here and reported as "no figure",
 * never smoothed into one. When it answers with `derivedFromLegacyPrice` the answer says that in
 * words: there is a price recorded, there is no full schedule behind it, and the notes the engine
 * itself produced are quoted rather than summarised.
 *
 * NOTHING IS ADDED UP HERE. Each line is stated as the engine stated it.
 */
async function readFee(course: { id: string; title: string; slug: string }): Promise<CorpusResult> {
  const LABEL = 'The fee engine, for ' + course.title;
  try {
    const fee = await courseFeeLines(course.id);
    if (fee.free) {
      return {
        degraded: false,
        look: look(LABEL, 'hit', 'The fee engine answered: this course carries no charge.', 1),
        citations: [{
          kind: 'Fee engine',
          title: 'Charges for ' + course.title,
          href: course.slug ? '/aquintutor/courses/' + encodeURIComponent(course.slug) : '/aquintutor/courses',
          passage: (fee.notes.join(' ') || 'This course has no charges.'),
          why: 'Every figure about money comes from the fee engine. Nothing on this page is a price typed into an answer.',
        }],
      };
    }
    const lines = fee.lines.map((l) => l.label + ': ' + formatMinor(l.amountMinor, fee.currency) + (l.mandatory ? '' : ' (optional)') + '.');
    const passage = lines.concat(fee.notes).join(' ');
    return {
      degraded: false,
      look: look(LABEL, 'hit', fee.derivedFromLegacyPrice
        ? 'The fee engine answered, and said this course has no full fee schedule — the figure was derived from the single price stored against it.'
        : fee.lines.length + (fee.lines.length === 1 ? ' charge line.' : ' charge lines.'), fee.lines.length),
      citations: [{
        kind: 'Fee engine',
        title: 'Charges for ' + course.title,
        href: course.slug ? '/aquintutor/courses/' + encodeURIComponent(course.slug) : '/aquintutor/courses',
        passage: trimText(passage, 500),
        why: fee.derivedFromLegacyPrice
          ? 'From the fee engine. It reports that this is derived from a single stored price rather than a full schedule, and that is said here rather than hidden.'
          : 'From the fee engine, which is the only source of a figure about money on this site.',
      }],
    };
  } catch (e: any) {
    logFail('courseFeeLines', e);
    return {
      citations: [], degraded: true,
      look: look(LABEL, 'unreadable', 'The fee engine did not return a figure for this course, so none is given. It said: ' + reasonOf(e) + '.'),
    };
  }
}

// -------------------------------------------------------------------------------------------------
// THE ENTRY POINT
// -------------------------------------------------------------------------------------------------

export interface AskVisitorOptions {
  useModel?: boolean;
}

/**
 * ANSWER ONE PUBLIC QUESTION. Never throws, and never knows who asked.
 *
 * There is no user id parameter and there is deliberately no way to add one at the call site: a
 * visitor question is stored without identity, and the cheapest way to keep that true is for the
 * function that produces the answer to have nothing to store.
 */
export async function askVisitor(rawQuestion: string, opts: AskVisitorOptions = {}): Promise<AskAnswer> {
  const question = normalizeQuestion(rawQuestion);

  const base = {
    scopeClass: 'visitor' as const,
    production: 'templated' as const,
    productionNote: 'This answer was assembled from the sources below.',
    degraded: false,
    clearedFloor: false,
    doItHere: [] as DoItHere[],
    citations: [] as Citation[],
    looked: [] as Look[],
    escalation: PUBLIC_ESCALATION.slice(),
  };

  if (question.length < QUESTION_MIN) {
    return {
      ...base,
      status: 'unknown',
      intent: 'unknown',
      paragraphs: ['Ask a whole question and this will search what has been published: the programmes, the courses and the pages of this site.'],
      looked: [look('Nothing', 'not-searched', 'No search was run: the question was too short to retrieve anything on.')],
    };
  }

  // The same three refusals as the workplace side. A visitor cannot have a record here, so
  // "somebody else's leave" typed into a public box is a question about a person either way.
  if (isHealthQuestion(question) || mentionsAnotherPerson(question)) {
    return {
      ...base,
      status: 'refused',
      scopeClass: isHealthQuestion(question) ? 'health' : 'about-another',
      intent: isHealthQuestion(question) ? 'health' : 'about-another',
      paragraphs: [
        'This assistant answers questions about the programmes, the courses and what is published on this site. It holds no record about any person and cannot look one up.',
        'For anything about an individual, a person will help.',
      ],
      looked: [look('Anything about a person', 'out-of-scope', 'Not searched. There is no record of any person reachable from this assistant.')],
    };
  }

  if (isActionRequest(question)) {
    return {
      ...base,
      status: 'refused',
      intent: 'action',
      paragraphs: [
        'This assistant explains and points; it does not do. It cannot enrol you, apply for you, or take a payment.',
        'The pages below are where each of those is done, by you, and a person is one message away if something is not clear.',
      ],
      looked: [look('Anything that would change a record', 'out-of-scope', 'Not attempted. Nothing in this assistant writes.')],
      doItHere: [
        { label: 'Browse the programmes', href: '/aquintutor/programs', note: 'What is offered, and how each one is delivered.' },
        { label: 'Browse the courses', href: '/aquintutor/courses', note: 'What is published and open to the public.' },
      ],
    };
  }

  const intent: VisitorIntent = classifyVisitor(question);
  const looks: Look[] = [];
  const citations: Citation[] = [];
  const paragraphs: string[] = [];
  const doItHere: DoItHere[] = [];
  let degraded = false;

  const take = (r: CorpusResult) => {
    looks.push(r.look);
    citations.push(...r.citations);
    degraded = degraded || r.degraded;
    return r;
  };

  if (intent === 'fees') {
    // A FEE ANSWER NEEDS A NAMED COURSE. Without one there is nothing the fee engine can be asked,
    // and a general sentence about what things cost would be exactly the invention this forbids.
    const courses = take(await readCourses(question, 3));
    const named = (courses.courses || [])[0] || null;
    if (named) {
      take(await readFee(named));
      paragraphs.push('Charges are recorded per course. For ' + named.title + ', this is what the fee engine holds:');
    } else {
      looks.push(look('The fee engine', 'not-searched', 'No published course could be matched to this question, so the fee engine was not asked. It is only ever asked about a specific course.'));
      paragraphs.push('Charges are recorded per course rather than as one figure, so this needs the course named. Nothing is quoted here that did not come from the fee engine, and no general figure exists to give.');
    }
    doItHere.push({ label: 'Browse the courses', href: '/aquintutor/courses', note: 'Open a course to see what it covers.' });
  } else if (intent === 'programmes' || intent === 'partner.awards') {
    take(await readProgrammes(question, 4));
    take(await readPages(question, 2));
    if (intent === 'partner.awards') {
      paragraphs.push('EduRankAI is the technology platform. The credential is awarded by the accredited partner a programme is delivered with, never by this platform, and what each programme records about its partner and its regulatory position is quoted below.');
    }
    doItHere.push({ label: 'The programme catalogue', href: '/aquintutor/programs', note: 'Every published programme and how it is delivered.' });
  } else if (intent === 'courses') {
    take(await readCourses(question, 5));
    doItHere.push({ label: 'The course catalogue', href: '/aquintutor/courses', note: 'Everything published and open to the public.' });
  } else if (intent === 'apply' || intent === 'cohort.start') {
    take(await readPages(question, 3));
    take(await readProgrammes(question, 2));
    doItHere.push({ label: 'The programme catalogue', href: '/aquintutor/programs', note: 'Each programme page is where its own route in is described.' });
  } else {
    take(await readPages(question, 3));
    take(await readProgrammes(question, 2));
    take(await readCourses(question, 2));
  }

  const clearedFloor = citations.length > 0;
  const status: AskAnswer['status'] = clearedFloor
    ? (degraded ? 'partial' : 'answered')
    : (doItHere.length > 0 ? 'partial' : 'unknown');

  if (clearedFloor && paragraphs.length === 0) {
    paragraphs.push('Here is what is published about this, quoted from the source with a link to the whole thing.');
  }
  if (!clearedFloor) {
    paragraphs.push(degraded
      ? 'Nothing that answers this could be retrieved, and part of the search did not run — so this is not the same as "it is not published". What could not be read is named under "where this looked".'
      : 'Nothing published on this site answers this. Rather than put together something that sounds right, here is how to reach a person who can tell you properly.');
  }

  let production: AskAnswer['production'] = 'templated';
  let productionNote = 'This answer was assembled from the sources below, word for word from what was retrieved. No language model was involved.';

  if (opts.useModel && paragraphs.length > 0) {
    const { rephrase } = await import('./rephrase');
    const verdict = await rephrase({ text: paragraphs.join('\n\n'), feature: 'ask.visitor', userId: null });
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
    escalation: PUBLIC_ESCALATION.slice(),
    scopeClass: 'visitor',
    intent,
    clearedFloor,
    degraded,
  };
}
