# AquinTutor — Master Engineering Specification

**Single source of truth: PRD + SRS + TDD + System Architecture Blueprint**

| | |
|---|---|
| Document type | Product Requirements + Software Requirements + Technical Design + Architecture |
| Product | AquinTutor — verified lifelong learning platform (pre-KG to PhD to vocational) |
| Parent org | EduRankAI (hosts AquinTutor as a self-contained sub-platform) |
| Status | Living document — authoritative for all implementation |
| Audience | Senior engineers, and Claude Code operating in VS Code |
| Runtime today | Astro 5 SSR on Vercel · Drizzle ORM (postgres-js) · Neon Postgres · @vercel/blob |
| Live | edurankai.in (AquinTutor at `/aquintutor/*`) |

> **How to read this document.** It describes the *entire finished product*, not just its structure. Where the current codebase already implements a behaviour, the spec states it as **[Built]** and describes the real implementation so it is not regressed. Where a behaviour is specified but not yet built, it is marked **[Planned]**. Where the source prompt was silent and a decision was inferred, it is marked **[Assumption]** with the rationale. An implementer must never need to guess; if a genuine ambiguity remains, it is listed in the open-questions register (§0.6) rather than silently resolved.

---

## 0. Preamble, Scope, and Conventions

### 0.1 Interpretation of the source prompt

No standalone "project prompt" text accompanied the request to produce this document. The project in scope is therefore **AquinTutor**, the learning platform built and specified throughout the current engagement together with the Product Manager's specification (`Aquintutor_.docx`). This document consolidates:

1. The PM master spec — 8 learner tiers, signature features, user flow, and 24-month roadmap.
2. The behaviours already implemented in the `edurankai` repository under `src/pages/aquintutor/**` and `src/lib/aquintutor-*`.
3. The platform-wide conventions of the host application (auth, DB, offline, payments, labs, LTI).

Intent is preserved exactly: AquinTutor is an **elite, verified-learning institution** spanning a learner's entire life, never framed around price, never naming competitors, never using emoji in UI, with automated proctoring strictly advisory.

### 0.2 Product one-liner

> AquinTutor follows **one learner from pre-KG to PhD and beyond**, replacing passive video with **verified learning** — every claimed skill is proven by an exit-ticket, taught back, or demonstrated in a hands-on virtual lab — across eight age-and-purpose tiers, each with a signature experience matched to its "job to be done."

### 0.3 Non-negotiable product principles (global invariants)

These are hard constraints. Any feature that violates one is a defect.

| # | Principle | Enforcement |
|---|-----------|-------------|
| P1 | **Verified learning, not passive completion.** "Completed" alone is never a claim of competence. Every skill needs verification (exit-ticket / teach-back / lab demo). | `aq_verify_log`, `aq_mastery.verified`; UI must distinguish *done* from *verified*. |
| P2 | **Socratic by default.** The tutor guides; it never hands over the final answer to a problem the learner is meant to solve. | Homework Helper, hint ladders — see §2.4. |
| P3 | **Productive failure is designed-in.** Struggle before reveal; retries are free and non-punitive. | Hint ladders, re-attempts, no lockouts on wrong answers. |
| P4 | **No competitor or company names anywhere in the UI.** Never name any external education, cloud, or AI company in user-facing copy. | Copy review; CI grep (§15.5). |
| P5 | **No emoji in any UI, seed, or notification.** Use inline SVG glyphs (lucide-style) only. | Copy review; CI grep. |
| P6 | **Proctoring is advisory-only.** Automated flags never auto-penalize; a human reviews and decides. | Proctor events stored as advisory; no automated score changes. |
| P7 | **AquinTutor is self-contained.** It uses its own shell (`AquintutorLayout`), never the EduRankAI admin/chrome, and never redirects a learner into EduRankAI admin. | Layout selection; route guards. |
| P8 | **Never framed around price.** Positioning is an elite research institution; marketing copy must not lead with cost ("1 CHF", "cheap", etc.). | Copy review. |
| P9 | **Own/authentic implementation.** Simulations, auth, and tutoring logic are hand-built, no third-party auth SDKs, no LLM dependency for core learning loops. | Code review; dependency allowlist. |
| P10 | **Accessibility and performance floors.** WCAG 2.1 AA, 60fps interactions, Lighthouse > 90 on marketing surfaces. | Automated audits (§15.6). |

### 0.4 Glossary

| Term | Meaning |
|------|---------|
| **Tier** | One of 8 learner segments (`tots … atelier`) defining age, goals, and the signature experience. |
| **Skill / skill_id** | An atomic learning objective, string-keyed (e.g. `kg-mech-newton`, `homework-arith`, `tots-count`). |
| **Mastery Tree** | The per-learner map of skills with state `growing → mastered` (forward-only) and a `verified` flag. |
| **Exit ticket** | A short, parameter-varied re-check taken after a lesson; the sole thing that flips a skill to *verified*. |
| **Teach-it-Back** | Learner explains a concept aloud; speech is matched against expected key terms (recall proof). |
| **Signature feature** | The one experience that defines a tier (e.g. Tots = voice-first; Scholars = Backlog Recovery). |
| **Lab** | A hand-built interactive simulation (physics, CS, chemistry, engineering) usable standalone, embedded, or via LTI. |
| **Embed mode** | Chromeless render of a page/lab (`?embed=1`) with a `postMessage` event bridge for host integration. |
| **Self-bootstrapping schema** | Tables created/altered at runtime via `CREATE/ALTER … IF NOT EXISTS`, memoized once per process. |

### 0.5 Assumptions register (inferred, faithful to intent)

| ID | Assumption | Rationale | Alternatives documented |
|----|-----------|-----------|--------------------------|
| A1 | The learner identity is the shared EduRankAI account (`Astro.locals.user`); AquinTutor does not maintain a separate credential store. | Existing auth is self-built multi-method and platform-wide; duplicating it violates P9's "own, not duplicated." | A separate `aquintutor.ai` auth realm is a future option (§17.4). |
| A2 | Core learning content (questions, refreshers, graphs) is **authored in code/data**, not LLM-generated at runtime. | P9; determinism; offline capability; PM's "own, authentic, no vague." | An optional AI Micro-Tutor add-on is gated behind an explicit API key and a paid flag (§13.4). |
| A3 | Currency of record for paid add-ons is **CHF**, converted to **INR paise** for Razorpay. | Matches existing founder/paywall code. | Multi-currency is a future extension (§17). |
| A4 | Parent/teacher dashboards read the same verify/teachback logs learners write; no separate analytics store initially. | Simplicity; single source of truth. | A dedicated analytics warehouse is a scale-out option (§10, §12). |
| A5 | "Elite" tiers (Tutor/Research/Atelier) reuse the labs + tests + LTI infrastructure rather than bespoke engines. | Those tiers are smaller audiences; reuse maximizes depth per effort. | Bespoke research/atelier workspaces are roadmap (§18.9). |

### 0.6 Open-questions register (must be resolved before the relevant epic ships)

| ID | Question | Blocks | Default if unanswered |
|----|----------|--------|-----------------------|
| Q1 | Does AquinTutor get its own domain (`aquintutor.ai`) and auth realm, or remain a path on edurankai.in? | §17.4 domain routing | Remain a path; single auth. |
| Q2 | For paid AI Micro-Tutor, which provider/model and who funds tokens? | §13.4 | Feature stays disabled behind a flag. |
| Q3 | ~~Parent accounts: separate login vs guardian toggle?~~ **RESOLVED** — implemented as a learner-minted read-only **share link** (`/aquintutor/shared-progress/[token]`); no viewer account, revocable. | — | Done. |
| Q4 | Institutional (B2B) seat licensing billing: self-serve or sales-assisted only? | §2.16, §13.5 | Sales-assisted (CTA to `connect@edurankai.in`). |

### 0.7 Document conventions

- **[Built]** implemented today · **[Planned]** specified, not yet built · **[Assumption]** inferred · **[B2B]** institutional feature.
- Code identifiers, table names, and routes are in `monospace`.
- All money is CHF unless a paise value is explicitly shown.
- All times are stored UTC (`TIMESTAMPTZ`) and rendered in the learner's timezone.

---

## 1. Product Vision

### 1.1 Purpose

AquinTutor exists to make **mastery verifiable and lifelong**. The market is saturated with content libraries that measure "hours watched" and "courses completed" — metrics that reward passivity and produce the *illusion of competence*. AquinTutor inverts this: the unit of progress is a **verified skill**, and a single learner is carried from their first phoneme at age three to a doctoral thesis and, later, a mid-career trade credential — inside one coherent institution.

### 1.2 Mission

> To be the institution a person never has to leave — proving, at every stage of life, not that they *attended*, but that they *understand*.

### 1.3 Objectives

1. **One learner, one lifelong record.** A continuous, verified competence history across all eight tiers.
2. **Every tier has a signature experience** tuned to its real job-to-be-done, not a re-skin of the same course player.
3. **Verification is unfakeable.** "Completed but unverified" is a first-class, visible state.
4. **Hands-on by default.** Elite virtual labs, embeddable into any institution's infrastructure (iframe / SDK / LTI), at a market-ready standard.
5. **Offline-first and fast.** Core learning works without connectivity; interactions hold 60fps; compute cost stays low (Neon suspend-friendly).
6. **Institution-grade.** Sellable to schools and universities as seats and as embeddable labs.

### 1.4 Problems being solved

| Problem | How AquinTutor solves it |
|---------|--------------------------|
| Passive video → illusion of competence | Exit-ticket + teach-back verification; `verified` flag distinct from `done`. |
| Homework shortcuts / answer-copying | Socratic Homework Helper that never reveals the answer, only checks the learner's own attempt. |
| "Why am I learning this?" / poor intent mapping | Knowledge-graph tiers where each concept visibly unlocks the next. |
| Backlog panic before exams | Backlog Recovery: a short diagnostic pinpoints the exact 2-3 gaps and builds a surgical, goal-filtered path. |
| Pre-readers excluded by text UIs | Voice-first Tots: everything spoken, answers by tap or speech. |
| Effort wasted on low-yield material | Goal-based filtering (Boards vs NIT vs IIT) so effort maps to marks. |
| Fragmented tools across life stages | One account, one mastery record, pre-KG → PhD → vocational. |
| Institutions can't reuse the content | Labs embeddable via iframe, JS SDK, and LTI 1.1 with grade passback. |

### 1.5 Target users

| Persona | Tier(s) | Primary job-to-be-done |
|---------|---------|------------------------|
| Pre-reader child (guardian-operated) | Tots (3-5) | Learn first sounds, numbers, calm — by voice and touch. |
| Primary child + parent | Primary (6-10) | Homework without battles; stay on curriculum. |
| Middle-schooler | Sub-Juniors (11-13) | Beat homework overload; understand, don't shortcut. |
| Secondary student | Juniors (14-15) | Boards + JEE/NEET foundation as one merged path. |
| Senior secondary student | Scholars (15-18) | Clear a backlog; crack JEE/NEET; build a portfolio. |
| Undergraduate | Tutor (18-22) | An employable degree; coding mastery; internships. |
| Postgraduate / researcher | Research (22+) | Manage literature; write thesis faster; publish. |
| Career-switcher / lifelong learner | Atelier (any) | A hands-on trade skill; an industry credential. |
| Parent / guardian | (cross-tier) | See real, verified progress — not vanity hours. |
| Teacher / school admin **[B2B]** | (cross-tier) | Assign, monitor, and embed labs into their LMS. |
| Institution buyer **[B2B]** | (cross-tier) | License seats and embed labs into virtual infra. |

### 1.6 Expected outcomes

- A learner can point to a **verified skill map** rather than a certificate of attendance.
- A parent sees **"3 of 9 mastered, verified"** — never a hollow "100% complete."
- An institution embeds a **lab as an API** into its own portal in under a day.
- The platform runs within **Vercel Hobby + Neon free-tier** constraints until scale justifies upgrade.

### 1.7 Success metrics (KPIs)

| KPI | Definition | Target (initial) |
|-----|------------|------------------|
| Verified-skill rate | verified skills ÷ started skills | > 60% |
| Exit-ticket pass-on-first-try | first-attempt passes ÷ exit tickets | 45-70% (too high ⇒ too easy) |
| Tier activation | learners who complete onboarding ÷ signups | > 70% |
| D7 / D30 retention | learners active on day 7 / 30 | > 40% / > 25% |
| Homework-Helper honesty | sessions ending verified ÷ sessions started | tracked, no answer-vending |
| Backlog completion | recovery paths finished ÷ started | > 55% |
| Lab embed adoption **[B2B]** | external domains loading a lab/month | growth MoM |
| p95 route latency | server response, warm | < 400ms |
| Lighthouse (marketing) | perf/a11y/best-practices/SEO | > 90 each |

---

## 2. Functional Requirements

Each feature below is specified with: Purpose · User flow · Business logic · Input/Output · Validation · Errors · Success · Edge cases · Permissions · Dependencies · Data flow · UI behaviour · API · Backend · DB · Notifications · Logs · Analytics.

### 2.1 Learner Onboarding & Tier Selection **[Built]**

**Purpose.** Establish *who is learning* and *why*, so every downstream experience is tier- and goal-appropriate. This is the single front door that resolves the PM's "intent mapping" problem.

**User flow.**
1. Learner lands on `/aquintutor` (home). A **front-door band** offers "Who's learning? Pick your stage" with 8 tier cards, plus fast tiles (Catalogue, My learning path, Practise, Homework help, Clear a backlog, Little ones, Knowledge map, Virtual labs).
2. Selecting a tier card deep-links to `/aquintutor/onboarding?tier=<id>` which **preselects** that stage.
3. Step 1 — confirm/choose tier (8 cards). Step 2 — choose a goal from that tier's goal list; optionally set a daily time limit (minutes).
4. "Start learning" persists the profile and routes to `/aquintutor/learn` (or the tier's signature surface).

**Business logic.**
- Tier must be one of `TIER_IDS`; invalid → coerced to `primary`.
- Goal is free-choice from the tier's `goals[]`; stored as text (≤200 chars).
- `dailyLimitMin` optional integer 5-240.
- Re-running onboarding **updates** the same row (upsert on `user_id`).

**Input/Output.** Input: `{ action:'profile', tier, goal, dailyLimitMin? }`. Output: `{ ok:true }` or `{ ok:false, error }`.

**Validation.** `tier ∈ TIER_IDS` (server re-validates); `goal.length ≤ 200`; `dailyLimitMin` numeric or null.

**Errors.** 401 if not signed in (redirect to `/aquintutor/login?next=…`); 400 bad JSON; 500 with `e.cause?.message`.

**Success.** Profile row present; learner redirected to learning surface with tier context.

**Edge cases.** No goal selected → "Start" disabled. Existing profile → preselect prior tier + goal. Deep-link `?tier=` with unknown id → ignored, learner picks manually.

**Permissions.** Any signed-in learner. Guardians operate on behalf of Tots/Primary children (A1, Q3).

**Dependencies.** Auth (`locals.user`), `aq_learner_profile`, `/api/aquintutor/learn`.

**Data flow.** Client `fetch POST /api/aquintutor/learn {action:'profile'}` → `saveProfile()` upsert → redirect.

**UI behaviour.** Tier cards highlight on select (rust border, lift). Goal chips single-select. Smooth scroll to Step 2. Disabled CTA until goal chosen.

**API.** `POST /api/aquintutor/learn` action `profile` (§8.2).

**Backend.** `saveProfile(userId,{tier,goal,dailyLimitMin})`.

**DB.** `aq_learner_profile` upsert.

**Notifications.** None on save (silent success).

**Logs.** Server error logs `e.cause?.message`. **Analytics:** `onboarding_started`, `tier_selected{tier}`, `goal_selected{tier,goal}`, `onboarding_completed`.

### 2.2 Mastery Tree & Session Engine (Primary track) **[Built]**

**Purpose.** Turn a track (Numeracy, Algebra) into a visible progression of skills with a repeatable learn→verify loop, so progress is *earned and shown*.

**User flow.** `/aquintutor/learn` shows the Mastery Tree for the learner's tier track: nodes are `locked / open / growing / mastered`. Selecting an open node runs a **session**: micro-lesson → hint-ladder question → **Teach-it-Back** (voice recall) → **parametric exit ticket**. Passing the exit ticket flips the skill to `mastered + verified`.

**Business logic.**
- Skill state is **forward-only**: `growing(1) → mastered(2)`; never downgrades. `verified` is sticky-true (`verified = verified OR new`).
- A node is `open` when all prerequisites are `mastered`.
- Exit-ticket parameters are randomized each attempt (type ∈ add/sub/mul/placevalue/fraction/neg/order/onestep/percent/ratio, etc.).

**Input/Output.** Progress: `{action:'progress', skillId, state, verified}`. Verify: `{action:'verify', skillId, verified}`. Teachback: `{action:'teachback', skillId, matched, total, transcript}`.

**Validation.** `skillId` ≤ 80 chars, required for non-profile actions. `state` coerced to `growing|mastered`. `transcript` truncated to 2000 chars server-side.

**Errors.** 401/400/500 as §2.1. Speech API absent → Teach-it-Back degrades to typed recall.

**Success.** `aq_mastery` row updated (forward-only); `aq_verify_log`/`aq_teachback_log` appended; tree re-renders with new state.

**Edge cases.** Repeated verify keeps `mastered`. Offline → progress queued (see §2.14). Wrong exit-ticket answer → does not verify; learner retries (productive failure).

**Permissions.** Signed-in learner (self only).

**Dependencies.** `aq_mastery`, `aq_verify_log`, `aq_teachback_log`, Web Speech API (optional).

**Data flow.** Client actions → `/api/aquintutor/learn` → `setMastery / logVerify / logTeachback`.

**UI.** Node colours by state; locked nodes show prerequisite reason; session panel with hint ladder; mic button for teach-back; success flips node with animation.

**Analytics.** `session_started{skillId}`, `hint_used{skillId,level}`, `teachback_logged{matched,total}`, `exit_ticket_result{skillId,pass}`, `skill_mastered{skillId}`.

### 2.3 Teach-it-Back (voice recall) **[Built]**

**Purpose.** Prove *recall*, not recognition, by having the learner explain a concept aloud.

**User flow.** After a micro-lesson, the learner taps the mic and explains the idea. The transcript is matched against a set of **expected key terms**; a match ratio (`matched/total`) is shown and logged.

**Business logic.** `matched` = count of expected terms present (case-insensitive, stemmed loosely) in transcript. A threshold (e.g. ≥ 60%) contributes to readiness for the exit ticket but never *replaces* it (P1).

**Validation/Errors.** SpeechRecognition unsupported → fallback to a text box; empty transcript → prompt to try again. Transcript stored ≤ 2000 chars.

**Edge cases.** Background noise / mis-recognition → learner can re-record; no penalty. Non-English speech → best-effort; term list is language-scoped per content.

**Data flow.** Client → `{action:'teachback', …}` → `logTeachback`.

**Analytics.** `teachback_started`, `teachback_logged{matched,total}`.

### 2.4 Homework Helper — "never gives the answer" (Sub-Juniors signature) **[Built]**

Route: `/aquintutor/homework`.

**Purpose.** Coach a learner through *their own* homework problem without ever revealing the final answer — the anti-shortcut mechanic.

**User flow.**
1. Learner types a problem (arithmetic, e.g. `38 + 7` or `2 + 3 × 4`; or a linear equation, e.g. `2x + 5 = 15`). May attach a photo *for reference* (parsing is on typed input; the photo is a visual aid only — see Edge cases).
2. Aquin **classifies** the problem, names the **rule**, and shows the **method** (never the answer).
3. Learner enters *their* answer. Aquin checks it against a computed solution; if wrong, it advances the **hint ladder** and refuses to reveal the answer.
4. On a correct self-derived answer, an **exit ticket** (fresh numbers, same type) verifies understanding and logs `verify skillId=homework-<type>`.

**Business logic.**
- Arithmetic solved by a **shunting-yard evaluator** over `+ - * / ( )` with correct precedence.
- Linear equations parsed into `ax+b` per side; solved `x = (bR−bL)/(aL−aR)`; `a=0` → unsupported.
- The computed answer is **never rendered**; only used to grade the learner's attempt.
- Hint ladder = the method steps, revealed one at a time; exhausting it still does not reveal the answer (P2).

**Input/Output.** Input: a problem string (+ optional image, client-side only). Output: rule + method + attempt feedback + exit-ticket verdict. Server output: verify log.

**Validation.** Problem must match arithmetic or single-variable linear grammar; otherwise a friendly "I can coach these kinds…" message. Attempt parsed as number (commas/spaces stripped); non-numeric rejected.

**Errors.** Unparseable input → guidance message, no crash. Photo attach with no typed problem → prompt to type it.

**Success.** Learner solves it themselves; exit ticket passes; `homework-<type>` verified.

**Edge cases.** Division producing non-integers → tolerance `1e-6`. Equation with variables on both sides supported. Photo OCR is **not** performed (P9 / no LLM); the attach is explicitly a reference aid and the UI says so. Task-planner (below) is part of the same surface.

**Sub-feature — Task Planner.** Paste an assignment + due date → the planner splits work into **dated daily micro-tasks** between today and the deadline (Understand → Plan → chunks → Review → Submit), scaled to available days. Pure client-side date math.

**Permissions.** Signed-in learner. **Dependencies.** `/api/aquintutor/learn` (verify). **Analytics.** `homework_classified{type}`, `homework_hint{level}`, `homework_attempt{correct}`, `homework_verified{type}`, `planner_generated{days}`.

### 2.5 Knowledge Graph (Juniors signature) **[Built]**

Route: `/aquintutor/knowledge-graph`.

**Purpose.** Show concepts as a **dependency DAG** so a learner sees *why* each concept matters and *what it unlocks* — directly answering the intent-mapping gap.

**User flow.** An SVG graph of Mechanics (9 nodes: Units → Kinematics/Vectors → Newton's Laws → Friction/Work/Momentum/Circular/Projectile). Nodes are `locked / open / mastered`. Clicking an **open** node shows a refresher + a numeric check; passing **masters** it, redraws edges (downstream lights up), and names what was unlocked. Clicking a **locked** node explains which prerequisites to master first. Clicking a **mastered** node reviews it and lists what it unlocked.

**Business logic.** `open` iff all `pre[]` mastered. Mastery persisted per-user in `localStorage` (key `aq_kg_mech_<uid>`) **and** logged server-side as `verify skillId=kg-mech-<node>`. Forward-only.

**Validation/Errors.** Numeric answer parsed with tolerance; wrong → retry with "re-read the idea." No lockouts.

**Edge cases.** Cleared localStorage → server verify log still exists (dashboard truth); local graph re-derives from scratch (acceptable; server is source of truth for reporting). Multiple subjects → future graphs keyed `kg-<subject>-<node>`.

**Analytics.** `kg_node_opened{node,state}`, `kg_node_mastered{node}`, `kg_unlocks{node,count}`.

### 2.6 Backlog Recovery (Scholars signature) **[Built]**

Route: `/aquintutor/backlog`.

**Purpose.** Convert exam-season backlog panic into a **surgical, goal-filtered recovery** — never "re-watch the whole topic."

**User flow.**
1. Learner picks a topic (Thermodynamics, Integration) + a **target** (Boards / NIT / IIT).
2. A **diagnostic** asks one probe per sub-concept (filtered by target stretch level).
3. Results separate **known** (skipped) from the **exact gaps** (the real backlog), with a realistic time estimate (~15 min each).
4. The **recovery path** runs only the gaps: a tight refresher + a prove-it question each; passing marks the sub-concept recovered and logs `verify skillId=backlog-<topic>-<sub>`.

**Business logic.**
- Stretch tiers: `core` (all targets), `advanced` (NIT+IIT), `elite` (IIT only). `STRETCH = {boards:[core], nit:[core,advanced], iit:[core,advanced,elite]}`.
- A sub-concept is a **gap** iff the diagnostic answer is wrong/empty.
- Time estimate = `gaps × 15 min`.

**Validation/Errors.** Numeric answers with tolerance; no gaps → "no backlog here, move on." Wrong recovery answer → re-read refresher, retry.

**Edge cases.** All correct → celebrate + advise to skip. Target change re-scopes which sub-concepts appear (ROI optimiser).

**Analytics.** `backlog_diagnostic{topic,target,gaps}`, `backlog_recovered{topic,sub}`, `backlog_completed{topic}`.

### 2.7 Voice-First Tots **[Built]**

Route: `/aquintutor/tots`.

**Purpose.** Let a pre-reader learn **unaided** — everything spoken, answers by tap or voice.

**User flow.** Home offers three games (Counting, Shapes & Colours, Letters) as large SVG cards. Every instruction is **spoken** (SpeechSynthesis). The child answers by tapping a large SVG target or by pressing "Say it" and speaking (SpeechRecognition). Correct → spoken praise + a star. Five rounds → celebration; completion logs `verify skillId=tots-<game>`.

**Business logic.** Number words and digit transcripts mapped to integers; letter names parsed to letters. Star counter accumulates in-session. Graceful **tap-only** fallback where speech APIs are absent (mic button hidden).

**Validation/Errors.** Mis-heard speech → "try again," re-listen; no penalty. No text the child must read.

**Edge cases.** SpeechSynthesis unavailable → activities still tappable (silent). Autoplay audio policies: speech triggered by a tap (user gesture) to satisfy browser gating.

**Accessibility.** Oversized targets, high contrast, SVG art (no emoji), no reading required. **Analytics.** `tots_game_started{game}`, `tots_round_correct{game}`, `tots_game_completed{game}`.

### 2.8 Course & Lesson Player **[Built]**

Routes: `/aquintutor/courses/[slug]`, `/aquintutor/learn/[lesson]`, `/aquintutor/player`.

**Purpose.** Deliver structured courses/lessons for tiers that use a catalogue (Primary→Atelier), always coupled to verification.

**Business logic.** A course has ordered lessons; a lesson has content blocks + an exit check. Completion is gated on the check (P1). Admin authoring at `/aquintutor/admin/courses/*`.

**Validation/Errors/Edge.** Missing content → skeleton + empty state; unauthorized edit → 403.

**Analytics.** `lesson_started`, `lesson_completed`, `lesson_verified`.

### 2.9 Practice Hub **[Built]**

Route: `/aquintutor/practice-hub`, `/aquintutor/practice/[slug]`.

**Purpose.** On-demand, low-stakes practice separate from graded assessment; feeds mastery signals without exam pressure.

**Business logic.** Parametric question generators per skill; unlimited attempts; optional streaks. Practice never sets `verified` on its own (only exit tickets do).

**Analytics.** `practice_started{slug}`, `practice_attempt{correct}`.

### 2.10 Assessments, Tests & Exams **[Built]**

Routes: `/aquintutor/tests`, `/aquintutor/test/[slug]`, `/aquintutor/test/[slug]/run`, `/aquintutor/test/[slug]/result`, `/aquintutor/exams`.

**Purpose.** Formal, timed assessment with results and (optionally) advisory proctoring.

**Business logic.** Timed runner (full-screen; uses `era-no-fab` to hide the floating action button). Auto-submit on timeout. Results computed server-side and stored. **Proctoring is advisory-only (P6):** any camera/tab-switch/focus signals are stored as flags for **human** review and **never** alter the score automatically.

**Validation/Errors.** Network drop mid-test → answers autosaved/queued; resume where left off. Double-submit guarded by attempt token.

**Edge cases.** Clock skew → server time authoritative. Refresh → resume same attempt. **Analytics.** `test_started`, `test_submitted`, `test_scored`, `proctor_flag{type}` (advisory).

### 2.11 Virtual Labs (learner-facing) **[Built]**

Routes: `/aquintutor/labs`, `/aquintutor/labs/*` (e.g. `cybersecurity`, `ai-ml`, `vlsi`, `dsp`, `robotics`, `fourier`, `neural-net`, plus 40+ benches).

**Purpose.** Hands-on, hand-built simulations that *demonstrate* understanding (P9). Elite depth (client bar: "market-ready, embeddable as an API").

**Business logic.** Each lab is a self-contained page (chromeless when opened as a tool; `isLabTool` in the layout strips chrome). Simulations are authentic (e.g., BSP-CSG geometry, CST plane-stress FEA, radix-2 FFT, MLP backprop, statevector quantum sim, stack-overflow exploit sandbox, 8-bit MCU emulator). Labs emit progress/complete via the event bridge (§2.12) and can log verification.

**UI.** Full-bleed canvas/WebGL; `<style is:global>` for all JS-created DOM (Astro scopes `<style>` by default — JS-created elements would otherwise be unstyled; this is a hard rule). **Analytics.** `lab_opened{slug}`, `lab_progress{slug,pct}`, `lab_completed{slug}`.

### 2.12 Labs-as-Product: Embed, SDK, iframe, LTI **[Built] [B2B]**

Routes/assets: `/labs` (licensing page), `/api/labs/catalog.json`, `public/era-labs-embed.js`, `/api/lti/launch`, `/api/lti/score`, `/admin/lti`.

**Purpose.** Let any institution embed a lab **into their own virtual infrastructure** — as an iframe, a JS SDK mount, or an LTI 1.1 tool with grade passback.

**Business logic.**
- **Embed mode:** `?embed=1` renders chromeless + `noindex` and injects an event bridge exposing `window.eraLab.{ready,progress,complete,event}`, which `postMessage`s to the parent and (for LTI) posts to `/api/lti/score`.
- **SDK:** including `era-labs-embed.js` + `<div data-era-lab="slug">` auto-mounts a sandboxed iframe and relays lab events as a DOM `era-lab` event.
- **Catalog API:** `GET /api/labs/catalog.json` (public, CORS) returns each lab's embed/iframe/sdk/lti metadata.
- **LTI 1.1:** OAuth 1.0 HMAC-SHA1 signed launches (`lti_consumers`, `lti_launches`), Basic Outcomes `replaceResult` grade passback with `oauth_body_hash`. Consumer keys managed at `/admin/lti` (super_admin).

**Security.** Sandboxed iframe; CORS on catalog; per-consumer shared secret; timing-safe signature comparison. **Analytics.** `embed_loaded{slug,host}`, `lti_launch{consumer}`, `lti_score_sent{consumer,score}`.

### 2.13 Verified-progress hub + Parent / Teacher view **[Built]**

**Purpose.** Show **verified** progress (never vanity hours) to the learner and, via a shareable read-only link, to a guardian or teacher.

**Built implementation.**
- `src/lib/aquintutor-summary.ts:getVerifiedSummary(userId)` aggregates every tier signal: `aq_mastery` (verified / growing / mastered-but-unverified), `aq_verify_log` (recent exit tickets), `aq_teachback_log`, `aq_srs_card` (recall due/mature/total), `aq_ref` + `aq_thesis_step` (research), `aq_atelier_evidence` (credential). Every query guarded so a missing table contributes nothing. Takes **any** `userId`, so the guardian view reuses it unchanged.
- **Owner view** `/aquintutor/mastery`: leads with skills-verified; flags "marked done but not yet verified" as a warning (completing ≠ understanding); renders via the shared `components/aquintutor/VerifiedSummary.astro`.
- **Guardian/teacher view:** the learner mints an unguessable read-only token (`aq_progress_share`) at `/aquintutor/mastery` and shares `/aquintutor/shared-progress/[token]` — no account needed for the viewer, revocable any time. This resolves **Q3** in favour of a share-link model (no fragile account-linking).

**API.** `GET/POST /api/aquintutor/progress-share` (create/list/revoke). **Analytics.** `dashboard_viewed{role}`, `share_created`, `share_revoked`.

### 2.14 Offline-First Learning (PWA) **[Built]**

**Purpose.** Core learning works without connectivity; nothing is lost.

**Business logic.** A versioned service worker (bump on each change) caches `/aquintutor` learning surfaces for offline; `/api` and `/admin` are online-only. Learner writes (progress/verify) are queued in **IndexedDB** (`public/offline-sync.js`) and flushed to the server when back online (mirrored to the `offline_work` table; admin view `/admin/offline-work`).

**Business rule.** Service-worker cache strategy: navigations use network-first-with-timeout then cache; static assets stale-while-revalidate. **Edge cases.** Version bump must invalidate stale precache; a stale prod deploy can make "live fixes" appear not to work (check `npx vercel ls`). **Analytics.** `offline_queued{action}`, `offline_flushed{count}`.

### 2.15 Rewards, Streaks, Leaderboards, Profile **[Built]**

Routes: `/aquintutor/rewards`, `/aquintutor/achievements`, `/aquintutor/leaderboard`, `/aquintutor/league`, `/aquintutor/profile`, `/aquintutor/progress`.

**Purpose.** Motivation aligned to *verified* progress, not time spent.

**Business rule.** Points/streaks accrue from verified skills and completed sessions, never from mere minutes (P1). Leaderboards are opt-in and privacy-safe (display name only). **Analytics.** `reward_earned`, `streak_incremented`, `leaderboard_viewed`.

### 2.16 Institutional / School surfaces **[Built/Partial] [B2B]**

Routes: `/aquintutor/schools`, `/aquintutor/schools/[slug]`, `/aquintutor/classrooms`, `/aquintutor/classrooms/[id]`, `/aquintutor/classroom`, `/aquintutor/instructors`, `/aquintutor/admin/*`.

**Purpose.** Let schools organize learners into classrooms, assign work, and monitor verified progress; instructors author/curate; partners/payouts for content contributors.

**Business rule.** Classroom membership scopes visibility; teachers see only their classroom's learners. Seat licensing per Q4 (default sales-assisted). **Analytics.** `classroom_created`, `assignment_issued`, `classroom_progress_viewed`.

### 2.17 AI Micro-Tutor (optional, gated) **[Planned]**

**Purpose.** An optional conversational Socratic helper for stuck moments — *additive*, never replacing verification.

**Business rule.** Disabled unless an API key is configured **and** a paid flag is set (A2, Q2). Must still obey P2 (never hands over answers) and P6/P1. When disabled, the platform is fully functional via authored content. **Analytics.** `microtutor_invoked`, `microtutor_hint_shown`.

---

## 3. Complete User Experience

### 3.1 Global shell & navigation

- **AquintutorLayout** is the only shell for learner surfaces (P7). It provides the AquinTutor header (breadcrumb `AQUINTUTOR / <SECTION>`), typographic system (Fraunces display, Inter Tight body, JetBrains/Geist Mono for labels/numerals), and the paper/ink/rust palette (`--ink`, `--ink-500`, `--rust`, `--rule`, `--sand-50/100`).
- **Floating action button (FAB):** body carries `era-has-fab`; full-screen runners (tests, some labs) set `era-no-fab` to hide it.
- **Chromeless modes:** lab tools (`isLabTool`) and embed (`?embed=1`) render without chrome.
- **Breadcrumbs** appear as the mono strip under the header on every deep page.

### 3.2 Home / front door (`/aquintutor`)

Hero → **stage picker band** ("Who's learning?") with 8 tier cards (each → `/onboarding?tier=`) → **fast tiles** row (Catalogue, My learning path, Practise, Homework help, Clear a backlog, Little ones, Knowledge map, Virtual labs). Below: value props (verified learning, one lifelong record, hands-on labs) — never price-led (P8), never naming competitors (P4).

### 3.3 Page/screen inventory (learner)

| Surface | Route | State variants |
|---------|-------|----------------|
| Home / front door | `/aquintutor` | default |
| Onboarding | `/aquintutor/onboarding` | new, returning (preselected), `?tier=` deep-link |
| Learn / Mastery Tree | `/aquintutor/learn` | locked/open/growing/mastered nodes; session panel; empty (no profile → redirect) |
| Homework Helper | `/aquintutor/homework` | idle, classified, hint-laddered, exit-ticket, planner |
| Knowledge Graph | `/aquintutor/knowledge-graph` | node locked/open/mastered; panel learn/mastered/locked |
| Backlog Recovery | `/aquintutor/backlog` | setup, diagnostic, results, recovery, done |
| Tots | `/aquintutor/tots` | home, 3 games, finish |
| Recall (SRS) | `/aquintutor/recall` | due queue, reveal, grade, caught-up |
| Research desk | `/aquintutor/research-workspace` | refs list/add/edit, cite, thesis tracker |
| Credential path | `/aquintutor/credential-path` | track picker, competency logbook, portfolio-ready |
| Verified progress | `/aquintutor/mastery` | summary + share-link management; empty |
| Shared progress (guardian) | `/aquintutor/shared-progress/[token]` | read-only; invalid/revoked notice |
| Courses / Lessons / Player | `/aquintutor/courses/[slug]`, `/learn/[lesson]`, `/player` | list, detail, playing, completed |
| Practice Hub | `/aquintutor/practice-hub`, `/practice/[slug]` | idle, attempting, streak |
| Tests / Exams | `/aquintutor/tests`, `/test/[slug]`, `/test/[slug]/run`, `/result`, `/exams` | preflight, running (timed), submitted, result |
| Labs index + tools | `/aquintutor/labs`, `/labs/*` | catalogue, running sim |
| Rewards/Achievements/Leaderboard/League | respective routes | earned/empty |
| Profile / Progress / Transcript | `/aquintutor/profile`, `/progress`, `/transcript` | populated/empty |
| Notifications | `/aquintutor/notifications` | list/empty |
| Login | `/aquintutor/login` | multi-method (password/passkey/face/TOTP) |
| Instructors / Schools / Classrooms | respective routes | list/detail |
| Admin | `/aquintutor/admin/*` | role-gated |

### 3.4 Components, widgets, and interaction states

- **Cards** (tier, fast-tile, course, lab): rounded 11-22px, 1.5px `--rule` border, hover lift, `:active` scale-down.
- **Mastery nodes:** rectangles/circles colour-coded by state, with check/lock glyphs (SVG).
- **Hint ladder:** left-accent info panels revealed sequentially.
- **Mic control:** rust pill "Say it"; "Listening…" transient; result parsed then restored.
- **Graphs:** responsive SVG in an `overflow-x:auto` container; never cause horizontal body scroll.
- **Tables** (admin): sticky header, row hover, bulk-select, CSV export.
- **Forms:** labeled inputs, inline validation, disabled CTAs until valid.

### 3.5 Empty, loading, skeleton, success, warning, error, confirmation states

| State | Behaviour |
|-------|-----------|
| Empty | Friendly one-liner + primary action (e.g. "No profile yet → Set up your path"). Never a blank screen. |
| Loading | Skeleton blocks matching final layout; spinners only for short waits. |
| Skeleton | Cards/tables show placeholder bars before data resolves. |
| Success | Inline green confirmation ("Verified.", "Mastered."), spoken praise for Tots. |
| Warning | Amber inline (e.g., "This won't verify until you pass the exit ticket."). |
| Error | Rust inline message; never a raw stack trace; retry affordance. |
| Confirmation | Destructive admin actions (delete all) require an explicit confirm dialog. |
| Offline | Banner "You're offline — your progress is saved and will sync." |

### 3.6 Responsive, mobile, tablet, desktop

- Layouts use flex/grid with relative units; graphs and tables scroll inside their own containers; images `max-width:100%`.
- Tots and Homework are **touch-first** (large targets).
- Breakpoints: single-column < 640px, two-column 640-1024px, full grid > 1024px.

### 3.7 Accessibility

- WCAG 2.1 AA: contrast ≥ 4.5:1; visible focus rings; keyboard operable (Enter submits answers; Tab order logical).
- Speech features have text fallbacks (Teach-it-Back typed, Tots tap-only).
- SVG icons carry `aria-label`/`role` where meaningful; decorative art is `aria-hidden`.
- No information conveyed by colour alone (state also shown by glyph/label).

### 3.8 Keyboard shortcuts

- Enter = submit answer (Homework, Backlog, Knowledge Graph, exit tickets).
- Esc = close panel/back to games (Tots).
- Admin tables: Ctrl/Cmd-A select-all (scoped), Del = delete selected (with confirm).

### 3.9 Animations & transitions

- Node state changes animate (scale/opacity), respecting `prefers-reduced-motion`.
- 60fps target (P10); no layout thrash; transforms/opacity only for motion.

---

## 4. Business Logic (rules engine)

### 4.1 Validation rules (canonical)

| Field | Rule |
|-------|------|
| `tier` | ∈ `TIER_IDS`; else coerce `primary`. |
| `goal` | text ≤ 200 chars. |
| `dailyLimitMin` | int 5-240 or null. |
| `skillId` | text ≤ 80; required for progress/verify/teachback. |
| `transcript` | truncated to 2000 chars. |
| numeric answers | parsed with commas/spaces stripped; tolerance `1e-6`. |
| problem grammar (Homework) | arithmetic `[\d+\-*/()×÷.\s]` with an operator, or single-var linear with `=` and `x`. |

### 4.2 Permissions (RBAC summary; full matrix §9.3)

- **Learner:** own profile/mastery/logs; own sessions.
- **Guardian:** operate a linked child's Tots/Primary session (Q3 default: view/act toggle on the account).
- **Teacher [B2B]:** their classroom's learners' progress; author lessons.
- **Partner [B2B]:** their contributed content + payouts.
- **Admin / super_admin:** platform config; `/aquintutor/admin/*`; LTI keys (super_admin).

### 4.3 Approval workflows

- Content publish: author (draft) → review → publish (teacher/admin gate).
- Proctor flags: system flag → human review → decision (P6; no auto-action).
- Payouts [B2B]: accrue → admin approve → mark paid.

### 4.4 Calculations

- Mastery state = `max(existing_rank, new_rank)` where `growing=1, mastered=2`.
- `verified = verified OR new_verified` (sticky).
- Backlog time estimate = `gaps × 15 min`.
- Teach-back ratio = `matched / total`.
- CHF→INR paise = `round(chf × rate × 100)` for Razorpay (rate from config).

### 4.5 Automation & scheduling

- Vercel cron on Hobby is **daily-only**; a sub-daily cron in `vercel.json` silently fails *all* deploys — never add one.
- Scheduled reminders (daily-limit nudges, streak reminders) run via the daily cron and in-app.

### 4.6 State transitions

- Skill: `locked → open → growing → mastered` (forward-only; `verified` orthogonal, sticky-true).
- Test attempt: `preflight → running → submitted → scored` (+ `expired` on timeout).
- Course: `not-started → in-progress → completed(verified)`.
- Backlog sub-concept: `unknown → gap → recovered`.

### 4.7 Dependencies & conflict resolution

- A node opens only when all prerequisites are mastered (DAG must be acyclic — enforced by authored data).
- Concurrent writes to `aq_mastery` resolved by the forward-only SQL `CASE` (last-writer-can't-downgrade).
- Offline replays are idempotent (verify/progress upserts are safe to re-apply).

### 4.8 Exception handling & retry

- Client fetches to `/api/aquintutor/learn` are fire-and-forget with local optimism; failures are queued offline and retried on reconnect.
- Server wraps DB ops in try/catch; returns `e.cause?.message` (real Postgres reason) not the SQL string.
- Neon compute exhaustion (all routes 500, sessions query fails) is a *capacity* signal, not an attack → reduce polling; upgrade plan.

---

## 5. Database Design

### 5.1 Conventions

- Engine: **Neon Postgres**; access via **Drizzle ORM over postgres-js**.
- **postgres-js returns plain arrays** — always normalize: `const rows = (r) => Array.isArray(r) ? r : (r?.rows || [])`. Never `r.rows[0]` blindly.
- **Errors:** the real reason is in `e.cause?.message` (Drizzle's `e.message` is only the failed SQL).
- **Self-bootstrapping schema:** app tables are created/altered at runtime via `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, memoized once per process (`ensure*` promise). No migration files for app tables.
- **Prod-only manual migrations** live in `.dev-scripts/*.cjs` (gitignored) and are run by the operator — the assistant hands over the command, it does not run prod DB changes.
- Timestamps are `TIMESTAMPTZ DEFAULT NOW()`. UUID PKs via `gen_random_uuid()`.

### 5.2 Core AquinTutor entities (existing) **[Built]**

**`aq_learner_profile`**
| Field | Type | Constraints |
|-------|------|-------------|
| `user_id` | UUID | **PK** (one profile per user) |
| `tier` | TEXT | NOT NULL DEFAULT `'primary'`, ∈ TIER_IDS |
| `goal` | TEXT | nullable, ≤ 200 chars |
| `daily_limit_min` | INT | nullable, 5-240 |
| `updated_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() |

**`aq_mastery`**
| Field | Type | Constraints |
|-------|------|-------------|
| `user_id` | UUID | NOT NULL, PK part |
| `skill_id` | TEXT | NOT NULL, PK part |
| `state` | TEXT | NOT NULL DEFAULT `'growing'` (`growing`/`mastered`) |
| `verified` | BOOLEAN | NOT NULL DEFAULT false (sticky-true) |
| `updated_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() |
| | | **PK (`user_id`,`skill_id`)** |

Forward-only update rule (verbatim intent): `state = CASE WHEN new_rank > existing_rank THEN new ELSE existing END; verified = verified OR new`.

**`aq_verify_log`** (append-only exit-ticket outcomes)
| Field | Type | Constraints |
|-------|------|-------------|
| `id` | UUID | PK DEFAULT gen_random_uuid() |
| `user_id` | UUID | NOT NULL |
| `skill_id` | TEXT | NOT NULL |
| `verified` | BOOLEAN | NOT NULL |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() |

**`aq_teachback_log`** (append-only recall attempts)
| Field | Type | Constraints |
|-------|------|-------------|
| `id` | UUID | PK |
| `user_id` | UUID | NOT NULL |
| `skill_id` | TEXT | NOT NULL |
| `matched` | INT | nullable |
| `total` | INT | nullable |
| `transcript` | TEXT | ≤ 2000 chars |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() |

### 5.2b Tier-signature entities (existing) **[Built]**

All self-bootstrapping (create themselves at runtime on first request; no manual migration).

- **`aq_srs_card`** (Tutor / Recall): PK (`user_id`,`card_id`); `deck`, `ease REAL` (2.5), `interval_days INT`, `reps INT`, `lapses INT`, `due_at TIMESTAMPTZ`. SM-2 scheduler in `src/lib/aquintutor-srs.ts:schedule()` (shared by API + client previews).
- **`aq_ref`** (Research): PK `id` UUID; `user_id`, `title`, `authors`, `year INT`, `venue`, `url`, `tags`, `status` (`to-read`/`reading`/`read`/`cited`), `notes`; index (`user_id`,`created_at DESC`).
- **`aq_thesis_step`** (Research): PK (`user_id`,`step_key`); `done BOOLEAN`. Steps are the fixed `THESIS_STEPS` list (11).
- **`aq_atelier_evidence`** (Atelier): PK (`user_id`,`track`,`competency_key`); `demonstrated BOOLEAN`, `evidence TEXT`.
- **`aq_progress_share`** (guardian view): PK `token`; `user_id`, `label`, `created_at`, `revoked_at`. Unguessable token; revoke = set `revoked_at`.

### 5.3 Supporting entities (existing / referenced) **[Built/Partial]**

- **Courses/Lessons** (authoring under `/aquintutor/admin/courses/*`): `aq_course(id, slug, title, tier, status…)`, `aq_lesson(id, course_id, ordinal, title, content_json, check_json…)`.
- **Tests/Attempts:** `aq_test(id, slug, title, duration_s, config…)`, `aq_test_attempt(id, user_id, test_id, state, started_at, submitted_at, score, answers_json, proctor_flags_json…)`.
- **LTI:** `lti_consumers(key, secret, name, created_at)`, `lti_launches(id, consumer_key, user_ref, resource, nonce, created_at)`.
- **Offline mirror:** `offline_work(id, user_id, action, payload_json, created_at, applied_at)`.
- **Payments (platform):** Razorpay order/verify records (shared with host).

> Field lists for supporting entities are indicative; the authoritative definition is the `ensure*` DDL in the corresponding `src/lib/*` module. New columns are added via `ADD COLUMN IF NOT EXISTS`, never destructive `ALTER`.

### 5.4 Indexes

| Table | Index | Reason |
|-------|-------|--------|
| `aq_mastery` | PK (`user_id`,`skill_id`) | point lookups + upsert |
| `aq_verify_log` | (`user_id`,`created_at`) **[Planned]** | dashboard queries |
| `aq_teachback_log` | (`user_id`,`created_at`) **[Planned]** | dashboard queries |
| `aq_test_attempt` | (`user_id`,`test_id`) **[Planned]** | resume/attempt lookup |
| `lti_launches` | (`consumer_key`,`nonce`) **[Planned]** | replay protection |

### 5.5 Relationships

- `aq_learner_profile.user_id` → platform `users.id` (1:1).
- `aq_mastery / aq_verify_log / aq_teachback_log .user_id` → `users.id` (1:N).
- `aq_lesson.course_id` → `aq_course.id` (N:1).
- `aq_test_attempt.test_id` → `aq_test.id` (N:1); `.user_id` → `users.id`.
- `lti_launches.consumer_key` → `lti_consumers.key`.

### 5.6 Cascading, soft-delete, versioning, audit, migration

- **Cascade:** deleting a user cascades to their AquinTutor rows **[Planned]** (currently orphan-safe by query scoping).
- **Soft delete:** content entities use a `status`/`deleted_at` rather than hard delete; logs are append-only (never deleted).
- **Versioning:** lessons/tests keep `content_json` snapshots; edits create new versions **[Planned]**.
- **Audit history:** verify/teachback logs *are* the learning audit trail; admin actions logged (§9.12).
- **Migration:** additive only at runtime; prod-only structural changes via `.dev-scripts/*.cjs` run by the operator.

---

## 6. Backend Architecture

### 6.1 Runtime & modules

- **Astro 5 SSR** on the **Vercel adapter**. Pages under `src/pages/**`; API routes are `src/pages/api/**/*.ts` exporting `GET/POST` handlers (`APIRoute`).
- **Domain libs** in `src/lib/*`: `aquintutor-learn.ts` (profiles/mastery/logs), `lti.ts` (LTI provider), `resume.ts`, `founder.ts`, `products-seed.ts`, `db.ts` (Drizzle client), auth libs.
- **Data catalogs** in `src/data/*` (labs-catalog, role-catalog, tracks).

### 6.2 Services (logical)

| Service | Responsibility | Key functions |
|---------|----------------|---------------|
| LearnService | profiles, mastery, verify, teachback | `saveProfile`, `getProfile`, `getMastery`, `setMastery`, `logVerify`, `logTeachback` |
| SchemaService | runtime bootstrap | `ensureLearnSchema` and peers (memoized) |
| AssessmentService | tests, attempts, scoring | attempt lifecycle, autosave, scoring |
| LabEventService | embed/LTI event bridge | `window.eraLab.*` → `/api/lti/score` |
| LtiService | OAuth1 sign/verify, grade passback | `verifyLaunch`, `createConsumer`, `storeLaunch`, `sendGrade` |
| OfflineSyncService | queue replay | flush IndexedDB → `offline_work` |
| PaymentService | Razorpay orders/verify | `createOrder`, `verifyPaymentSignature`, `fetchPayment` |

### 6.3 Controllers / API routes (representative)

- `POST /api/aquintutor/learn` — profile/progress/verify/teachback (§8.2).
- `GET /api/labs/catalog.json` — public labs catalog (CORS).
- `POST /api/lti/launch`, `POST /api/lti/score` — LTI provider.
- Admin/content endpoints under `/api/aquintutor/admin/*` **[Partial]**.

### 6.4 Authentication & authorization

- **Self-built multi-method auth** (P9): any **one** of password / passkey-fingerprint / WebAuthn face / authenticator TOTP signs a user in (not stacked factors). WebAuthn is hand-implemented — never add `@simplewebauthn` or an external auth SDK.
- Middleware populates `Astro.locals.user`; pages/handlers gate on it (`if (!user) redirect('/aquintutor/login?next=…')`).
- Role checks: `user.role` (e.g. `super_admin`); LTI key admin gated to super_admin; `/founder/admin` gated to `siddharth@edurankai.in` only (host feature).

### 6.5 Middleware

- Auth/session resolution; request logging; embed-mode detection (`?embed=1` → chromeless + noindex + bridge); lab-tool detection (`isLabTool`).

### 6.6 Background jobs & queues

- **Daily Vercel cron** only (Hobby limit). Jobs: reminders, streak maintenance, log rollups **[Planned]**.
- **Client-side queue:** IndexedDB offline queue flushed on reconnect (not a server queue).

### 6.7 Caching, rate limiting, storage, search, logging, monitoring, backup

- **Caching:** SSR responses cache-controlled per route; static assets via Vercel CDN; service-worker cache for offline.
- **Rate limiting:** per-IP/user on write endpoints **[Planned]** (esp. verify/teachback and payments).
- **File storage:** `@vercel/blob` (photos, resume PDFs, uploads).
- **Search:** in-catalogue filtering client-side + server queries; full-text **[Planned]**.
- **Logging:** structured server logs (`e.cause?.message`); Vercel logs.
- **Monitoring:** Vercel analytics; Neon compute usage watch (capacity guard).
- **Backup/recovery:** Neon PITR (plan-dependent); logs append-only; §14.8.

---

## 7. Frontend Architecture

### 7.1 Folder structure (relevant)

```
src/
  layouts/            AquintutorLayout.astro (learner shell), BaseLayout.astro (host; embed/lab-tool logic)
  pages/aquintutor/   home, onboarding, learn, homework, knowledge-graph, backlog, tots,
                      courses/, learn/[lesson], player, practice-hub, practice/, tests, test/,
                      exams, labs/, rewards, achievements, leaderboard, profile, progress,
                      transcript, notifications, login, schools/, classrooms/, instructors/, admin/
  pages/api/aquintutor/learn.ts
  pages/api/labs/catalog.json.ts
  pages/api/lti/launch.ts, score.ts
  lib/                aquintutor-learn.ts, lti.ts, db.ts, auth*, resume.ts, founder.ts
  data/               labs-catalog.ts, role-catalog.ts, tracks
public/               era-labs-embed.js, offline-sync.js, service worker, era/ assets
```

### 7.2 Component hierarchy & rendering model

- Astro pages render server-side; interactive logic is **inline `<script is:inline>`** (or `define:vars` to pass server data). No heavy SPA framework is required for the learning loops.
- **Critical Astro rule:** `<style>` is **scoped by default**; JS-created DOM elements do **not** receive scoped hashes and render unstyled. All styles targeting JS-generated elements must be in **`<style is:global>`**. (This bug has recurred; treat as a hard convention.)

### 7.3 State management

- Per-page ephemeral state in inline scripts; durable learner state in Postgres via the learn API; local persistence via `localStorage` (e.g., knowledge-graph mastery) and IndexedDB (offline queue).
- Server is the source of truth for reporting; local caches are optimistic.

### 7.4 Routing

- File-based Astro routing. Deep-link params drive behaviour (`?tier=`, `?embed=1`, `[slug]`, `[lesson]`).

### 7.5 Reusable UI, design system, forms

- Palette tokens (`--ink`, `--rust`, `--rule`, `--sand-*`); fonts (Fraunces/Inter Tight/mono). SVG glyphs only (no emoji, P5). Cards/buttons/inputs share consistent radii and borders.
- Forms: labeled inputs, inline validation, disabled-until-valid CTAs, Enter-to-submit.

### 7.6 API integration, error boundaries, performance

- `fetch` with `credentials:'same-origin'`; JSON in/out; failures degrade gracefully (offline queue).
- No uncaught exceptions in inline scripts (wrap risky ops); user-facing errors are inline messages.
- Performance: minimal JS, lazy-load labs' heavy canvases, images `max-width:100%`, wide content scrolls in its own container. 60fps (P10).

### 7.7 Accessibility & responsive

- Per §3.7/§3.6. Speech features have non-speech fallbacks. `prefers-reduced-motion` respected. `prefers-color-scheme` handled where theming applies.

---

## 8. APIs

### 8.1 Conventions

- JSON request/response; `Content-Type: application/json`. Auth via session (`locals.user`). Errors: `{ ok:false, error }` with appropriate status. Server never leaks SQL; returns `e.cause?.message`.
- CORS: closed by default; **open only** on the public labs catalog.

### 8.2 `POST /api/aquintutor/learn` **[Built]**

Persist learner progress. **Auth:** required (401 otherwise).

**Actions & payloads**

| action | payload | effect |
|--------|---------|--------|
| `profile` | `{ tier, goal?, dailyLimitMin? }` | upsert `aq_learner_profile` |
| `progress` | `{ skillId, state, verified? }` | forward-only `setMastery` |
| `verify` | `{ skillId, verified }` | append `aq_verify_log`; if `verified`, `setMastery(mastered,true)` |
| `teachback` | `{ skillId, matched, total, transcript }` | append `aq_teachback_log` |

**Validation.** `tier ∈ TIER_IDS` else `primary`; `goal ≤ 200`; `skillId ≤ 80` required for non-profile; `transcript ≤ 2000`.

**Responses.** `200 {ok:true}` · `400 {ok:false,error:'bad json'|'skillId required'|'unknown action'}` · `401 {ok:false,error:'Sign in first'}` · `500 {ok:false,error:<cause>}`.

**Example.**
```
POST /api/aquintutor/learn
{ "action":"verify", "skillId":"kg-mech-newton", "verified":true }
→ 200 { "ok": true }
```

### 8.3 `GET /api/labs/catalog.json` **[Built]**

Public (CORS) catalog of labs with embed/iframe/sdk/lti metadata. **Auth:** none. **Response:** `{ labs:[{ slug, title, category, embedUrl, iframe, sdk, lti }...] }`. Cache-friendly.

### 8.4 `POST /api/lti/launch` and `POST /api/lti/score` **[Built]**

LTI 1.1 provider. `launch` verifies OAuth 1.0 HMAC-SHA1 signatures against `lti_consumers`, stores the launch, and renders the tool. `score` posts a Basic Outcomes `replaceResult` (grade passback) with `oauth_body_hash`. **Auth:** OAuth1 signature (not session). **Errors:** 401 on bad signature; nonce replay rejected.

### 8.5 Endpoint index (representative; full list in code)

| Method | URL | Auth | Purpose |
|--------|-----|------|---------|
| POST | `/api/aquintutor/learn` | session | profiles/mastery/verify/teachback |
| GET/POST | `/api/aquintutor/srs` | session | Recall: seed deck, due queue, SM-2 grade |
| GET/POST | `/api/aquintutor/research` | session | references (CRUD) + thesis steps |
| GET/POST | `/api/aquintutor/atelier` | session | credential competencies + evidence |
| GET/POST | `/api/aquintutor/progress-share` | session | create/list/revoke read-only share links |
| GET | `/api/labs/catalog.json` | none (CORS) | labs product catalog |
| POST | `/api/lti/launch` | OAuth1 | LTI tool launch |
| POST | `/api/lti/score` | OAuth1 | LTI grade passback |
| POST | `/api/aquintutor/admin/*` | admin | content/config **[Partial]** |
| POST | `/api/payments/*` | session | Razorpay order/verify (host) |

### 8.6 Versioning strategy

- Current APIs are unversioned under `/api/*`. Breaking changes introduce `/api/v2/*` while keeping v1 until deprecation (§17.7). The labs catalog carries a `version` field for consumers.

---

## 9. Security

### 9.1 Authentication

- Self-built multi-method (password / passkey / WebAuthn face / TOTP); any one authenticates (P9). Passwords hashed (host standard); WebAuthn credentials stored server-side. No external auth SDKs.

### 9.2 Session management

- Server sessions resolved by middleware into `locals.user`. Cookies HTTP-only, `Secure`, `SameSite=Lax`. Session-loss symptom ("logins seem to have slept") traced to compute exhaustion, not auth bugs — see capacity guard.

### 9.3 Authorization / RBAC matrix

| Capability | Learner | Guardian | Teacher | Partner | Admin | Super-admin |
|-----------|:---:|:---:|:---:|:---:|:---:|:---:|
| Own profile/mastery | ✓ | ✓(child) | – | – | ✓ | ✓ |
| View classroom progress | – | – | ✓(own) | – | ✓ | ✓ |
| Author/publish content | – | – | ✓ | ✓(own) | ✓ | ✓ |
| Configure LTI keys | – | – | – | – | – | ✓ |
| Platform config/admin | – | – | – | – | ✓ | ✓ |
| Founder admin (host) | – | – | – | – | – | siddharth only |

### 9.4 Encryption & secrets

- TLS in transit (Vercel). Secrets in Vercel env vars (never committed): DB URL, blob token, Razorpay `KEY_ID`/`SECRET`, LTI secrets. **Do not edit `.env` without explicit operator approval.** Razorpay keys live in **prod only** — test paid flows on the deployed site.

### 9.5 CSRF / XSS / SQLi / SSRF

- **CSRF:** same-origin fetches + SameSite cookies; state-changing POSTs require session.
- **XSS:** never inject unsanitized user text as HTML; prefer text nodes; sanitize any rich content. Inline scripts use server-provided `define:vars`, not string-built markup from user input.
- **SQLi:** parameterized Drizzle `sql` templates only; no string concatenation into SQL.
- **SSRF:** no server-side fetch of user-supplied URLs; labs/embed run client-side in sandboxed iframes.

### 9.6 File-upload security

- Uploads (photos, resume) go to `@vercel/blob`; validate MIME/type/size client- and server-side; store as opaque blobs; never execute. Photos in Homework are client-side only (not parsed server-side).

### 9.7 Input sanitization

- Length caps everywhere (`goal ≤ 200`, `skillId ≤ 80`, `transcript ≤ 2000`); numeric parsing strict; unknown actions rejected.

### 9.8 Audit logging & compliance

- Verify/teachback logs form the learning audit trail. Admin actions logged. **Proctoring advisory-only (P6)** — no automated penalties; camera/AV data handled with consent and minimal retention. Child-data (Tots/Primary) handled under guardian consent; minimize PII; comply with applicable child-privacy norms (COPPA/GDPR-K spirit) **[Assumption A-privacy]**.

### 9.9 Lab/embed isolation

- Embeds render in **sandboxed iframes**; the event bridge only `postMessage`s structured events; LTI uses per-consumer secrets with timing-safe comparison and nonce replay protection.

---

## 10. Performance

### 10.1 Strategy & floors

- Lighthouse > 90 (perf/a11y/best-practices/SEO) on marketing surfaces; 60fps interactions; p95 warm route < 400ms.

### 10.2 Caching / DB / query optimization

- SSR + CDN for static; service-worker offline cache. Queries are point-lookups on PK where possible; add planned indexes (§5.4). Avoid N+1 by batching mastery reads (`getMastery` returns a map).
- **Neon capacity guard:** minimize background polling/reconcile so the compute can auto-suspend; if every route 500s and the sessions query fails, that is compute exhaustion → reduce polling and upgrade plan (not an attack).

### 10.3 Image optimization / CDN / lazy loading / streaming

- Images responsive, compressed, `max-width:100%`; heavy lab canvases lazy-initialized on view; embed assets self-contained.

### 10.4 Scalability / load balancing / HA

- Stateless SSR scales horizontally on Vercel; DB is the shared state (Neon). HA via managed platform; scale-out path in §17.3.
- **Deploy ceiling:** Vercel Hobby = 100 deploys/day; on "Resource is limited," stop and notify (don't retry).

---

## 11. Notifications

| Channel | Use | Notes |
|---------|-----|-------|
| **In-app** | verification results, streaks, assignment issued, backlog nudges | `/aquintutor/notifications`; primary channel. |
| **Email** | account, receipts, assignment digests, reminders | **Own SMTP only** (no third-party email API); From normalized to configured `from_address`; Gmail/Zoho need app passwords. `connect@` general, `hr@` careers only. |
| **Push** | streak/daily-limit reminders **[Planned]** | Web Push via service worker. |
| **Webhooks [B2B]** | LTI grade passback; institution callbacks | LTI `replaceResult`; signed. |
| **Scheduled** | daily reminders/rollups | **Daily** Vercel cron only. |
| **SMS** | **[Planned]** critical alerts | provider TBD (Q). |

**Reminder system.** Respects `daily_limit_min`; nudges toward *verified* progress, never "watch more." No emoji in any notification (P5).

---

## 12. Analytics

### 12.1 Event taxonomy (canonical names)

`onboarding_started`, `tier_selected`, `goal_selected`, `onboarding_completed`, `session_started`, `hint_used`, `teachback_started`, `teachback_logged`, `exit_ticket_result`, `skill_mastered`, `homework_classified`, `homework_hint`, `homework_attempt`, `homework_verified`, `planner_generated`, `kg_node_opened`, `kg_node_mastered`, `kg_unlocks`, `backlog_diagnostic`, `backlog_recovered`, `backlog_completed`, `tots_game_started`, `tots_round_correct`, `tots_game_completed`, `lesson_started/completed/verified`, `practice_started/attempt`, `test_started/submitted/scored`, `proctor_flag` (advisory), `lab_opened/progress/completed`, `embed_loaded`, `lti_launch`, `lti_score_sent`, `reward_earned`, `dashboard_viewed`, `offline_queued/flushed`.

### 12.2 Dashboards & KPIs

- **Learner dashboard:** mastered/verified counts, current path, streaks.
- **Parent/Teacher dashboard:** verified vs done per child/classroom; "completed but unverified" surfaced.
- **Ops dashboard:** KPIs from §1.7; p95 latency; Neon compute.

### 12.3 Funnels

- Signup → onboarding → first session → first verified skill → D7 return.
- Backlog: start diagnostic → see gaps → complete recovery.

### 12.4 Audit trails

- Verify/teachback logs (immutable) + admin action logs constitute the audit record; used for both learning integrity and compliance.

---

## 13. Integrations

| Integration | Direction | Auth | Failure/retry |
|-------------|-----------|------|---------------|
| **Razorpay** (payments) | out | KEY_ID/SECRET (prod env) | verify HMAC signature server-side; on failure, no entitlement granted; waiver→approval fallback exists. CHF→INR paise. |
| **@vercel/blob** (storage) | out | blob token | retry upload; validate before store. |
| **LTI 1.1 consumers** (LMS) [B2B] | in/out | OAuth1 HMAC-SHA1 per consumer | reject bad signatures/replays; grade passback retried with backoff **[Planned]**. |
| **Labs SDK / iframe** [B2B] | out | none (sandboxed) | event bridge best-effort; host handles absence gracefully. |
| **Own SMTP** (email) | out | SMTP creds (app passwords) | derive-SMTP-from-IMAP helper; retry on transient failure. |
| **AI Micro-Tutor** [Planned] | out | provider key + paid flag | disabled by default (Q2); never blocks core learning. |

**No third-party auth or email *API* providers** (P9). No competitor/company names surface from integrations into UI (P4) — e.g., WhatsApp/Slack are never named in copy even where a direct-connect link is used.

---

## 14. Deployment

### 14.1 Infrastructure & environments

- **Host:** Vercel (Astro SSR adapter). **DB:** Neon Postgres. **Storage:** @vercel/blob. **Domain:** edurankai.in (AquinTutor at `/aquintutor/*`; own domain is Q1/§17.4).
- Environments: **production** (live), **preview** (per-branch Vercel), **local** (dev).

### 14.2 CI/CD

- Push to `main` → Vercel build & deploy. **Not live until `git push origin main`** — a frequent source of "still broken" reports is unpushed commits; always verify `origin/main..main` is empty before re-investigating a live issue.
- The assistant does **not** push or run prod DB changes (classifier-blocked); it hands the operator the exact command.

### 14.3 Environment variables & secrets

- DB URL, blob token, Razorpay `KEY_ID`/`SECRET`, LTI secrets, SMTP creds — all in Vercel env. **Never edit `.env` or `src/layouts/` or `public/era/` without explicit operator approval.**

### 14.4 Cron / scheduled

- **Daily-only** cron in `vercel.json`. A sub-daily cron silently fails **all** deploys — forbidden. If live fixes "don't work," check `npx vercel ls` for a stale prod deploy.

### 14.5 Monitoring & logging

- Vercel logs + analytics; Neon compute usage; structured error logs (`e.cause?.message`).

### 14.6 Backup, disaster recovery, rollback

- Neon PITR (plan-dependent). Rollback = redeploy previous Vercel build; DB additive-only migrations reduce rollback risk. Append-only logs are never destructively migrated.

### 14.7 Deploy guardrails

- Respect the 100 deploys/day ceiling; on "Resource is limited," stop and notify. Prod-only DB migrations run manually by the operator from `.dev-scripts/*.cjs`.

---

## 15. Testing

### 15.1 Unit tests

- `evalArith` (shunting-yard) across precedence/parentheses/decimals/negatives.
- Linear parser/solver (`ax+b` both sides; `a=0` unsupported; tolerance).
- Backlog gap detection & stretch filtering (`STRETCH` map).
- Knowledge-graph `isOpen/state` transitions (DAG correctness, no cycles).
- `setMastery` forward-only SQL semantics (no downgrade; verified sticky).
- Number-word/letter parsing (Tots).

### 15.2 Integration tests

- `/api/aquintutor/learn` all actions incl. 401/400/500 paths and validation caps.
- LTI launch signature verify + nonce replay reject + grade passback.
- Offline queue flush → `offline_work` → server apply idempotency.

### 15.3 End-to-end (per tier signature)

- Tots: play a game via tap and via voice fallback; completion logs verify.
- Sub-Juniors: solve a problem; assert answer is **never** shown; exit-ticket verifies.
- Juniors: master a node; assert downstream unlocks; persists across reload.
- Scholars: diagnostic → correct gap set → recovery marks verified.
- Onboarding deep-link `?tier=` preselects; profile persists.

### 15.4 Performance testing

- Lighthouse CI on marketing surfaces (> 90). Interaction frame timing (60fps) on graph/lab redraws. p95 route latency load test.

### 15.5 Security testing

- Signature/nonce tests (LTI); authz matrix tests (role gates); XSS injection attempts on user text; SQLi attempts (parameterization); upload MIME/size abuse.
- **CI content guards:** grep for emoji in UI/seed/notification copy (fail build); grep for banned competitor/company names in user-facing copy (fail build).

### 15.6 Accessibility testing

- axe/Lighthouse a11y (AA); keyboard-only walkthroughs; screen-reader labels on interactive SVG; contrast checks; reduced-motion honored.

### 15.7 Manual QA & acceptance criteria (samples)

- **AC-Onboarding:** Given a signed-in user selecting a tier + goal, when they click Start, then a profile row exists and they land on the learning surface. Deep-link `?tier=x` preselects x.
- **AC-Homework:** Given any solvable problem, the final answer is never rendered; only the learner's attempt is graded; a passed exit ticket writes `verify homework-<type>`.
- **AC-Knowledge-Graph:** A locked node cannot be opened; mastering a prerequisite opens dependents and the UI names what unlocked.
- **AC-Backlog:** Only wrong-diagnostic sub-concepts enter the recovery path; target selection changes which sub-concepts appear.
- **AC-Verification-integrity:** No path other than a passed exit ticket (or lab demo) can set `verified=true`.
- **AC-Advisory-proctoring:** No proctor flag ever changes a score automatically.

---

## 16. Documentation

| Audience | Deliverable | Contents |
|----------|-------------|----------|
| Developers | `docs/aquintutor/*`, this spec, code comments | architecture, conventions (postgres-js arrays, `e.cause`, `is:global`, forward-only mastery), local setup. |
| Administrators | Admin guide | content authoring, classroom setup, LTI key management, moderation, payouts, proctor review. |
| End users (learners/guardians) | In-app help + onboarding | how verification works; how to use each signature feature. |
| API consumers [B2B] | Labs/LTI integration guide | catalog schema, embed snippet, SDK usage, LTI setup, grade passback. |
| Deployment | Runbook | env vars, cron limits, deploy ceiling, stale-deploy check, prod-migration procedure. |
| Maintenance | Ops guide | Neon capacity guard, backup/rollback, incident response. |

---

## 17. Future Scalability

### 17.1 Extensibility

- New tiers/tracks are data-driven (`TIERS`, tracks, `labs-catalog`, knowledge-graph node sets). Adding a subject graph = new authored node/edge data + `kg-<subject>-*` skill ids.

### 17.2 Plugin architecture **[Planned]**

- Labs already behave as plugins (self-contained + event bridge + catalog entry). Generalize to a lab plugin manifest so third parties can register labs.

### 17.3 Microservice migration

- Extract high-load domains (assessment scoring, LTI, analytics rollups) into separate services behind the same API surface if Vercel/Neon limits are exceeded. Keep the learn API stable as the contract.

### 17.4 Multi-tenancy & domain (Q1)

- Optional `aquintutor.ai` domain and a tenant scoping column (`tenant_id`) on institutional data for B2B isolation. Guardian/teacher scoping already partitions visibility.

### 17.5 Localization & internationalization

- Content authored per-locale; speech features are language-scoped; RTL-ready layouts. Term lists for teach-back are locale-specific. Currency/date formatting localized.

### 17.6 Feature flags

- Gate AI Micro-Tutor, push notifications, new tiers behind flags (env/DB-driven) so incomplete features never reach learners.

### 17.7 Enterprise readiness

- Seat licensing, SSO/LTI, audit exports, SLA/monitoring, data-residency options. API versioning (`/api/v2`) with deprecation windows.

---

## 18. Final Product Definition — end-to-end behaviour

This section narrates the finished product from open to close, per scenario, so behaviour is unambiguous.

### 18.1 First-time learner (self-serve, secondary student)

1. Opens `/aquintutor`. Sees the front door: "Who's learning? Pick your stage."
2. Taps **Aquin Juniors** → `/aquintutor/onboarding?tier=junior` with Juniors preselected.
3. Chooses goal "Boards + JEE, merged," optionally sets 45 min/day. Clicks **Start learning**. Profile upserts; lands on the learning surface.
4. Opens **Knowledge map** → sees Mechanics as a dependency graph; only *Units & Measurement* is open.
5. Masters Units (refresher + numeric check) → *Kinematics* and *Vectors* light up; the UI says what unlocked. Server logs `verify kg-mech-units`.
6. Later, needing homework help, opens **Homework help**, types `2x + 5 = 15`. Aquin names the rule and method, never the answer; the learner solves it; a fresh exit ticket verifies; `homework-equation` verified.
7. Before exams, opens **Clear a backlog**, picks Thermodynamics + target IIT; the diagnostic finds two gaps; a ~30-min recovery repairs exactly those; each logs verified.
8. All of this works offline; writes queue and sync on reconnect.

### 18.2 Guardian-operated pre-reader (Tots)

1. Guardian opens **Little ones (voice)**. The app **speaks** the choices.
2. Child taps **Counting**; Aquin says "How many balloons? Tap the number or say it." Child taps 3 (or presses "Say it" and says "three"). Spoken praise + a star.
3. Five rounds → celebration; `verify tots-count`. No reading required at any point; if speech APIs are absent, everything is still tappable.

### 18.3 Undergraduate (Tutor) using labs

1. Opens **Virtual labs** → runs the AI/ML or DSP lab (chromeless tool). Interacts with a real, hand-built simulation.
2. Progress/complete events emit via the bridge; verification can be logged. Nothing names a competitor; no emoji anywhere.

### 18.4 Institution embedding a lab **[B2B]**

1. Integrator reads `/labs`, fetches `/api/labs/catalog.json`.
2. Drops `era-labs-embed.js` + `<div data-era-lab="dsp">` into their portal → a sandboxed iframe mounts; lab events surface as a DOM `era-lab` event.
3. Alternatively configures LTI: creates a consumer key at `/admin/lti`, launches from their LMS (OAuth1-signed), and receives grade passback.

### 18.5 Teacher monitoring **[B2B]**

1. Teacher opens their classroom, sees each learner's **verified** vs merely **done** counts, recent exit-ticket outcomes, and backlog status. Assigns work; learners get in-app (and emailed) notifications.

### 18.6 Assessment with advisory proctoring

1. Learner starts a timed test (full-screen, FAB hidden). Proctor signals (if enabled) are stored as **advisory flags**. Auto-submit on timeout. Results computed server-side. **A human** reviews any flags; the score is never auto-penalized.

### 18.7 Failure & offline behaviour

- Wrong answers never lock the learner out; hints ladder; retries are free.
- Network loss → banner; progress queued; nothing lost; sync on reconnect.
- Neon at capacity → operator upgrades; app reduces polling to let compute suspend.

### 18.8 Payments (paid add-ons)

- Where a paid add-on applies (never for core school-age learning framed by price), Razorpay handles the order; the server verifies the HMAC signature before granting entitlement; CHF is converted to INR paise. Test on the deployed site (keys are prod-only).

### 18.9 Post-school tiers — all shipped

- **Tutor:** spaced-repetition Recall engine (SM-2), server-persisted, at `/aquintutor/recall`. **[Built]** Internship/coding tracks reuse labs/tests. **[Planned]**
- **Research:** literature + thesis workspace (reference manager with APA/IEEE/BibTeX export + 11-stage thesis tracker) at `/aquintutor/research-workspace`. **[Built]**
- **Atelier:** credential path + competency evidence logbook (4 trade tracks) at `/aquintutor/credential-path`. **[Built]**
- All eight tiers now ship a genuine **signature** experience, not a re-skinned course player. Remaining depth (bespoke trade simulations, internship pipelines) is roadmap.

---

## Appendix A — Hard conventions (do-not-regress checklist)

1. Normalize postgres-js results: `Array.isArray(r) ? r : (r?.rows || [])`.
2. Log DB errors as `e?.cause?.message || e?.message`.
3. Style JS-created DOM via `<style is:global>` (Astro scopes `<style>` by default).
4. Mastery is forward-only; `verified` is sticky-true; only exit-tickets/lab-demos set it.
5. No emoji in UI/seed/notifications — SVG glyphs only.
6. No competitor/company names in user-facing copy.
7. Proctoring is advisory-only; never auto-penalize.
8. AquinTutor uses `AquintutorLayout`; never EduRankAI chrome; never redirect to EduRankAI admin.
9. Never framed around price.
10. Self-built auth (any one of password/passkey/face/TOTP); no external auth SDKs.
11. Daily-only Vercel cron; sub-daily silently fails all deploys.
12. Not live until `git push origin main`; check `origin/main..main` before re-investigating "still broken."
13. Prod DB changes and pushes are operator-run; hand over the command, don't execute.
14. Don't edit `src/layouts/`, `public/era/`, or `.env` without explicit operator approval.
15. Respect the 100 deploys/day ceiling; on "Resource is limited," stop and notify.

## Appendix B — Tier reference (from `aquintutor-learn.ts`)

| id | name | ages | tag | representative goals |
|----|------|------|-----|----------------------|
| tots | Aquin Tots | 3-5 | Pre-KG · KG | phonics, numbers, calm |
| primary | Aquin Primary | 6-10 | Grades 1-5 | homework, curriculum, confidence |
| subjunior | Aquin Sub-Juniors | 11-13 | Grades 6-8 | beat overload, real understanding, planning |
| junior | Aquin Juniors | 14-15 | Grades 9-10 | Boards, JEE/NEET foundation, merged path |
| scholar | Aquin Scholars | 15-18 | Grades 11-12 | clear backlog, JEE, NEET, portfolio |
| tutor | AquinTutor | 18-22 | Undergraduate | employable degree, coding, internships |
| research | AquinTutor Research | 22+ | Master's · PhD | literature, thesis, publish |
| atelier | AquinTutor Atelier | any | Vocational · Lifelong | switch careers, trade skill, credential |

## Appendix C — Signature-feature status

| Tier | Signature | Route | Status |
|------|-----------|-------|--------|
| Tots | Voice-first play (speak + tap/say) | `/aquintutor/tots` | Built |
| Primary | Mastery Tree + Teach-it-Back | `/aquintutor/learn` | Built |
| Sub-Juniors | Homework Helper (never-answer) + exit ticket + planner | `/aquintutor/homework` | Built |
| Juniors | Boards+JEE knowledge graph (DAG) | `/aquintutor/knowledge-graph` | Built |
| Scholars | Backlog Recovery (diagnostic → surgical path) | `/aquintutor/backlog` | Built |
| Tutor | Spaced-repetition Recall engine (SM-2) | `/aquintutor/recall` | Built |
| Research | Literature + thesis workspace (APA/IEEE/BibTeX) | `/aquintutor/research-workspace` | Built |
| Atelier | Credential path + competency logbook | `/aquintutor/credential-path` | Built |

**Cross-tier surfaces (Built):** verified-progress hub `/aquintutor/mastery`; guardian/teacher read-only share `/aquintutor/shared-progress/[token]`.

---

*End of Master Specification. This document is authoritative; when code and spec disagree, reconcile deliberately and update this file in the same change.*
