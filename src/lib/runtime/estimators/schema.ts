// src/lib/runtime/estimators/schema.ts — Block 04: zod schemas validated at the API boundary.
import { z } from 'zod';

export const modality = z.enum(['visual', 'verbal', 'interactive', 'example']);

export const observationSignalSchema = z.object({
  conceptId: z.string().min(1),
  correct: z.boolean(),
  responseMs: z.number().nonnegative().optional(),
  hintsUsed: z.number().int().nonnegative().optional(),
  modality: modality.optional(),
});

export const deviceSignalsSchema = z.object({
  cores: z.number().int().positive().optional(),
  deviceMemoryGb: z.number().positive().optional(),
  webgl: z.boolean().optional(),
  userAgent: z.string().max(512).optional(),
});
export const networkSignalsSchema = z.object({
  effectiveType: z.enum(['slow-2g', '2g', '3g', '4g']).optional(),
  downlinkMbps: z.number().nonnegative().optional(),
  rttMs: z.number().nonnegative().optional(),
  saveData: z.boolean().optional(),
});
export const accessibilitySignalsSchema = z.object({
  reducedMotion: z.boolean().optional(),
  highContrast: z.boolean().optional(),
  screenReader: z.boolean().optional(),
  captions: z.boolean().optional(),
});

export const signalsBodySchema = z.object({
  studentObjectId: z.string().uuid(),
  device: deviceSignalsSchema.optional(),
  network: networkSignalsSchema.optional(),
  accessibility: accessibilitySignalsSchema.optional(),
  languagePrefs: z.array(z.string()).max(10).optional(),
});

export const observeBodySchema = z.object({
  studentObjectId: z.string().uuid(),
  observation: observationSignalSchema,
});
