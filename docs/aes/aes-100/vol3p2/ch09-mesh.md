# AES-100 Vol III P2 Ch 9 — Service Mesh Infrastructure (public/aquin-mesh.js)

Governed service-to-service fabric — real distributed-systems patterns. Node-tested (5).
- **Circuit breaker** (Nygard/Fowler): closed→OPEN after failure threshold (fail
  fast)→HALF-OPEN after cooldown→closed on success.
- **Retry** exponential backoff (1,2,4,8… capped).
- **Health-aware load balancing**: round-robin / least-connections over healthy only.
- **Zero-trust**: no verified identity or policy-forbidden → denied by default.
- **Distributed tracing**: parent/child spans → reconstructable call tree.
HONEST SCOPE: mesh control logic real; sidecar proxy, mTLS transport, HTTP/2·gRPC
wire protocols declared substrates. (~15.2M-LOC C++ → core.)
