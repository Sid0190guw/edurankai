# AES-100 · Vol II · Part XIII · Ch 56 — Meta-Cognition & Reflective Intelligence

**Status:** specified + reference implementation (`public/aquin-metacognition.js`,
Node-tested, 7 cases). The layer that makes a powerful reasoner HONEST about the
limits of its own reasoning. It never produces educational conclusions — it audits
the ones the other engines produce.

## Requirements (normative)
- **META-001** Confidence calibration: a claim's stated confidence SHALL be checked
  against its evidence; overconfidence (high confidence, thin/conflicting evidence)
  SHALL be down-calibrated, never passed through. *(tests 1,2)*
- **META-002** Assumption analysis: unstated load-bearing assumptions SHALL be
  surfaced; an unverified load-bearing assumption makes a conclusion provisional,
  not a fact. *(test 3)*
- **META-003** Blind-spot detection: the engine SHALL name what the reasoning did
  NOT consider (missing factors, unrepresented populations). *(test 4)*
- **META-004** Alternative strategies: an underperforming approach SHALL trigger
  proposal of *different* approaches — never repetition of the failing one. *(test 5)*
- **META-005** Reflective memory: past reasoning + actual outcome SHALL be recorded;
  measured overconfidence SHALL adjust future calibration toward truth. *(test 6)*
- **META-006** Meta-cognition MAY lower confidence, add caveats, request more
  evidence — it SHALL NOT manufacture certainty or change a conclusion's content,
  only how much it should be trusted. *(test 7)*

## Interface
```
MetaCognition: calibrate(claim) · assumptions(claim) · blindSpots(claim)
  alternatives(attempt, catalog) · reflect(outcome) · review(claim, {attempt,catalog})
  reflections() · calibrationBias()
```
Reference: `public/aquin-metacognition.js`. Harness: `meta_test.js` (7/7). Sits
above Cognition (`aquin-cognition.js`) + Consistency (`aquin-consistency.js`) and
consumes their outputs. It is the auditor, not the oracle.
