// src/lib/animation.ts — Animation kernel linkage (Prompt A1). Registry templates and each fired
// live instance are AnimationObjects in the kernel; an instance links to a KnowledgeObject via the
// `references` edge. Built on the Prompt-1 KernelRepository (so it's proven in-memory + on Postgres).
// The server-side template list mirrors public/aquin-anim-templates.js for validation + the admin
// registry (the browser engine remains the single source for rendering).
import { KernelRepository, createPgKernel } from '@/lib/kernel';

export interface TemplateDef { id: string; name: string; kind: string; params: string[] }
export const TEMPLATES: TemplateDef[] = [
  { id: 'projectile', name: 'Projectile motion', kind: 'physics', params: ['angle', 'v0', 'gravity'] },
  { id: 'sine', name: 'Function / sine plot', kind: 'math', params: ['amplitude', 'frequency', 'phase'] },
  { id: 'sortbars', name: 'Sorting visualiser', kind: 'cs', params: ['values'] },
];
export function isTemplate(id: string): boolean { return TEMPLATES.some((t) => t.id === id); }

export class AnimationService {
  constructor(private repo: KernelRepository = createPgKernel()) {}

  /** Idempotently create one AnimationObject per registry template (metadata.template=true). */
  async ensureTemplates(): Promise<Record<string, string>> {
    const existing = await this.repo.listByType('AnimationObject').catch(() => []);
    const byTpl: Record<string, string> = {};
    for (const o of existing as any[]) { const t = (o.metadata as any)?.templateId; if (t && (o.metadata as any)?.template) byTpl[t] = o.id; }
    for (const t of TEMPLATES) {
      if (byTpl[t.id]) continue;
      const o = await this.repo.createObject({ type: 'AnimationObject', data: { title: t.name, scene: t.id } as any, metadata: { template: true, templateId: t.id, kind: t.kind } });
      byTpl[t.id] = (o as any).id;
    }
    return byTpl;
  }

  /** Create a fired-instance AnimationObject (carrying its params) and link it to a KnowledgeObject. */
  async createInstance(templateId: string, params: any, koId: string | null, owner: string | null): Promise<string> {
    if (!isTemplate(templateId)) throw new Error('unknown template');
    const o = await this.repo.createObject({ type: 'AnimationObject', data: { title: templateId, scene: JSON.stringify({ templateId, params }).slice(0, 4000) } as any, owner: owner ?? null, metadata: { instance: true, templateId, params } });
    const id = (o as any).id;
    if (koId) await this.repo.addRelationship(koId, 'references', id).catch(() => {});   // KO -references-> animation
    return id;
  }

  async listAll(): Promise<any[]> { return this.repo.listByType('AnimationObject').catch(() => []); }
}

let _svc: AnimationService | null = null;
export function animationService(): AnimationService { if (!_svc) _svc = new AnimationService(createPgKernel()); return _svc; }

// ---- admin registry reads (Postgres) ----
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
export async function templateUsage(): Promise<{ templates: any[]; instances: number }> {
  try {
    const all = await animationService().listAll();
    const templates = all.filter((o: any) => (o.metadata as any)?.template).map((o: any) => ({ id: (o.metadata as any).templateId, title: (o.data as any).title, kind: (o.metadata as any).kind, objectId: o.id }));
    const instances = all.filter((o: any) => (o.metadata as any)?.instance).length;
    return { templates, instances };
  } catch { return { templates: [], instances: 0 }; }
}
