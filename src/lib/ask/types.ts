// src/lib/ask/types.ts — THE SHAPE OF AN ANSWER, AND WHY EVERY FIELD ON IT IS THERE.
//
// =================================================================================================
// THE ONE RULE THIS FILE ENCODES
// =================================================================================================
//
// An answer is ASSEMBLED FROM THINGS THAT WERE RETRIEVED, and it carries them. There is no field on
// AskAnswer for "what the model said"; there is a field for the passages it was built from and a
// field for where it looked. A confident wrong answer about a notice period, a leave entitlement, a
// fee or a refund is a real harm to a real person, and it arrives wearing exactly the same clothes
// as a right one — so the clothes are what this type is about.
//
// THREE THINGS A SCREEN MUST BE ABLE TO TELL APART, everywhere, and which one flat list of results
// can never express:
//
//   NOT CONFIGURED   — nothing has been written yet. On a fresh deployment nothing seeds kb_articles,
//                      so "the handbook does not mention notice periods" and "there is no handbook"
//                      are different sentences and only one of them is true.
//   GENUINELY EMPTY  — the query ran, the corpus exists, and nothing in it matched.
//   COULD NOT READ   — the query did not complete. Rendering this as "nothing found" tells somebody
//                      their company has no leave policy. It is the failure this module exists to
//                      not have.
//
// That is what LookOutcome is for, and every retrieval attempt records one whether it succeeded or
// not — including the ones that were never made, because "I did not look at the policies" and "it is
// not in the policies" are the two sentences a person most needs to be able to tell apart.

/** Which surface asked. Employee questions and visitor questions are different retrievals. */
export type AskSurface = 'employee' | 'visitor';

/**
 * WHO IS ASKING, RESOLVED SERVER-SIDE, BEFORE ANYTHING IS RETRIEVED.
 *
 * This is not a label on the output. It selects the corpus. The same question from a visitor and
 * from an employee is two different retrievals against two different sets of documents, and the
 * documents one of them may not see are never fetched at all — there is no version of the pipeline
 * where they are read and then hidden.
 */
export type ScopeClass =
  /** Nobody is signed in. Public catalogue and published pages only. */
  | 'visitor'
  /** Signed in, with an employee record, asking about their OWN record. */
  | 'employee-self'
  /** Signed in, asking a policy or how-to question. No personal record is read. */
  | 'employee-general'
  /** Signed in with no hr_employees row. An ordinary state for a founder or an admin account, NOT an
   *  error — it means there are no personal facts to read, and the handbook is still readable. */
  | 'no-workspace'
  /** Refused: the question would return a row about somebody else. */
  | 'about-another'
  /** Refused: health or wellness. Out of bounds to EVERYONE including the founder. There is no
   *  filtered version of this and no path to the data from here. */
  | 'health'
  /** Refused: the asker wanted the assistant to DO something. It answers; it does not act. */
  | 'action';

/**
 * A SOURCE THE ANSWER WAS BUILT FROM, with the words it was built from.
 *
 * `passage` is never a paraphrase. It is characters out of the retrieved document or the retrieved
 * record, with markdown punctuation flattened. A citation that has been reworded is not a citation —
 * it is the assistant's own prose wearing a document's name.
 */
export interface Citation {
  /** What kind of thing this is, in the reader's words. "Company policy", "Your own leave record". */
  kind: string;
  title: string;
  /** The screen or document this can be checked against. Null when there is no page to open. */
  href: string | null;
  /** The sentences the claim came from. Never a whole body. */
  passage: string;
  /** Why this one was selected, in words. A result nobody can explain is a result nobody trusts. */
  why: string;
}

/**
 * WHAT HAPPENED WHEN WE LOOKED SOMEWHERE.
 *
 * 'not-searched' is deliberately a first-class outcome. A person reading "nothing in the policies"
 * is entitled to know whether the policies were opened.
 */
export type LookOutcome =
  | 'hit'
  | 'empty'
  | 'unreadable'
  | 'not-configured'
  | 'not-searched'
  | 'out-of-scope';

export interface Look {
  /** The corpus, named so a person recognises it. */
  label: string;
  outcome: LookOutcome;
  /** A sentence rendered verbatim under the label. */
  note: string;
  /** How many things were found. Zero for every outcome except 'hit'. */
  count: number;
}

/**
 * HOW THE WORDS ON SCREEN WERE PRODUCED.
 *
 * A person reading an answer about their own pay is entitled to know whether a language model
 * touched it. 'templated' means the sentences were assembled by this code from retrieved values.
 * 'model-rephrased' means a model was given the templated answer and its sources and asked to say
 * the same thing better — and the result passed a validator that refuses any new number, any new
 * link and any change of length that could smuggle in a new claim.
 *
 * A MODEL NEVER SUPPLIES A FACT HERE. It only ever re-words text that was already assembled from
 * retrieved sources. When nothing is configured the answer degrades from prose to plainer prose —
 * never from an answer to nothing, and never from an answer to an invention.
 */
export type Production = 'templated' | 'model-rephrased';

/** The route to a person. Present on every answer, including the good ones. */
export interface Escalation {
  label: string;
  href: string | null;
  note: string;
}

/** A screen where a HUMAN does the thing. This assistant never does it. */
export interface DoItHere {
  label: string;
  href: string;
  note: string;
}

export type AskStatus =
  /** Retrieval cleared the floor and the answer is built from it. */
  | 'answered'
  /** Something real was retrieved, but not the thing that was asked. Say which part is missing. */
  | 'partial'
  /** Nothing retrieved answers this. Say so, and offer the human who can. */
  | 'unknown'
  /** The question is one this assistant must not answer. Say why, and offer the human. */
  | 'refused';

export interface AskAnswer {
  status: AskStatus;
  /** Paragraphs of plain text. Never HTML, never markdown — the surfaces render text nodes. */
  paragraphs: string[];
  citations: Citation[];
  /** Every corpus that was consulted, and every one that was not. Rendered, always. */
  looked: Look[];
  doItHere: DoItHere[];
  production: Production;
  /** Why production is what it is — including a rephrase that was attempted and refused. */
  productionNote: string;
  /** Never empty. Nobody should be trapped in a conversation with software about their own pay. */
  escalation: Escalation[];
  scopeClass: ScopeClass;
  /** The classifier's answer, for the log. Coarse on purpose. */
  intent: string;
  /**
   * DID ANYTHING RETRIEVED ACTUALLY ANSWER THE QUESTION?
   *
   * The most valuable column in the log is this one set to false: a question nothing could answer
   * names a policy nobody has written down.
   */
  clearedFloor: boolean;
  /** Something did not answer. No surface may print a confident "nothing found" over this. */
  degraded: boolean;
}
