# AES Volume 7 — Animation Engine

**STATUS: implemented.** This volume specifies code that exists, ships, and is
tested: `public/aquintutor-animator-engine.js` and the three surfaces that
consume it. Every claim here is verifiable against that source.

---

## 1. Purpose

Give AquinTutor a single, dependency-free, real-time procedural animation engine
that turns an educational *topic* into a *live visual* in the browser — the
concrete core of the "real-time animation generation while teaching" promise.
One engine, many surfaces, so a fix or a new concept reaches everywhere at once.

## 2. Non-goals (deliberate boundaries)

- **Not** a general 3D scene graph, physics library, or shader pipeline. It is
  Canvas 2D, hand-written, chosen so it runs on a ₹8,000 Android phone with no
  WebGL and no downloaded framework.
- **Not** an LLM-driven "generate arbitrary animation from arbitrary prose."
  Intent matching maps free text onto a **curated set of correct, hand-built
  scenes**. This is a feature, not a limitation: every output is physically and
  mathematically correct because a human wrote the model. (§8 covers how new
  scenes are added; §9 covers the honest path toward broader generation.)

## 3. Architecture

```
                 ┌───────────────────────────────────────────┐
   free text ───▶│  findScene(query)  — intent → scene        │
                 └───────────────────────────────────────────┘
                                   │ Scene
                                   ▼
   canvas ──────▶│  attach(canvas, scene, opts) — render loop  │──▶ controller
                 └───────────────────────────────────────────┘
   SCENES[]  — 15 self-contained scene definitions
   palettes  — 6 named colour ramps
```

Global surface (browser): `window.AquinAnimator = { SCENES, palettes,
findScene, attach, makePalHelpers }`. No modules, no bundler step — it is a
plain `<script src>` so it caches trivially and works offline once cached.

## 4. The Scene contract

Every scene is a plain object:

```
{
  id:       string,              // stable key, e.g. 'waves'
  label:    string,              // human title, e.g. 'Wave interference'
  cat:      string,              // discipline, e.g. 'Physics'
  keywords: string[],            // free-text hints for intent matching
  controls: [{ id, label, min, max, step, value }],  // live parameters
  state?:   any,                 // optional per-instance sim state
  draw(ctx, t, params, w, h, H)  // called every frame; H = palette helpers
}
```

`draw` is the entire scene. It receives the elapsed animation time `t`
(seconds, scaled by playback speed), the current parameter values, canvas
dimensions, and palette helpers `H.pal(i)` / `H.palLerp(0..1)`. A scene that
needs simulation state (Lorenz, Game of Life, double pendulum, Turing,
particles, galaxy) stores it on `this.state` and resets via `this.state._reset`.

**Invariants a scene must uphold** (enforced by convention + the render loop's
try/catch):
- `draw` must not throw for any control value in `[min, max]`.
- `draw` must be idempotent w.r.t. external state (only reads params + its own
  `state`), so the same scene can be attached to multiple canvases.
- No allocation-per-pixel in the hot path beyond one `ImageData` per frame for
  raster scenes (Mandelbrot, Julia, waves, Turing).

### 4.1 Shipped scenes (15)

| id | label | discipline | technique |
|----|-------|------------|-----------|
| mandelbrot | Mandelbrot zoom | Fractals | escape-time iteration, smooth colouring |
| julia | Julia set | Fractals | escape-time, animated c on a circle |
| lorenz | Lorenz attractor | Dynamics | RK-free Euler integration, 3D→2D projection |
| waves | Wave interference | Physics | two-source superposition field |
| particles | Particle field | Particles | curl-noise advection, 250–800 agents |
| gol | Game of Life | Cellular | Conway rules on a toroidal grid |
| tree | Fractal tree | Fractals | recursive L-system with wind sway |
| wavepkt | Wave packet | Quantum | Gaussian envelope × plane wave, Re/Im/‖ψ‖² |
| vector | Vector field | Physics | 4 field modes, arrow glyphs |
| turing | Turing patterns | Biology | Gray–Scott reaction–diffusion, 8 iters/frame |
| galaxy | Spiral galaxy | Astronomy | density-wave winding, up to 4000 stars |
| pendcascade | Pendulum cascade | Physics | length-graded harmonic pendulums |
| phyllotaxis | Phyllotaxis | Biology | golden-angle seed packing |
| dblpend | Double pendulum | Physics | exact Lagrangian ODE, chaotic trail |
| mobius | Möbius strip | Geometry | parametric mesh, painter's-algorithm sort |

> **Known gap:** the standalone Animation Studio (`/aquintutor/labs/animator.astro`)
> historically had 16 scenes (it also carried a synthetic "Spectrum bars"
> scene). The shared engine ships 15; the studio has not yet been migrated onto
> the shared engine. Reconciliation (migrate the studio → shared engine, decide
> whether `bars` earns its place) is tracked in §10.

## 5. Intent matching — `findScene(query)`

The algorithm (see source `findScene`) scores every scene against the lowercased
query and returns the best if it clears a threshold, else `null`.

```
score(scene, q):
    best = 0
    for kw in scene.keywords:
        if q contains kw:                      best = max(best, len(kw))
        else:
            words = kw.split(' ')
            hits  = count(w in words where len(w) > 3 and q contains w)
            if hits: best = max(best, hits * 4)
    if q contains scene.id or scene.label:     best = max(best, 20)
    return best

findScene(q): argmax score over SCENES; return it iff score >= 4 else null
```

Design rationale:
- **Longer keyword matches win** — a query containing the full phrase "double
  pendulum" (15 chars) beats a stray single-word overlap, so specific intent
  dominates.
- **Word-overlap fallback** (`hits * 4`) catches paraphrases ("lorenz attractor
  chaos" still resolves to `lorenz`) without matching on short stop-words
  (`len > 3` filter drops "the", "and", …).
- **Threshold `>= 4`** — one 4-char word overlap or better. Below that we return
  `null` and the UI honestly says "no renderer matched", offering the real
  catalogue rather than rendering something wrong. **Never guess a visual.**

Complexity: O(scenes × keywords) per query — trivial (≈ 60 substring checks).

## 6. Render loop — `attach(canvas, scene, opts)`

```
attach(canvas, scene, {palette, speed, params}):
    ctx = canvas.2d; H = makePalHelpers(palette)
    params = defaults(scene.controls) overridden by opts.params
    t = 0; playing = true
    each animation frame ts:
        dt = (ts - lastTs)/1000  (clamped first frame to 16ms)
        if playing: t += dt * speed
        try: scene.draw(ctx, t, params, w, h, H)
        catch e: paint the error onto the canvas (never crash the page)
        request next frame
    return controller { play, pause, setParam, setPalette, setSpeed, destroy, scene }
```

Guarantees:
- **Fresh state per attach** (`scene.state = null` on attach) so the same scene
  object can drive the Co-pilot demo and a concept page simultaneously without
  cross-talk.
- **Fault isolation** — a throwing `draw` paints "Scene error: …" and keeps
  animating the loop; one bad frame never white-screens the surface.
- **`destroy()`** cancels the RAF; every surface calls it before re-attaching to
  avoid orphaned loops (verified in the surfaces below).

## 7. Surfaces (consumers) — all on the one engine

1. **Aquin Co-pilot demo** — `src/pages/aquintutor/campus/aquin-copilot.astro`.
   A text box + preset buttons → `findScene` → `attach`. Shows the matched
   scene name and match latency. This is the flagship "say a topic, watch it
   teach it" proof. (The page's former fabricated "Live now — 6 lectures at
   partner campuses" section was **removed** as part of this work; we do not
   present invented usage as real.)
2. **Concept visualiser** — `src/pages/aquintutor/concept/[slug].astro`. A
   deep-linkable teaching surface: `/aquintutor/concept/wave-interference`
   opens that concept full-panel with its own parameter sliders, palette
   picker, play/restart, a plain-language explainer, and related-concept chips.
   Any lesson can link a student straight into a visual.
3. **Labs hub entry point** — `src/pages/aquintutor/labs/index.astro` surfaces
   the visualiser and the Co-pilot demo so they are discoverable.

## 8. Adding a scene (extension contract)

1. Append a Scene object to `SCENES` with a correct `draw` and honest
   `keywords`.
2. Add a one-line plain-language explainer to `EXPLAIN` in the concept page.
3. That's it — it appears in intent matching, the concept catalogue, related
   chips, and the Co-pilot fallback automatically. No surface code changes.

## 9. Adaptive rendering (rural-first)

The concept page benchmarks viewport width and drops render resolution on small
screens (`640×420` vs `960×600`) so a low-end phone stays smooth. This is the
minimal, shipping version of the broader adaptive-rendering principle (device /
network / battery aware pipelines) — deliberately small and real, not a promised
"benchmark everything" abstraction. Future expansion is tracked in §10.

## 10. Roadmap (design, not yet built)

- **Migrate the Animation Studio onto the shared engine** (remove the duplicate
  inline engine; reconcile the 15↔16 scene gap).
- **Offline packaging** — precache the engine + a lesson's chosen concepts into
  the existing service worker (`public/sw.js`) so animations run with no
  network, aligning with the offline-first requirement. The engine is already a
  single cacheable static file, which makes this cheap.
- **Camera / narration track** — timestamped parameter keyframes so a scene can
  be "played" like a scripted explanation and replayed against lecture audio.
- **Toward broader generation** — the honest path is *more curated scenes +
  smarter intent routing*, and only then a parameterised "scene compiler" for
  compositional topics. Not an unconstrained generator; correctness stays
  human-guaranteed.

## 11. Test evidence

Headless verification (harness run 2026-07-08, re-runnable):
- **Intent matching: 10/10** realistic phrasings resolved to the correct scene;
  gibberish correctly returned `null`.
- **Rendering: 15/15 scenes** attached and drew 15 frames each (225 frames
  total) with **0 draw errors**.

Build: `astro build` passes with the engine and all three surfaces.
