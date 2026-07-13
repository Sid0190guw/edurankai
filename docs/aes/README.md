# AquinTutor Engineering Specification (AES)

> **What this is, honestly.** This is a *working* engineering-spec library for
> AquinTutor — not a 20,000-page fantasy, and not marketing. Each volume is
> written only when the subsystem it describes is either (a) built and needs an
> accurate spec, or (b) about to be built and needs a bounded design first. We
> do not write specs for subsystems no one is building yet; that produces
> plausible-looking fiction and rots the moment reality diverges.
>
> The rule for this repo: **a volume is either grounded in shipping code
> (marked `STATUS: implemented`) or is a bounded design for the next concrete
> build (marked `STATUS: design`).** Nothing is marked "done" that isn't.

## Why a spec at all

AquinTutor's long-term thesis (see Volume 0) is genuinely large and worth
writing down. But large systems are not built by one giant prompt — they are
built one bounded, tested subsystem at a time, each with a spec that a future
engineer (human or agent) can implement against. This library grows that way,
in step with the code.

## Volumes

| Vol | Title | Status | Backed by |
|----:|-------|--------|-----------|
| 0 | Vision, Research Direction, Scope | design | `docs/aes/volume-0-vision.md` |
| 7 | Animation Engine | **implemented** | `public/aquintutor-animator-engine.js` + 3 surfaces |

Volumes 1–6, 8–20 (Educational Kernel, Knowledge Engine, Offline Runtime,
Virtual Laboratory Runtime, Distributed Infrastructure, …) are named in
Volume 0's roadmap but are **intentionally not written yet** — each will be
authored when it becomes the active build, so the spec reflects real decisions
rather than guesses.

## Reading order

1. **Volume 0** — the *why*: the "optimize for learning gain, not token
   likelihood" thesis, the rural-first / accessibility-first design centre, and
   the honest decomposition of the vision into buildable subsystems.
2. **Volume 7** — the *first shipped subsystem*: the real-time animation engine,
   its scene contract, intent-matching algorithm, render loop, the three
   surfaces it powers, adaptive-rendering strategy, and test evidence.
