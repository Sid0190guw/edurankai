# AES-100 · Vol II · Part XV · Ch 60 — Educational Time Intelligence Engine

**Status:** specified + reference implementation (`public/aquin-time.js`,
Node-tested, 7 cases). Time as an active computational dimension, not a timestamp.

## Requirements (normative)
- **TIME-001** Multi-scale reasoning (daily/weekly/semester/annual/lifetime).
- **TIME-002** Retention over time via an Ebbinghaus-style decay whose strength
  grows with successful spaced reps (spacing effect). *(test 1)*
- **TIME-003** Spaced revision scheduling: next review when retention would fall to
  target; well-recalled concepts wait longer, shaky ones return sooner. *(test 2)*
- **TIME-004** Rhythm detection from real performance history — WHEN this learner
  performs best (evidence, not assumption); insufficient history asserts no rhythm.
  *(test 3)*
- **TIME-005** Overload/burnout signal from sustained high load across weeks. *(test 4)*
- **TIME-006** Cognitive timing is ADAPTIVE, not deterministic: recommends
  teach/revise/assess/rest with evidence and never commands; overload preempts new
  learning (recovery first). *(tests 5,6)*
- **TIME-007** Temporal provenance of every timing decision. *(test 7)*

## Interface
```
TimeIntelligence: record(ev) · retention(concept,at) · nextRevision(concept,target)
  dailyRhythm() · loadTrend(weeks) · recommend(concept) · timeSince(concept)
```
Reference: `public/aquin-time.js`. Harness: `time_test.js` (7/7). HONEST SCOPE: the
forgetting model is the same Ebbinghaus curve family as `aquin-memory.js` (Vol I);
this engine adds scheduling, rhythm detection, and multi-scale cognitive timing
above it. Multiple evidence-based memory models plug in behind `retention`. With the
World Model (Ch 59) this completes spatiotemporal awareness: World = what/where,
Time = when/how-long/in-what-sequence.
