// src/lib/learning-object.ts — A LESSON HOLDS TYPED OBJECTS, NOT A VIDEO FIELD.
//
// =================================================================================================
// WHAT THIS IS, AND WHAT IT REFUSES TO BE
// =================================================================================================
//
// It is NOT a fourth content model. Three already exist and are named honestly here:
//
//   1. training_lesson_blocks  — the block abstraction (src/lib/aquintutor-authoring.ts). 18 kinds,
//                                (lesson_id, kind, position, content JSONB). The AquinTutor player
//                                reads it. THIS IS THE LIVE AUTHORING SHAPE.
//   2. fixed columns on training_lessons — content, video_url, and the video columns
//                                src/lib/lesson-video.ts adds (video_embed_url, video_provider,
//                                video_link_kind). /portal/courses/[slug] renders FROM THESE and
//                                never reads a block, which is why the same lesson can look
//                                different in the two players.
//   3. kernel KnowledgeObject  — src/lib/kernel-content.ts, keyed by ko_id, its own progress table.
//                                A different key space; bridged by name here, never merged.
//
// This module is the READING that makes those one list. Every function below DERIVES a typed
// learning object from what is already stored. Nothing already authored has to move, and a lesson
// that has never been opened in the block editor still yields objects — from its own columns.
//
// The one table it adds, training_learning_objects, stores NO CONTENT. It carries the facets the
// two existing shapes cannot express (commercial rights, preview, whether an object counts toward
// completion) plus the objects that have no home in either — an uploaded video, an audio file, an
// external link with a licence note. It is an OVERLAY, matched to a derived object by its ref, so
// an empty table means the lesson reads exactly as it did before.
//
// =================================================================================================
// SECTION 57 — THE SIX THINGS THAT MUST NEVER BE ONE THING
// =================================================================================================
//
//   content source     where the material comes from        authored / uploaded / link / embed / live
//   delivery           how it reaches the learner           in page / stream / download / frame / join
//   access rights      who may open it                      public preview / enrolled / entitled / staff
//   commercial rights  what we are allowed to do with it    owned / licensed / third-party link
//   learning state     what this person has done with it    not started / in progress / completed
//   credential state   whether it counts toward a credential none / counts toward / evidence / issued
//
// A PUBLICLY AVAILABLE VIDEO DOES NOT MEAN A PAID COURSE WAS COMPLETED. That sentence is the whole
// point of the six, and it is the sentence the types below make unwriteable: each facet is a
// NOMINAL type (branded), so a ContentSource cannot be assigned where an AccessRight is wanted, a
// LearningState cannot stand in for a CredentialState, and there is no function anywhere in this
// file that derives one facet from another. The compiler refuses the conflation; the tests in
// learning-object.test.ts state it in English as well.
//
// =================================================================================================
// VIDEO IS ALL THREE, AND THE MISSING CAPABILITIES ARE A STATE
// =================================================================================================
//
// A video object may be an EMBED (a provider link resolved by src/lib/video-embed.ts), a LINK, or a
// real UPLOAD held behind a storage interface. All three are first-class here.
//
// What this deployment does NOT have is a media pipeline. There is no transcoder, no adaptive
// bitrate ladder, no multi-resolution rendition set and no caption generation. deliveryCapabilities()
// returns those as UNAVAILABLE by name rather than leaving a screen free to offer a 1080p selector
// over one uploaded file. An unavailable capability is a first-class state, not a lie and not a
// silence.
//
// EduRankAI is the technology platform. Nothing here claims a qualification; accredited partners
// award credentials. Learner-facing labels below never name a provider.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';

// -------------------------------------------------------------------------------------------------
// CONSTANTS AND HELPERS — every one declared ABOVE the functions that read them. `const` is not
// hoisted; a function reaching a later declaration throws on its own first line while the page
// reports success. That has taken surfaces down on this project.
// -------------------------------------------------------------------------------------------------

const MOD = 'learning-object';

/** postgres-js resolves to a PLAIN ARRAY, never `{ rows }`. `r.rows[0]` is always a bug here. */
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason is on `e.cause`; `e.message` is only the SQL that failed. */
const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const logFail = (tag: string, e: any) => console.error('[' + MOD + '] ' + tag, causeOf(e));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/**
 * "That table is not here" is a different fact from "that read failed". 42P01 is undefined_table:
 * training_lesson_blocks is created by the authoring library on first use, so on a database where
 * nobody has opened the block editor it genuinely does not exist. Same reading as learning-doors.ts.
 */
const isMissingTable = (e: any): boolean =>
  String(e?.cause?.code || '') === '42P01' || /relation .* does not exist/i.test(causeOf(e));

const WRITE_FAILED = 'We could not save that just now. Nothing was changed.';

// -------------------------------------------------------------------------------------------------
// THE SIX FACETS, AS NOMINAL TYPES
//
// Branding is not decoration. Without it every facet is `string`, and `object.access = source.kind`
// compiles — which is exactly the conflation section 57 exists to prevent. With it, each facet has
// its own constructor and the compiler refuses every cross-assignment.
// -------------------------------------------------------------------------------------------------

declare const FACET: unique symbol;
type Branded<K extends string, V extends string> = V & { readonly [FACET]: K };

/** WHERE THE MATERIAL COMES FROM. Nothing about who may see it. */
export const CONTENT_SOURCES = [
  'authored',      // written in this platform (a block, a lesson body)
  'uploaded',      // a file we hold, behind the storage interface
  'external_link', // an address somebody else hosts; we hold no copy
  'embedded',      // a third-party player framed in the page
  'live',          // produced in real time; no artefact exists until it is recorded
  'kernel',        // a KnowledgeObject in the kernel content model
] as const;
export type ContentSourceKind = Branded<'content_source', (typeof CONTENT_SOURCES)[number]>;

/** HOW IT REACHES THE LEARNER. Nothing about where it came from. */
export const DELIVERY_MODES = [
  'in_page',        // rendered inside the lesson
  'stream',         // played from our storage
  'download',       // handed over as a file
  'embed_frame',    // an iframe under sandbox
  'live_join',      // a join at a scheduled time
  'external_open',  // opened on somebody else's site, in a new tab
  'offline_package',// bundled for offline use
] as const;
export type DeliveryMode = Branded<'delivery', (typeof DELIVERY_MODES)[number]>;

/** WHO MAY OPEN IT. Nothing about payment, which is one input to this and not the same fact. */
export const ACCESS_RIGHTS = [
  'public_preview', // deliberately open, signed in or not
  'enrolled',       // an enrolment row is enough
  'entitled',       // enrolment AND settlement (paid, waived, or free by policy)
  'staff_only',     // authors, reviewers and the learning desk
] as const;
export type AccessRight = Branded<'access_right', (typeof ACCESS_RIGHTS)[number]>;

/** WHAT WE ARE ALLOWED TO DO WITH IT. Nothing about who may watch it. */
export const COMMERCIAL_RIGHTS = [
  'owned',                 // made here
  'licensed_for_platform', // licensed to us, on terms recorded in the note
  'third_party_link',      // we link; we hold no rights and distribute nothing
  'unknown',               // nobody has recorded this yet. The honest default.
] as const;
export type CommercialRight = Branded<'commercial_right', (typeof COMMERCIAL_RIGHTS)[number]>;

/** WHAT THIS PERSON HAS DONE WITH IT. Nothing about what they were awarded for it. */
export const LEARNING_STATES = [
  'not_started',
  'in_progress',
  'completed',
  'not_tracked', // this object records no engagement at all — a divider, a caption
] as const;
export type LearningState = Branded<'learning_state', (typeof LEARNING_STATES)[number]>;

/** WHETHER IT BEARS ON A CREDENTIAL. Nothing about whether it was watched. */
export const CREDENTIAL_STATES = [
  'not_credential_bearing', // finishing it awards nothing and never will
  'counts_toward',          // it is part of what a credential is measured on
  'evidence_recorded',      // engagement with it is on the record as evidence
  'credential_issued',      // an accredited partner has awarded against it
] as const;
export type CredentialState = Branded<'credential_state', (typeof CREDENTIAL_STATES)[number]>;

const inList = (list: readonly string[], v: unknown): boolean =>
  typeof v === 'string' && list.indexOf(v) >= 0;

/**
 * THE CONSTRUCTORS. Each is the ONLY way to make a value of its facet, and each falls back to the
 * most conservative member rather than throwing — a lesson must render even when a stored string is
 * something nobody in this repository writes.
 */
export function contentSource(v: unknown): ContentSourceKind {
  return (inList(CONTENT_SOURCES, v) ? v : 'authored') as ContentSourceKind;
}
export function delivery(v: unknown): DeliveryMode {
  return (inList(DELIVERY_MODES, v) ? v : 'in_page') as DeliveryMode;
}
export function accessRight(v: unknown): AccessRight {
  // The conservative default is `entitled`, not `enrolled`: an object nobody has classified must not
  // be the one that leaks a paid course.
  return (inList(ACCESS_RIGHTS, v) ? v : 'entitled') as AccessRight;
}
export function commercialRight(v: unknown): CommercialRight {
  return (inList(COMMERCIAL_RIGHTS, v) ? v : 'unknown') as CommercialRight;
}
export function learningState(v: unknown): LearningState {
  return (inList(LEARNING_STATES, v) ? v : 'not_started') as LearningState;
}
export function credentialState(v: unknown): CredentialState {
  return (inList(CREDENTIAL_STATES, v) ? v : 'not_credential_bearing') as CredentialState;
}

// -------------------------------------------------------------------------------------------------
// THE TYPED OBJECT KINDS — section 12
// -------------------------------------------------------------------------------------------------

export const OBJECT_TYPES = [
  'video',
  'live',
  'document',
  'interactive',
  'assessment',
  'audio',
  'external_link',
  'reading',
  'discussion',
  'ai_tutor',
] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

/** What a learner reads. No provider name, no product name, no price. */
export const OBJECT_TYPE_LABELS: Record<ObjectType, string> = {
  video: 'Watch',
  live: 'Join live',
  document: 'Open the document',
  interactive: 'Work through it',
  assessment: 'Take the assessment',
  audio: 'Listen',
  external_link: 'Open the link',
  reading: 'Read',
  discussion: 'Discuss',
  ai_tutor: 'Practise with the tutor',
};

export function isObjectType(v: unknown): v is ObjectType {
  return inList(OBJECT_TYPES, v);
}

/**
 * BLOCK KIND -> OBJECT TYPE. The bridge, stated once.
 *
 * The keys are the 18 kinds in BLOCK_KINDS (src/lib/aquintutor-authoring.ts). They are listed here
 * rather than imported because that module runs about thirty DDL statements on import of its schema
 * guard, and a read of a lesson must not carry that. learning-doors.ts reads the block table
 * directly for the same reason. A kind that is not in this map still yields an object — as
 * 'reading', the type that promises nothing.
 */
export const BLOCK_KIND_TO_TYPE: Record<string, ObjectType> = {
  text: 'reading',
  heading: 'reading',
  image: 'reading',
  callout: 'reading',
  code: 'reading',
  quote: 'reading',
  divider: 'reading',
  latex: 'reading',
  video_embed: 'video',
  file_attachment: 'document',
  mcq: 'assessment',
  fill_blank: 'assessment',
  order_steps: 'interactive',
  embed_lab: 'interactive',
  embed_simulator: 'interactive',
  embed_animation: 'interactive',
  embed_test: 'assessment',
  embed_liveclass: 'live',
};

/** Block kinds that are page furniture: they record no engagement and can never bear a credential. */
export const UNTRACKED_BLOCK_KINDS = ['divider', 'heading', 'quote'];

// -------------------------------------------------------------------------------------------------
// CAPABILITIES THIS DEPLOYMENT DOES NOT HAVE
//
// Declared as data so a screen can print the sentence instead of offering the control. The founder's
// rule: a screen must never offer a 1080p selector over one uploaded file.
// -------------------------------------------------------------------------------------------------

export interface CapabilityReport {
  /** Things this object can actually do here. */
  available: string[];
  /** Things a media platform would offer and this deployment cannot. Named, never hidden. */
  unavailable: string[];
  /** One sentence for the screen. Empty when nothing is missing. */
  note: string;
}

const NO_PIPELINE = [
  'transcoding',
  'adaptive bitrate',
  'multiple resolutions',
  'automatic captions',
];

const NO_PIPELINE_NOTE =
  'This file plays exactly as it was uploaded. There is no transcoding, no adaptive bitrate, no '
  + 'second resolution and no automatic captions on this deployment, so nothing here offers a '
  + 'quality selector it could not honour. Captions can be added as a separate file.';

const THIRD_PARTY_NOTE =
  'This plays on the site that hosts it, under whatever that site provides. Nothing about it is '
  + 'produced or stored here.';

/**
 * What delivery can actually do for one object on THIS deployment. Pure.
 *
 * The uploaded case is the one that matters: a real upload behind the storage interface can be
 * streamed and downloaded and nothing else, and saying so is the difference between an honest player
 * and a screen that pretends to a media pipeline that is not installed.
 */
export function deliveryCapabilities(source: ContentSourceKind, type: ObjectType): CapabilityReport {
  const s = String(source);
  if (s === 'uploaded' && (type === 'video' || type === 'audio')) {
    return {
      available: ['streaming the original', 'download', 'resume position'],
      unavailable: NO_PIPELINE.slice(),
      note: NO_PIPELINE_NOTE,
    };
  }
  if (s === 'uploaded') {
    return { available: ['download'], unavailable: [], note: '' };
  }
  if (s === 'embedded' || s === 'external_link') {
    return {
      available: ['playback on the hosting site'],
      unavailable: ['download', 'offline use', 'playback statistics'],
      note: THIRD_PARTY_NOTE,
    };
  }
  if (s === 'live') {
    return {
      available: ['joining at the scheduled time'],
      unavailable: ['replay before a recording is filed'],
      note: 'A live session exists while it is happening. A recording is a separate object and only '
        + 'appears once one has been filed against this lesson.',
    };
  }
  return { available: ['reading in the page'], unavailable: [], note: '' };
}

// -------------------------------------------------------------------------------------------------
// THE OBJECT
// -------------------------------------------------------------------------------------------------

export interface SourceFacet {
  kind: ContentSourceKind;
  /** Block id, column name, storage key, address or session id. Never content. */
  ref: string | null;
  /** Named ONLY on admin surfaces. Learner copy says Watch, Join, Continue. */
  provider: string | null;
}

export interface DeliveryFacet {
  mode: DeliveryMode;
  capabilities: CapabilityReport;
}

export interface AccessFacet {
  right: AccessRight;
  /** Section 10: this object is deliberately open while the rest of the course stays protected. */
  previewable: boolean;
}

export interface CommercialFacet {
  right: CommercialRight;
  note: string | null;
}

export interface LearningFacet {
  state: LearningState;
  /** Whether finishing this object is part of finishing the lesson. */
  countsForCompletion: boolean;
}

export interface CredentialFacet {
  state: CredentialState;
  /** The ledger number, when one has been issued. Never minted here. */
  certNumber: string | null;
}

export interface LearningObject {
  /** Stable across reads. 'block:<uuid>', 'lesson:<uuid>:video', or an overlay row id. */
  id: string;
  lessonId: string;
  courseId: string | null;
  position: number;
  type: ObjectType;
  title: string;
  /** Where this object came from in the existing data. Diagnostic, never shown to a learner. */
  origin: 'block' | 'lesson_column' | 'object_row';
  source: SourceFacet;
  delivery: DeliveryFacet;
  access: AccessFacet;
  commercial: CommercialFacet;
  learning: LearningFacet;
  credential: CredentialFacet;
}

// -------------------------------------------------------------------------------------------------
// THE FACET QUESTIONS. One per facet, and NOT ONE OF THEM READS ANOTHER FACET.
//
// This is section 57 as code. Each function's parameter type names the single facet it is entitled
// to look at, so a future edit that wanted to answer "did they complete it" from the content source
// would have to change a signature to do it — which is a visible act, not a slip.
// -------------------------------------------------------------------------------------------------

/** Is the MATERIAL out in the open? Says nothing about entitlement, completion or a credential. */
export function isPubliclyAvailable(source: SourceFacet): boolean {
  const s = String(source.kind);
  return s === 'external_link' || s === 'embedded';
}

/** Is this object OPEN TO ANYONE? The access facet, and only it. */
export function isOpenToAnyone(access: AccessFacet): boolean {
  return access.previewable || String(access.right) === 'public_preview';
}

/** May we redistribute this ourselves? The commercial facet, and only it. */
export function mayRedistribute(commercial: CommercialFacet): boolean {
  const r = String(commercial.right);
  return r === 'owned' || r === 'licensed_for_platform';
}

/** Has this person finished it? The learning facet, and only it. */
export function isFinished(learning: LearningFacet): boolean {
  return String(learning.state) === 'completed';
}

/** Has anything been awarded? The credential facet, and only it. */
export function credentialIssued(credential: CredentialFacet): boolean {
  return String(credential.state) === 'credential_issued';
}

// -------------------------------------------------------------------------------------------------
// DERIVATION — PURE. Given the rows a lesson already has, what objects does it hold?
// -------------------------------------------------------------------------------------------------

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const clip = (v: unknown, n: number): string => str(v).trim().slice(0, n);

/** Parse a JSONB column that postgres-js may hand back as an object or as text. */
function asObject(v: any): any {
  if (v && typeof v === 'object') return v;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return {}; } }
  return {};
}

/**
 * The overlay row that may sit on top of a derived object, keyed by its ref.
 * Absent for every object until somebody records a licence, a preview flag or a completion weight.
 */
export interface ObjectOverlay {
  ref: string;
  type?: ObjectType | null;
  title?: string | null;
  previewable?: boolean | null;
  commercial?: string | null;
  commercialNote?: string | null;
  countsForCompletion?: boolean | null;
  accessRight?: string | null;
  sourceKind?: string | null;
  provider?: string | null;
  deliveryMode?: string | null;
}

function applyOverlay(obj: LearningObject, o: ObjectOverlay | undefined): LearningObject {
  if (!o) return obj;
  const type = o.type && isObjectType(o.type) ? o.type : obj.type;
  const sourceKind = o.sourceKind ? contentSource(o.sourceKind) : obj.source.kind;
  return {
    ...obj,
    type,
    title: o.title ? clip(o.title, 200) : obj.title,
    source: {
      kind: sourceKind,
      ref: obj.source.ref,
      provider: o.provider ? clip(o.provider, 60) : obj.source.provider,
    },
    delivery: {
      mode: o.deliveryMode ? delivery(o.deliveryMode) : obj.delivery.mode,
      capabilities: deliveryCapabilities(sourceKind, type),
    },
    access: {
      right: o.accessRight ? accessRight(o.accessRight) : obj.access.right,
      previewable: o.previewable === null || o.previewable === undefined
        ? obj.access.previewable
        : o.previewable === true,
    },
    commercial: {
      right: o.commercial ? commercialRight(o.commercial) : obj.commercial.right,
      note: o.commercialNote ? clip(o.commercialNote, 500) : obj.commercial.note,
    },
    learning: {
      state: obj.learning.state,
      countsForCompletion: o.countsForCompletion === null || o.countsForCompletion === undefined
        ? obj.learning.countsForCompletion
        : o.countsForCompletion === true,
    },
    credential: obj.credential,
  };
}

/** A block row -> a typed object. Pure. */
function objectFromBlock(
  block: any,
  lesson: { id: string; courseId: string | null; previewAllowed: boolean },
  index: number,
): LearningObject {
  const kind = str(block?.kind) || 'text';
  const content = asObject(block?.content);
  const type: ObjectType = BLOCK_KIND_TO_TYPE[kind] || 'reading';
  const tracked = UNTRACKED_BLOCK_KINDS.indexOf(kind) < 0;

  let sourceKind: ContentSourceKind = contentSource('authored');
  let mode: DeliveryMode = delivery('in_page');
  let ref: string | null = str(block?.id) || null;
  let provider: string | null = null;
  let commercial: CommercialRight = commercialRight('owned');

  if (kind === 'video_embed') {
    // Provider and address come from the block; both are ADMIN facts. The learner sees "Watch".
    sourceKind = contentSource('embedded');
    mode = delivery('embed_frame');
    provider = clip(content?.provider, 60) || null;
    commercial = commercialRight('third_party_link');
  } else if (kind === 'file_attachment') {
    // Documents on this project are links, never uploads. That rule is unchanged.
    sourceKind = contentSource('external_link');
    mode = delivery('external_open');
    commercial = commercialRight('third_party_link');
  } else if (kind === 'embed_liveclass') {
    sourceKind = contentSource('live');
    mode = delivery('live_join');
    ref = clip(content?.roomId, 120) || ref;
  } else if (kind === 'embed_lab' || kind === 'embed_simulator' || kind === 'embed_animation') {
    mode = delivery('embed_frame');
    ref = clip(content?.slug || content?.target || content?.scene, 120) || ref;
  } else if (kind === 'embed_test') {
    ref = clip(content?.slug, 120) || ref;
  }

  const title = clip(content?.title || content?.question || content?.prompt || content?.caption
    || content?.text || content?.name, 200)
    || OBJECT_TYPE_LABELS[type];

  return {
    id: 'block:' + str(block?.id),
    lessonId: lesson.id,
    courseId: lesson.courseId,
    position: Number(block?.position ?? index) || index,
    type,
    title,
    origin: 'block',
    source: { kind: sourceKind, ref, provider },
    delivery: { mode, capabilities: deliveryCapabilities(sourceKind, type) },
    // A lesson marked previewable makes its objects previewable; an object may also be marked on its
    // own through the overlay. THERE IS NO SECOND AUTHORIZATION PATH — the preview flag is read by
    // courseAccess() inside the one decision, never beside it.
    access: { right: accessRight('entitled'), previewable: lesson.previewAllowed },
    commercial: { right: commercial, note: null },
    learning: {
      state: learningState('not_started'),
      countsForCompletion: tracked && (type === 'assessment' || type === 'interactive' || type === 'video'),
    },
    credential: { state: credentialState('not_credential_bearing'), certNumber: null },
  };
}

/**
 * The objects a lesson holds in its OWN COLUMNS, for a lesson that has no blocks — or that has both.
 *
 * This is the bridge the brief asks for: the fixed video field becomes a typed video object, so the
 * portal player's lessons and the block editor's lessons finally describe themselves the same way.
 * Nothing is written and nothing is migrated; the columns stay exactly where they are.
 */
export function objectsFromLessonColumns(lesson: any): LearningObject[] {
  const id = str(lesson?.id);
  const courseId = str(lesson?.course_id) || null;
  const previewAllowed = lesson?.preview_allowed === true;
  const out: LearningObject[] = [];

  // src/lib/lesson-video.ts (course-delivery) resolves and stores the embed address. Read it if it
  // is there; fall back to the legacy column, which is the only one that exists on older rows.
  const embed = clip(lesson?.video_embed_url, 2000);
  const legacy = clip(lesson?.video_url, 2000);
  const linkKind = clip(lesson?.video_link_kind, 16);
  const address = embed || legacy;
  if (address) {
    const uploaded = linkKind === 'upload' || /^\/(?:api\/)?media\//.test(address);
    const kind = uploaded ? contentSource('uploaded') : contentSource('embedded');
    const mode = uploaded ? delivery('stream') : delivery('embed_frame');
    out.push({
      id: 'lesson:' + id + ':video',
      lessonId: id,
      courseId,
      position: -1, // the lesson's own video comes before its blocks, as both players render it
      type: 'video',
      title: clip(lesson?.title, 200) || 'Watch',
      origin: 'lesson_column',
      source: { kind, ref: address, provider: clip(lesson?.video_provider, 60) || null },
      delivery: { mode, capabilities: deliveryCapabilities(kind, 'video') },
      access: { right: accessRight('entitled'), previewable: previewAllowed },
      commercial: {
        right: uploaded ? commercialRight('owned') : commercialRight('third_party_link'),
        note: null,
      },
      learning: { state: learningState('not_started'), countsForCompletion: true },
      credential: { state: credentialState('not_credential_bearing'), certNumber: null },
    });
  }

  const body = clip(lesson?.content, 200000);
  if (body) {
    const kind = contentSource('authored');
    out.push({
      id: 'lesson:' + id + ':reading',
      lessonId: id,
      courseId,
      position: 0,
      type: 'reading',
      title: clip(lesson?.title, 200) || 'Read',
      origin: 'lesson_column',
      source: { kind, ref: 'content', provider: null },
      delivery: { mode: delivery('in_page'), capabilities: deliveryCapabilities(kind, 'reading') },
      access: { right: accessRight('entitled'), previewable: previewAllowed },
      commercial: { right: commercialRight('owned'), note: null },
      learning: { state: learningState('not_started'), countsForCompletion: false },
      credential: { state: credentialState('not_credential_bearing'), certNumber: null },
    });
  }

  return out;
}

/**
 * THE DERIVATION, WHOLE AND PURE. Lesson row + block rows + overlay rows -> the typed list.
 *
 * Exported separately from the database read so it can be unit-tested without a connection, and so a
 * caller that already has the rows does not fetch them twice.
 */
export function deriveLessonObjects(
  lesson: any,
  blocks: any[],
  overlays: ObjectOverlay[] = [],
): LearningObject[] {
  const id = str(lesson?.id);
  if (!id) return [];
  const meta = {
    id,
    courseId: str(lesson?.course_id) || null,
    previewAllowed: lesson?.preview_allowed === true,
  };

  const byRef = new Map<string, ObjectOverlay>();
  for (const o of overlays || []) {
    if (o && o.ref) byRef.set(String(o.ref), o);
  }

  const fromBlocks = (blocks || []).map((b, i) => objectFromBlock(b, meta, i));
  const fromColumns = objectsFromLessonColumns(lesson);

  // A lesson authored in BOTH shapes yields both, and the caller sees exactly what is stored. That
  // is the honest reading of the split the map calls out: it does not hide one shape behind the
  // other, it names both in one list so somebody can see the duplication and fix the authoring.
  const merged = fromColumns.concat(fromBlocks)
    .map((o) => applyOverlay(o, byRef.get(o.id)));

  // Objects authored directly in the overlay table — an upload, an audio file, a link with a licence
  // — have no derived counterpart, so they are added rather than merged.
  const derivedIds = new Set(merged.map((o) => o.id));
  for (const o of overlays || []) {
    if (!o || !o.ref || derivedIds.has(o.ref)) continue;
    if (!String(o.ref).startsWith('object:')) continue;
    const type: ObjectType = o.type && isObjectType(o.type) ? o.type : 'document';
    const kind = contentSource(o.sourceKind || 'uploaded');
    merged.push(applyOverlay({
      id: String(o.ref),
      lessonId: id,
      courseId: meta.courseId,
      position: 1000,
      type,
      title: clip(o.title, 200) || OBJECT_TYPE_LABELS[type],
      origin: 'object_row',
      source: { kind, ref: null, provider: null },
      delivery: { mode: delivery(o.deliveryMode || 'stream'), capabilities: deliveryCapabilities(kind, type) },
      access: { right: accessRight('entitled'), previewable: meta.previewAllowed },
      commercial: { right: commercialRight('unknown'), note: null },
      learning: { state: learningState('not_started'), countsForCompletion: false },
      credential: { state: credentialState('not_credential_bearing'), certNumber: null },
    }, o));
  }

  return merged.sort((a, b) => (a.position - b.position) || a.id.localeCompare(b.id));
}

/** The objects of this lesson a person who is NOT entitled may still open. Section 10. */
export function previewableObjects(objects: LearningObject[]): LearningObject[] {
  return (objects || []).filter((o) => isOpenToAnyone(o.access));
}

/**
 * Does this lesson offer anything at all to somebody outside the course?
 *
 * Used by courseAccess() as ONE INPUT to its single decision. It is deliberately a predicate over
 * objects and not an authorization function: it cannot grant anything, it can only report that
 * something was marked open.
 */
export function lessonHasPreview(objects: LearningObject[]): boolean {
  return previewableObjects(objects).length > 0;
}

// -------------------------------------------------------------------------------------------------
// SCHEMA — the overlay table. ADDITIVE ONLY, never DROP, its own ensureOnce key.
// -------------------------------------------------------------------------------------------------

export function ensureLearningObjectSchema(): Promise<void> {
  return ensureOnce('learning-object:v1', async () => {
    const ex = async (q: any, tag: string) => {
      try { await db.execute(q); } catch (e: any) { logFail('ensure:' + tag, e); }
    };
    // NO CONTENT COLUMN, DELIBERATELY. Content lives in training_lesson_blocks and in the lesson's
    // own columns. A body column here would be the fourth content model this file exists to refuse.
    await ex(sql`CREATE TABLE IF NOT EXISTS training_learning_objects (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lesson_id UUID NOT NULL,
      object_ref VARCHAR(120) NOT NULL,
      object_type VARCHAR(24),
      title VARCHAR(200),
      source_kind VARCHAR(24),
      source_provider VARCHAR(60),
      source_locator TEXT,
      delivery_mode VARCHAR(24),
      access_right VARCHAR(24),
      previewable BOOLEAN,
      commercial_right VARCHAR(32),
      commercial_note TEXT,
      counts_for_completion BOOLEAN,
      created_by_user_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT training_learning_objects_ref UNIQUE (lesson_id, object_ref))`, 'objects');
    await ex(sql`CREATE INDEX IF NOT EXISTS tlo_lesson_idx
      ON training_learning_objects(lesson_id)`, 'objects_idx');
    // The preview flag already exists on training_lessons (preview_allowed, added by the authoring
    // library and written by /api/aquintutor/lessons/[id]/meta). It had no reader anywhere in this
    // repository until courseAccess(). It is NOT redeclared here — one flag, one column.
  });
}

/**
 * VERIFY, NEVER TRUST THE ENSURE. src/lib/ensure-once.ts swallows a DDL failure by design, so a
 * caller that believed its return value would write a facet into a column that does not exist.
 */
export async function learningObjectSchemaState(): Promise<{ ok: boolean; missing: string[]; error: string | null }> {
  await ensureLearningObjectSchema();
  try {
    const present = new Set(rowsOf(await db.execute(sql`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'training_learning_objects'`)).map((r: any) => String(r.column_name)));
    const want = ['lesson_id', 'object_ref', 'object_type', 'previewable', 'commercial_right', 'counts_for_completion'];
    const missing = want.filter((c) => !present.has(c));
    return { ok: present.size > 0 && missing.length === 0, missing, error: null };
  } catch (e: any) {
    logFail('schemaState', e);
    return { ok: false, missing: [], error: causeOf(e) };
  }
}

// -------------------------------------------------------------------------------------------------
// THE DATABASE READ
// -------------------------------------------------------------------------------------------------

export interface LessonObjectsRead {
  lessonId: string;
  courseId: string | null;
  lessonTitle: string;
  objects: LearningObject[];
  /** False when we could not read the lesson at all — a 503, never an empty lesson. */
  ok: boolean;
  /** True when the block table is absent on this database. Not an outage. */
  blocksAbsent: boolean;
  error: string | null;
}

/**
 * Every typed object this lesson holds, from every shape it is stored in.
 *
 * THREE READS, each tolerated separately: a missing block table is "no blocks", a failed lesson read
 * is a failure, and a missing overlay table simply means no facet has been recorded yet. An empty
 * list from a failed read would tell a learner their lesson is empty, so ok:false is reported rather
 * than an empty array pretending to be an answer.
 */
export async function lessonObjects(lessonId: string): Promise<LessonObjectsRead> {
  const empty: LessonObjectsRead = {
    lessonId: str(lessonId), courseId: null, lessonTitle: '', objects: [],
    ok: false, blocksAbsent: false, error: null,
  };
  if (!isUuid(lessonId)) return { ...empty, error: 'That lesson does not exist.' };

  let lesson: any = null;
  try {
    // SELECT * on purpose: this table has been ALTERed additively by four separate features and
    // naming a column that has not landed on some database turns a working lesson into an outage.
    lesson = rowsOf(await db.execute(sql`
      SELECT * FROM training_lessons WHERE id = ${lessonId}::uuid LIMIT 1`))[0] || null;
  } catch (e: any) {
    logFail('lessonObjects/lesson', e);
    return { ...empty, error: causeOf(e) };
  }
  if (!lesson) return { ...empty, ok: true, error: 'That lesson does not exist.' };

  let blocks: any[] = [];
  let blocksAbsent = false;
  try {
    blocks = rowsOf(await db.execute(sql`
      SELECT id, kind, position, content FROM training_lesson_blocks
       WHERE lesson_id = ${lessonId}::uuid
       ORDER BY position ASC, created_at ASC
       LIMIT 500`));
  } catch (e: any) {
    if (isMissingTable(e)) blocksAbsent = true;
    else logFail('lessonObjects/blocks', e);
  }

  let overlays: ObjectOverlay[] = [];
  try {
    overlays = rowsOf(await db.execute(sql`
      SELECT object_ref, object_type, title, source_kind, source_provider, delivery_mode,
             access_right, previewable, commercial_right, commercial_note, counts_for_completion
        FROM training_learning_objects
       WHERE lesson_id = ${lessonId}::uuid
       LIMIT 500`)).map((r: any) => ({
        ref: str(r.object_ref),
        type: isObjectType(r.object_type) ? r.object_type : null,
        title: r.title ? str(r.title) : null,
        sourceKind: r.source_kind ? str(r.source_kind) : null,
        provider: r.source_provider ? str(r.source_provider) : null,
        deliveryMode: r.delivery_mode ? str(r.delivery_mode) : null,
        accessRight: r.access_right ? str(r.access_right) : null,
        previewable: r.previewable === null || r.previewable === undefined ? null : r.previewable === true,
        commercial: r.commercial_right ? str(r.commercial_right) : null,
        commercialNote: r.commercial_note ? str(r.commercial_note) : null,
        countsForCompletion: r.counts_for_completion === null || r.counts_for_completion === undefined
          ? null : r.counts_for_completion === true,
      }));
  } catch (e: any) {
    // Absent means no facet has ever been recorded. The derived reading is the whole answer.
    if (!isMissingTable(e)) logFail('lessonObjects/overlay', e);
  }

  return {
    lessonId: str(lesson.id),
    courseId: str(lesson.course_id) || null,
    lessonTitle: clip(lesson.title, 200),
    objects: deriveLessonObjects(lesson, blocks, overlays),
    ok: true,
    blocksAbsent,
    error: null,
  };
}

/**
 * Record a facet against one object. The only write in this module.
 *
 * It writes NO CONTENT — an object's material stays where it was authored. What it stores is the
 * commercial right, the preview flag, whether the object counts toward completion, and the type when
 * a derived guess was wrong.
 *
 * NEVER SWALLOWED: the caller is told what failed, because a licence somebody believed they recorded
 * and which is not in the table is worse than one they know did not save.
 */
export async function setObjectFacets(input: {
  lessonId: string;
  objectRef: string;
  actorUserId?: string | null;
  type?: ObjectType | null;
  title?: string | null;
  previewable?: boolean | null;
  commercial?: string | null;
  commercialNote?: string | null;
  countsForCompletion?: boolean | null;
  sourceKind?: string | null;
  provider?: string | null;
  sourceLocator?: string | null;
  deliveryMode?: string | null;
  accessRight?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const lessonId = str(input?.lessonId);
  const ref = clip(input?.objectRef, 120);
  if (!isUuid(lessonId)) return { ok: false, error: 'That lesson does not exist.' };
  if (!ref) return { ok: false, error: 'That object does not exist.' };

  try {
    await ensureLearningObjectSchema();
    const actor = isUuid(input?.actorUserId) ? String(input.actorUserId) : null;
    await db.execute(sql`
      INSERT INTO training_learning_objects (
        lesson_id, object_ref, object_type, title, source_kind, source_provider, source_locator,
        delivery_mode, access_right, previewable, commercial_right, commercial_note,
        counts_for_completion, created_by_user_id)
      VALUES (
        ${lessonId}::uuid, ${ref},
        ${input.type && isObjectType(input.type) ? input.type : null},
        ${input.title === null || input.title === undefined ? null : clip(input.title, 200)},
        ${input.sourceKind ? String(contentSource(input.sourceKind)) : null},
        ${input.provider === null || input.provider === undefined ? null : clip(input.provider, 60)},
        ${input.sourceLocator === null || input.sourceLocator === undefined ? null : clip(input.sourceLocator, 2000)},
        ${input.deliveryMode ? String(delivery(input.deliveryMode)) : null},
        ${input.accessRight ? String(accessRight(input.accessRight)) : null},
        ${input.previewable === null || input.previewable === undefined ? null : input.previewable === true},
        ${input.commercial ? String(commercialRight(input.commercial)) : null},
        ${input.commercialNote === null || input.commercialNote === undefined ? null : clip(input.commercialNote, 500)},
        ${input.countsForCompletion === null || input.countsForCompletion === undefined ? null : input.countsForCompletion === true},
        ${actor}::uuid)
      ON CONFLICT (lesson_id, object_ref) DO UPDATE SET
        object_type = COALESCE(EXCLUDED.object_type, training_learning_objects.object_type),
        title = COALESCE(EXCLUDED.title, training_learning_objects.title),
        source_kind = COALESCE(EXCLUDED.source_kind, training_learning_objects.source_kind),
        source_provider = COALESCE(EXCLUDED.source_provider, training_learning_objects.source_provider),
        source_locator = COALESCE(EXCLUDED.source_locator, training_learning_objects.source_locator),
        delivery_mode = COALESCE(EXCLUDED.delivery_mode, training_learning_objects.delivery_mode),
        access_right = COALESCE(EXCLUDED.access_right, training_learning_objects.access_right),
        previewable = COALESCE(EXCLUDED.previewable, training_learning_objects.previewable),
        commercial_right = COALESCE(EXCLUDED.commercial_right, training_learning_objects.commercial_right),
        commercial_note = COALESCE(EXCLUDED.commercial_note, training_learning_objects.commercial_note),
        counts_for_completion = COALESCE(EXCLUDED.counts_for_completion, training_learning_objects.counts_for_completion),
        updated_at = NOW()`);
    return { ok: true };
  } catch (e: any) {
    logFail('setObjectFacets', e);
    return { ok: false, error: causeOf(e) || WRITE_FAILED };
  }
}
