// src/lib/render-profile.test.ts — run: DATABASE_URL=... npx tsx src/lib/render-profile.test.ts
// Self-contained pure tests for the deterministic render-profile selector (no DB used; a dummy
// DATABASE_URL is only needed because edu-runtime imports the db module at load time).
import { selectRenderProfile, profileToSceneQuality, mergeTelemetry, OFFLINE_MIN_FREE_MB, type DeviceTelemetry } from './render-profile';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

const RICH: DeviceTelemetry = { deviceMemory: 8, effectiveType: '4g', webglVersion: 2 };

function main() {
  console.log('\n== determinism ==');
  ok('same telemetry -> deep-equal profile', JSON.stringify(selectRenderProfile(RICH)) === JSON.stringify(selectRenderProfile(RICH)));

  console.log('\n== base tier ==');
  const rich = selectRenderProfile(RICH);
  ok('rich device + 4g + webgl2 -> rich/webgl/bloom', rich.tier === 'rich' && rich.mode === 'webgl' && rich.bloom && rich.shadows === 'soft', [rich.tier, rich.mode]);

  console.log('\n== gates ==');
  ok('low battery discharging -> lite', selectRenderProfile({ ...RICH, batteryLevel: 0.1, batteryCharging: false }).tier === 'lite');
  ok('low battery while charging -> not forced lite', selectRenderProfile({ ...RICH, batteryLevel: 0.1, batteryCharging: true }).tier === 'rich');
  ok('webglVersion 0 -> 2d mode', selectRenderProfile({ ...RICH, webglVersion: 0 }).mode === '2d');
  ok('tiny screen -> lite', selectRenderProfile({ ...RICH, screenWidth: 320 }).tier === 'lite');
  ok('<=2 cores caps at standard', selectRenderProfile({ ...RICH, hardwareConcurrency: 2 }).tier === 'standard');
  ok('reduced-data -> lite', selectRenderProfile({ ...RICH, prefersReducedData: true }).tier === 'lite');
  ok('reduced-motion -> animation none', selectRenderProfile({ ...RICH, prefersReducedMotion: true }).animation === 'none');
  ok('save-data (client hint) -> lite', selectRenderProfile({ ...RICH, saveData: true }).tier === 'lite');

  console.log('\n== xr is report-only ==');
  const xr = selectRenderProfile({ ...RICH, xrImmersive: true });
  ok('xrCapable true but mode stays webgl (never auto-xr)', xr.xrCapable === true && xr.mode === 'webgl', [xr.xrCapable, xr.mode]);
  ok('no xr hardware -> xrCapable false', selectRenderProfile(RICH).xrCapable === false);

  console.log('\n== offline eligibility (storage headroom) ==');
  ok(`>= ${OFFLINE_MIN_FREE_MB}MB free -> eligible`, selectRenderProfile({ ...RICH, storageQuotaMB: 1000, storageUsageMB: 100 }).offlineEligible === true);
  ok('< threshold free -> not eligible', selectRenderProfile({ ...RICH, storageQuotaMB: 300, storageUsageMB: 100 }).offlineEligible === false);
  ok('unknown storage -> not eligible', selectRenderProfile(RICH).offlineEligible === false);

  console.log('\n== pixel-ratio cap ==');
  ok('retina DPR clamped by tier (lite<=1)', selectRenderProfile({ ...RICH, saveData: true, devicePixelRatio: 3 }).pixelRatioCap === 1);
  ok('rich caps DPR at 2', selectRenderProfile({ ...RICH, devicePixelRatio: 3 }).pixelRatioCap === 2);

  console.log('\n== mergeTelemetry + profileToSceneQuality ==');
  const merged = mergeTelemetry({ deviceMemory: 4, effectiveType: '3g' }, { deviceMemory: 8 });
  ok('client value wins, header fills gaps', merged.deviceMemory === 8 && merged.effectiveType === '3g', merged);
  const q = profileToSceneQuality(rich);
  ok('scene quality mirrors profile dials', q.shadows === true && q.shadowQuality === 'soft' && q.mode === 'webgl' && q.pixelRatioCap === rich.pixelRatioCap);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main();
