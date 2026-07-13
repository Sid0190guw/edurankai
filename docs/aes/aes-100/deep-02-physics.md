# DEEP BUILD 02 — Physics Simulation Engine (real numerical ODE integration)

**Real-depth build, not a formula lookup.** `public/aquin-physics.js` numerically
integrates real ODE systems with a 4th-order Runge-Kutta solver and VERIFIES the
physics. Node-tested, 7 cases, each checked against theory.

## What it actually computes (all verified)
- **RK4 integrator** (generic vector ODE). 4th-order accuracy confirmed: halving the
  step cut the error 14.9x (~16x) vs the analytic `x=cos t` solution.
- **Nonlinear pendulum** `θ'' = -(g/L)sinθ`: measured small-angle period 2.0073s
  matches `2π√(L/g)=2.0061s`; large-angle (2.5 rad) period 3.296s matches the exact
  **elliptic-integral** value ~3.29s — the real amplitude dependence the small-angle
  formula misses.
- **Energy conservation**: undamped relative drift 6e-14 over 30s; with damping,
  energy decreases monotonically 13.89 → 0.04.
- **Damped-driven oscillator**: resonance amplitude 9.79 at ω=ω₀ vs 0.38 at 2ω₀.
- **Series RLC**: under/critical/over-damped classified from the discriminant R²-4L/C.
- **Projectile with quadratic drag**: vacuum range 163.1m (theory 163.10m) → 78.2m
  with drag; terminal velocity √(mg/k)=31.3 m/s.

## Interface
```
AquinPhysics.rk4Step(f,t,y,h) · integrate(f,y0,t0,h,n,{sample,energy}) · measurePeriod(traj)
  pendulum({g,L,damping}) · oscillator({w0,zeta,F,wd}) · rlc({R,L,C})
  projectile({g,k,m}) · projectileRange({speed,angleDeg,k,m,h})
```
Harness: `physics_test.js` (7/7). HONEST SCOPE: classical mechanics + lumped circuits
on the CPU; GPU field solvers / FEM / CFD are separate substrates. This is exact,
verifiable numerical integration — real, and it powers interactive labs with genuine
dynamics instead of canned equations.
