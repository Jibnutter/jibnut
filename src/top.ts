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
 * A baggy T-shirt or windbreaker, with cloth physics (see Cloth).
 *
 * The windbreaker is longer, down over the top of the seat, with a tall
 * stand-up collar and full sleeves cinched at the wrists.
 *
 * An oversized body hanging loose over the shorts' waistband, a crew neck,
 * and wide short sleeves. Each sleeve starts as a closed dome over the
 * shoulder (a set-in sleeve), so the only open edges are the hem, the neck
 * and the sleeve ends.
 *
 * Held at the neck and over the shoulders; the body and sleeves are loose,
 * so they billow, flap in the wind and swing in tricks.
 */

const BODY_SEGMENTS = 40; // particles round the body
const SLEEVE_SEGMENTS = 24;

// Bones: pelvis, abdomen, chest, upper arms (left, right)
const ABDOMEN = 1;

// Along a bone, -length/2 is its first joint and +length/2 its second:
// pelvis: hip centre -> up; abdomen and chest: up the spine (chest's top is
// the shoulder line); upper arm: shoulder -> elbow
const P = BODY.pelvis / 2;
const A = BODY.abdomen / 2;
const C = BODY.chest / 2;
const U = BODY.upperArm / 2;
const F = BODY.forearm / 2;

const BODY_KEYS: ClothRing[] = [
  // The hem: loose, hanging over the shorts' waistband (kept out from the
  // hips so it stays outside the baggy shorts, not inside them)
  { bone: 'pelvis', y: -0.03, rx: 0.27, rz: 0.235, cz: 0.025, pin: 0.06, leash: 0.08, margin: 0.11 },
  { bone: 'pelvis', y: P, rx: 0.265, rz: 0.225, cz: 0.015, pin: 0.06, leash: 0.09, margin: 0.07 },
  // Oversized: roomy all the way up, so it billows
  { bone: 'abdomen', y: 0, rx: 0.255, rz: 0.22, cz: 0.01, pin: 0.04, leash: 0.11 },
  { bone: 'abdomen', y: A, rx: 0.255, rz: 0.22, cz: 0.01, pin: 0.04, leash: 0.11 },
  { bone: 'chest', y: 0, rx: 0.25, rz: 0.21, cz: 0.005, pin: 0.08, leash: 0.08 },
  // Over the shoulders, where the sleeves are set in
  { bone: 'chest', y: C, rx: 0.235, rz: 0.19, pin: 0.25, leash: 0.04 },
  { bone: 'chest', y: C + 0.05, rx: 0.165, rz: 0.14, cz: 0.005, pin: 0.5, leash: 0.025 },
  // The crew neck, round the base of the neck
  { bone: 'chest', y: C + 0.075, rx: 0.115, rz: 0.11, cz: 0.012, pin: 1, leash: 0.01 },
];

const JACKET_KEYS: ClothRing[] = [
  // Long, freeride style: down over the top of the seat, with a drawcord hem
  { bone: 'pelvis', y: -0.08, rx: 0.285, rz: 0.25, cz: 0.03, pin: 0.3, leash: 0.05, margin: 0.12 },
  { bone: 'pelvis', y: 0, rx: 0.275, rz: 0.24, cz: 0.025, pin: 0.12, leash: 0.07, margin: 0.1 },
  { bone: 'pelvis', y: P, rx: 0.265, rz: 0.225, cz: 0.015, pin: 0.1, leash: 0.08, margin: 0.07 },
  // A roomy body: loose, so it billows
  { bone: 'abdomen', y: 0, rx: 0.255, rz: 0.22, cz: 0.01, pin: 0.05, leash: 0.11 },
  { bone: 'abdomen', y: A, rx: 0.255, rz: 0.22, cz: 0.01, pin: 0.05, leash: 0.11 },
  { bone: 'chest', y: 0, rx: 0.25, rz: 0.21, cz: 0.005, pin: 0.08, leash: 0.08 },
  // Over the shoulders, where the sleeves are set in
  { bone: 'chest', y: C, rx: 0.235, rz: 0.19, pin: 0.2, leash: 0.05 },
  { bone: 'chest', y: C + 0.06, rx: 0.17, rz: 0.15, cz: 0.005, pin: 0.4, leash: 0.03 },
  // The collar: tall and stiff, standing up round the neck
  { bone: 'chest', y: C + 0.1, rx: 0.12, rz: 0.12, cz: 0.012, pin: 0.8, leash: 0.015 },
  { bone: 'chest', y: C + 0.16, rx: 0.125, rz: 0.122, cz: 0.018, pin: 1, leash: 0.01 },
];

const LONG_SLEEVE_KEYS: ClothRing[] = [
  { bone: 'upper', y: -U - 0.1, rx: 0.02, rz: 0.02, pin: 0.5, leash: 0.02 },
  { bone: 'upper', y: -U - 0.075, rx: 0.07, rz: 0.07, pin: 0.4, leash: 0.03 },
  { bone: 'upper', y: -U - 0.03, rx: 0.1, rz: 0.1, pin: 0.3, leash: 0.04 },
  { bone: 'upper', y: -U + 0.04, rx: 0.105, rz: 0.105, pin: 0.12, leash: 0.06 },
  // Loose down the arm, with slack round the elbow
  { bone: 'upper', y: 0, rx: 0.1, rz: 0.1, pin: 0.05, leash: 0.1 },
  { bone: 'upper', y: U - 0.03, rx: 0.095, rz: 0.095, pin: 0.06, leash: 0.1, loose: true },
  { bone: 'fore', y: -F + 0.02, rx: 0.09, rz: 0.09, pin: 0.08, leash: 0.1, loose: true },
  { bone: 'fore', y: 0, rx: 0.088, rz: 0.088, pin: 0.04, leash: 0.1 },
  { bone: 'fore', y: F - 0.06, rx: 0.085, rz: 0.085, pin: 0.1, leash: 0.06 },
  // The cuff, cinched at the wrist
  { bone: 'fore', y: F + 0.01, rx: 0.055, rz: 0.055, pin: 0.7, leash: 0.015 },
];

const SLEEVE_KEYS: ClothRing[] = [
  // A dome over the shoulder joint: the top of the sleeve, closed
  { bone: 'upper', y: -U - 0.1, rx: 0.02, rz: 0.02, pin: 0.5, leash: 0.02 },
  { bone: 'upper', y: -U - 0.075, rx: 0.07, rz: 0.07, pin: 0.4, leash: 0.03 },
  { bone: 'upper', y: -U - 0.03, rx: 0.1, rz: 0.1, pin: 0.3, leash: 0.04 },
  { bone: 'upper', y: -U + 0.04, rx: 0.105, rz: 0.105, pin: 0.12, leash: 0.06 },
  // Wide and short, ending halfway down the upper arm
  { bone: 'upper', y: 0, rx: 0.105, rz: 0.105, pin: 0.06, leash: 0.08 },
  { bone: 'upper', y: 0.04, rx: 0.105, rz: 0.105, pin: 0.06, leash: 0.08 },
];

export class Top extends Cloth {
  constructor(person: Person, kind: 'tee' | 'jacket', color: number) {
    const jacket = kind === 'jacket';
    // Lots of rings: a fine mesh, so the fabric folds and creases smoothly
    const torso = refine(jacket ? JACKET_KEYS : BODY_KEYS, 2);
    const sleeve = refine(jacket ? LONG_SLEEVE_KEYS : SLEEVE_KEYS, 1);
    super(
      [person.pelvis, person.abdomen, person.chest, person.upperArms[0], person.upperArms[1], person.forearms[0], person.forearms[1]],
      [
        { rings: torso, segments: BODY_SEGMENTS, bones: { pelvis: 0, abdomen: ABDOMEN, chest: 2 }, side: 0 },
        // (left arm first, as in Person)
        { rings: sleeve, segments: SLEEVE_SEGMENTS, bones: { upper: 3, fore: 5 }, side: -1 },
        { rings: sleeve, segments: SLEEVE_SEGMENTS, bones: { upper: 4, fore: 6 }, side: 1 },
      ],
      jacket
        ? // hardshell: smooth, with a soft sheen
          new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.05, side: THREE.DoubleSide })
        : new THREE.MeshStandardMaterial({ color, roughness: 0.9, side: THREE.DoubleSide }),
      ABDOMEN,
    );
  }
}
