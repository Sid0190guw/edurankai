# Follow-up (NOT built here): many-person video needs an SFU

**Context.** Prompts H1–H3 add the animation board, presenter roles, and (next) breakouts + mass
broadcast on top of the existing huddle. Step 0 established the current media transport.

## What the current transport is

The huddle (`src/pages/portal/meet/[id].astro` + `public/meet-mesh.js`) is a **WebRTC full mesh**:
every participant opens a peer connection to every other participant. Signaling is HTTP polling at
`/api/portal/meet/<room>/signal`. ICE uses public STUN only (`stun.l.google.com`) — **no TURN, no SFU**.

## The honest scaling limit

A full mesh is **O(N²)**: with N participants each peer maintains N−1 connections and **uploads its
camera N−1 times**. In practice this is fine to ~4–6 video participants and then collapses
(uplink saturation, CPU, connection churn). **Mesh does not scale to "many-person" video.** No amount
of application code changes that — it is a property of the transport.

## What DOES scale on the current transport (and is what H1–H3 lean on)

- **The animation SPEC** (template/scene/ink) — a few hundred bytes, broadcast once over the data
  channel; every client renders locally at its Prompt-5 tier. This is why H1 keeps it smooth at scale.
- **Audio**, **chat**, **reactions**, **polls** — small payloads.

So the interactive-learning path (spec + audio + chat) already works well beyond the video ceiling.
**Many small rooms (H2 breakouts)** further bounds the per-room video count.

## Recommendation: adopt an SFU for many-person video (provisioning, not a rewrite)

Route video through a **Selective Forwarding Unit** — each peer uploads **once** to the SFU, which
forwards streams to others. Options:

| Option | Shape | Rough effort |
|---|---|---|
| **LiveKit** (self-host or cloud) | Open-source SFU + mature JS SDK, simulcast, egress for H3 HLS | ~1–2 wks integrate; cloud = provisioning + $ per participant-min |
| **mediasoup** | Low-level SFU library, max control, you build signaling/orchestration | ~3–5 wks (more infra to own) |
| **Managed (Daily / 100ms / Agora / Twilio)** | Fully hosted, fastest to ship | days to integrate; highest per-minute cost |

**Rough cost:** self-hosted LiveKit ≈ a few small VMs + bandwidth (egress-dominated); managed
services ≈ $0.001–$0.004 per participant-minute. A 100-viewer hour ≈ single-digit dollars on managed.

### Why this stays a provisioning change, not a rewrite

H2 defines a **transport interface** (`createRoom/joinRoom/leaveRoom/moveParticipant/broadcast`) and
H3 a **broadcast transport interface** (`startBroadcast/publishSpec/viewerSubscribe`), both implemented
against the current mesh. Swapping in an SFU means implementing those same interfaces against the SFU
SDK — the breakout/presenter/animation/broadcast application logic above them does not change.

**Decision needed from you:** pick LiveKit (recommended: open-source, own the data) vs a managed
provider (fastest), and whether to self-host or use cloud. Nothing here is built until you choose —
this prompt did not swap the media server.
