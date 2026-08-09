// src/lib/aes/simulate.ts — AES section 20 and the section 21 worked example: where an Experience
// represents a physical phenomenon, a DETERMINISTIC ENGINE computes the behaviour. Given amplitude,
// frequency and phase, the positions come from the equation, never from a model guess.
//
// WHAT THIS FILE IS NOT. It is not a second integrator. src/lib/aes/physics.ts already loads
// public/aquin-physics.js and runs the real RK4 solver (nonlinear pendulum, damped-driven
// oscillator, RLC, quadratic-drag projectile) with its own invariant checks. Adding another one
// here would be the mistake this repository has already made with chat tables and XP systems.
//
// WHAT IT IS. The CLOSED-FORM ANALYTIC SOLUTIONS — the exact answers that exist for the linear
// cases — and nothing else. That gives the system something it did not have: an INDEPENDENT ORACLE.
// An integrator can only check itself against its own energy bookkeeping; those checks pass on a
// solver that is consistently wrong. validate.ts compares the integrated series against these
// equations, so "the picture looked right" is replaced by "the numbers agree with the analytic
// solution to 1e-3". That is section 172 made computable.
//
// PURITY. Nothing here imports the physics engine, the kernel or the database. Every function is
// arithmetic on numbers, so identical inputs give identical outputs on every machine and the whole
// module is unit-testable with `npx tsx src/lib/aes/simulate.test.ts`.
//
// The model ids match src/lib/aes/physics.ts PHYSICS_MODELS exactly, so a run and its oracle are
// always talking about the same thing.

export const SIMULATE_VERSION = 1;
/** Beyond this release angle the small-angle formula is not merely imprecise, it is the wrong model. */
export const SMALL_ANGLE_LIMIT_RAD = 0.2618;      // 15 degrees

export interface AnalyticPoint { t: number; x: number; v: number }
export interface AnalyticSolution {
  /** which closed form was used, in words a teacher can read */
  form: string;
  /** true when an exact solution exists for these parameters; false = only the integrator can answer */
  exact: boolean;
  x: (t: number) => number;
  v: (t: number) => number;
  derived: Record<string, number>;
  assumptions: string[];
}

const TAU = Math.PI * 2;

// ── the harmonic oscillator — section 21's worked example ──────────────────────────────────────
//
// Convention: x(t) = A cos(omega t + phase). With phase 0 the mass starts at full amplitude and at
// rest, which is what a teacher draws when they pull a mass back and let go.
//
// Damping uses the standard ratio zeta = c / (2 sqrt(k m)):
//   zeta = 0    undamped        x = A cos(w0 t + p)
//   0 < z < 1   underdamped     x = A e^(-z w0 t) cos(wd t + p),  wd = w0 sqrt(1 - z^2)
//   zeta = 1    critical        x = (x0 + (v0 + w0 x0) t) e^(-w0 t)
//   zeta > 1    overdamped      x = C1 e^(r1 t) + C2 e^(r2 t)
// The three damped branches are written from the SAME initial conditions the undamped branch has at
// t = 0 (x0 = A cos p, v0 = -A w0 sin p), so the four regimes agree in the limit and a teacher
// sweeping zeta through 1 sees a continuous family rather than a jump.

export interface HarmonicInput {
  /** amplitude, in metres */
  amplitude?: number;
  /** frequency in HERTZ (cycles per second). Give this OR angularFrequency, never both meanings. */
  frequency?: number;
  /** angular frequency in rad/s. Takes precedence when given — it is what the solver actually uses. */
  angularFrequency?: number;
  /** phase, in radians */
  phase?: number;
  /** damping RATIO, dimensionless */
  damping?: number;
  /** mass, in kilograms — only needed for an energy figure */
  mass?: number;
}

/** The exact solution. omega comes from angularFrequency when given, otherwise 2*pi*frequency. */
export function harmonic(input: HarmonicInput): AnalyticSolution {
  const A = Number.isFinite(Number(input.amplitude)) ? Number(input.amplitude) : 1;
  const w0 = Number.isFinite(Number(input.angularFrequency))
    ? Number(input.angularFrequency)
    : TAU * (Number.isFinite(Number(input.frequency)) ? Number(input.frequency) : 1);
  const p = Number.isFinite(Number(input.phase)) ? Number(input.phase) : 0;
  const z = Number.isFinite(Number(input.damping)) ? Math.max(0, Number(input.damping)) : 0;
  const m = Number.isFinite(Number(input.mass)) && Number(input.mass) > 0 ? Number(input.mass) : 1;
  const k = m * w0 * w0;
  const x0 = A * Math.cos(p);
  const v0 = -A * w0 * Math.sin(p);

  if (z === 0) {
    return {
      form: 'x(t) = A cos(omega t + phase)',
      exact: true,
      x: (t) => A * Math.cos(w0 * t + p),
      v: (t) => -A * w0 * Math.sin(w0 * t + p),
      derived: { omega0: w0, omegaD: w0, period: w0 > 0 ? TAU / w0 : Infinity, stiffness: k, energy: 0.5 * k * A * A, zeta: 0 },
      assumptions: ['the restoring force is exactly linear in displacement', 'no damping and no driving force'],
    };
  }
  if (z < 1) {
    const wd = w0 * Math.sqrt(1 - z * z);
    const env = (t: number) => Math.exp(-z * w0 * t);
    const x = (t: number) => A * env(t) * Math.cos(wd * t + p);
    const v = (t: number) => A * env(t) * (-z * w0 * Math.cos(wd * t + p) - wd * Math.sin(wd * t + p));
    return {
      form: 'x(t) = A e^(-zeta omega0 t) cos(omegaD t + phase)',
      exact: true, x, v,
      derived: { omega0: w0, omegaD: wd, period: wd > 0 ? TAU / wd : Infinity, stiffness: k, energy: 0.5 * k * A * A, zeta: z, qualityFactor: 1 / (2 * z) },
      assumptions: ['damping is viscous, so the resisting force is proportional to velocity', 'the restoring force stays linear'],
    };
  }
  if (z === 1) {
    const c2 = v0 + w0 * x0;
    const x = (t: number) => (x0 + c2 * t) * Math.exp(-w0 * t);
    const v = (t: number) => (c2 - w0 * (x0 + c2 * t)) * Math.exp(-w0 * t);
    return {
      form: 'x(t) = (x0 + (v0 + omega0 x0) t) e^(-omega0 t)',
      exact: true, x, v,
      derived: { omega0: w0, omegaD: 0, period: Infinity, stiffness: k, energy: 0.5 * k * x0 * x0 + 0.5 * m * v0 * v0, zeta: 1 },
      assumptions: ['damping is viscous', 'critical damping: the system returns without overshooting'],
    };
  }
  const s = w0 * Math.sqrt(z * z - 1);
  const r1 = -z * w0 + s, r2 = -z * w0 - s;
  const c1 = (v0 - r2 * x0) / (r1 - r2);
  const c2 = (r1 * x0 - v0) / (r1 - r2);
  return {
    form: 'x(t) = C1 e^(r1 t) + C2 e^(r2 t)',
    exact: true,
    x: (t) => c1 * Math.exp(r1 * t) + c2 * Math.exp(r2 * t),
    v: (t) => c1 * r1 * Math.exp(r1 * t) + c2 * r2 * Math.exp(r2 * t),
    derived: { omega0: w0, omegaD: 0, period: Infinity, stiffness: k, energy: 0.5 * k * x0 * x0 + 0.5 * m * v0 * v0, zeta: z, r1, r2 },
    assumptions: ['damping is viscous', 'overdamped: no oscillation at all'],
  };
}

// ── projectile motion in vacuum — the template that already exists, solved exactly ─────────────
export interface ProjectileInput { speed?: number; angleDeg?: number; gravity?: number; height?: number }
export interface ProjectileSolution {
  form: string; exact: boolean;
  point: (t: number) => { x: number; y: number };
  velocity: (t: number) => { vx: number; vy: number };
  derived: Record<string, number>;
  assumptions: string[];
}

export function projectileVacuum(input: ProjectileInput): ProjectileSolution {
  const v = Number.isFinite(Number(input.speed)) ? Number(input.speed) : 30;
  const a = ((Number.isFinite(Number(input.angleDeg)) ? Number(input.angleDeg) : 45) * Math.PI) / 180;
  const g = Number.isFinite(Number(input.gravity)) && Number(input.gravity) > 0 ? Number(input.gravity) : 9.81;
  const y0 = Number.isFinite(Number(input.height)) ? Math.max(0, Number(input.height)) : 0;
  const vx = v * Math.cos(a), vy = v * Math.sin(a);
  const flight = (vy + Math.sqrt(Math.max(0, vy * vy + 2 * g * y0))) / g;
  return {
    form: 'x = v cos(a) t,  y = y0 + v sin(a) t - g t^2 / 2',
    exact: true,
    point: (t) => ({ x: vx * t, y: y0 + vy * t - 0.5 * g * t * t }),
    velocity: (t) => ({ vx, vy: vy - g * t }),
    derived: { flightTime: flight, range: vx * flight, apex: y0 + (vy * vy) / (2 * g), vx0: vx, vy0: vy },
    assumptions: ['no air resistance at all', 'uniform gravity', 'the projectile is a point mass'],
  };
}

// ── the small-angle pendulum — exact only inside its own assumption ────────────────────────────
export interface PendulumInput { length?: number; gravity?: number; theta0Rad?: number }
export function pendulumSmallAngle(input: PendulumInput): AnalyticSolution {
  const L = Number.isFinite(Number(input.length)) && Number(input.length) > 0 ? Number(input.length) : 1;
  const g = Number.isFinite(Number(input.gravity)) && Number(input.gravity) > 0 ? Number(input.gravity) : 9.81;
  const A = Number.isFinite(Number(input.theta0Rad)) ? Number(input.theta0Rad) : 0.2;
  const w = Math.sqrt(g / L);
  const inRange = Math.abs(A) <= SMALL_ANGLE_LIMIT_RAD;
  return {
    form: 'theta(t) = theta0 cos(sqrt(g/L) t)',
    // The honesty that matters: outside the small-angle range this closed form is NOT the answer,
    // and saying so is the difference between a check and a decoration.
    exact: inRange,
    x: (t) => A * Math.cos(w * t),
    v: (t) => -A * w * Math.sin(w * t),
    derived: { omega: w, period: TAU / w, theta0: A, smallAngleLimit: SMALL_ANGLE_LIMIT_RAD },
    assumptions: inRange
      ? ['sin(theta) is replaced by theta, valid to about 1% below 15 degrees']
      : ['THE SMALL-ANGLE APPROXIMATION DOES NOT HOLD AT THIS AMPLITUDE — the nonlinear equation must be integrated instead'],
  };
}

// ── the oracle, keyed to the physics.ts model registry ─────────────────────────────────────────
//
// Given the SAME parameter object physics.ts clamps and integrates, produce the analytic series at
// the same abscissae. Returns null when no closed form exists for those parameters (a driven
// oscillator through its transient, a drag projectile, a large-angle pendulum) — which is not a
// failure and must never be reported as one.
export interface Oracle { modelId: string; form: string; at: (x: number) => number; derived: Record<string, number>; note: string }

export function analyticOracle(modelId: string, params: Record<string, number>): Oracle | null {
  if (modelId === 'sho') {
    const sol = harmonic({ amplitude: params.x0, angularFrequency: params.omega0, phase: 0 });
    return { modelId, form: sol.form, at: (t) => sol.x(t), derived: sol.derived, note: 'undamped, undriven: the analytic solution is exact for every t' };
  }
  if (modelId === 'damped-driven') {
    if ((params.force || 0) !== 0) return null;                    // a driven transient has no tidy closed form
    const sol = harmonic({ amplitude: params.x0, angularFrequency: params.omega0, phase: 0, damping: params.zeta });
    return { modelId, form: sol.form, at: (t) => sol.x(t), derived: sol.derived, note: 'undriven: the damped closed form applies in every regime' };
  }
  if (modelId === 'pendulum') {
    const theta0 = ((params.theta0 || 0) * Math.PI) / 180;
    if ((params.damping || 0) !== 0) return null;
    if (Math.abs(theta0) > SMALL_ANGLE_LIMIT_RAD) return null;     // outside its own assumption; no claim made
    const sol = pendulumSmallAngle({ length: params.length, gravity: params.gravity, theta0Rad: theta0 });
    return { modelId, form: sol.form, at: (t) => sol.x(t), derived: sol.derived, note: 'small-angle only, so the comparison is valid below 15 degrees' };
  }
  if (modelId === 'projectile-drag') {
    if ((params.dragK || 0) !== 0) return null;                    // with drag there IS no closed form
    const sol = projectileVacuum({ speed: params.speed, angleDeg: params.angleDeg, gravity: params.gravity });
    // the projectile series is height against horizontal distance, so the oracle is y(x)
    const vx = sol.derived.vx0, vy = sol.derived.vy0, g = params.gravity;
    return {
      modelId, form: 'y = x tan(a) - g x^2 / (2 v^2 cos^2 a)',
      at: (x) => (vx > 0 ? (vy / vx) * x - (g * x * x) / (2 * vx * vx) : 0),
      derived: sol.derived,
      note: 'drag is zero, so the vacuum parabola is the exact trajectory',
    };
  }
  return null;
}

/** Sample a solution at n+1 evenly spaced abscissae. Deterministic by construction. */
export function sampleAnalytic(fn: (t: number) => number, from: number, to: number, n: number): AnalyticPoint[] {
  const out: AnalyticPoint[] = [];
  const count = Math.max(1, Math.round(n));
  for (let i = 0; i <= count; i++) {
    const t = from + ((to - from) * i) / count;
    out.push({ t, x: fn(t), v: 0 });
  }
  return out;
}

/** Largest absolute and relative gap between an integrated series and its analytic oracle. */
export function compareToAnalytic(series: { x: number; y: number }[], oracle: Oracle): { maxAbs: number; maxRel: number; scale: number; points: number } {
  let maxAbs = 0;
  let scale = 0;
  for (const p of series) if (Number.isFinite(p.y)) scale = Math.max(scale, Math.abs(p.y));
  for (const p of series) {
    const expected = oracle.at(p.x);
    if (!Number.isFinite(expected) || !Number.isFinite(p.y)) continue;
    maxAbs = Math.max(maxAbs, Math.abs(p.y - expected));
  }
  return { maxAbs, maxRel: scale > 0 ? maxAbs / scale : maxAbs, scale, points: series.length };
}

// ── determinism ────────────────────────────────────────────────────────────────────────────────
/** Deterministic PRNG (mulberry32). The ONLY source of variation anywhere in the AES compute path,
 *  and it is seeded, so reproduce.ts can replay a run exactly. */
export function seededRandom(seed: number): () => number {
  let a = (seed >>> 0) || 1;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic scatter, for a lab Experience that should look like measured data rather than a
 *  perfect curve. Off unless a seed is given — an unseeded run would not be reproducible, and a
 *  non-reproducible teaching artefact is worse than a clean one. */
export function withMeasurementNoise(series: { x: number; y: number }[], relative: number, seed: number | null): { series: { x: number; y: number }[]; applied: boolean; reason: string } {
  if (!(relative > 0)) return { series, applied: false, reason: 'no noise requested' };
  if (seed == null || !Number.isFinite(seed)) return { series, applied: false, reason: 'noise needs a seed; an unseeded run cannot be reproduced, so none was applied' };
  const rnd = seededRandom(seed);
  const scale = series.reduce((mx, p) => Math.max(mx, Math.abs(p.y)), 0) || 1;
  return {
    series: series.map((p) => ({ x: p.x, y: p.y + (rnd() * 2 - 1) * relative * scale })),
    applied: true,
    reason: 'scatter of ' + relative + ' applied with seed ' + seed,
  };
}
