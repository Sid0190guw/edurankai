# AES-100 Vol III P2 Ch 1 — System Services Architecture (public/aquin-services.js)

Service registry + capability DISCOVERY with semver compatibility + health-aware
selection. Composes the Ch 50 boot orchestrator. Node-tested (6).
- Discover by capability/name; newest compatible version first.
- Semver compatibility (same major, >= minVersion); major bumps break.
- Health-aware: unhealthy/retired never discovered.
- Lifecycle installed→registered→initialized→activated→suspended→retired.
HONEST SCOPE: registry/discovery/versioning real; C++ platform runtime, IPC, service
sandboxing are declared substrates. (~3.8M-LOC C++ → core.)
