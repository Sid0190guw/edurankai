# AES-100 · Vol II · Part XIV · Ch 57 — Multi-Agent Educational Intelligence Framework

**Status:** specified + reference implementation (`public/aquin-agents.js`,
Node-tested, 6 cases). The system stops being ONE large intelligence and becomes a
governed SOCIETY of specialists — like a university's departments, dean, registrar,
librarian, counselors, researchers.

## Requirements (normative)
- **AGENT-001** Every agent declares its capabilities and REFUSES any task outside
  them; routing (`agentsFor`) only ever hands a task to a declared-capable agent.
  No agent exceeds its authority. *(test 1)*
- **AGENT-002** The Executive Agent decomposes a mission into a task pipeline and
  routes each to the specialist; it coordinates, it does NOT do the specialist's
  work. *(test 2)*
- **AGENT-003** Agents collaborate through governed Runtime Objects handed forward
  by the Executive — never by sharing internal memory. *(test 2)*
- **AGENT-004** Specialist disagreement is resolved as reasoning, not error, by a
  governance priority (default: scientific-accuracy > safety > clarity > simplicity),
  with the conflict + resolution recorded. *(test 3)*
- **AGENT-005** Verification gate: an educational decision is NOT published if a
  `verify` step rejects it. *(test 4)*
- **AGENT-006** A missing capability blocks the mission rather than fabricating an
  answer. *(test 5)*
- **AGENT-007** Agents can be added/retired at runtime; complete inter-agent
  provenance is replayable. *(test 6)*

## Interface
```
Framework: registerAgent({id,capabilities,permissions,handlers}) · retireAgent(id)
  agentsFor(capability) · run(mission,{ctx}) / executive.run(...)
mission = { goal, pipeline:[{capability, task}], resolve? }
```
Reference: `public/aquin-agents.js`. Harness: `agents_test.js` (6/6). HONEST SCOPE:
this is the coordination + governance fabric; the intelligence INSIDE each agent is
supplied by the domain engines (`aquin-mentor`, `aquin-research`, `aquin-cognition`,
`aquin-languages`, …) which it orchestrates under constitutional boundaries.
