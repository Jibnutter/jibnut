// Jibnut
// Copyright (C) 2026 Frans Ljung
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE
// file for details.

import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';
import { loadMaps, decodeSculpt, SCULPT, GRID_W, GRID_H, MAP_BUILDER_ENABLED, type CustomMap } from './customMaps';

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
  /** Powder only between these tags (down the course); everywhere if not given. */
  powderOnly?: { from: string; to: string };
  /** How much of the quirky hop after a hard landing (1 = full). */
  bounce: number;
  /** Untracked deep snow holding the skis back (1/s: m/s² per m/s of speed). */
  snowDrag: number;
  /** Where the menu's camera circles: the feature at this tag, offset across. */
  showcase: { tag: string; x: number };
  /** Summer: dirt and grass, no snow (and you ride the bike). */
  summer?: boolean;
  /** Dirt doubles: a takeoff and a landing mound with an open gap between. */
  doubles?: Double[];
  /** A wooden drop: a ramp up onto a deck that ends in a drop to the slope below. */
  drop?: Drop;
}

/**
 * A dirt double, built up from the ground at its lip's tag: a takeoff
 * curving up to the lip, a steep back, an open gap (the bare ground), then
 * the landing mound: a steep face, a short flat top and the landing,
 * rounding down to the ground again.
 */
interface Double {
  tag: string; // the lip
  height: number; // lip, above the ground
  takeoff: number; // m of takeoff
  gap: number; // m from the lip to the foot of the landing's face
  landHeight: number; // the landing's top, above the ground
  top: number; // m of flat top before the landing goes down
  landing: number; // m of landing
  halfWidth: number;
}

/** A wooden drop deck ending at its edge's tag: ramp up, level-ish deck, drop. */
interface Drop {
  tag: string; // the edge
  height: number; // of the edge above the slope
  ramp: number; // m of ramp up onto the deck
  deck: number; // m of deck
  halfWidth: number;
}

const JUMPLINE: MapDef = {
  id: 'jumpline',
  name: 'Jumpline',
  description: 'A groomed slopestyle line down the mountain: three tabletops, each bigger than the last, the biggest landing in deep powder.',
  features: ['3 tabletop jumps: 15, 18 and 21 m', 'Down rail beside the first jump', 'Powder landing on the last jump'],
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
  // Groomed, except the last jump's landing: a pillow of deep powder
  powderOnly: { from: '3:knuckle', to: '3:c' },
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
const SUMMER: MapDef = {
  id: 'summer',
  name: 'Summer Dirt',
  description: 'The snow is gone: a steep downhill track down a grassy hill. Four big dirt gaps, each bigger than the last, then a big wooden drop. Commit or case it.',
  features: ['4 dirt gap jumps: 10 to 21.5 m gaps', 'Wooden drop: 4 m', 'Steep and fast: up to 90 km/h, bike only'],
  sMin: -70,
  startAngle: -18,
  program: [
    [50, -18], // the hilltop above
    [15, 0], // easing onto the start deck
    [12, 0, 'deck-end'],
    [6, -24], // the roll-in: steep
    [16, -24],
    [10, -10, 'trail'], // onto the dirt line

    // The gaps, down a steep track: no pedalling needed, the hill brings
    // the speed (and each gap is sized for what it has built up)
    [14, -10],
    [4, -10, 'd1'],
    [46, -11, 'd2'],
    [52, -12, 'd3'],
    [58, -12, 'd4'],

    // The drop: its deck stands on a flat bench (scrubbing off some speed);
    // past the edge the landing falls away steeply
    [40, -10],
    [20, 3],
    [25, 0, 'drop'],
    [4, -38],
    [30, -38],
    [18, -8],

    // Finish
    [20, -6, 'finish'],
    [30, -3],
    [10, 8, 'brake'],
    [22, 9, 'end'],
    [10, 16],
    [40, 16],
  ],
  tabletops: [],
  // A gentle S down the hill; straight through the jumps and the drop
  bends: (t) => [
    [-70, 0],
    [t['deck-end'], 0],
    [t['trail'] + 2, 4],
    [t['d1'] - 12, 4],
    [t['d4'] + 40, 4],
    [t['drop'] - 26, -3],
    [t['drop'] + 30, -3],
    [t['finish'], 0],
  ],
  courseHalf: 14,
  bermStart: 30,
  bermTop: 40,
  bermHeight: 0,
  edgeLimit: 34,
  meshHalf: 40,
  meshCell: 0.4,
  wild: { amount: 0.25, from: 'trail' },
  cliffs: [],
  park: false,
  bounce: 0.5,
  snowDrag: 0,
  showcase: { tag: 'd3', x: 6 },
  summer: true,
  doubles: [
    { tag: 'd1', height: 1.8, takeoff: 6, gap: 10, landHeight: 1.6, top: 1.0, landing: 13, halfWidth: 2.6 },
    { tag: 'd2', height: 2.0, takeoff: 6.5, gap: 14, landHeight: 1.8, top: 1.0, landing: 14, halfWidth: 2.8 },
    { tag: 'd3', height: 2.2, takeoff: 7, gap: 17.5, landHeight: 2.0, top: 1.2, landing: 15, halfWidth: 3 },
    { tag: 'd4', height: 2.4, takeoff: 7.5, gap: 21.5, landHeight: 2.2, top: 1.2, landing: 16, halfWidth: 3 },
  ],
  drop: { tag: 'drop', height: 4, ramp: 16, deck: 7, halfWidth: 1.5 },
};

/**
 * A map made in the map builder: a plain, even slope with a flat start at
 * the top and a run-out and braking zone at the bottom, wide open across.
 * Everything else (the shape, lips, trees, spawn) the player adds.
 */
function customDef(map: CustomMap): MapDef {
  return {
    id: map.id,
    name: map.name,
    description: 'A map you built.',
    features: ['Your own map'],
    sMin: -SCULPT.topZ,
    startAngle: 0,
    program: [
      [10, 0],
      [16, 0, 'deck-end'], // (the start: at z = 0)
      [10, -20],
      [520, -21],
      [50, -6],
      [20, 0, 'finish'],
      [30, 0],
      [10, 10, 'brake'],
      [22, 10, 'end'],
      [10, 18],
      [40, 18],
    ],
    tabletops: [],
    bends: () => [[-SCULPT.topZ, 0]],
    courseHalf: 20,
    bermStart: 200, // (no berms: open across the whole editable area)
    bermTop: 220,
    bermHeight: 0,
    edgeLimit: SCULPT.halfX - 6,
    meshHalf: SCULPT.halfX,
    meshCell: SCULPT.cell,
    wild: { amount: 0, from: 'deck-end' },
    cliffs: [],
    park: false,
    bounce: 0.6,
    snowDrag: 0.05,
    showcase: { tag: 'deck-end', x: 0 },
  };
}

const CUSTOM_MAPS = loadMaps();

export const MAPS: MapInfo[] = [JUMPLINE, BACKCOUNTRY, SUMMER, ...(MAP_BUILDER_ENABLED ? CUSTOM_MAPS.map(customDef) : [])].map(
  ({ id, name, description, features }) => ({ id, name, description, features }),
);

/** The custom map this page load runs, if it's one (else null). */
export const CUSTOM: CustomMap | null = (() => {
  const loc = (globalThis as { location?: { search: string } }).location;
  const id = loc ? new URLSearchParams(loc.search).get('map') : null;
  return MAP_BUILDER_ENABLED ? (CUSTOM_MAPS.find((m) => m.id === id) ?? null) : null;
})();

/** The map this page load runs (?map=<id>; Jumpline if none). */
const M: MapDef = (() => {
  if (CUSTOM) return customDef(CUSTOM);
  const loc = (globalThis as { location?: { search: string } }).location;
  const id = loc ? new URLSearchParams(loc.search).get('map') : null;
  return [JUMPLINE, BACKCOUNTRY, SUMMER].find((m) => m.id === id) ?? JUMPLINE;
})();
export const MAP: MapInfo = MAPS.find((m) => m.id === M.id)!;
/** Whether this map is a park (lift, arches, fencing). */
export const IS_PARK = M.park;
/** How much of the quirky landing hop this map has. */
export const MAP_BOUNCE = M.bounce;
/** Summer: dirt and grass, no snow, and you ride the bike. */
export const SUMMER_MAP = !!M.summer;
/** How hard this map's snow holds the skis back (1/s). */
export const SNOW_DRAG = M.snowDrag;

export const COURSE_HALF = M.courseHalf;
const BERM_START = M.bermStart;
const BERM_TOP = M.bermTop;
const BERM_HEIGHT = M.bermHeight;
/** Riders are kept this close to the centreline (between the berms in the park). */
export const EDGE_LIMIT = M.edgeLimit;
/** Where riders start: a custom map's spawn point (x, z, facing), else the top of the course. */
export const SPAWN = CUSTOM ? { ...CUSTOM.spawn } : null;

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
/** The map's jumps, in order down the course: tabletops, a kicker (no table: knuckle = lip), dirt doubles (knuckle: the landing's top) and the drop (lip: its edge). */
export const JUMPS: Jump[] = [
  ...(M.kicker
    ? [
        {
          startZ: zAt(tags[M.kicker.tag] - M.kicker.length),
          lipZ: zAt(tags[M.kicker.tag]),
          knuckleZ: zAt(tags[M.kicker.tag]),
          endZ: zAt(tags[M.kicker.tag] + 30),
          halfWidth: M.kicker.halfWidth,
        },
      ]
    : []),
  ...M.tabletops.map((hw, k) => ({
    startZ: zAt(tags[`${k + 1}:a`]),
    lipZ: zAt(tags[`${k + 1}:lip`]),
    knuckleZ: zAt(tags[`${k + 1}:knuckle`]),
    endZ: zAt(tags[`${k + 1}:c`]),
    halfWidth: hw,
  })),
  ...(M.doubles ?? []).map((d) => {
    const lip = tags[d.tag];
    const sp = doubleSpan(d);
    return { startZ: zAt(lip - d.takeoff), lipZ: zAt(lip), knuckleZ: zAt(lip + sp.top + d.top), endZ: zAt(lip + sp.end), halfWidth: d.halfWidth };
  }),
  ...(M.drop
    ? [
        {
          startZ: zAt(tags[M.drop.tag] - M.drop.deck - M.drop.ramp),
          lipZ: zAt(tags[M.drop.tag]),
          knuckleZ: zAt(tags[M.drop.tag]),
          endZ: zAt(tags[M.drop.tag] + 16),
          halfWidth: M.drop.halfWidth,
        },
      ]
    : []),
];

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
  if (M.doubles) {
    for (const d of M.doubles) h += doubleHeight(d, s - tags[d.tag], Math.abs(u));
  }
  if (M.drop) h += dropHeight(M.drop, s, Math.abs(u));
  return h;
}

const DIRT_SIDE = 1.1; // m: a dirt jump's sides fall away over this
const DECK_SIDE = 0.25; // m: the wooden deck's sides (near vertical: boarded)
const DECK_ANGLE = Math.tan(THREE.MathUtils.degToRad(3)); // the deck runs down this gently

/** Where a double's landing mound starts and ends (m from the lip). */
function doubleSpan(d: Double): { face: number; top: number; end: number } {
  const face = d.gap; // foot of the landing's face
  const top = face + 1.2; // (the face rises over 1.2 m)
  return { face, top, end: top + d.top + d.landing };
}

/** Height a dirt double adds, at dist m past its lip, au across. */
function doubleHeight(d: Double, dist: number, au: number): number {
  const sp = doubleSpan(d);
  if (dist < -d.takeoff || dist > sp.end || au > d.halfWidth + DIRT_SIDE) return 0;
  const across = 1 - THREE.MathUtils.smoothstep(au, d.halfWidth, d.halfWidth + DIRT_SIDE);
  let up: number;
  if (dist <= 0) {
    // The takeoff: curving up to the lip (y = H t²: its lip angle is 2H/L above the ground)
    const t = (dist + d.takeoff) / d.takeoff;
    up = d.height * t * t;
  } else if (dist < sp.face) {
    // The lip's steep back, then the open gap
    up = d.height * (1 - THREE.MathUtils.smoothstep(dist, 0, 0.9));
  } else if (dist < sp.top) {
    up = d.landHeight * THREE.MathUtils.smoothstep(dist, sp.face, sp.top);
  } else if (dist < sp.top + d.top) {
    up = d.landHeight;
  } else {
    // The landing: rounding over the knuckle, steepest midway, rounding into the ground
    const t = (dist - sp.top - d.top) / d.landing;
    up = d.landHeight * (0.5 + 0.5 * Math.cos(Math.PI * t));
  }
  return up * across;
}

/** Height the wooden drop adds at course distance s, au across. */
function dropHeight(d: Drop, s: number, au: number): number {
  const edge = tags[d.tag];
  const start = edge - d.deck - d.ramp;
  const deckStart = start + d.ramp;
  if (s < start || s > edge + DECK_SIDE || au > d.halfWidth + DECK_SIDE) return 0;
  const across = 1 - THREE.MathUtils.smoothstep(au, d.halfWidth, d.halfWidth + DECK_SIDE);
  // The deck's top: a straight line from the edge back up, gently
  const deckTop = (x: number) => lookup(mainH, edge) + d.height + DECK_ANGLE * (edge - x);
  let above: number;
  if (s < deckStart) {
    // The ramp: a straight board from the ground up to the deck, its foot
    // eased in (no kink to bump over)
    const t = (s - start) / d.ramp;
    const a = 0.15;
    const lin = t < a ? (t * t) / (2 * a) : t - a / 2;
    const ground = (x: number) => lookup(mainH, x);
    const boardTop = ground(start) + ((deckTop(deckStart) - ground(start)) * lin) / (1 - a / 2);
    above = boardTop - ground(s);
  } else {
    above = deckTop(s) - lookup(mainH, s);
    if (s > edge) above *= 1 - THREE.MathUtils.smoothstep(s, edge, edge + DECK_SIDE); // the drop
  }
  return Math.max(0, above) * across;
}

/** Is course point (s, u) on the drop's deck or ramp (for the boarding)? */
export function dropDeck(): { start: number; deckStart: number; edge: number; halfWidth: number } | null {
  const d = M.drop;
  if (!d) return null;
  const edge = tags[d.tag];
  return { start: edge - d.deck - d.ramp, deckStart: edge - d.deck, edge, halfWidth: d.halfWidth };
}

/** A cliff's bench, 0 -> 1 along it: easing in over the first 40%, then straight. */
function benchRise(t: number): number {
  const a = 0.4;
  const k = 1 / (1 - a / 2); // the steady part's slope (the whole rise is 1)
  return t < a ? (k * t * t) / (2 * a) : k * (a / 2 + (t - a));
}

// Course coordinates of the last point given to courseCoords (module
// scratch: heightAt runs constantly, so nothing is allocated)
let cs = 0;
let cu = 0;

/**
 * Course coordinates of world (x, z): u across the course from its
 * centreline, s along it. Where the course bends, measuring s along its
 * direction (not straight down z) turns the contours with it, so the fall
 * line follows the bend instead of running off into the berm.
 */
function courseCoords(x: number, z: number): void {
  const s0 = -z;
  const slope = lookup(centreSlope, s0);
  const offset = x - lookup(centreX, s0);
  cs = s0 + offset * slope;
  cu = offset / Math.sqrt(1 + slope * slope); // distance across, square to the course (+ = right)
}

/**
 * How much (x, z) belongs to a built snow feature (a tabletop jump or the
 * kicker), 0 to 1: their steep sides are packed snow, never bare rock.
 */
function builtAt(x: number, z: number): number {
  courseCoords(x, z);
  const ax = Math.abs(cu);
  const margin = 2; // m beyond the feature's foot, so the blend stays off it
  let built = 0;
  const hw = lookup(halfWidth, cs);
  if (hw > 0) built = 1 - THREE.MathUtils.smoothstep(ax, hw + JUMP_SIDE, hw + JUMP_SIDE + margin);
  if (M.kicker) {
    const k = M.kicker;
    const d = cs - tags[k.tag];
    if (d > -k.length - margin && d < 0.5 + margin) built = Math.max(built, 1 - THREE.MathUtils.smoothstep(ax, k.halfWidth + 1.5, k.halfWidth + 1.5 + margin));
  }
  for (const d of M.doubles ?? []) {
    const dist = cs - tags[d.tag];
    if (dist > -d.takeoff - margin && dist < doubleSpan(d).end + margin) {
      built = Math.max(built, 1 - THREE.MathUtils.smoothstep(ax, d.halfWidth + DIRT_SIDE, d.halfWidth + DIRT_SIDE + margin));
    }
  }
  const deck = dropDeck();
  if (deck && cs > deck.start - margin && cs < deck.edge + margin) {
    built = Math.max(built, 1 - THREE.MathUtils.smoothstep(ax, deck.halfWidth, deck.halfWidth + margin));
  }
  return built;
}

/** Terrain height at world (x, z). Physics, meshes and colliders all use this. */
export function heightAt(x: number, z: number): number {
  return groundHeight(x, z) + placedKickerHeight(x, z);
}

// ---------------------------------------------------------------------------
// Kickers placed by the player (Backcountry build mode, see kickers.ts):
// part of the ground, so riding, landing and the snow all follow them.

export interface PlacedKicker {
  x: number; // the middle of the ramp
  z: number;
  yaw: number; // the way you ride it: forward is (-sin yaw, 0, -cos yaw)
}
/**
 * Kicker size: ramp length and half-width (the sides slope off over SIDE).
 * Its height depends on the slope it's built on: tall enough that the lip
 * points LIP_ANGLE above level (a fixed height barely kicked up at all on a
 * steep face), within MIN_HEIGHT..MAX_HEIGHT.
 */
export const KICKER = { length: 7, halfWidth: 3.2, side: 1.6, lipAngle: 0.26, minHeight: 1.2, maxHeight: 3.6 };
const placed: (PlacedKicker & { height: number })[] = [];
/** Replace the placed kickers (the ground changes at once). */
export function setPlacedKickers(list: PlacedKicker[]): void {
  placed.length = 0;
  for (const k of list) placed.push({ ...k, height: kickerHeightFor(k) });
}

/**
 * How tall a kicker here must be: a ramp curving up from the slope (its
 * curve y = c t², t = 0..1 along it) leaves the lip at the ground's angle
 * plus 2c / length; c is the height that makes that LIP_ANGLE above level.
 */
export function kickerHeightFor(k: PlacedKicker): number {
  const fx = -Math.sin(k.yaw);
  const fz = -Math.cos(k.yaw);
  const half = KICKER.length / 2;
  const foot = groundHeight(k.x - fx * half, k.z - fz * half);
  const lip = groundHeight(k.x + fx * half, k.z + fz * half);
  const groundDrop = (foot - lip) / KICKER.length; // tan of the slope down the ramp's way
  const h = ((Math.tan(KICKER.lipAngle) + groundDrop) * KICKER.length) / 2;
  return THREE.MathUtils.clamp(h, KICKER.minHeight, KICKER.maxHeight);
}
/** Placed kickers (M) can only go on maps without a park: the backcountry. */
export const CAN_BUILD = !M.park && !CUSTOM; // (custom maps have the map builder instead)

/**
 * How far along a placed kicker's ramp (x, z) is: 0 at its foot, 1 at the
 * lip (-1: not on one). Its local frame, for the shape and for the rider.
 */
function kickerLocal(k: PlacedKicker, x: number, z: number, out: { along: number; across: number }): void {
  const fx = -Math.sin(k.yaw);
  const fz = -Math.cos(k.yaw);
  const dx = x - k.x;
  const dz = z - k.z;
  out.along = dx * fx + dz * fz + KICKER.length / 2; // 0 at the foot, length at the lip
  out.across = Math.abs(dx * fz - dz * fx);
}
const tmpLocal = { along: 0, across: 0 };

/** Height a placed kicker adds at (x, z). */
function placedKickerHeight(x: number, z: number): number {
  let h = 0;
  for (const k of placed) {
    kickerLocal(k, x, z, tmpLocal);
    const { along, across } = tmpLocal;
    if (along < 0 || along > KICKER.length + 0.5 || across > KICKER.halfWidth + KICKER.side) continue;
    const sides = 1 - THREE.MathUtils.smoothstep(across, KICKER.halfWidth, KICKER.halfWidth + KICKER.side);
    // Curving up to the lip, then straight down at its back
    const t = Math.min(1, along / KICKER.length);
    const up = along <= KICKER.length ? t * t : 1 - THREE.MathUtils.smoothstep(along - KICKER.length, 0, 0.5);
    h = Math.max(h, k.height * up * sides);
  }
  return h;
}

/** Is (x, z) on a placed kicker's ramp? (Its curve is a takeoff, not a bump.) */
export function onPlacedKicker(x: number, z: number): boolean {
  for (const k of placed) {
    kickerLocal(k, x, z, tmpLocal);
    if (tmpLocal.along > -1 && tmpLocal.along < KICKER.length + 1 && tmpLocal.across < KICKER.halfWidth + KICKER.side) return true;
  }
  return false;
}

/** The ground without placed kickers: the map's own shape (and, on a custom map, its sculpting). */
export function groundHeight(x: number, z: number): number {
  return CUSTOM ? baseHeight(x, z) + sculptAt(x, z) : baseHeight(x, z);
}

// ---------------------------------------------------------------------------
// Sculpting (custom maps): metres added to the slope, on a grid, blended.

/** The sculpt grid (row by row from the top), or empty on the built-in maps. */
export const SCULPT_GRID: Float32Array = CUSTOM ? decodeSculpt(CUSTOM.sculpt) : new Float32Array(0);

function sculptAt(x: number, z: number): number {
  const fx = (x + SCULPT.halfX) / SCULPT.cell;
  const fz = (SCULPT.topZ - z) / SCULPT.cell;
  if (fx < 0 || fz < 0 || fx > GRID_W - 1 || fz > GRID_H - 1) return 0;
  const ix = Math.min(GRID_W - 2, Math.floor(fx));
  const iz = Math.min(GRID_H - 2, Math.floor(fz));
  const tx = fx - ix;
  const tz = fz - iz;
  const g = SCULPT_GRID;
  const i = iz * GRID_W + ix;
  const a = g[i] * (1 - tx) + g[i + 1] * tx;
  const b = g[i + GRID_W] * (1 - tx) + g[i + GRID_W + 1] * tx;
  return a * (1 - tz) + b * tz;
}

/** The map's own shape, before any sculpting. */
function baseHeight(x: number, z: number): number {
  courseCoords(x, z);
  const s = cs;
  const u = cu;
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

/**
 * How much powder lies at (x, z): 1 = deep, 0 = groomed. Jumpline is
 * groomed except its last landing, fading in and out over a few metres.
 */
export function powderAmount(_x: number, z: number): number {
  if (M.summer) return 0; // (no snow at all)
  const only = M.powderOnly;
  if (!only) return 1;
  const s = -z;
  const a = tags[only.from];
  const b = tags[only.to];
  const fade = 6;
  return THREE.MathUtils.smoothstep(s, a - 2, a - 2 + fade) * (1 - THREE.MathUtils.smoothstep(s, b, b + fade));
}

/** Top of the snow at (x, z): what you see (riding uses heightAt). Groomed snow sits right on it. */
export function powderAt(x: number, z: number): number {
  const amount = powderAmount(x, z);
  const groomed = 0.012; // (just above where the skis ride)
  if (amount <= 0) return heightAt(x, z) + groomed;
  const powder = POWDER_DEPTH + 0.03 * noise(x / 3 + 200, z / 3) + 0.015 * noise(x / 1.2, z / 1.2 + 90);
  return heightAt(x, z) + groomed + (powder - groomed) * amount;
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

/** Summer ground: near white (the vertex colours give grass and dirt) with grit and blades. */
function groundTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#f0f0ea';
  ctx.fillRect(0, 0, size, size);
  const rand = mulberry32(23);
  for (let i = 0; i < 3500; i++) {
    const light = rand() < 0.4;
    ctx.fillStyle = light ? `rgba(255, 255, 240, ${rand() * 0.35})` : `rgba(70, 60, 40, ${0.08 + rand() * 0.22})`;
    if (rand() < 0.5) ctx.fillRect(rand() * size, rand() * size, 1 + rand() * 2, 1 + rand() * 2);
    else ctx.fillRect(rand() * size, rand() * size, 1, 2 + rand() * 5); // blades and streaks
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Boards: planks across, in a few browns, with dark gaps and grain. */
function woodTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rand = mulberry32(31);
  const plank = 32;
  for (let y = 0; y < size; y += plank) {
    const l = 38 + rand() * 12;
    ctx.fillStyle = `hsl(${28 + rand() * 8}, ${35 + rand() * 15}%, ${l}%)`;
    ctx.fillRect(0, y, size, plank);
    for (let k = 0; k < 14; k++) {
      ctx.fillStyle = `rgba(60, 35, 15, ${0.1 + rand() * 0.15})`;
      ctx.fillRect(0, y + 2 + rand() * (plank - 4), size, 1);
    }
    ctx.fillStyle = 'rgba(30, 18, 8, 0.85)';
    ctx.fillRect(0, y, size, 2); // the gap between planks
    ctx.fillStyle = 'rgba(40, 40, 40, 0.8)'; // nails
    for (const x of [12, size / 2, size - 14]) ctx.fillRect(x, y + plank / 2 - 1, 3, 3);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * The drop's woodwork: boards over its ramp and deck, boarded sides and a
 * boarded front down to the ground (its shape is in heightAt: this is the
 * look).
 */
function dropMesh(d: Drop): THREE.Group {
  const edge = tags[d.tag];
  const start = edge - d.deck - d.ramp;
  const out = d.halfWidth + 0.35; // the boarding stands just outside the ridden width
  const top = (s: number) => heightAt(courseX(-s), -s) + 0.03; // (the deck is level across)
  const ground = (s: number, u: number) => heightAt(courseX(-s) + u, -s) - 0.15;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const quad = (a: number[], b: number[], c: number[], e: number[], ua: number[], ub: number[], uc: number[], ue: number[]) => {
    const i = pos.length / 3;
    pos.push(...a, ...b, ...c, ...e);
    uv.push(...ua, ...ub, ...uc, ...ue);
    idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  };
  const P = (s: number, u: number, y: number) => [courseX(-s) + u, y, -s];
  const PLANK = 0.14; // m: the texture's plank width (8 planks per repeat)
  const steps = Math.ceil((edge - start) / 0.25);
  for (let k = 0; k < steps; k++) {
    const s0 = start + ((edge - start) * k) / steps;
    const s1 = start + ((edge - start) * (k + 1)) / steps;
    const v0 = s0 / (PLANK * 8);
    const v1 = s1 / (PLANK * 8);
    // Top: planks running across
    quad(P(s0, -out, top(s0)), P(s0, out, top(s0)), P(s1, out, top(s1)), P(s1, -out, top(s1)), [0, v0], [1, v0], [1, v1], [0, v1]);
    // Sides: boards from the deck down into the ground
    for (const side of [-1, 1]) {
      const u = side * out;
      const a = P(s0, u, top(s0));
      const b = P(s1, u, top(s1));
      const c = P(s1, u, ground(s1, u + side * 0.3));
      const e = P(s0, u, ground(s0, u + side * 0.3));
      const h0 = (top(s0) - ground(s0, u)) / (PLANK * 8);
      if (side > 0) quad(a, e, c, b, [v0, 0], [v0, h0], [v1, h0], [v1, 0]);
      else quad(a, b, c, e, [v0, 0], [v1, 0], [v1, h0], [v0, h0]);
    }
  }
  // The front: a wall down from the edge to the slope below it
  const fs = edge + 0.3;
  const yTop = top(edge);
  const yLow = heightAt(courseX(-fs), -fs) - 0.2;
  quad(P(fs, out, yTop), P(fs, -out, yTop), P(fs, -out, yLow), P(fs, out, yLow), [0, 0], [1, 0], [1, (yTop - yLow) / (PLANK * 8)], [0, (yTop - yLow) / (PLANK * 8)]);
  quad(P(edge, -out, yTop), P(edge, out, yTop), P(fs, out, yTop), P(fs, -out, yTop), [0, 0], [1, 0], [1, 0.3], [0, 0.3]); // the top of the edge
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const wood = new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.85, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, wood);
  mesh.castShadow = mesh.receiveShadow = true;
  const group = new THREE.Group();
  group.add(mesh);
  // Posts at the corners of the front, a little proud of the boarding
  const postMat = new THREE.MeshStandardMaterial({ color: 0x5a3b22, roughness: 0.9 });
  for (const u of [-out, out]) {
    for (const ps of [edge + 0.15, edge - d.deck]) {
      const yt = top(Math.min(ps, edge)) + 0.12;
      const yb = heightAt(courseX(-ps) + u, -ps) - 0.3;
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, yt - yb, 0.16), postMat);
      post.position.set(courseX(-ps) + u + Math.sign(u) * 0.08, (yt + yb) / 2, -ps);
      post.castShadow = post.receiveShadow = true;
      group.add(post);
    }
  }
  return group;
}

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
  // through snow-dusted rock on the slightly gentler edges. Not on built
  // features, though: a tabletop's sides are as steep as a cliff's but are
  // packed snow (as rock, on the side away from the sun, they read as black
  // smears, blurred wide by the vertex colours blending across the mesh)
  out.setAttribute('color', new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3));
  for (let i = 0; i < pos.count; i++) vertexColor(out, i);
  return out;
}

const SNOW_WHITE = new THREE.Color(0xffffff);
const ROCK = new THREE.Color(0x4a4744).convertSRGBToLinear();
const tmpColor = new THREE.Color();
/** A terrain vertex's colour: snow or bare rock, darkened by baked sky visibility. */
function vertexColor(geo: THREE.BufferGeometry, i: number): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nrm = geo.attributes.normal as THREE.BufferAttribute;
  const steep = THREE.MathUtils.smoothstep(1 - nrm.getY(i), 0.42, 0.62); // ~55° to ~68°
  const bare = steep > 0 ? steep * (1 - builtAt(pos.getX(i), pos.getZ(i))) : 0;
  if (M.summer) summerColor(pos.getX(i), pos.getZ(i), bare, tmpColor);
  else tmpColor.lerpColors(SNOW_WHITE, ROCK, bare);
  // Baked sky visibility: hollows and the feet of walls see less sky
  tmpColor.multiplyScalar(skyVisibility(pos.getX(i), pos.getZ(i)));
  (geo.attributes.color as THREE.BufferAttribute).setXYZ(i, tmpColor.r, tmpColor.g, tmpColor.b);
}

const GRASS = new THREE.Color(0x7aa647).convertSRGBToLinear();
const GRASS_DRY = new THREE.Color(0x9aa64a).convertSRGBToLinear();
const DIRT = new THREE.Color(0x8c6a48).convertSRGBToLinear();
const DIRT_PACKED = new THREE.Color(0xa58460).convertSRGBToLinear();
const tmpDirt = new THREE.Color();
const TRAIL_HALF = 3.2; // m: the dirt line's half-width (wider round the features)

/**
 * Summer ground: grass in patches of greener and drier, a dirt trail down
 * the course (the jumps and the drop's landing packed smooth), and bare
 * rock where it's steep.
 */
function summerColor(x: number, z: number, bare: number, out: THREE.Color): void {
  // Grass, patchy
  const patch = THREE.MathUtils.clamp(0.5 + 0.6 * noise(x / 18 + 700, z / 18) + 0.3 * noise(x / 5, z / 5 + 800), 0, 1);
  out.lerpColors(GRASS, GRASS_DRY, patch * 0.7);
  // The trail
  courseCoords(x, z);
  const s = cs;
  const ax = Math.abs(cu);
  let dirt = 0;
  if (s > tags['deck-end'] - 14 && s < tags['end'] + 10) {
    const edge = TRAIL_HALF + 0.8 * noise(s / 6 + 900, 3) + (s < tags['deck-end'] + 2 ? 4 : 0) + (s > tags['finish'] - 10 ? 6 : 0);
    dirt = 1 - THREE.MathUtils.smoothstep(ax, edge, edge + 1.2);
  }
  const built = builtAt(x, z);
  dirt = Math.max(dirt, built);
  if (M.drop) {
    // The drop's landing: worn wide
    const d = s - tags[M.drop.tag];
    if (d > -2 && d < 20) dirt = Math.max(dirt, 1 - THREE.MathUtils.smoothstep(ax, 4.5, 6));
  }
  if (dirt > 0) {
    tmpDirt.lerpColors(DIRT, DIRT_PACKED, Math.max(built, 0.5 + 0.5 * noise(x / 3 + 1000, z / 3)));
    out.lerp(tmpDirt, dirt);
  }
  out.lerp(ROCK, bare);
}

/** The visible course mesh (custom maps edit it live). */
let coursePowder: THREE.BufferGeometry | null = null;

/**
 * After sculpting: bring the terrain meshes up to date over a region
 * (world x0..x1, z0..z1). Quick (heights and shading) while a brush is
 * moving; with colours, also the rock and baked sky visibility (slower:
 * after a stroke).
 */
export function refreshTerrain(x0: number, z0: number, x1: number, z1: number, colours: boolean): void {
  const ride = terrainGeometry().course;
  const look = coursePowder;
  const rp = ride.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < rp.count; i++) {
    const x = rp.getX(i);
    const z = rp.getZ(i);
    if (x < x0 || x > x1 || z < z0 || z > z1) continue;
    rp.setY(i, heightAt(x, z));
    if (look) (look.attributes.position as THREE.BufferAttribute).setY(i, powderAt(x, z));
  }
  rp.needsUpdate = true;
  ride.computeBoundingSphere();
  if (!look) return;
  look.attributes.position.needsUpdate = true;
  look.computeVertexNormals();
  if (colours) {
    // Sky visibility looks up to ~36 m away: redo it that far around
    const reach = 38;
    for (let ix = Math.floor((x0 - reach) / AO_CELL); ix <= Math.ceil((x1 + reach) / AO_CELL); ix++) {
      for (let iz = Math.floor((z0 - reach) / AO_CELL); iz <= Math.ceil((z1 + reach) / AO_CELL); iz++) {
        aoCache.delete(ix * 100003 + iz);
      }
    }
    const lp = look.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < lp.count; i++) {
      const x = lp.getX(i);
      const z = lp.getZ(i);
      if (x < x0 - reach || x > x1 + reach || z < z0 - reach || z > z1 + reach) continue;
      vertexColor(look, i);
    }
  } else {
    // (rock follows the new steepness at once; the sky visibility after the stroke)
    const lp = look.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < lp.count; i++) {
      const x = lp.getX(i);
      const z = lp.getZ(i);
      if (x < x0 || x > x1 || z < z0 || z > z1) continue;
      vertexColor(look, i);
    }
  }
  look.attributes.color.needsUpdate = true;
  look.computeBoundingSphere();
}

export function createTerrain(): THREE.Group {
  const { course, outer } = terrainGeometry();
  const group = new THREE.Group();

  // (Jumpline is groomed: corduroy; its powder landing shows as lumpy snow)
  const powder = new THREE.MeshStandardMaterial({ map: M.summer ? groundTexture() : snowTexture(!!M.powderOnly), roughness: M.summer ? 0.95 : 0.9, vertexColors: true });
  const courseMesh = new THREE.Mesh(powderGeometry(course), powder);
  coursePowder = courseMesh.geometry;
  courseMesh.frustumCulled = !CUSTOM; // (edited live: its bounds change)
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

  if (M.drop) group.add(dropMesh(M.drop));
  if (M.summer) return group; // (no dye on dirt)

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
