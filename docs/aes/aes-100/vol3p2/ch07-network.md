# AES-100 Vol III P2 Ch 7 — Universal Networking Stack (public/aquin-network.js)

Networking as a governed OS service. Node-tested (5).
- **Packet pipeline**: auth → policy → classify → route; no-identity or
  policy-forbidden packets dropped at the boundary.
- **QoS priority scheduling**: educational traffic classes (realtime-classroom >
  video > assessment > ai-inference > research > admin > background > archival);
  scheduler serves most critical first (classroom never starved by archival).
- **AIMD congestion control** (TCP-Reno core): additive increase per ack,
  multiplicative decrease (halve) on loss; verified 8.37→4.19 on loss.
HONEST SCOPE: scheduling/congestion/pipeline logic real; NIC drivers, zero-copy DMA,
kernel-bypass, TLS transport declared substrates. (~11.9M-LOC C++ → core.)
