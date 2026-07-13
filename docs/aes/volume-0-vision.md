# AES Volume 0 — Vision, Research Direction, Scope

**STATUS: design.** This volume states *what AquinTutor is trying to be* and,
just as importantly, *how much of that is real today*. It is the honest frame
every other volume hangs from.

---

## 1. Thesis

Most AI systems optimise **next-token likelihood**. AquinTutor's research
direction is to optimise **learning gain** — a different objective function.
The questions a token model asks ("what word is likely next?") are replaced by:

- What does this learner already understand?
- Where, specifically, is the misconception?
- What is the most effective *next teaching action* — explain, show, simulate,
  ask, or stay quiet?

This is a narrower and more defensible problem than "build another general
chatbot," and it is the intellectual core worth pursuing. We call the long-term
target an **Educational Cognitive Architecture (ECA)**.

> **Honesty clause.** ECA in full — a knowledge graph, per-learner cognitive
> model, adaptive pedagogy engine, assessment engine, simulation runtime, and a
> reasoning layer, unified under an "educational kernel" — is a multi-year
> research-and-engineering programme, not a deliverable of any single work
> session. Treating it as buildable-in-one-go produces impressive-looking but
> hollow scaffolding. This library is built the opposite way: one bounded,
> tested subsystem at a time.

## 2. The design centre: accessibility-first, not average-student

The platform is designed for the **widest range of learners**, benchmarked
against the hardest case rather than the average one. Concretely, the reference
learner is:

> *A student on a ₹8,000–10,000 Android phone, on 2G/3G/4G with intermittent
> power, who may not have strong English, may have gaps in prerequisites, may be
> the first in their family in higher education, and may have a disability.*

If it works well for them, it works for everyone. The guiding line:

> **Every learner deserves an educational experience adapted to how they learn —
> regardless of language, location, background, device, or prior preparation.**

The knowledge stays constant; the *teaching strategy* adapts (language, pace,
modality, prerequisite recovery). We deliberately avoid framing this as "low
learning capacity" — the barriers are language, connectivity, foundations,
economics, and accessibility, which are design problems, not learner deficits.

### 2.1 Institutional posture (UGC / Dibrugarh University context)

AquinTutor is positioned as **infrastructure a university licenses**, not a
degree-granting franchise. The institution keeps admissions, curriculum,
faculty, assessment, and degrees. AquinTutor provides tutoring, virtual labs,
adaptive pedagogy, translation, analytics, and student-success tooling — with
data-sovereignty options (cloud / private cloud / on-prem).

## 3. What is real today

- **Virtual Labs:** ~40 working, browser-based interactive simulators across
  VLSI, EEE, cybersecurity, AI/ML, robotics, mechanical, physics, chemistry,
  biology, mathematics, CS, and signals (`/aquintutor/labs`).
- **Animation Engine (Volume 7):** a shipped, tested, dependency-free real-time
  animation engine powering a live "topic → animation" Co-pilot demo and a
  deep-linkable concept visualiser. This is the first concrete proof of the
  "real-time animation while teaching" promise.
- **Offline foundation:** a service worker + IndexedDB queue already cache parts
  of the app for offline use (`public/sw.js`, `public/offline-sync.js`) — a real
  base to extend toward downloadable lesson/animation packages.
- **Course/lesson runtime, adaptive practice, and campus surfaces** exist in
  `/aquintutor/*`.

## 4. Buildable decomposition (the roadmap)

The ECA vision decomposes into subsystems that *can* be built and tested one at
a time. Each becomes its own AES volume **when it is the active build**, so the
spec records real decisions rather than speculation:

| Subsystem | What it owns | Nearest real anchor today |
|-----------|--------------|---------------------------|
| Educational Kernel | object model, lifecycle, orchestration between engines | — (design) |
| Knowledge Engine | concept graph, prerequisites, misconceptions | course/lesson data |
| Student Model | per-learner mastery state, pace, modality preference | practice + progress tables |
| Teaching Engine | strategy selection (explain/show/simulate/ask) | Aquin Co-pilot |
| **Animation Engine** | topic → live visual | **shipped — Volume 7** |
| Virtual Laboratory Runtime | shared instrument/measurement/safety contract | ~40 labs (not yet unified) |
| Assessment Engine | continuous, multi-dimensional evaluation | adaptive assessments |
| Offline Runtime | download-on-Wi-Fi, learn-offline, delta-sync | sw.js + offline-sync.js |
| Multilingual Intelligence | teach/assess in-language (start: Assam/NE India) | — (design) |
| Distributed Infrastructure | 10M-learner scale: stateless services, edge, sharding | Vercel + Supabase today |

**Sequencing principle:** *no subsystem is implemented before its bounded spec
exists, and no spec is written before its subsystem is the active build.* This
keeps the library truthful and the codebase coherent as it grows over years.

## 5. What this volume is not

It is not a product brochure, not a funding deck, and not a promise that all of
§4 is imminent. It is a compass: it fixes the objective (learning gain), the
design centre (accessibility-first, rural-first), the institutional posture
(infrastructure, not franchise), and the discipline (spec-then-build,
one subsystem at a time). Volume 7 is the proof that the discipline produces
real, shipping capability.
