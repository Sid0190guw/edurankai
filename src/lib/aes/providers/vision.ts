// src/lib/aes/providers/vision.ts — VisionModelProvider (spec sections 5, 41, 42).
//
// Section 5 says the teacher must not have to abandon a blackboard, a notebook or a marker. That
// makes sight a first-class AES capability rather than a novelty: AES has to be able to look at a
// real board and turn it into structure. This repository already does that deterministically —
// public/aquin-board-vision.js computes a rectifying homography from four board corners, judges
// lighting from real brightness statistics, differences a frame against the calibration baseline,
// and chains the changed cells into normalised polylines. It emits VECTORS, never pixels.
//
// So the real provider here needs no model at all, and that is worth saying out loud in the
// console: the part of AES that can see is fully live today, and it is deterministic.
//
// WHAT THIS PROVIDER REFUSES TO DO, permanently and by design:
//   - It does not read handwriting into text. `vision.text` is DECLARED by the interface and
//     supported by nobody, so a caller that wants it is refused with a reason instead of handed a
//     confident guess at what a teacher wrote.
//   - It does not identify a person, a face or a body. AES looks at a board.
//   - It does not emit pixels, frames or video. Only structure leaves this provider.
//   - Its gesture reading is ADVISORY. A circle or an underline is a suggestion for a human to
//     confirm; nothing acts on it automatically.

import { loadEngine } from './engine-loader';
import {
  BaseProvider, NullProvider, available, unavailable, unsupportedAll,
  type AesProvider, type AesResult, type CapabilityDecl, type Health, type ProviderDescriptor,
} from './types';

export type Point = [number, number];
export type Stroke = Point[];
export type GrayFrame = ArrayLike<number>;

export interface CalibrateRequest { corners: Point[]; target?: Point[] }
export interface CalibrateValue { homography: number[]; worstCornerError: number }

export interface LightingRequest { frame: GrayFrame }
export interface LightingValue { level: string; score: number; reason: string; mean: number; stddev: number }

export interface StrokesRequest {
  baseline: GrayFrame; current: GrayFrame; width: number; height: number;
  threshold?: number; cell?: number; maxGap?: number; maxPoints?: number;
}
export interface StrokesValue {
  strokes: Stroke[];
  polarity: string;
  changedRatio: number;
  confidence: { value: number; usable: boolean; reason: string };
  lighting: LightingValue;
}

export interface GestureRequest { strokes: Stroke[] }
export interface GestureValue {
  kind: string; confidence: number; centroid: Point | null; bbox: any; reason: string;
  /** Always true. A human decides what this means; nothing downstream may act on it alone. */
  advisory: true;
}

export interface VisionModelProvider extends AesProvider {
  calibrate(req: CalibrateRequest): Promise<AesResult<CalibrateValue>>;
  lighting(req: LightingRequest): Promise<AesResult<LightingValue>>;
  strokes(req: StrokesRequest): Promise<AesResult<StrokesValue>>;
  gesture(req: GestureRequest): Promise<AesResult<GestureValue>>;
  /** Declared by the interface, implemented by nobody. Kept here so the refusal is explicit. */
  text(req: { frame: GrayFrame; width: number; height: number }): Promise<AesResult<{ text: string }>>;
}

export const VISION_CAPABILITIES: { id: string; summary: string; determinism: 'deterministic' }[] = [
  { id: 'vision.calibrate', summary: 'Turn four board corners in a camera frame into a rectifying homography.', determinism: 'deterministic' },
  { id: 'vision.lighting', summary: 'Judge whether the light on the board is good enough to work with, and say why when it is not.', determinism: 'deterministic' },
  { id: 'vision.strokes', summary: 'Difference a frame against the calibration baseline and return new marker strokes as normalised vectors.', determinism: 'deterministic' },
  { id: 'vision.gesture', summary: 'Read a circle, an underline or general marks from strokes — advisory only, for a human to confirm.', determinism: 'deterministic' },
  { id: 'vision.text', summary: 'Read handwriting on the board into text.', determinism: 'deterministic' },
];

const NO_TEXT_READING =
  'AES does not read handwriting into text. A confident transcription of what a teacher wrote is exactly the kind of guess that ends up on a student screen uncorrected, so the capability is refused rather than approximated.';

const CANNOT = [
  'Read handwriting or any text on the board.',
  'Identify a person, a face or a body. AES looks at a board, not at people.',
  'Emit pixels, frames or video. Only vectors and statistics leave this provider.',
  'Decide anything on its own. Gesture reading is advisory; a human confirms it.',
];

const ASSET = 'public/aquin-board-vision.js';
const GLOBAL = 'AquinVision';

/** A frame larger than this is refused rather than silently downsampled. */
export const MAX_PIXELS = 1920 * 1080;

// ---------------------------------------------------------------- null (honest about doing nothing)

export class NullVisionProvider extends NullProvider implements VisionModelProvider {
  readonly descriptor: ProviderDescriptor;

  constructor(reason = 'No vision engine is registered for this deployment.',
              remedy = 'Register a vision provider before offering board capture on a teaching surface.') {
    super(reason, remedy);
    this.descriptor = {
      id: 'vision.null',
      kind: 'vision',
      title: 'No board vision',
      does: 'Nothing. Board capture is refused with a reason, so a teacher is told the camera path is unavailable instead of watching it appear to work.',
      cannot: ['Anything at all. Every call is refused, with the reason above.'],
      requires: ['a registered vision engine'],
      capabilities: unsupportedAll(VISION_CAPABILITIES, reason),
    };
  }

  calibrate(_r: CalibrateRequest) { return this.guarded('vision.calibrate', () => { throw new Error('unreachable'); }) as Promise<AesResult<CalibrateValue>>; }
  lighting(_r: LightingRequest) { return this.guarded('vision.lighting', () => { throw new Error('unreachable'); }) as Promise<AesResult<LightingValue>>; }
  strokes(_r: StrokesRequest) { return this.guarded('vision.strokes', () => { throw new Error('unreachable'); }) as Promise<AesResult<StrokesValue>>; }
  gesture(_r: GestureRequest) { return this.guarded('vision.gesture', () => { throw new Error('unreachable'); }) as Promise<AesResult<GestureValue>>; }
  text(_r: { frame: GrayFrame; width: number; height: number }) { return this.guarded('vision.text', () => { throw new Error('unreachable'); }) as Promise<AesResult<{ text: string }>>; }
}

// ------------------------------------------------------------------------------------- the real one

export class BoardVisionProvider extends BaseProvider implements VisionModelProvider {
  readonly descriptor: ProviderDescriptor;
  private engine: any = null;
  private loadReason = '';

  constructor(private readonly assetPath: string = ASSET) {
    super();
    const caps: CapabilityDecl[] = VISION_CAPABILITIES.map((c) =>
      c.id === 'vision.text'
        ? { ...c, supported: false, reason: NO_TEXT_READING }
        : { ...c, supported: true });
    this.descriptor = {
      id: 'vision.board',
      kind: 'vision',
      title: 'Physical board vision',
      does: 'Watches a real blackboard or whiteboard and derives structure from it — a rectifying homography, an honest lighting judgement, and new marker strokes as normalised vectors. No model is involved; the arithmetic is exact and runs the same everywhere.',
      cannot: CANNOT,
      requires: [],
      capabilities: caps,
    };
  }

  private async load(): Promise<any> {
    if (this.engine) return this.engine;
    const r = await loadEngine(this.assetPath, GLOBAL);
    this.loadReason = r.reason;
    this.engine = r.ok ? r.api : null;
    return this.engine;
  }

  async health(): Promise<Health> {
    const e = await this.load();
    if (!e) {
      return unavailable(
        'The board vision engine is not loadable in this runtime, so camera capture cannot be offered here. ' + this.loadReason,
        'Serve AES from a runtime that can read the application engine files, or register a different vision provider.',
      );
    }
    return available('Board vision is loaded and deriving structure from camera frames. No model is involved. ' + this.loadReason);
  }

  async calibrate(req: CalibrateRequest): Promise<AesResult<CalibrateValue>> {
    return this.guarded('vision.calibrate', async () => {
      const V = await this.load();
      const target: Point[] = req.target || [[0, 0], [1, 0], [1, 1], [0, 1]];
      if (!Array.isArray(req.corners) || req.corners.length !== 4) {
        throw new Error('calibration needs exactly four board corners, in order; ' + (req.corners ? req.corners.length : 0) + ' were given');
      }
      const H = V.computeHomography(req.corners, target);
      if (!H) throw new Error('those four corners are degenerate — they do not describe a board quadrilateral');
      let worst = 0;
      for (let i = 0; i < 4; i++) {
        const p = V.applyHomography(H, req.corners[i]);
        worst = Math.max(worst, Math.abs(p[0] - target[i][0]), Math.abs(p[1] - target[i][1]));
      }
      return { homography: H, worstCornerError: worst };
    });
  }

  async lighting(req: LightingRequest): Promise<AesResult<LightingValue>> {
    return this.guarded('vision.lighting', async () => {
      const V = await this.load();
      const stats = V.brightnessStats(req.frame);
      const q = V.lightingQuality(stats);
      return { level: q.level, score: q.score, reason: q.reason, mean: stats.mean, stddev: stats.stddev };
    });
  }

  async strokes(req: StrokesRequest): Promise<AesResult<StrokesValue>> {
    return this.guarded('vision.strokes', async () => {
      const V = await this.load();
      const px = req.width * req.height;
      if (!Number.isFinite(px) || px <= 0) throw new Error('the frame dimensions do not describe an image');
      if (px > MAX_PIXELS) {
        throw new Error('the frame is ' + req.width + 'x' + req.height + ' and this provider accepts up to ' + MAX_PIXELS + ' pixels; capture at a smaller size rather than accepting a silently reduced result');
      }
      if (req.baseline.length !== req.current.length) throw new Error('the baseline and the current frame are different sizes, so nothing can be compared');

      const stats = V.brightnessStats(req.current);
      const light = V.lightingQuality(stats);
      const diff = V.diffMask(req.baseline, req.current, req.threshold || 40);
      const strokes = V.maskToStrokes(diff.indices, req.width, req.height, {
        cell: req.cell || 8, maxGap: req.maxGap || 0.06, maxPoints: req.maxPoints || 400,
      });
      const conf = V.captureConfidence(light, diff.changedRatio);
      return {
        strokes,
        polarity: diff.polarity,
        changedRatio: diff.changedRatio,
        confidence: conf,
        lighting: { level: light.level, score: light.score, reason: light.reason, mean: stats.mean, stddev: stats.stddev },
      };
    });
  }

  async gesture(req: GestureRequest): Promise<AesResult<GestureValue>> {
    return this.guarded('vision.gesture', async () => {
      const V = await this.load();
      const g = V.recognizeStrokes(req.strokes || []);
      return { kind: g.kind, confidence: g.confidence, centroid: g.centroid, bbox: g.bbox, reason: g.reason, advisory: true as const };
    });
  }

  /** Declared by the interface, supported by nobody. The guard refuses it with NO_TEXT_READING. */
  async text(_req: { frame: GrayFrame; width: number; height: number }): Promise<AesResult<{ text: string }>> {
    return this.guarded('vision.text', () => { throw new Error('unreachable'); }) as Promise<AesResult<{ text: string }>>;
  }
}
