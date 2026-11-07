import * as THREE from 'three';
import type { SecondaryMotion } from './secondary';

/**
 * Placeholder human: a three-part spine (pelvis, abdomen, chest), a sphere
 * head, and four two-segment limbs (thigh + shin, upper arm + forearm).
 * Every part is a simple shape between two joints, so the same list becomes
 * the ragdoll's bodies, with joints at the spine, neck, hips, knees,
 * shoulders and elbows.
 *
 * Local frame: feet on the skis at y ≈ 0, facing -Z, +X to the right.
 */

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
  twist: number; // upper body turned about the spine, radians (+ = to the left)
  look: number; // head turned over a shoulder: +1 = fully over the left, -1 = over the right
}

// hipBack values are solved so the centre of mass (body + skis) sits right
// over the feet, except the two leans: 8 cm behind / ahead of the feet.
export const RIDING: Pose = { hipHeight: 0.86, hipBack: 0.14, torsoPitch: 0.35, lean: 0, armsOut: 0, twist: 0, look: 0 };
export const TUCK: Pose = { hipHeight: 0.62, hipBack: 0.27, torsoPitch: 1.0, lean: 0, armsOut: 0, twist: 0, look: 0 };
export const CROUCH: Pose = { hipHeight: 0.6, hipBack: 0.23, torsoPitch: 0.7, lean: 0, armsOut: 0, twist: 0, look: 0 };
export const AIR: Pose = { hipHeight: 0.78, hipBack: 0.12, torsoPitch: 0.3, lean: 0, armsOut: 1, twist: 0, look: 0 };
// Loading a jump with weight shifted: back (for a backflip) or forward
export const LEAN_BACK: Pose = { hipHeight: 0.62, hipBack: 0.23, torsoPitch: 0.25, lean: 0, armsOut: 0, twist: 0, look: 0 };
export const LEAN_FORWARD: Pose = { hipHeight: 0.62, hipBack: 0.18, torsoPitch: 1.05, lean: 0, armsOut: 0, twist: 0, look: 0 };
// In the air: pulled into a tight ball (rotates fast) or stretched out (slow)
export const AIR_TUCK: Pose = { hipHeight: 0.42, hipBack: 0.27, torsoPitch: 1.0, lean: 0, armsOut: 0, twist: 0, look: 0 };
// In the air, upright with arms hugged in: the fastest shape for spinning
export const AIR_SPIN: Pose = { hipHeight: 0.86, hipBack: 0.07, torsoPitch: 0.1, lean: 0, armsOut: -1, twist: 0, look: 0 };
export const AIR_OPEN: Pose = { hipHeight: 0.98, hipBack: 0.01, torsoPitch: -0.05, lean: 0, armsOut: 1, twist: 0, look: 0 };

export function lerpPose(a: Pose, b: Pose, t: number, out: Pose): Pose {
  out.hipHeight = a.hipHeight + (b.hipHeight - a.hipHeight) * t;
  out.hipBack = a.hipBack + (b.hipBack - a.hipBack) * t;
  out.torsoPitch = a.torsoPitch + (b.torsoPitch - a.torsoPitch) * t;
  out.lean = a.lean + (b.lean - a.lean) * t;
  out.armsOut = a.armsOut + (b.armsOut - a.armsOut) * t;
  out.twist = a.twist + (b.twist - a.twist) * t;
  out.look = a.look + (b.look - a.look) * t;
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
  place(a: THREE.Vector3, b: THREE.Vector3): void {
    const dir = tmpDir.subVectors(b, a);
    const len = dir.length();
    this.mesh.position.copy(a).addScaledVector(dir, 0.5 * (this.length / len));
    this.mesh.quaternion.setFromUnitVectors(UP, dir.divideScalar(len));
  }
}

const UP = new THREE.Vector3(0, 1, 0);
const tmpDir = new THREE.Vector3();

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

  constructor() {
    const jacket = new THREE.MeshStandardMaterial({ color: 0xe0672f, roughness: 0.6 });
    const pants = new THREE.MeshStandardMaterial({ color: 0x2d3a4a, roughness: 0.7 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xf0c8a0, roughness: 0.6 });

    this.pelvis = new Segment(BODY.pelvis, BODY.pelvisRadius, MASS.pelvis, pants);
    this.abdomen = new Segment(BODY.abdomen, BODY.abdomenRadius, MASS.abdomen, jacket);
    this.chest = new Segment(BODY.chest, BODY.chestRadius, MASS.chest, jacket);
    this.spine = [this.pelvis, this.abdomen, this.chest];
    const pair = (len: number, r: number, m: number, mat: THREE.Material): [Segment, Segment] => [
      new Segment(len, r, m, mat),
      new Segment(len, r, m, mat),
    ];
    this.thighs = pair(BODY.thigh, BODY.thighRadius, MASS.thigh, pants);
    this.shins = pair(BODY.shin, BODY.shinRadius, MASS.shin, pants);
    this.upperArms = pair(BODY.upperArm, BODY.upperArmRadius, MASS.upperArm, jacket);
    this.forearms = pair(BODY.forearm, BODY.forearmRadius, MASS.forearm, jacket);
    this.segments = [...this.spine, ...this.thighs, ...this.shins, ...this.upperArms, ...this.forearms];

    this.head = new THREE.Mesh(new THREE.SphereGeometry(BODY.headRadius, 20, 14), skin);
    this.head.castShadow = true;
    // Goggles, so you can tell which way they're facing
    const goggles = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.06, 0.06),
      new THREE.MeshStandardMaterial({ color: 0x1b2a3a, roughness: 0.2, metalness: 0.5 }),
    );
    goggles.position.set(0, 0.02, -BODY.headRadius + 0.02);
    this.head.add(goggles);

    for (const s of this.segments) this.group.add(s.mesh);
    this.group.add(this.head);
    this.pose(RIDING);
  }

  /**
   * Where the mass is right now: centre of mass and pitch inertia of the
   * posed body, plus the skis (given as their centres and length direction,
   * in the same local frame), each of skiMass kg.
   */
  massProperties(skis: { p: THREE.Vector3; d: THREE.Vector3 }[], skiMass: number, skiLength: number, out: MassProperties): MassProperties {
    const rods: Rod[] = this.segments.map((s) => ({
      m: s.mass,
      L: s.length,
      r: s.radius,
      p: s.mesh.position,
      d: tmpRodDir.set(0, 1, 0).applyQuaternion(s.mesh.quaternion).clone(),
    }));
    rods.push({ m: MASS.head, L: 0, r: BODY.headRadius * 0.9, p: this.head.position, d: UP });
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
      j.ankles[i].set(s * BODY.stance, BODY.ankleHeight, 0);
      const kneeDir = tmpPole.set(0, 0, -1).applyAxisAngle(UP, upperYaw * 0.5);
      solveLimb(j.hips[i], j.ankles[i], BODY.thigh, BODY.shin, kneeDir, j.knees[i]);
      this.thighs[i].place(j.hips[i], j.knees[i]);
      this.shins[i].place(j.knees[i], j.ankles[i]);

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
      if (sec) hand.add(sec.hand(i, tmpHandOff)); // trailing hands
      solveLimb(j.shoulders[i], hand, BODY.upperArm, BODY.forearm, tmpPole.set(s * 0.6, 0, 1).applyQuaternion(yawQ), j.elbows[i]);
      this.upperArms[i].place(j.shoulders[i], j.elbows[i]);
      this.forearms[i].place(j.elbows[i], hand);
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
