# AES-100 · Vol II · Part I · Chapter 6 — Runtime Command Engine

**Status:** specified + reference implementation (`public/aquin-command.js`,
Node-tested, 7 cases). Normative: SHALL/SHOULD/MAY.

## 1. Purpose
The constitutional execution gateway. **Commands express intent; Events record
fact.** Nothing modifies Educational Reality except a Command that passes the
full pipeline. (Complements Ch 5 Event Bus = `aquin-bus.js`.)

## 2. The command→event cycle
```
Created → Validated → Authorized → Accepted → (Scheduled) → Executing →
Verified → Committed → Completed → Runtime Event published
```

## 3. Requirements (normative)
- **CMD-001** Every state-changing operation SHALL originate from a Command;
  no hidden execution paths. *(test 3 — validation)*
- **CMD-002** A Command SHALL express exactly ONE intent (type + targetDomain).
- **CMD-003** Authorization SHALL occur BEFORE execution; unauthorized commands
  SHALL NOT run their handler. *(test 2)*
- **CMD-004** Commands SHALL be immutable once accepted; corrections require a
  new command.
- **CMD-005** Commands carrying an idempotency key SHALL execute **exactly once**
  under replay/retry. *(test 4 — handler runs once)*
- **CMD-006** Execution ≠ success: an unverified result SHALL retry per policy
  then `Failed`. *(test 5)*
- **CMD-007** A successful Command SHALL emit exactly one immutable Runtime Event
  and record full command provenance (validate→authorize→…→event). *(test 1/7)*

## 4. Public interface
```
CommandEngine: registerHandler(domain, fn) · submit(command)
               -> { accepted, status, commandId, event? } | { accepted:false, status, reason }
command = { type, targetDomain, authority:{role}, missionId?, payload,
            idempotencyKey?, priorityClass?, retryPolicy? }
```

## 5. Composition
Schedules via the Runtime Scheduler (Ch 3) when provided; authorizes via an
injectable authority function (the Interaction authority model, Vol I Ch 19);
emits Events consumable by the Event Bus (Ch 5).

## 6. Reference implementation
`public/aquin-command.js` — `window.AquinCommand.createCommandEngine()`.
Harness: `scratchpad/command_test.js` (7/7).
