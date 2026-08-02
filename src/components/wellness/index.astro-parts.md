# Wellness components

Six components and one token layer. Astro needs a file per component, so this
document is the index: what each part is for, the decision behind it, and the
measured numbers that back the colour choices.

Everything here is server-rendered. **The whole set ships 0 bytes of client
JavaScript** (verified: a build exercising every component and every variant
emitted one CSS file and no JS at all).

| File | What it is |
| --- | --- |
| `tokens.css` | Colour, radius, type, spacing and motion tokens. The only place a hex value appears. |
| `Card.astro` | The surface everything sits on. Publishes the module accent to its subtree. |
| `Metric.astro` | One health number, with an optional trend that is not colour-only. |
| `Ring.astro` | Progress ring in plain SVG. Static by default, celebratory on request. |
| `Reveal.astro` | Progressive disclosure on native `<details>`. Zero JS. |
| `Notice.astro` | Calm information, including the urgent kind. |
| `EmptyState.astro` | Illustration, one warm line, one clear action. |

## Using them

```astro
---
import Card from '../../components/wellness/Card.astro';
import Ring from '../../components/wellness/Ring.astro';
import Metric from '../../components/wellness/Metric.astro';
---
<Card module="hydration" href="/hydration" label="Open hydration">
  <Ring value={6} max={8} label="Water today" unit="glasses" />
  <Metric label="Average" value={7.1} unit="glasses" trend="up" sentiment="positive" />
</Card>
```

No stylesheet import is needed on the page. Each component imports
`tokens.css` from its own frontmatter, and Vite bundles it exactly once no
matter how many of them a page uses (verified in the build output: the token
block appears a single time).

Set `module` once on the Card. It writes `--w-accent` and `--w-tint` for its
whole subtree, so the Ring and Metric inside are already the right colour
without being told twice. A child that sets its own `module` overrides only
itself. That is the one structural idea in the set worth knowing.

## Motion, by component

The three tiers were a ruling, not a preference, so they are enforced by what
each file is physically able to do rather than by convention.

| Tier | Where | What moves |
| --- | --- | --- |
| A, 420 to 640ms, spring | `Ring` with `celebrate` only | Arc blooms from 0.94 scale, a terminal dot sweeps to the arc's end, the numeral rises 6px. |
| B, 180ms, ease-out | `Card` hover lift, `Reveal` chevron and panel, `EmptyState` action | 2px translate, a shadow layer's opacity, a 180 degree chevron turn. |
| C, none | `Metric`, `Notice`, every static `Card` | Nothing. These files contain no `transition` and no `animation` at all. |

Two things follow from that table:

- **Tier C is absence, not a zero-duration token.** `tokens.css` deliberately
  has no "instant" motion token, so there is nothing for a developer to reach
  for when styling a symptom log or a red-flag notice. The stillness cannot be
  undone by accident.
- **Nothing runs while idle and nothing loops.** The only animations in the set
  are one-shot entrances that a caller opts into per instance, plus hover
  transitions, which are gated behind `@media (hover: hover) and (pointer: fine)`
  so a phone never fires them and never gets a hover state stuck after a tap.

Every animated property in the set is `transform` or `opacity`. Audited
mechanically across all keyframes and transitions:

```
w-ring-bloom  [opacity, transform]      w-reveal-in  [opacity, transform]
w-ring-sweep  [transform]               transitions  [transform], [opacity]
w-ring-fade   [opacity]
w-ring-rise   [opacity, transform]
```

### The one place two rulings collided

A progress ring's draw-on is normally `stroke-dashoffset`. That is a paint
property, and Ruling 2 allows transform and opacity only. Rather than quietly
break one ruling to satisfy the other, `celebrate` is built from three
compositor-only moves that together read as the ring being drawn: the arc
blooms, a terminal dot sweeps around to the arc's end, and the numeral rises
into place. The sweeping dot is what sells it, and it is a pure rotation.

A genuine transform-only draw-on is possible with two rotating half-occluders,
but it breaks the round line caps mid-sweep and doubles the element count for
an effect nobody would consciously notice. It was not worth the artefact.

## Reduced motion

`prefers-reduced-motion` is treated as a variant, not a switch. The Tier A and
Tier B rules are declared **inside** `@media (prefers-reduced-motion: no-preference)`,
so the reduced-motion build is the default and needs no overrides to undo.

It still looks designed, because the celebratory state lives in the
composition rather than in the animation:

- A celebratory `Ring` keeps its echo hairline and its terminal dot. They are
  static parts of the drawing, not residue left behind by a keyframe.
- An interactive `Card` still lifts its shadow layer on hover and firms its
  border. It simply arrives instead of travelling.
- A `Reveal` chevron still points up when open. The state is never ambiguous.

## Contrast, measured

Computed with the WCAG 2.x relative-luminance formula, not estimated.

**Body and UI text**

| Pair | Light | Dark | Bar |
| --- | --- | --- | --- |
| ink on surface | 17.20:1 | 15.21:1 | AAA |
| ink on canvas | 16.34:1 | 16.36:1 | AAA |
| ink-2 on surface | 10.07:1 | 9.17:1 | AAA |
| ink-3 on surface (meta labels only) | 6.44:1 | 5.81:1 | AA |

Body copy is AAA in both themes. `ink-3` is the only token below 7:1 and it is
restricted to eyebrow labels, units and metadata; it never carries a sentence.

**Module accents.** Soft colour carries surfaces, rings and illustration; text
sits on ink. Even so, every accent clears AA against both the base surface and
its own tint, so a short accent label is safe anywhere in the system.

| Module | Accent on surface | Accent on its tint | Arc against ring track |
| --- | --- | --- | --- |
| cycle | 7.18:1 | 6.39:1 | 5.68:1 |
| pregnancy | 6.09:1 | 5.51:1 | 4.82:1 |
| mental | 7.99:1 | 7.07:1 | 6.32:1 |
| nutrition | 7.12:1 | 6.34:1 | 5.63:1 |
| sleep | 8.16:1 | 7.17:1 | 6.46:1 |
| hydration | 6.60:1 | 5.87:1 | 5.22:1 |
| fitness | 6.42:1 | 5.70:1 | 5.08:1 |
| therapy | 7.65:1 | 6.73:1 | 6.05:1 |
| neutral | 9.40:1 | 8.32:1 | 7.43:1 |

Lowest text pair in the whole system: 5.51:1. Lowest non-text pair: 4.82:1,
against a 3:1 requirement. Dark mode is looser everywhere, 8.14:1 or better on
every accent pair.

**Notices**, the tightest of which is urgent:

| Pair | Light | Dark |
| --- | --- | --- |
| urgent body ink on urgent surface | 15.32:1 | 14.72:1 |
| urgent title on urgent surface | 6.76:1 | 8.19:1 |
| guidance title on guidance surface | 6.43:1 | 8.59:1 |
| info title on info surface | 7.29:1 | 8.81:1 |

**Filled action buttons**: the label on an accent fill measures 6.09:1 or
better in light and 9.09:1 or better in dark, across all nine modules.

## The components

### `Card.astro`

Props: `module`, `tone` (`calm` | `celebratory`), `padding`
(`none` | `sm` | `md` | `lg`), `href`, `as`, `interactive`, `label`, `class`.

Generous 22px radius, hairline border, a warm low shadow with no black in it.
Passing `href` renders an anchor and turns on the lift; a static card gets no
transition at all, not a zero-length one.

*Decision:* the hover lift is a pseudo-element fading in, not a shadow growing.
Ruling 2 forbids animating `box-shadow`, so the deeper shadow is painted once
on an inert `::after` at zero opacity and only that opacity moves, alongside a
2px translate on the card. Both are compositor-only, so the lift costs a cheap
phone nothing.

`tone="celebratory"` is a composition change rather than an effect: one soft
wash of the module tint off the top-right corner. It resolves to an opaque
surface colour instead of `transparent`, because fading to `transparent`
greys the midpoint in some engines.

### `Metric.astro`

Props: `value`, `unit`, `label`, `trend` (`up` | `down` | `steady`),
`trendLabel`, `sentiment` (`neutral` | `positive` | `caution`), `module`,
`size`, `hint`, `class`.

Large tabular numeral so a value going from 9 to 10 does not shove the unit
sideways and a column of readings lines up. Tier C: no motion.

*Decision:* a trend direction is not a verdict. In a health context "up" is not
good news and "down" is not bad news; heavier bleeding is up, so is a longer
night's sleep. So direction and sentiment are separate props and sentiment
defaults to neutral ink. Colour appears only when a caller states what the
change means, and even then the arrow's silhouette (solid triangle up, solid
triangle down, two stacked bars for no change) plus a text label carry the same
information. When no `trendLabel` is given the direction is still read aloud
from a visually hidden string, so nothing is conveyed by colour alone.

### `Ring.astro`

Props: `value`, `max`, `module`, `label`, `size`, `celebrate`, `display`,
`unit`, `thickness`, `class`.

Pure SVG, `stroke-dasharray`, rendered at its final value with no animation
unless `celebrate` is set. Geometry is computed server-side against a fixed
120-unit viewBox with 4 units of headroom so the celebratory echo hairline
stays inside its own box and never needs `overflow` to escape.

Exposed as `role="progressbar"` with `aria-valuenow`, `aria-valuemax` and a
readable `aria-valuetext` ("6 of 8 glasses"); the visible caption is
`aria-hidden` so it is not announced twice. Value is clamped, so 99 of 10
renders as a full ring and 0 renders no arc at all rather than a stray dot from
the round line cap.

*Decision:* see "the one place two rulings collided" above.

### `Reveal.astro`

Props: `summary`, `meta`, `module`, `open`, `flush`, `class`. Also accepts a
`summary` slot for a rich heading.

Native `<details>`, so it works before hydration, with JS off, when printed,
and on a phone that is struggling. The summary row is a 44px target.

*Decision:* the panel does not slide open. Animating height is layout work,
it is banned by Ruling 2, and the JS-free height tricks cost more than the
effect is worth. The content simply exists the moment it is asked for, with a
180ms fade and a 4px rise to soften the arrival. The summary row never moves,
so the line the reader was already looking at stays exactly where their eye is.

### `Notice.astro`

Props: `kind` (`info` | `guidance` | `urgent`), `title`, `class`.

*Decision:* urgent is the quietest thing in the set. The person reading it is
already frightened and the design's job is to be legible, not louder. So it
gets no alarm red, no filled red block, no uppercase, no exclamation mark, and
no heavier weight than the other two kinds. It is distinguished by a solid clay
rule down its edge and a small flag mark, which is the visual language of
"this has been flagged for attention" rather than "sound the siren".

It also deliberately avoids `role="alert"`, which would interrupt a screen
reader mid-sentence. It is `role="note"`. It waits to be read. Tier C: the
component contains no transitions and no animations in any preference state.

### `EmptyState.astro`

Props: `module`, `illustration`
(`sprout` | `moon` | `droplet` | `bloom` | `path` | `note` | `cup`), `title`,
`body`, `actionLabel`, `actionHref`, `headingLevel`, `class`. Falls back to an
`action` slot when a button rather than a link is needed. Each module has a
sensible default drawing, so `illustration` is usually unnecessary.

*Decision:* the illustrations are drawn for this set and all built from the
same two parts, a soft wash of the module tint and one continuous accent line
at a single weight. That constraint is what makes seven different pictures read
as one family. Empty is a normal state here, the first day of a cycle log or a
night with no sleep data, so nothing in this component apologises and nothing
animates. It is also the one place the display serif appears: an empty screen
is the most human moment in the product, so it gets the warmest voice.

## Notes on implementation

- **Injected SVG needs a `:global()` bridge.** Astro adds its scope attribute
  at build time, so markup inserted with `set:html` never receives it and
  scoped selectors will not match it. The illustration parts are therefore
  styled as `.w-empty__art :global(.wash)`, which compiles to a scoped parent
  with an unscoped child. Confirmed in the compiled CSS.
- **Dark mode is written twice on purpose**, once for `prefers-color-scheme`
  and once for an explicit `[data-theme="dark"]`, matching the convention this
  site already uses on `<html>`. The media-query copy excludes an explicit
  light choice, so a user who has chosen light always beats their OS setting.
  `light-dark()` would collapse both into one block but fails closed on older
  Android WebViews, and Ruling 2 puts those devices first.
- **Mobile first.** Every component is `box-sizing: border-box` with
  `max-width: 100%` and `min-width: 0`; the metric row wraps; the ring is
  `width: min(100%, size)`; padding steps up only above 480px. Nothing has an
  intrinsic width that can push a 360px page sideways.

## What was verified, and what was not

Verified by building a throwaway Astro project that renders every component and
every variant, then reading the compiled HTML and CSS:

- all six components compile with no diagnostics, and the page builds clean;
- zero client JavaScript in the output;
- `tokens.css` is bundled once despite six imports;
- ring geometry is correct (circumference 320.44 at r=51; 6 of 8 renders
  `stroke-dasharray="240.33 80.11"` and a 270 degree sweep angle), and the
  clamped, zero, and celebratory cases all render as intended;
- the `:global()` illustration bridge, the grid stack, the `[open]` state
  selectors and every focus-visible rule survive scoping;
- no emoji anywhere, and no hard-coded hex outside `tokens.css` (the only hex
  in the components is inside comments, quoting measured ratios).

Not verified, and worth a real device pass before this ships: rendering in an
actual browser at 360px, and the ring's celebratory timing on low-end hardware.
Everything above is static analysis of the build output, which cannot catch a
visual mistake.

`tokens.css` is a supporting file rather than one of the six components. The
brief required tokens with no hard-coded hex, and no wellness token layer
existed in this repo, so the definition site had to be created somewhere. It
lives in this folder rather than `src/styles/` to keep the set self-contained
and avoid colliding with anything a foundation pass may add later. If a shared
wellness stylesheet does arrive, it can define the same `--w-*` names and win
on cascade order without any component changing.
