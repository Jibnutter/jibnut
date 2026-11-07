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
import { RAPIER, type Physics } from './physics';
import { BODY, MASS, type Person, type Segment } from './person';
import { BOARD_LENGTH, BOARD_STANCE } from './boardModel';

/**
 * The always-on ragdoll: the rider you see is this, all the time.
 *
 * One rigid body per body part and per ski, linked by joints:
 *
 *   spine (x2), neck,      ball joints with angle limits
 *   shoulders, hips
 *   elbows, knees          hinges that only bend the natural way
 *   ankles                 stiff, springy ball joints (boot flex) on the skis
 *
 * While riding ("driven"), each ski is pulled towards where the ski
 * controller wants it by a stiff spring on all six axes (to an invisible
 * anchor the controller moves), so skis lag, splay and chatter a little but
 * go where you steer. The body stands on them: every joint has a
 * muscle (a springy position motor) pulling it towards the pose the
 * controller wants. The muscles push between body parts, not from outside,
 * so gravity, landings, turns and hits make the body sag, lag, wobble and
 * bounce for real.
 *
 * In a crash it goes "limp": the skis are let go, the muscles relax, and a
 * violent jolt can pop a binding.
 *
 * All bodies are created with the same orientation (the skier's), and each
 * part's own orientation lives in its collider. That way a joint's axes mean
 * the same thing in both bodies it joins, and a joint's angle is measured
 * from the pose the ragdoll was built in.
 */

const BODY_FRICTION = 0.9; // a body sliding on snow grips far more than skis
const SKI_FRICTION = 0.15; // skis sliding loose in a crash
/**
 * While riding the controller does the sliding: the sprung skis touch the
 * snow with no friction. (With friction, an inside ski tipped on edge across
 * a steep slope dug in and was dragged back to its spring's limit, twisting
 * the body over into the snow.)
 */
const RIDING_SKI_FRICTION = 0;
const SKI_MASS = 2;
// Ragdoll parts collide with the world but not each other. Groups are
// (membership << 16) | filter: we're in group 2 and only collide with group 1.
const RAGDOLL_GROUPS = (0x0002 << 16) | 0x0001;
// Free skis in physical skiing collide with nothing: Rapier's contacts
// against the snow mesh's triangle edges (sideways "ghost" normals) launched
// them at speed. Physical skiing supports them from the exact snow height
// instead. (Sprung skis keep normal contacts: their springs keep them in
// check, and without contacts they sank under the rider.) In a crash they
// collide normally again.
const FREE_SKI_GROUPS = (0x0002 << 16) | 0x0000;

const LIMB_DAMPING = 0.3; // body angular damping: air and soft-tissue losses

/**
 * Muscles: springy position motors at every joint. Each is a spring
 * frequency (how fast it snaps back, rad/s), a damping ratio (below 1
 * overshoots and bounces: deliberately low, exaggerated springiness) and the
 * load it moves: roughly the mass the joint holds up times its distance
 * squared (kg m²). Stiffness = load × omega², damping = 2 × zeta × omega ×
 * load, in real torque units (force-based motors).
 *
 * Why not acceleration-based motors (Rapier's default)? They scale with the
 * two bodies the joint links, not the load: a spine joint between two light
 * trunk segments couldn't hold up the chest, head and arms, and folded.
 *
 * Sag under gravity ≈ (load's weight × lever) / stiffness: tuned to a few
 * hundredths of a radian for the legs, ~0.1 for spine and neck, and looser
 * for the arms, which are meant to swing.
 */
interface Muscle {
  omega: number;
  zeta: number;
  load: number;
}
// Per ankle, knee and hip: half the body above it
const ANKLE: Muscle = { omega: 24, zeta: 0.35, load: 25 }; // ~40 kg at 0.8 m; stiff boots: softer let the body pitch over them
const KNEE: Muscle = { omega: 14, zeta: 0.3, load: 11 }; // ~36 kg at 0.55 m
const HIP: Muscle = { omega: 15, zeta: 0.3, load: 3.3 }; // ~27 kg at 0.35 m
const LOWER_SPINE: Muscle = { omega: 18, zeta: 0.3, load: 3.6 }; // abdomen up: ~40 kg at 0.3 m
const UPPER_SPINE: Muscle = { omega: 20, zeta: 0.3, load: 1.2 }; // chest up: ~30 kg at 0.2 m
const NECK: Muscle = { omega: 32, zeta: 0.3, load: 0.14 }; // head: 5 kg at 0.15 m; stiff to hold it under g-loads
const SHOULDER: Muscle = { omega: 13, zeta: 0.25, load: 0.4 }; // arm: 4.5 kg at 0.3 m
const ELBOW: Muscle = { omega: 16, zeta: 0.25, load: 0.04 }; // forearm: 2 kg at 0.14 m
/** Limp (crashed): no pull towards a pose, just a little damping. */
const LIMP_DAMPING = 3; // per unit of load (so ~0.1 damping ratio at 15 rad/s)

/**
 * Ski springs: each ski is held to its anchor by springs on all six axes
 * (force-based motors on a free joint, which the solver keeps stable). In a
 * test, 30000 N/m sagged 1.4 cm under a 40 kg load and a 2 rad/s turn
 * lagged 1°. A bit softer here so the skis visibly work.
 */
const SKI_LINEAR = { k: 20000, d: 700 }; // N/m, N·s/m
const SKI_ANGULAR = { k: 2000, d: 90 }; // N·m/rad, N·m·s/rad
const SKI_SLACK = 0.25; // m: the most a ski can stray from its anchor
/**
 * In the air the skis' position springs relax to this fraction: the core
 * holds the body. Their angle springs stay at full strength, so the skis
 * stay parallel (relaxed too, the loose hips and ankles let them scissor
 * into an X in the arch, up to 69° apart).
 */
const SKI_AIR_FRACTION = 0.1;
/** ...and their angle springs stiffen this much, to beat the flip's swing. */
const SKI_AIR_ANGLE_BOOST = 3;

/**
 * Core spring (in the air): the abdomen, near the centre of mass, held to
 * where the controller wants it on all six axes. In a flip the controller
 * turns the body about its centre of mass; holding the ragdoll there (not by
 * its skis) makes it turn about the same point, with legs and skis swinging
 * round the core, rather than the springy body swinging round its skis.
 * Gains: the whole ~86 kg at ~20 rad/s, inertia ~10 kg m².
 */
const CORE_LINEAR = { k: 34000, d: 1700 }; // N/m, N·s/m
const CORE_ANGULAR = { k: 4000, d: 200 }; // N·m/rad, N·m·s/rad
const SKI_TWIST_SLACK = 0.6; // rad
/**
 * Grab spring: holding a grab, the right hand is pulled onto the right ski's
 * tail (the arm's muscles alone are soft enough that it floated ~20 cm off
 * through a flip). Position only: the hand can still turn on it.
 */
const GRAB_SPRING = { k: 1500, d: 50 }; // N/m, N·s/m

// Ball joint limits, radians either way from the pose the ragdoll was built
// in (standing, riding), about the skier's own axes: x = bend forward/back,
// y = twist, z = bend sideways. Generous enough for every riding pose.
type Limits = { x: number; y: number; z: number };
const SPINE_LIMITS: Limits = { x: 0.6, y: 0.5, z: 0.4 }; // per spine joint
const NECK_LIMITS: Limits = { x: 0.8, y: 2.3, z: 0.6 }; // turns far for looking back
const SHOULDER_LIMITS: Limits = { x: 2.4, y: 1.4, z: 1.8 };
const HIP_LIMITS: Limits = { x: 1.9, y: 0.9, z: 0.8 };
const KNEE_MAX = 2.6; // radians of bend from straight
// Ankles: boots let the shin flex forward and back a fair bit, barely any
// twist or sideways give. Stiff: everything above stands on them.
const ANKLE_LIMITS: Limits = { x: 0.25, y: 0.08, z: 0.3 };
const ELBOW_MAX = 2.6;
const STRAIGHT = 0.02; // knees and elbows stop just short of straight
// A binding pops when its ski is jolted harder than this (crashes only).
// Peak jolts seen in test crashes: ~100 km/h crashes 60-135 g, a slow 180
// 54-84 g, a gentle slow backflip 44 g.
const SKI_RELEASE_G = 60;

interface Part {
  body: RAPIER.RigidBody;
  target: THREE.Object3D; // the (hidden) posed mesh or ski the controller moves
  visual: THREE.Object3D; // what you see: a copy, placed from the body
  colliderRot: THREE.Quaternion; // part orientation relative to its body
  colliderInv: THREE.Quaternion;
}

interface Joint {
  joint: RAPIER.ImpulseJoint;
  parent: Part;
  child: Part;
  muscle: Muscle;
  hingeAxis: THREE.Vector3 | null; // body frame; null = ball joint
}

export class Ragdoll {
  /** The visible rider, in world space. Add this to the scene (via the skier). */
  readonly view = new THREE.Group();
  limp = false;
  private readonly physics: Physics;
  private readonly parts: Part[] = [];
  private readonly joints: Joint[] = [];
  private readonly skis: Part[] = [];
  /** Invisible kinematic bodies the controller moves; the skis spring to them. */
  private readonly anchors: RAPIER.RigidBody[] = [];
  private readonly skiSprings: RAPIER.ImpulseJoint[] = [];
  // The core spring and its anchor, used in the air (see CORE_LINEAR)
  private readonly coreAnchor: RAPIER.RigidBody;
  private coreSpring: RAPIER.ImpulseJoint | null = null;
  private readonly corePart: Part;
  private readonly coreFrom = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
  private readonly coreTo = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
  /**
   * 0 = on the snow (held by the skis), 1 = in the air (held at the core).
   * Set by the skier each frame, eased so the handover is smooth.
   */
  airBlend = 0;
  /** How hard the right hand holds the right ski's tail (0..1; the grab). Set by the skier. */
  grab = 0;
  private grabSpring: RAPIER.ImpulseJoint | null = null;
  private readonly person: Person;
  /** On a snowboard: the two "skis" are the board's halves, joined rigidly, never let go. */
  private readonly board: boolean;
  private readonly grabHand: Part;
  private readonly skiJoints: (RAPIER.ImpulseJoint | null)[] = [null, null];
  private readonly lastSkiVel = [new THREE.Vector3(), new THREE.Vector3()];
  // Ski targets: last frame's and this frame's, interpolated across substeps
  private readonly skiFrom = [0, 1].map(() => ({ p: new THREE.Vector3(), q: new THREE.Quaternion() }));
  private readonly skiTo = [0, 1].map(() => ({ p: new THREE.Vector3(), q: new THREE.Quaternion() }));
  readonly torso: RAPIER.RigidBody;
  readonly pelvis: RAPIER.RigidBody;
  readonly chest: RAPIER.RigidBody;
  readonly head: RAPIER.RigidBody;
  /** The visible head (hidden in first person, where the camera sits in it). */
  readonly headVisual: THREE.Object3D;
  /** How many skis have come off. */
  skisLost = 0;

  /**
   * Builds the ragdoll in the person's current pose, driven (riding).
   * @param frame     frame the person and skis are posed in (the stance)
   * @param skiGroups the two ski models
   * @param velocity  starting velocity of every part
   */
  constructor(physics: Physics, person: Person, frame: THREE.Object3D, skiGroups: THREE.Object3D[], velocity: THREE.Vector3) {
    this.physics = physics;
    this.person = person;
    this.board = person.board;
    const world = physics.world;
    frame.updateMatrixWorld(true);
    const rootRot = frame.getWorldQuaternion(new THREE.Quaternion());
    const rootInv = rootRot.clone().invert();
    const toWorld = (local: THREE.Vector3) => frame.localToWorld(local.clone());

    /** A body at the part's world position, with the shared orientation. */
    const makeBody = (target: THREE.Object3D, desc: RAPIER.RigidBodyDesc, damping: number): Part => {
      const pos = target.getWorldPosition(new THREE.Vector3());
      const rot = target.getWorldQuaternion(new THREE.Quaternion());
      const body = world.createRigidBody(
        desc
          .setTranslation(pos.x, pos.y, pos.z)
          .setRotation(rootRot)
          .setLinvel(velocity.x, velocity.y, velocity.z)
          .setLinearDamping(0.05)
          .setAngularDamping(damping)
          .setCcdEnabled(true), // small and fast: don't tunnel through the snow
      );
      const colliderRot = rootInv.clone().multiply(rot);
      // What you see: a copy of the posed model, placed from the body
      const visual = target.clone(true);
      visual.visible = true;
      this.view.add(visual);
      const part = { body, target, visual, colliderRot, colliderInv: colliderRot.clone().invert() };
      this.parts.push(part);
      return part;
    };

    /** extraRot/offset: the shape's own turn and shift within the part's frame */
    const addCollider = (
      part: Part,
      desc: RAPIER.ColliderDesc,
      mass: number,
      volume: number,
      friction: number,
      extraRot?: THREE.Quaternion,
      offset?: THREE.Vector3,
      groups = RAGDOLL_GROUPS,
    ) => {
      if (offset) {
        const o = offset.clone().applyQuaternion(part.colliderRot);
        desc.setTranslation(o.x, o.y, o.z);
      }
      world.createCollider(
        desc
          .setRotation(extraRot ? part.colliderRot.clone().multiply(extraRot) : part.colliderRot)
          .setDensity(mass / volume)
          .setFriction(friction)
          .setRestitution(0.1)
          .setCollisionGroups(groups),
        part.body,
      );
    };

    const capsulePart = (seg: Segment): Part => {
      const part = makeBody(seg.mesh, RAPIER.RigidBodyDesc.dynamic(), LIMB_DAMPING);
      const r = seg.radius;
      const volume = Math.PI * r * r * seg.length + (4 / 3) * Math.PI * r ** 3;
      addCollider(part, RAPIER.ColliderDesc.capsule(seg.length / 2, r), seg.mass, volume, BODY_FRICTION);
      return part;
    };

    // --- Bodies
    const [pelvis, abdomen, chest] = person.spine.map(capsulePart);
    this.torso = abdomen.body; // the middle of the trunk: what the camera follows
    this.pelvis = pelvis.body;
    this.chest = chest.body;

    const head = makeBody(person.head, RAPIER.RigidBodyDesc.dynamic(), LIMB_DAMPING);
    const hr = BODY.headRadius;
    addCollider(head, RAPIER.ColliderDesc.ball(hr), MASS.head, (4 / 3) * Math.PI * hr ** 3, BODY_FRICTION);
    this.head = head.body;
    this.headVisual = head.visual;

    const thighs = person.thighs.map(capsulePart);
    const shins = person.shins.map(capsulePart);
    const upperArms = person.upperArms.map(capsulePart);
    const forearms = person.forearms.map(capsulePart);

    // Skis: real bodies, sprung to anchors the controller moves while
    // riding; let go in a crash
    const raw = world.impulseJoints.raw;
    skiGroups.forEach((g, i) => {
      const part = makeBody(g, RAPIER.RigidBodyDesc.dynamic(), 0.3);
      // A flat box: its flat base stops the ski rolling over under the rider
      // (a round capsule let riders tip sideways after hard landings)
      if (this.board) {
        // Half the board, from its foot to the nose (half 0) or tail (half 1)
        const halfLen = BOARD_LENGTH / 4;
        const offset = new THREE.Vector3(0, 0, (i === 0 ? -1 : 1) * (halfLen - BOARD_STANCE));
        addCollider(part, RAPIER.ColliderDesc.cuboid(0.13, 0.015, halfLen), SKI_MASS, 0.26 * 0.03 * halfLen * 2, RIDING_SKI_FRICTION, undefined, offset);
      } else {
        addCollider(part, RAPIER.ColliderDesc.cuboid(0.05, 0.015, 0.8), SKI_MASS, 0.1 * 0.03 * 1.6, RIDING_SKI_FRICTION);
      }
      // (The lower of the two surfaces' friction applies: Rapier's default
      // averages it with the snow's, which still dragged)
      for (let c = 0; c < part.body.numColliders(); c++) part.body.collider(c).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min);
      this.skis.push(part);
      this.readSkiTarget(i, this.skiTo[i]);
      this.skiFrom[i].p.copy(this.skiTo[i].p);
      this.skiFrom[i].q.copy(this.skiTo[i].q);

      const { p, q } = this.skiTo[i];
      const anchor = world.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, p.y, p.z).setRotation(q),
      );
      this.anchors.push(anchor);
      // A free joint (no axes locked) with a spring on every axis
      const spring = world.createImpulseJoint(
        RAPIER.JointData.generic(ORIGIN, ORIGIN, X_AXIS, 0 as RAPIER.JointAxesMask),
        anchor,
        part.body,
        true,
      );
      for (let ax = 0; ax < 6; ax++) {
        const { k, d } = ax < 3 ? SKI_LINEAR : SKI_ANGULAR;
        const slack = ax < 3 ? SKI_SLACK : SKI_TWIST_SLACK;
        raw.jointConfigureMotorModel(spring.handle, ax, RAPIER.MotorModel.ForceBased as number as never);
        raw.jointConfigureMotorPosition(spring.handle, ax, 0, k, d);
        raw.jointSetLimits(spring.handle, ax, -slack, slack);
      }
      this.skiSprings.push(spring);
    });
    if (this.board) {
      // The board's two halves are one board: weld them together (anchors
      // in each body's frame; every body starts in the shared orientation)
      const a = this.skis[0].body.translation();
      const b = this.skis[1].body.translation();
      const rel = new THREE.Vector3(a.x - b.x, a.y - b.y, a.z - b.z).applyQuaternion(rootInv);
      const same = { x: 0, y: 0, z: 0, w: 1 };
      world.createImpulseJoint(
        RAPIER.JointData.fixed({ x: 0, y: 0, z: 0 }, same, { x: rel.x, y: rel.y, z: rel.z }, same),
        this.skis[0].body,
        this.skis[1].body,
        true,
      );
    }

    // --- Joints. Anchors are given in each body's local frame.
    const anchor = (part: Part, worldPoint: THREE.Vector3) => {
      const t = part.body.translation();
      return worldPoint.clone().sub(tmpV.set(t.x, t.y, t.z)).applyQuaternion(rootInv);
    };
    const ball = (a: Part, b: Part, jointLocal: THREE.Vector3, limits: Limits, muscle: Muscle) => {
      const p = toWorld(jointLocal);
      const joint = world.createImpulseJoint(RAPIER.JointData.spherical(anchor(a, p), anchor(b, p)), a.body, b.body, true);
      // The typings list motors and limits on spherical joints but the
      // runtime class lacks them (rapier3d-compat 0.21): use the joint set
      const lim = [limits.x, limits.y, limits.z];
      for (let ax = 0; ax < 3; ax++) {
        raw.jointSetLimits(joint.handle, ANG_AXES[ax], -lim[ax], lim[ax]);
        raw.jointConfigureMotorModel(joint.handle, ANG_AXES[ax], RAPIER.MotorModel.ForceBased as number as never);
      }
      this.joints.push({ joint, parent: a, child: b, muscle, hingeAxis: null });
    };
    /**
     * A hinge that bends only the natural way. The axis is the normal of the
     * limb's plane, so bending further is a positive rotation about it; the
     * limits are relative to the bend in the pose the ragdoll was built in.
     */
    const hinge = (
      a: Part,
      b: Part,
      rootLocal: THREE.Vector3,
      midLocal: THREE.Vector3,
      endLocal: THREE.Vector3,
      fallbackAxis: THREE.Vector3,
      maxBend: number,
      muscle: Muscle,
    ) => {
      const upper = midLocal.clone().sub(rootLocal).normalize();
      const lower = endLocal.clone().sub(midLocal).normalize();
      const bend = upper.angleTo(lower);
      const axis = new THREE.Vector3().crossVectors(upper, lower);
      if (axis.lengthSq() < 1e-6) axis.copy(fallbackAxis);
      axis.normalize();
      // Every body shares the frame's orientation, so a frame-local axis is
      // already in the bodies' local frame
      const p = toWorld(midLocal);
      const joint = world.createImpulseJoint(
        RAPIER.JointData.revolute(anchor(a, p), anchor(b, p), axis),
        a.body,
        b.body,
        true,
      ) as RAPIER.RevoluteImpulseJoint;
      joint.setLimits(STRAIGHT - bend, maxBend - bend);
      joint.configureMotorModel(RAPIER.MotorModel.ForceBased);
      this.joints.push({ joint, parent: a, child: b, muscle, hingeAxis: axis });
    };

    const j = person.joints;
    ball(pelvis, abdomen, j.spine[1], SPINE_LIMITS, LOWER_SPINE);
    ball(abdomen, chest, j.spine[2], SPINE_LIMITS, UPPER_SPINE);
    ball(chest, head, j.shoulderCentre.clone().lerp(j.headCentre, 0.5), NECK_LIMITS, NECK);
    for (let i = 0; i < 2; i++) {
      ball(pelvis, thighs[i], j.hips[i], HIP_LIMITS, HIP);
      hinge(thighs[i], shins[i], j.hips[i], j.knees[i], j.ankles[i], new THREE.Vector3(-1, 0, 0), KNEE_MAX, KNEE);
      ball(chest, upperArms[i], j.shoulders[i], SHOULDER_LIMITS, SHOULDER);
      hinge(upperArms[i], forearms[i], j.shoulders[i], j.elbows[i], j.hands[i], new THREE.Vector3(1, 0, 0), ELBOW_MAX, ELBOW);

      // Ankle (in the binding): the shin on the ski, flexing like a boot
      ball(this.skis[i], shins[i], j.ankles[i], ANKLE_LIMITS, ANKLE);
      this.skiJoints[i] = this.joints[this.joints.length - 1].joint;
    }

    this.grabHand = forearms[1];
    // Core anchor for the air: free joint to the abdomen, springs off for now
    this.corePart = abdomen;
    this.readTarget(abdomen, this.coreTo);
    this.coreFrom.p.copy(this.coreTo.p);
    this.coreFrom.q.copy(this.coreTo.q);
    this.coreAnchor = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(this.coreTo.p.x, this.coreTo.p.y, this.coreTo.p.z)
        .setRotation(this.coreTo.q),
    );
    this.coreSpring = world.createImpulseJoint(
      RAPIER.JointData.generic(ORIGIN, ORIGIN, X_AXIS, 0 as RAPIER.JointAxesMask),
      this.coreAnchor,
      abdomen.body,
      true,
    );
    for (let ax = 0; ax < 6; ax++) {
      raw.jointConfigureMotorModel(this.coreSpring.handle, ax, RAPIER.MotorModel.ForceBased as number as never);
    }

    this.drive();
    this.sync();
  }

  private readSkiTarget(i: number, out: { p: THREE.Vector3; q: THREE.Quaternion }): void {
    this.readTarget(this.skis[i], out);
  }

  /** Where a part's body should be: its target's position and orientation. */
  private readTarget(part: Part, out: { p: THREE.Vector3; q: THREE.Quaternion }): void {
    part.target.getWorldPosition(out.p);
    // The body's orientation is the part's orientation without its collider's
    part.target.getWorldQuaternion(out.q).multiply(part.colliderInv);
  }

  /**
   * Read this frame's targets from the posed (hidden) model: where the skis
   * go, and the pose every muscle pulls towards. Call once per frame, after
   * the controller has posed the model and before stepping physics.
   */
  drive(): void {
    if (this.limp) return;
    for (let i = 0; i < 2; i++) {
      this.skiFrom[i].p.copy(this.skiTo[i].p);
      this.skiFrom[i].q.copy(this.skiTo[i].q);
      this.readSkiTarget(i, this.skiTo[i]);
    }
    this.coreFrom.p.copy(this.coreTo.p);
    this.coreFrom.q.copy(this.coreTo.q);
    this.readTarget(this.corePart, this.coreTo);
    const raw = this.physics.world.impulseJoints.raw;

    // Who holds the body: the skis on the snow, the core in the air
    const blend = THREE.MathUtils.clamp(this.airBlend, 0, 1);
    const skiScale = 1 - (1 - SKI_AIR_FRACTION) * blend;
    for (const spring of this.skiSprings) {
      for (let ax = 0; ax < 6; ax++) {
        // Position (axes 0-2) relaxes in the air; angle (3-5) stays firm
        const { k, d } = ax < 3 ? SKI_LINEAR : SKI_ANGULAR;
        const scale = ax < 3 ? skiScale : 1 + (SKI_AIR_ANGLE_BOOST - 1) * blend;
        raw.jointConfigureMotorPosition(spring.handle, ax, 0, k * scale, d * scale);
      }
    }
    if (this.coreSpring) {
      for (let ax = 0; ax < 6; ax++) {
        const { k, d } = ax < 3 ? CORE_LINEAR : CORE_ANGULAR;
        raw.jointConfigureMotorPosition(this.coreSpring.handle, ax, 0, k * blend, d * blend);
      }
    }
    // The grab spring: only while the hand is (nearly) there (earlier it
    // would yank the arm), and only exists then: even slack, a joint between
    // the hand and the ski changed how the body landed
    const hold = THREE.MathUtils.clamp((this.grab - 0.7) / 0.3, 0, 1);
    if (hold > 0 && !this.grabSpring) this.createGrabSpring();
    if (hold === 0 && this.grabSpring) this.dropGrab();
    if (this.grabSpring) {
      for (let ax = 0; ax < 3; ax++) {
        raw.jointConfigureMotorPosition(this.grabSpring.handle, ax, 0, GRAB_SPRING.k * hold, GRAB_SPRING.d * hold);
      }
    }
    for (const jt of this.joints) {
      // Target orientation of each body (part orientation minus collider's),
      // then the child relative to the parent, as a rotation vector: the
      // encoding Rapier's ball-joint motors follow (tested: within 0.01-0.07
      // rad for big combined rotations; Euler angles miss by 0.14-0.5)
      const qp = jt.parent.target.getWorldQuaternion(tmpQa).multiply(jt.parent.colliderInv);
      const qc = jt.child.target.getWorldQuaternion(tmpQb).multiply(jt.child.colliderInv);
      const rel = qp.invert().multiply(qc);
      const rv = rotationVector(rel, tmpRv);
      const { omega, zeta, load } = jt.muscle;
      const k = load * omega * omega;
      const d = 2 * zeta * omega * load;
      if (jt.hingeAxis) {
        (jt.joint as RAPIER.RevoluteImpulseJoint).configureMotorPosition(rv.dot(jt.hingeAxis), k, d);
      } else {
        raw.jointConfigureMotorPosition(jt.joint.handle, ANG_AXES[0], rv.x, k, d);
        raw.jointConfigureMotorPosition(jt.joint.handle, ANG_AXES[1], rv.y, k, d);
        raw.jointConfigureMotorPosition(jt.joint.handle, ANG_AXES[2], rv.z, k, d);
      }
    }
  }

  /**
   * Before each physics substep: move the skis' anchors part of the way from
   * last frame's target to this frame's, so they glide smoothly rather than
   * jumping once a frame.
   */
  beforeSubstep(alpha: number): void {
    if (this.limp) return;
    for (let i = 0; i < 2; i++) {
      const body = this.anchors[i];
      tmpV.lerpVectors(this.skiFrom[i].p, this.skiTo[i].p, alpha);
      tmpQa.slerpQuaternions(this.skiFrom[i].q, this.skiTo[i].q, alpha);
      body.setNextKinematicTranslation(tmpV);
      body.setNextKinematicRotation(tmpQa);
    }
    tmpV.lerpVectors(this.coreFrom.p, this.coreTo.p, alpha);
    tmpQa.slerpQuaternions(this.coreFrom.q, this.coreTo.q, alpha);
    this.coreAnchor.setNextKinematicTranslation(tmpV);
    this.coreAnchor.setNextKinematicRotation(tmpQa);
  }

  /**
   * The grab: the right hand (the end of the forearm) held to the right
   * ski's tail by a free joint with springs on position only. Anchors in
   * each body's frame: a point in a part's own frame turned by its collider
   * rotation.
   */
  private createGrabSpring(): void {
    const raw = this.physics.world.impulseJoints.raw;
    const hand = new THREE.Vector3(0, BODY.forearm / 2, 0).applyQuaternion(this.grabHand.colliderRot);
    const hold = this.person.grabHoldLocal(new THREE.Vector3()).applyQuaternion(this.skis[1].colliderRot);
    this.grabSpring = this.physics.world.createImpulseJoint(
      RAPIER.JointData.generic(hand, hold, X_AXIS, 0 as RAPIER.JointAxesMask),
      this.grabHand.body,
      this.skis[1].body,
      true,
    );
    for (let ax = 0; ax < 3; ax++) {
      raw.jointConfigureMotorModel(this.grabSpring.handle, ax, RAPIER.MotorModel.ForceBased as number as never);
    }
  }

  private dropGrab(): void {
    if (this.grabSpring) this.physics.world.removeImpulseJoint(this.grabSpring, true);
    this.grabSpring = null;
  }

  /** Remove the core spring (crash, or physical skiing: nothing holds the body). */
  private dropCore(): void {
    if (this.coreSpring) this.physics.world.removeImpulseJoint(this.coreSpring, true);
    this.coreSpring = null;
  }

  /** The visible copy of a posed part (for things worn on the body). */
  visualOf(target: THREE.Object3D): THREE.Object3D {
    const part = this.parts.find((p) => p.target === target);
    if (!part) throw new Error('not a ragdoll part');
    return part.visual;
  }

  /** Every body: body parts and both skis. */
  get bodies(): RAPIER.RigidBody[] {
    return this.parts.map((p) => p.body);
  }

  /** The two ski bodies. */
  get skiBodies(): RAPIER.RigidBody[] {
    return this.skis.map((p) => p.body);
  }

  /** Are the skis still sprung to the controller's anchors? */
  get skisSprung(): boolean {
    return this.skiSprings.length > 0;
  }

  /**
   * Physical skiing: let go of the skis' anchors so they slide on the snow
   * by themselves. The muscles keep holding the pose on top of them.
   */
  freeSkis(): void {
    for (const spring of this.skiSprings) this.physics.world.removeImpulseJoint(spring, true);
    this.skiSprings.length = 0;
    this.dropCore();
    // The physical ride supports them from the snow height (see FREE_SKI_GROUPS)
    for (const ski of this.skis) {
      for (let c = 0; c < ski.body.numColliders(); c++) ski.body.collider(c).setCollisionGroups(FREE_SKI_GROUPS);
    }
  }

  /** Total mass, centre of mass and its velocity, over every body. */
  massState(com: THREE.Vector3, vel: THREE.Vector3): number {
    let m = 0;
    com.set(0, 0, 0);
    vel.set(0, 0, 0);
    for (const part of this.parts) {
      const b = part.body;
      const mi = b.mass();
      const t = b.translation();
      const v = b.linvel();
      com.x += t.x * mi;
      com.y += t.y * mi;
      com.z += t.z * mi;
      vel.x += v.x * mi;
      vel.y += v.y * mi;
      vel.z += v.z * mi;
      m += mi;
    }
    com.divideScalar(m);
    vel.divideScalar(m);
    return m;
  }

  /**
   * Kick the whole body as one: every part gets the same change in velocity
   * dv, plus the spin w (rad/s, world) about the centre of mass, as if the
   * body were rigid for that instant. Used for the jump's push.
   */
  kick(dv: THREE.Vector3, w: THREE.Vector3, com: THREE.Vector3): void {
    for (const part of this.parts) {
      const b = part.body;
      const t = b.translation();
      const v = b.linvel();
      const av = b.angvel();
      // Each point of a spinning body moves at w × r
      tmpV.set(t.x - com.x, t.y - com.y, t.z - com.z);
      tmpRv.crossVectors(w, tmpV).add(dv);
      b.setLinvel({ x: v.x + tmpRv.x, y: v.y + tmpRv.y, z: v.z + tmpRv.z }, true);
      b.setAngvel({ x: av.x + w.x, y: av.y + w.y, z: av.z + w.z }, true);
    }
  }

  /** Crash: let the skis go (carrying on at this velocity), relax the muscles. */
  goLimp(velocity: THREE.Vector3): void {
    if (this.limp) return;
    this.limp = true;
    // Let go of the skis (they keep the speed they have) and let them hit
    // the snow like everything else
    for (const spring of this.skiSprings) this.physics.world.removeImpulseJoint(spring, true);
    this.skiSprings.length = 0;
    this.dropCore();
    this.dropGrab(); // (and let go of the grab)
    for (const ski of this.skis) {
      for (let c = 0; c < ski.body.numColliders(); c++) {
        ski.body.collider(c).setCollisionGroups(RAGDOLL_GROUPS);
        ski.body.collider(c).setFriction(SKI_FRICTION);
        ski.body.collider(c).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Average);
      }
    }
    void velocity;
    const raw = this.physics.world.impulseJoints.raw;
    for (const jt of this.joints) {
      const d = LIMP_DAMPING * jt.muscle.load;
      if (jt.hingeAxis) (jt.joint as RAPIER.RevoluteImpulseJoint).configureMotorVelocity(0, d);
      else for (const ax of ANG_AXES) raw.jointConfigureMotorVelocity(jt.joint.handle, ax, 0, d);
    }
    for (let i = 0; i < 2; i++) {
      const v = this.skis[i].body.linvel();
      this.lastSkiVel[i].set(v.x, v.y, v.z);
    }
  }

  /** In a crash: release bindings that took a violent jolt this frame. */
  update(dt: number): void {
    if (!this.limp) return;
    for (let i = 0; i < 2; i++) {
      const v = this.skis[i].body.linvel();
      const dv = this.lastSkiVel[i].distanceTo(tmpV.set(v.x, v.y, v.z));
      this.lastSkiVel[i].copy(tmpV);
      const joint = this.skiJoints[i];
      // (Snowboard bindings don't release: the board stays on)
      if (joint && !this.board && dt > 0 && dv / dt / 9.81 > SKI_RELEASE_G) {
        this.physics.world.removeImpulseJoint(joint, true);
        this.skiJoints[i] = null;
        this.skisLost++;
      }
    }
  }

  /** Place what you see from the physics bodies. */
  sync(): void {
    for (const part of this.parts) {
      const t = part.body.translation();
      const r = part.body.rotation();
      part.visual.position.set(t.x, t.y, t.z);
      part.visual.quaternion.set(r.x, r.y, r.z, r.w).multiply(part.colliderRot);
    }
  }

  /** Is the chest or head touching the snow? (That's a fall.) */
  chestOrHeadDown(): boolean {
    const world = this.physics.world;
    let hit = false;
    for (const body of [this.chest, this.head]) {
      for (let c = 0; c < body.numColliders() && !hit; c++) {
        const collider = body.collider(c);
        world.contactPairsWith(collider, (other) => {
          if (other.parent()?.isFixed() || !other.parent()) {
            world.contactPair(collider, other, (manifold) => {
              if (manifold.numContacts() > 0) hit = true;
            });
          }
        });
      }
    }
    return hit;
  }

  /** Speed of the torso, and how fast it's tumbling. */
  torsoMotion(): { speed: number; spin: number; velocity: THREE.Vector3 } {
    const v = this.torso.linvel();
    const w = this.torso.angvel();
    return {
      velocity: new THREE.Vector3(v.x, v.y, v.z),
      speed: Math.hypot(v.x, v.y, v.z),
      spin: Math.hypot(w.x, w.y, w.z),
    };
  }

  torsoPosition(out = new THREE.Vector3()): THREE.Vector3 {
    const t = this.torso.translation();
    return out.set(t.x, t.y, t.z);
  }

  destroy(): void {
    // Removing a body also removes its colliders and joints
    for (const part of this.parts) this.physics.world.removeRigidBody(part.body);
    for (const anchor of this.anchors) this.physics.world.removeRigidBody(anchor);
    this.physics.world.removeRigidBody(this.coreAnchor);
    this.parts.length = 0;
    this.view.removeFromParent();
  }
}

/** Rotation as axis × angle (shortest way round). */
function rotationVector(q: THREE.Quaternion, out: THREE.Vector3): THREE.Vector3 {
  const s = q.w < 0 ? -1 : 1; // q and -q are the same rotation: take the short one
  const w = Math.min(1, s * q.w);
  const angle = 2 * Math.acos(w);
  const sin = Math.sqrt(1 - w * w);
  if (sin < 1e-6) return out.set(s * q.x * 2, s * q.y * 2, s * q.z * 2);
  return out.set(s * q.x, s * q.y, s * q.z).multiplyScalar(angle / sin);
}

const ANG_AXES = [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngY, RAPIER.JointAxis.AngZ] as number[];
const ORIGIN = { x: 0, y: 0, z: 0 };
const X_AXIS = { x: 1, y: 0, z: 0 };
const tmpV = new THREE.Vector3();
const tmpQa = new THREE.Quaternion();
const tmpQb = new THREE.Quaternion();
const tmpRv = new THREE.Vector3();
