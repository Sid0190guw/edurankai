// Every face model a page asks for must be a file this site actually serves.
//
// =================================================================================================
// THE FAILURE THIS EXISTS TO CATCH
// =================================================================================================
//
// The face weights were moved off a public CDN into public/vendor/face-api/models, so that signing
// in stops depending on somebody else's uptime. Three were vendored — the three every face surface
// used: tiny_face_detector, face_landmark_68_tiny, face_recognition.
//
// One page had always asked for different ones. /portal/face-setup loaded ssdMobilenetv1 and the
// FULL face_landmark_68, and neither had been downloaded. It answered 404 and the camera panel read
//
//     CAMERA ERROR: FAILED TO FETCH: (404) ... ssd_mobilenetv1_model-weights_manifest.json
//
// to anybody trying to enrol their face. Thirteen pages used the tiny pair and worked. Nothing in a
// build, a type check or a unit test could see it, because the mismatch is between a string in a
// browser script and a file on disk — and the CDN had been quietly covering for it.
//
// So this is the check that could have: read what the pages ask for, read what is on disk, and
// insist the first is a subset of the second.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { describe, it, expect, report } from './test-shim';

const MODEL_DIR = 'public/vendor/face-api/models';
const LIB = 'public/vendor/face-api/face-api.min.js';

/** faceapi.nets.<name> -> the file prefix it fetches. */
const NET_FILES: ReadonlyArray<readonly [string, string]> = [
  ['tinyFaceDetector', 'tiny_face_detector_model'],
  ['ssdMobilenetv1', 'ssd_mobilenetv1_model'],
  ['faceLandmark68Net', 'face_landmark_68_model'],
  ['faceLandmark68TinyNet', 'face_landmark_68_tiny_model'],
  ['faceRecognitionNet', 'face_recognition_model'],
  ['faceExpressionNet', 'face_expression_model'],
  ['ageGenderNet', 'age_gender_model'],
];

function sources(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.astro' || name === 'dist') continue;
    const p = dir + '/' + name;
    if (statSync(p).isDirectory()) sources(p, acc);
    else if (p.endsWith('.astro') || p.endsWith('.ts') || p.endsWith('.js')) acc.push(p);
  }
  return acc;
}

const onDisk = existsSync(MODEL_DIR) ? readdirSync(MODEL_DIR) : [];
const PAGES = sources('src').filter((f) => !f.endsWith('.test.ts'));

/** Every (file, net) pair the product asks a browser to load. */
const asked: { file: string; net: string; prefix: string }[] = [];
for (const f of PAGES) {
  const body = readFileSync(f, 'utf8');
  // Only the real call, not a mention in prose: `nets.<name>.loadFromUri`.
  for (const [net, prefix] of NET_FILES) {
    if (new RegExp('nets\\.' + net + '\\s*\\.\\s*loadFromUri').test(body)) {
      asked.push({ file: f, net, prefix });
    }
  }
}

describe('the vendored models are actually there', () => {
  it('the library itself is vendored, not fetched from a CDN', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('every model has BOTH its manifest and its weights', () => {
    // A manifest without its .bin is the same 404, one request later.
    const manifests = onDisk.filter((n) => n.endsWith('-weights_manifest.json'));
    expect(manifests.length).toBeGreaterThan(0);
    for (const m of manifests) {
      const prefix = m.replace('-weights_manifest.json', '');
      expect(onDisk.some((n) => n.startsWith(prefix) && n.endsWith('.bin'))).toBe(true);
    }
  });

  it('no weights file is empty or a stub', () => {
    // A truncated download produces a file that exists and loads to nothing.
    for (const n of onDisk.filter((x) => x.endsWith('.bin'))) {
      expect(statSync(MODEL_DIR + '/' + n).size).toBeGreaterThan(10000);
    }
  });
});

describe('no page asks for a model this site does not serve', () => {
  it('found the loadFromUri calls at all, so this test is testing something', () => {
    // A regex that matches nothing would make every assertion below pass vacuously.
    expect(asked.length).toBeGreaterThan(5);
  });

  it('every requested model exists on disk', () => {
    const missing = asked
      .filter((a) => !onDisk.includes(a.prefix + '-weights_manifest.json'))
      .map((a) => a.file.replace('src/', '') + ' wants ' + a.prefix);
    // Named, because "a model is missing" sends somebody to read fourteen files.
    expect(missing.join(' | ')).toBe('');
  });

  it('nothing loads the full landmark net while only the tiny one is vendored', () => {
    // withFaceLandmarks() defaults to the FULL net. Every call site must pass `true` for the tiny
    // one, or detection reaches for a model that was never downloaded.
    if (onDisk.includes('face_landmark_68_model-weights_manifest.json')) return;
    const bad: string[] = [];
    for (const f of PAGES) {
      const body = readFileSync(f, 'utf8');
      if (/withFaceLandmarks\(\s*\)/.test(body)) bad.push(f.replace('src/', ''));
    }
    expect(bad.join(', ')).toBe('');
  });

  it('nothing fetches face models from a third-party CDN any more', () => {
    // The whole point of vendoring: identity must not depend on somebody else's uptime, and 13
    // surfaces once pointed at an unpinned @latest.
    const offenders: string[] = [];
    for (const f of PAGES) {
      const body = readFileSync(f, 'utf8');
      if (/https?:\/\/cdn\.[^'"`\s]*face-api/i.test(body)) offenders.push(f.replace('src/', ''));
    }
    expect(offenders.join(', ')).toBe('');
  });
});

report();
