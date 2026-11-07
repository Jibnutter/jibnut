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
import type { SecondaryMotion } from './secondary';
import { createHeadgear } from './helmet';
import { createBootCuff } from './gear';
import { BOARD_STANCE } from './boardModel';

/**
 * Placeholder human: a three-part spine (pelvis, abdomen, chest), a sphere
 * head, and four two-segment limbs (thigh + shin, upper arm + forearm).
 * Every part is a simple shape between two joints, so the same list becomes
 * the ragdoll's bodies, with joints at the spine, neck, hips, knees,
 * shoulders and elbows.
 *
 * Local frame: feet on the skis at y ≈ 0, facing -Z, +X to the right.
 */

/** Green: the cloth shorts, and the thighs and hips under them. */
export const PANTS_COLOR = 0x3f8f3a;
/** The T-shirt (see tee.ts), and the torso under it. */
export const SHIRT_COLOR = 0xf1efe8;
const SKIN_COLOR = 0xf0c8a0;

/** Body measurements in metres, shared by meshes, collision and physics. */
export const BODY = {
  ankleHeight: 0.12, // top of the boot, where the shin meets it
  stance: 0.18, // half the distance between the feet

  hipWidth: 0.1, // half the distance between the hip joints
  thigh: 0.45,
  thighRadius: 0.075,
  shin: 0.45,
  shinRadius: 0.06,

  // Spine, bottom to top: hip centre -> pelvis -> abdomen -> chest -> shoulder centre
  pelvis: 0.15,
  pelvisRadius: 0.13,
  abdomen: 0.15,
  abdomenRadius: 0.12,
  chest: 0.2,
  chestRadius: 0.15,

  shoulderWidth: 0.2, // half the distance between the shoulder joints
  upperArm: 0.3,
  upperArmRadius: 0.05,
  forearm: 0.28,
  forearmRadius: 0.045,

  neck: 0.08, // gap between shoulder centre and the bottom of the head
  headRadius: 0.12,
};

/** Rough mass per part in kg, for the physics bodies. */
export const MASS = {
  pelvis: 14,
  abdomen: 10,
  chest: 16,
  head: 5,
  thigh: 9,
  shin: 5,
  upperArm: 2.5,
  forearm: 2,
};

/** What the posing code controls. */
export interface Pose {
  hipHeight: number; // hip centre above the feet
  hipBack: number; // how far the hips sit behind the feet (+Z)
  torsoPitch: number; // forward lean of the torso, radians
  lean: number; // sideways lean into a turn, radians (+ = left)
  armsOut: number; // -1 = hugged to the chest, 0 = hands forward holding poles, 1 = out for balance
  armsUp: number; // 0..1: reaching up over the head, along the spine
  twist: number; // upper body turned about the spine, radians (+ = to the left)
  look: number; // head turned over a shoulder: +1 = fully over the left, -1 = over the right
  grab: number; // 0..1: the X tail grab (skis crossed, right hand on the right ski's tail; see GRAB)
  shifty: number; // -1..1: a shifty (skis turned one way, shoulders the other; see SHIFTY)
}

// hipBack values are solved so the centre of mass (body + skis) sits right
// over the feet, except the two leans: 8 cm behind / ahead of the feet.
export const RIDING: Pose = { hipHeight: 0.86, hipBack: 0.14, torsoPitch: 0.35, lean: 0, armsOut: 0, twist: 0, look: 0, armsUp: 0, grab: 0, shifty: 0 };
export const TUCK: Pose = { hipHeight: 0.62, hipBack: 0.27, torsoPitch: 1.0, lean: 0, armsOut: 0, twist: 0, look: 0, armsUp: 0, grab: 0, shifty: 0 };
export const CROUCH: Pose = { hipHeight: 0.6, hipBack: 0.23, torsoPitch: 0.7, lean: 0, armsOut: 0, twist: 0, look: 0, armsUp: 0, grab: 0, shifty: 0 };
export const AIR: Pose = { hipHeight: 0.78, hipBack: 0.12, torsoPitch: 0.3, lean: 0, armsOut: 1, twist: 0, look: 0, armsUp: 0, grab: 0, shifty: 0 };
// Loading a jump with weight shifted: back (for a backflip) or forward
export const LEAN_BACK: Pose = { hipHeight: 0.62, hipBack: 0.23, torsoPitch: 0.25, lean: 0, armsOut: 0, twist: 0, look: 0, armsUp: 0, grab: 0, shifty: 0 };
export const LEAN_FORWARD: Pose = { hipHeight: 0.62, hipBack: 0.18, torsoPitch: 1.05, lean: 0, armsOut: 0, twist: 0, look: 0, armsUp: 0, grab: 0, shifty: 0 };
// In the air: pulled into a tight ball (rotates fast) or stretched out (slow)
// Backflip arch: the whole body bowed backwards like a banana. Legs straight
// and trailing (hips pushed forward of the feet; hip height past full leg
// reach, so the leg solver straightens them rather than bending the knees), back arching more
// towards the top, head back, arms reaching up over the head along the arch.
// Far less compact than the forward ball: the skier flips as fast as with
// the ball anyway (see Skier.updateMass), so backflip tricks stay as tuned.
export const AIR_ARCH: Pose = { hipHeight: 1.05, hipBack: -0.25, torsoPitch: -0.7, lean: 0, armsOut: 0, twist: 0, look: 0, armsUp: 1, grab: 0, shifty: 0 };
export const AIR_TUCK: Pose = { hipHeight: 0.42, hipBack: 0.27, torsoPitch: 1.0, lean: 0, armsOut: 0, twist: 0, look: 0, armsUp: 0, grab: 0, shifty: 0 };
// In the air, upright with arms hugged in: the fastest shape for spinning
export const AIR_SPIN: Pose = { hipHeight: 0.86, hipBack: 0.07, torsoPitch: 0.1, lean: 0, armsOut: -1, twist: 0, look: 0, armsUp: 0, grab: 0, shifty: 0 };
// The X tail grab: crouched, knees up, the skis crossed into an X, the right
// foot pulled up with its ski's tail tilted up, and the right hand reaching
// down beside the hip to hold it. (The legs and skis are placed by GRAB.)
export const AIR_GRAB: Pose = { hipHeight: 0.66, hipBack: 0.16, torsoPitch: 0.4, lean: -0.3, armsOut: 0.6, twist: -0.35, look: 0, armsUp: 0, grab: 1, shifty: 0 };
// Snowboard grab (an Indy): knees pulled up, crouched, the back hand
// reaching down to the toe edge between the bindings. (Feet placed by pose.)
export const AIR_INDY: Pose = { hipHeight: 0.66, hipBack: 0.18, torsoPitch: 1.0, lean: 0, armsOut: 0.6, twist: 0.5, look: 0, armsUp: 0, grab: 1, shifty: 0 };
export const AIR_OPEN: Pose = { hipHeight: 0.98, hipBack: 0.01, torsoPitch: -0.05, lean: 0, armsOut: 1, twist: 0, look: 0, armsUp: 0, grab: 0, shifty: 0 };

export function lerpPose(a: Pose, b: Pose, t: number, out: Pose): Pose {
  out.hipHeight = a.hipHeight + (b.hipHeight - a.hipHeight) * t;
  out.hipBack = a.hipBack + (b.hipBack - a.hipBack) * t;
  out.torsoPitch = a.torsoPitch + (b.torsoPitch - a.torsoPitch) * t;
  out.lean = a.lean + (b.lean - a.lean) * t;
  out.armsOut = a.armsOut + (b.armsOut - a.armsOut) * t;
  out.armsUp = a.armsUp + (b.armsUp - a.armsUp) * t;
  out.twist = a.twist + (b.twist - a.twist) * t;
  out.look = a.look + (b.look - a.look) * t;
  out.grab = a.grab + (b.grab - a.grab) * t;
  out.shifty = a.shifty + (b.shifty - a.shifty) * t;
  return out;
}

/** A capsule drawn between two joint positions. */
export class Segment {
  readonly mesh: THREE.Mesh;
  readonly length: number;
  readonly radius: number;
  readonly mass: number;

  constructor(length: number, radius: number, mass: number, material: THREE.Material) {
    this.length = length;
    this.radius = radius;
    this.mass = mass;
    // CapsuleGeometry's length is the straight part; the rounded ends then
    // overlap at the joints, which makes neat rounded knees and elbows
    this.mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 4, 12), material);
    this.mesh.castShadow = true;
  }

  /** Stretch between joint a and joint b (only the direction is used). */
  /**
   * Between joints a and b. For a limb, hinge is the axis its middle joint
   * (knee, elbow) bends about (see limbHinge): the part is turned about its
   * own length so its x axis lies along it, so the limb twists as a whole
   * (a leg with its ski) instead of keeping an arbitrary facing. Standing,
   * that's the orientation it has anyway.
   */
  place(a: THREE.Vector3, b: THREE.Vector3, hinge?: THREE.Vector3): void {
    const dir = tmpDir.subVectors(b, a);
    const len = dir.length();
    this.mesh.position.copy(a).addScaledVector(dir, 0.5 * (this.length / len));
    dir.divideScalar(len);
    const q = this.mesh.quaternion.setFromUnitVectors(UP, dir);
    if (!hinge) return;
    const x = tmpXAxis.set(1, 0, 0).applyQuaternion(q);
    q.premultiply(tmpYaw.setFromUnitVectors(x, hinge));
  }
}

const UP = new THREE.Vector3(0, 1, 0);
const tmpDir = new THREE.Vector3();
const tmpPitchQ = new THREE.Quaternion();
const tmpFlexQ = new THREE.Quaternion();
const tmpSkiUp = new THREE.Vector3();
const tmpHold = new THREE.Vector3();
const tmpYaw = new THREE.Quaternion();
const tmpHinge = new THREE.Vector3();
const tmpXAxis = new THREE.Vector3();

/**
 * The X tail grab, at full strength, in the stance frame. Each leg turns
 * (left knee and ski tip in to the right, right in to the left, so the skis
 * cross into an X); the right foot comes up behind, heel towards the butt,
 * which tips its ski tail-up. The skis follow the shins as stiff boots do.
 */
export const GRAB = {
  yaw: [-0.55, 0.55], // left, right leg and ski: + = tip to the left
  // Right ankle: up and back, heel towards the butt, so the tail comes up beside the hip
  rightAnkle: new THREE.Vector3(0.2, 0.32, 0.3),
  leftAnkle: new THREE.Vector3(-0.16, 0.18, 0),
  /** Where the hand holds the right ski: along it from the boot (+ = towards the tail), and above its base. */
  hold: { along: 0.5, up: 0.03 },
};
/** A shifty at full strength: skis turned this far (rad, + = tips left), shoulders back the other way. */
// (45° to the left, tips dipped a little)
export const SHIFTY = { skis: Math.PI / 4, shoulders: 0.55, tipDown: 0.2 };
/** On a board, the grab pulls both feet up this far. */
const BOARD_GRAB_LIFT = 0.26;
/** The ski's origin (its base, under the boot) sits this far below the ankle. */
const ANKLE_ABOVE_SKI = BODY.ankleHeight - 0.015;

/** Mass, centre of mass and pitch inertia of the posed body (plus skis). */
export interface MassProperties {
  mass: number; // kg
  com: THREE.Vector3; // centre of mass, in the person's local frame
  /** Moment of inertia about the side-to-side axis through the COM, kg m². */
  pitchInertia: number;
  /** Moment of inertia about the up axis through the COM (for spins), kg m². */
  yawInertia: number;
  /** Moment of inertia about the front-to-back axis through the COM (roll), kg m². */
  rollInertia: number;
}

/** A rod of mass m and length L along unit dir d, at point p. */
interface Rod {
  m: number;
  L: number;
  r: number;
  p: THREE.Vector3;
  d: THREE.Vector3;
}

/**
 * Pitch (X-axis) inertia about the COM: each part as a thick rod.
 * Parallel axis: m·(dy² + dz²) for where it sits, plus its own spin inertia
 * m·L²/12 scaled by how much the rod lies across the X axis (1 - dx²).
 */
/** Same idea about the front-to-back (Z) axis: how hard the body is to roll. */
function rollInertia(rods: Rod[], com: THREE.Vector3): number {
  let I = 0;
  for (const { m, L, r, p, d } of rods) {
    const dx = p.x - com.x;
    const dy = p.y - com.y;
    I += m * (dx * dx + dy * dy) + ((m * L * L) / 12) * (1 - d.z * d.z) + (m * r * r) / 2;
  }
  return I;
}

/** Same idea about the up (Y) axis: how hard the body is to spin. */
function yawInertia(rods: Rod[], com: THREE.Vector3): number {
  let I = 0;
  for (const { m, L, r, p, d } of rods) {
    const dx = p.x - com.x;
    const dz = p.z - com.z;
    I += m * (dx * dx + dz * dz) + ((m * L * L) / 12) * (1 - d.y * d.y) + (m * r * r) / 2;
  }
  return I;
}

function pitchInertia(rods: Rod[], com: THREE.Vector3): number {
  let I = 0;
  for (const { m, L, r, p, d } of rods) {
    const dy = p.y - com.y;
    const dz = p.z - com.z;
    I += m * (dy * dy + dz * dz) + ((m * L * L) / 12) * (1 - d.x * d.x) + (m * r * r) / 2;
  }
  return I;
}
const tmpU = new THREE.Vector3();
const tmpV = new THREE.Vector3();

/**
 * Two-bone IK: where does the middle joint (knee or elbow) go so that the
 * limb reaches from root to target? It bends towards `pole`.
 * Writes the middle joint into `out` and returns the actual end point.
 */
function solveLimb(
  root: THREE.Vector3,
  target: THREE.Vector3,
  upper: number,
  lower: number,
  pole: THREE.Vector3,
  out: THREE.Vector3,
): void {
  const u = tmpU.subVectors(target, root);
  const d = Math.min(u.length(), upper + lower - 1e-4);
  u.normalize();
  // Bend direction: the pole with its component along the limb removed
  const v = tmpV.copy(pole).addScaledVector(u, -pole.dot(u)).normalize();
  // Law of cosines: angle at the root between the limb line and the upper bone
  const cosA = THREE.MathUtils.clamp((upper * upper + d * d - lower * lower) / (2 * upper * d), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  out.copy(root).addScaledVector(u, upper * cosA).addScaledVector(v, upper * sinA);
}

/**
 * The axis a two-part limb from root to end bends about, its middle joint
 * pushed towards pole (as solveLimb places it): square to the plane of the
 * limb's line and the pole. Taken from the limb's whole line, not each part,
 * so it can't flip when a part swings past the pole (a knee pulled up above
 * the hip). side picks which way round it runs, to match the rest pose.
 */
function limbHinge(root: THREE.Vector3, end: THREE.Vector3, pole: THREE.Vector3, side: number, out: THREE.Vector3): THREE.Vector3 | undefined {
  out.subVectors(end, root).cross(pole).multiplyScalar(side);
  if (out.lengthSq() < 1e-8) return undefined; // limb along the pole: no plane
  return out.normalize();
}

export class Person {
  readonly group = new THREE.Group();
  readonly pelvis: Segment;
  readonly abdomen: Segment;
  readonly chest: Segment;
  /** Pelvis, abdomen, chest: bottom to top. */
  readonly spine: [Segment, Segment, Segment];
  readonly head: THREE.Mesh;
  readonly thighs: [Segment, Segment];
  readonly shins: [Segment, Segment];
  readonly upperArms: [Segment, Segment];
  readonly forearms: [Segment, Segment];
  /** Every capsule part, for building physics bodies. */
  readonly segments: Segment[];
  /** Where each ski goes (its origin and orientation, in the pose frame), from the last pose(). */
  readonly skiPoses = [0, 1].map(() => ({ p: new THREE.Vector3(), q: new THREE.Quaternion() }));
  /**
   * Riding a snowboard: the body stands sideways on it (the group turned a
   * quarter turn: regular, left foot forward, facing the toe edge), feet
   * wider apart, both strapped to the one board (its two halves: skiPoses).
   */
  board = false;
  setBoard(on: boolean): void {
    this.board = on;
    this.group.rotation.y = on ? -Math.PI / 2 : 0;
    this.pose(RIDING);
  }
  /** Where the grabbing hand holds its ski / the board, in that ski's (or board half's) own frame. */
  grabHoldLocal(out: THREE.Vector3): THREE.Vector3 {
    return this.board
      ? out.set(0.12, 0.02, -BOARD_STANCE + 0.05) // the board's toe edge, between the bindings
      : out.set(0, GRAB.hold.up, GRAB.hold.along);
  }

  /** Each ski's orientation relative to its shin, standing (the boot holds it so). */
  private readonly bootRest = [new THREE.Quaternion(), new THREE.Quaternion()];

  // Joint positions from the last pose(), in the local frame
  readonly joints = {
    hipCentre: new THREE.Vector3(),
    shoulderCentre: new THREE.Vector3(),
    /** Hip centre, pelvis/abdomen, abdomen/chest, shoulder centre. */
    spine: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()],
    headCentre: new THREE.Vector3(),
    hips: [new THREE.Vector3(), new THREE.Vector3()],
    knees: [new THREE.Vector3(), new THREE.Vector3()],
    ankles: [new THREE.Vector3(), new THREE.Vector3()],
    shoulders: [new THREE.Vector3(), new THREE.Vector3()],
    elbows: [new THREE.Vector3(), new THREE.Vector3()],
    hands: [new THREE.Vector3(), new THREE.Vector3()],
  };

  /** The body's own colours, under the cloth clothes (see dress). */
  private readonly materials: Record<'shirt' | 'pants' | 'shins' | 'upperArms' | 'forearms', THREE.MeshStandardMaterial>;

  /**
   * Colour the body under the clothes: the same colour as what covers it,
   * so any gap in the fabric shows clothes, not body; bare skin elsewhere.
   * (The ragdoll's visible parts share these materials.)
   */
  dress(bottom: { kind: string; color: number }, top: { kind: string; color: number }): void {
    const m = this.materials;
    m.pants.color.setHex(bottom.color);
    m.shins.color.setHex(bottom.kind === 'pants' ? bottom.color : SKIN_COLOR);
    m.shirt.color.setHex(top.color);
    m.upperArms.color.setHex(top.kind === 'jacket' ? top.color : SKIN_COLOR);
    m.forearms.color.setHex(top.kind === 'jacket' ? top.color : SKIN_COLOR);
  }

  constructor() {
    const shirt = new THREE.MeshStandardMaterial({ color: SHIRT_COLOR, roughness: 0.9 });
    // Same green as the cloth snowpants worn over them, so any gap in the
    // fabric shows pants, not body
    const pants = new THREE.MeshStandardMaterial({ color: PANTS_COLOR, roughness: 0.85 });
    const skin = new THREE.MeshStandardMaterial({ color: SKIN_COLOR, roughness: 0.6 });

    this.pelvis = new Segment(BODY.pelvis, BODY.pelvisRadius, MASS.pelvis, pants);
    this.abdomen = new Segment(BODY.abdomen, BODY.abdomenRadius, MASS.abdomen, shirt);
    this.chest = new Segment(BODY.chest, BODY.chestRadius, MASS.chest, shirt);
    this.spine = [this.pelvis, this.abdomen, this.chest];
    const pair = (len: number, r: number, m: number, mat: THREE.Material): [Segment, Segment] => [
      new Segment(len, r, m, mat),
      new Segment(len, r, m, mat),
    ];
    // Shins and arms: bare skin, or the colour of the clothes over them
    // (see dress), each with its own material to recolour
    const shins = skin.clone();
    const upperArms = skin.clone();
    const forearms = skin.clone();
    this.materials = { shirt, pants, shins, upperArms, forearms };
    this.thighs = pair(BODY.thigh, BODY.thighRadius, MASS.thigh, pants);
    this.shins = pair(BODY.shin, BODY.shinRadius, MASS.shin, shins);
    this.upperArms = pair(BODY.upperArm, BODY.upperArmRadius, MASS.upperArm, upperArms);
    this.forearms = pair(BODY.forearm, BODY.forearmRadius, MASS.forearm, forearms);
    this.segments = [...this.spine, ...this.thighs, ...this.shins, ...this.upperArms, ...this.forearms];

    this.head = new THREE.Mesh(new THREE.SphereGeometry(BODY.headRadius, 20, 14), skin);
    this.head.castShadow = true;
    // Black skate helmet and white goggles with an orange lens (which also
    // show which way they're facing)
    this.head.add(createHeadgear(BODY.headRadius));

    // Ski boot cuffs on the lower shins (the shells are on the skis)
    for (let i = 0; i < 2; i++) this.shins[i].mesh.add(createBootCuff(BODY.shin / 2, i === 0 ? -1 : 1));

    for (const s of this.segments) this.group.add(s.mesh);
    this.group.add(this.head);
    this.pose(RIDING);
    // (skis flat, standing)
    for (let i = 0; i < 2; i++) this.bootRest[i].copy(this.shins[i].mesh.quaternion).invert();
  }

  /**
   * Where the mass is right now: centre of mass and pitch inertia of the
   * posed body, plus the skis (given as their centres and length direction,
   * in the same local frame), each of skiMass kg.
   */
  massProperties(skis: { p: THREE.Vector3; d: THREE.Vector3 }[], skiMass: number, skiLength: number, out: MassProperties): MassProperties {
    // (In the frame the person stands in: on a board the body is turned,
    // and floats up on the powder)
    const g = this.group.quaternion;
    const lift = this.group.position;
    const rods: Rod[] = this.segments.map((s) => ({
      m: s.mass,
      L: s.length,
      r: s.radius,
      p: s.mesh.position.clone().applyQuaternion(g).add(lift),
      d: tmpRodDir.set(0, 1, 0).applyQuaternion(s.mesh.quaternion).applyQuaternion(g).clone(),
    }));
    rods.push({ m: MASS.head, L: 0, r: BODY.headRadius * 0.9, p: this.head.position.clone().applyQuaternion(g).add(lift), d: UP });
    for (const ski of skis) rods.push({ m: skiMass, L: skiLength, r: 0.03, p: ski.p, d: ski.d });

    out.mass = 0;
    out.com.set(0, 0, 0);
    for (const rod of rods) {
      out.mass += rod.m;
      out.com.addScaledVector(rod.p, rod.m);
    }
    out.com.divideScalar(out.mass);
    out.pitchInertia = pitchInertia(rods, out.com);
    out.yawInertia = yawInertia(rods, out.com);
    out.rollInertia = rollInertia(rods, out.com);
    return out;
  }

  /**
   * Place every part for the given pose, plus the springy secondary motion
   * if given. Feet stay planted on the skis; the hips and everything above
   * them can turn separately (sec.yaw) and the legs bend to connect.
   */
  pose(p: Pose, sec?: SecondaryMotion): void {
    const j = this.joints;
    // Secondary motion (springy layer): legs compress, torso lags, upper body
    // turns separately from the skis, head nods, hands trail
    const hipHeight = p.hipHeight + (sec ? sec.compress.value : 0);
    const torsoPitch = p.torsoPitch + (sec ? sec.pitch.value : 0);
    const torsoRoll = p.lean + (sec ? sec.roll.value : 0);
    const upperYaw = sec ? sec.yaw.value : 0;
    const nod = sec ? sec.nod.value : 0;
    const yawQ = tmpYawQ.setFromAxisAngle(UP, upperYaw);

    // Side-to-side axis of the hips and shoulders: tilted by the lean,
    // turned with the upper body
    const side = tmpSide.set(Math.cos(p.lean), Math.sin(p.lean), 0).applyQuaternion(yawQ);

    // Leaning into a turn tilts the whole body over the feet
    j.hipCentre.set(
      -Math.sin(p.lean) * (hipHeight - BODY.ankleHeight),
      BODY.ankleHeight + Math.cos(p.lean) * (hipHeight - BODY.ankleHeight),
      p.hipBack,
    );
    // Spine: each part pitched forward, more towards the top so the back
    // rounds as the skier leans, tilted sideways, then turned with the upper
    // body (which may face a different way from the skis)
    const spine = tmpSpine;
    j.spine[0].copy(j.hipCentre);
    for (let k = 0; k < 3; k++) {
      const pitch = torsoPitch * SPINE_CURVE[k];
      spine
        .set(0, Math.cos(pitch), -Math.sin(pitch))
        .applyAxisAngle(tmpZ.set(0, 0, 1), torsoRoll)
        .applyQuaternion(yawQ);
      j.spine[k + 1].copy(j.spine[k]).addScaledVector(spine, this.spine[k].length);
      this.spine[k].place(j.spine[k], j.spine[k + 1]);
    }
    j.shoulderCentre.copy(j.spine[3]);
    // Head continues along the chest's direction
    j.headCentre.copy(j.shoulderCentre).addScaledVector(spine, BODY.neck + BODY.headRadius);
    this.head.position.copy(j.headCentre);
    // Head: up along the chest and facing where the upper body faces, then
    // turned with the shoulders plus any look over a shoulder, then nodded
    const unturned = tmpUnturned.copy(spine).applyQuaternion(tmpYawInv.copy(yawQ).invert());
    this.head.quaternion
      .setFromUnitVectors(UP, unturned)
      .premultiply(yawQ)
      .premultiply(tmpHeadTurn.setFromAxisAngle(spine, p.twist + p.look * HEAD_TURN))
      .multiply(tmpHeadTurn.setFromAxisAngle(tmpX.set(1, 0, 0), -nod));

    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? -1 : 1; // left, right

      // Legs: from the (possibly turned) hips down to the ankles on the
      // boots, which stay with the skis. Knees point between the two.
      j.hips[i].copy(j.hipCentre).addScaledVector(side, s * BODY.hipWidth);
      j.ankles[i].set(s * (this.board ? BOARD_STANCE : BODY.stance), BODY.ankleHeight, 0);
      // The grab: on skis, feet and skis move to the X; on a board both feet
      // come up together (blended in by p.grab)
      const g = p.grab;
      // (A shifty turns both legs and skis together, from the hips)
      const skiYaw = this.board ? 0 : GRAB.yaw[i] * g + p.shifty * SHIFTY.skis;
      if (g > 0) {
        if (this.board) j.ankles[i].y += BOARD_GRAB_LIFT * g;
        else j.ankles[i].lerp(i === 1 ? GRAB.rightAnkle : GRAB.leftAnkle, g);
      }
      // Knees point the way their ski goes; the whole leg turns with it
      // (the knee is a hinge and the boot can't twist: the hip does it)
      const kneeDir = tmpPole.set(0, 0, -1).applyAxisAngle(UP, upperYaw * 0.5 + skiYaw);
      solveLimb(j.hips[i], j.ankles[i], BODY.thigh, BODY.shin, kneeDir, j.knees[i]);
      const knee = limbHinge(j.hips[i], j.ankles[i], kneeDir, 1, tmpHinge);
      this.thighs[i].place(j.hips[i], j.knees[i], knee);
      this.shins[i].place(j.knees[i], j.ankles[i], knee);
      // The ski: flat on the snow normally (the ankle flexes over it); when
      // grabbing, carried by the shin at the standing ankle angle
      const ski = this.skiPoses[i];
      ski.q.identity();
      if (this.board) {
        // The board runs along the line between the feet (the body's x),
        // nose (half 0) under the left foot
        ski.q.setFromAxisAngle(UP, Math.PI / 2);
      } else if (g > 0) ski.q.slerp(tmpPitchQ.copy(this.shins[i].mesh.quaternion).multiply(this.bootRest[i]), g);
      // Shifty: the skis turned with the legs, tips pointing down a little
      if (!this.board && p.shifty !== 0) {
        tmpPitchQ.setFromAxisAngle(UP, p.shifty * SHIFTY.skis).multiply(tmpFlexQ.setFromAxisAngle(tmpX.set(1, 0, 0), -Math.abs(p.shifty) * SHIFTY.tipDown));
        ski.q.premultiply(tmpPitchQ);
      }
      ski.p.copy(j.ankles[i]).sub(tmpSkiUp.set(0, ANKLE_ABOVE_SKI, 0).applyQuaternion(ski.q));

      // Arms: hands forward and low as if holding poles, or out for balance.
      // Twisting the upper body turns shoulders and arms about the spine.
      const shoulderSide = tmpShoulderSide.copy(side).applyAxisAngle(spine, p.twist);
      j.shoulders[i].copy(j.shoulderCentre).addScaledVector(shoulderSide, s * BODY.shoulderWidth);
      const hand = j.hands[i]
        .set(s * 0.1, -0.35, -0.3)
        .lerp(
          p.armsOut >= 0 ? tmpOut.set(s * 0.5, -0.05, -0.1) : tmpOut.set(-s * 0.08, -0.22, -0.16),
          Math.abs(p.armsOut),
        )
        .applyAxisAngle(UP, p.twist + upperYaw)
        .add(j.shoulders[i]);
      if (p.armsUp > 0) {
        // Reaching up over the head: out along the spine, a little apart
        const overhead = tmpOut
          .copy(j.shoulders[i])
          .addScaledVector(spine, 0.55)
          .addScaledVector(shoulderSide, s * 0.08);
        hand.lerp(overhead, p.armsUp);
      }
      if (sec) hand.add(sec.hand(i, tmpHandOff)); // trailing hands
      if (i === 1 && p.grab > 0) {
        // Grabbing: the right hand goes to the right ski's tail (on a board:
        // the toe edge)
        const hold = this.grabHoldLocal(tmpHold)
          .applyQuaternion(this.skiPoses[1].q)
          .add(this.skiPoses[1].p);
        hand.lerp(hold, p.grab);
      }
      const elbowDir = tmpPole.set(s * 0.6, 0, 1).applyQuaternion(yawQ);
      solveLimb(j.shoulders[i], hand, BODY.upperArm, BODY.forearm, elbowDir, j.elbows[i]);
      // (Elbows are hinges too: the arm twists as a whole)
      const elbow = limbHinge(j.shoulders[i], hand, elbowDir, -1, tmpHinge);
      this.upperArms[i].place(j.shoulders[i], j.elbows[i], elbow);
      this.forearms[i].place(j.elbows[i], hand, elbow);
    }
  }

}

// How much of the torso's forward lean each spine part takes: pelvis, abdomen, chest
const SPINE_CURVE = [0.6, 1.0, 1.25];
const tmpSide = new THREE.Vector3();
const tmpRodDir = new THREE.Vector3();
const tmpYawQ = new THREE.Quaternion();
const tmpYawInv = new THREE.Quaternion();
const tmpUnturned = new THREE.Vector3();
const tmpX = new THREE.Vector3();
const tmpHandOff = new THREE.Vector3();
const tmpShoulderSide = new THREE.Vector3();
const tmpHeadTurn = new THREE.Quaternion();
// How far the neck turns the head when looking over a shoulder (plus the shoulder twist)
const HEAD_TURN = 1.6;
const tmpSpine = new THREE.Vector3();
const tmpZ = new THREE.Vector3();
const tmpPole = new THREE.Vector3();
const tmpOut = new THREE.Vector3();
