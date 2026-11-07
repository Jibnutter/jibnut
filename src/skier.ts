import * as THREE from 'three';
import { heightAt, normalAt, courseX, EDGE_LIMIT, MAX_Z } from './terrain';
import type { Controls } from './input';
import { RAPIER, type Physics } from './physics';
import { Ragdoll } from './ragdoll';
import { SecondaryMotion } from './secondary';
import {
  Person,
  BODY,
  RIDING,
  TUCK,
  CROUCH,
  AIR,
  AIR_TUCK,
  AIR_OPEN,
  AIR_SPIN,
  LEAN_BACK,
  LEAN_FORWARD,
  lerpPose,
  type Pose,
  type MassProperties,
} from './person';

const STANCE = BODY.stance; // half the gap between the skis

function createSki(x: number): THREE.Group {
  const mat = new THREE.MeshStandardMaterial({ color: 0x2b6fd6, roughness: 0.4 });
  const ski = new THREE.Group();

  const base = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.03, 1.6), mat);
  base.castShadow = true;
  ski.add(base);

  // Upturned tip at the front (-Z) and a smaller kick at the tail
  const tip = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.03, 0.2), mat);
  tip.position.set(0, 0.04, -0.88);
  tip.rotation.x = 0.5;
  tip.castShadow = true;
  ski.add(tip);
  const tail = tip.clone();
  tail.position.z = 0.86;
  tail.rotation.x = -0.3;
  ski.add(tail);

  // Boot
  const boot = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.1, 0.3),
    new THREE.MeshStandardMaterial({ color: 0x222222 }),
  );
  boot.position.y = 0.06;
  boot.castShadow = true;
  ski.add(boot);

  ski.position.set(x, 0.015, 0);
  return ski;
}

const GRAVITY = 9.81;
const SNOW_FRICTION = 0.05; // ski-on-snow friction coefficient
const AIR_DRAG = 0.004; // 0.5 * air density * drag area / mass, per metre
const TUCK_DRAG = 0.002; // tucking roughly halves the frontal area
const BRAKE_DECEL = 4; // snowplow, m/s^2
const TURN_RATE = 2.2; // rad/s when slow; turning gets wider at speed
const CLEAN_SPIN = 0.6; // land within ~35° of your travel direction to stick it
const CLEAN_FLIP = 0.7; // land with the body within ~40° of the slope's normal to stick it
const TURN_SCRUB = 0.25; // fraction of speed lost per second while turning hard
const MAX_LEAN = 0.45; // radians the body leans into a turn
const EDGE = EDGE_LIMIT; // stay on the course, between the berms
const WALL = 0.4; // a step up bigger than this (m) blocks you, e.g. a kicker's side
const MAX_SLOPE_NY = 0.5; // surfaces steeper than 60° count as walls, not slopes
const WALL_CRASH_SPEED = 4; // m/s: hit a kicker's side faster than this and you fall

// While riding, the spine (pelvis, abdomen, chest) and head are checked
// against the snow: if any touches, you've fallen. Legs and arms don't count, since they're meant
// to be near the snow.
const SKI_HALF = { x: 0.23, y: 0.03, z: 0.9 }; // box around both skis
const SKI_GRACE = 0.1; // s after takeoff before the skis can count as landing
const SWEEP_STEP = 0.1; // m between body checks along each frame's path

// After a crash the ragdoll (ragdoll.ts) takes over until you get back up.
const GET_UP_MIN = 1.5; // s of tumbling at least, so a crash reads as a crash
const GET_UP_SETTLED = 0.4; // s of not tumbling over before getting back up
const SETTLED_SPIN = 2.5; // rad/s: below this the body is wobbling, not tumbling
const GET_UP_MAX = 6; // s of tumbling before getting up regardless

const CHARGE_TIME = 0.8; // seconds of holding space for a full-power jump
const POP_MIN = 2.5; // m/s of pop for a quick tap
const POP_MAX = 7.5; // m/s of pop at full charge
const WEIGHT_SHIFT_RATE = 6; // how quickly weight moves fore/aft, and wind-up builds (1/s)
// Holding A/D while charging winds the upper body up the opposite way; at
// the pop it unwinds against the skis' edges into spin. This much angular
// momentum (kg m²/s) at full wind-up, on top of any turn you carve into the
// takeoff.
const WIND_MOMENTUM = 14;
const WINDUP_TWIST = 0.6; // radians the shoulders turn back while winding up
const SWITCH_TWIST = 0.6; // shoulders turned towards the look when riding switch
// The upper body turns partly towards the fall line, separately from the skis
const FALL_LINE_PULL = 0.4; // fraction of the way
const MAX_COUNTER = 0.45; // radians at most
const SKI_MASS = 2; // kg, matching the ragdoll's skis
const SKI_LENGTH = 1.6;
// Windmilling the arms turns the body a little without changing its angular
// momentum (the arms turn the other way). Holding W in the air does this,
// turning the body towards the slope below at up to this rate.
const WINDMILL_RATE = 1.2; // rad/s
// With no keys held and no flip going, riders instinctively spot their
// landing: the same windmilling, gentler. A rider leaving a 24° lip for a
// 32° landing needs ~56° of forward rotation from somewhere.
const AUTO_SPOT_RATE = 0.7; // rad/s
const AUTO_SPOT_MAX_FLIP = 1.5; // rad/s: above this you're flipping, so no auto-spot

const UP = new THREE.Vector3(0, 1, 0);

/** Wrap an angle to (-π, π]. */
function wrapAngle(a: number): number {
  return a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
}

/**
 * Name a jump's tricks, e.g. "360", "Frontflip", "Switch 540 + Backflip".
 * Spins count in half turns, since you can land forwards or switch.
 */
function trickName(spin: number, pitch: number, fromSwitch: boolean): string {
  const parts: string[] = [];
  // Spin rounded to the nearest 180, since clean landings are within ±35°
  const degrees = Math.round(Math.abs(spin) / Math.PI) * 180;
  if (degrees >= 180) parts.push(`${degrees}`);
  const flips = Math.round(pitch / (2 * Math.PI));
  const kind = flips > 0 ? 'backflip' : 'frontflip';
  const n = Math.abs(flips);
  const name = kind[0].toUpperCase() + kind.slice(1);
  if (n === 1) parts.push(name);
  else if (n === 2) parts.push(`Double ${kind}`);
  else if (n === 3) parts.push(`Triple ${kind}`);
  else if (n > 3) parts.push(`${n}x ${kind}`);
  const trick = parts.join(' + ');
  return trick && fromSwitch ? `Switch ${trick}` : trick;
}
const g = new THREE.Vector3(0, -GRAVITY, 0);
const tmpN = new THREE.Vector3();
const tmpDir = new THREE.Vector3();
const tmpPred = new THREE.Vector3();
const tmpPos = new THREE.Vector3();
const tmpRot = new THREE.Quaternion();
const tmpOffset = new THREE.Vector3();
const tmpCentre = new THREE.Vector3();
const tmpStart = new THREE.Vector3();
const tmpSweep = new THREE.Vector3();
const tmpSlide = new THREE.Vector3();
const tmpBack = new THREE.Vector3();
const tmpCom = new THREE.Vector3();
const tmpMass: MassProperties = { mass: 0, com: new THREE.Vector3(), pitchInertia: 1, yawInertia: 1, rollInertia: 1 };
// Skis sit untilted in the stance frame, alongside the person
const SKIS_IN_STANCE = [-STANCE, STANCE].map((x) => ({
  p: new THREE.Vector3(x, 0.015, 0),
  d: new THREE.Vector3(0, 0, 1),
}));
const tmpFelt = new THREE.Vector3();
const tmpStanceQ = new THREE.Quaternion();
const tmpFeetW = new THREE.Vector3();
const tmpLb = new THREE.Vector3();
const tmpWb = new THREE.Vector3();
const tmpQInv = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpFwdAir = new THREE.Vector3();
const tmpAxis = new THREE.Vector3();

/** Rotate q by angular velocity w (world frame, rad/s) over dt. */
function rotateBy(q: THREE.Quaternion, w: THREE.Vector3, dt: number): void {
  const rate = w.length();
  if (rate < 1e-9) return;
  q.premultiply(tmpQ2.setFromAxisAngle(tmpAxis.copy(w).divideScalar(rate), rate * dt)).normalize();
}
const tmpUp = new THREE.Vector3();
const tmpFwd = new THREE.Vector3();
const tmpFootN = new THREE.Vector3();
const tmpPush = new THREE.Vector3();
// Sample points (along the skis, across them) in metres from the boots
const FOOTPRINT = [[0, 0], [0.6, 0], [-0.6, 0], [0, 0.2], [0, -0.2]];
const tmpFeet = new THREE.Vector3();
const tmpImpulse = new THREE.Vector3();
const tmpSideAxis = new THREE.Vector3();
const tmpTorque = new THREE.Vector3();

export class Skier {
  readonly object = new THREE.Group();
  private readonly skis = new THREE.Group();
  private readonly person = new Person();
  /** Springy layer on top of the pose: suspension, lag, floppy arms. */
  private readonly secondary = new SecondaryMotion();
  private readonly prevVelocity = new THREE.Vector3();
  private prevHeading = 0;
  private prevGrounded = true;
  private poppedThisFrame = false;
  /** Current pose, eased towards the target each frame. */
  private readonly current: Pose = { ...RIDING };
  private readonly target: Pose = { ...RIDING };

  readonly velocity = new THREE.Vector3();
  /** Facing angle around world Y. 0 = straight down the fall line (-Z). */
  heading = 0;
  grounded = true;
  /** Jump charge from holding space, 0..1. */
  charge = 0;
  private wasJumpHeld = false;
  private lean = 0;

  // Flips pivot around the centre of mass, not the feet: object (at the feet,
  // turned to the heading) -> body (at the COM, pitched) -> rig (back to the
  // feet). The COM is worked out from the pose every frame.
  private readonly body = new THREE.Group();
  private readonly mass: MassProperties = { mass: 0, com: new THREE.Vector3(), pitchInertia: 1, yawInertia: 1, rollInertia: 1 };
  /**
   * Centre of mass of the pose *without* the springy layer, stance frame.
   * The jump's push uses this: the rider's balance cancels out wobble, so
   * only a deliberate weight shift (W/S while loading) starts a flip.
   */
  private readonly intendedCom = new THREE.Vector3();
  /**
   * Spin works like flips: angular momentum about the vertical (kg m²/s), set
   * at takeoff by the turn you're carving plus any wind-up, then conserved.
   * Spin speed = momentum / inertia: arms in spins faster, arms out slower.
   */
  private spinMomentum = 0;
  /** Wind-up for a spin while loading a jump: -1 (right) .. +1 (left). */
  private windup = 0;
  /** How fast the skier is turning on the snow right now, rad/s. */
  private turnRate = 0;
  /**
   * Flip rotation is physical: angular momentum about the side axis (kg m²/s)
   * is set at takeoff and conserved in the air. Rotation speed is momentum /
   * inertia, so tucking (less inertia) spins faster and opening up slows down.
   */
  private flipMomentum = 0;
  private flipVel = 0;
  // In the air the body is a free rigid body: a full orientation (airQ, of
  // the body and its stance) and an angular momentum vector (airL) fixed in
  // the world at takeoff. Each frame the angular velocity is worked out from
  // the momentum and the inertia of the current pose about the body's own
  // axes, so spin + flip combine into the off-axis "cork" rotations real
  // riders do, instead of the flip axis being dragged round by the spin.
  private readonly airQ = new THREE.Quaternion();
  private readonly airL = new THREE.Vector3();
  /** Current angular velocity in the air, world frame (rad/s). */
  private readonly airOmega = new THREE.Vector3();
  /** The side axis at takeoff (world, horizontal): flips are counted about it. */
  private readonly flipAxis = new THREE.Vector3(1, 0, 0);
  /** Weight shifted fore/aft while loading a jump: -1 forward .. +1 back. */
  private weight = 0;
  /**
   * Riding switch: facing backwards, skis sliding tail first. Entered by
   * landing a 180 (or 540...), left the same way.
   */
  switchStance = false;
  private takeoffSwitch = false;
  /** Up direction of the stance in world space: the slope's normal, kept through the air. */
  private readonly tiltWorld = new THREE.Vector3(0, 1, 0);
  /** Which shoulder to look over when riding switch: +1 left, -1 right. */
  private lookSide = 1;
  private pitch = 0; // flip rotation so far, radians: + backflip, - frontflip
  private airSpin = 0; // heading change during this jump, radians

  /** Called on landing after a trick or a crash, for the HUD to show. */
  onLand?: (message: string, clean: boolean) => void;

  /** 'riding' = our own ski physics; 'tumbling' = crashed, Rapier simulates. */
  mode: 'riding' | 'tumbling' = 'riding';
  private readonly physics: Physics;
  private ragdoll: Ragdoll | null = null;
  private readonly rig = new THREE.Group();
  /** Person + skis, tilted to the slope (see constructor). */
  private readonly stance = new THREE.Group();
  private readonly skiModels: THREE.Group[];
  private tumbleTime = 0;
  private stillTime = 0;
  private airTime = 0;
  private hitWall = false;
  private readonly prevCentre = new THREE.Vector3();
  /** Why the last crash happened, for debugging. */
  crashReason = '';

  // Wireframes of the collision query shapes, for the debug view
  private readonly debugParts: THREE.Mesh[] = [];
  private readonly debugSkis: THREE.Mesh;

  constructor(physics: Physics) {
    this.physics = physics;
    this.skiModels = [createSki(-STANCE), createSki(STANCE)];
    this.skis.add(...this.skiModels);
    // Skis follow the slope; the person stays upright like a real skier,
    // with knees and ankles bending to keep the boots on the skis
    // The person and skis stand together in the stance frame, which tilts so
    // the body is perpendicular to the skis: the balanced stance on a slope
    // (the ground's push then goes straight through the centre of mass)
    const rig = this.rig;
    this.stance.add(this.skis, this.person.group);
    rig.add(this.stance);
    this.body.add(rig);
    this.updateMass(false);
    this.object.add(this.body);

    const wire = new THREE.MeshBasicMaterial({ color: 0xff00ff, wireframe: true });
    for (const part of [...this.person.spine.map((s) => s.mesh), this.person.head]) {
      const overlay = new THREE.Mesh(part.geometry, wire);
      part.add(overlay);
      this.debugParts.push(overlay);
    }
    this.debugSkis = new THREE.Mesh(
      new THREE.BoxGeometry(SKI_HALF.x * 2, SKI_HALF.y * 2, SKI_HALF.z * 2),
      wire,
    );
    this.debugSkis.position.y = 0.015;
    this.skis.add(this.debugSkis);
    this.showColliders = false;
  }

  /** Show the riding collision shapes as wireframes. */
  set showColliders(on: boolean) {
    for (const m of this.debugParts) m.visible = on;
    this.debugSkis.visible = on;
  }
  get showColliders(): boolean {
    return this.debugSkis.visible;
  }

  /** World position of the centre of mass: what the camera should follow. */
  centre(out = new THREE.Vector3()): THREE.Vector3 {
    if (this.ragdoll) return this.ragdoll.torsoPosition(out);
    return this.body.getWorldPosition(out);
  }

  /** How many skis came off in the current crash (0 when riding). */
  get skisLost(): number {
    return this.ragdoll?.skisLost ?? 0;
  }

  get speed(): number {
    return this.velocity.length();
  }

  /** Unit vector the skier is facing, on the horizontal plane. */
  forward(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(-Math.sin(this.heading), 0, -Math.cos(this.heading));
  }

  reset(x: number, z: number): void {
    if (this.ragdoll) {
      this.ragdoll.destroy();
      this.ragdoll = null;
    }
    this.mode = 'riding';
    this.object.quaternion.identity();
    this.stance.quaternion.identity();
    // Put the skis back under the feet (the ragdoll may have moved them)
    this.skiModels.forEach((ski, i) => {
      ski.position.set(i === 0 ? -STANCE : STANCE, 0.015, 0);
      ski.quaternion.identity();
    });
    Object.assign(this.current, RIDING);
    this.velocity.set(0, 0, 0);
    this.heading = 0;
    this.grounded = true;
    this.charge = 0;
    this.lean = 0;
    this.pitch = 0;
    this.spinMomentum = 0;
    this.windup = 0;
    this.turnRate = 0;
    this.switchStance = false;
    this.flipVel = 0;
    this.flipMomentum = 0;
    this.weight = 0;
    this.airL.set(0, 0, 0);
    this.airOmega.set(0, 0, 0);
    this.body.rotation.set(0, 0, 0);
    this.object.position.set(x, heightAt(x, z), z);
    this.secondary.reset();
    this.prevVelocity.set(0, 0, 0);
    this.prevHeading = 0;
    this.prevGrounded = true;
    this.updatePose(1);
    this.person.pose(this.current);
    this.updateMass(false);
  }

  /**
   * Recompute the centre of mass and pitch inertia from the current pose,
   * and move the flip pivot there. In the air the COM follows a ballistic
   * path no matter how the body moves, so changing shape moves the feet
   * around the COM rather than the COM itself.
   */
  private updateMass(inAir: boolean): void {
    this.person.massProperties(SKIS_IN_STANCE, SKI_MASS, SKI_LENGTH, this.mass);
    if (inAir) {
      // The body group sits at the COM and doesn't move with shape changes
      // (the COM is ballistic); the rig hangs off it so the COM stays put and
      // the feet move around it instead
      this.rig.position.copy(this.mass.com).negate();
      return;
    }
    // massProperties is in the stance frame; the pivot lives in the rig frame
    const com = tmpCom.copy(this.mass.com).applyQuaternion(this.stance.quaternion);
    this.body.position.copy(com);
    this.rig.position.copy(com).negate();
  }

  /**
   * Direction of travel along the snow: where the ski tips point, or the
   * tails when riding switch.
   */
  private rideDir(n: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    this.surfaceDir(n, out);
    return this.switchStance ? out.negate() : out;
  }

  /** Facing direction laid onto the snow surface with normal n. */
  private surfaceDir(n: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    this.forward(out);
    return out.addScaledVector(n, -out.dot(n)).normalize();
  }

  /** Call after physics.step() each frame. */
  update(dt: number, input: Controls): void {
    if (this.mode === 'tumbling') {
      this.updateTumble(dt);
      return;
    }

    const wasGrounded = this.grounded;
    this.hitWall = false;
    this.centre(this.prevCentre); // for the swept collision check below
    if (this.grounded) this.updateGround(dt, input);
    else this.updateAir(dt, input);
    if (wasGrounded && !this.grounded) {
      // Just took off: start counting tricks for this jump
      this.airSpin = 0;
      this.pitch = 0;
      this.airTime = 0;
      this.windup = 0; // released into the spin
      this.takeoffSwitch = this.switchStance;
      this.enterAir();
    }

    // Keep within the mountain
    const p = this.object.position;
    const cx = courseX(p.z); // the course bends: stay between its berms
    p.x = THREE.MathUtils.clamp(p.x, cx - EDGE, cx + EDGE);
    if (p.z > MAX_Z) {
      p.z = MAX_Z;
      if (this.grounded) p.y = heightAt(p.x, p.z);
    }

    this.updatePose(dt, input);
    this.object.updateMatrixWorld(true);

    // Collisions, now that the model is posed for this frame
    const contact = this.bodyContact(this.prevCentre);
    if (contact !== null) {
      // Back up to the last clear point on this frame's path, so the ragdoll
      // starts touching the snow rather than buried in it (Rapier would fling
      // the torso out and tear the limbs off their joints)
      const back = tmpBack.copy(this.centre(tmpCentre)).sub(this.prevCentre);
      p.addScaledVector(back, contact - 1);
      this.object.updateMatrixWorld(true);
    }
    if (this.hitWall || contact !== null) {
      this.crash(this.hitWall ? 'hit a wall' : this.grounded ? 'body hit snow (riding)' : 'body hit snow (air)');
      return;
    }
    if (!this.grounded) {
      this.airTime += dt;
      const feet = this.stance.getWorldPosition(tmpFeetW);
      const skisDown = this.airTime > SKI_GRACE && this.velocity.y < 0 && this.skisHitSnow();
      // The feet only mean "feet on the snow" when roughly upright; upside
      // down it's the body or skis that touch, caught above
      const upright = tmpUp.set(0, 1, 0).applyQuaternion(this.airQ).y > 0.5;
      if ((upright && feet.y <= heightAt(feet.x, feet.z)) || skisDown) {
        this.land();
      }
    }
  }

  /**
   * Is the body (not the skis) touching the slope or a kicker? Checked along
   * the whole path since last frame: at speed the body moves further per
   * frame than the capsule is thick, and could step right through the snow.
   */
  private bodyHitsSnow(from?: THREE.Vector3): boolean {
    return this.bodyContact(from) !== null;
  }

  /**
   * Like bodyHitsSnow, but says how far along this frame's path the body
   * was still clear: 0 = at last frame's position, 1 = here. null = no hit.
   */
  private bodyContact(from?: THREE.Vector3): number | null {
    const parts: [THREE.Object3D, RAPIER.Shape][] = [
      ...this.person.spine.map((s): [THREE.Object3D, RAPIER.Shape] => [
        s.mesh,
        new RAPIER.Capsule(s.length / 2, s.radius),
      ]),
      [this.person.head, new RAPIER.Ball(BODY.headRadius)],
    ];
    // Each part moved by the same amount as the centre of mass since last
    // frame (ignoring rotation), so sweep each back along that path
    const moved = from ? tmpOffset.copy(this.centre(tmpCentre)).sub(from) : tmpOffset.set(0, 0, 0);
    let clear: number | null = null;
    for (const [obj, shape] of parts) {
      const end = obj.getWorldPosition(tmpPos);
      const rot = obj.getWorldQuaternion(tmpRot);
      const start = tmpStart.copy(end).sub(moved);
      const steps = Math.max(1, Math.ceil(moved.length() / SWEEP_STEP));
      for (let i = 1; i <= steps; i++) {
        const pos = tmpSweep.lerpVectors(start, end, i / steps);
        if (this.physics.shapeHits(shape, pos, rot)) {
          const f = (i - 1) / steps;
          clear = clear === null ? f : Math.min(clear, f);
          break;
        }
      }
    }
    return clear;
  }

  /** Are the skis touching the slope or a kicker? */
  private skisHitSnow(): boolean {
    const pos = this.debugSkis.getWorldPosition(tmpPos);
    const rot = this.skis.getWorldQuaternion(tmpRot);
    return this.physics.shapeHits(new RAPIER.Cuboid(SKI_HALF.x, SKI_HALF.y, SKI_HALF.z), pos, rot);
  }

  /**
   * Fall: hand the skier over to Rapier as a ragdoll built from the current
   * pose, carrying the current speed and spin, and let it tumble.
   */
  private crash(reason: string): void {
    this.crashReason = reason;
    const com = this.body.getWorldPosition(new THREE.Vector3());
    // Carry over the air rotation (none on the ground)
    const angvel = this.grounded ? new THREE.Vector3() : this.airOmega.clone();

    this.object.updateMatrixWorld(true);
    this.liftClear();
    this.ragdoll = new Ragdoll(
      this.physics,
      this.person,
      this.stance,
      this.skiModels,
      this.velocity,
      angvel,
      com,
    );
    this.mode = 'tumbling';
    this.tumbleTime = 0;
    this.stillTime = 0;
    this.charge = 0;
    this.pitch = 0;
    this.flipVel = 0;
    this.lean = 0;

    // From here the ragdoll places every part in world space. Straighten the
    // model's own transforms so the rig frame is world-aligned, sitting at
    // the torso; sync() then writes positions relative to it.
    this.object.quaternion.identity();
    this.body.rotation.set(0, 0, 0);
    this.stance.quaternion.identity();
    this.syncRagdoll();

    this.onLand?.('Crash!', false);
  }

  /**
   * Before handing over to the ragdoll, lift the skier until neither body
   * nor skis overlap the snow (skis arriving tilted against the slope can
   * end up half buried). Rapier would otherwise blast the parts apart.
   */
  private liftClear(): void {
    const step = 0.05;
    for (let i = 0; i < 30 && (this.bodyHitsSnow() || this.skisHitSnow()); i++) {
      this.object.position.y += step;
      this.object.updateMatrixWorld(true);
    }
  }

  /** Follow the ragdoll: the model sits at the torso, parts placed around it. */
  private syncRagdoll(): void {
    const ragdoll = this.ragdoll!;
    const torso = ragdoll.torsoPosition(tmpPos);
    // object -> body (+COM) -> rig (-COM): the rig's origin is object.position
    this.object.position.copy(torso);
    ragdoll.sync(torso);
    this.velocity.copy(ragdoll.torsoMotion().velocity);
  }

  private updateTumble(dt: number): void {
    const ragdoll = this.ragdoll!;
    ragdoll.update(dt);
    this.syncRagdoll();
    this.tumbleTime += dt;

    // "Settled" means the torso is no longer tumbling over, not stopped: on a
    // steep slope a fallen skier can slide a long way, so we let them recover
    // mid-slide
    const { spin } = ragdoll.torsoMotion();
    this.stillTime = spin < SETTLED_SPIN ? this.stillTime + dt : 0;

    const settled = this.tumbleTime > GET_UP_MIN && this.stillTime > GET_UP_SETTLED;
    if (settled || this.tumbleTime > GET_UP_MAX) this.getUp();
  }

  /**
   * Stand back up and ride on, keeping the slide's speed and direction (or
   * facing downhill if barely moving). If the spot is inside something, say
   * against a kicker, shuffle sideways until clear.
   */
  private getUp(): void {
    const slide = tmpSlide.copy(this.velocity);
    const sliding = Math.hypot(slide.x, slide.z) > 2;
    const heading = sliding ? Math.atan2(-slide.x, -slide.z) : 0;

    const p = this.centre(tmpPos);
    const cx = courseX(p.z);
    const x0 = THREE.MathUtils.clamp(p.x, cx - EDGE, cx + EDGE);
    const z = Math.min(p.z, MAX_Z);
    for (const dx of [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 2, -2, 3, -3, 4, -4, 6, -6, 8, -8]) {
      this.reset(THREE.MathUtils.clamp(x0 + dx, cx - EDGE, cx + EDGE), z);
      this.heading = heading;
      this.updatePose(1);
      this.object.updateMatrixWorld(true);
      if (!this.bodyHitsSnow()) break;
    }
    if (sliding) {
      // Carry on at the slide's speed, along the skis on the slope
      const q = this.object.position;
      const dir = this.rideDir(normalAt(q.x, q.z, tmpN), tmpDir);
      this.velocity.copy(dir).multiplyScalar(Math.max(0, slide.dot(dir)));
    }
  }

  /**
   * On the snow. Gravity pulls along the direction the skis point, so pointing
   * straight down the hill is fastest and pointing across it bleeds speed.
   */
  private updateGround(dt: number, input: Controls): void {
    const p = this.object.position;
    let speed = this.velocity.length();

    // Steering: tighter when slow, wider at speed
    // While loading a jump (Space held), A/D wind up for a spin instead of
    // steering, and W/S shift weight instead of tucking and braking
    const loading = input.jump;
    this.turnRate = loading ? 0 : input.steer * (TURN_RATE / (1 + speed / 25));
    this.heading += this.turnRate * dt;

    // The slope we're on: read a little behind us. A reading centred here
    // would straddle a sharp lip and blend the ramp with the table, sending
    // us off at half the lip's angle.
    const back = speed > 0.5 ? 0.3 / speed : 0;
    const n = normalAt(p.x - this.velocity.x * back, p.z - this.velocity.z * back, tmpN);
    // Wall-like readings (beside a steep feature) are nonsense for riding on:
    // treat as flat; the wall check below stops us.
    if (n.y < MAX_SLOPE_NY) n.copy(UP);
    const dir = this.rideDir(n, tmpDir);

    const weightTarget = loading ? (input.brake ? 1 : 0) - (input.tuck ? 1 : 0) : 0;
    this.weight += (weightTarget - this.weight) * (1 - Math.exp(-WEIGHT_SHIFT_RATE * dt));
    const windupTarget = loading ? input.steer : 0;
    this.windup += (windupTarget - this.windup) * (1 - Math.exp(-WEIGHT_SHIFT_RATE * dt));

    const drag = input.tuck && !loading ? TUCK_DRAG : AIR_DRAG;
    let accel =
      -GRAVITY * dir.y - // the downhill part of gravity along the skis
      SNOW_FRICTION * GRAVITY * n.y -
      drag * speed * speed;
    if (input.brake && !loading) accel -= BRAKE_DECEL;
    // Turning scrubs off some speed, like skidding the skis round
    accel -= TURN_SCRUB * Math.abs(input.steer) * speed;
    speed = Math.max(0, speed + accel * dt);
    this.velocity.copy(dir).multiplyScalar(speed);

    // Jump: charge while space is held, pop on release
    if (input.jump) this.charge = Math.min(1, this.charge + dt / CHARGE_TIME);
    if (this.wasJumpHeld && !input.jump) {
      const pop = POP_MIN + (POP_MAX - POP_MIN) * this.charge;
      // The legs push along the stance (perpendicular to the skis as a whole),
      // which is the footprint-averaged slope, not the point under the boots
      const push = this.footprintNormal(p.x, p.z, tmpPush);
      this.velocity.addScaledVector(push, pop);
      this.poppedThisFrame = true;
      // The push goes through the feet. If the centre of mass isn't straight
      // above them, that push also starts the body rotating: angular impulse
      // = r × J, with r from the COM to the feet and J the push (mass × pop).
      // Weight back -> backflip rotation, weight forward -> frontflip.
      const feet = this.stance.localToWorld(
        tmpFeet.addVectors(this.person.joints.ankles[0], this.person.joints.ankles[1]).multiplyScalar(0.5),
      );
      const com = this.stance.localToWorld(tmpCentre.copy(this.intendedCom));
      const r = feet.sub(com);
      const impulse = tmpImpulse.copy(push).multiplyScalar(this.mass.mass * pop);
      const side = tmpSideAxis.set(1, 0, 0).applyAxisAngle(UP, this.heading);
      this.flipMomentum = tmpTorque.crossVectors(r, impulse).dot(side);
      // Spin: keep turning as fast as we were carving, plus the wind-up
      this.spinMomentum = this.mass.yawInertia * this.turnRate + this.windup * WIND_MOMENTUM;
      this.charge = 0;
      this.grounded = false;
      this.wasJumpHeld = false;
      p.addScaledVector(this.velocity, dt);
      return;
    }
    this.wasJumpHeld = input.jump;

    // Where would we be if the snow weren't there? If the ground drops away
    // faster than that (a crest at speed, or a kicker lip), we're airborne.
    const pred = tmpPred.copy(p).addScaledVector(this.velocity, dt).addScaledVector(g, 0.5 * dt * dt);
    const h = heightAt(pred.x, pred.z);

    if (h - pred.y > WALL) {
      // Ran into something steep (the side of a kicker): fall if fast,
      // otherwise just stop against it
      if (speed > WALL_CRASH_SPEED) this.hitWall = true;
      else this.velocity.multiplyScalar(0);
      return;
    }
    if (pred.y > h + 0.02) {
      this.grounded = false;
      // Rolled off a lip or crest: no push, so no flip; the body keeps
      // turning at whatever rate it was carving
      this.flipMomentum = 0;
      this.spinMomentum = this.mass.yawInertia * this.turnRate;
      this.velocity.addScaledVector(g, dt);
      p.copy(pred);
      return;
    }
    p.set(pred.x, h, pred.z);
  }

  /** Direction of travel on the horizontal plane, as a heading angle. */
  travelHeading(): number {
    const { x, z } = this.velocity;
    // Barely moving sideways: travel direction is meaningless, use facing
    if (x * x + z * z < 1) return this.switchStance ? this.heading + Math.PI : this.heading;
    return Math.atan2(-x, -z); // inverse of forward(): (-sin h, 0, -cos h)
  }

  /**
   * In the air: ballistic flight. Nothing can push on the body, so spin and
   * flip momentum stay as they were at takeoff; only the body's shape (S
   * tuck, W open) changes how fast it turns, and W also windmills the arms
   * to line up with the landing.
   */
  private updateAir(dt: number, input: Controls): void {
    const p = this.object.position;

    // Free rigid body: angular velocity from the conserved momentum and the
    // current pose's inertia about the body's own axes (x side-to-side,
    // y head-to-feet, z front-to-back)
    const q = this.airQ;
    const headingBefore = this.heading;
    const lb = tmpLb.copy(this.airL).applyQuaternion(tmpQInv.copy(q).invert());
    const wb = tmpWb.set(lb.x / this.mass.pitchInertia, lb.y / this.mass.yawInertia, lb.z / this.mass.rollInertia);
    const w = this.airOmega.copy(wb).applyQuaternion(q);
    rotateBy(q, w, dt);
    this.flipVel = w.dot(this.flipAxis); // flipping about the takeoff side axis
    this.pitch += this.flipVel * dt;

    // Spotting the landing: windmilling arms turn the body without changing
    // its momentum. Hands off (and not flipping) it happens gently by itself.
    const handsOff = !input.tuck && !input.brake && input.steer === 0;
    if (handsOff && Math.abs(this.flipVel) < AUTO_SPOT_MAX_FLIP) this.spot(dt, AUTO_SPOT_RATE, false);
    if (input.tuck) this.spot(dt, WINDMILL_RATE, true);
    // Count spin as the change in facing with the flip taken out. (Momentum
    // about the body's own long axis isn't a spin count: in a cork it
    // reverses whenever the body is upside down.)
    this.heading = this.headingFromAir();
    this.airSpin += wrapAngle(this.heading - headingBefore);

    const drag = AIR_DRAG;
    this.velocity.addScaledVector(g, dt);
    this.velocity.multiplyScalar(1 - drag * this.velocity.length() * dt);
    const prevX = p.x;
    const prevZ = p.z;
    p.addScaledVector(this.velocity, dt);

    // Flew into the side of a kicker: we'd be deep inside it, far more than
    // one frame of falling explains. Bounce off instead of popping up on top.
    // (Only meaningful while roughly upright: inverted, the feet point is
    // nowhere near the snow and the body checks handle contact.)
    const feet = this.feetInAir(tmpFeetW);
    const sink = heightAt(feet.x, feet.z) - feet.y;
    const upright = tmpUp.set(0, 1, 0).applyQuaternion(q).y > 0.5;
    if (upright && sink > WALL + Math.abs(this.velocity.y) * dt) {
      p.x = prevX;
      p.z = prevZ;
      this.velocity.x = 0;
      this.velocity.z = 0;
    }

    // Charge can't build in the air, and releasing up here does nothing
    if (!input.jump) this.charge = 0;
    this.wasJumpHeld = input.jump;
    // Touchdown is decided in update(), after the collision checks
  }

  /**
   * Switch to the air representation at takeoff. On the ground the model is
   * object (feet, turned to the heading) -> body (COM) -> rig -> stance
   * (tilted to the slope). In the air the object stays unrotated and the
   * body, sitting at the COM, carries the whole orientation, so every
   * rotation pivots about the centre of mass.
   */
  private enterAir(): void {
    this.object.updateMatrixWorld(true);
    const q = this.stance.getWorldQuaternion(tmpRot);
    const com = this.body.getWorldPosition(tmpCentre);
    this.airQ.copy(q);
    this.object.quaternion.identity();
    this.stance.quaternion.identity();
    this.body.quaternion.copy(q);
    this.body.position.copy(com).sub(this.object.position);
    this.rig.position.copy(this.mass.com).negate();

    // Angular momentum: spin about the body's long axis, flip about the
    // (horizontal) side axis
    const up = tmpUp.set(0, 1, 0).applyQuaternion(q);
    this.flipAxis.set(1, 0, 0).applyAxisAngle(UP, this.heading);
    this.airL.copy(up).multiplyScalar(this.spinMomentum).addScaledVector(this.flipAxis, this.flipMomentum);
    this.airOmega.set(0, 0, 0);
  }

  /** Where the feet (the stance origin) are while in the air. */
  private feetInAir(out: THREE.Vector3): THREE.Vector3 {
    // feet = COM - (COM offset within the stance, turned by the orientation)
    return out
      .copy(this.mass.com)
      .applyQuaternion(this.airQ)
      .negate()
      .add(this.body.position)
      .add(this.object.position);
  }

  /**
   * Facing direction in the air, as a heading: the body's forward with the
   * flip taken out, so it doesn't jump by 180° when upside down mid-flip.
   */
  private headingFromAir(): number {
    const unflipped = tmpQ2.setFromAxisAngle(this.flipAxis, -this.pitch).multiply(this.airQ);
    const f = tmpFwdAir.set(0, 0, -1).applyQuaternion(unflipped);
    if (f.x * f.x + f.z * f.z < 1e-4) return this.heading;
    return Math.atan2(-f.x, -f.z);
  }

  /**
   * Spot the landing by windmilling the arms: turn the body (not its
   * momentum) at up to `rate` rad/s so its up direction matches the slope
   * below, and if `alignYaw`, so it faces the way it's travelling (forwards
   * or switch, whichever is nearer).
   */
  private spot(dt: number, rate: number, alignYaw: boolean): void {
    const q = this.airQ;
    const feet = this.feetInAir(tmpFeetW);
    const n = this.footprintNormal(feet.x, feet.z, tmpN);
    const up = tmpUp.set(0, 1, 0).applyQuaternion(q);
    const axis = tmpAxis.crossVectors(up, n);
    const sin = axis.length();
    const angle = Math.atan2(sin, up.dot(n));
    if (sin > 1e-6) {
      const turn = Math.min(angle, rate * dt);
      axis.divideScalar(sin);
      q.premultiply(tmpQ2.setFromAxisAngle(axis, turn));
      this.pitch += turn * axis.dot(this.flipAxis); // counts towards the flip
    }
    if (alignYaw) {
      this.heading = this.headingFromAir();
      const off = wrapAngle(2 * (this.travelHeading() - this.heading)) / 2;
      const turn = THREE.MathUtils.clamp(off, -rate * dt, rate * dt);
      q.premultiply(tmpQ2.setFromAxisAngle(tmpUp.set(0, 1, 0).applyQuaternion(q), turn));
    }
    q.normalize();
  }

  /**
   * Skis touched down. Close enough to upright and to the direction of travel
   * counts as clean: we straighten you out and you keep your speed.
   * Otherwise you fall.
   */
  private land(): void {
    const p = this.object.position;
    const feet = this.stance.getWorldPosition(tmpFeetW);
    this.heading = this.headingFromAir();
    const travel = this.travelHeading();
    // Facing the way we're going, or the opposite way (landing switch)
    const d = Math.abs(wrapAngle(this.heading - travel));
    const landSwitch = d > Math.PI / 2;
    const facingOff = landSwitch ? Math.PI - d : d;
    const pitch = this.pitch;
    // How far the body's up direction is from the landing slope's normal:
    // what matters is matching the slope, however you got there
    const bodyUp = tmpUp.set(0, 1, 0).applyQuaternion(this.stance.getWorldQuaternion(tmpRot));
    const flipOff = bodyUp.angleTo(this.footprintNormal(feet.x, feet.z, tmpN));
    if (facingOff >= CLEAN_SPIN || flipOff >= CLEAN_FLIP) {
      this.crash(`bad landing: facing off ${facingOff.toFixed(2)}, flip off ${flipOff.toFixed(2)}`);
      return;
    }

    // Clean: back to the ground representation (object at the feet, turned
    // to the heading), feet settled onto the snow, and ride on
    p.set(feet.x, heightAt(feet.x, feet.z), feet.z);
    this.object.quaternion.identity();
    this.body.quaternion.identity();
    this.airL.set(0, 0, 0);
    this.airOmega.set(0, 0, 0);
    this.switchStance = landSwitch;
    this.heading = landSwitch ? travel + Math.PI : travel;
    this.pitch = 0;
    this.spinMomentum = 0;
    this.flipVel = 0;
    this.flipMomentum = 0;

    const n = normalAt(p.x, p.z, tmpN);
    const dir = this.rideDir(n, tmpDir);
    const along = Math.max(0, this.velocity.dot(dir));
    this.velocity.copy(dir).multiplyScalar(along);
    this.grounded = true;

    const trick = trickName(this.airSpin, pitch, this.takeoffSwitch);
    if (trick) this.onLand?.(trick, true);
  }

  /**
   * The slope the skis are standing on: normals averaged over the ski
   * footprint (tips, tails, both edges), so 1.6 m skis bridge small bumps.
   * Wall-like readings (beside a kicker's vertical side) are ignored.
   */
  private footprintNormal(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const f = this.forward(tmpFwd);
    const sx = -f.z; // side vector: forward turned 90°
    const sz = f.x;
    out.set(0, 0, 0);
    for (const [along, across] of FOOTPRINT) {
      const n = normalAt(x + f.x * along + sx * across, z + f.z * along + sz * across, tmpFootN);
      if (n.y >= MAX_SLOPE_NY) out.add(n);
    }
    return out.lengthSq() > 0 ? out.normalize() : out.copy(UP);
  }

  /**
   * Drive the springy layer from what the body feels this frame: its change
   * in velocity minus gravity (and minus the snow's steady support when on
   * the ground), in the stance's own frame. Also: how far the skis turned,
   * which the upper body resists, and where the upper body wants to face.
   */
  private updateSecondary(dt: number): void {
    const sec = this.secondary;
    const felt = tmpFelt.copy(this.velocity).sub(this.prevVelocity).addScaledVector(g, -dt);
    this.prevVelocity.copy(this.velocity);

    // Into the stance frame
    const q = this.grounded
      ? tmpStanceQ.setFromAxisAngle(UP, this.heading).multiply(this.stance.quaternion)
      : tmpStanceQ.copy(this.airQ);
    const up = tmpUp.set(0, 1, 0).applyQuaternion(q);
    felt.applyQuaternion(q.invert());
    // Riding along, the snow holds you up all the time: only changes count
    if (this.grounded) felt.y -= GRAVITY * Math.max(0, up.y) * dt;

    // Popping a jump: the legs drive the body up, they don't buckle
    if (this.poppedThisFrame) {
      felt.set(0, 0, 0);
      sec.compress.velocity += 1.2;
      this.poppedThisFrame = false;
    }

    // Skis turning under the upper body (only while riding; landing snaps
    // don't count, and in the air the body turns as one)
    const steady = this.grounded && this.prevGrounded;
    const skiTurn = steady ? wrapAngle(this.heading - this.prevHeading) : 0;
    this.prevHeading = this.heading;
    this.prevGrounded = this.grounded;

    // On the snow the upper body leans towards facing down the fall line
    // (skis across the hill, chest down it); riding switch the look takes
    // care of the upper body instead
    let yawTarget = 0;
    if (this.grounded && !this.switchStance) {
      const n = this.tiltWorld;
      if (n.x * n.x + n.z * n.z > 0.01) {
        const fallHeading = Math.atan2(-n.x, -n.z);
        yawTarget = THREE.MathUtils.clamp(wrapAngle(fallHeading - this.heading) * FALL_LINE_PULL, -MAX_COUNTER, MAX_COUNTER);
      }
    }
    sec.update(dt, felt, skiTurn, yawTarget);
  }

  /** Orient the model: facing, skis on the slope, lean and crouch. */
  private updatePose(dt: number, input?: Controls): void {
    const p = this.object.position;
    if (!this.grounded) {
      // In the air the body carries the whole orientation (see enterAir)
      this.object.quaternion.identity();
      this.body.quaternion.copy(this.airQ);
      this.stance.quaternion.identity();
    } else {
      this.object.rotation.set(0, this.heading, 0);
      this.body.quaternion.identity();
    }

    // On the snow, stand perpendicular to the slope. The normal is in world
    // space, so turn it into the skier's local frame (undo the heading)
    // first. In the air nothing can turn the body except its own rotation,
    // so the stance keeps its takeoff tilt.
    // The tilt is remembered in world space, so a spin turns the rider
    // about their own (tilted) long axis rather than the world's vertical:
    // after a 180 off a slope they still lean down the hill, not up it.
    if (this.grounded) {
      this.footprintNormal(p.x, p.z, this.tiltWorld);
      const n = tmpN.copy(this.tiltWorld).applyAxisAngle(UP, -this.heading);
      this.stance.quaternion.setFromUnitVectors(UP, n);
    }

    if (!input) return;
    // Faster in the air, so tucking and opening up respond quickly
    const ease = 1 - Math.exp(-(this.grounded ? 8 : 14) * dt);

    // Lean into the turn, more at speed; upright in the air
    // Riding switch, the body's left is the travel direction's right
    const sideSign = this.switchStance ? -1 : 1;
    const targetLean = this.grounded
      ? sideSign * input.steer * MAX_LEAN * Math.min(1, this.speed / 15)
      : 0;
    // Riding switch: look back over a shoulder to see where you're going.
    // Steering picks the side: to see the way you're turning, look over the
    // opposite shoulder (the body's right is travel's left).
    if (this.switchStance && input.steer !== 0) this.lookSide = -input.steer;
    this.lean += (targetLean - this.lean) * ease;

    // Body shape. Ground: tuck on W, sink while charging a jump, and shift
    // weight fore/aft while loading. Air: S pulls into a tuck, W opens up.
    // Eased so changes flow rather than snap.
    const t = this.target;
    if (!this.grounded) {
      // S: ball tuck (fast flips). A/D: arms hugged in, upright (fast spins).
      // W: open up (slow everything, and windmill to spot the landing).
      Object.assign(
        t,
        input.brake ? AIR_TUCK : input.tuck ? AIR_OPEN : input.steer !== 0 ? AIR_SPIN : AIR,
      );
    } else {
      Object.assign(t, input.tuck && !input.jump ? TUCK : RIDING);
      if (this.charge > 0) lerpPose(t, CROUCH, this.charge, t);
      if (this.weight > 0) lerpPose(t, LEAN_BACK, this.weight, t);
      else if (this.weight < 0) lerpPose(t, LEAN_FORWARD, -this.weight, t);
    }
    t.lean = this.lean;
    // Wind-up shows as shoulders turned back against the coming spin
    t.twist = this.grounded ? -this.windup * WINDUP_TWIST : 0;
    // Switch: shoulders open up towards the look, head turns the rest
    t.look = this.switchStance && this.grounded ? this.lookSide : 0;
    t.twist += t.look * SWITCH_TWIST;
    lerpPose(this.current, t, ease, this.current);
    this.updateSecondary(dt);
    if (this.grounded) {
      // Where the mass would be without the springy layer (for the pop)
      this.person.pose(this.current);
      this.person.massProperties(SKIS_IN_STANCE, SKI_MASS, SKI_LENGTH, tmpMass);
      this.intendedCom.copy(tmpMass.com);
    }
    this.person.pose(this.current, this.secondary);
    this.updateMass(!this.grounded);
  }
}
