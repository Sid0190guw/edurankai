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
export * from './schema';
