# AES-100 Vol III P2 Ch 8 — Software Defined Networking (public/aquin-sdn.js)

Control plane separated from data plane. Node-tested (5).
- **Intent-based**: declare "connect A→B"; controller compiles to flow rules.
- **Shortest-path routing** (Dijkstra): cheapest path (A-B-D cost 2 over A-C-D cost 6).
- **Flow installation** per switch along the path.
- **Autonomous healing**: link failure → recompute alternative path + reinstall
  flows for every affected intent (B-D down → reroute A-C-D); no path → intent fails.
HONEST SCOPE: control-plane logic real; OpenFlow/P4 wire protocols + vendor switch
firmware declared substrates. (~13.4M-LOC C++ → core.)
