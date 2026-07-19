// src/lib/security/index.ts — Block 11 security public surface.
export {
  detectLoginBursts, detectPrivilegeEscalation, detectSessionFanout, detectImpossibleTravel,
  type SignalKind, type AuditRow, type RbacAuditRow, type SessionRow, type DetectedSignal,
} from './detectors';
export { ensureSecuritySchema, runSecurityScan, listSignals, setSignalStatus } from './signals';
export { computeTrustScore } from './trust';
export { authorizeRequest } from './authz';
export { SECURITY_DDL, securitySignals, type SecuritySignal } from './schema';
