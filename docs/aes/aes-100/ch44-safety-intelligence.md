# AES-100 · Vol II · Part VIII · Ch 43–44 — Learner State & Safety Intelligence

## Ch 43 — Learner State Estimation Engine (embodied)
**Status:** largely embodied in existing engines. The multidimensional, per-
dimension **estimate-with-confidence-and-provenance** model (never a single
label; unknown stays unknown; temporal validity) is implemented by
`public/aquin-understanding.js` (6 cognitive dimensions, Bayesian confidence,
Ebbinghaus decay, provenance) and the Mentor's 11-dimension holistic model
(`aquin-mentor.js`). A unified 18-dimension state vector consuming both is a thin
aggregation over these; every adaptive subsystem already reads these estimates
rather than building its own — the Ch 43 invariant.

## Ch 44 — Educational Safety Intelligence & Guardian Alert Runtime Domain
**Status:** specified + reference implementation (`public/aquin-safety.js`,
Node-tested, 7 cases). Purpose is educational **protection, not surveillance**:
*Protect without surveilling. Inform without alarming. Intervene with evidence,
not assumptions.*

### Requirements (normative)
- **SAFE-001** Evidence SHALL be strictly tiered: **observed-fact / risk-indicator
  / verified-concern**. From indicators the system SHALL NOT assert a fact — it
  SHALL hedge ("indicators suggest … may …; additional review recommended; NOT a
  confirmed fact"). *(test 1)*
- **SAFE-002** A **verified-concern** (human/authorized confirmation) SHALL raise
  the level and be stated as verified. *(test 3)*
- **SAFE-003** Alerts SHALL be graduated 0..5 (observation → reminder → coaching →
  guardian-summary → urgent-review → critical-safety), proportional to evidence.
- **SAFE-004** Guardian notification (level ≥ 3) SHALL be **consent-gated**;
  without consent it SHALL cap at coaching. *(test 2)*
- **SAFE-005** Critical-safety (level 5) SHALL require **explicit** crisis evidence
  (never inferred), pause the mission, and route to a human/emergency. *(test 5)*
- **SAFE-006** Integrated cyber sources (anti-phishing/scam) produce **observed
  facts**; a flagged link SHALL be blocked, explained, and recorded. *(test 4)*
- **SAFE-007** The guardian dashboard SHALL separate **observations** (factual,
  evidence-backed) from **recommendations**, and SHALL be unavailable without
  consent. *(test 6)*
- **SAFE-008** Every observation SHALL carry provenance; every assessment/alert
  SHALL be audited. *(test 7)*

### Categories
educational · digital-wellbeing · online-safety · information-integrity · social ·
self-reported-wellbeing.

### Public interface
```
SafetyIntelligence: observe({category,tier,signal,confidence,crisis?,provenance})
  flagLink(url, verdict) · assess(category) -> hedged risk estimate
  guardianDashboard() -> { observations, recommendations } (consent-gated)
  grantConsent(p) · revokeConsent(p) · audit
```

### Reference implementation
`public/aquin-safety.js` — `window.AquinSafety.createSafetyIntelligence()`.
Composes the Intervention Engine (Ch 42) consent/authority model + the Mentor
(Ch 9). Harness: `scratchpad/safety_test.js` (7/7).
