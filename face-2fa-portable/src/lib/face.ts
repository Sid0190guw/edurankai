// face-2fa server helpers. Pure functions, no framework lock-in.

// Threshold tuned for @vladmandic/face-api 128-d descriptors. Lower = stricter.
// 0.55 is the standard match cutoff used in the reference implementation.
export const FACE_MATCH_THRESHOLD = 0.55;

// Euclidean distance between two 128-d descriptors. Smaller = more similar.
export function faceDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number);
    s += d * d;
  }
  return Math.sqrt(s);
}

// JSONB descriptors can come back from Postgres as an array OR as an object
// with numeric keys ({"0": 0.13, "1": -0.02, ...}). Normalise to number[].
export function normalizeDescriptor(stored: unknown): number[] {
  if (Array.isArray(stored)) return stored as number[];
  if (stored && typeof stored === 'object') return Object.values(stored as Record<string, number>);
  if (typeof stored === 'string') {
    try { return normalizeDescriptor(JSON.parse(stored)); } catch { return []; }
  }
  return [];
}

// Validate that a descriptor isn't garbage (right length, not all zeros).
export function isValidDescriptor(d: unknown, expectedLen = 128): d is number[] {
  if (!Array.isArray(d) || d.length !== expectedLen) return false;
  let nonZero = 0;
  for (const v of d) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
    if (Math.abs(v) > 1e-6) nonZero++;
  }
  return nonZero > 8; // reject blank/black-frame captures
}
