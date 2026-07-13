# AES-100 Vol III P2 Ch 19 — Autonomous Multi-Agent Framework (public/aquin-multiagent.js)

Coordinates many specialized agents; composes (not duplicates) the earlier agent
engines by adding two classic named algorithms. Node-tested (5).
- **Contract Net Protocol** (Smith 1980): announce task → capable agents bid →
  award to best (cheapest) bid; no capable bidder → unassigned. Decomposition
  allocates subtasks across agents respecting capacity.
- **Blackboard architecture** (Hearsay-II): shared partial-result board; knowledge
  sources fire opportunistically when their precondition appears (continuity+energy
  → derive-bernoulli → chains into apply-venturi).
- Majority **consensus** voting.
HONEST SCOPE: coordination algorithms real; agent intelligence supplied by the
domain engines wrapped.
