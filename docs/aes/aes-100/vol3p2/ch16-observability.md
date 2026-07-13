# AES-100 Vol III P2 Ch 16 — Observability & Autonomous Operations (public/aquin-observability.js)

Telemetry → operational intelligence. Node-tested (4).
- **Anomaly detection** (z-score): value >k stddev from the metric's recent mean is
  flagged (900ms spike z=176 flagged; normal jitter not).
- **Health rollup** across components.
- **Root-cause analysis**: given the dependency graph + failed set, trace to the
  deepest upstream failure (db is the root; gateway/knowledge-svc are consequences).
- **Incident lifecycle**: MTTD / MTTA / MTTR.
HONEST SCOPE: anomaly/health/root-cause/MTTR math real; petabyte log storage,
distributed trace correlation at scale, AIOps ML models declared substrates.
(~35.1M-LOC C++ → core.)
