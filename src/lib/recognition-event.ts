// src/lib/recognition-event.ts — Block 07: the single browser→server capture contract.
// One zod discriminated union so every recognizer (speech/ink/gesture/equation) speaks the same
// validated schema. Ink is vector strokes ONLY — never pixels/frames (privacy invariant).
import { z } from 'zod';
import type { SceneSpec } from '@/lib/scene-spec';

const Pt = z.tuple([z.number(), z.number()]);      // normalized [x,y] in 0..1
const Polyline = z.array(Pt).max(400);

export const RecognitionEventZ = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('speech'),
    transcript: z.string().max(500),
    lang: z.string().default('en'),
    interim: z.boolean().default(false),   // interim ASR result — don't compile yet
    at: z.number(),
  }),
  z.object({
    kind: z.literal('ink'),
    strokes: z.array(Polyline).max(400),   // vectors only
    source: z.enum(['pen', 'physical']),
    at: z.number(),
  }),
  z.object({
    kind: z.literal('gesture'),
    gesture: z.enum(['circle', 'underline', 'arrow', 'marks']),
    centroid: Pt,
    confidence: z.number().min(0).max(1),
    at: z.number(),
  }),
  z.object({
    kind: z.literal('equation'),
    latex: z.string().max(400).optional(),          // if the client/OCR already produced it
    strokes: z.array(Polyline).max(400).optional(), // else raw ink for server-side OCR
    at: z.number(),
  }),
]);
export type RecognitionEvent = z.infer<typeof RecognitionEventZ>;

// ---- broadcast fire payload (server → students): documents the existing wire format ----
export type FirePayload =
  | { templateId: 'projectile' | 'sine' | 'sortbars'; params: Record<string, number | number[]> }
  | { templateId: 'scene'; params: { scene: SceneSpec } }
  | { templateId: 'slide'; params: { slide: { title: string; bullets: string[] } } }
  | { templateId: 'ink'; params: { strokes: [number, number][][]; source: 'pen' | 'physical' } }
  | { templateId: 'equation'; params: { latex: string; caption?: string } };   // Block 07: new
