// src/lib/rbac/index.ts — public API of the AquinTutor Kernel Permission Engine.
//
//   import { can, requireCapability, requireAdminRole } from '@/lib/rbac';
//   const decision = await can(Astro.locals.user, 'write', { id, type:'KnowledgeObject', ownerId });
//   await requireCapability(Astro.locals.user, 'create', { type:'CourseObject' });   // throws ForbiddenError
//   if (!(await requireAdminRole(Astro.locals.user))) return Astro.redirect('/admin/login');
//
// Built on the existing auth/session; the 2b UI manages roles/grants on this backend.
export * from './capabilities';
export * from './roles';
export * from './types';
export { evaluate } from './engine';
export { enforce, can, requireCapability, requireAdminRole, ForbiddenError, type AuditEntry, type AuditSink } from './guard';
export {
  ensureRbacSchema, seedRbac, resolvePrincipal, writeAudit, createGrant, transitionGrant,
} from './store';
export { accessSummary, CAPABILITY_LABELS, type AccessSummary } from './access';
export * from './schema';

// Block 10 — capability tokens, per-object ACL enforcement, policy ladder.
export {
  generateTokenSecret, hashTokenSecret, issueToken, validateToken, resolveToken,
  delegateToken, revokeToken, listTokens, tokenCovers, resourceMatches, scopeMatches,
} from './tokens';
export { aclToGrants, resolveInheritedGrants, canObject, type ObjectAclEntry } from './objectAcl';
export { POLICY_TIERS, KERNEL_LOCK_FLAG, MAX_INHERITANCE_DEPTH, type PolicyTier } from './policy';
