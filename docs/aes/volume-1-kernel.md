# AES Volume 1 — Educational Operating Kernel

**STATUS: implemented (Ch 1.1 + Ch 1.2).** Backed by `public/aquin-kernel.js`
and `public/aquin-resolver.js`. Every claim here is verifiable against that
source and the Node test harnesses.

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

The second subsystem. It **never initializes modules directly** — it computes an
**immutable, reproducible execution plan** the kernel executes. Given identical
manifests it always produces an identical plan (verified: shuffled input → same
`planHash`); random ordering is prohibited.

- **Typed dependency edges** — each dep is `mandatory | strong | optional | weak`
  with a version constraint + reason; only *blocking* edges constrain ordering
  and cycle detection, so a missing *optional* dep degrades to a warning, not a
  failure.
- **Manifest validation** (non-terminating, full diagnostics) — rejects
  duplicate ids, invalid mandatory dependency references, and **semver version
  conflicts** (`^`, `~`, `>=`, `<=`, `>`, `<`, exact), collecting every issue
  before aborting.
- **Graph validation** — cycle detection with the exact chain trace + duplicate
  edge detection; never auto-resolves.
- **Startup levels** — `level(id) = 1 + max(level(blocking deps))`, so a level's
  modules cannot depend on one another and **init in parallel**. The kernel
  runs each level with `Promise.all`; levels run strictly in order. Verified:
  `L0 config → L1 {security,storage,render} → L2 {animation,simulation,
  translation} → L3 teacher`, level-1 modules starting with a 0 ms gap.
- **Lifecycle state events** — `created → queued → initializing → healthy |
  degraded | failed …`, emitted immutably for a live dependency graph.
- **Live impact analysis** — `computeImpact(graph,id)` returns the directly and
  transitively affected modules + affected categories (reverse reachability
  over blocking edges). Verified: failing `render-rt` ⇒ `{animation, teacher}`.
- **Graceful degradation** — *educational continuity before computational
  perfection*: rendering→simplified renderer, animation→static diagram,
  translation→original language, simulation→recorded playback, knowledge→cached
  snapshot, assessment→defer-and-queue. `degrade(graph,id)` isolates the branch
  and keeps teaching alive.
- **Runtime Stability Score** (0–100) — weighted with **educational continuity
  highest (0.35)**, then init success, availability, recovery, restart
  frequency, dependency violations. Verified: perfect=100, degraded=69.

**Kernel integration:** when `AquinResolver` is present, the kernel's GRAPH
phase calls `plan(manifests)` (cycle/validation now surface here) and the INIT
phase executes the levels in parallel; without it, the kernel falls back to its
own topological sort. Teardown stays kernel-owned for either path.

**Test evidence** (`scratchpad/resolver_test.js`, `integration_test.js`):
levels, determinism, cycle trace, 3 manifest diagnostics (duplicate/invalid-ref/
version-conflict), impact analysis, degradation, stability (100/69), parallel
execution, and integrated kernel boot (`resolver=1.2.0`, level-1 gap 0 ms).
