# AES-100 · Vol II · Part I · Chapter 2 — Runtime Lifecycle Engine

**Status:** specified + reference implementation (`public/aquin-lifecycle.js`,
Node-tested, 7 cases). Normative keywords: SHALL / SHOULD / MAY.

## 1. Purpose

Govern the existence of every executable Runtime Domain through **one canonical
lifecycle**, so that creation, initialization, verification, execution,
suspension, recovery, and retirement are deterministic, observable, and
recoverable. No Runtime Domain SHALL execute logic outside a declared lifecycle
state.

## 2. Terminology

- **Runtime Domain** — a constitutionally-governed subsystem (Retrieval, Graph,
  Cognition, Rendering, AI Runtime, …).
- **Lifecycle state** — one of the 16 canonical states (§5).
- **Lifecycle event** — the named trigger of a transition (`Allocate`, `Run`, …).
- **Transition** — a validated move `state --event--> state'`.

## 3. Requirements (normative)

- **LIFE-001** Every Runtime Domain SHALL be in exactly **one** lifecycle state
  at any instant. *(test: state() single-valued)*
- **LIFE-002** State SHALL change **only** via a transition defined in the
  transition table (§6). Illegal transitions SHALL be rejected without side
  effects. *(test 2)*
- **LIFE-003** A domain SHALL NOT enter **Running** unless every declared
  dependency is in `Ready` or `Running`. *(test 3)*
- **LIFE-004** Every transition SHALL emit an **immutable provenance record**
  (§9). *(test 6)*
- **LIFE-005** From **Running**, `Fail` SHALL move to **Recovering**; from
  **Recovering**, `Verify` SHALL return to **Running** and `Fail` SHALL move to
  **Stopping**. Recovery SHALL either succeed or terminate — never hang. *(test 4)*
- **LIFE-006** The shutdown path `Running→Stopping→Stopped→Archived→Destroyed`
  SHALL be supported; **Archived** provenance SHALL be immutable. *(test 5)*
- **LIFE-007** On dependency failure, dependent domains in `Running` SHOULD be
  moved to `Paused` per policy (isolation, not cascade-destroy). *(test 7)*
- **LIFE-008** Lifecycle operations SHALL be idempotent w.r.t. correctness:
  re-issuing a completed transition SHALL NOT corrupt the domain.
- **LIFE-009** State lookup SHALL be O(1); transition validation SHALL be
  bounded-time (table lookup).

## 4. Internal architecture

`Lifecycle Controller` (orchestration) · `State Machine Manager` (holds
per-domain state) · `Transition Validator` (LIFE-002) · `Dependency Monitor`
(LIFE-003/007) · `Recovery Coordinator` (LIFE-005) · `Health Observer` ·
`Lifecycle Registry` · `Provenance Recorder` (LIFE-004). In the reference
implementation these collapse into one engine object; the responsibilities map
1:1 to functions.

## 5. Canonical state machine (16 states)

```
Registered → Allocated → Constructed → Configured → Initialized → Verified
          → Ready → Running
Running → Paused → (Resume) → Running
Running → Suspended → Restored → (Activate) → Running
Running → Recovering → (Verify) → Running        (Recovering → Fail → Stopping)
Running → Stopping → Stopped → Archived → Destroyed
Stopped → Running                                (restart)
```

State semantics (summary): **Registered** identity/deps only, no code;
**Allocated** resources reserved; **Constructed** internal objects; **Configured**
config applied then frozen; **Initialized** internal services; **Verified**
startup diagnostics pass; **Ready** may accept requests; **Running** full
operation; **Paused** halt w/ memory intact; **Suspended** serialized, resources
freeable; **Recovering** replay/repair; **Stopping/Stopped/Archived/Destroyed**
teardown with provenance preserved to the end.

## 6. Transition table (normative)

| State | Event | → |
|---|---|---|
| Registered | Allocate | Allocated |
| Allocated | Construct | Constructed |
| Constructed | Configure | Configured |
| Configured | Initialize | Initialized |
| Initialized | Verify | Verified |
| Verified | Activate | Ready |
| Ready | Run | Running |
| Running | Pause / Suspend / Fail / Stop | Paused / Suspended / Recovering / Stopping |
| Paused | Resume | Running |
| Suspended | Restore | Restored |
| Restored | Activate | Running |
| Recovering | Verify / Fail | Running / Stopping |
| Stopping | Complete | Stopped |
| Stopped | Archive / Run | Archived / Running |
| Archived | Destroy | Destroyed |

Any (state, event) pair absent from this table is **illegal** (LIFE-002).

## 7. Public interface (normative)

```
LifecycleEngine:
  register(id, { deps?, authority? })         -> registers a domain in `Registered`
  transition(id, EVENT, { authority?, note? })-> { ok, from, to, provenance } | { ok:false, reason }
  boot(id, opts?)                             -> runs Allocate…Run to Running (or first failure)
  state(id) -> string          history(id) -> ProvenanceRecord[]
  pauseDependentsOf(failedId) -> string[]     domains() -> string[]
```

## 8. Dependency coordination

`Dependency Monitor` enforces LIFE-003 at the moment of any transition whose
target is `Running`: it inspects each dependency's current state and rejects the
transition (with a reason naming the offending dependency and its state) unless
all are `Ready`/`Running`. On dependency failure, LIFE-007 pauses dependents.

## 9. Lifecycle provenance (record schema)

Each transition appends an immutable record: `{ domain, prev, next, event, tick
(Educational Chronology), at (wall), authority, note, deps[] }`. Records support
replay, audit, and distributed synchronization.

## 10. Failure modes & recovery

Configuration / dependency / resource-exhaustion / init-timeout / verification /
health-degradation / sync-loss / upgrade-conflict / invalid-transition /
corrupted-checkpoint. Each maps to either a deterministic recovery path
(→ `Recovering` → `Verify` → `Running`) or a controlled shutdown (→ `Stopping`).
Invalid transitions are rejected in place (no state change).

## 11. Performance targets

O(1) state lookup; table-lookup transition validation; append-only provenance;
concurrent management of thousands of domains; zero illegal transitions in
normal operation (enforced, not assumed).

## 12. Testing strategy (met by the reference implementation)

Canonical boot → Running (1); illegal transition rejected (2); dependency
coordination blocks then permits Running (3); failure→recovery→Running (4);
full shutdown → Destroyed (5); provenance completeness (6); dependency-failure
pauses dependents (7). All re-runnable headless.

## 13. Extension points

Domains MAY add internal substates provided they map onto a canonical state and
introduce no transitions outside §6. GPU-simulation and autonomous-research
runtimes are the motivating cases.

## Reference implementation

`public/aquin-lifecycle.js` — `window.AquinLifecycle.createLifecycleEngine()`.
The transition table (§6) is `AquinLifecycle.TRANSITIONS`; the interface (§7)
matches exactly. Test harness: `scratchpad/lifecycle_test.js` (7/7).
