// src/lib/aes/providers/engine-loader.ts — loads a FIRST-PARTY engine this repository already owns.
//
// Two of the AES providers are answered today by engines that were written for the browser and
// attach themselves to a window global: public/aquin-physics.js (a real RK4 ODE integrator with
// energy-conservation and convergence checks) and public/aquin-board-vision.js (homography,
// lighting, frame-diff, stroke vectorisation). Both are dependency-free and pure; aquin-physics.js
// has, until now, had no importer anywhere in the repository.
//
// This loader is an ADAPTER, not a second engine. It does not reimplement any of that maths — it
// evaluates the existing asset once and hands back the same API object the browser gets, so the
// physics a student sees and the physics the server computes are the identical code path. Writing
// a parallel TypeScript integrator would be exactly the mistake this project has already made
// twice with chat tables and progress writers.
//
// WHERE IT WORKS, HONESTLY: in the browser the global is already there. Under Node (tests, `astro
// dev`, a Node-adapter server) the file is read from disk. In a bundled serverless runtime the
// public/ directory is served statically and is NOT part of the function bundle, so the read can
// fail — and when it does, the provider above reports UNAVAILABLE with this exact reason rather
// than pretending to have physics. That is the whole point of the availability contract.

import { errText } from './types';

export interface EngineLoad {
  ok: boolean;
  api: any;
  /** Always populated: a sentence explaining how it loaded, or why it did not. */
  reason: string;
  source: 'global' | 'filesystem' | 'none';
}

const cache = new Map<string, EngineLoad>();

/** Candidate roots, in order. cwd covers `npx tsx` from the repo root and `astro dev`. */
function candidates(assetPath: string): string[] {
  const cwd = typeof process !== 'undefined' && process.cwd ? process.cwd() : '';
  const out: string[] = [];
  if (cwd) {
    out.push(cwd + '/' + assetPath);
    out.push(cwd + '/../' + assetPath);
  }
  out.push(assetPath);
  return out;
}

/**
 * Load an engine asset and return its API object.
 *
 * @param assetPath repo-relative path, e.g. 'public/aquin-physics.js'
 * @param globalName the window global the asset assigns, e.g. 'AquinPhysics'
 */
export async function loadEngine(assetPath: string, globalName: string): Promise<EngineLoad> {
  const key = assetPath + '#' + globalName;
  const hit = cache.get(key);
  if (hit) return hit;

  const g: any = globalThis as any;
  if (g && g[globalName] && typeof g[globalName] === 'object') {
    const r: EngineLoad = { ok: true, api: g[globalName], reason: 'The engine is already loaded in this runtime.', source: 'global' };
    cache.set(key, r);
    return r;
  }
  if (g && g.window && g.window[globalName] && typeof g.window[globalName] === 'object') {
    const r: EngineLoad = { ok: true, api: g.window[globalName], reason: 'The engine is already loaded in this runtime.', source: 'global' };
    cache.set(key, r);
    return r;
  }

  let lastErr = '';
  try {
    const fs: any = await import('node:fs');
    for (const path of candidates(assetPath)) {
      let src = '';
      try {
        src = fs.readFileSync(path, 'utf8');
      } catch (e: any) { lastErr = errText(e); continue; }
      try {
        // The asset is a first-party static file in this repository, not user input. It assigns its
        // API to `window`, so it is given a private window object rather than the real one.
        const shim: any = { window: {}, module: { exports: {} } };
        const run = new Function('window', 'module', 'exports', src);
        run(shim.window, shim.module, shim.module.exports);
        const api = shim.window[globalName] || shim.module.exports;
        if (api && typeof api === 'object' && Object.keys(api).length > 0) {
          const r: EngineLoad = { ok: true, api, reason: 'Loaded ' + assetPath + ' from the application files.', source: 'filesystem' };
          cache.set(key, r);
          return r;
        }
        lastErr = assetPath + ' evaluated but exposed no ' + globalName + ' API.';
      } catch (e: any) { lastErr = errText(e); }
    }
  } catch (e: any) {
    lastErr = 'no filesystem in this runtime (' + errText(e) + ')';
  }

  const r: EngineLoad = {
    ok: false,
    api: null,
    reason: 'The engine ' + assetPath + ' could not be loaded in this runtime' + (lastErr ? ': ' + lastErr : '') + '.',
    source: 'none',
  };
  cache.set(key, r);
  return r;
}

/** Test seam: forget cached loads so a deliberately bad path can be exercised. */
export function resetEngineCache(): void { cache.clear(); }
