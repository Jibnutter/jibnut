import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';

/**
 * The maps. Each is one mountain the course runs down, along -Z
 * (s = distance down the course = -z).
 *
 *   Jumpline      a slopestyle park: a start deck, a steep roll-in, three
 *                 big tabletop jumps (each bigger than the last) and a flat
 *                 finish with an uphill braking zone, between snow berms.
 *   Backcountry   a steep, wild mountain: a kicker just below the start,
 *                 then a steep face broken by three bands of rocky cliffs,
 *                 each with a way round, down to a valley at the bottom.
 *
 * The whole surface is one smooth height function, so physics, meshes and
 * colliders all agree. Features (tabletops, cliffs, the kicker) are part of
 * it. One map is active per page load, picked from the URL (?map=...).
 */

type Step = [length: number, angle: number, tag?: string];

/**
 * A band of cliffs across the slope at a tagged point: above it the slope
 * flattens into a bench (raised up to `depth`), which then drops `depth`
 * metres in a near-vertical rock face back to the mountain. Across the
 * course it spans u = from..to (metres right of the centreline), tapering
 * off at its ends: ride round it there.
 */
interface Cliff {
  tag: string;
  depth: number;
  bench: number; // m of bench above the drop
  from: number;
  to: number;
}

/** A kicker (a short, steep jump ramp) ending in its lip at a tagged point. */
interface Kicker {
  tag: string;
  height: number; // of the lip above the slope
  length: number;
  halfWidth: number;
}

/** What the menu shows about a map. */
export interface MapInfo {
  id: string;
  name: string;
  description: string;
  features: string[];
}

interface MapDef extends MapInfo {
  sMin: number; // the mountain starts this far above the start
  startAngle: number;
  program: Step[]; // slope angles (degrees; negative = downhill) down the course
  /** Tabletop jumps standing above a side path: tags j:a, j:lip, j:knuckle, j:c (j = 1, 2, ...). */
  tabletops: number[]; // half-width of each one's deck
  bends: (tag: Record<string, number>) => [s: number, x: number][];
  courseHalf: number; // half the width of the groomed course (park markings)
  bermStart: number; // where the edge berms (or the wild mountain) begin ...
  bermTop: number; // ... and rise to their top
  bermHeight: number;
  edgeLimit: number; // riders are kept this close to the centreline
  meshHalf: number; // fine terrain mesh: this far either side of the centreline
  meshCell: number;
  /** Rolls and lumps on the riding surface itself (m), from this far down. */
  wild: { amount: number; from: string };
  cliffs: Cliff[];
  kicker?: Kicker;
  /** A park: lift, start and finish arches, fencing, marker poles. */
  park: boolean;
  /** How much of the quirky hop after a hard landing (1 = full). */
  bounce: number;
  /** Untracked deep snow holding the skis back (1/s: m/s² per m/s of speed). */
  snowDrag: number;
  /** Where the menu's camera circles: the feature at this tag, offset across. */
  showcase: { tag: string; x: number };
}

const JUMPLINE: MapDef = {
  id: 'jumpline',
  name: 'Jumpline',
  description: 'A slopestyle line down the mountain: three tabletops, each bigger than the last, in deep powder.',
  features: ['3 tabletop jumps: 15, 18 and 21 m', 'Down rail beside the first jump', 'Deep powder'],
  sMin: -80,
  startAngle: -22,
  // The course profile, as a programme of slope angles. Each step eases the
  // slope from the previous angle to a new one over a length of course, so
  // the surface is smooth; short steps make sharp features like lips and
  // knuckles. Tags mark points the code needs.
  program: [
    [45, -22],
    [20, 0], // ease onto the start deck
    [17, 0, 'deck-end'],
    [8, -27], // drop into the roll-in
    [32, -27],

    // Jump 1
    [10, -14],
    [16, -14, '1:a'], // approach
    [12, 24], // takeoff: curves up to a 24° lip
    [0.8, -4, '1:lip'],
    [15, -4, '1:knuckle'], // 15 m table
    [4, -32],
    [28, -32], // landing
    [16, -10, '1:c'], // flattens into the run-out

    // Jump 2 (the run-out bends right to get here)
    [40, -10, '2:a'],
    [13, 26],
    [0.8, -4, '2:lip'],
    [18, -4, '2:knuckle'], // 18 m table
    [4, -33],
    [32, -33],
    [16, -10, '2:c'],

    // Jump 3: the biggest (after a bend back left)
    [40, -10, '3:a'],
    [14, 28],
    [0.8, -4, '3:lip'],
    [21, -4, '3:knuckle'], // 21 m table
    [4, -34],
    [36, -34],
    [18, -10, '3:c'],

    // Finish
    [20, -6],
    [15, 0, 'finish'],
    [40, 0],
    [10, 10, 'brake'], // uphill braking zone
    [22, 10, 'end'],
    [10, 20],
    [40, 20],
  ],
  tabletops: [8, 9, 10],
  // The centreline wanders left and right; each jump sits on a straight
  // stretch, so the bends are in the roll-in and run-outs
  bends: (t) => [
    [-80, 0],
    [t['deck-end'], 0],
    [t['1:a'] - 4, -8], // roll-in eases left
    [t['1:knuckle'] + 18, -8],
    [t['2:a'] - 4, 8], // run-out bends right
    [t['2:knuckle'] + 20, 8],
    [t['3:a'] - 4, -4], // and back left
    [t['3:knuckle'] + 24, -4],
    [t['finish'], 0], // straightens out for the finish
  ],
  courseHalf: 20,
  bermStart: 20,
  bermTop: 24,
  bermHeight: 1.4,
  edgeLimit: 23,
  meshHalf: 27,
  meshCell: 0.5,
  wild: { amount: 0, from: 'deck-end' },
  cliffs: [],
  park: true,
  bounce: 1,
  snowDrag: 0, // groomed
  showcase: { tag: '1:lip', x: 4 },
};

const BACKCOUNTRY: MapDef = {
  id: 'backcountry',
  name: 'Backcountry',
  description: 'No park, no lift: a steep, wild face broken by bands of rocky cliffs. Hit the kicker off the top, then pick your drops.',
  features: ['Kicker below the start', '3 cliff bands: 7, 10 and 14 m drops', 'Steep: up to 33°'],
  sMin: -70,
  startAngle: -26,
  program: [
    [40, -26], // the summit ridge above
    [20, -18], // easing onto a steep shoulder ...
    [10, -18, 'deck-end'], // ... where you start
    [14, -21], // steepening towards the kicker
    [8, -21, 'kick'], // the kicker's lip
    [14, -32], // then the face drops away (the landing)
    [36, -32],
    [10, -28, 'c1'], // cliff band 1
    [30, -31],
    [12, -27],
    [10, -27, 'c2'], // cliff band 2
    [36, -33],
    [14, -29],
    [10, -29, 'c3'], // cliff band 3: the big one
    [40, -33],
    [30, -24],
    [40, -14],
    [30, -6, 'finish'], // the valley
    [30, -3],
    [10, 8, 'brake'],
    [22, 9, 'end'],
    [10, 18],
    [40, 18],
  ],
  tabletops: [],
  // The face swings a little left, back right, then out into the valley
  bends: (t) => [
    [-70, 0],
    [t['kick'] + 6, 0],
    [t['c1'] + 10, -10],
    [t['c2'] + 10, 6],
    [t['c3'] + 30, -6],
    [t['finish'], 0],
  ],
  courseHalf: 20,
  // No berms: open mountain all the way across
  bermStart: 70,
  bermTop: 90,
  bermHeight: 0,
  edgeLimit: 62,
  meshHalf: 72,
  meshCell: 0.6,
  wild: { amount: 0.8, from: 'kick' },
  cliffs: [
    // Each band covers part of the face; ride round it at the open end
    // (Benches ~2.2x the drop: long enough to run out level to the edge)
    { tag: 'c1', depth: 7, bench: 16, from: -34, to: 12 },
    { tag: 'c2', depth: 10, bench: 22, from: -8, to: 40 },
    { tag: 'c3', depth: 14, bench: 31, from: -42, to: 24 },
  ],
  // (Tall for its length: on the steep run-in its lip still points up, ~+12°)
  kicker: { tag: 'kick', height: 2.3, length: 7, halfWidth: 3.5 },
  park: false,
  bounce: 0.4,
  // Deep, untracked powder: it holds you back, so even the steepest pitches
  // top out around 70-80 km/h (on groomed snow they'd pass 110)
  snowDrag: 0.12,
  showcase: { tag: 'c1', x: -6 },
};

/** Every map, in menu order. */
export const MAPS: MapInfo[] = [JUMPLINE, BACKCOUNTRY].map(({ id, name, description, features }) => ({
  id,
  name,
  description,
  features,
}));

/** The map this page load runs (?map=<id>; Jumpline if none). */
const M: MapDef = (() => {
  const loc = (globalThis as { location?: { search: string } }).location;
  const id = loc ? new URLSearchParams(loc.search).get('map') : null;
  return [JUMPLINE, BACKCOUNTRY].find((m) => m.id === id) ?? JUMPLINE;
})();
export const MAP: MapInfo = MAPS.find((m) => m.id === M.id)!;
/** Whether this map is a park (lift, arches, fencing). */
export const IS_PARK = M.park;
/** How much of the quirky landing hop this map has. */
export const MAP_BOUNCE = M.bounce;
/** How hard this map's snow holds the skis back (1/s). */
export const SNOW_DRAG = M.snowDrag;

export const COURSE_HALF = M.courseHalf;
const BERM_START = M.bermStart;
const BERM_TOP = M.bermTop;
const BERM_HEIGHT = M.bermHeight;
/** Riders are kept this close to the centreline (between the berms in the park). */
export const EDGE_LIMIT = M.edgeLimit;

const S_MIN = M.sMin;
const START_ANGLE = M.startAngle;
const PROGRAM = M.program;
const JUMP_SIDE = 5; // the sides of a tabletop slope down over this many metres

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
  for (let j = 1; j <= M.tabletops.length; j++) {
    const a = tags[`${j}:a`];
    const c = tags[`${j}:c`];
    const ia = Math.round((a - S_MIN) / DS);
    const ic = Math.round((c - S_MIN) / DS);
    for (let i = ia; i <= ic; i++) {
      const t = (i - ia) / (ic - ia);
      const chord = mainH[ia] + (mainH[ic] - mainH[ia]) * t;
      // Ease in and out at the ends so the side path has no kinks
      const s = S_MIN + i * DS;
      const w = THREE.MathUtils.smoothstep(s, a, a + 8) * (1 - THREE.MathUtils.smoothstep(s, c - 8, c));
      sideH[i] = mainH[i] - w * Math.max(0, mainH[i] - chord);
      halfWidth[i] = M.tabletops[j - 1];
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
// The course's centreline wanders left and right. Waypoints (from the map)
// give its x at points down the course; between them it eases smoothly
// across.

const BENDS: [s: number, x: number][] = [...M.bends(tags), [S_MAX, 0]];
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
/** The map's jumps, in order down the course: tabletops, or a kicker (no table: knuckle = lip). */
export const JUMPS: Jump[] = M.kicker
  ? [
      {
        startZ: zAt(tags[M.kicker.tag] - M.kicker.length),
        lipZ: zAt(tags[M.kicker.tag]),
        knuckleZ: zAt(tags[M.kicker.tag]),
        endZ: zAt(tags[M.kicker.tag] + 30),
        halfWidth: M.kicker.halfWidth,
      },
    ]
  : M.tabletops.map((hw, k) => ({
      startZ: zAt(tags[`${k + 1}:a`]),
      lipZ: zAt(tags[`${k + 1}:lip`]),
      knuckleZ: zAt(tags[`${k + 1}:knuckle`]),
      endZ: zAt(tags[`${k + 1}:c`]),
      halfWidth: hw,
    }));

/** Where the menu's camera circles (world x, z). */
export const SHOWCASE = (() => {
  const z = zAt(tags[M.showcase.tag]);
  return { x: courseX(z) + M.showcase.x, z };
})();

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

/**
 * The map's own features, as height added to the slope at course
 * coordinates (s down, u across): cliff bands, the kicker, and the rolls
 * and lumps of wild terrain.
 */
function features(s: number, u: number, x: number, z: number): number {
  let h = 0;
  if (M.wild.amount > 0) {
    // Rolls and lumps, fading in below where they start
    const fade = THREE.MathUtils.smoothstep(s, tags[M.wild.from] + 6, tags[M.wild.from] + 26);
    if (fade > 0) h += fade * M.wild.amount * (0.7 * noise(x / 28 + 300, z / 28) + 0.3 * noise(x / 9 + 400, z / 9));
  }
  for (let k = 0; k < M.cliffs.length; k++) {
    const c = M.cliffs[k];
    // The band's edge wanders a little up and down the slope
    const edge = tags[c.tag] + 2.5 * noise(u / 14, 40 + k * 17);
    const d = s - edge;
    if (d < -c.bench || d > 1.2) continue;
    // Across: full height over the band, tapering off at its ends
    const taper = Math.max(6, c.depth);
    const across = THREE.MathUtils.smoothstep(u, c.from - taper, c.from) * (1 - THREE.MathUtils.smoothstep(u, c.to, c.to + taper));
    if (across <= 0) continue;
    // Down: the bench rises (flattening the slope above the drop), then the
    // face drops back. The rise eases in, then climbs steadily: so the
    // bench runs out about level to its edge. (Curving up all the way, the
    // edge pointed up to 28° uphill: a launch ramp, throwing riders onto
    // their backs on the steep slope below.)
    const t = (d + c.bench) / c.bench;
    const rise = d <= 0 ? benchRise(t) : 1 - THREE.MathUtils.smoothstep(d, 0, 1.2);
    h += c.depth * rise * across;
  }
  if (M.kicker) {
    const k = M.kicker;
    const d = s - tags[k.tag];
    if (d > -k.length && d < 0.5 && Math.abs(u) < k.halfWidth + 1.5) {
      const across = 1 - THREE.MathUtils.smoothstep(Math.abs(u), k.halfWidth, k.halfWidth + 1.5);
      // Curving up to the lip, then straight down at its back
      const t = (d + k.length) / k.length;
      const up = d <= 0 ? t * t : 1 - THREE.MathUtils.smoothstep(d, 0, 0.5);
      h += k.height * up * across;
    }
  }
  return h;
}

/** A cliff's bench, 0 -> 1 along it: easing in over the first 40%, then straight. */
function benchRise(t: number): number {
  const a = 0.4;
  const k = 1 / (1 - a / 2); // the steady part's slope (the whole rise is 1)
  return t < a ? (k * t * t) / (2 * a) : k * (a / 2 + (t - a));
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
  const u = offset / Math.sqrt(1 + slope * slope); // distance across, square to the course (+ = right)
  const ax = Math.abs(u);
  const side = lookup(sideH, s) + features(s, u, x, z);

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

/**
 * Deep powder lies on top of the surface the skis ride on (heightAt): this
 * deep on average, so the skis are buried in it, and gently lumpy.
 */
export const POWDER_DEPTH = 0.09;

/** Top of the powder at (x, z): what you see (riding uses heightAt). */
export function powderAt(x: number, z: number): number {
  return heightAt(x, z) + POWDER_DEPTH + 0.03 * noise(x / 3 + 200, z / 3) + 0.015 * noise(x / 1.2, z / 1.2 + 90);
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

const COURSE_MESH_HALF = M.meshHalf; // fine mesh: the course and its berms (follows the centreline)
const COURSE_CELL = M.meshCell;
const OUTER_HALF = 240; // coarse mesh: the mountain around it
const OUTER_CELL = 4;
const OUTER_HIDE = COURSE_MESH_HALF - 2; // this close to the centreline the coarse mesh sinks out of sight

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
  // Soft drifts: faint broad shading, like wind-blown powder
  for (let i = 0; i < 40; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 20 + rand() * 50;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(190, 205, 225, ${0.05 + rand() * 0.05})`);
    g.addColorStop(1, 'rgba(190, 205, 225, 0)');
    ctx.fillStyle = g;
    for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) ctx.fillRect(x - r + ox, y - r + oy, 2 * r, 2 * r);
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
    for (const dz of [-width / 2, width / 2]) pos.push(x, powderAt(x, z + dz) + 0.02, z + dz);
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

/** The terrain as you see it: covered in powder (lifted to powderAt). */
// ---------------------------------------------------------------------------
// Baked ambient occlusion: how much of the sky each point of the terrain can
// see. Computed once at load from the height function (the terrain never
// changes), so it's free while playing: a lightmap without a lightmap.

const AO_CELL = 2; // m: worked out on this grid, blended in between
const AO_DIRECTIONS = 8;
const AO_STEPS = [1, 2, 3.5, 5.5, 8, 12, 17, 25, 36]; // m out from the point
const AO_STRENGTH = 0.75; // how dark fully hemmed-in snow gets (1 = black)
const aoCache = new Map<number, number>();

/**
 * Sky visibility at a grid point (1 = open sky, lower = hemmed in). In each
 * direction, the steepest rise of the terrain above the point's own slope
 * (so an even slope isn't darkened: only walls, lips and hollows are).
 */
function aoAt(ix: number, iz: number): number {
  const key = ix * 100003 + iz;
  const cached = aoCache.get(key);
  if (cached !== undefined) return cached;
  const x = ix * AO_CELL;
  const z = iz * AO_CELL;
  const h0 = heightAt(x, z);
  const e = 0.75;
  const gx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
  const gz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
  let occluded = 0;
  for (let d = 0; d < AO_DIRECTIONS; d++) {
    const a = (d / AO_DIRECTIONS) * Math.PI * 2;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const own = gx * dx + gz * dz; // the slope's own rise this way
    let maxRise = 0;
    for (const r of AO_STEPS) {
      const rise = (heightAt(x + dx * r, z + dz * r) - h0) / r - own;
      if (rise > maxRise) maxRise = rise;
    }
    occluded += Math.sin(Math.atan(maxRise)); // how much of this side's sky is hidden
  }
  const visibility = 1 - AO_STRENGTH * (occluded / AO_DIRECTIONS);
  aoCache.set(key, visibility);
  return visibility;
}

/** Sky visibility at (x, z), blended from the grid around it. */
function skyVisibility(x: number, z: number): number {
  const fx = x / AO_CELL;
  const fz = z / AO_CELL;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = fx - ix;
  const tz = fz - iz;
  const a = aoAt(ix, iz) * (1 - tx) + aoAt(ix + 1, iz) * tx;
  const b = aoAt(ix, iz + 1) * (1 - tx) + aoAt(ix + 1, iz + 1) * tx;
  return a * (1 - tz) + b * tz;
}

function powderGeometry(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = geo.clone();
  const pos = out.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    // (The coarse mesh's part hidden under the course stays sunk)
    const h = heightAt(x, z);
    if (Math.abs(pos.getY(i) - h) < 0.5) pos.setY(i, powderAt(x, z));
  }
  out.computeVertexNormals();
  // Snow won't stick to steep faces: cliffs show bare dark rock, blending
  // through snow-dusted rock on the slightly gentler edges
  const nrm = out.attributes.normal as THREE.BufferAttribute;
  const color = new Float32Array(pos.count * 3);
  const snow = new THREE.Color(0xffffff);
  const rock = new THREE.Color(0x4a4744).convertSRGBToLinear();
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const bare = THREE.MathUtils.smoothstep(1 - nrm.getY(i), 0.42, 0.62); // ~55° to ~68°
    c.lerpColors(snow, rock, bare);
    // Baked sky visibility: hollows and the feet of walls see less sky
    c.multiplyScalar(skyVisibility(pos.getX(i), pos.getZ(i)));
    c.toArray(color, i * 3);
  }
  out.setAttribute('color', new THREE.BufferAttribute(color, 3));
  return out;
}

export function createTerrain(): THREE.Group {
  const { course, outer } = terrainGeometry();
  const group = new THREE.Group();

  const powder = new THREE.MeshStandardMaterial({ map: snowTexture(false), roughness: 0.9, vertexColors: true });
  const courseMesh = new THREE.Mesh(powderGeometry(course), powder);
  const outerMesh = new THREE.Mesh(powderGeometry(outer), powder);
  for (const m of [courseMesh, outerMesh]) {
    m.receiveShadow = true;
    m.castShadow = true; // jumps, cliffs and ridges shade the snow beyond them
    group.add(m);
  }

  // The finish line: red dye across the course, under the arch
  const finishZ = zAt(tags['finish']);
  const fx = courseX(finishZ);
  const span = M.park ? COURSE_HALF + 1 : 26;
  group.add(dyeLine(finishZ, fx - span, fx + span, 0.6, new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.9, side: THREE.DoubleSide })));

  // Blue dye across each jump's lip and knuckle, as in a real park
  const dye = new THREE.MeshStandardMaterial({ color: 0x2f6fd6, roughness: 0.9, side: THREE.DoubleSide });
  for (const j of JUMPS) {
    const w = j.halfWidth + 1;
    const cx = courseX(j.lipZ); // jumps sit on straight stretches
    group.add(dyeLine(j.lipZ + 0.3, cx - w, cx + w, 0.5, dye));
    if (j.knuckleZ !== j.lipZ) group.add(dyeLine(j.knuckleZ - 0.5, cx - w, cx + w, 0.5, dye));
  }
  return group;
}
