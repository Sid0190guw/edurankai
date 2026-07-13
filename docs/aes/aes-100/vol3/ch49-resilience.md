# AES-100 Vol III Ch 49 — Resilience, Survivability & Recovery (public/aquin-resilience.js)

Classic fault tolerance: survive DURING failure, not just recover after. Node-tested (7).
- **Checkpoint/restore** to a known-good state.
- **Failure detection** → classified incident (category+severity) + Recovery Session.
- **Reversible isolation** to contain cascades.
- **Failover** only to a HEALTHY backup (refuses if none healthy — no faked success).
- **Verification gate**: recovery is NOT complete until checks pass.
- **Mission continuity**: critical missions prioritized; non-critical degrade gracefully.
- **Metrics**: MTTR / MTTD / availability / recovery-success-rate.
HONEST SCOPE: recovery orchestration + metrics real; hardware failover, storage
replication, DR infrastructure are declared substrates. (~2.05M-LOC C++ → core.)
