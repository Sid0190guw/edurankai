# AES-100 · Vol II · Part I · Chapter 7 — Multi-Tenant Educational Runtime Engine

**Status:** specified + reference implementation (`public/aquin-device.js`,
Node-tested, 7 cases). Normative: SHALL/SHOULD/MAY.

## 1. Purpose
Host **many isolated Educational Runtimes on one device**. A device is a host;
a learner is a tenant. Built for the reality of shared household / school / kiosk
devices in emerging economies. **Educational Identity — not the device — is the
unit of computation.**

## 2. Requirements (normative)
- **DEV-001** Each tenant SHALL own an isolated runtime: Understanding model
  (Digital Twin), Working Memory, AI conversation, offline sync queue, mission,
  security context. *(test 1/3/4)*
- **DEV-002** Educational state SHALL NEVER leak across tenants; only stateless
  infrastructure MAY be shared. *(test 1 — 61% vs 45%; test 6 — access denied)*
- **DEV-003** Switching users SHALL preserve each tenant's state exactly and
  restore continuity fast (hot switch ≈ instant). *(test 2)*
- **DEV-004** Suspension SHALL be adaptive: **hot** (keep in RAM) vs **cold**
  (serialize to storage + evict) chosen from RAM/battery pressure; resume SHALL
  reconstruct identical state. *(test 5)*
- **DEV-005** Each tenant's offline synchronization SHALL be independent; one
  tenant's sync SHALL NOT affect another's. *(test 4)*
- **DEV-006** Over the hot-capacity limit, the least-recently-used tenant SHALL
  be cold-suspended (bounded RAM on low-end devices).
- **DEV-007** Cross-tenant access SHALL be denied by default (privacy). *(test 6)*

## 3. Shared vs private
**Shared (stateless):** AI Runtime, Rendering, Physics/Math engines, network
stack, crypto/compression. **Private (per tenant, isolated):** everything in
DEV-001. The shared AI Runtime is loaded once; each tenant keeps its own
conversation + Understanding reference (major RAM saving on low-end phones).

## 4. Public interface
```
DeviceRuntime: addTenant(id) · switchTo(id, {ram?,battery?}) -> {active,from,strategy,latencyMs}
               tenant(id) · say(id,who,msg) · enqueueSync(id,item) · syncTenant(id)
               resume(id) · canAccess(requester,target) · tenants() · provenance
```

## 5. Future evolution
Same runtime scales from a household phone to school tablets, community kiosks,
libraries, and XR terminals — only the tenant count changes.

## 6. Reference implementation
`public/aquin-device.js` — `window.AquinDevice.createDeviceRuntime()`. Composes
`aquin-understanding.js` (per-tenant twin) + `aquin-memory.js` (working memory),
with plain-object fallbacks. Harness: `scratchpad/device_test.js` (7/7).
