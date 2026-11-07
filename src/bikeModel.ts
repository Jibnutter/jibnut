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
const TIRE = 0.034;
/** Bike mass (kg), split over the two halves for the physics. */
export const BIKE_MASS = 14;
const FORK_TRAVEL = 0.12;
const REAR_TRAVEL_ANGLE = 0.22; // rad of swingarm at full squash
const FORK_TRAVEL_DH = 0.18; // a downhill bike's longer travel
const REAR_TRAVEL_ANGLE_DH = 0.32;

/**
 * A frame design (from the bike workshop). Lengths in metres from the
 * bottom bracket; the ranges in DESIGN_RANGES keep it rideable.
 */
export interface BikeDesign {
  frameColor: number;
  forkColor: number;
  headAngle: number; // degrees from level: slacker (lower) is longer and more stable-looking
  reach: number; // how far forward the head tube's top is
  stack: number; // how high the head tube's top is
  chainstay: number; // back wheel's axle behind the BB
  wheel: 27.5 | 29; // wheel size (inches)
  tubes: 'slim' | 'normal' | 'burly';
  topTube: 'straight' | 'dropped';
  /**
   * Trail: a single-crown fork and a shock up in the frame. Downhill: a
   * dual-crown fork, a low bent top tube, the shock low in the front
   * triangle driven by two short links round the bottom bracket, a boxy
   * swingarm and more travel.
   */
  style: 'trail' | 'downhill' | 'mine';
}

export const DEFAULT_DESIGN: BikeDesign = {
  frameColor: 0xff7a1c,
  forkColor: 0xd8a63a,
  headAngle: 64,
  reach: 0.5,
  stack: 0.6,
  chainstay: 0.44,
  wheel: 29,
  tubes: 'normal',
  topTube: 'straight',
  style: 'trail',
};

export const DESIGN_RANGES = {
  headAngle: { min: 60, max: 69, step: 0.5 },
  reach: { min: 0.42, max: 0.54, step: 0.01 },
  stack: { min: 0.54, max: 0.66, step: 0.01 },
  chainstay: { min: 0.41, max: 0.48, step: 0.005 },
};

/** The design's key points, in the bike's own frame (BB at the origin, forward -z). */
function geometry(d: BikeDesign) {
  const wheelR = d.wheel === 29 ? 0.37 : 0.35;
  const axleY = wheelR - BB_HEIGHT;
  const a = THREE.MathUtils.degToRad(d.headAngle);
  const steer = new THREE.Vector3(0, Math.sin(a), Math.cos(a)); // up the head tube (leaning back)
  const headTop = new THREE.Vector3(0, d.stack, -d.reach);
  const headBottom = headTop.clone().addScaledVector(steer, -0.17);
  // The fork runs on down the steering axis to the front axle (plus a little offset forward)
  const t = (headBottom.y - axleY) / steer.y;
  const frontAxle = headBottom.clone().addScaledVector(steer, -t).add(new THREE.Vector3(0, 0, -0.044));
  frontAxle.y = axleY;
  const rearAxle = new THREE.Vector3(0, axleY, d.chainstay);
  const seatTop = new THREE.Vector3(0, 0.56, 0.13);
  const tube = { slim: 0.8, normal: 1, burly: 1.3 }[d.tubes];
  const barCentre = headTop.clone().add(new THREE.Vector3(0, 0.09, 0.02));
  return {
    wheelR,
    headTop,
    headBottom,
    frontAxle,
    rearAxle,
    seatTop,
    pivot: new THREE.Vector3(0, 0.1, 0.06), // swingarm pivot, just above and behind the BB
    shockFrame: new THREE.Vector3(0, 0.36 * (d.stack / 0.6), -0.14),
    forkAxis: headBottom.clone().sub(frontAxle).normalize(), // up the fork
    steer,
    tube,
    barCentre,
  };
}

// ---------------------------------------------------------------------------
// "My frame": a frame modelled in Tinkercad (src/models/tinkercad-frame.glb),
// one solid piece with its own colours: frame, swingarm, shock, fork, bars.
// It's scaled and placed so its fork bottom and rear dropout land on the
// wheel axles; the game's own wheels, cranks and pedals go with it.

interface FrameModel {
  geometry: THREE.BufferGeometry; // in the model's own space (Tinkercad mm, y up)
  front: THREE.Vector3; // its front axle (the fork's bottom)
  rear: THREE.Vector3; // its rear axle (the swingarm's end)
  grips: THREE.Vector3[]; // its bar ends, left and right
  seat: THREE.Vector3; // the top of its seat tube (the model has no saddle: ours goes there)
}
let frameModel: FrameModel | null = null;
const BAR_BAND = 0.045; // the top this much of the model's length is the bars
const BAR_WIDEN = 1.5; // the bars' ends pulled out this much (about 0.6 m → 0.8 m wide)
/** Whether the Tinkercad frame is loaded (the workshop offers it once it is). */
export function hasFrameModel(): boolean {
  return !!frameModel;
}

/** Load the Tinkercad frame (once, at startup). */
export async function loadFrameModel(): Promise<void> {
  const [{ GLTFLoader }, { mergeGeometries }, { default: url }] = await Promise.all([
    import('three/addons/loaders/GLTFLoader.js'),
    import('three/addons/utils/BufferGeometryUtils.js'),
    import('./models/tinkercad-frame.glb?url'),
  ]);
  const gltf = await new GLTFLoader().loadAsync(url);
  gltf.scene.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'color') g.deleteAttribute(name);
    parts.push(g);
  });
  const geometry = mergeGeometries(parts);
  // Its key points: bike pointing along +x, up +y
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const len = box.max.x - box.min.x;
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  // Wider bars: the top band (the bars, above the stem and crown) pulled out
  // sideways, the middle (the stem clamp) left as it is
  const barsFrom = box.max.y - len * BAR_BAND;
  const clamp = len * 0.065;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) < barsFrom) continue;
    const z = pos.getZ(i);
    if (Math.abs(z) > clamp) pos.setZ(i, Math.sign(z) * (clamp + (Math.abs(z) - clamp) * BAR_WIDEN));
  }
  geometry.computeBoundingBox();
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < pos.count; i++) pts.push(new THREE.Vector3().fromBufferAttribute(pos, i));
  const mean = (a: THREE.Vector3[]) => a.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(Math.max(1, a.length));
  const nose = pts.filter((p) => p.x > box.max.x - len * 0.2);
  const lowest = Math.min(...nose.map((p) => p.y));
  const front = mean(nose.filter((p) => p.y < lowest + len * 0.012));
  const rear = mean(pts.filter((p) => p.x < box.min.x + len * 0.02));
  const top = pts.filter((p) => p.y > box.max.y - len * 0.04);
  const grips = [top.reduce((m, p) => (p.z < m.z ? p : m)), top.reduce((m, p) => (p.z > m.z ? p : m))];
  // The seat tube's top: the highest point in the back half
  const back = pts.filter((p) => p.x < box.min.x + len * 0.55);
  const peak = back.reduce((m, p) => (p.y > m.y ? p : m));
  const seat = mean(back.filter((p) => p.y > peak.y - len * 0.02));
  frameModel = { geometry, front, rear, grips, seat };
}

/**
 * The transform taking the Tinkercad model into the bike's frame (BB at the
 * origin, forward -z): a quarter turn (its +x forward becomes -z), then a
 * scale, tilt and shift so its front and rear axles land on the design's.
 */
function frameTransform(d: BikeDesign): THREE.Matrix4 {
  const fm = frameModel!;
  const g = geometry(d);
  const turn = new THREE.Matrix4().makeRotationY(Math.PI / 2);
  const f = fm.front.clone().applyMatrix4(turn);
  const r = fm.rear.clone().applyMatrix4(turn);
  const from = f.clone().sub(r);
  const to = g.frontAxle.clone().sub(g.rearAxle);
  const scale = to.length() / from.length();
  const tilt = new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(), to.clone().normalize());
  const m = new THREE.Matrix4().compose(new THREE.Vector3(), tilt, new THREE.Vector3(scale, scale, scale)).multiply(turn);
  // Shift: the rear axle onto the design's
  const rNow = fm.rear.clone().applyMatrix4(m);
  return new THREE.Matrix4().makeTranslation(g.rearAxle.x - rNow.x, g.rearAxle.y - rNow.y, g.rearAxle.z - rNow.z).multiply(m);
}

/** Where the hands hold the bars (in half 0's frame): left and right grips. */
export function gripsFor(d: BikeDesign): THREE.Vector3[] {
  if (d.style === 'mine' && frameModel) {
    // The model's own bar ends (pulled in a little: hands sit inside the ends)
    const m = frameTransform(d);
    return frameModel.grips.map((p) => {
      const v = p.clone().applyMatrix4(m);
      v.x *= 0.88;
      v.x += PEDAL_X;
      return v;
    });
  }
  const c = geometry(d).barCentre;
  return [-1, 1].map((s) => new THREE.Vector3(PEDAL_X + s * 0.37, c.y + 0.02, c.z));
}
/** The default design's grips (the rider's pose is fitted to these). */
export const GRIPS = gripsFor(DEFAULT_DESIGN);

/** The ragdoll's collision box for the bike (half 0's frame): centre and half-sizes. */
export function bikeBox(d: BikeDesign): { centre: THREE.Vector3; half: THREE.Vector3 } {
  const g = geometry(d);
  const front = g.frontAxle.z - g.wheelR * 0.6;
  const back = g.rearAxle.z + g.wheelR * 0.6;
  const bottom = -BB_HEIGHT;
  const top = g.wheelR - BB_HEIGHT + 0.3;
  return {
    centre: new THREE.Vector3(PEDAL_X, (top + bottom) / 2, (front + back) / 2),
    half: new THREE.Vector3(0.05, (top - bottom) / 2, (back - front) / 2),
  };
}

const sharedMats: Record<'black' | 'tire' | 'metal' | 'rim', THREE.Material> = {
  black: new THREE.MeshStandardMaterial({ color: 0x17181b, roughness: 0.55, metalness: 0.2 }),
  tire: new THREE.MeshStandardMaterial({ color: 0x1b1b1b, roughness: 0.95 }),
  metal: new THREE.MeshStandardMaterial({ color: 0xb9c0c8, roughness: 0.3, metalness: 0.9 }),
  rim: new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.4, metalness: 0.6 }),
};
function materials(d: BikeDesign = DEFAULT_DESIGN) {
  return {
    ...sharedMats,
    frame: new THREE.MeshStandardMaterial({ color: d.frameColor, roughness: 0.35, metalness: 0.2 }),
    gold: new THREE.MeshStandardMaterial({ color: d.forkColor, roughness: 0.25, metalness: 0.8 }),
  };
}

/** A flat-sided bar between two points (boxy frame members): w across, h deep. */
function box(a: THREE.Vector3, b: THREE.Vector3, w: number, h: number, mat: THREE.Material): THREE.Mesh {
  const d = b.clone().sub(a);
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, d.length(), h), mat);
  m.position.copy(a).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  m.castShadow = true;
  return m;
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
function wheel(WHEEL_R: number): THREE.Group {
  const m = sharedMats;
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
export function buildBike(d: BikeDesign = DEFAULT_DESIGN): THREE.Group {
  const m = materials(d);
  const G = geometry(d);
  const { headTop: HEAD_TOP, headBottom: HEAD_BOTTOM, seatTop: SEAT_TOP, pivot: PIVOT, shockFrame: SHOCK_FRAME } = G;
  const REAR_AXLE = G.rearAxle;
  const FRONT_AXLE = G.frontAxle;
  const FORK_AXIS = G.forkAxis;
  const k = G.tube; // tube thickness
  const bike = new THREE.Group();
  bike.userData.forkAxis = FORK_AXIS;
  if (d.style === 'mine' && frameModel) return buildMine(d, bike);
  const dh = d.style === 'downhill';
  bike.userData.forkTravel = dh ? FORK_TRAVEL_DH : FORK_TRAVEL;
  bike.userData.rearTravel = dh ? REAR_TRAVEL_ANGLE_DH : REAR_TRAVEL_ANGLE;

  // Front triangle (frame)
  bike.add(tube(new THREE.Vector3(0, 0, 0), HEAD_BOTTOM, 0.03 * k * (dh ? 1.15 : 1), m.frame, 0.026 * k * (dh ? 1.15 : 1))); // down tube
  if (dh) {
    // Downhill: a top tube that bends down from the head tube to a short
    // seat tube, with a brace from the bend to the down tube
    const bend = HEAD_TOP.clone().lerp(SEAT_TOP, 0.55).add(new THREE.Vector3(0, -0.03, 0));
    const seatLow = SEAT_TOP.clone().multiplyScalar(0.78);
    bike.add(tube(HEAD_TOP, bend, 0.026 * k, m.frame));
    bike.add(tube(bend, seatLow, 0.024 * k, m.frame));
    bike.add(tube(bend, new THREE.Vector3(0, 0.2, -0.24), 0.017 * k, m.frame));
  } else if (d.topTube === 'dropped') {
    // A low, swooping top tube: down from the head tube to the seat tube's
    // middle, with a strut up to the seat cluster
    const mid = SEAT_TOP.clone().multiplyScalar(0.62);
    bike.add(tube(mid, HEAD_TOP.clone().lerp(HEAD_BOTTOM, 0.3), 0.022 * k, m.frame));
    bike.add(tube(mid.clone().lerp(SEAT_TOP, 0.1), SEAT_TOP.clone().lerp(HEAD_TOP, 0.18), 0.015 * k, m.frame));
  } else {
    bike.add(tube(SEAT_TOP, HEAD_TOP, 0.022 * k, m.frame)); // top tube
  }
  const seatTop = dh ? SEAT_TOP.clone().multiplyScalar(0.78) : SEAT_TOP;
  bike.add(tube(new THREE.Vector3(0, 0.02, 0.02), seatTop, 0.022 * k, m.frame)); // seat tube
  bike.add(tube(HEAD_BOTTOM, HEAD_TOP, 0.032 * k, m.frame)); // head tube
  // Seat post (dropper, lowered: slammed right down on a downhill bike) and saddle
  const postTop = seatTop.clone().add(new THREE.Vector3(0, dh ? 0.05 : 0.1, 0.03));
  bike.add(tube(seatTop, postTop, 0.016, m.black));
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
  let rocker: THREE.Vector3;
  if (dh) {
    // A boxy swingarm: deep, flat-sided chainstays and seatstays meeting
    // in a short stay brace; the shock pushes on it low, just ahead of the
    // pivot (through the two short links, below)
    const stayTop = new THREE.Vector3(0, 0.27, 0.12);
    for (const side of [-1, 1]) {
      const off = new THREE.Vector3(side * 0.06, 0, 0);
      swing.add(box(off.clone(), axle.clone().add(off), 0.022 * k, 0.05 * k, m.frame)); // chainstay
      swing.add(box(stayTop.clone().add(off), axle.clone().add(off), 0.02 * k, 0.035 * k, m.frame)); // seatstay
    }
    swing.add(box(stayTop.clone().add(new THREE.Vector3(-0.06, 0, 0)), stayTop.clone().add(new THREE.Vector3(0.06, 0, 0)), 0.03, 0.03, m.frame));
    rocker = new THREE.Vector3(0, 0.03, -0.05);
    // The two short links round the BB: little plates, frame to swingarm
    for (const [a, b] of [
      [new THREE.Vector3(0, -0.04, 0.02), new THREE.Vector3(0, -0.02, 0.1)],
      [new THREE.Vector3(0, 0.15, 0.04), new THREE.Vector3(0, 0.16, 0.12)],
    ]) {
      for (const side of [-1, 1]) {
        const o = new THREE.Vector3(side * 0.04, 0, 0);
        bike.add(box(a.clone().add(o), b.clone().add(o), 0.012, 0.03, m.black));
      }
    }
  } else {
    for (const side of [-1, 1]) {
      const off = new THREE.Vector3(side * 0.06, 0, 0);
      swing.add(tube(off.clone(), axle.clone().add(off), 0.016 * k, m.frame)); // chainstay
      const stayTop = new THREE.Vector3(side * 0.05, 0.3, 0.06);
      swing.add(tube(stayTop, axle.clone().add(off), 0.013 * k, m.frame)); // seatstay
    }
    rocker = new THREE.Vector3(0, 0.3, 0.06);
    swing.add(tube(new THREE.Vector3(-0.05, 0.3, 0.06), new THREE.Vector3(0.05, 0.3, 0.06), 0.012, m.frame));
  }
  const rear = wheel(G.wheelR);
  rear.name = 'rearWheel';
  rear.position.copy(axle);
  swing.add(rear);
  bike.add(swing);
  // The shock: from the frame to the rocker (stretched each frame)
  const shock = new THREE.Group();
  shock.name = 'shock';
  // (Downhill: the shock lies low in the front triangle, off the down tube)
  shock.userData.top = dh ? new THREE.Vector3(0, 0.24, -0.26) : SHOCK_FRAME.clone();
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
  front.userData.axis = G.steer.clone();
  const crown = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.035, 0.05), m.black);
  crown.position.y = -0.03;
  front.add(crown);
  const axleF = FRONT_AXLE.clone().sub(HEAD_BOTTOM);
  const headLen = HEAD_TOP.distanceTo(HEAD_BOTTOM);
  for (const side of [-1, 1]) {
    // (Downhill: dual-crown, the stanchions run on up past the head tube to
    // a second crown above it)
    const top = dh
      ? G.steer.clone().multiplyScalar(headLen + 0.04).add(new THREE.Vector3(side * 0.07, 0, 0))
      : new THREE.Vector3(side * 0.065, -0.03, 0);
    const lowerTop = axleF.clone().addScaledVector(FORK_AXIS, 0.28).add(new THREE.Vector3(side * (dh ? 0.07 : 0.065), 0, 0));
    front.add(tube(top, lowerTop.clone().addScaledVector(FORK_AXIS, -0.05), dh ? 0.019 : 0.017, m.gold)); // stanchion
  }
  if (dh) {
    const upper = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.03, 0.06), m.black);
    upper.position.copy(G.steer).multiplyScalar(headLen + 0.03);
    front.add(upper);
  }
  const lowers = new THREE.Group();
  lowers.name = 'lowers';
  for (const side of [-1, 1]) {
    const a = axleF.clone().add(new THREE.Vector3(side * 0.065, 0, 0));
    lowers.add(tube(a, a.clone().addScaledVector(FORK_AXIS, 0.3), 0.022, m.black));
  }
  const frontWheel = wheel(G.wheelR);
  frontWheel.name = 'frontWheel';
  frontWheel.position.copy(axleF);
  lowers.add(frontWheel);
  front.add(lowers);
  // Stem and bars (riser bars, wide; on a downhill bike the stem sits on
  // the upper crown)
  const stemTop = HEAD_TOP.clone().sub(HEAD_BOTTOM).add(new THREE.Vector3(0, dh ? 0.07 : 0.05, 0));
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

/**
 * The Tinkercad frame (rigid: it's one piece, so the fork and swingarm don't
 * move), with the game's wheels at its axles, cranks at the BB.
 */
function buildMine(d: BikeDesign, bike: THREE.Group): THREE.Group {
  const g = geometry(d);
  const frame = new THREE.Mesh(
    frameModel!.geometry.clone().applyMatrix4(frameTransform(d)),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.1 }),
  );
  frame.geometry.computeVertexNormals();
  frame.castShadow = true;
  bike.add(frame);
  bike.userData.forkTravel = 0;
  bike.userData.rearTravel = 0;
  bike.userData.noSteer = true;
  // The wheels (rolling), in the groups animateBike looks for
  const front = new THREE.Group();
  front.name = 'front';
  front.userData.axis = g.steer.clone();
  const lowers = new THREE.Group();
  lowers.name = 'lowers';
  const fw = wheel(g.wheelR);
  fw.name = 'frontWheel';
  fw.position.copy(g.frontAxle);
  lowers.add(fw);
  front.add(lowers);
  bike.add(front);
  const swing = new THREE.Group();
  swing.name = 'swing';
  const rw = wheel(g.wheelR);
  rw.name = 'rearWheel';
  rw.position.copy(g.rearAxle);
  swing.add(rw);
  bike.add(swing);
  // Cranks, turning at the BB
  const m = sharedMats;
  const cranks = new THREE.Group();
  cranks.name = 'cranks';
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.008, 24), m.black);
  ring.rotation.z = Math.PI / 2;
  ring.position.x = 0.05;
  cranks.add(ring);
  for (const side of [-1, 1]) cranks.add(tube(new THREE.Vector3(side * 0.05, 0, 0), new THREE.Vector3(side * 0.07, side * 0.17, 0), 0.012, m.black));
  bike.add(cranks);
  // A seat: a post up from the seat tube's top, and a saddle on it
  const seatTop = frameModel!.seat.clone().applyMatrix4(frameTransform(d));
  const postTop = seatTop.clone().add(new THREE.Vector3(0, 0.07, 0.015));
  bike.add(tube(seatTop, postTop, 0.016, m.black));
  const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.04, 0.27), m.black);
  saddle.position.copy(postTop).add(new THREE.Vector3(0, 0.025, 0.02));
  saddle.castShadow = true;
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.035, 0.1), m.black);
  nose.position.copy(saddle.position).add(new THREE.Vector3(0, -0.003, -0.15));
  nose.castShadow = true;
  bike.add(saddle, nose);
  return bike;
}

/** Flat pedal under a boot (at the half's origin), with the boot on it. */
function pedal(): THREE.Group {
  const m = sharedMats;
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
export function createBikeHalf(i: number, design: BikeDesign = DEFAULT_DESIGN): THREE.Group {
  const half = new THREE.Group();
  half.add(pedal());
  if (i === 0) {
    const b = buildBike(design);
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
  front.quaternion.setFromAxisAngle(front.userData.axis as THREE.Vector3, bike.userData.noSteer ? 0 : steer);
  const lowers = bike.getObjectByName('lowers')!;
  lowers.position.copy(bike.userData.forkAxis as THREE.Vector3).multiplyScalar(squash * (bike.userData.forkTravel as number));
  bike.getObjectByName('frontWheel')!.rotation.x = -roll;
  const swing = bike.getObjectByName('swing')!;
  swing.rotation.x = -squash * (bike.userData.rearTravel as number); // the axle comes up
  bike.getObjectByName('rearWheel')!.rotation.x = -roll;
  bike.getObjectByName('cranks')!.rotation.x = -crank;
  // The shock: from its frame mount to the rocker, wherever the swingarm is
  const shock = bike.getObjectByName('shock');
  if (!shock) return; // (the Tinkercad frame has its own, fixed)
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
