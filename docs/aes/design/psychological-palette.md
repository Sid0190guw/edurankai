# Psychological Colour System — `public/aquin-palette.js`

Colour chosen from educational colour psychology and **verified in code** against
WCAG 2.1 AA — not arbitrary AI colour. Node-tested.

## Principles (grounded, cited)
- **No alarm-red for learning states.** Red impairs achievement and induces
  avoidance in evaluative contexts (Elliot, Maier, Moller, Friedman & Meinhardt,
  *JEP:General* 2007). "Needs review / struggling" use warm **ochre** — attention
  without threat. Verified: 0 states are alarm-red.
- **Green = growth/achievement** (mastered/proficient). **Blue = calm focus**
  (sustained attention). **Neutral grey = locked** (low arousal, no charge).
  **Violet = misconception** (distinct "look here", non-punitive).
- **Arousal ramps with age**: tots (0.35, soft/calm) → atelier (1.0, max signal).
  Overstimulation harms young learners' focus.
- **No colour alone** (WCAG 1.4.1): every state also carries a distinct **glyph**.

## Verified in the harness
- WCAG relative-luminance + contrast math validated (black/white = 21:1;
  #767676/white = 4.54, the AA boundary).
- **All 8 learning states meet AA (≥4.5:1) on the paper background** (the
  design gate caught `review` at 4.49 and it was darkened to pass).

| state | hex | contrast | glyph | rationale |
|---|---|---|---|---|
| mastered | #1F7A3D | 5.14 | check | green = growth + achievement |
| proficient | #2F6F4F | 5.73 | check-double | steady competence |
| learning | #B5540A | 4.74 | spinner | warm rust = active engagement (brand) |
| review | #8F6300 | 5.08 | refresh | ochre = attention, **not** red |
| struggling | #8A5A00 | 5.67 | lifebuoy | supportive, still not red |
| misconception | #7A4FB0 | 5.62 | flag | violet = distinct, non-punitive |
| locked | #5B5651 | 6.94 | lock | neutral, low arousal |
| focus | #1D5E8C | 6.62 | target | blue = calm focus |

## Interface
```
AquinPalette.STATES · TIER_MOODS · BRAND
  contrastRatio(a,b) · relLuminance(hex) · meetsAA(fg,bg,large?)
  stateFor(name) · auditContrast(bg) · toCSSVars(bg)
```
Sits on the spec's paper/ink/rust brand system. `auditContrast()` is the CI gate:
any new state colour must pass AA before it ships.
