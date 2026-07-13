# AES-100 Vol III P2 Ch 11 — Container Runtime & Orchestration (public/aquin-container.js)

Universal application execution platform. Node-tested (5).
- **Image signature gate**: unsigned image refused unless policy allows.
- **Bin-packing scheduler** (best-fit): places containers on a node with enough
  cpu+mem; no fit → pending (never silently overcommitted).
- **Autoscaling** (Kubernetes HPA): desired = ceil(replicas × util/target), clamped.
- **Self-healing**: failed container / all containers on a failed node rescheduled
  to a healthy node with capacity.
HONEST SCOPE: scheduling/quota/autoscale/healing real; OCI layers, Linux
namespaces/cgroups, GPU drivers, confidential-computing attestation declared
substrates. (~18.7M-LOC C++ → core.)
