# AES-100 Vol III Ch 41 — Kernel Autonomous Agent Runtime (public/aquin-agent-runtime.js)

Governed actor model + capability security + lifecycle FSM. Node-tested (7).
- **Lifecycle FSM** created→registered→authenticated→active→idle→archived→retired;
  illegal transitions rejected.
- **Capability security**: agent refuses any ungranted action.
- **Governed execution**: only in 'active' state (idle/archived blocked).
- **Goals** with sub-goals + progress + success/failure criteria.
- **Delegation** never exceeds policy: only to a capable+active agent, and the
  delegator must itself hold the capability.
- **Trust** updates from outcomes and steers delegation candidate selection.
- **Human override** (hold/release) always available; full audit provenance.
HONEST SCOPE: governance/lifecycle/capability/trust logic is real; the C++ kernel,
OS scheduling, and network transport are declared substrates. Richer than the
earlier aquin-agents.js (Executive routing) — this is the kernel agent *runtime*.
