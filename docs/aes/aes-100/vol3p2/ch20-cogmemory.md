# AES-100 Vol III P2 Ch 20 — Digital Memory & Cognitive Continuity (public/aquin-cogmemory.js)

Built to NOT duplicate: episodic/semantic/consolidation/forgetting already in
aquin-memory-runtime.js; bitemporal reconstruction in aquin-knowledge.js. This adds
the two uncovered parts. Node-tested (4).
- **Procedural memory**: records skill executions (step sequence + success), then
  consolidates the MOST-SUCCESSFUL sequence into a learned procedure with a measured
  success rate (identify-abc→use-formula at 100%, not the failing guess-check).
- **Privacy-preserving governance**: memories carry consent scope + retention + PII;
  access DENIED unless caller scope covers consent scope; retention EXPIRES old
  memories; export REDACTS PII.
HONEST SCOPE: procedural consolidation + privacy governance real; multi-store memory,
forgetting curve, bitemporal reconstruction are the composed substrate engines.
