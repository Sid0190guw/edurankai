# AES-100 · Vol II · Part XV · Ch 64 — Educational Self-Model (Computational Self-Model)

**Status:** specified + reference implementation (`public/aquin-selfmodel.js`,
Node-tested, 8 cases). NOT a model of human consciousness — a systems-engineering
self-model: the OS's continuously-updated understanding of ITSELF. The structural
counterpart of Meta-Cognition (Ch 56): meta-cognition audits one conclusion; the
self-model audits the SYSTEM's standing capability and health. Both keep a powerful
system HONEST.

## Requirements (normative)
- **SELF-001** Honest capability introspection: "what can I do?" answers only from
  registered AND healthy Runtime Domains; a down domain is unavailable, never
  pretended. *(tests 1,6)*
- **SELF-002** Declared limitations: "what can I NOT do?" is explicit; an
  out-of-scope request returns "I cannot", not a fabricated attempt. *(tests 4,5)*
- **SELF-003** Confidence boundary → human escalation: a request below the
  competence threshold, touching a declared limitation, or needing a down domain
  triggers "ask for human assistance". *(tests 3,4,5,6)*
- **SELF-004** Graceful-degradation awareness: a domain failure shrinks the
  self-model's capability picture accordingly (it knows it is degraded). *(test 6)*
- **SELF-005** Failure-mode + resource awareness: exposes health, load, and known
  failure modes rather than a false all-green. *(test 7)*
- **SELF-006** Provenance of every self-assessment. *(test 8)*

## Interface
```
SelfModel: registerDomain({name,capabilities,competence,failureModes,up,load})
  setDomainUp(name,up) · declareLimitation(text) · capabilities() · cannot()
  assess({capability,description}) -> { can, byDomain, competence, askHuman, ... }
  health()
```
Reference: `public/aquin-selfmodel.js`. Harness: `self_test.js` (8/8). Answers the
five self-questions: what can I do / not do / which domains are active / where are my
limits / should I ask a human. The final architectural component before the Runtime
Domains are engineered in detail.
