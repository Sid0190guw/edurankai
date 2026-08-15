// src/lib/vod.ts — Recording & VOD (Prompt AP1). A recording captures the ORDERED animation SPEC
// timeline (+ optional media) so replays RE-RENDER at the viewer's Prompt-5 tier — never baked pixels.
// A VOD asset is a kernel AnimationObject (metadata.vod=true, like scenes are metadata.sceneSpec),
// carrying securityLabels for access and linked to a Course/KnowledgeObject via `references`. The
// spec timeline lives in the object (works with no object store); media rides the storage interface.
import { KernelRepository, createPgKernel } from '@/lib/kernel';
import { eventsSince, type BoardEvent } from '@/lib/board-session';
import type { SecurityLabel } from '@/lib/kernel/types';

/** The board fan-out session id for a broadcast (AP1 records this session's spec timeline). */
export function broadcastSession(broadcastId: string): string { return 'bcast-' + broadcastId; }

export interface TimelineEntry { tMs: number; kind: string; templateId: string; params: any }
export interface Chapter { tMs: number; label: string }
export interface VodTimeline { timeline: TimelineEntry[]; durationMs: number; chapters: Chapter[]; mediaUrl: string | null }

// animation/slide/ink events replay; ephemeral chat/reactions (bcast-msg) are NOT part of the lesson
const REPLAYABLE = new Set(['scene', 'slide', 'ink']);
function kindOf(templateId: string): string {
  if (templateId === 'scene') return 'scene';
  if (templateId === 'slide') return 'slide';
  if (templateId === 'ink') return 'ink';
  if (templateId === 'bcast-msg') return 'interaction';
  return 'template';
}

/** Build a replayable timeline from ordered board events: relative offsets, specs only (no pixels). */
export function buildTimeline(events: BoardEvent[]): VodTimeline {
  const evs = (events || []).slice().sort((a, b) => a.seq - b.seq);
  const kept = evs.filter((e) => { const k = kindOf(e.templateId); return REPLAYABLE.has(k) || k === 'template'; });
  const t0 = kept.length ? new Date(kept[0].at).getTime() : 0;
  const timeline: TimelineEntry[] = kept.map((e) => ({ tMs: Math.max(0, new Date(e.at).getTime() - t0), kind: kindOf(e.templateId), templateId: e.templateId, params: e.params }));
  const durationMs = timeline.length ? timeline[timeline.length - 1].tMs : 0;
  // a chapter at each scene/slide change (a natural navigation point)
  const chapters: Chapter[] = timeline.filter((e) => e.kind === 'scene' || e.kind === 'slide').map((e, i) => ({ tMs: e.tMs, label: (e.kind === 'slide' && e.params?.slide?.title) ? e.params.slide.title : (e.kind === 'scene' && e.params?.scene?.title) ? e.params.scene.title : 'Chapter ' + (i + 1) }));
  return { timeline, durationMs, chapters, mediaUrl: null };
}

/** Replay seek (pure): the spec to show at position tMs = the last event at/before it. Null before start. */
export function specAt(timeline: TimelineEntry[], tMs: number): TimelineEntry | null {
  let cur: TimelineEntry | null = null;
  for (const e of timeline || []) { if (e.tMs <= tMs) cur = e; else break; }
  return cur;
}

/** Pure access check: does a viewer's context satisfy the asset's securityLabels? */
export function labelAllows(labels: SecurityLabel[], ctx: { enrolled?: boolean; examMode?: boolean }): boolean {
  const ls = labels || [];
  if (ls.includes('exam-secure') && !ctx.examMode) return false;      // exam material only in exam context
  if (ls.includes('enrolled-only') && !ctx.enrolled) return false;    // enrolled learners only
  return true;                                                         // public (or unlabelled)
}

export class VodService {
  constructor(private repo: KernelRepository = createPgKernel()) {}

  /** Snapshot a live session's spec timeline into a VOD AnimationObject linked to a Course/KO. */
  async record(sessionId: string, meta: { title: string; linkId?: string | null; owner?: string | null; labels?: SecurityLabel[]; mediaUrl?: string | null }): Promise<string> {
    // A RECORDING THAT SILENTLY LOSES THE LESSON IS WORSE THAN ONE THAT FAILS.
    //
    // Two caps used to combine into unrecoverable data loss with no error anywhere: the read below
    // stopped at 5,000 events with `.catch(() => [])`, and the serialised payload was cut with
    // `.slice(0, 400000)` — mid-JSON. A long session therefore produced a row that parses to `{}`
    // on read (see get(), whose `try { JSON.parse } catch {}` leaves payload empty), i.e. a VOD
    // that exists, is listed, opens, and plays NOTHING. The session it came from is gone by then.
    //
    // Both limits stay — an unbounded read and an unbounded column are their own problems — but
    // hitting either is now a LOUD, RECORDED fact rather than a silent truncation.
    const EVENT_CAP = 5000;
    const SCENE_CAP = 400000;

    let events: BoardEvent[] = [];
    let readFailed = false;
    try {
      events = await eventsSince(sessionId, 0, EVENT_CAP);
    } catch (e: any) {
      readFailed = true;
      console.error('[vod] record: reading session ' + sessionId + ' failed:', e?.cause?.message || e?.message);
    }
    // A FAILED READ AND AN EMPTY SESSION ARE DIFFERENT FACTS, and so are "there is a video file" and
    // "there is not". Refuse only in the case that would produce a recording containing NOTHING —
    // no board timeline and no media — because that is the row that lists, opens and plays silence.
    // Where a media file exists, the class IS recorded and the missing timeline is a degradation to
    // report, not a reason to discard forty minutes of video.
    if (readFailed && !meta.mediaUrl) {
      throw new Error('The session could not be read and there is no media file, so there is nothing to record. Nothing has been saved under a title that would imply otherwise.');
    }
    const truncatedEvents = events.length >= EVENT_CAP;

    const tl = buildTimeline(events);
    if (meta.mediaUrl) tl.mediaUrl = meta.mediaUrl;
    const payload = { vod: true, title: meta.title, timeline: tl.timeline, durationMs: tl.durationMs, chapters: tl.chapters, mediaUrl: tl.mediaUrl };

    // Serialise ONCE and measure it. Cutting a JSON string at a byte offset produces something that
    // cannot be parsed at all, so if it does not fit we drop whole events off the end — which
    // yields a shorter but VALID timeline — and record that we did.
    let scene = JSON.stringify(payload);
    let droppedForSize = 0;
    while (scene.length > SCENE_CAP && payload.timeline.length > 1) {
      const drop = Math.max(1, Math.ceil(payload.timeline.length * 0.1));
      payload.timeline.splice(payload.timeline.length - drop, drop);
      droppedForSize += drop;
      scene = JSON.stringify(payload);
    }
    if (scene.length > SCENE_CAP) {
      throw new Error('This recording cannot be stored: a single event exceeds the size a recording may occupy. Nothing was saved.');
    }
    if (truncatedEvents || droppedForSize) {
      console.error('[vod] record ' + sessionId + ': INCOMPLETE — ' +
        (truncatedEvents ? 'session had at least ' + EVENT_CAP + ' events (read cap reached); ' : '') +
        (droppedForSize ? droppedForSize + ' event(s) dropped to fit the size cap; ' : '') +
        'the stored recording is shorter than the class was.');
    }

    const o = await this.repo.createObject({
      type: 'AnimationObject',
      data: { title: meta.title || 'Recording', scene } as any,
      owner: meta.owner ?? null,
      securityLabels: (meta.labels && meta.labels.length ? meta.labels : ['enrolled-only']) as any,
      // `incomplete` travels WITH the recording, so a surface listing it can say so. A shorter
      // recording that admits it is a different object from one that pretends to be whole.
      metadata: {
        vod: true, sessionId, durationMs: tl.durationMs, events: payload.timeline.length,
        chapters: tl.chapters.length, published: false, mediaUrl: tl.mediaUrl,
        incomplete: truncatedEvents || droppedForSize > 0 || readFailed,
        droppedEvents: droppedForSize,
        hitReadCap: truncatedEvents,
        timelineUnavailable: readFailed,
      },
    } as any);
    const id = (o as any).id;
    if (meta.linkId) await this.repo.addRelationship(meta.linkId, 'references', id).catch(() => {});   // Course/KO -references-> VOD
    return id;
  }
  async get(id: string): Promise<{ id: string; title: string; labels: SecurityLabel[]; published: boolean; data: VodTimeline } | null> {
    const o = await this.repo.getObject(id); if (!o || !(o.metadata as any)?.vod) return null;
    let payload: any = {}; try { payload = JSON.parse((o.data as any).scene); } catch {}
    return { id, title: payload.title || (o.data as any).title, labels: (o.securityLabels || []) as any, published: !!(o.metadata as any).published, data: { timeline: payload.timeline || [], durationMs: payload.durationMs || 0, chapters: payload.chapters || [], mediaUrl: payload.mediaUrl || null } };
  }
  async list(onlyPublished = false): Promise<any[]> {
    const all = (await this.repo.listByType('AnimationObject').catch(() => [])).filter((o: any) => (o.metadata as any)?.vod);
    return (onlyPublished ? all.filter((o: any) => (o.metadata as any).published) : all).map((o: any) => ({ id: o.id, title: (o.data as any).title, durationMs: (o.metadata as any).durationMs || 0, published: !!(o.metadata as any).published, labels: o.securityLabels || [], events: (o.metadata as any).events || 0 }));
  }
  async setPublished(id: string, on: boolean): Promise<void> {
    // the VOD "published" flag is app state, not the kernel publish lifecycle -> editDraft (in-place, no transition)
    await this.repo.editDraft(id, { metadata: { published: on } }).catch(() => {});
  }
}
let _svc: VodService | null = null;
export function vodService(): VodService { if (!_svc) _svc = new VodService(createPgKernel()); return _svc; }
