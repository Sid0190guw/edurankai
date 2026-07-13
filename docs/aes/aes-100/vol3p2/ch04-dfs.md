# AES-100 Vol III P2 Ch 4 — Distributed Filesystem Runtime (public/aquin-dfs.js)

One global namespace over many nodes/regions. Node-tested (7).
- **Location transparency**: apps use a global path; runtime resolves to replicas.
- **Geo-replication**: N replicas spread across distinct regions (us/eu/india).
- **Tunable consistency**: strong read needs a quorum of replicas reachable (refuses
  rather than returning stale); eventual read serves nearest healthy replica.
- **Failover**: primary outage transparently redirects reads to a healthy replica.
Composes the Ch 42 quorum idea. HONEST SCOPE: namespace/placement/consistency/
failover logic real over in-memory nodes; network transport, on-disk storage, crypto
replication are declared substrates. (~7.1M-LOC C++ → the core.)
