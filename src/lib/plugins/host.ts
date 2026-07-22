// src/lib/plugins/host.ts — Block 09: the capability-mediated facade over KernelRepository.
// Every plugin reaches persistence ONLY through this host: caps are clamped to the plugin's
// manifest, every read/write is gated by Block 10 can(), objects are stamped metadata.plugin,
// and cross-plugin private reads/writes are refused. A plugin never imports @/lib/db or @/lib/kernel.
import type { ObjectType, ObjectDataMap, KernelObject } from '@/lib/kernel';
import type { Capability } from '@/lib/rbac/capabilities';
import type { ResourceRef } from '@/lib/rbac';
import { getPlugin } from './registry';

export interface HostCreateInput<T extends ObjectType> {
  type: T;
  subtype: string;
  data: ObjectDataMap[T] & Record<string, unknown>;
  owner?: string | null;
  securityLabels?: string[];
}

export interface PluginHost {
  readonly pluginId: string;
  createObject<T extends ObjectType>(input: HostCreateInput<T>): Promise<KernelObject>;
  getObject(id: string): Promise<KernelObject | null>;
  updateObject(id: string, patch: { data?: Record<string, unknown> }): Promise<KernelObject>;
  linkConcept(objectId: string, conceptId: string): Promise<void>;
  addReference(fromId: string, toId: string): Promise<void>;
  can(cap: Capability, res?: ResourceRef): Promise<boolean>;
}

export function createPluginHost(pluginId: string, user: unknown): PluginHost {
  const manifest = getPlugin(pluginId);
  if (!manifest) throw new Error(`unknown plugin '${pluginId}'`);
  const capAllowed = new Set<Capability>(manifest.requiredCapabilities);

  async function rbacCan(cap: Capability, res: ResourceRef = {}): Promise<{ allow: boolean; reason: string }> {
    if (!capAllowed.has(cap)) return { allow: false, reason: `plugin '${pluginId}' manifest does not grant '${cap}'` };
    const { can } = await import('@/lib/rbac');
    const d = await can(user, cap, res);
    return { allow: d.allow, reason: d.reason };
  }
  async function repo() { return (await import('@/lib/kernel')).createPgKernel(); }

  return {
    pluginId,

    async createObject(input) {
      const { ForbiddenError } = await import('@/lib/rbac');
      const sub = manifest.objectSubtypes.find((s) => s.kernelType === input.type && s.subtype === input.subtype);
      if (!sub) throw new Error(`unknown subtype ${input.type}/${input.subtype} for plugin '${pluginId}'`);
      const res: ResourceRef = { type: input.type, securityLabels: input.securityLabels ?? ['public'] };
      const d = await rbacCan('create', res);
      if (!d.allow) { const { can } = await import('@/lib/rbac'); throw new ForbiddenError(await can(user, 'create', res)); }
      sub.schema.parse(input.data);   // plugin-owned payload validation (throws on bad data)
      const r = await repo();
      return r.createObject({
        type: input.type, data: input.data as any, owner: input.owner ?? null,
        securityLabels: (input.securityLabels ?? ['public']) as any,
        metadata: { plugin: pluginId, subject: manifest.subject, subtype: input.subtype },
      }) as unknown as Promise<KernelObject>;
    },

    async getObject(id) {
      const r = await repo();
      const o = await r.getObject(id);
      if (!o) return null;
      const res: ResourceRef = { id, type: o.type, ownerId: o.owner, securityLabels: o.securityLabels, state: o.lifecycleState };
      if (!(await rbacCan('read', res)).allow) return null;
      const owner = (o.metadata as any)?.plugin;
      // shared ConceptObjects are readable by any plugin; another plugin's private objects are not.
      if (owner && owner !== pluginId && o.type !== 'ConceptObject') return null;
      return o;
    },

    async updateObject(id, patch) {
      const own = await this.getObject(id);
      if (!own) throw new Error('object not found or not permitted');
      const res: ResourceRef = { id, type: own.type, ownerId: own.owner, securityLabels: own.securityLabels, state: own.lifecycleState };
      if (!(await rbacCan('write', res)).allow) throw new Error('write denied');
      const r = await repo();
      const draft = ['created', 'validated', 'indexed'].includes(own.lifecycleState);
      return draft ? r.editDraft(id, { data: patch.data }) : r.updateObject(id, { data: patch.data });
    },

    async linkConcept(objectId, conceptId) {
      const own = await this.getObject(objectId);
      if (!own) throw new Error('object not found or not permitted');
      if (!(await rbacCan('write', { id: objectId, type: own.type })).allow) throw new Error('write denied');
      const r = await repo();
      await r.addRelationship(objectId, 'part_of', conceptId);   // part_of a SHARED concept
    },

    async addReference(fromId, toId) {
      const from = await this.getObject(fromId);
      const to = await this.getObject(toId);   // getObject enforces isolation on both ends
      if (!from || !to) throw new Error('both endpoints must be readable + plugin-owned (or a shared concept)');
      if (!(await rbacCan('write', { id: fromId, type: from.type })).allow) throw new Error('write denied');
      const r = await repo();
      await r.addRelationship(fromId, 'references', toId);
    },

    async can(cap, res) { return (await rbacCan(cap, res)).allow; },
  };
}
