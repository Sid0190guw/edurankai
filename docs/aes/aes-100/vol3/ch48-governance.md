# AES-100 Vol III Ch 48 — Constitutional Governance & Court (public/aquin-kgov.js)

The supreme governance layer; composes the Vol II validation pipeline
(aquin-constitution.js) and adds the Court. Node-tested (6).
- **Immutable rules**: a published constitutional rule is frozen.
- **Hierarchy**: lower Article # = higher authority → higher priority → more specific
  scope; deterministic conflict resolution.
- **Explainable Court**: returns the winning rule + exact reason (Article-1 privacy
  forbid beats Article-4 institutional permit).
- **Compliance monitor**: flags actions a forbidding rule matches; computes a rate.
- **Governed amendment**: versioned, history retained in the audit.
HONEST SCOPE: rule arbitration + compliance real; C++ constitutional runtime,
distributed policy propagation, crypto audit chaining are declared substrates.
(~1.82M-LOC C++ spec distilled to the core.)
