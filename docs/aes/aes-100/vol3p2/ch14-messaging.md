# AES-100 Vol III P2 Ch 14 — Unified Messaging & Event Streaming (public/aquin-messaging.js)

Asynchronous backbone; producers/consumers decoupled. Node-tested (5).
- **Pub/sub**: publisher → topic → all subscribers (loose coupling).
- **Exactly-once**: duplicate message id delivered once (idempotent dedup).
- **Dead-letter + retry**: a persistently-failing handler is retried to a limit then
  moved to the dead-letter queue (not lost, not looped forever).
- **Event sourcing / replay**: immutable per-topic log; replay from any offset.
- **Priority** delivery ordering.
HONEST SCOPE: broker semantics real in-memory; distributed partitioning/replication/
zero-copy transport declared substrates. (~27.5M-LOC C++ → core.)
