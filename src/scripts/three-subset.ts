// three-subset.ts — the tree-shakeable door onto three.js for the WebGL scene adapter.
//
// SceneGL.astro used to do `await import('three')` and reach everything through the namespace as
// `T.Foo`. A namespace import is opaque to the bundler: it has to assume every export is reachable,
// so the whole library landed in the chunk — 688 kB minified, which is what tripped rollup's
// 500 kB chunk-size warning on every build.
//
// three@0.170 declares `sideEffects: ["./src/nodes/**/*"]`, so build/three.module.js is
// side-effect-free and rollup CAN drop what nobody names. Naming the exports here is what lets it:
// re-exporting the symbols the adapter actually constructs turns the same dynamic import into a
// tree-shaken chunk.
//
// Measured by building this tree both ways on 2026-08-29, over the whole worst-case payload (this
// module plus RoomEnvironment plus the three postprocessing passes):
//
//   before   705,281 raw bytes / 179,713 gzipped   largest chunk 688.39 kB  (warning fires)
//   after    502,695 raw bytes / 124,982 gzipped   largest chunk 486.06 kB  (no warning)
//
// The largest chunk crossing back under 500 kB is the observable half of that: `npm run build` no
// longer prints rollup's chunk-size warning, so a future regression announces itself.
//
// THIS LIST IS LOAD-BEARING. A symbol used in SceneGL.astro but missing here is not a build error —
// it is `undefined` at runtime, and `new T.Missing()` throws inside a render loop on a live
// teaching surface. Add the export here in the same commit as any new `T.Foo` over there.
export {
  // renderer + colour pipeline
  WebGLRenderer,
  SRGBColorSpace,
  ACESFilmicToneMapping,
  PCFSoftShadowMap,

  // scene graph, camera, framing
  Scene,
  Group,
  PerspectiveCamera,
  Color,
  Fog,
  Clock,
  Vector2,
  Vector3,

  // lighting + environment
  HemisphereLight,
  DirectionalLight,
  PMREMGenerator,

  // geometry
  BoxGeometry,
  PlaneGeometry,
  SphereGeometry,
  CylinderGeometry,
  ConeGeometry,
  TorusGeometry,
  RingGeometry,
  BufferGeometry,
  BufferAttribute,

  // meshes, lines, points, sprites
  Mesh,
  Line,
  Points,
  Sprite,
  GridHelper,

  // materials + textures
  MeshStandardMaterial,
  LineBasicMaterial,
  PointsMaterial,
  SpriteMaterial,
  ShadowMaterial,
  CanvasTexture,
} from 'three';
