# AES-000 Part II — Computational Planning (`public/aquin-planner.js`)

Planning = search over states. STRIPS (Fikes & Nilsson 1971) + A* (Hart/Nilsson/
Raphael 1968). Node-tested (6). No invented CS.
- State = set of true facts; Action = {pre, add, del, cost}; Goal = facts.
- **A*** with the admissible "unmet-goal-count" heuristic ⇒ **optimal** plans
  (cost 2 chosen over cost 5).
- Handles delete effects (non-monotonic), detects unreachable goals.
- `learningPlan(mastered, activities, targets)` = cost-optimal curriculum plan;
  skips already-known prerequisites. The general planner beneath learning paths
  (topo-sort in aquin-diagnosis is the no-cost/no-delete special case).
