// src/lib/aes/providers/simulation.ts — SimulationProvider (spec sections 20, 172, 41).
//
// THIS IS THE PROVIDER THAT MAKES SECTION 20 REAL. The model decides intent; a DETERMINISTIC
// ENGINE computes the physics. Until now this repository had both halves and had never introduced
// them to each other: public/aquin-physics.js is a genuine RK4 ODE integrator — nonlinear
// large-angle pendulum, damped and driven oscillator, series RLC with correct damping regimes,
// projectile with quadratic drag, energy-conservation and convergence checks — and it had no
// importer anywhere. The scene engine meanwhile samples closed-form curves: correct for its three
// cases, silent about damping, driving, resonance, energy and large amplitude.
//
// So this provider does not write a solver. It ADAPTS the existing one, through the engine loader,
// which means the numbers a student sees on the board and the numbers the server computes come out
// of the same code. Writing a parallel TypeScript integrator would have been a second engine.
//
// WHAT THIS PROVIDER IS FOR, said plainly: when a lesson needs a number, it comes from here. A
// language model may choose WHICH system to simulate and with what parameters; it never supplies
// the trajectory, the period or the energy. Visual plausibility is not evidence.

import { loadEngine } from './engine-loader';
import {
  BaseProvider, NullProvider, available, unavailable, unsupportedAll,
  type AesProvider, type AesResult, type CapabilityDecl, type Health, type ProviderDescriptor,
} from './types';

export interface Sample { t: number; y: number[]; E?: number }

export interface PendulumRequest { lengthM: number; gravity?: number; amplitudeRad: number; damping?: number; seconds?: number; step?: number }
export interface PendulumValue {
  samples: Sample[];
  measuredPeriod: number | null;
  smallAnglePeriod: number;
  /** measured / small-angle. Above 1 at large amplitude — the effect the textbook formula misses. */
  periodRatio: number | null;
  energyDriftRatio: number;
}

export interface OscillatorRequest { omega0: number; zeta?: number; drive?: number; driveOmega?: number; x0?: number; v0?: number; seconds?: number; step?: number }
export interface OscillatorValue { samples: Sample[]; regime: string; measuredPeriod: number | null; energyDriftRatio: number }

export interface RlcRequest { resistance: number; inductance: number; capacitance: number; charge0?: number; current0?: number; seconds?: number; step?: number }
export interface RlcValue { samples: Sample[]; regime: string; discriminant: number }

export interface ProjectileRequest { speed: number; angleDeg: number; gravity?: number; dragCoefficient?: number; mass?: number }
export interface ProjectileValue { range: number | null; flightTime: number | null; maxHeight: number | null; terminalVelocity: number; vacuumRange: number }

export interface SimulationProvider extends AesProvider {
  pendulum(req: PendulumRequest): Promise<AesResult<PendulumValue>>;
  oscillator(req: OscillatorRequest): Promise<AesResult<OscillatorValue>>;
  rlc(req: RlcRequest): Promise<AesResult<RlcValue>>;
  projectile(req: ProjectileRequest): Promise<AesResult<ProjectileValue>>;
}

export const SIMULATION_CAPABILITIES: { id: string; summary: string; determinism: 'deterministic' }[] = [
  { id: 'simulation.pendulum', summary: 'Integrate a nonlinear pendulum and measure its real, amplitude-dependent period.', determinism: 'deterministic' },
  { id: 'simulation.oscillator', summary: 'Integrate a damped and driven harmonic oscillator and name its damping regime.', determinism: 'deterministic' },
  { id: 'simulation.rlc', summary: 'Integrate a series RLC circuit and name its damping regime from the discriminant.', determinism: 'deterministic' },
  { id: 'simulation.projectile', summary: 'Integrate a projectile with quadratic air drag and report the real range against the vacuum range.', determinism: 'deterministic' },
];

const CANNOT = [
  'Field solvers, finite elements or fluid dynamics. This is classical mechanics and lumped circuits, integrated on the CPU.',
  'Accept a result a language model produced. Parameters may be proposed; the trajectory is always computed here.',
  'Guarantee a result outside its step budget. A request that would exceed it is refused, not silently truncated.',
];

const ASSET = 'public/aquin-physics.js';
const GLOBAL = 'AquinPhysics';

// ---------------------------------------------------------------- null (honest about doing nothing)

export class NullSimulationProvider extends NullProvider implements SimulationProvider {
  readonly descriptor: ProviderDescriptor;

  constructor(reason = 'No simulation engine is registered for this deployment.',
              remedy = 'Register a simulation provider before any lesson asks AES for a computed physical result.') {
    super(reason, remedy);
    this.descriptor = {
      id: 'simulation.null',
      kind: 'simulation',
      title: 'No physics engine',
      does: 'Nothing. A lesson that needs a computed number is refused with a reason, which is the correct answer when nothing can compute it — an invented number would be worse.',
      cannot: ['Anything at all. Every call is refused, with the reason above.'],
      requires: ['a registered simulation engine'],
      capabilities: unsupportedAll(SIMULATION_CAPABILITIES, reason),
    };
  }

  pendulum(_r: PendulumRequest) { return this.guarded('simulation.pendulum', () => { throw new Error('unreachable'); }) as Promise<AesResult<PendulumValue>>; }
  oscillator(_r: OscillatorRequest) { return this.guarded('simulation.oscillator', () => { throw new Error('unreachable'); }) as Promise<AesResult<OscillatorValue>>; }
  rlc(_r: RlcRequest) { return this.guarded('simulation.rlc', () => { throw new Error('unreachable'); }) as Promise<AesResult<RlcValue>>; }
  projectile(_r: ProjectileRequest) { return this.guarded('simulation.projectile', () => { throw new Error('unreachable'); }) as Promise<AesResult<ProjectileValue>>; }
}

// ------------------------------------------------------------------------------------- the real one

/** Hard ceiling on integration work in one call. A request beyond it is REFUSED with the numbers,
 *  so a teacher sees why, rather than receiving a quietly shortened trajectory that looks fine. */
export const MAX_STEPS = 400000;

export class Rk4SimulationProvider extends BaseProvider implements SimulationProvider {
  readonly descriptor: ProviderDescriptor;
  private engine: any = null;
  private loadReason = '';

  constructor(private readonly assetPath: string = ASSET) {
    super();
    const caps: CapabilityDecl[] = SIMULATION_CAPABILITIES.map((c) => ({ ...c, supported: true }));
    this.descriptor = {
      id: 'simulation.rk4',
      kind: 'simulation',
      title: 'Numerical physics engine (Runge-Kutta 4)',
      does: 'Numerically integrates real ordinary differential equations and verifies them — energy conservation on an undamped system, monotonic loss on a damped one, damping regimes from the discriminant. Every number a lesson quotes comes from here, never from a guess.',
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
        'The physics engine is not loadable in this runtime, so AES cannot compute a physical result here. ' + this.loadReason,
        'Serve AES from a runtime that can read the application engine files, or register a different simulation provider.',
      );
    }
    return available('The numerical physics engine is loaded and computing results. ' + this.loadReason);
  }

  private stepCount(seconds: number, step: number): number { return Math.ceil(seconds / step); }

  private budget(seconds: number, step: number): void {
    const n = this.stepCount(seconds, step);
    if (!Number.isFinite(n) || n <= 0) throw new Error('the requested duration and step size do not describe any work');
    if (n > MAX_STEPS) {
      throw new Error(
        'the request needs ' + n + ' integration steps and one call admits ' + MAX_STEPS +
        '; shorten the duration or increase the step size rather than accepting a truncated trajectory',
      );
    }
  }

  private drift(traj: Sample[]): number {
    const withE = traj.filter((s) => typeof s.E === 'number');
    if (withE.length < 2) return 0;
    const first = Number(withE[0].E);
    if (!first) return 0;
    let worst = 0;
    for (const s of withE) worst = Math.max(worst, Math.abs(Number(s.E) - first));
    return worst / Math.abs(first);
  }

  async pendulum(req: PendulumRequest): Promise<AesResult<PendulumValue>> {
    return this.guarded('simulation.pendulum', async () => {
      const P = await this.load();
      const g = req.gravity && req.gravity > 0 ? req.gravity : 9.81;
      const L = req.lengthM > 0 ? req.lengthM : 1;
      const step = req.step && req.step > 0 ? req.step : 0.001;
      const seconds = req.seconds && req.seconds > 0 ? req.seconds : 12;
      this.budget(seconds, step);
      const sys = P.pendulum({ g, L, damping: req.damping || 0 });
      const traj: Sample[] = P.integrate(sys.f, [req.amplitudeRad, 0], 0, step, this.stepCount(seconds, step), { sample: 5, energy: sys.energy });
      const measured = P.measurePeriod(traj);
      return {
        samples: traj,
        measuredPeriod: measured,
        smallAnglePeriod: sys.smallAnglePeriod,
        periodRatio: measured ? measured / sys.smallAnglePeriod : null,
        energyDriftRatio: this.drift(traj),
      };
    });
  }

  async oscillator(req: OscillatorRequest): Promise<AesResult<OscillatorValue>> {
    return this.guarded('simulation.oscillator', async () => {
      const P = await this.load();
      const step = req.step && req.step > 0 ? req.step : 0.001;
      const seconds = req.seconds && req.seconds > 0 ? req.seconds : 20;
      this.budget(seconds, step);
      const sys = P.oscillator({ w0: req.omega0, zeta: req.zeta || 0, F: req.drive || 0, wd: req.driveOmega || req.omega0 });
      const traj: Sample[] = P.integrate(sys.f, [req.x0 === undefined ? 1 : req.x0, req.v0 === undefined ? 0 : req.v0], 0, step, this.stepCount(seconds, step), { sample: 5, energy: sys.energy });
      return { samples: traj, regime: sys.regime, measuredPeriod: P.measurePeriod(traj), energyDriftRatio: this.drift(traj) };
    });
  }

  async rlc(req: RlcRequest): Promise<AesResult<RlcValue>> {
    return this.guarded('simulation.rlc', async () => {
      const P = await this.load();
      const step = req.step && req.step > 0 ? req.step : 0.0001;
      const seconds = req.seconds && req.seconds > 0 ? req.seconds : 0.2;
      this.budget(seconds, step);
      const sys = P.rlc({ R: req.resistance, L: req.inductance, C: req.capacitance });
      const traj: Sample[] = P.integrate(sys.f, [req.charge0 === undefined ? 1e-6 : req.charge0, req.current0 === undefined ? 0 : req.current0], 0, step, this.stepCount(seconds, step), { sample: 5 });
      return { samples: traj, regime: sys.regime, discriminant: sys.discriminant };
    });
  }

  async projectile(req: ProjectileRequest): Promise<AesResult<ProjectileValue>> {
    return this.guarded('simulation.projectile', async () => {
      const P = await this.load();
      const g = req.gravity && req.gravity > 0 ? req.gravity : 9.81;
      const speed = req.speed > 0 ? req.speed : 1;
      const angle = (req.angleDeg * Math.PI) / 180;
      const r = P.projectileRange({ speed, angleDeg: req.angleDeg, g, k: req.dragCoefficient || 0, m: req.mass || 1, h: 0.001 });
      if (r.range === null || r.range === undefined) throw new Error(r.reason || 'the projectile did not land within the step budget');
      return {
        range: r.range,
        flightTime: r.flightTime,
        maxHeight: r.maxHeight,
        terminalVelocity: r.terminalVelocity,
        vacuumRange: (speed * speed * Math.sin(2 * angle)) / g,
      };
    });
  }
}
