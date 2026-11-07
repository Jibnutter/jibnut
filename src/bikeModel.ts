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
import { createBootShell } from './gear';

/**
 * A full-suspension mountain bike (an original design, no brand graphics).
 *
 * The rig treats the bike like a pair of skis: one "ski" under each foot.
 * Half 0 (under the left pedal) carries the whole bike; half 1 (under the
 * right pedal) is just that pedal. Each half's origin is its pedal, so the
 * bike's centreline is PEDAL_X to the right of half 0's origin, and the
 * ground is BB_HEIGHT below it. Forward is -z.
 *
 * Moving parts (see animateBike): both wheels spin; the front end (fork,
 * wheel, bars) steers and the fork compresses; the rear swingarm pivots up
 * against the shock; the cranks turn when pedalling.
 */

export const PEDAL_X = 0.11; // each pedal this far out from the centreline
export const BB_HEIGHT = 0.34; // bottom bracket (pedal axle) above the ground
const WHEEL_R = 0.37; // 29er
const TIRE = 0.034;
const FRONT_AXLE = new THREE.Vector3(0, WHEEL_R - BB_HEIGHT, -0.74);
const REAR_AXLE = new THREE.Vector3(0, WHEEL_R - BB_HEIGHT, 0.44);
const HEAD_TOP = new THREE.Vector3(0, 0.6, -0.5);
const HEAD_BOTTOM = new THREE.Vector3(0, 0.44, -0.56);
const SEAT_TOP = new THREE.Vector3(0, 0.56, 0.13);
const PIVOT = new THREE.Vector3(0, 0.1, 0.06); // swingarm pivot, just above and behind the BB
const SHOCK_FRAME = new THREE.Vector3(0, 0.36, -0.14); // shock mount on the frame
/** Where the hands hold the bars (in half 0's frame): left and right grips. */
export const GRIPS = [new THREE.Vector3(PEDAL_X - 0.37, 0.72, -0.48), new THREE.Vector3(PEDAL_X + 0.37, 0.72, -0.48)];
/** Bike mass (kg), split over the two halves for the physics. */
export const BIKE_MASS = 14;
/** The ragdoll's collision box for the bike (half 0's frame): centre and half-sizes. */
export const BIKE_BOX = { centre: new THREE.Vector3(PEDAL_X, (WHEEL_R - BB_HEIGHT) / 2 + 0.06, -0.15), half: new THREE.Vector3(0.05, 0.33, 0.58) };

const FORK_AXIS = HEAD_BOTTOM.clone().sub(FRONT_AXLE).normalize(); // up the fork
const FORK_TRAVEL = 0.12;
const REAR_TRAVEL_ANGLE = 0.22; // rad of swingarm at full squash

let mats: Record<'frame' | 'black' | 'tire' | 'gold' | 'metal' | 'rim', THREE.Material> | null = null;
function materials() {
  mats ??= {
    frame: new THREE.MeshStandardMaterial({ color: 0xff7a1c, roughness: 0.35, metalness: 0.2 }),
    black: new THREE.MeshStandardMaterial({ color: 0x17181b, roughness: 0.55, metalness: 0.2 }),
    tire: new THREE.MeshStandardMaterial({ color: 0x1b1b1b, roughness: 0.95 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xd8a63a, roughness: 0.25, metalness: 0.8 }),
    metal: new THREE.MeshStandardMaterial({ color: 0xb9c0c8, roughness: 0.3, metalness: 0.9 }),
    rim: new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.4, metalness: 0.6 }),
  };
  return mats;
}

/** A tube between two points. */
function tube(a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material, r2 = r): THREE.Mesh {
  const d = b.clone().sub(a);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r2, r, d.length(), 12), mat);
  m.position.copy(a).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  m.castShadow = true;
  return m;
}

/** A wheel (in the yz plane, spinning about x): knobbly tyre, rim, hub, spokes, brake rotor. */
function wheel(): THREE.Group {
  const m = materials();
  const g = new THREE.Group();
  const tire = new THREE.Mesh(new THREE.TorusGeometry(WHEEL_R - TIRE, TIRE, 10, 48), m.tire);
  tire.rotation.y = Math.PI / 2;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(WHEEL_R - TIRE * 2.2, 0.013, 6, 48), m.rim);
  rim.rotation.y = Math.PI / 2;
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.11, 12), m.black);
  hub.rotation.z = Math.PI / 2;
  const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.004, 24), m.metal);
  rotor.rotation.z = Math.PI / 2;
  rotor.position.x = -0.05;
  g.add(tire, rim, hub, rotor);
  // Knobs round the tyre, so the spin shows
  const knob = new THREE.BoxGeometry(0.05, 0.016, 0.03);
  for (let k = 0; k < 36; k++) {
    const a = (k / 36) * Math.PI * 2;
    const kb = new THREE.Mesh(knob, m.tire);
    kb.position.set(0, Math.cos(a) * (WHEEL_R - 0.002), Math.sin(a) * (WHEEL_R - 0.002));
    kb.rotation.x = -a;
    g.add(kb);
  }
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const side = k % 2 ? 1 : -1;
    const sp = tube(
      new THREE.Vector3(side * 0.03, 0, 0),
      new THREE.Vector3(side * 0.008, Math.cos(a) * (WHEEL_R - TIRE * 2.3), Math.sin(a) * (WHEEL_R - TIRE * 2.3)),
      0.0025,
      m.metal,
    );
    sp.castShadow = false;
    g.add(sp);
  }
  g.traverse((o) => ((o as THREE.Mesh).castShadow = true));
  return g;
}

/** The whole bike, centred on its own centreline (BB at the origin). */
function bike(): THREE.Group {
  const m = materials();
  const bike = new THREE.Group();

  // Front triangle (frame)
  bike.add(tube(new THREE.Vector3(0, 0, 0), HEAD_BOTTOM, 0.03, m.frame, 0.026)); // down tube
  bike.add(tube(SEAT_TOP, HEAD_TOP, 0.022, m.frame)); // top tube
  bike.add(tube(new THREE.Vector3(0, 0.02, 0.02), SEAT_TOP, 0.022, m.frame)); // seat tube
  bike.add(tube(HEAD_BOTTOM, HEAD_TOP, 0.032, m.frame)); // head tube
  // Seat post (dropper, lowered) and saddle
  const postTop = SEAT_TOP.clone().add(new THREE.Vector3(0, 0.1, 0.03));
  bike.add(tube(SEAT_TOP, postTop, 0.016, m.black));
  const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.04, 0.27), m.black);
  saddle.position.copy(postTop).add(new THREE.Vector3(0, 0.025, 0.02));
  saddle.castShadow = true;
  bike.add(saddle);
  // BB shell
  const bb = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.09, 12), m.black);
  bb.rotation.z = Math.PI / 2;
  bike.add(bb);

  // Rear: swingarm and wheel, pivoting at PIVOT (the shock reaches it)
  const swing = new THREE.Group();
  swing.name = 'swing';
  swing.position.copy(PIVOT);
  const axle = REAR_AXLE.clone().sub(PIVOT);
  for (const side of [-1, 1]) {
    const off = new THREE.Vector3(side * 0.06, 0, 0);
    swing.add(tube(off.clone(), axle.clone().add(off), 0.016, m.frame)); // chainstay
    const stayTop = new THREE.Vector3(side * 0.05, 0.3, 0.06);
    swing.add(tube(stayTop, axle.clone().add(off), 0.013, m.frame)); // seatstay
  }
  const rocker = new THREE.Vector3(0, 0.3, 0.06);
  swing.add(tube(new THREE.Vector3(-0.05, 0.3, 0.06), new THREE.Vector3(0.05, 0.3, 0.06), 0.012, m.frame));
  const rear = wheel();
  rear.name = 'rearWheel';
  rear.position.copy(axle);
  swing.add(rear);
  bike.add(swing);
  // The shock: from the frame to the rocker (stretched each frame)
  const shock = new THREE.Group();
  shock.name = 'shock';
  shock.userData.top = SHOCK_FRAME.clone();
  shock.userData.rocker = rocker; // in swing's frame
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 1, 12), m.black);
  body.name = 'shockBody';
  const spring = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1, 12), m.gold);
  spring.name = 'shockSpring';
  shock.add(body, spring);
  bike.add(shock);

  // Front end: steers about the head tube; the fork compresses along itself
  const front = new THREE.Group();
  front.name = 'front';
  front.position.copy(HEAD_BOTTOM);
  const steerAxis = HEAD_TOP.clone().sub(HEAD_BOTTOM).normalize();
  front.userData.axis = steerAxis;
  const crown = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.035, 0.05), m.black);
  crown.position.y = -0.03;
  front.add(crown);
  const axleF = FRONT_AXLE.clone().sub(HEAD_BOTTOM);
  for (const side of [-1, 1]) {
    const top = new THREE.Vector3(side * 0.065, -0.03, 0);
    const lowerTop = axleF.clone().addScaledVector(FORK_AXIS, 0.28).add(new THREE.Vector3(side * 0.065, 0, 0));
    front.add(tube(top, lowerTop.clone().addScaledVector(FORK_AXIS, -0.05), 0.017, m.gold)); // stanchion
  }
  const lowers = new THREE.Group();
  lowers.name = 'lowers';
  for (const side of [-1, 1]) {
    const a = axleF.clone().add(new THREE.Vector3(side * 0.065, 0, 0));
    lowers.add(tube(a, a.clone().addScaledVector(FORK_AXIS, 0.3), 0.022, m.black));
  }
  const frontWheel = wheel();
  frontWheel.name = 'frontWheel';
  frontWheel.position.copy(axleF);
  lowers.add(frontWheel);
  front.add(lowers);
  // Stem and bars (riser bars, wide)
  const stemTop = HEAD_TOP.clone().sub(HEAD_BOTTOM).add(new THREE.Vector3(0, 0.05, 0));
  const barCentre = stemTop.clone().add(new THREE.Vector3(0, 0.04, 0.02));
  front.add(tube(HEAD_TOP.clone().sub(HEAD_BOTTOM), stemTop, 0.02, m.black));
  front.add(tube(barCentre.clone().add(new THREE.Vector3(-0.39, 0.02, 0)), barCentre.clone().add(new THREE.Vector3(0.39, 0.02, 0)), 0.012, m.black));
  for (const side of [-1, 1]) {
    const grip = tube(
      barCentre.clone().add(new THREE.Vector3(side * 0.3, 0.02, 0)),
      barCentre.clone().add(new THREE.Vector3(side * 0.39, 0.02, 0)),
      0.017,
      m.black,
    );
    front.add(grip);
  }
  bike.add(front);

  // Cranks and pedals, turning about the BB
  const cranks = new THREE.Group();
  cranks.name = 'cranks';
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.008, 24), m.black);
  ring.rotation.z = Math.PI / 2;
  ring.position.x = 0.05;
  cranks.add(ring);
  for (const side of [-1, 1]) {
    const end = new THREE.Vector3(side * 0.07, side * 0.17, 0);
    cranks.add(tube(new THREE.Vector3(side * 0.05, 0, 0), end, 0.012, m.black));
  }
  bike.add(cranks);
  bike.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
  });
  return bike;
}

/** Flat pedal under a boot (at the half's origin), with the boot on it. */
function pedal(): THREE.Group {
  const m = materials();
  const g = new THREE.Group();
  const p = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.018, 0.1), m.black);
  p.position.y = -0.02;
  p.castShadow = true;
  g.add(p);
  // (the boot sits on the pedal, as on a ski binding)
  const boot = createBootShell();
  boot.position.y = -0.03;
  boot.scale.setScalar(0.92);
  g.add(boot);
  return g;
}

/** One half: 0 = the whole bike (under the left pedal), 1 = the right pedal. */
export function createBikeHalf(i: number): THREE.Group {
  const half = new THREE.Group();
  half.add(pedal());
  if (i === 0) {
    const b = bike();
    b.name = 'bike';
    b.position.x = PEDAL_X; // the centreline, right of the left pedal
    half.add(b);
  }
  return half;
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();

/**
 * Move the bike's parts: wheels rolled `roll` radians, the front end steered
 * `steer` rad, the suspension squashed (0..1) and the cranks at `crank` rad.
 * Works on the posed half and on the ragdoll's visible copy alike.
 */
export function animateBike(half: THREE.Object3D, roll: number, steer: number, squash: number, crank: number): void {
  const bike = half.getObjectByName('bike');
  if (!bike) return;
  const front = bike.getObjectByName('front')!;
  front.quaternion.setFromAxisAngle(front.userData.axis as THREE.Vector3, steer);
  const lowers = bike.getObjectByName('lowers')!;
  lowers.position.copy(FORK_AXIS).multiplyScalar(squash * FORK_TRAVEL);
  bike.getObjectByName('frontWheel')!.rotation.x = -roll;
  const swing = bike.getObjectByName('swing')!;
  swing.rotation.x = -squash * REAR_TRAVEL_ANGLE; // the axle comes up
  bike.getObjectByName('rearWheel')!.rotation.x = -roll;
  bike.getObjectByName('cranks')!.rotation.x = -crank;
  // The shock: from its frame mount to the rocker, wherever the swingarm is
  const shock = bike.getObjectByName('shock')!;
  const top = shock.userData.top as THREE.Vector3;
  const rocker = tmpA.copy(shock.userData.rocker as THREE.Vector3).applyEuler(swing.rotation).add(swing.position);
  const d = tmpB.subVectors(rocker, top);
  const len = d.length();
  shock.position.copy(top).addScaledVector(d, 0.5);
  shock.quaternion.copy(tmpQ.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.divideScalar(len)));
  shock.getObjectByName('shockBody')!.scale.set(1, len, 1);
  const spring = shock.getObjectByName('shockSpring')!;
  spring.scale.set(1, len * 0.55, 1);
  spring.position.y = -len * 0.15;
}
