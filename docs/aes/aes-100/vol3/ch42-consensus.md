# AES-100 Vol III Ch 42 — Distributed Consensus & Coordination (public/aquin-consensus.js)

Core of the Raft algorithm (Ongaro & Ousterhout 2014). Node-tested (7).
- **Quorum** = floor(N/2)+1. Leader election needs a quorum of votes.
- **Split-brain prevented**: a minority partition (reachable < quorum) elects NO
  leader and commits NOTHING — two partitions can never both have a leader.
- **Commit** only when a quorum acknowledges; monotonic terms; stale leader steps down.
- **Distributed locks** granted only by a leader backed by a live quorum.
HONEST SCOPE: consensus safety logic (quorum/terms/commit) real over an in-memory
up/down reachability model; real network transport, persistent logs, and node crypto
auth are declared substrates. (~910k-LOC C++ spec distilled to the real safety core.)
