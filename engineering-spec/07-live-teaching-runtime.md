# Engineering Block 07 — Live Teaching Intelligence Runtime

| Field | Value |
|---|---|
| **Spec source** | Vol 1 pp 34–52 — "Live Educational Compilation", "Educational Intelligence Runtime", "Runtime Bootstrap Engine (AES-001)", "Educational Prediction (AES-000 Ch 26)" |
| **Repo target** | Extend: `src/lib/board-session.ts`, `src/lib/board-speech.ts`, `src/lib/broadcast.ts`, `src/lib/scene-spec.ts`, `src/lib/scene-compose.ts`, `src/lib/animation.ts`, `src/lib/render-policy.ts`, `src/lib/edu-runtime.ts`, `src/lib/assessment.ts`, `src/lib/i18n.ts`, `src/lib/llm/gateway.ts`, `src/pages/api/aquintutor/board/*`. Create: `src/lib/board-translate.ts`, `src/lib/board-assess.ts`, `src/lib/recognition-event.ts`, `src/pages/api/aquintutor/board/assess.ts`. |
| **Status** | partial (most of the pipeline exists; translation-on-fan-out, live-assessment generation, and the equation/OCR recognizer are the remaining gaps) |
| **Depends on** | Block 01 — Educational Object Kernel (`src/lib/kernel/*`); Block 04/05 — Adaptive Learning Runtime & Rendering (`edu-runtime.ts`, `render-policy.ts`); Block 06 — LLM Gateway (`src/lib/llm/gateway.ts`); RBAC/auth (`src/lib/rbac`, `src/lib/auth`) |

## 1. Purpose
Compile a teacher's live lecture — voice, board writing, gestures, and typed intent — into structured teaching artifacts (animations, 3D scenes, slides, ink, quizzes) and fan those artifacts out to every joined student in real time, where each student renders them adaptively for their device, network, accessibility, and language. Recognition (ASR, vision, LLM reasoning) runs **externally or in the browser**; the repo owns the **event schema, the compile/validate/repair step, the broadcast channel, and the per-student adaptive render**. Broadcast payloads are always small structured specs (JSON scene specs, slide text, vector strokes) — never video frames or pixels — so the channel scales and preserves privacy.

## 2. Repo mapping — exists vs. build

**Already implemented (do not duplicate):**
- **Broadcast channel** — `src/lib/board-session.ts`: `edu_board_events` (monotonic `seq` = SSE event id), `edu_board_participants`, `edu_board_detections`; `fireBoardEvent`, `eventsSince`, `currentEvent`, `joinSession`, `touchParticipant`, `logDetection`. Self-bootstrapping DDL (repo's dominant pattern).
- **SSE transport** — `src/pages/api/aquintutor/board/stream.ts`: `GET …/board/stream?session=SID`, short-lived (~45 s) `ReadableStream` with `text/event-stream`, resume via `Last-Event-ID`, per-connect tier resolution. Browser `EventSource` auto-reconnects (serverless-correct — no infinite function).
- **One-to-many broadcast registry** — `src/lib/broadcast.ts` (`edu_broadcasts`, votes, hands); viewer count reuses board participants on channel `bcast-<id>`.
- **Speech → animation reasoning** — `src/lib/board-speech.ts` (`detectTemplate`, `extractParams`, `clampToSpec`, `buildSuggestion`, `validateLlmSuggestion`, `llmSystemPrompt`); endpoint `src/pages/api/aquintutor/board/interpret.ts`. LLM path + deterministic keyword fallback.
- **Animation compiler** — `src/lib/animation.ts` (`AnimationService`, `TEMPLATES` = projectile/sine/sortbars; each fired instance is a kernel `AnimationObject` linked to a `KnowledgeObject` via a `references` edge). Browser engine: `public/aquin-anim-templates.js`.
- **3D scene generator + simulation compiler** — `src/lib/scene-spec.ts` (canonical versioned `SceneSpec`, `normalizeScene` validate+repair, physics types projectile/pendulum/spring) and `src/lib/scene-compose.ts` (LLM composes scene JSON, keyword fallback to authored examples). Browser engine: `public/aquin-scene-engine.js` (three.js). Endpoint `…/board/compose.ts`.
- **Gesture / writing recognition (vision)** — `public/aquin-board-vision.js` (browser: homography rectification, lighting quality, frame-diff, stroke vectorization, best-effort circle/underline/marks gestures), exercised by `src/lib/board-vision.test.ts`. Ink is broadcast as **vector strokes only** via the `fire-ink` action in `src/pages/api/aquintutor/board.ts`.
- **Per-student adaptive render** — `src/lib/edu-runtime.ts` (`estimateDevice`, `estimateNetwork`, `combinePlan`, tiers `lite|standard|rich`, `signalsFromHeaders`) and `src/lib/render-policy.ts` (`RENDER_MATRIX` object-type × tier → `RenderDirective`, media rewriting). `resolveBroadcastTier` in `board-session.ts` reuses this on join.
- **Assessment engine** — `src/lib/assessment.ts` (`edu_assessment_items`, `edu_attempts`, `gradeItem`/`gradeAttempt`, practice vs. official, mastery advance via `aq_mastery`).
- **Translation (interface strings)** — `src/lib/i18n.ts` (`t`, `coverage`, locale overrides, RTL). Content-variant translation via `translation_of` kernel edges in `edu-runtime.startLesson`.
- **Reasoning (deterministic) + LLM gateway** — `src/lib/aquin-brain.ts` (retrieval + Socratic rules, no-LLM fallback); `src/lib/llm/gateway.ts` (`chat`, `chatStream`, dual backend `own` | `claude`, usage log, rate limit).
- **Kernel object store** — `src/lib/kernel/*` (`kernel_objects`, `kernel_edges`; `AnimationObject`, `SimulationObject`, `AssessmentObject`, `KnowledgeObject` types).

**To build / extend:**
- `src/lib/recognition-event.ts` — a single **zod discriminated union** for the browser→server capture contract (speech / ink / gesture / equation), so every recognizer speaks one schema.
- `src/lib/board-translate.ts` — translate a fired event's human-readable text (slide title/bullets, scene labels) into a joined student's locale, **cached per `(session, seq, locale)`**, served on the stream. Closes the "Real-time Translation" gap for live fan-out.
- `src/lib/board-assess.ts` — accumulate the session's fired concepts/transcript and generate a live `AssessmentObject` + items via the LLM gateway (validated against the `assessment.ts` item schema). Closes the "Assessment Generator" gap.
- **Equation recognizer** — extend `interpret.ts` with an `equation` path and an external OCR/LaTeX service contract (see §7); today only concept→template and text→scene exist.
- Extend `board/stream.ts` with a `loc` param and the translation hook; extend `edu_board_translations` and `edu_board_assessments` tables.

## 3. Data model

### 3.1 Recognition event (browser capture → server) — new `src/lib/recognition-event.ts`
```ts
import { z } from 'zod';

const Pt = z.tuple([z.number(), z.number()]);                 // normalized [x,y] in 0..1
const Polyline = z.array(Pt).max(400);

export const RecognitionEventZ = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('speech'),
    transcript: z.string().max(500),
    lang: z.string().default('en'),                           // BCP-47 of the SPOKEN language
    interim: z.boolean().default(false),                      // interim ASR result (don't compile yet)
    at: z.number(),                                           // client epoch ms
  }),
  z.object({
    kind: z.literal('ink'),
    strokes: z.array(Polyline).max(400),                      // vector strokes ONLY — never pixels
    source: z.enum(['pen', 'physical']),
    at: z.number(),
  }),
  z.object({
    kind: z.literal('gesture'),
    gesture: z.enum(['circle', 'underline', 'arrow', 'marks']),
    centroid: Pt,                                             // WHERE the gesture points
    confidence: z.number().min(0).max(1),                     // honest, capped (<=0.6 from vision)
    at: z.number(),
  }),
  z.object({
    kind: z.literal('equation'),
    latex: z.string().max(400).optional(),                    // if the client/OCR already produced it
    strokes: z.array(Polyline).max(400).optional(),           // else raw ink for server-side OCR
    at: z.number(),
  }),
]);
export type RecognitionEvent = z.infer<typeof RecognitionEventZ>;
```

### 3.2 Broadcast fire payload (server → students) — the shape `board-session.BoardEvent.params` carries
```ts
import type { SceneSpec } from '@/lib/scene-spec';

// The existing envelope (verbatim from src/lib/board-session.ts):
export interface BoardEvent {
  seq: number; sessionId: string; templateId: string; params: any;
  playState: string; timelinePos: number; actor: string | null; at: string;
}

// Typed union of what `params` holds per templateId (documents the existing wire format):
export type FirePayload =
  | { templateId: 'projectile' | 'sine' | 'sortbars'; params: Record<string, number | number[]> }
  | { templateId: 'scene';    params: { scene: SceneSpec } }
  | { templateId: 'slide';    params: { slide: { title: string; bullets: string[] } } }
  | { templateId: 'ink';      params: { strokes: [number, number][][]; source: 'pen' | 'physical' } }
  | { templateId: 'equation'; params: { latex: string; caption?: string } };   // NEW
```

### 3.3 New additive tables (self-bootstrapping, matching `board-session.ts` style)
```sql
-- cache of a fired event's translated text per target locale (translation-on-fan-out)
CREATE TABLE IF NOT EXISTS edu_board_translations (
  session_id text   NOT NULL,
  seq        bigint NOT NULL,          -- FK-by-value to edu_board_events.seq
  locale     text   NOT NULL,          -- BCP-47 target
  payload    jsonb  NOT NULL DEFAULT '{}',   -- the translated params for this event
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, seq, locale)
);

-- link a running session to the live quiz generated from it
CREATE TABLE IF NOT EXISTS edu_board_assessments (
  session_id     text NOT NULL,
  assessment_id  uuid NOT NULL,        -- a kernel AssessmentObject id
  generated_from bigint NOT NULL DEFAULT 0,   -- last edu_board_detections.id consumed
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, assessment_id)
);
```
No new kernel object types are needed: fired animations/scenes remain `AnimationObject`s (§2), generated quizzes are `AssessmentObject`s attached with an `assesses` edge (see `assessment.createAssessment`).

## 4. Interfaces & API contracts

### 4.1 Existing endpoints (extend, do not replace)
```
POST /api/aquintutor/board            (faculty: can write AnimationObject)
  body: { action: 'ensure' }
      | { action: 'fire', templateId, params, koId?, session?, playState?, timelinePos?, detectionId? }
      | { action: 'save-scene', spec, koId? }
      | { action: 'fire-ink', strokes: [number,number][][], source: 'pen'|'physical', session? }
      | { action: 'fire-slide', slide: { title, bullets: string[] }, session? }
      | { action: 'fire-scene', spec, koId?, save?, session? }
  resp: { ok, seq?, instanceId?, sceneId?, issues?, objects? }

POST /api/aquintutor/board/interpret  (faculty)  body: { text, session, origin? }
  resp: { ok, suggestion: { templateId, params, confidence, source } | null, detectionId, llm }

POST /api/aquintutor/board/compose    (faculty)  body: { text, session, save?, autoFire?, koId? }
  resp: { ok, spec: SceneSpec|null, issues, source: 'llm'|'example', matched?, sceneId?, seq }

GET  /api/aquintutor/board/stream?session=SID     (any signed-in reader of AnimationObject)
  SSE: event:ready { tier, animate, physics } ; event:fire (id=seq) BoardEvent ; ": hb" heartbeats
  resume: Last-Event-ID header (or ?since=)
```

### 4.2 New / extended contracts
```
GET  /api/aquintutor/board/stream?session=SID&loc=hi        (extend stream.ts)
  → if loc != 'en' and the fire has translatable text, serve the cached/translated variant.

POST /api/aquintutor/board/interpret  (extend)  body: { kind:'equation', latex?, strokes?, session }
  → returns { ok, latex, confidence, source:'client'|'ocr'|'llm' } and fires templateId:'equation'.

POST /api/aquintutor/board/assess     (NEW, faculty)  body: { session, koId?, window? }
  → generate a live quiz from the session's fired concepts/transcript.
  resp: { ok, assessmentId, items: number, source: 'llm'|'template' }
```

### 4.3 New library signatures
```ts
// src/lib/board-translate.ts
export function translatableText(ev: BoardEvent): string[];                     // pure: pull strings out
export function applyTranslations(ev: BoardEvent, map: Record<string,string>): BoardEvent;  // pure: put back
export async function translateFire(ev: BoardEvent, locale: string): Promise<BoardEvent>;   // cache (session,seq,locale)

// src/lib/board-assess.ts
export interface LiveItemDraft { type: 'mcq'|'numeric'|'true_false'; prompt: string; options?: string[]; answer: any; points: number }
export function windowConcepts(dets: Detection[]): { concepts: string[]; transcript: string };  // pure
export function validateDrafts(raw: unknown): LiveItemDraft[];                                   // pure, clamps
export async function generateLiveAssessment(sessionId: string, koId: string|null, owner: string, window?: number): Promise<{ assessmentId: string; items: number }>;

// External recognizer service contract (server-side fallbacks; see §7)
export interface ExternalRecognizers {
  transcribe?(audio: ArrayBuffer, hintLang?: string): Promise<{ text: string; lang: string; confidence: number }>;
  latexOf?(input: { strokes?: [number,number][][]; imageDataUrl?: string }): Promise<{ latex: string; confidence: number }>;
  translate?(texts: string[], from: string, to: string): Promise<string[]>;   // default: LLM gateway chat()
}
```

## 5. Core logic / algorithms

### 5.1 The live compile pipeline (capture → render), per fired artifact
```
 1. CAPTURE (browser): ASR (Web Speech API) | vision (aquin-board-vision.js) | typed intent
      → RecognitionEvent (§3.1), validated by RecognitionEventZ. Interim ASR results are dropped.
 2. RECOGNIZE/REASON (server, faculty-gated):
      speech   → detectTemplate() keyword scoring OR LLM (llmSystemPrompt) → Suggestion{templateId,params,confidence}
      equation → client LaTeX, else external OCR latexOf(), else LLM
      ink/gesture → already-structured strokes/gesture kind (no server reasoning)
 3. VALIDATE + REPAIR (server, deterministic, never throws):
      clampToSpec(templateId, params)              // animation params clamped to registry schema
      normalizeScene(spec)                          // scene clamped/repaired, object count capped at 200
      → a hallucinated/out-of-range spec can never crash a student render.
 4. PERSIST + LOG:
      createInstance() → AnimationObject (kernel) linked to KnowledgeObject via `references` edge
      logDetection()   → edu_board_detections (audit + assessment source; fired=false)
 5. FIRE:
      fireBoardEvent(session, {templateId, params, playState, timelinePos}) → monotonic seq (= SSE id)
 6. FAN OUT (per student, on their SSE connection):
      on connect: resolveBroadcastTier(signals) → tier ∈ {lite,standard,rich}, animate, physics
      for each event > lastSeq: [translate if loc≠en] → send `id:<seq> event:fire`
 7. ADAPTIVE RENDER (browser): resolveDirective(objectType, tier) decides hydrate/animation/physics.
      lite → static keyframe / server HTML, no client JS; rich → full interactive player.
```

### 5.2 Adaptive tier resolution (exists — `edu-runtime.combinePlan`, used by `resolveBroadcastTier`)
```
minTier(device, network):           # rank lite=0 < standard=1 < rich=2 ; take the lower
tier = minTier(estimateDevice(sig).tier, estimateNetwork(sig).tier)
if a11y.reduceMotion and tier == 'rich': tier = 'standard'     # no heavy animation under reduced motion
directive = RENDER_MATRIX['AnimationObject'][tier]
animate = directive.animation != 'none'                         # lite → static keyframe only
# device signals come from Client Hints headers (signalsFromHeaders) refined by query params.
```

### 5.3 Speech → template scoring (exists — `board-speech.detectTemplate`/`extractParams`)
```
score(templateId) = Σ weight(term) for each concept term found in the phrase   # weighted keyword match
best = argmax score ; null if all zero
params = clampToSpec(best, extractParams(best, phrase))   # "<num> <synonym>" preferred, then "<synonym> … <num>"
confidence = clamp(0.35 + 0.12·score + 0.10·paramHits, 0.3, 0.9)   # honest, never fabricated-high
```

### 5.4 SSE resume (exists — monotonic-seq delta feed, `stream.ts` + `eventsSince`)
```
lastSeq = Number(Last-Event-ID header || ?since || 0)
if lastSeq == 0: send currentEvent(session)         # late joiner sees the current board immediately
loop up to ~45s:
    for ev in eventsSince(session, lastSeq): send(id=ev.seq, ev); lastSeq = ev.seq
    heartbeat ; touchParticipant() ; sleep 1.5s
close → browser EventSource reconnects with Last-Event-ID = lastSeq (no gaps, no dupes)
```

### 5.5 Translation-on-fan-out (new — `board-translate.translateFire`)
```
translatableText(ev):                      # pure
    if templateId=='slide':  return [slide.title, ...slide.bullets]
    if templateId=='scene':  return [spec.title, spec.subtitle, ...objects[].text]
    if templateId=='equation': return [caption]              # LaTeX body is NOT translated
    else: return []                                          # projectile/sine/sortbars/ink: nothing to translate
translateFire(ev, locale):
    if locale == 'en' or translatableText(ev).length == 0: return ev
    hit = SELECT payload FROM edu_board_translations WHERE (session,seq,locale)   # cache
    if hit: return applyTranslations(ev, hit)
    out = recognizers.translate(texts, 'en', locale)  # default = LLM gateway chat(), preserves meaning not word-for-word
    INSERT edu_board_translations(session,seq,locale, out)   # cache once; every later student reuses
    return applyTranslations(ev, zip(texts,out))
# Bounded cost: at most (distinct locales in the room) LLM calls per fired event, memoized forever.
```

### 5.6 Live assessment generation (new — `board-assess.generateLiveAssessment`)
```
dets = recentDetections(session) since generated_from            # fired concepts + transcript window
{concepts, transcript} = windowConcepts(dets)                    # pure
if LLM ready: raw = chat(assessGenPrompt(concepts, transcript))  # strict-JSON item drafts
              drafts = validateDrafts(raw)                       # clamp to assessment.Item schema; drop bad
else:         drafts = templateItemsFor(concepts)                # deterministic fallback from concept bank
a = createAssessment(title, 'quiz', koId ?? conceptObj, owner)   # kernel AssessmentObject + `assesses` edge
for d in drafts: addItem(a, d)                                   # reuse assessment.addItem
INSERT edu_board_assessments(session, a, last det id)
# Objective items auto-grade via gradeItem(); short-answer routes to the existing manual queue.
```

### 5.7 Prerequisite readiness + mastery (exists — reused for student adaptation)
```
readiness: prereqs = incoming prerequisite_of edges; mastered = numericMastery(aq_mastery['ko:'+id]) >= 0.6
           notReady = any prereq unmastered  → served with a prerequisite notice, never blocked outright
mastery advance (on official pass / lesson completion): absent → growing → mastered  (applyCompletion)
```

## 6. Execution plan

> **Status: PARTIALLY IMPLEMENTED** (2026-07-20) — the recognition contract + translation + live-assessment engine (+ endpoint) landed with tests; the recognizer-wiring, equation OCR path, `loc` stream hook, gesture-compile, and pub/sub scale items are deferred (they edit existing endpoints / need external ML / are browser-side). `board-live.test.ts` **20/20**, `astro check` **zero errors** in touched files (repo total unchanged at 184).

- [x] **Recognition contract.** `src/lib/recognition-event.ts` — `RecognitionEventZ` discriminated union (speech/ink/gesture/equation) + typed `FirePayload`. Ink = vector strokes only (schema has no pixel/image field). Unit-tested. *(Wiring `interpret.ts`/`board.ts` to parse through it is a deferred call-site edit.)*
- [ ] **Deferred** — equation OCR path in `interpret.ts` (needs the external `latexOf` OCR contract).
- [x] **Translation-on-fan-out.** `src/lib/board-translate.ts` — pure `translatableText`/`applyTranslations` + cached `translateFire` (`edu_board_translations`, LLM default, never-throws fallback). *(Adding the `loc` param to `stream.ts` is a deferred call-site edit.)*
- [x] **Live assessment generator.** `src/lib/board-assess.ts` — pure `windowConcepts`/`validateDrafts`/`templateItemsFor` + `generateLiveAssessment` (`edu_board_assessments`, LLM with deterministic concept fallback) + `POST /api/aquintutor/board/assess` (faculty-gated). Tested.
- [ ] **Deferred** — gesture→board-action mapping (browser).
- [ ] **Deferred** — external pub/sub scale adapter (Upstash/Ably/Pusher).
- [ ] **Deferred** — `ASR_*`/`OCR_*` env/config surface.
- [x] **Tests.** Recognition union (incl. vectors-only privacy invariant), translate extract/apply (LaTeX never translated), windowConcepts/validateDrafts/templateItemsFor. 20/20.

## 7. Reality checks & risks

**Where the spec's OS/kernel metaphor breaks on serverless:**
- **"Runtime Bootstrap Engine as the only executable entry point / deterministic FSM startup / resident kernel"** (pp 43–50) — there is no long-running process on Vercel. Each request is a cold-or-warm stateless function. Realistic equivalent: the self-bootstrapping `CREATE TABLE IF NOT EXISTS` guards already in every lib (`_ready`/`booted` flags), Postgres as the authoritative state, and idempotent `ensure*` helpers. **Do not** build a resident scheduler; there is nothing to keep it alive.
- **"Benchmark every capability into a hundreds-dimensional capability vector; measure CPU/GPU/WebGPU/WebCodecs throughput"** (pp 46–50) — impractical and privacy-heavy to run per session server-side. Reduced to `signalsFromHeaders` (UA + Client Hints: device-memory, ECT, downlink, save-data, viewport) plus optional page-measured query params. Tiering is 3-way (`lite|standard|rich`), which is what the render matrix consumes. Full benchmarking is **out of scope**.
- **"Every configuration object shall include … checksum … digital signature"; "Digital signature validation"** (pp 44–45) — plus the spec's broader **post-quantum crypto / autonomous cyber-defense** themes (stated elsewhere in Vol 1, not this slice) — out of scope for this block. Config is env/DB; integrity is Postgres + RBAC. Session tokens already use `@oslojs/crypto`. Flag for a human if signed/frozen config objects become a real requirement.
- **"Educational Prediction — simulate consequences before every action"** (AES-000 Ch 26, pp 51–52) — no world-simulator here. The buildable equivalent is the deterministic **validate+repair** step (`normalizeScene`, `clampToSpec`) that guarantees a safe render, plus the readiness/mastery checks (§5.7). Predictive "what-if" simulation is **out of scope** for the live runtime.
- **"100 million learners"** (p 50) — the current fan-out **polls Postgres every 1.5 s per connected student** (`stream.ts`). That is fine for a classroom/webinar but will not hold at extreme concurrency: N students × per-1.5 s queries hammers the serverless Postgres connection pool. Mitigation is flagged in §6 (external pub/sub keyed by the same `seq`); until then, cap concurrent viewers per session and rely on CDN/edge for static assets.

**External services required (most ML is external — this block owns only the contracts):**
- **ASR** — primary path is the **browser Web Speech API** (client-side, `public/aquin-speech.js`), zero server cost. Optional server fallback contract: `recognizers.transcribe(audio, hintLang) → { text, lang, confidence }` (e.g. Whisper/Deepgram). Not build-in-repo.
- **Vision / equation OCR** — browser homography + stroke vectorization is **in-repo** (`aquin-board-vision.js`) and deliberately emits vectors, not pixels. Semantic diagram understanding and handwritten-equation→LaTeX need an **external** OCR/vision model (Mathpix-shaped `recognizers.latexOf` or a vision LLM). Not build-in-repo.
- **LLM** — the existing `src/lib/llm/gateway.ts` (`own` self-hosted OR `claude`) is the reasoning/compose/translate/quiz-gen backend. Keys from env/DB, rate-limited, usage-logged. Every feature degrades to a deterministic fallback when no key is configured (this is a hard invariant across `board-speech`, `scene-compose`, `aquin-brain`).
- **Video egress** — full audio+video streaming (HLS/SFU/CDN) is explicitly deferred (`docs/huddle-sfu-followup.md`). The mass-scale default is audio + structured specs/slides. Live per-student video is **out of scope** here.

**Decisions needing a human:**
- Auto-fire vs. teacher-confirm for low-confidence recognitions (current default: `interpret` decides nothing; the board confirms — keep for correctness).
- Whether generated live quizzes are ever **official** (affect credential eligibility) or always **practice** — recommend practice-only until reviewed (`affectsEligibility` gate already exists).
- Translation trust: LLM translations of live content are cached and served without human review — acceptable for slides/labels, but flag for high-stakes wording; the LaTeX body is deliberately never translated.
- Which external pub/sub (if any) to adopt for scale, and the associated cost/latency trade-off.
