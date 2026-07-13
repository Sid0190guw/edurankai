# AES-100 · Vol II · Part XV · Ch 62 — Educational Value & Ethics Intelligence Engine

**Status:** specified + reference implementation (`public/aquin-ethics.js`,
Node-tested, 8 cases). The DELIBERATIVE layer above the Constitutional Runtime.
Constitution (Ch 58): "is this PERMITTED?" — Ethics (Ch 62): "among permitted
actions, which best serves the learner and the mission?" It never claims moral
authority and never replaces human judgement.

## Requirements (normative)
- **ETHICS-001** Permitted-only: deliberates ONLY over constitutionally-permitted
  actions; a non-permitted option is never recommended. *(test 2)*
- **ETHICS-002** Multi-value, no dominant value: options scored across many
  educational values (learning quality, integrity, equity, dignity, autonomy,
  long-term growth, safety, transparency). *(tests 1,7)*
- **ETHICS-003** Long-term over short-term: an option raising short-term engagement
  but lowering long-term learning loses (usage != learning; consistent w/ Ch 49).
  *(test 1)*
- **ETHICS-004** Dignity is a HARD constraint: humiliating / public-comparison /
  manipulative / discriminatory options are REJECTED, not down-weighted. *(test 3)*
- **ETHICS-005** Fairness != identical treatment: appropriate-to-need scores as
  more fair than uniform treatment ignoring need. *(test 4)*
- **ETHICS-006** Human oversight: high-stakes, near-ties, and all-rejected cases
  are escalated; the engine assists, never replaces. *(tests 5,6)*
- **ETHICS-007** Full explainability + ethical provenance: values considered,
  stakeholders affected, trade-offs, why-this, alternatives, oversight. *(tests 7,8)*

## Interface
```
EthicsEngine: deliberate(options, context) -> { recommendation | requiresHumanReview,
  ranked, rejectedForDignity, excludedAsNotPermitted, explanation, disclaimer }
  scoreOption(option) · fairness(option)
option = { id, permitted, values:{...}, flags:[], shortTermEngagement,
           appropriateToNeed, uniformIgnoringNeed, stakeholders:[] }
```
Reference: `public/aquin-ethics.js`. Harness: `ethics_test.js` (8/8). It sits AFTER
the Constitution gate (Ch 58) and never authorizes a forbidden action; it consumes
Intent (Ch 61), World Model (Ch 59), and Safety (Ch 44) context.
