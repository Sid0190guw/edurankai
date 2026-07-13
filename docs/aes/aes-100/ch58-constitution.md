# AES-100 · Vol II · Part XV · Ch 58 — Constitutional Runtime & Governance Kernel

**Status:** specified + reference implementation (`public/aquin-constitution.js`,
Node-tested, 10 cases). The SUPREME governing subsystem. Every runtime action
derives authority here. **No intelligence is above the Constitution** — it
separates POWER (capability) from AUTHORITY (constitutional limits).

## Requirements (normative)
- **CONST-001** Validation pipeline: no action executes without passing, in order,
  identity → authorization → educational-truth → safety → governance →
  policy-resolution. Any stage denies; denial is final + explained. *(tests 1-4,6)*
- **CONST-002** Layered constitution with INHERITANCE (universal > federation >
  national > institutional > mission): a lower layer inherits higher constraints
  and MAY NOT relax them unless a higher layer explicitly permits. *(tests 6,7)*
- **CONST-003** Conflict resolution by hierarchy — higher layer wins, reasoning
  recorded. *(test 6)*
- **CONST-004** AI behaviour governance: an agent decision that is unexplainable,
  evidence-insufficient, overconfident-without-evidence, or provenance-incomplete
  SHALL NOT publish. *(tests 2,3)*
- **CONST-005** No autonomous constitutional change: a runtime request that targets
  the constitution is REJECTED; amendment requires `governedAmendment()`. *(test 5)*
- **CONST-006** Amendment only through the full governed pathway (proposal →
  educational-evidence → research-review → expert-council → public-consultation →
  governance-approval); universal principles are frozen. *(tests 8,9)*
- **CONST-007** Complete auditability: every decision records version, applied
  policies, stage results, actor, reasoning. *(test 10)*

## Interface
```
Constitution: setPolicy(layer,id,rule) · resolvePolicy(id) · validate(action)
  governedAmendment(proposal) · audit() · version() · universal()
action = { id, actor, capability, decision, explanation, evidenceSufficient,
           confidence, provenanceComplete, safe, targetsConstitution, policyId }
```
Reference: `public/aquin-constitution.js`. Harness: `const_test.js` (10/10). This is
the governance decision + audit kernel; cryptographic identity, distributed policy
replication, and jurisdiction-specific legal encodings are the substrates beneath.
It is the enforcement point above the Multi-Agent Society (Ch 57) and every engine.
