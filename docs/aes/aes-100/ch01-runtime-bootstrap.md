# AES-100 · Vol II · Part I · Chapter 1 — Runtime Bootstrap Engine

**Status:** specified + reference implementation (`public/aquin-kernel.js` +
`public/aquin-resolver.js`, Node-tested, 15 cases). Normative: SHALL/SHOULD/MAY.

## 1. Purpose
Transform an inactive environment into a constitutionally-valid Educational
Runtime that can accept Educational Missions. Nothing else may run until boot
completes deterministically.

## 2. Requirements (normative)
- **BOOT-001** Boot SHALL be a deterministic finite-state machine; identical
  config + persisted state SHALL yield an identical sequence. *(kernel FSM)*
- **BOOT-002** The sequence SHALL be `VERIFY → CONFIG → IDENTITY → CAPABILITY →
  GRAPH → INIT → HEALTH → READY`, with a `FAILED` branch. *(reference: kernel `boot()`)*
- **BOOT-003** Config SHALL be merged by precedence (System→Deployment→
  Institution→Environment→User→Runtime), checksummed (SHA-256), field-validated
  (non-terminating — collect all errors), then **deep-frozen** into an immutable
  snapshot. Enforces `proctoring = advisory`.
- **BOOT-004** Runtime Domains SHALL initialize in dependency order; cycles SHALL
  abort boot with the exact cycle chain (never auto-resolve). *(resolver)*
- **BOOT-005** Boot SHALL support modes: **cold / warm / recovery / offline /
  development / testing / research** (offline skips remote sync; testing is
  deterministic; recovery replays checkpoints). *(planned extension of `boot(opts)`)*
- **BOOT-006** On any failure, initialized modules SHALL be disposed in **reverse
  order**; a partially-initialized runtime SHALL NEVER be exposed. *(kernel teardown)*
- **BOOT-007** Boot SHALL emit a complete provenance record (phases, timings,
  validation report). Native-only concerns (GPU APIs, NUMA, exe-signature) are
  declared not-applicable in a browser sandbox.

## 3. Boot state machine
See `AquinKernel.boot()` phases (BOOT-002). Dependency resolution + parallel
startup levels are delegated to `AquinResolver` (Ch 2/3 substrate).

## 4. Reference implementation
`public/aquin-kernel.js` (FSM, config, identity, capability vector, health,
teardown) + `public/aquin-resolver.js` (typed-edge manifests, cycle detection,
parallel startup levels, stability score). Harnesses: `kernel_test.js` (4),
`resolver_test.js` (8), `integration_test.js` (3). Boot-mode matrix (BOOT-005)
is the next increment on this engine.
