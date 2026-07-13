# AES-100 · Vol II · Part XV · Ch 63 — Educational Context Intelligence Engine

**Status:** specified + reference implementation (`public/aquin-context.js`,
Node-tested, 7 cases). "How do I solve this equation?" is the same mathematics for
a Class-8 student, an IIT-JEE aspirant, a blind learner, or a Hindi-medium learner —
but the right educational RESPONSE differs completely. **Knowledge is universal;
educational meaning is contextual.**

## Requirements (normative)
- **CTX-001** Context is a first-class, versioned, inspectable Runtime Object (not a
  hidden prompt blob), with per-factor provenance of which layer set it. *(test 1)*
- **CTX-002** Hierarchical layers resolved by precedence (civilization < world <
  time < curriculum < institution < language < learner < mission < accessibility).
  *(test 4)*
- **CTX-003** One shared context: every Runtime Domain reads the SAME resolved
  object; no domain rebuilds context independently.
- **CTX-004** Same knowledge, different action: adapting one concept to two contexts
  yields two different responses (depth, language, format). *(test 2)*
- **CTX-005** Accessibility is a HARD requirement — survives every merge and shapes
  delivery format (audio-first for blind, dyslexia-friendly). *(tests 2,3)*
- **CTX-006** Low-bandwidth/offline shapes delivery. *(test 5)*
- **CTX-007** Explainability: factors considered, which CHANGED the response, which
  ignored, what extra context would help; + contextual provenance. *(tests 6,7)*

## Interface
```
ContextEngine: build(layers) -> Context Object · adapt(concept, ctx) -> response
  explain(ctx, adaptation)
layers = { learner, family, classroom, institution, curriculum, cultural,
           language, accessibility, mission, time, world, civilization }
```
Reference: `public/aquin-context.js`. Harness: `context_test.js` (7/7). Composes the
World Model (Ch 59), Time (Ch 60), Intent (Ch 61), Digital Twin, and Mission
context. With Ch 59–62 it completes the **Situational Intelligence Layer**.
