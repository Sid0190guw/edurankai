# AES Volume 1 — Educational Operating Kernel

**STATUS: implemented (Ch 1.1) · in progress (Ch 1.2).** Backed by
`public/aquin-kernel.js` (and `public/aquin-resolver.js` for 1.2). Every claim
here is verifiable against that source and the Node test harness.

> **Engineering Decision 001 (the user's standard, adopted).** First-principles,
> 100M-learner scale, 30-year maintainability, implementation-grade detail. One
> subsystem engineered at a time — never two simultaneously.

> **Platform honesty clause.** AquinTutor runs in the browser. Several items in
> the source specs assume a native binary and are **not exposed to a browser
> sandbox**: native GPU APIs (Vulkan / Metal / DirectX), NUMA / SIMD topology,
> and cryptographic signing of an executable. These are implemented as their
> real web equivalents and the boundary is *declared in code* (`AquinKernel`'s
> `notApplicable` map, `aquin-kernel.js`), never faked. Config integrity uses a
> real SHA-256 content checksum instead of an executable signature.

---

## Chapter 1.1 — Runtime Bootstrap Engine  `window.AquinKernel`

The single executable entry point. No subsystem initializes on its own; each is
created only through `AquinKernel`, in deterministic order.

**Boot is a deterministic finite-state machine:**

```
IDLE → VERIFY → CONFIG → IDENTITY → CAPABILITY → GRAPH → INIT → HEALTH → READY
                                                                         ↘ FAILED
```

Phases (all logged with a Runtime Session Id):
- **VERIFY** — merge config layers by precedence (System → Deployment →
  Institution → Environment → User → Runtime), compute a **SHA-256 checksum**
  of the merged config (`crypto.subtle`, real).
- **CONFIG** — validate every field against `SCHEMA` (type / range / enum /
  required). Validation **never stops at the first error**: it collects a full
  structured report `{config, rule, expected, actual, severity, resolution}`,
  then aborts if any error remains. Enforces the institutional rule
  `educational.proctoring === 'advisory'` at boot. On success the config is
  **deep-frozen** into an immutable Runtime Configuration Snapshot — the single
  authoritative source; no subsystem reads config files directly.
- **IDENTITY** — one Runtime Session Id, Kernel Instance Id, Deployment Id,
  Institution Id, ISO timestamp, and a crypto secure seed; frozen and inherited
  by every subsystem. No subsystem mints its own identity.
- **CAPABILITY** — the Runtime Capability Analyzer **benchmarks** (it does not
  merely detect): sustained CPU ops in a fixed budget, a real WASM add-loop,
  WebGL/WebGL2 + max-texture, WebGPU presence, measured refresh rate over 8
  frames, `storage.estimate`, `navigator.connection`, and feature presence
  (SW / Cache / IndexedDB / WebCodecs / speech / media). Output is a
  **multidimensional capability vector** — *not* fixed Low/Med/High classes —
  from which continuous budgets derive (particle budget, target FPS clamped to
  the real panel, texture scale, animation quality, offline viability). Honours
  `saveData` and `prefers-reduced-motion`.
- **GRAPH / INIT / HEALTH** — build the module DAG, **detect cycles** (abort
  with the exact chain, e.g. `a → b → a`; never auto-resolve), topologically
  order, init in order, then require every module's health check to pass.
- **FAILED** — on any error: dependency-aware diagnostic, **dispose initialized
  modules in reverse order**, and never expose a partially-initialized runtime.

**Test evidence** (Node harness, re-runnable, `scratchpad/kernel_test.js`):
1. Happy-path boot → `ready`, all 7 phases, frozen snapshot, real checksum.
2. Cycle `a↔b` → aborted: `Dependency cycle detected: a → b → a`.
3. `proctoring: 'auto-penalize'` → rejected by config validation.
4. A module init throwing → prior module disposed in reverse; no partial runtime.

## Chapter 1.2 — Runtime Dependency Resolution Engine  `window.AquinResolver`

The second subsystem. It does not initialize modules directly — it computes an
**immutable, reproducible execution plan** the kernel executes. See the source
for the typed-edge manifest model, non-terminating graph validation
diagnostics, parallel **startup levels**, lifecycle state events, live impact
analysis, graceful-degradation policies (rendering→simplified, animation→
diagrams, translation→original language, simulation→recorded), and the Runtime
Stability Score. *(This chapter is being written as it is built.)*
