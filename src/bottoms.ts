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
import { BODY, type Person } from './person';
import { Cloth, refine, type ClothRing } from './cloth';

/**
 * Baggy shorts or snowpants, with cloth physics (see Cloth).
 *
 * Built like the T-shirt: no seams. The seat is one tube from the
 * waistband over the hips and bum, hanging down past the crotch; each leg
 * is a tube that starts as a closed dome tucked up inside the seat (as the
 * shirt's sleeves start inside its body), reaching just past the knee
 * (shorts) or down over the boots (pants). The seat's lower edge is kept
 * out past the thighs (a margin), so it hangs over the legs' tops rather
 * than through them. Held firmly at the waistband (and the pants' cuffs),
 * loosely elsewhere, so the fabric swings, flaps and bunches.
 *
 * (They used to be three tubes sewn together by generated triangles; as the
 * thighs swung, the seams folded over themselves and the seat looked torn
 * and inside out from behind.)
 */

const SEAT_SEGMENTS = 40; // particles round the seat (as the shirt's body)
const SEGMENTS = 24; // ... and round each leg (as its sleeves)

// Bones: pelvis, thighs (left, right), shins (left, right)
const PELVIS = 0;

// Along a bone, -length/2 is its first joint and +length/2 its second:
// pelvis: hip centre -> up the spine; thigh: hip -> knee; shin: knee -> ankle
const T = BODY.thigh / 2;
const S = BODY.shin / 2;
const P = BODY.pelvis / 2;
// Key rings; more are filled in between (see refine) for a finer mesh
const SEAT_KEYS: ClothRing[] = [
  // Belt line: held fast
  { bone: 'pelvis', y: P + 0.02, rx: 0.17, rz: 0.14, cz: 0.025, pin: 1, leash: 0.01 },
  { bone: 'pelvis', y: 0, rx: 0.2, rz: 0.16, cz: 0.035, pin: 0.6, leash: 0.03, cheeks: 0.015 },
  // The bum: two cheeks at the back with a crease between, fullest just
  // below the hip joints
  { bone: 'pelvis', y: -P - 0.01, rx: 0.22, rz: 0.17, cz: 0.04, pin: 0.3, leash: 0.05, cheeks: 0.045 },
  {
    bone: 'pelvis', y: -P - 0.07, rx: 0.225, rz: 0.165, cz: 0.04, pin: 0.2, leash: 0.06, cheeks: 0.04, crotch: 0.03,
    collide: ['pelvis', 'thigh'], margin: 0.09, blend: { bone: 'thigh', front: 0.3, back: 0.05 },
  },
  // Under the bum it curves in onto the legs, and the hem arches up between
  // them front and back (the crotch), so the two legs read as legs
  {
    bone: 'pelvis', y: -P - 0.13, rx: 0.25, rz: 0.15, cz: 0.025, pin: 0.1, leash: 0.08, cheeks: 0.015, crotch: 0.09,
    collide: ['pelvis', 'thigh'], margin: 0.09, blend: { bone: 'thigh', front: 0.45, back: 0.2 },
  },
];
const THIGH_KEYS: ClothRing[] = [
  // A dome over the hip joint, up inside the seat: the top of the leg, closed
  { bone: 'thigh', y: -T - 0.07, rx: 0.02, rz: 0.02, pin: 0.5, leash: 0.02 },
  { bone: 'thigh', y: -T - 0.04, rx: 0.1, rz: 0.105, pin: 0.35, leash: 0.03 },
  { bone: 'thigh', y: -T + 0.03, rx: 0.145, rz: 0.155, pin: 0.2, leash: 0.05 },
  // Wide and loose down the thigh (deep front to back; slimmer side to side,
  // so the two legs don't overlap and merge into one skirt)
  { bone: 'thigh', y: -T * 0.4, rx: 0.145, rz: 0.16, pin: 0.08, leash: 0.1 },
  { bone: 'thigh', y: 0, rx: 0.14, rz: 0.17, pin: 0.04, leash: 0.14 },
  { bone: 'thigh', y: T * 0.5, rx: 0.135, rz: 0.165, pin: 0.05, leash: 0.13 },
];
const SHORTS_LEG: ClothRing[] = [
  ...THIGH_KEYS,
  // The hem: wide and loose, just past the knee. It goes with the thigh:
  // when the knee bends (deeply, knees up in a grab) shorts ride up the
  // thigh rather than following the shin round the fold, which stretched
  // the fabric over the knee to three times its length. Kept outside the
  // shin too, which folds up under it.
  { bone: 'thigh', y: T + 0.07, rx: 0.14, rz: 0.17, pin: 0.08, leash: 0.1, collide: ['thigh', 'shin'] },
];
const SHORTS_KNEE = SHORTS_LEG.length - 1;

const PANTS_LEG: ClothRing[] = [
  ...THIGH_KEYS,
  // Over the knee: halfway between thigh and shin (so a deep bend doesn't
  // stretch it round the fold), kept outside both, with lots of slack nearby
  { bone: 'shin', y: -S + 0.02, rx: 0.155, rz: 0.16, pin: 0.1, leash: 0.1, collide: ['thigh', 'shin'], blend: { bone: 'thigh', front: 0.5, back: 0.5 } },
  { bone: 'shin', y: -S * 0.4, rx: 0.15, rz: 0.155, pin: 0.04, leash: 0.12 },
  { bone: 'shin', y: S * 0.15, rx: 0.155, rz: 0.16, pin: 0.04, leash: 0.12 },
  { bone: 'shin', y: S * 0.65, rx: 0.165, rz: 0.17, pin: 0.08, leash: 0.08 }, // flaring over the boot
  { bone: 'shin', y: S + 0.03, rx: 0.13, rz: 0.15, pin: 0.6, leash: 0.02 }, // cuff, on the boot top
];
const PANTS_KNEE = THIGH_KEYS.length;

/** The refined leg, with the fabric within two rings of the knee loose. */
function legRings(keys: ClothRing[], knee: number): ClothRing[] {
  const rings = refine(keys, 1);
  const k = rings.indexOf(keys[knee]);
  return rings.map((ring, r) => (Math.abs(r - k) <= 2 ? { ...ring, loose: true } : ring));
}

export class Bottoms extends Cloth {
  constructor(person: Person, kind: 'shorts' | 'pants', color: number) {
    // Lots of rings: a fine mesh, so the fabric folds and creases smoothly
    const seat = refine(SEAT_KEYS, 2);
    const leg = kind === 'pants' ? legRings(PANTS_LEG, PANTS_KNEE) : legRings(SHORTS_LEG, SHORTS_KNEE);
    super(
      [person.pelvis, person.thighs[0], person.thighs[1], person.shins[0], person.shins[1]],
      [
        { rings: seat, segments: SEAT_SEGMENTS, bones: { pelvis: PELVIS, thigh: [1, 2] }, side: 0 },
        // (left leg first, as in Person)
        { rings: leg, segments: SEGMENTS, bones: { pelvis: PELVIS, thigh: 1, shin: 3 }, side: -1 },
        { rings: leg, segments: SEGMENTS, bones: { pelvis: PELVIS, thigh: 2, shin: 4 }, side: 1 },
      ],
      new THREE.MeshStandardMaterial({ color, roughness: 0.85, side: THREE.DoubleSide }),
    );
  }
}
