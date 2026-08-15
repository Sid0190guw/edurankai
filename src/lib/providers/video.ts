// src/lib/providers/video.ts — VideoProviderInterface + the one video provider registry.
//
// A lesson's video arrives in one of three ways, and the founder has been explicit that ALL THREE
// are real: an embedded player, a link that opens elsewhere, and a genuine upload. (The
// no-uploads rule in this project governs DOCUMENTS, which stay as shared links. It has never
// governed video.) Each of those is a provider here, each declares what it can and cannot do, and
// a screen renders a control only for a capability it has ASKED for and been granted.
//
// WHAT THIS FILE IS NOT
// ---------------------
// It is NOT a second link validator. src/lib/video-embed.ts already parses a pasted address against
// an allowlist, extracts an id whose character set it constrains, and BUILDS the embed URL itself —
// the hardening that stopped a stored `javascript:` surviving into an iframe on two authenticated
// surfaces. The embed and link-out providers below DELEGATE to it. Duplicating that validator would
// be strictly worse than depending on it: two allowlists drift, and the one that drifts is the one
// a learner's browser executes.
//
// THE UNAVAILABLE-CAPABILITY RULE, IN THE FORM IT MATTERS MOST HERE
// ----------------------------------------------------------------
// This deployment has no media pipeline. Nothing re-encodes an uploaded file, nothing packages it
// into bitrate ladders, nothing extracts a frame for a thumbnail and nothing transcribes audio.
// A screen must therefore never offer a 1080p selector over one uploaded file: there is no 1080p
// version, and a selector that changes nothing teaches a learner that the platform is broken in a
// way they cannot describe. So `playback().qualities` is EMPTY unless a provider declares
// `multi_resolution`, and `renditions()` is refused rather than returning a fabricated list.
//
// BRAND NAMES
// -----------
// Learner-facing copy says "Watch lecture" and describes the KIND of link ("a public video platform
// link"), never whose. That brand-free description comes from video-embed.ts and is carried through
// unchanged. The admin labels here name the INTEGRATION SHAPE rather than a company, because one
// integration (the embed provider) covers an allowlist of many hosts — naming one of them would be
// less accurate, not more.
//
// No database. Storage access is the shared src/lib/storage.ts interface (S3-compatible first, so
// the core is not locked to one vendor); it is imported lazily inside upload() so that importing
// this module — or its test — opens no connection and touches no environment beyond what it reads.

import {
  AVAILABLE, can, cannot, createRegistry, deny, isRefusal, unavailable,
  type Provider, type Refusal,
} from './capability';
import { resolveStoredVideo, resolveVideoLink, videoColumnValues, type VideoLinkResult } from '@/lib/video-embed';

// ---------------------------------------------------------------------------------------------
// The questions every video provider answers
// ---------------------------------------------------------------------------------------------

export const VIDEO_CAPABILITIES = [
  'validate_link',
  'validate_upload',
  'play_in_page',
  'open_in_new_tab',
  'metadata_basic',
  'metadata_from_provider_api',
  'upload_original',
  'resumable_upload',
  'delete_stored_file',
  'transcode',
  'multi_resolution',
  'adaptive_bitrate',
  'generated_captions',
  'known_duration',
  'thumbnail',
] as const;
export type VideoCapabilityKey = typeof VIDEO_CAPABILITIES[number];

/** The only words a learner reads on a video control. Brand-free, and the same on every surface. */
export const LEARNER_VIDEO_LABEL = 'Watch lecture';
export const LEARNER_VIDEO_LABEL_NEW_TAB = 'Watch lecture';

/**
 * The sentence an admin screen prints beside an upload field, so nobody is surprised later. It is
 * the plain-language version of the four capabilities the native provider permanently withholds.
 */
export const NATIVE_PIPELINE_NOTE =
  'An uploaded lecture is stored and played back exactly as it arrived: one file, one quality, and ' +
  'no captions unless somebody writes them. This deployment has no encoder, so there is no 720p or ' +
  '1080p version to switch between and no automatic subtitles.';

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------

/** How a video reaches the learner's screen. */
export type VideoDelivery = 'iframe' | 'file' | 'new_tab';

/** What is stored about one lesson's video. Every field optional: rows predate every column here. */
export interface VideoRef {
  /** The address exactly as an author pasted it (training_lessons.video_url). */
  url?: string | null;
  /** The derived player address, when the database has that column (video_embed_url). */
  embedUrl?: string | null;
  /** embed | internal | file | link, as stored by src/lib/lesson-video.ts (video_link_kind). */
  linkKind?: string | null;
  /** Native upload: the object-storage key. */
  objectKey?: string | null;
  /** Native upload: the address the stored object is served from. */
  objectUrl?: string | null;
  contentType?: string | null;
  sizeBytes?: number | null;
}

/** A link or a file this provider will accept, with the columns a writer should persist. */
export interface VideoAccepted {
  ok: true;
  provider: string;
  delivery: VideoDelivery;
  /** Brand-free description of the KIND of source. Safe to print anywhere. */
  description: string;
  /**
   * The training_lessons columns for a link source, exactly as src/lib/lesson-video.ts writes them.
   * Null for an upload, which has no pasted address to store.
   */
  columns: ReturnType<typeof videoColumnValues> | null;
  /** Anything the author should know about what was accepted. Empty when there is nothing to add. */
  note: string;
}

/**
 * The input was not acceptable. Distinct from a capability Refusal: the provider CAN do this kind of
 * thing, this particular input just is not one. Kept apart so a screen can tell an author "fix your
 * link" without implying the integration is switched off.
 */
export interface VideoRejected {
  ok: false;
  rejected: 'input';
  provider: string;
  /** A complete sentence for the author. Never swallowed, never a code. */
  reason: string;
  /** True when the address is safe to OPEN even though we will not frame it. */
  canLinkOut: boolean;
  linkOutUrl: string | null;
}

export type VideoValidation = VideoAccepted | VideoRejected;

export function isRejected(x: unknown): x is VideoRejected {
  return !!x && typeof x === 'object' && (x as any).ok === false && (x as any).rejected === 'input';
}

/** Facts about a video. Every field here is either known or null — nothing is estimated. */
export interface VideoMetadata {
  ok: true;
  provider: string;
  /** Where these facts came from. 'provider_api' never appears in this deployment; see below. */
  source: 'derived_from_link' | 'stored_object';
  delivery: VideoDelivery;
  description: string;
  /** The id extracted from a recognised link, when the shape had one. */
  videoId: string | null;
  /** NULL, always, in this deployment. Reading a real duration needs the host's API or a demuxer. */
  durationMs: number | null;
  /** NULL for the same reason. A title invented from a URL slug is not a title. */
  title: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  /** One sentence naming what is NOT known, so a screen does not leave a blank field unexplained. */
  note: string;
}

export interface CaptionState {
  available: boolean;
  /** Why there are none. Present whenever `available` is false. */
  reason: string | null;
  tracks: { label: string; srcLang: string; src: string }[];
}

/** Everything a page needs to render the video, and nothing it must not render. */
export interface VideoPlayback {
  ok: true;
  provider: string;
  delivery: VideoDelivery;
  /** For an iframe this was BUILT by video-embed.ts from an extracted id, never pasted through. */
  src: string;
  sandbox: string;
  allow: string;
  referrerPolicy: string;
  /** Learner-facing. Brand-free by construction. */
  actionLabel: string;
  description: string;
  /**
   * Qualities the learner may CHOOSE BETWEEN. EMPTY unless the provider declares `multi_resolution`.
   * A screen renders a selector only when this holds more than one entry — never because a video is
   * playing. One file is one quality.
   */
  qualities: { label: string; src: string }[];
  captions: CaptionState;
  /** True only when a provider declares it. Nothing here offers a download of somebody else's file. */
  downloadable: boolean;
  /** A sentence for the learner when the delivery needs one (a new tab, for instance). */
  note: string;
}

export interface VideoUploadInput {
  data: Uint8Array | ArrayBuffer | string | Blob;
  fileName: string;
  contentType: string;
  sizeBytes?: number;
  /** What the file belongs to (a lesson id, usually). Used only to build a storage key. */
  ownerRef: string;
}

export interface VideoUploaded {
  ok: true;
  provider: string;
  key: string;
  url: string;
  contentType: string;
  sizeBytes: number | null;
  /** Says plainly what was and was not done to the file. */
  note: string;
}

/** The interface. Every provider implements all of it; capability declarations decide the answers. */
export interface VideoProvider extends Provider {
  kind: 'embed' | 'link' | 'native';
  /** Is this pasted address / uploaded file something this provider will take? */
  validate(input: { url?: string | null; upload?: Omit<VideoUploadInput, 'data'> | null; allowLinkOut?: boolean }): VideoValidation | Refusal;
  /** Facts, where the provider is allowed to have them. Refused when it cannot know. */
  metadata(ref: VideoRef): VideoMetadata | Refusal;
  /** What the page should render. Refused when this provider cannot play what it was handed. */
  playback(ref: VideoRef): VideoPlayback | VideoRejected | Refusal;
  /** The alternative renditions. Refused everywhere in this deployment: there are none. */
  renditions(ref: VideoRef): { label: string; src: string }[] | Refusal;
  /** Store an original. Refused unless the provider declares `upload_original`. */
  upload(input: VideoUploadInput): Promise<VideoUploaded | VideoRejected | Refusal>;
  /** Remove a stored original. Refused wherever the file is not ours to delete. */
  remove(ref: VideoRef): Promise<{ ok: true } | Refusal>;
}

// ---------------------------------------------------------------------------------------------
// Shared refusal sentences (identical facts get identical words)
// ---------------------------------------------------------------------------------------------

const NO_PIPELINE_TRANSCODE =
  'Nothing in this deployment re-encodes a video. The file is served exactly as it was published, ' +
  'so there is no second version for this platform to make.';
const NO_PIPELINE_RESOLUTIONS =
  'Only one version of this video exists as far as this platform is concerned, so no screen may ' +
  'offer a choice of resolutions over it. A selector that changed nothing would be worse than none.';
const NO_PIPELINE_ABR =
  'Adaptive streaming needs a segmented multi-bitrate rendition set and a packager to build it. ' +
  'Neither exists in this deployment, so playback is a single stream at whatever the source is.';
const NO_CAPTION_ENGINE =
  'No speech recognition runs on this server, so captions are never generated here. An automatic ' +
  'transcript presented as accurate would be worse than none, particularly for a learner who ' +
  'depends on it.';
const NO_THUMBNAIL =
  'Producing a still image from a video needs a frame extractor, which this deployment does not ' +
  'have. Any picture shown beside a lesson is one somebody chose, not one taken from the video.';

// ---------------------------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------------------------

export const videoProviders = createRegistry<VideoProvider>('video', VIDEO_CAPABILITIES);

// ---------------------------------------------------------------------------------------------
// 1. The embed provider — plays inside the lesson, delegating every URL decision to video-embed.ts
// ---------------------------------------------------------------------------------------------

function linkKindToDelivery(kind: string): VideoDelivery {
  if (kind === 'link') return 'new_tab';
  if (kind === 'file') return 'file';
  return 'iframe';   // 'embed' and 'internal' both render framed
}

function linkMetadata(providerId: string, r: VideoLinkResult): VideoMetadata | VideoRejected {
  if (!r.ok) {
    return { ok: false, rejected: 'input', provider: providerId, reason: r.reason, canLinkOut: r.canLinkOut, linkOutUrl: r.linkOutUrl };
  }
  return {
    ok: true,
    provider: providerId,
    source: 'derived_from_link',
    delivery: linkKindToDelivery(r.kind),
    description: r.description,
    videoId: r.videoId,
    durationMs: null,
    title: null,
    contentType: null,
    sizeBytes: null,
    note: 'The length, the title and the picture belong to whoever published this video. This ' +
      'server does not ask them for it, so those are shown as unknown rather than guessed.',
  };
}

function embedVideoProvider(): VideoProvider {
  const id = 'embed_link';
  const self: VideoProvider = {
    id,
    kind: 'embed',
    adminLabel: 'Embedded video link',
    adminNote:
      'An address pasted from a video page, played inside the lesson in a sandboxed frame this ' +
      'platform builds itself from the recognised video id.',
    availability: AVAILABLE,
    capabilities: [
      can('validate_link', 'Check a pasted address before it is stored'),
      cannot('validate_upload', 'Accept an uploaded file',
        'This integration takes an address, not a file. An upload goes to the direct-upload integration instead.'),
      can('play_in_page', 'Play inside the lesson'),
      can('open_in_new_tab', 'Open the source in a new tab'),
      can('metadata_basic', 'Report what kind of link this is'),
      cannot('metadata_from_provider_api', 'Read the title and length from the host',
        'Reading a title, a length or a picture from the host means calling that host with ' +
        'credentials, and none are configured on this server. Nothing here invents those values.'),
      cannot('upload_original', 'Store the original file',
        'This kind of link points at a file somebody else already hosts, so there is nothing for ' +
        'this platform to store.'),
      cannot('resumable_upload', 'Resume an interrupted upload',
        'There is no upload in this integration at all, so there is nothing to resume.'),
      cannot('delete_stored_file', 'Delete the stored file',
        'The file lives wherever the link points. Removing the lesson removes the link; nothing ' +
        'here can delete a copy somebody else holds, and pretending otherwise would leave a ' +
        'publisher believing their video had been taken down.'),
      cannot('transcode', 'Re-encode the video', NO_PIPELINE_TRANSCODE),
      cannot('multi_resolution', 'Offer a choice of resolutions',
        'The player on the other end offers whatever qualities its host prepared, and this ' +
        'platform is not told what those are. It will not present a resolution list of its own.'),
      cannot('adaptive_bitrate', 'Adapt the stream to the connection', NO_PIPELINE_ABR),
      cannot('generated_captions', 'Generate captions', NO_CAPTION_ENGINE),
      cannot('known_duration', 'Know how long the video is',
        'The length is known only to the host, and is not read here. Any figure shown would be a guess.'),
      cannot('thumbnail', 'Take a picture from the video', NO_THUMBNAIL),
    ],

    validate(input) {
      const no = deny(self, 'validate_link');
      if (no) return no;
      const r = resolveVideoLink(input.url, { allowLinkOut: false });
      if (!r.ok) {
        return { ok: false, rejected: 'input', provider: id, reason: r.reason, canLinkOut: r.canLinkOut, linkOutUrl: r.linkOutUrl };
      }
      if (r.kind === 'link') {
        // resolveVideoLink only returns 'link' when link-out was asked for, which this provider
        // never does. Defensive: a future change there must not silently turn a framed lesson into
        // a link this provider claims to play.
        return {
          ok: false, rejected: 'input', provider: id,
          reason: 'That address cannot be played inside the lesson. Save it as a link that opens elsewhere instead.',
          canLinkOut: true, linkOutUrl: r.embedUrl,
        };
      }
      return {
        ok: true, provider: id, delivery: linkKindToDelivery(r.kind), description: r.description,
        columns: videoColumnValues(r), note: '',
      };
    },

    metadata(ref) {
      const no = deny(self, 'metadata_basic');
      if (no) return no;
      const r = resolveStoredVideo(ref.url, ref.embedUrl, ref.linkKind);
      const m = linkMetadata(id, r);
      if (!m.ok) {
        // A stored row we can no longer resolve is not a capability failure; it is a bad row, and
        // the caller gets the sentence that says which one.
        return {
          ok: false, refused: 'capability', provider: id, capability: 'metadata_basic', undeclared: false,
          reason: m.reason,
        };
      }
      return m;
    },

    playback(ref) {
      const no = deny(self, 'play_in_page');
      if (no) return no;
      const r = resolveStoredVideo(ref.url, ref.embedUrl, ref.linkKind);
      if (!r.ok) {
        return { ok: false, rejected: 'input', provider: id, reason: r.reason, canLinkOut: r.canLinkOut, linkOutUrl: r.linkOutUrl };
      }
      return {
        ok: true,
        provider: id,
        delivery: linkKindToDelivery(r.kind),
        src: r.embedUrl,
        sandbox: r.sandbox,
        allow: r.allow,
        referrerPolicy: r.referrerPolicy,
        actionLabel: LEARNER_VIDEO_LABEL,
        description: r.description,
        qualities: [],            // never populated: `multi_resolution` is not declared here
        captions: { available: false, reason: NO_CAPTION_ENGINE, tracks: [] },
        downloadable: false,
        note: '',
      };
    },

    renditions() {
      // Always a refusal — the capability is declared unavailable, so this can never return a list.
      return deny(self, 'multi_resolution') as Refusal;
    },

    async upload() { return deny(self, 'upload_original') as Refusal; },
    async remove() { return deny(self, 'delete_stored_file') as Refusal; },
  };
  return self;
}

// ---------------------------------------------------------------------------------------------
// 2. The link-out provider — an honest button, for everything we will not frame
// ---------------------------------------------------------------------------------------------

function linkOutVideoProvider(): VideoProvider {
  const id = 'link_out';
  const self: VideoProvider = {
    id,
    kind: 'link',
    adminLabel: 'Link that opens elsewhere',
    adminNote:
      'A secure address that is not framed inside the lesson. The learner gets a button that opens ' +
      'it in a new tab, which is the honest rendering of a page we do not control.',
    availability: AVAILABLE,
    capabilities: [
      can('validate_link', 'Check a pasted address before it is stored'),
      cannot('validate_upload', 'Accept an uploaded file',
        'This integration takes an address, not a file. An upload goes to the direct-upload integration instead.'),
      cannot('play_in_page', 'Play inside the lesson',
        'This address was saved as one that opens elsewhere. Either its host refuses to be framed ' +
        'or the author chose to send people to it, and framing it anyway would break for the learner.'),
      can('open_in_new_tab', 'Open the source in a new tab'),
      can('metadata_basic', 'Report what kind of link this is'),
      cannot('metadata_from_provider_api', 'Read the title and length from the host',
        'Nothing on this server calls the host of a pasted link, so its title and length are not ' +
        'known here and are shown as unknown rather than guessed.'),
      cannot('upload_original', 'Store the original file',
        'This integration holds an address. There is no file here for this platform to store.'),
      cannot('resumable_upload', 'Resume an interrupted upload',
        'There is no upload in this integration at all, so there is nothing to resume.'),
      cannot('delete_stored_file', 'Delete the stored file',
        'The page on the other end of this link is not ours. Removing the lesson removes the link ' +
        'and nothing else.'),
      cannot('transcode', 'Re-encode the video', NO_PIPELINE_TRANSCODE),
      cannot('multi_resolution', 'Offer a choice of resolutions', NO_PIPELINE_RESOLUTIONS),
      cannot('adaptive_bitrate', 'Adapt the stream to the connection', NO_PIPELINE_ABR),
      cannot('generated_captions', 'Generate captions', NO_CAPTION_ENGINE),
      cannot('known_duration', 'Know how long the video is',
        'The length lives on a page this platform never opens, so it is not known here.'),
      cannot('thumbnail', 'Take a picture from the video', NO_THUMBNAIL),
    ],

    validate(input) {
      const no = deny(self, 'validate_link');
      if (no) return no;
      const r = resolveVideoLink(input.url, { allowLinkOut: true });
      if (!r.ok) {
        return { ok: false, rejected: 'input', provider: id, reason: r.reason, canLinkOut: r.canLinkOut, linkOutUrl: r.linkOutUrl };
      }
      return {
        ok: true, provider: id, delivery: 'new_tab', description: r.description,
        columns: { ...videoColumnValues(r), video_link_kind: 'link' },
        note: 'Learners get a button that opens this in a new tab, because it is not played inside the lesson.',
      };
    },

    metadata(ref) {
      const no = deny(self, 'metadata_basic');
      if (no) return no;
      const r = resolveStoredVideo(ref.url, ref.embedUrl, 'link');
      const m = linkMetadata(id, r);
      if (!m.ok) {
        return {
          ok: false, refused: 'capability', provider: id, capability: 'metadata_basic', undeclared: false,
          reason: m.reason,
        };
      }
      return { ...m, delivery: 'new_tab' };
    },

    playback(ref) {
      const no = deny(self, 'open_in_new_tab');
      if (no) return no;
      const r = resolveStoredVideo(ref.url, ref.embedUrl, 'link');
      if (!r.ok) {
        return { ok: false, rejected: 'input', provider: id, reason: r.reason, canLinkOut: r.canLinkOut, linkOutUrl: r.linkOutUrl };
      }
      return {
        ok: true,
        provider: id,
        delivery: 'new_tab',
        src: r.embedUrl,
        sandbox: '',
        allow: '',
        referrerPolicy: r.referrerPolicy,
        actionLabel: LEARNER_VIDEO_LABEL_NEW_TAB,
        description: r.description,
        qualities: [],
        captions: { available: false, reason: NO_CAPTION_ENGINE, tracks: [] },
        downloadable: false,
        note: 'This opens in a new tab.',
      };
    },

    renditions() { return deny(self, 'multi_resolution') as Refusal; },
    async upload() { return deny(self, 'upload_original') as Refusal; },
    async remove() { return deny(self, 'delete_stored_file') as Refusal; },
  };
  return self;
}

// ---------------------------------------------------------------------------------------------
// 3. The native provider — a real upload, and an honest account of what happens to it afterwards
// ---------------------------------------------------------------------------------------------

/** Container types this deployment will store. A file it cannot play back is not accepted. */
export const ACCEPTED_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'] as const;

/**
 * The ceiling on a file that arrives through a request body. It is small because a serverless
 * request body is small — this is not a guess about what a lecture weighs.
 *
 * THE GAP THIS COMMENT USED TO DESCRIBE IS CLOSED, AND THIS FILE IS NOT THE THING THAT CLOSED IT.
 * src/lib/storage.ts now exposes presignedUpload(), and POST /api/aquintutor/lms/upload-url mints
 * one so the browser uploads straight to storage — the 4 MB below does not apply on that path and
 * the working limit there is 5 GB. Nothing imports this module (a repo-wide search for
 * 'providers/video' finds only this file), so the number is inert; it is left with this note rather
 * than quietly raised, because two upload contracts in one tree is how the wrong one gets used.
 */
export const MAX_INLINE_UPLOAD_BYTES = 4 * 1024 * 1024;

function storageIsProvisioned(): boolean {
  // Read the same environment variables src/lib/storage.ts reads, WITHOUT importing it here: this
  // module must stay importable (and testable) without pulling in the blob adapters.
  const s3 = !!(process.env.S3_ENDPOINT && process.env.S3_BUCKET && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY);
  return s3 || !!process.env.BLOB_READ_WRITE_TOKEN;
}

const NO_OBJECT_STORE =
  'Uploading a lecture is switched off on this server because no object store is configured for ' +
  'it. There is nowhere to put the file, so nothing is accepted — rather than a file being ' +
  'taken and quietly lost. An administrator switches it on by configuring S3-compatible storage, ' +
  'which can be a self-hosted one.';

function nativeVideoProvider(): VideoProvider {
  const id = 'native_upload';
  const provisioned = storageIsProvisioned();
  const self: VideoProvider = {
    id,
    kind: 'native',
    adminLabel: 'Direct upload to storage this platform owns',
    adminNote:
      'The lecture file is stored in the object storage configured for this deployment and played ' +
      'back from there. ' + NATIVE_PIPELINE_NOTE,
    availability: provisioned ? AVAILABLE : unavailable(NO_OBJECT_STORE),
    capabilities: [
      cannot('validate_link', 'Check a pasted address before it is stored',
        'This integration takes a file, not an address. A pasted link goes to one of the link ' +
        'integrations instead.'),
      can('validate_upload', 'Check an uploaded file before it is stored'),
      can('play_in_page', 'Play inside the lesson'),
      can('open_in_new_tab', 'Open the stored file in a new tab'),
      can('metadata_basic', 'Report the file type and size that were stored'),
      cannot('metadata_from_provider_api', 'Read the title and length from the host',
        'There is no host to ask. The file sits in the object storage configured here, and what is ' +
        'known about it is exactly what was recorded when it was uploaded.'),
      can('upload_original', 'Store the original file'),
      cannot('resumable_upload', 'Resume an interrupted upload',
        'An upload here travels through a request body, which is capped well below the size of a ' +
        'full lecture, and the storage interface exposes no presigned upload for the browser to ' +
        'send to directly. A large file must be placed in the object store by an operator until ' +
        'that is built.'),
      cannot('delete_stored_file', 'Delete the stored file',
        'The storage interface in this deployment can write an object and address it, but has no ' +
        'delete operation. Removing a lesson therefore does not remove the file it stored; an ' +
        'operator has to remove it in the object store itself.'),
      cannot('transcode', 'Re-encode the video',
        'Nothing in this deployment re-encodes an uploaded file. It is played back exactly as it ' +
        'arrived, so a phone on a slow connection is sent the same file as a desktop.'),
      cannot('multi_resolution', 'Offer a choice of resolutions',
        'Only the original file is stored. There is no 720p or 1080p version to switch to, so no ' +
        'screen may offer a quality selector over it.'),
      cannot('adaptive_bitrate', 'Adapt the stream to the connection', NO_PIPELINE_ABR),
      cannot('generated_captions', 'Generate captions', NO_CAPTION_ENGINE),
      cannot('known_duration', 'Know how long the video is',
        'The length is inside the container of the file itself, which nothing here reads. It is not ' +
        'recorded at upload, so it is not shown.'),
      cannot('thumbnail', 'Take a picture from the video', NO_THUMBNAIL),
    ],

    validate(input) {
      const no = deny(self, 'validate_upload');
      if (no) return no;
      const up = input.upload;
      if (!up) {
        return {
          ok: false, rejected: 'input', provider: id,
          reason: 'No file was given, so there is nothing to store.',
          canLinkOut: false, linkOutUrl: null,
        };
      }
      const type = String(up.contentType || '').toLowerCase().split(';')[0].trim();
      if (!(ACCEPTED_VIDEO_TYPES as readonly string[]).includes(type)) {
        return {
          ok: false, rejected: 'input', provider: id,
          reason: 'That file is a "' + (type || 'unknown type') + '", which this platform cannot play back. ' +
            'Upload one of: ' + ACCEPTED_VIDEO_TYPES.join(', ') + '.',
          canLinkOut: false, linkOutUrl: null,
        };
      }
      const size = Number(up.sizeBytes || 0);
      if (size > MAX_INLINE_UPLOAD_BYTES) {
        return {
          ok: false, rejected: 'input', provider: id,
          reason: 'That file is larger than this server accepts in one upload (' +
            Math.round(MAX_INLINE_UPLOAD_BYTES / (1024 * 1024)) + ' MB). Nothing was stored. A ' +
            'full-length lecture needs an operator to place it in the object store, or a link to ' +
            'where it is already hosted.',
          canLinkOut: false, linkOutUrl: null,
        };
      }
      return {
        ok: true, provider: id, delivery: 'file', description: 'a file stored on this platform',
        columns: null, note: NATIVE_PIPELINE_NOTE,
      };
    },

    metadata(ref) {
      const no = deny(self, 'metadata_basic');
      if (no) return no;
      if (!ref.objectKey && !ref.objectUrl) {
        return {
          ok: false, refused: 'capability', provider: id, capability: 'metadata_basic', undeclared: false,
          reason: 'This lesson has no uploaded file recorded against it, so there is nothing to describe.',
        };
      }
      return {
        ok: true,
        provider: id,
        source: 'stored_object',
        delivery: 'file',
        description: 'a file stored on this platform',
        videoId: ref.objectKey || null,
        durationMs: null,
        title: null,
        contentType: ref.contentType || null,
        sizeBytes: ref.sizeBytes == null ? null : Number(ref.sizeBytes),
        note: 'The type and size are what was recorded at upload. The length is not read from the ' +
          'file, so it is shown as unknown rather than guessed.',
      };
    },

    playback(ref) {
      const no = deny(self, 'play_in_page');
      if (no) return no;
      const src = String(ref.objectUrl || '').trim();
      if (!src) {
        return {
          ok: false, rejected: 'input', provider: id,
          reason: 'This lesson has no stored file to play. Nothing was uploaded, or the upload did not finish.',
          canLinkOut: false, linkOutUrl: null,
        };
      }
      return {
        ok: true,
        provider: id,
        delivery: 'file',
        src,
        // A <video> element has no script context, so the frame hardening does not apply; the
        // fields stay on the shape so every caller reads one structure.
        sandbox: '',
        allow: '',
        referrerPolicy: 'same-origin',
        actionLabel: LEARNER_VIDEO_LABEL,
        description: 'a file stored on this platform',
        qualities: [],           // ONE FILE IS ONE QUALITY. See NATIVE_PIPELINE_NOTE.
        captions: { available: false, reason: NO_CAPTION_ENGINE, tracks: [] },
        downloadable: false,
        note: '',
      };
    },

    renditions() { return deny(self, 'multi_resolution') as Refusal; },

    async upload(input) {
      const no = deny(self, 'upload_original');
      if (no) return no;
      const check = self.validate({ upload: { fileName: input.fileName, contentType: input.contentType, sizeBytes: input.sizeBytes, ownerRef: input.ownerRef } });
      if (isRefusal(check)) return check;
      if (!check.ok) return check;

      // Lazy import: this module stays importable, and its test runnable, without loading the
      // storage adapters or reading their environment.
      const { getStore, storageKey } = await import('@/lib/storage');
      const store = getStore();
      const ext = (String(input.contentType).split('/')[1] || 'mp4').replace(/[^a-z0-9]/gi, '');
      const key = storageKey('lecture-video', input.ownerRef, ext);
      let stored: { url: string; key: string } | null = null;
      try {
        stored = await store.put(key, input.data as any, input.contentType);
      } catch (e: any) {
        // NEVER SWALLOWED. A write path that fails silently is how a lesson ends up pointing at a
        // file that was never stored.
        console.error('[providers/video] upload failed for', input.ownerRef, '-', e?.cause?.message || e?.message);
        return {
          ok: false, rejected: 'input', provider: id,
          reason: 'The file could not be stored (' + String(e?.cause?.message || e?.message || 'unknown reason').slice(0, 140) +
            '). Nothing has been attached to this lesson.',
          canLinkOut: false, linkOutUrl: null,
        };
      }
      if (!stored) {
        return {
          ok: false, rejected: 'input', provider: id,
          reason: 'The object store refused the file and gave no address back, so nothing has been ' +
            'attached to this lesson. This is usually a storage credential that is missing or expired.',
          canLinkOut: false, linkOutUrl: null,
        };
      }
      return {
        ok: true,
        provider: id,
        key: stored.key,
        url: stored.url,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes == null ? null : Number(input.sizeBytes),
        note: NATIVE_PIPELINE_NOTE,
      };
    },

    async remove() { return deny(self, 'delete_stored_file') as Refusal; },
  };
  return self;
}

videoProviders.register('embed_link', embedVideoProvider);
videoProviders.register('link_out', linkOutVideoProvider);
// REGISTERED EVEN WHEN IT IS UNAVAILABLE. A provider that vanished from the list when storage was
// unconfigured would leave an admin screen with no way to say WHY uploading is not on offer, and
// the honest sentence is the whole point.
videoProviders.register('native_upload', nativeVideoProvider);

// ---------------------------------------------------------------------------------------------
// Choosing, without assuming
// ---------------------------------------------------------------------------------------------

/**
 * Which provider owns this stored video? Decided by what was stored, never by a default:
 * an object key means the file is ours; a link kind of 'link' means it opens elsewhere; anything
 * else is a link we frame.
 */
export function providerForStored(ref: VideoRef): VideoProvider | null {
  if (ref?.objectKey || ref?.objectUrl) return videoProviders.get('native_upload');
  if (String(ref?.linkKind || '') === 'link') return videoProviders.get('link_out');
  if (ref?.url || ref?.embedUrl) return videoProviders.get('embed_link');
  return null;
}

/** The one call a lesson page makes. A Refusal here is a sentence to render, not an exception. */
export function playbackFor(ref: VideoRef): VideoPlayback | VideoRejected | Refusal {
  const p = providerForStored(ref);
  if (!p) {
    return {
      ok: false, refused: 'provider', provider: 'video', capability: 'play_in_page', undeclared: false,
      reason: 'This lesson has no video attached to it yet.',
    };
  }
  return p.playback(ref);
}
