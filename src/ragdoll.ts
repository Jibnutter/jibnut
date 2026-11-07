import * as THREE from 'three';
import { RAPIER, type Physics } from './physics';
import { BODY, MASS, type Person, type Segment } from './person';

/**
 * A physics ragdoll built from the person's current pose at the moment of a
 * crash: one rigid body per body part and per ski, linked by joints.
 *
 *   spine (x2), neck,      ball joints with angle limits, lightly damped
 *   shoulders, hips          like relaxed muscles
 *   elbows, knees          hinges that only bend the natural way
 *   ankles                 skis held on fixed joints; a violent jolt releases them
 *
 * All bodies start with the same orientation (the skier's), and each part's
 * own orientation lives in its collider. That way a hinge axis means the same
 * thing in both bodies it joins, which is how Rapier's revolute joints work.
 */

const BODY_FRICTION = 0.9; // a body sliding on snow grips far more than skis
const SKI_FRICTION = 0.15;
const SKI_MASS = 2;
// Ragdoll parts collide with the world but not each other. Groups are
// (membership << 16) | filter: we're in group 2 and only collide with group 1.
const RAGDOLL_GROUPS = (0x0002 << 16) | 0x0001;

const LIMB_DAMPING = 0.3; // body angular damping: air and soft-tissue losses
// Joint motor damping: resists joints swinging freely, like muscle tone.
// Rapier's motors here are acceleration-based (mass doesn't matter); in a
// test, 1000 made a 1 m pendulum's swing decay e-fold in about 1.3 s.
// Kept low so a fall looks loose; the angle limits stop it going rubbery.
const MUSCLE = 300;
const SPINE_MUSCLE = 600; // the trunk holds together a bit more than limbs

// Ball joint limits, radians either way from the pose at the crash, about the
// skier's own axes: x = bend forward/back, y = twist, z = bend sideways.
type Limits = { x: number; y: number; z: number };
const SPINE_LIMITS: Limits = { x: 0.45, y: 0.35, z: 0.3 }; // per spine joint
const NECK_LIMITS: Limits = { x: 0.7, y: 1.0, z: 0.5 };
const SHOULDER_LIMITS: Limits = { x: 2.2, y: 1.2, z: 1.6 };
const HIP_LIMITS: Limits = { x: 1.8, y: 0.6, z: 0.8 };
const KNEE_MAX = 2.6; // radians of bend from straight
const ELBOW_MAX = 2.6;
const STRAIGHT = 0.02; // knees and elbows stop just short of straight
// A binding pops when its ski is jolted harder than this. Peak jolts seen in
// test crashes: ~100 km/h crashes 60-135 g, a slow 180 54-84 g, a gentle
// slow backflip 44 g. At 60 most hard crashes lose both skis, slow ones may
// lose one, and gentle falls keep them.
const SKI_RELEASE_G = 60;

interface Part {
  body: RAPIER.RigidBody;
  object: THREE.Object3D; // the mesh or ski group that shows it
  colliderRot: THREE.Quaternion; // part orientation relative to the body
}

export class Ragdoll {
  private readonly physics: Physics;
  private readonly parts: Part[] = [];
  private readonly skiJoints: (RAPIER.ImpulseJoint | null)[] = [null, null];
  private readonly skiBodies: RAPIER.RigidBody[] = [];
  private readonly lastSkiVel = [new THREE.Vector3(), new THREE.Vector3()];
  readonly torso: RAPIER.RigidBody;
  /** How many skis have come off. */
  skisLost = 0;

  /**
   * @param rig      frame the person and skis are posed in (rig-local coordinates)
   * @param skiGroups the two ski models, children of the skis group
   * @param velocity linear velocity of the centre of mass
   * @param angvel   angular velocity of the whole skier
   * @param com      world centre of mass, the point angvel spins around
   */
  constructor(
    physics: Physics,
    person: Person,
    rig: THREE.Object3D,
    skiGroups: THREE.Object3D[],
    velocity: THREE.Vector3,
    angvel: THREE.Vector3,
    com: THREE.Vector3,
  ) {
    this.physics = physics;
    const world = physics.world;
    rig.updateMatrixWorld(true);
    const rootRot = rig.getWorldQuaternion(new THREE.Quaternion());
    const rootInv = rootRot.clone().invert();

    const toWorld = (local: THREE.Vector3) => rig.localToWorld(local.clone());

    /** A body at the part's world position, with the shared orientation. */
    const makeBody = (object: THREE.Object3D, damping: number): Part => {
      const pos = object.getWorldPosition(new THREE.Vector3());
      const rot = object.getWorldQuaternion(new THREE.Quaternion());
      // Each point of a spinning skier moves at v + ω × r
      const v = new THREE.Vector3().crossVectors(angvel, pos.clone().sub(com)).add(velocity);
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(pos.x, pos.y, pos.z)
          .setRotation(rootRot)
          .setLinvel(v.x, v.y, v.z)
          .setAngvel(angvel)
          .setLinearDamping(0.05)
          .setAngularDamping(damping)
          .setCcdEnabled(true), // small and fast: don't tunnel through the snow
      );
      const part = { body, object, colliderRot: rootInv.clone().multiply(rot) };
      this.parts.push(part);
      return part;
    };

    const addCollider = (part: Part, desc: RAPIER.ColliderDesc, mass: number, volume: number, friction: number) => {
      world.createCollider(
        desc
          .setRotation(part.colliderRot)
          .setDensity(mass / volume)
          .setFriction(friction)
          .setRestitution(0.1)
          .setCollisionGroups(RAGDOLL_GROUPS),
        part.body,
      );
    };

    const capsulePart = (seg: Segment): Part => {
      const part = makeBody(seg.mesh, LIMB_DAMPING);
      const r = seg.radius;
      const volume = Math.PI * r * r * seg.length + (4 / 3) * Math.PI * r ** 3;
      addCollider(part, RAPIER.ColliderDesc.capsule(seg.length / 2, r), seg.mass, volume, BODY_FRICTION);
      return part;
    };

    // --- Bodies
    const [pelvis, abdomen, chest] = person.spine.map(capsulePart);
    this.torso = abdomen.body; // the middle of the trunk: what the camera follows

    const head = makeBody(person.head, LIMB_DAMPING);
    const hr = BODY.headRadius;
    addCollider(head, RAPIER.ColliderDesc.ball(hr), MASS.head, (4 / 3) * Math.PI * hr ** 3, BODY_FRICTION);

    const thighs = person.thighs.map(capsulePart);
    const shins = person.shins.map(capsulePart);
    const upperArms = person.upperArms.map(capsulePart);
    const forearms = person.forearms.map(capsulePart);

    const skis = skiGroups.map((g) => {
      const part = makeBody(g, 0.3);
      addCollider(part, RAPIER.ColliderDesc.cuboid(0.05, 0.015, 0.8), SKI_MASS, 0.1 * 0.03 * 1.6, SKI_FRICTION);
      this.skiBodies.push(part.body);
      return part;
    });

    // --- Joints. Anchors are given in each body's local frame.
    const anchor = (part: Part, worldPoint: THREE.Vector3) => {
      const t = part.body.translation();
      return worldPoint.clone().sub(tmpV.set(t.x, t.y, t.z)).applyQuaternion(rootInv);
    };
    const ball = (a: Part, b: Part, jointLocal: THREE.Vector3, limits: Limits, muscle = MUSCLE) => {
      const p = toWorld(jointLocal);
      const joint = world.createImpulseJoint(
        RAPIER.JointData.spherical(anchor(a, p), anchor(b, p)),
        a.body,
        b.body,
        true,
      );
      // Muscle tone (damping towards zero speed) and angle limits on each
      // axis. The typings list motors on spherical joints but the runtime
      // class lacks them (rapier3d-compat 0.21), so go through the joint set.
      // The joint's axes are the bodies' shared frame: the skier's own axes.
      const raw = world.impulseJoints.raw;
      const axes: [RAPIER.JointAxis, number][] = [
        [RAPIER.JointAxis.AngX, limits.x],
        [RAPIER.JointAxis.AngY, limits.y],
        [RAPIER.JointAxis.AngZ, limits.z],
      ];
      for (const [axis, limit] of axes) {
        raw.jointConfigureMotorVelocity(joint.handle, axis as number, 0, muscle);
        raw.jointSetLimits(joint.handle, axis as number, -limit, limit);
      }
    };
    /**
     * A hinge that bends only the natural way. The axis is the normal of the
     * limb's plane, so bending further is a positive rotation about it; the
     * limits are relative to the bend at the moment of the crash.
     */
    const hinge = (
      a: Part,
      b: Part,
      rootLocal: THREE.Vector3,
      midLocal: THREE.Vector3,
      endLocal: THREE.Vector3,
      fallbackAxis: THREE.Vector3,
      maxBend: number,
    ) => {
      const upper = midLocal.clone().sub(rootLocal).normalize();
      const lower = endLocal.clone().sub(midLocal).normalize();
      const bend = upper.angleTo(lower);
      const axisLocal = new THREE.Vector3().crossVectors(upper, lower);
      if (axisLocal.lengthSq() < 1e-6) axisLocal.copy(fallbackAxis);
      axisLocal.normalize();
      // Every body shares the rig's orientation, so a rig-local axis is
      // already in the bodies' local frame
      const p = toWorld(midLocal);
      const joint = world.createImpulseJoint(
        RAPIER.JointData.revolute(anchor(a, p), anchor(b, p), axisLocal),
        a.body,
        b.body,
        true,
      ) as RAPIER.RevoluteImpulseJoint;
      joint.setLimits(STRAIGHT - bend, maxBend - bend);
      joint.configureMotorVelocity(0, MUSCLE);
    };

    const j = person.joints;
    ball(pelvis, abdomen, j.spine[1], SPINE_LIMITS, SPINE_MUSCLE);
    ball(abdomen, chest, j.spine[2], SPINE_LIMITS, SPINE_MUSCLE);
    ball(chest, head, j.shoulderCentre.clone().lerp(j.headCentre, 0.5), NECK_LIMITS);
    for (let i = 0; i < 2; i++) {
      ball(pelvis, thighs[i], j.hips[i], HIP_LIMITS);
      hinge(thighs[i], shins[i], j.hips[i], j.knees[i], j.ankles[i], new THREE.Vector3(-1, 0, 0), KNEE_MAX);
      ball(chest, upperArms[i], j.shoulders[i], SHOULDER_LIMITS);
      hinge(upperArms[i], forearms[i], j.shoulders[i], j.elbows[i], j.hands[i], new THREE.Vector3(1, 0, 0), ELBOW_MAX);

      // Ski bindings: rigid until something rips them off
      const p = toWorld(j.ankles[i]);
      this.skiJoints[i] = world.createImpulseJoint(
        RAPIER.JointData.fixed(anchor(shins[i], p), IDENTITY, anchor(skis[i], p), IDENTITY),
        shins[i].body,
        skis[i].body,
        true,
      );
      const sv = skis[i].body.linvel();
      this.lastSkiVel[i].set(sv.x, sv.y, sv.z);
    }
  }

  /** Release bindings that took a violent jolt this frame. */
  update(dt: number): void {
    for (let i = 0; i < 2; i++) {
      const v = this.skiBodies[i].linvel();
      const dv = this.lastSkiVel[i].distanceTo(tmpV.set(v.x, v.y, v.z));
      this.lastSkiVel[i].copy(tmpV);
      const joint = this.skiJoints[i];
      if (joint && dt > 0 && dv / dt / 9.81 > SKI_RELEASE_G) {
        this.physics.world.removeImpulseJoint(joint, true);
        this.skiJoints[i] = null;
        this.skisLost++;
      }
    }
  }

  /**
   * Move the models to match the bodies. Positions are written relative to
   * `origin` (the rig's world position; the rig must have no rotation).
   */
  sync(origin: THREE.Vector3): void {
    for (const part of this.parts) {
      const t = part.body.translation();
      const r = part.body.rotation();
      part.object.position.set(t.x - origin.x, t.y - origin.y, t.z - origin.z);
      part.object.quaternion.set(r.x, r.y, r.z, r.w).multiply(part.colliderRot);
    }
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
    this.parts.length = 0;
  }
}

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const tmpV = new THREE.Vector3();
