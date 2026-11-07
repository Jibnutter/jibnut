import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';

/**
 * Slopestyle park. The course runs downhill along -Z (s = distance down the
 * course = -z): a start deck, a steep roll-in, three big tabletop jumps
 * (each bigger than the last), and a flat finish with an uphill braking
 * zone. Around it: snow berms, then the natural mountain.
 *
 * The whole surface is one smooth height function, so physics, meshes and
 * colliders all agree. The jumps are part of it: each one stands above a
 * lower side path you can ride around on, with sloped sides.
 */

export const COURSE_HALF = 20; // half the width of the groomed course
const BERM_START = 20; // the snow berms along each edge...
const BERM_TOP = 24; // ...rise to their top here
const BERM_HEIGHT = 1.4;
/** Riders are kept between the berm tops. */
export const EDGE_LIMIT = BERM_TOP - 1;

// ---------------------------------------------------------------------------
// The course profile, as a programme of slope angles. Each step eases the
// slope from the previous angle to a new one over a length of course, so the
// surface is smooth; short steps make sharp features like lips and knuckles.
// Angles in degrees: negative = downhill. Tags mark points the code needs.

type Step = [length: number, angle: number, tag?: string];

const S_MIN = -80; // the mountain above the start deck
const START_ANGLE = -22;
const PROGRAM: Step[] = [
  [45, -22],
  [20, 0], // ease onto the start deck
  [17, 0, 'deck-end'],
  [8, -27], // drop into the roll-in
  [32, -27],

  // Jump 1
  [10, -14],
  [16, -14, 'j1:a'], // approach
  [12, 24], // takeoff: curves up to a 24° lip
  [0.8, -4, 'j1:lip'],
  [15, -4, 'j1:knuckle'], // 15 m table
  [4, -32],
  [28, -32], // landing
  [16, -10, 'j1:c'], // flattens into the run-out

  // Jump 2 (the run-out bends right to get here)
  [40, -10, 'j2:a'],
  [13, 26],
  [0.8, -4, 'j2:lip'],
  [18, -4, 'j2:knuckle'], // 18 m table
  [4, -33],
  [32, -33],
  [16, -10, 'j2:c'],

  // Jump 3: the biggest (after a bend back left)
  [40, -10, 'j3:a'],
  [14, 28],
  [0.8, -4, 'j3:lip'],
  [21, -4, 'j3:knuckle'], // 21 m table
  [4, -34],
  [36, -34],
  [18, -10, 'j3:c'],

  // Finish
  [20, -6],
  [15, 0, 'finish'],
  [40, 0],
  [10, 10, 'brake'], // uphill braking zone
  [22, 10, 'end'],
  [10, 20],
  [40, 20],
];

const JUMP_HALF_WIDTH = [8, 9, 10]; // half the width of each jump's deck
const JUMP_SIDE = 5; // the sides slope down over this many metres

// --- Build the profile into lookup tables

const DS = 0.1; // metres between samples
const tags: Record<string, number> = {};
let S_MAX = S_MIN;
{
  let s = S_MIN;
  for (const [len, , tag] of PROGRAM) {
    s += len;
    if (tag) tags[tag] = s;
  }
  S_MAX = s;
}
const N = Math.ceil((S_MAX - S_MIN) / DS) + 1;
const mainH = new Float32Array(N); // the course line, jumps and all
const sideH = new Float32Array(N); // the go-around path beside the jumps
const naturalH = new Float32Array(N); // the untouched mountain beside the course
const halfWidth = new Float32Array(N); // jump deck half-width at each s (0 = no jump)

{
  // Angle at each sample: ease linearly between programme steps
  const angle = new Float32Array(N);
  let s0 = S_MIN;
  let a0 = START_ANGLE;
  for (const [len, a1] of PROGRAM) {
    const i0 = Math.round((s0 - S_MIN) / DS);
    const i1 = Math.min(N - 1, Math.round((s0 + len - S_MIN) / DS));
    for (let i = i0; i <= i1; i++) angle[i] = a0 + (a1 - a0) * ((i - i0) / Math.max(1, i1 - i0));
    s0 += len;
    a0 = a1;
  }
  // Integrate slope into height, with h = 0 at the start of the deck
  for (let i = 1; i < N; i++) {
    mainH[i] = mainH[i - 1] + Math.tan(THREE.MathUtils.degToRad(angle[i])) * DS;
  }
  const zero = mainH[Math.round((0 - S_MIN) / DS)];
  for (let i = 0; i < N; i++) mainH[i] -= zero;

  // Side path: under each jump, a straight cut from the start of the takeoff
  // to the end of the landing, never higher than the jump itself
  sideH.set(mainH);
  for (let j = 1; j <= 3; j++) {
    const a = tags[`j${j}:a`];
    const c = tags[`j${j}:c`];
    const ia = Math.round((a - S_MIN) / DS);
    const ic = Math.round((c - S_MIN) / DS);
    for (let i = ia; i <= ic; i++) {
      const t = (i - ia) / (ic - ia);
      const chord = mainH[ia] + (mainH[ic] - mainH[ia]) * t;
      // Ease in and out at the ends so the side path has no kinks
      const s = S_MIN + i * DS;
      const w = THREE.MathUtils.smoothstep(s, a, a + 8) * (1 - THREE.MathUtils.smoothstep(s, c - 8, c));
      sideH[i] = mainH[i] - w * Math.max(0, mainH[i] - chord);
      halfWidth[i] = JUMP_HALF_WIDTH[j - 1];
    }
  }

  // Natural mountain: the side path, heavily smoothed (±30 m average)
  const R = Math.round(30 / DS);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < Math.min(R, N); i++) {
    sum += sideH[i];
    count++;
  }
  for (let i = 0; i < N; i++) {
    const add = i + R;
    const drop = i - R - 1;
    if (add < N) {
      sum += sideH[add];
      count++;
    }
    if (drop >= 0) {
      sum -= sideH[drop];
      count--;
    }
    naturalH[i] = sum / count;
  }
}

// ---------------------------------------------------------------------------
// The course's centreline wanders left and right. Waypoints give its x at
// points down the course; between them it eases smoothly across. Each jump
// sits on a straight stretch, so the bends are in the roll-in and run-outs.

const BENDS: [s: number, x: number][] = [
  [S_MIN, 0],
  [tags['deck-end'], 0],
  [tags['j1:a'] - 4, -8], // roll-in eases left
  [tags['j1:knuckle'] + 18, -8],
  [tags['j2:a'] - 4, 8], // run-out bends right
  [tags['j2:knuckle'] + 20, 8],
  [tags['j3:a'] - 4, -4], // and back left
  [tags['j3:knuckle'] + 24, -4],
  [tags['finish'], 0], // straightens out for the finish
  [S_MAX, 0],
];
const centreX = new Float32Array(N);
const centreSlope = new Float32Array(N); // dx/ds of the centreline
{
  let k = 0;
  for (let i = 0; i < N; i++) {
    const s = S_MIN + i * DS;
    while (k < BENDS.length - 2 && s > BENDS[k + 1][0]) k++;
    const [s0, x0] = BENDS[k];
    const [s1, x1] = BENDS[k + 1];
    const t = THREE.MathUtils.clamp((s - s0) / (s1 - s0), 0, 1);
    centreX[i] = x0 + (x1 - x0) * t * t * t * (t * (t * 6 - 15) + 10); // smootherstep
  }
  for (let i = 0; i < N; i++) {
    const a = centreX[Math.max(0, i - 1)];
    const b = centreX[Math.min(N - 1, i + 1)];
    centreSlope[i] = (b - a) / (2 * DS);
  }
}

function lookup(table: Float32Array, s: number): number {
  const f = (THREE.MathUtils.clamp(s, S_MIN, S_MAX) - S_MIN) / DS;
  const i = Math.min(N - 2, Math.floor(f));
  const t = f - i;
  return table[i] * (1 - t) + table[i + 1] * t;
}

/** Course distance s for a world z, and back. */
export const sAt = (z: number): number => -z;
export const zAt = (s: number): number => -s;

/** x of the course's centreline at world z. */
export const courseX = (z: number): number => lookup(centreX, -z);

// Key places, as world z
export const DECK_END_Z = zAt(tags['deck-end']);
/** Riders start here: just over the edge of the roll-in, so gravity gets them going. */
export const START_Z = zAt(tags['deck-end'] + 1);
/** Riders can't go further back up than the back of the start deck. */
export const MAX_Z = zAt(tags['deck-end'] - 15);
export const FINISH_Z = zAt(tags['finish']);
export const BRAKE_Z = zAt(tags['brake']);
export const END_Z = zAt(tags['end']);
export const MOUNTAIN_TOP_Z = zAt(S_MIN);
export const MOUNTAIN_BOTTOM_Z = zAt(S_MAX);

export interface Jump {
  /** Takeoff starts, lip, table ends (knuckle), landing flattens out: world z. */
  startZ: number;
  lipZ: number;
  knuckleZ: number;
  endZ: number;
  halfWidth: number;
}
export const JUMPS: Jump[] = [1, 2, 3].map((j) => ({
  startZ: zAt(tags[`j${j}:a`]),
  lipZ: zAt(tags[`j${j}:lip`]),
  knuckleZ: zAt(tags[`j${j}:knuckle`]),
  endZ: zAt(tags[`j${j}:c`]),
  halfWidth: JUMP_HALF_WIDTH[j - 1],
}));

// ---------------------------------------------------------------------------
// Height

/** Small seeded PRNG so the mountain is the same on every reload. */
export function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const noise = createNoise2D(mulberry32(1337));

/** The mountain outside the course: rolling, rougher further out. */
function mountainNoise(x: number, z: number, ax: number): number {
  const amount = THREE.MathUtils.smoothstep(ax, BERM_TOP + 2, 90);
  if (amount === 0) return 0;
  return amount * (3 * noise(x / 70, z / 70) + 1 * noise(x / 20 + 50, z / 20));
}

/** Terrain height at world (x, z). Physics, meshes and colliders all use this. */
export function heightAt(x: number, z: number): number {
  // Work in course coordinates: u across the course from its centreline,
  // s along it. Where the course bends, measuring s along its direction
  // (not straight down z) turns the contours with it, so the fall line
  // follows the bend instead of running off into the berm.
  const s0 = -z;
  const slope = lookup(centreSlope, s0);
  const offset = x - lookup(centreX, s0);
  const s = s0 + offset * slope;
  const ax = Math.abs(offset) / Math.sqrt(1 + slope * slope); // distance across, square to the course
  const side = lookup(sideH, s);

  // On the course: the side path, raised into a jump deck near the middle
  let course = side;
  const hw = lookup(halfWidth, s);
  if (hw > 0) {
    const mask = 1 - THREE.MathUtils.smoothstep(ax, hw, hw + JUMP_SIDE);
    if (mask > 0) course += mask * (lookup(mainH, s) - side);
  }
  if (ax <= BERM_START) return course;

  // Edges: up the berm to the natural mountain, which carries on beyond
  const outside = lookup(naturalH, s) + BERM_HEIGHT * (1 - THREE.MathUtils.smoothstep(ax, BERM_TOP + 2, 45));
  const t = THREE.MathUtils.smoothstep(ax, BERM_START, BERM_TOP);
  return course + (outside - course) * t + mountainNoise(x, z, ax);
}

/** Surface normal at (x, z), from finite differences of heightAt. */
export function normalAt(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
  const e = 0.25;
  const dx = heightAt(x + e, z) - heightAt(x - e, z);
  const dz = heightAt(x, z + e) - heightAt(x, z - e);
  return out.set(-dx, 2 * e, -dz).normalize();
}

// ---------------------------------------------------------------------------
// Geometry (no DOM needed, so physics can build colliders from it in tests)

const COURSE_MESH_HALF = 27; // fine mesh: the course and its berms (follows the centreline)
const COURSE_CELL = 0.5;
const OUTER_HALF = 240; // coarse mesh: the mountain around it
const OUTER_CELL = 4;
const OUTER_HIDE = 25; // this close to the centreline the coarse mesh sinks out of sight

/**
 * A grid over x0..x1, z0..z1 with heights from fn, as indexed triangles.
 * shift(z) slides each row sideways (to follow the course's centreline).
 */
function gridGeometry(
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  cell: number,
  fn: (x: number, z: number) => number,
  shift: (z: number) => number = () => 0,
): THREE.BufferGeometry {
  const nx = Math.round((x1 - x0) / cell);
  const nz = Math.round((z1 - z0) / cell);
  const pos = new Float32Array((nx + 1) * (nz + 1) * 3);
  const uv = new Float32Array((nx + 1) * (nz + 1) * 2);
  let p = 0;
  let u = 0;
  for (let j = 0; j <= nz; j++) {
    const z = z0 + ((z1 - z0) * j) / nz;
    const dx = shift(z);
    for (let i = 0; i <= nx; i++) {
      const x = x0 + ((x1 - x0) * i) / nx + dx;
      pos[p++] = x;
      pos[p++] = fn(x, z);
      pos[p++] = z;
      uv[u++] = x / 4; // texture repeats every 4 m
      uv[u++] = z / 4;
    }
  }
  const idx = new Uint32Array(nx * nz * 6);
  let k = 0;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      const b = a + 1;
      const c = a + nx + 1;
      const d = c + 1;
      // counter-clockwise seen from above (z0 < z1 runs towards +Z)
      idx[k++] = a;
      idx[k++] = c;
      idx[k++] = b;
      idx[k++] = b;
      idx[k++] = c;
      idx[k++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  return geo;
}

let cached: { course: THREE.BufferGeometry; outer: THREE.BufferGeometry } | null = null;

/** The terrain's two surfaces: the fine course and the coarse mountain. */
export function terrainGeometry(): { course: THREE.BufferGeometry; outer: THREE.BufferGeometry } {
  if (cached) return cached;
  const zTop = MOUNTAIN_TOP_Z;
  const zBottom = MOUNTAIN_BOTTOM_Z;
  const course = gridGeometry(-COURSE_MESH_HALF, COURSE_MESH_HALF, zBottom, zTop, COURSE_CELL, heightAt, courseX);
  const outer = gridGeometry(-OUTER_HALF, OUTER_HALF, zBottom - 40, zTop + 40, OUTER_CELL, (x, z) => {
    // Under the course mesh, sink well out of sight
    const zc = THREE.MathUtils.clamp(z, zBottom, zTop);
    const h = heightAt(x, zc);
    return Math.abs(x - courseX(zc)) < OUTER_HIDE ? h - 3 : h;
  });
  cached = { course, outer };
  return cached;
}

// ---------------------------------------------------------------------------
// Meshes

function snowTexture(groomed: boolean): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#f4f7fb';
  ctx.fillRect(0, 0, size, size);
  const rand = mulberry32(groomed ? 7 : 11);
  if (groomed) {
    // Corduroy: fine grooves running down the fall line
    for (let x = 0; x < size; x += 4) {
      ctx.fillStyle = `rgba(150, 170, 195, ${0.1 + rand() * 0.06})`;
      ctx.fillRect(x, 0, 1.5, size);
    }
  }
  // Sparkle and unevenness
  for (let i = 0; i < 1800; i++) {
    const shade = rand() < 0.5 ? '255,255,255' : '170,185,205';
    ctx.fillStyle = `rgba(${shade}, ${rand() * 0.25})`;
    ctx.fillRect(rand() * size, rand() * size, 1 + rand() * 2, 1 + rand() * 2);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * A painted line across the snow at world z, from x0 to x1: like the blue
 * dye that marks lips and knuckles in a real park.
 */
function dyeLine(z: number, x0: number, x1: number, width: number, material: THREE.Material): THREE.Mesh {
  const pos: number[] = [];
  const idx: number[] = [];
  const steps = Math.ceil((x1 - x0) / 0.5);
  for (let i = 0; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps;
    for (const dz of [-width / 2, width / 2]) pos.push(x, heightAt(x, z + dz) + 0.03, z + dz);
    if (i < steps) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  return mesh;
}

export function createTerrain(): THREE.Group {
  const { course, outer } = terrainGeometry();
  const group = new THREE.Group();

  const courseMesh = new THREE.Mesh(
    course,
    new THREE.MeshStandardMaterial({ map: snowTexture(true), roughness: 0.85 }),
  );
  const outerMesh = new THREE.Mesh(
    outer,
    new THREE.MeshStandardMaterial({ map: snowTexture(false), roughness: 0.95 }),
  );
  for (const m of [courseMesh, outerMesh]) {
    m.receiveShadow = true;
    group.add(m);
  }

  // Blue dye across each jump's lip and knuckle, as in a real park
  const dye = new THREE.MeshStandardMaterial({ color: 0x2f6fd6, roughness: 0.9, side: THREE.DoubleSide });
  for (const j of JUMPS) {
    const w = j.halfWidth + 1;
    const cx = courseX(j.lipZ); // jumps sit on straight stretches
    group.add(dyeLine(j.lipZ + 0.3, cx - w, cx + w, 0.5, dye));
    group.add(dyeLine(j.knuckleZ - 0.5, cx - w, cx + w, 0.5, dye));
  }
  return group;
}
