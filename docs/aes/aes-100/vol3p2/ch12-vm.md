# AES-100 Vol III P2 Ch 12 — VM Runtime & Hypervisor (public/aquin-vm.js)

Strong-isolation whole-OS virtualization. Node-tested (5).
- **Capacity-guarded placement**: VM created only if host has vcpu+mem (overcommit
  protection); else refused.
- **Snapshot / restore** of full VM state.
- **Live migration**: dest capacity checked, source freed, VM keeps identity;
  refused if dest can't fit.
- **HA failover**: host failure restarts its VMs on a healthy host with capacity;
  none → honestly unplaceable.
HONEST SCOPE: placement/snapshot/migration/HA real; VT-x/AMD-V/ARM-VE, vCPU/EPT
paging, vGPU/SR-IOV, confidential-VM attestation declared substrates. (~21.6M-LOC C++ → core.)
