// ONE MESSAGE STRIP, TWO MEANINGS — and until now only one colour.
//
// Every screen in the Phase 3-6 family posts its form, builds a sentence, and redirects back with
// `?msg=`. The strip that prints it is styled green on all of them. So "Decision recorded." and
// "Nothing was saved: relation hr_loans does not exist" arrived on screen looking exactly the same:
// a green box saying something happened. That is the same failure mode as a blank panel that could
// mean "no rows" or "the query threw" — the reader cannot tell, so they assume the good one.
//
// This is deliberately a TEXT test rather than a second query parameter, because the messages are
// already written in plain English by the handlers and adding a `&tone=` to twenty redirect sites is
// twenty more places to forget. The vocabulary below is the vocabulary those handlers actually use;
// it is listed rather than guessed.
//
// It is one-directional on purpose: an unrecognised message stays in the neutral/success style, so
// the worst case is the behaviour that already exists, never a success wrongly painted as a failure.
const FAILURE_WORDS = [
  '^error\\b',
  '^halted\\b',
  '^not escalated\\b',
  '\\bcould not\\b',
  '\\bwas not\\b',
  '\\bwere not\\b',
  '\\bnothing was saved\\b',
  '\\bnothing here can be saved\\b',
  '\\bhalted\\b',
  '\\bcannot\\b',
  '\\bfailed\\b',
  '\\bneeds the\\b',
  '\\bnot something this page does\\b',
  '\\bnot one this page performs\\b',
  '\\bno award was raised\\b',
  '\\bnot available\\b',
  '\\bdid not\\b',
];

const FAILURE = new RegExp(FAILURE_WORDS.join('|'), 'i');

/**
 * True when a flash message is reporting that something did NOT happen, so the strip can be
 * painted as a failure rather than as a success.
 */
export function flashFailed(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return FAILURE.test(String(msg));
}
