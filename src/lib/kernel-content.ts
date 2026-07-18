// src/lib/kernel-content.ts — the Course + KnowledgeObject content service, built ON the
// Prompt-1 kernel repository (no parallel store). A CourseObject BRIDGES a real training_courses
// row via data.trainingCourseId; KnowledgeObjects are kernel-native teaching units composed into
// a course through ordered `part_of` edges, with `prerequisite_of` links between units.
// Publishing walks the real lifecycle created -> validated -> indexed -> published.
import { KernelRepository, createPgKernel } from '@/lib/kernel';
import type { KernelObject, Equation, WorkedExample, SecurityLabel, LearningMetadata } from '@/lib/kernel';

export interface UnitInput {
  title: string;
  body?: string;
  equations?: Equation[];
  examples?: WorkedExample[];
  securityLabels?: SecurityLabel[];
  learningMetadata?: LearningMetadata;
  owner?: string | null;
}
export interface UnitView {
  unit: KernelObject;
  prerequisites: { id: string; title: string; state: string }[];
  courses: { id: string; title: string; trainingCourseId: string | null }[];
}

const orderOf = (o: KernelObject): number => Number((o.metadata as any)?.order ?? 9999);
const titleOf = (o: KernelObject): string => String((o.data as any)?.title ?? '(untitled)');

export class ContentService {
  constructor(private repo: KernelRepository) {}

  // ---- Course bridge ----
  /** Idempotently get/create the CourseObject that bridges a training_courses row. */
  async ensureCourse(trainingCourseId: string, title: string, summary?: string, securityLabels?: SecurityLabel[]): Promise<KernelObject> {
    const existing = (await this.repo.listByType('CourseObject')).find((o) => (o.data as any)?.trainingCourseId === trainingCourseId);
    if (existing) return existing;
    const c = await this.repo.createObject({ type: 'CourseObject', data: { title, summary, trainingCourseId }, securityLabels: securityLabels ?? ['public'] });
    return c as unknown as KernelObject;
  }
  /** Create a CourseObject (trainingCourseId optional — used for kernel-native courses/tests). */
  async createCourse(title: string, summary?: string, trainingCourseId: string | null = null, securityLabels?: SecurityLabel[]): Promise<KernelObject> {
    const c = await this.repo.createObject({ type: 'CourseObject', data: { title, summary, trainingCourseId }, securityLabels: securityLabels ?? ['public'] });
    return c as unknown as KernelObject;
  }
  async listCourses(): Promise<KernelObject[]> { return this.repo.listByType('CourseObject'); }

  // ---- KnowledgeObject authoring ----
  async createUnit(input: UnitInput): Promise<KernelObject> {
    const ko = await this.repo.createObject({
      type: 'KnowledgeObject',
      data: { title: input.title, body: input.body, equations: input.equations, examples: input.examples },
      owner: input.owner ?? null,
      securityLabels: input.securityLabels ?? ['public'],
      learningMetadata: input.learningMetadata ?? {},
    });
    return ko as unknown as KernelObject;
  }
  /** Edit a draft unit (pre-publish). */
  async editUnit(id: string, input: Partial<UnitInput>): Promise<KernelObject> {
    return this.repo.editDraft(id, {
      data: { ...(input.title !== undefined ? { title: input.title } : {}), ...(input.body !== undefined ? { body: input.body } : {}), ...(input.equations !== undefined ? { equations: input.equations } : {}), ...(input.examples !== undefined ? { examples: input.examples } : {}) },
      securityLabels: input.securityLabels,
      learningMetadata: input.learningMetadata,
    });
  }
  async listUnits(): Promise<KernelObject[]> { return this.repo.listByType('KnowledgeObject'); }

  /** Attach a unit to a course as an ordered part_of edge (order stored on the unit's metadata). */
  async attachUnit(courseObjId: string, unitId: string, order: number): Promise<void> {
    await this.repo.addRelationship(unitId, 'part_of', courseObjId, { order });
    await this.repo.patchMeta(unitId, { order });
  }
  /** Add a prerequisite: prereq -[prerequisite_of]-> unit. */
  async addPrerequisite(unitId: string, prerequisiteUnitId: string): Promise<void> {
    await this.repo.addRelationship(prerequisiteUnitId, 'prerequisite_of', unitId);
  }

  /** Units of a course, ordered. `onlyPublished` filters to the published lifecycle state. */
  async listCourseUnits(courseObjId: string, onlyPublished = false): Promise<KernelObject[]> {
    const graph = await this.repo.getObjectGraph(courseObjId);
    const unitIds = graph.incoming.filter((e) => e.type === 'part_of').map((e) => e.fromId);
    const units: KernelObject[] = [];
    for (const id of unitIds) { const u = await this.repo.getObject(id); if (u && (!onlyPublished || u.lifecycleState === 'published')) units.push(u); }
    return units.sort((a, b) => orderOf(a) - orderOf(b));
  }

  // ---- lifecycle ----
  /** Walk a unit to the published state (created -> validated -> indexed -> published). Idempotent. */
  async publishUnit(id: string): Promise<KernelObject> {
    let o = await this.repo.getObject(id);
    if (!o) throw new Error('unit not found');
    if (o.lifecycleState === 'created') { await this.repo.validateObject(id); o = await this.repo.getObject(id); }
    if (o!.lifecycleState === 'validated') { await this.repo.indexObject(id); o = await this.repo.getObject(id); }
    if (o!.lifecycleState === 'indexed') { await this.repo.publishObject(id); o = await this.repo.getObject(id); }
    return o!;
  }
  async archiveUnit(id: string): Promise<KernelObject> { return this.repo.archiveObject(id); }

  // ---- read a unit for the lesson view ----
  async getUnitView(id: string): Promise<UnitView | null> {
    const graph = await this.repo.getObjectGraph(id).catch(() => null);
    if (!graph) return null;
    const prereqEdges = graph.incoming.filter((e) => e.type === 'prerequisite_of');   // prereq -> this unit
    const prerequisites: UnitView['prerequisites'] = [];
    for (const e of prereqEdges) { const p = await this.repo.getObject(e.fromId); if (p) prerequisites.push({ id: p.id, title: titleOf(p), state: p.lifecycleState }); }
    const courseEdges = graph.outgoing.filter((e) => e.type === 'part_of');            // this unit -> course
    const courses: UnitView['courses'] = [];
    for (const e of courseEdges) { const c = await this.repo.getObject(e.toId); if (c) courses.push({ id: c.id, title: titleOf(c), trainingCourseId: (c.data as any)?.trainingCourseId ?? null }); }
    return { unit: graph.object, prerequisites, courses };
  }
}

let _svc: ContentService | null = null;
/** The real Postgres-backed content service (self-bootstraps kernel tables on first use). */
export function contentService(): ContentService {
  if (!_svc) _svc = new ContentService(createPgKernel());
  return _svc;
}
