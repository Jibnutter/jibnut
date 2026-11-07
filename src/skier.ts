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
import { heightAt, normalAt, courseX, EDGE_LIMIT, MAX_Z, MAP_BOUNCE, SNOW_DRAG, JUMPS, onPlacedKicker } from './terrain';
import type { Controls } from './input';
import { RAPIER, type Physics } from './physics';
import { Ragdoll } from './ragdoll';
import { SecondaryMotion } from './secondary';
import { PhysicalRide } from './physicalRide';
import { Bottoms } from './bottoms';
import { Top } from './top';
import type { Outfit } from './progress';
import { createSki, type SkiStyle } from './skiModel';
import { createBoardHalf, BOARD_STANCE, BOARD_LENGTH } from './boardModel';
import { createBikeHalf, animateBike, BB_HEIGHT, BIKE_MASS, type BikeDesign } from './bikeModel';
import { groundAt, railAt, type RailContact } from './rails';
import {
  Person,
  BODY,
  PANTS_COLOR,
  SHIRT_COLOR,
  RIDING,
  TUCK,
  CROUCH,
  AIR,
  AIR_TUCK,
  AIR_ARCH,
  AIR_OPEN,
  AIR_GRAB,
  AIR_INDY,
  AIR_SPIN,
  LEAN_BACK,
  LEAN_FORWARD,
  SHIFTY,
  lerpPose,
  type Pose,
  type MassProperties,
} from './person';

const STANCE = BODY.stance; // half the gap between the skis


const GRAVITY = 9.81;
const SNOW_FRICTION = 0.05; // ski-on-snow friction coefficient
const AIR_DRAG = 0.004; // 0.5 * air density * drag area / mass, per metre
const TUCK_DRAG = 0.002; // tucking roughly halves the frontal area
const BRAKE_DECEL = 4; // m/s^2 braking, starting to turn the skis across ...
const SKID_DECEL = 4; // ... plus this much more with them fully across (a hockey stop)
const SKID_ANGLE = THREE.MathUtils.degToRad(80); // braking turns the skis this far across the way we're going
const SKID_RATE = 9; // 1/s: how quickly they swing round
const SKID_COUNTER = 0.75; // the upper body turns back this much of it, to keep facing down the hill
const SKID_LEAN = 0.3; // rad: leaning back against the slide
const TURN_RATE = 2.2; // rad/s when slow; turning gets wider at speed
const CLEAN_SPIN = 0.6; // land within ~35° of your travel direction to stick it
const CLEAN_FLIP = 0.7; // land with the body within ~40° of the slope's normal to stick it
const TURN_SCRUB = 0.25; // fraction of speed lost per second while turning hard
const MAX_LEAN = 0.45; // radians the body leans into a turn
const MAX_BALANCE_LEAN = 0.85; // ... up to this much in fast, tight turns
const PULL_RATE = 3; // 1/s: how quickly a carve's sideways pull builds
const EDGE_PER_LEAN = 1.0; // ski edge angle per radian of lean
const EDGE = EDGE_LIMIT; // stay on the course, between the berms
const WALL = 0.4; // a step up bigger than this (m) blocks you, e.g. a kicker's side
const MAX_SLOPE_NY = 0.5; // surfaces steeper than 60° count as walls, not slopes
// Rails: steel slides far more easily than snow
const RAIL_FRICTION = 0.02;
const RAIL_CATCH_BELOW = 0.3; // m: landing this far below a rail's top still catches it
// The bike
const BIKE_POSE = { hipHeight: 0.84, hipBack: 0.26, torsoPitch: 1.05 }; // (balanced: the mass right over the pedals)
const BIKE_SKID_ANGLE = 0.7; // rad: the back wheel skids round this far
const PEDAL_ACCEL = 3; // m/s² pedalling from a standstill ...
const PEDAL_TOP_SPEED = 9; // ... fading out by this speed (m/s)
const BIKE_WHEEL_R = 0.37;
const ROLL_OFF_SPIN = 0.35; // of the carve's turn kept when rolling off an edge (no pop)
const MIN_GRIND = 0.25; // s: slides shorter than this don't get called out
// Grabs (hold Space in the air)
const MIN_GRAB = 0.25; // s held for the grab to count
const GRAB_HELD = 0.8; // the pose this far into the grab counts as holding it
const GRAB_LAND_MAX = 0.5; // land still this far into the grab (skis crossed) and you fall
const RAIL_TURN_RATE = 4.5; // rad/s: on a rail the skis swing round freely (no edges to carve)
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
const SWITCH_TWIST = 0.6;
// Snowboard: head turned to look down the board, shoulders opened a little,
// and turns made by leaning over the toe or heel edge
const BOARD_LOOK = 0.8;
const BOARD_TWIST = 0.3;
const BOARD_EDGE_PITCH = 0.9;
const BOARD_EDGE_HIPS = 0.25; // shoulders turned towards the look when riding switch
// The upper body turns partly towards the fall line, separately from the skis
const FALL_LINE_PULL = 0.6; // fraction of the way
const MAX_COUNTER = 0.75; // radians at most
// In the air the shoulders lead a spin and the hips and skis follow
const SPIN_LEAD = 0.15; // radians of lead per rad/s of spin
const MAX_SPIN_LEAD = 0.7;
const SKI_MASS = 2; // kg, matching the ragdoll's skis
const SKI_LENGTH = 1.6;
// Windmilling the arms turns the body a little without changing its angular
// momentum (the arms turn the other way). Holding W in the air does this,
// turning the body towards the slope below at up to this rate.
const WINDMILL_RATE = 1.2; // rad/s
// With no keys held and no flip going, riders instinctively spot their
// landing: the same windmilling, gentler. A rider leaving a 24° lip for a
// 32° landing needs ~56° of forward rotation from somewhere.
const AUTO_SPOT_RATE = 1.0; // rad/s
// Standing on a side slope: square to it up to this tilt (rad), then only
// this much of any more (stay nearer upright, skis on edge)
const SIDE_TILT_FULL = 0.26;
const SIDE_TILT_BEYOND = 0.35;
// Hard landings: speed into the slope above this squashes the body right
// down and then bounces it back up into a hop (for fun, not realism)
const HARD_LANDING = 8; // m/s
const SQUASH_KICK = 5; // m/s of hip drop: the legs fold fully
const BOUNCE_DELAY = 0.14; // s: bounce at the bottom of the squash
const BOUNCE_MIN = 2; // m/s of hop
const BOUNCE_PER_IMPACT = 0.5;
const BOUNCE_MAX = 6;
// Bumps: the legs soak up the snow curving upwards (m/s of hip drop per m/s
// of hit), and spring a share of a big enough bump back as a little hop
const BUMP_ABSORB = 0.6;
const BUMP_MEMORY = 0.12; // s: hits this close together are one bump
const BUMP_OVER = 0.03; // m/s: a hit this small means the bump's been passed
const BUMP_MIN = 0.3; // m/s: smaller bumps are just soaked up
const BUMP_REBOUND = 1.3;
const BUMP_MAX = 2.5; // m/s
const STRETCH_KICK = 2.5; // m/s: the legs spring out as it bounces
// Landing: skis slap onto the slope over a moment instead of snapping
const SLAP_TIME = 0.15; // s
const AIR_HANDOVER_RATE = 25; // 1/s: ragdoll held by skis <-> by its core (~0.1 s)
const SLAP_RATE = 30; // 1/s
const SQUASH_GRACE = 0.35; // s after a clean landing when chest/head touching the snow is allowed
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
// Points: each flip (back or front), each full spin (a 180 scores half),
// and holding a grab
const POINTS = { flip: 200, spin360: 100, grab: 50, shifty: 50 };

/** What a landed trick scores (rounded the same way as its name). */
function trickPoints(spin: number, pitch: number, grabbed: boolean): number {
  const halfSpins = Math.round(Math.abs(spin) / Math.PI);
  const flips = Math.abs(Math.round(pitch / (2 * Math.PI)));
  return flips * POINTS.flip + (halfSpins * POINTS.spin360) / 2 + (grabbed ? POINTS.grab : 0);
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
const tmpCom = new THREE.Vector3();
const tmpMass: MassProperties = { mass: 0, com: new THREE.Vector3(), pitchInertia: 1, yawInertia: 1, rollInertia: 1 };
// Inertias of the backflip arch and the forward ball
// tuck (computed once from the body model; see updateMass)
const TUCK_INERTIA = (() => {
  const p = new Person();
  const m: MassProperties = { mass: 0, com: new THREE.Vector3(), pitchInertia: 1, yawInertia: 1, rollInertia: 1 };
  const skis = [-STANCE, STANCE].map((x) => ({ p: new THREE.Vector3(x, 0.015, 0), d: new THREE.Vector3(0, 0, 1) }));
  const inertia = (pose: Pose) => {
    p.pose(pose);
    p.massProperties(skis, SKI_MASS, SKI_LENGTH, m);
    return { pitch: m.pitchInertia, yaw: m.yawInertia, roll: m.rollInertia };
  };
  return { back: inertia(AIR_ARCH), ball: inertia(AIR_TUCK) };
})();
// Skis sit untilted in the stance frame, alongside the person
const SKIS_IN_STANCE = [-STANCE, STANCE].map((x) => ({
  p: new THREE.Vector3(x, 0.015, 0),
  d: new THREE.Vector3(0, 0, 1),
}));
// ... or the board's two halves, one under each foot along the board
// ... or the bike: two rods along it, low between the wheels
const BIKE_IN_STANCE = [-0.05, 0.05].map((x) => ({
  p: new THREE.Vector3(x, BB_HEIGHT * 0.9, -0.15),
  d: new THREE.Vector3(0, 0, 1),
}));
const BOARD_FLOAT = 0.12; // m: a board rides on top of the powder
const BOARD_IN_STANCE = [-BOARD_STANCE, BOARD_STANCE].map((z) => ({
  p: new THREE.Vector3(0, 0.015 + BOARD_FLOAT, z),
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
const tmpBump = new THREE.Vector3();
const tmpFootN = new THREE.Vector3();
const tmpPush = new THREE.Vector3();
// Sample points (along the skis, across them) in metres from the boots
const FOOTPRINT = [[0, 0], [0.6, 0], [-0.6, 0], [0, 0.2], [0, -0.2]];
const tmpFeet = new THREE.Vector3();
const tmpImpulse = new THREE.Vector3();
const tmpSideAxis = new THREE.Vector3();
const tmpTorque = new THREE.Vector3();

export class Skier {
  /** The hidden controller rig: the posed target body and skis. */
  readonly object = new THREE.Group();
  /** What you see: the ragdoll. Add this to the scene. */
  readonly view = new THREE.Group();
  private readonly skis = new THREE.Group();
  private readonly person = new Person();
  /** The clothes, simulated as cloth over the ragdoll (see setOutfit). */
  private bottoms!: Bottoms;
  private top!: Top;
  /** Springy layer on top of the pose: suspension, lag, floppy arms. */
  private readonly secondary = new SecondaryMotion();
  private readonly prevVelocity = new THREE.Vector3();
  private prevHeading = 0;
  /** Hockey stop: the skis (and legs) turned across the way we're going (rad, + = left). */
  private skid = 0;
  private prevSkid = 0;
  /** Which way the skis swing round when braking: the way we last steered (+ = left). */
  private skidSide = 1;
  private prevGrounded = true;
  private poppedThisFrame = false;
  /** Eased 0 (on the snow) .. 1 (in the air): who holds the ragdoll. */
  private airBlend = 0;
  // Quirky bounce after a really hard landing: wait for the squash, then boing
  private bounceTimer = 0;
  private slapTime = 0; // s left of easing the skis onto the slope after landing
  /** Just after a clean landing the body may squash right down: brushing the snow then isn't a fall. */
  private squashGrace = 0;
  private bounceSpeed = 0;
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
  /** How long the grab has been held this jump (s). */
  private grabTime = 0;
  /** How long a shifty has been held this jump (s). */
  private shiftyTime = 0;
  /**
   * Crashes on (the default) or off. Off, nothing ends a run: bad landings
   * are ridden away, walls just stop you, and the body touching the snow is
   * fine.
   */
  crashes = true;
  // Bumps (see suspension)
  private readonly lastRideDir = new THREE.Vector3();
  private hasRideDir = false;
  private bumpStore = 0;
  /** A carve's sideways pull (m/s², smoothed; + = turning left), for leaning in. */
  private turnPull = 0;
  /** Space still held from a grab when we landed: it mustn't charge a jump until let go. */
  private jumpLocked = false;
  /** Sliding a rail: for how long, and how much of it with the skis across it. */
  private grindTime = 0;
  private grindAcross = 0;
  /** The last slide, called out when we land after it (0: none). */
  private lastGrind = { time: 0, across: 0 };
  private readonly railContact: RailContact = {
    top: 0,
    dir: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    point: new THREE.Vector3(),
  };
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
  private spinRate = 0; // how fast we're spinning in the air, rad/s

  /** Called when a hard landing bounces back up. */
  onBounce?: () => void;
  /** Called on landing after a trick or a crash, for the HUD to show. */
  /** After each landing: what to call out, whether it was clean, and the points it scored. */
  onLand?: (message: string, clean: boolean, points: number) => void;

  /**
   * Fully physical skiing (toggle): the skis slide on the snow by themselves
   * and the controller only reads them and poses the body. Takes effect on
   * the next reset.
   */
  physicalMode = false;
  private ride: PhysicalRide | null = null;
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
    // The posed body is only the ragdoll's target now: hide it
    this.object.visible = false;
    this.setOutfit({
      bottom: { id: '', name: '', price: 0, slot: 'bottom', kind: 'shorts', color: PANTS_COLOR },
      top: { id: '', name: '', price: 0, slot: 'top', kind: 'tee', color: SHIRT_COLOR },
    });
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
  /** First-person view: the camera sits in the head, so hide it. */
  set firstPerson(on: boolean) {
    this._firstPerson = on;
    if (this.ragdoll) this.ragdoll.headVisual.visible = !on;
  }
  get firstPerson(): boolean {
    return this._firstPerson;
  }
  private _firstPerson = false;

  /**
   * Where the rider's eyes are and which way the head faces (world), from
   * the visible ragdoll head (or the posed body before it exists).
   */
  eyes(pos: THREE.Vector3, rot: THREE.Quaternion): void {
    const head = this.ragdoll ? this.ragdoll.headVisual : this.person.head;
    head.updateMatrixWorld(true);
    head.getWorldPosition(pos);
    head.getWorldQuaternion(rot);
  }

  /**
   * How far the chest (and so the head on it) is pitched forward in the
   * current pose, radians: the first-person camera tilts back up by this so
   * a crouched rider still looks ahead rather than at their skis.
   */
  get headPitch(): number {
    return this.current.torsoPitch * 1.25;
  }

  centre(out = new THREE.Vector3()): THREE.Vector3 {
    if ((this.mode === 'tumbling' || this.ride) && this.ragdoll) return this.ragdoll.torsoPosition(out);
    return this.body.getWorldPosition(out);
  }

  /** How many skis came off in the current crash (0 when riding). */
  get skisLost(): number {
    return this.ragdoll?.skisLost ?? 0;
  }

  get speed(): number {
    return this.velocity.length();
  }

  /** Where ski i (0 left, 1 right) is, in the world: for snow effects. */
  skiWorld(i: number, out: THREE.Vector3): THREE.Vector3 {
    // (The ragdoll moves these: bring their matrices up to date first)
    this.skiModels[i].updateWorldMatrix(true, false);
    return this.skiModels[i].getWorldPosition(out);
  }

  /** Riding a snowboard (instead of skis). */
  board = false;
  /** Riding the mountain bike (instead of skis). */
  bike = false;

  /** The bike's frame design (the workshop): rebuilt at once if riding it. */
  setBikeDesign(d: BikeDesign): void {
    this.person.setBikeDesign(d);
    if (!this.bike) return;
    this.bike = false; // (so setGear builds it again)
    this.setGear('bike');
  }
  // The bike's moving parts (see animateBike)
  private wheelRoll = 0;
  private crank = 0;
  private steerShown = 0;

  /** Which skis (when not on the board). */
  private skiStyle: SkiStyle = 'classic';

  /** Ride these: skis of a style, or the snowboard. Takes effect from the next (re)start. */
  setGear(gear: SkiStyle | 'board' | 'bike'): void {
    const on = gear === 'board';
    const bike = gear === 'bike';
    if (!on && !bike) {
      if (gear === this.skiStyle && !this.board && !this.bike) return;
      this.skiStyle = gear;
    } else if ((on && this.board) || (bike && this.bike)) return;
    this.board = on;
    this.bike = bike;
    this.person.setBike(bike);
    this.person.setBoard(on);
    // A board floats on top of the powder (skis ride buried in it); a bike's
    // pedals ride a bottom bracket's height up (its wheels reach the snow)
    const lift = on ? BOARD_FLOAT : bike ? BB_HEIGHT - 0.015 : 0;
    this.person.group.position.y = lift;
    this.skis.position.y = lift;
    this.skis.remove(...this.skiModels);
    this.skiModels.splice(
      0,
      2,
      ...(on
        ? [createBoardHalf(0), createBoardHalf(1)]
        : bike
          ? [createBikeHalf(0, this.person.bikeDesign), createBikeHalf(1, this.person.bikeDesign)]
          : [createSki(-STANCE, this.skiStyle), createSki(STANCE, this.skiStyle)]),
    );
    this.skis.add(...this.skiModels);
    if (this.ragdoll) {
      this.ragdoll.destroy();
      this.ragdoll = null;
      this.ride = null;
    }
    this.placeSkis();
  }

  /** The skis (or board halves) as mass rods, for the body's mass properties. */
  private skiRods(): [{ p: THREE.Vector3; d: THREE.Vector3 }[], number, number] {
    if (this.bike) return [BIKE_IN_STANCE, BIKE_MASS / 2, 1.2];
    return this.board ? [BOARD_IN_STANCE, SKI_MASS, BOARD_LENGTH / 2] : [SKIS_IN_STANCE, SKI_MASS, SKI_LENGTH];
  }

  /**
   * Put the skis where the pose puts them (under the boots; crossed in a
   * grab), in the stance frame. (The pose is in the person's frame: turned
   * sideways on a board.) Rolled onto their edges into a turn as much as
   * the body leans (the physical skis spring towards this; flat again in
   * the air).
   */
  private placeSkis(): void {
    const g = this.person.group.quaternion;
    this.skiModels.forEach((ski, i) => {
      const pose = this.person.skiPoses[i];
      ski.position.copy(pose.p).applyQuaternion(g);
      ski.quaternion.copy(g).multiply(pose.q);
      if (this.grounded) ski.rotateZ(this.lean * EDGE_PER_LEAN);
    });
  }

  /**
   * The bike's moving parts: wheels rolling with the speed (spinning on in
   * the air), the front end steering into turns, the suspension squashing
   * with the legs, the cranks turning while pedalling. On the posed bike and
   * on the ragdoll's visible copy.
   */
  private animateBike(dt: number, input: Controls): void {
    this.wheelRoll += (this.speed / BIKE_WHEEL_R) * dt;
    if (input.tuck && this.grounded) this.crank += 7 * dt;
    const steerTo = this.grounded ? THREE.MathUtils.clamp(this.turnRate * 0.18, -0.35, 0.35) : 0;
    this.steerShown += (steerTo - this.steerShown) * (1 - Math.exp(-10 * dt));
    // The legs' squash (secondary compress goes negative as they fold) is the suspension's
    const squash = THREE.MathUtils.clamp(-this.secondary.compress.value / 0.22, 0, 1);
    const halves: THREE.Object3D[] = [this.skiModels[0]];
    if (this.ragdoll) halves.push(this.ragdoll.visualOf(this.skiModels[0]));
    for (const h of halves) animateBike(h, this.wheelRoll, this.steerShown, squash, this.crank);
  }

  /** Put on these clothes (they snap onto the body). */
  setOutfit(o: Pick<Outfit, 'bottom' | 'top'>): void {
    for (const old of [this.bottoms, this.top]) {
      if (!old) continue;
      old.mesh.removeFromParent();
      old.mesh.geometry.dispose();
      (old.mesh.material as THREE.Material).dispose();
    }
    this.bottoms = new Bottoms(this.person, o.bottom.kind === 'pants' ? 'pants' : 'shorts', o.bottom.color);
    this.top = new Top(this.person, o.top.kind === 'jacket' ? 'jacket' : 'tee', o.top.color);
    this.view.add(this.bottoms.mesh, this.top.mesh);
    this.person.dress(o.bottom, o.top);
    if (this.ragdoll) {
      this.bottoms.bind(this.ragdoll);
      this.top.bind(this.ragdoll);
    }
  }

  /** How far the skis are turned across the way we're going (hockey stop; rad, + = left). */
  get skidAngle(): number {
    return this.grounded ? this.skid : 0;
  }

  /** How fast we're turning on the snow (rad/s, + = left). */
  get turning(): number {
    return this.grounded ? this.turnRate : 0;
  }

  /** Unit vector the skier is facing, on the horizontal plane. */
  forward(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(-Math.sin(this.heading), 0, -Math.cos(this.heading));
  }

  reset(x: number, z: number): void {
    this.bumpStore = 0;
    this.hasRideDir = false;
    this.grabTime = 0;
    this.shiftyTime = 0;
    this.jumpLocked = false;
    this.skid = 0;
    this.prevSkid = 0;
    this.grindTime = 0;
    this.lastGrind = { time: 0, across: 0 };
    if (this.ragdoll) {
      // A fresh ragdoll is built in the new pose on the next update
      this.ragdoll.destroy();
      this.ragdoll = null;
      this.ride = null;
    }
    this.bounceTimer = 0;
    this.mode = 'riding';
    this.object.quaternion.identity();
    this.stance.quaternion.identity();
    Object.assign(this.current, RIDING);
    // Put the skis back under the feet (the ragdoll may have moved them)
    this.lean = 0;
    this.person.pose(RIDING);
    this.placeSkis();
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
    this.airBlend = 0;
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
    this.person.massProperties(...this.skiRods(), this.mass);
    if (inAir && this.current.torsoPitch < 0) {
      // Arching back in a backflip: flip as fast as the forward ball tuck
      // would (the arch is the look; physically it's far less compact and
      // doubles became impossible). Blended in by how far the body has
      // leaned back into the arch.
      // All three axes, so the body's inertias stay in the ball's proportions
      // (scaling only the flip axis made it the middle one of the three,
      // which tumbles: the "tennis racket" effect twisted backflips)
      const { back, ball } = TUCK_INERTIA;
      const progress = THREE.MathUtils.clamp(this.current.torsoPitch / AIR_ARCH.torsoPitch, 0, 1);
      this.mass.pitchInertia *= Math.pow(ball.pitch / back.pitch, progress);
      this.mass.yawInertia *= Math.pow(ball.yaw / back.yaw, progress);
      this.mass.rollInertia *= Math.pow(ball.roll / back.roll, progress);
    }
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

  /**
   * Legs as suspension. Following the snow, the rider is turned upwards
   * wherever it curves up (into a bump, a dip's far side): that's a hit,
   * speed into the slope. The legs soak it up (the body sinks), and once
   * it's over, a share of it springs back as a little hop off the bump.
   * (Not on jump ramps: their takeoffs stay as tuned. Not on rails.)
   */
  private suspension(dt: number, dir: THREE.Vector3, n: THREE.Vector3, grinding: boolean): void {
    const p = this.object.position;
    const onJump = JUMPS.some((j) => p.z <= j.startZ + 2 && p.z >= j.knuckleZ - 2) || onPlacedKicker(p.x, p.z);
    let hit = 0;
    if (this.hasRideDir && !grinding && !onJump) {
      hit = this.speed * Math.max(0, tmpBump.subVectors(dir, this.lastRideDir).dot(n));
    }
    this.lastRideDir.copy(dir);
    this.hasRideDir = true;
    if (hit > 0) this.secondary.compress.velocity -= hit * BUMP_ABSORB;
    // The hits of the last moment add up: one bump's worth
    this.bumpStore = this.bumpStore * Math.exp(-dt / BUMP_MEMORY) + hit;
    // (No hop while a landing is still settling: it stacked onto the
    // landing's own squash and bounce, into a second, crooked landing)
    const settling = this.slapTime > 0 || this.bounceTimer > 0 || this.squashGrace > 0;
    if (settling) this.bumpStore = 0;
    if (hit < BUMP_OVER && this.bumpStore > BUMP_MIN) {
      const hop = Math.min(BUMP_MAX, (this.bumpStore - BUMP_MIN) * BUMP_REBOUND);
      this.velocity.addScaledVector(n, hop);
      this.secondary.compress.velocity += hop * 0.8; // legs extending into it
      this.bumpStore = 0;
    }
  }

  /** Along a rail, the way we're already sliding (downhill if barely moving). */
  private railDir(rail: RailContact, out: THREE.Vector3): THREE.Vector3 {
    out.copy(rail.dir);
    return this.velocity.dot(out) < -0.5 ? out.negate() : out;
  }

  /** Facing direction laid onto the snow surface with normal n. */
  private surfaceDir(n: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    this.forward(out);
    return out.addScaledVector(n, -out.dot(n)).normalize();
  }

  /**
   * Once per frame: run the ski controller, pose the (hidden) target body,
   * drive the ragdoll towards it and step the physics world.
   */
  update(dt: number, input: Controls): void {
    if (!this.ragdoll) this.buildRagdoll();
    if (this.mode === 'riding' && this.ride) {
      this.updatePhysical(dt, input);
      return;
    }
    if (this.mode === 'tumbling') {
      this.physics.step(dt);
      this.updateTumble(dt);
      return;
    }

    const wasGrounded = this.grounded;
    this.hitWall = false;
    // Landed still holding Space (from a grab): it isn't a jump charge
    if (this.jumpLocked) {
      if (!input.jump) this.jumpLocked = false;
      else if (this.grounded) input = { ...input, jump: false };
    }
    if (!this.grounded) this.hasRideDir = false; // (a fresh start after landing)
    if (this.grounded) this.updateGround(dt, input);
    else this.updateAir(dt, input);
    if (wasGrounded && !this.grounded) {
      // Just took off (maybe off a rail: remember the slide for the callout)
      if (this.grindTime > 0) {
        this.lastGrind = { time: this.grindTime, across: this.grindAcross };
        this.grindTime = 0;
      }
      // Start counting tricks for this jump
      this.grabTime = 0;
    this.shiftyTime = 0;
      this.shiftyTime = 0;
      this.airSpin = 0;
      this.pitch = 0;
      this.airTime = 0;
      this.windup = 0; // released into the spin
      this.takeoffSwitch = this.switchStance;
      this.skid = 0; // (skis back in line: the air works with one heading)
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

    if (this.hitWall) {
      if (this.crashes) this.crash('hit a wall');
      else this.velocity.set(0, 0, 0); // (crashes off: just stop against it)
    } else if (!this.grounded) {
      this.airTime += dt;
      if (this.current.grab >= GRAB_HELD) this.grabTime += dt;
      if (Math.abs(this.current.shifty) >= GRAB_HELD) this.shiftyTime += dt;
      const feet = this.stance.getWorldPosition(tmpFeetW);
      const skisDown = this.airTime > SKI_GRACE && this.velocity.y < 0 && this.skisHitSnow();
      // The feet only mean "feet on the snow" when roughly upright; upside
      // down it's the body or skis that touch, caught above
      const upright = tmpUp.set(0, 1, 0).applyQuaternion(this.airQ).y > 0.5;
      if ((upright && feet.y <= groundAt(feet.x, feet.z)) || skisDown) {
        this.land();
        if (this.grounded && input.jump) {
          this.jumpLocked = true;
          this.wasJumpHeld = false;
          this.charge = 0;
        }
      }
    }

    // The visible body: pull it towards this frame's pose, carry it on the
    // skis (on the snow) or by its core (in the air, so it turns about its
    // centre of mass), and let physics do the rest
    const ragdoll = this.ragdoll!;
    this.airBlend += ((this.grounded ? 0 : 1) - this.airBlend) * (1 - Math.exp(-AIR_HANDOVER_RATE * dt));
    ragdoll.airBlend = this.airBlend;
    ragdoll.grab = this.grounded ? 0 : this.current.grab;
    ragdoll.drive();
    this.physics.step(dt, (alpha) => ragdoll.beforeSubstep(alpha));
    ragdoll.sync();
    this.bottoms.update(dt);
    this.top.update(dt);
    // A fall is the real body's chest or head touching the snow (the pelvis
    // may touch down in a deep landing squat: that's fine)
    this.squashGrace = Math.max(0, this.squashGrace - dt);
    if (this.mode === 'riding' && this.squashGrace === 0 && ragdoll.chestOrHeadDown()) {
      if (this.crashes) this.crash(this.grounded ? 'chest or head hit the snow (riding)' : 'chest or head hit the snow (air)');
      // Crashes off, coming down head or back first: that's the landing
      else if (!this.grounded) this.land();
    }
  }

  /**
   * Stand still, posed (for the locker): no riding, but the visible body
   * and its clothes are simulated, so they hang and sway as in the game.
   */
  preview(dt: number): void {
    if (!this.ragdoll) this.buildRagdoll();
    this.velocity.set(0, 0, 0);
    this.updatePose(dt, { steer: 0, tuck: false, brake: false, jump: false });
    this.object.updateMatrixWorld(true);
    const ragdoll = this.ragdoll!;
    ragdoll.airBlend = 0;
    ragdoll.grab = 0;
    ragdoll.drive();
    this.physics.step(dt, (alpha) => ragdoll.beforeSubstep(alpha));
    ragdoll.sync();
    this.bottoms.update(dt);
    this.top.update(dt);
  }

  /** Build the ragdoll in the current target pose (after a reset). */
  private buildRagdoll(): void {
    this.object.updateMatrixWorld(true);
    // (Posed in the person's frame: on a board it's turned sideways)
    this.ragdoll = new Ragdoll(this.physics, this.person, this.person.group, this.skiModels, this.velocity);
    this.view.add(this.ragdoll.view);
    this.ragdoll.headVisual.visible = !this._firstPerson;
    this.bottoms.bind(this.ragdoll);
    this.top.bind(this.ragdoll);
    if (this.physicalMode && !this.board && !this.bike) {
      this.ride = new PhysicalRide(this.ragdoll);
      this.ride.onBounce = () => this.onBounce?.();
    }
  }

  /**
   * Physical mode, once per frame: read the free skis, handle the jump and
   * the pose from the controls, then let physics (plus the ski-on-snow
   * forces) move everything.
   */
  private updatePhysical(dt: number, input: Controls): void {
    const ride = this.ride!;
    const ragdoll = this.ragdoll!;
    const wasGrounded = this.grounded;
    this.grounded = ride.grounded;
    this.heading = ride.heading;
    this.velocity.copy(ride.velocity);
    this.object.position.copy(ride.feet);
    const speed = this.velocity.length();

    if (this.grounded) {
      // Loading a jump: Space charges, W/S shift weight, A/D wind up
      const loading = input.jump;
      const ease = 1 - Math.exp(-WEIGHT_SHIFT_RATE * dt);
      this.weight += ((loading ? (input.brake ? 1 : 0) - (input.tuck ? 1 : 0) : 0) - this.weight) * ease;
      this.windup += ((loading ? input.steer : 0) - this.windup) * ease;
      this.turnRate = loading ? 0 : input.steer * (TURN_RATE / (1 + speed / 25));
      if (loading) this.charge = Math.min(1, this.charge + dt / CHARGE_TIME);
      if (this.wasJumpHeld && !input.jump) {
        ride.pop(this.charge, this.windup, this.turnRate);
        this.charge = 0;
        this.windup = 0;
        this.poppedThisFrame = true;
      }
    } else {
      this.charge = 0;
      this.windup = 0;
    }
    this.wasJumpHeld = input.jump;
    if (this.grounded && !wasGrounded) this.squashGrace = SQUASH_GRACE;

    // Pose the target body (relative shapes are what the muscles follow)
    this.updatePose(dt, input);
    this.object.updateMatrixWorld(true);
    ragdoll.drive();
    const loading = input.jump && this.grounded;
    const rideInput = {
      steer: loading ? 0 : input.steer,
      tuck: input.tuck && !loading,
      brake: input.brake && !loading,
      spot: !this.grounded && input.tuck,
    };
    this.physics.step(dt, () => ride.substep(rideInput));
    ragdoll.sync();
    this.bottoms.update(dt);
    this.top.update(dt);
    ride.read();
    ride.afterFrame(dt);

    this.squashGrace = Math.max(0, this.squashGrace - dt);
    if (this.squashGrace === 0 && ragdoll.chestOrHeadDown()) {
      if (this.crashes) this.crash(this.grounded ? 'chest or head hit the snow (physical)' : 'chest or head hit the snow (physical, air)');
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
   * Fall: the ragdoll goes limp (skis let go, muscles relaxed) and tumbles
   * on from exactly how it was moving.
   */
  private crash(reason: string): void {
    this.grindTime = 0;
    this.lastGrind = { time: 0, across: 0 };
    this.crashReason = reason;
    this.ragdoll?.goLimp(this.velocity);
    this.mode = 'tumbling';
    this.tumbleTime = 0;
    this.stillTime = 0;
    this.charge = 0;
    this.pitch = 0;
    this.flipVel = 0;
    this.lean = 0;
    this.bounceTimer = 0;
    this.squashGrace = 0;
    this.onLand?.('Crash!', false, 0);
  }

  /** Follow the ragdoll while tumbling (the hidden controller rig tags along). */
  private syncRagdoll(): void {
    const ragdoll = this.ragdoll!;
    this.object.position.copy(ragdoll.torsoPosition(tmpPos));
    ragdoll.sync();
    this.velocity.copy(ragdoll.torsoMotion().velocity);
  }

  private updateTumble(dt: number): void {
    const ragdoll = this.ragdoll!;
    ragdoll.update(dt);
    this.syncRagdoll();
    this.bottoms.update(dt);
    this.top.update(dt);
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

    // Boing: the squash from a hard landing springs back into a hop
    if (this.bounceTimer > 0) {
      this.bounceTimer -= dt;
      if (this.bounceTimer <= 0) {
        this.velocity.addScaledVector(this.footprintNormal(p.x, p.z, tmpN), this.bounceSpeed);
        this.secondary.compress.velocity += STRETCH_KICK;
        this.onBounce?.();
      }
    }
    let speed = this.velocity.length();

    // On a rail? (Its top under us, and we're up on it, not beside it below.)
    const rail = railAt(p.x, p.z, this.railContact);
    const grinding = !!rail && p.y >= rail.top - 0.05;
    if (grinding) {
      if (this.grindTime === 0) this.grindAcross = 0;
      this.grindTime += dt;
      this.lastGrind = { time: 0, across: 0 };
      // Skis across the bar (a boardslide) or along it (a 50-50)
      if (Math.abs(this.forward(tmpFwd).dot(rail.dir)) < 0.5) this.grindAcross += dt;
    } else if (this.grindTime > 0) {
      this.lastGrind = { time: this.grindTime, across: this.grindAcross };
      this.grindTime = 0;
    }

    // Steering: tighter when slow, wider at speed
    // While loading a jump (Space held), A/D wind up for a spin instead of
    // steering, and W/S shift weight instead of tucking and braking
    const loading = input.jump;
    this.turnRate = loading ? 0 : input.steer * (grinding ? RAIL_TURN_RATE : TURN_RATE / (1 + speed / 25));
    this.heading += this.turnRate * dt;

    // The slope we're on: read a little behind us. A reading centred here
    // would straddle a sharp lip and blend the ramp with the table, sending
    // us off at half the lip's angle.
    const back = speed > 0.5 ? 0.3 / speed : 0;
    // On a rail: its slope, and we slide along the bar whichever way the
    // skis point (so they can turn across it, or spin)
    const n = grinding ? tmpN.copy(rail.normal) : normalAt(p.x - this.velocity.x * back, p.z - this.velocity.z * back, tmpN);
    // Wall-like readings (beside a steep feature) are nonsense for riding on:
    // treat as flat; the wall check below stops us.
    if (n.y < MAX_SLOPE_NY) n.copy(UP);
    const dir = grinding ? this.railDir(rail, tmpDir) : this.rideDir(n, tmpDir);

    const weightTarget = loading ? (input.brake ? 1 : 0) - (input.tuck ? 1 : 0) : 0;
    this.weight += (weightTarget - this.weight) * (1 - Math.exp(-WEIGHT_SHIFT_RATE * dt));
    const windupTarget = loading ? input.steer : 0;
    this.windup += (windupTarget - this.windup) * (1 - Math.exp(-WEIGHT_SHIFT_RATE * dt));

    const drag = input.tuck && !loading ? TUCK_DRAG : AIR_DRAG;
    let accel =
      -GRAVITY * dir.y - // the downhill part of gravity along the skis
      (grinding ? RAIL_FRICTION : SNOW_FRICTION) * GRAVITY * n.y -
      (grinding ? 0 : SNOW_DRAG * speed) - // deep snow (the backcountry)
      drag * speed * speed;
    // Braking: a hockey stop. The skis swing round across the way we're
    // going (the way we last steered) and skid; the further round, the
    // harder they stop us. We keep sliding the way we were going.
    if (input.steer !== 0 && !loading) this.skidSide = input.steer;
    // (Held across for as long as we brake: standing across the hill holds us still)
    const stopping = input.brake && !loading && !grinding;
    // (A bike skids its back wheel round less far than skis turn across)
    const skidTarget = stopping ? this.skidSide * (this.bike ? BIKE_SKID_ANGLE : SKID_ANGLE) : 0;
    this.skid += (skidTarget - this.skid) * (1 - Math.exp(-SKID_RATE * dt));
    if (Math.abs(this.skid) < 1e-3 && !stopping) this.skid = 0;
    if (input.brake && !loading) accel -= BRAKE_DECEL + SKID_DECEL * Math.abs(this.skid) / SKID_ANGLE;
    // Turning scrubs off some speed, like skidding the skis round
    if (!grinding) accel -= TURN_SCRUB * Math.abs(input.steer) * speed;
    // On the bike, W pedals: a push forward, fading as the speed builds
    if (this.bike && input.tuck && !loading) accel += PEDAL_ACCEL * Math.max(0, 1 - speed / PEDAL_TOP_SPEED);
    speed = Math.max(0, speed + accel * dt);
    this.velocity.copy(dir).multiplyScalar(speed);
    this.suspension(dt, dir, n, grinding);

    // Jump: charge while space is held, pop on release
    if (input.jump) this.charge = Math.min(1, this.charge + dt / CHARGE_TIME);
    if (this.wasJumpHeld && !input.jump) {
      const pop = POP_MIN + (POP_MAX - POP_MIN) * this.charge;
      // The legs push along the stance (perpendicular to the skis as a whole),
      // which is the footprint-averaged slope, not the point under the boots
      const push = grinding ? tmpPush.copy(rail.normal) : this.footprintNormal(p.x, p.z, tmpPush);
      this.velocity.addScaledVector(push, pop);
      this.poppedThisFrame = true;
      // The push goes through the feet. If the centre of mass isn't straight
      // above them, that push also starts the body rotating: angular impulse
      // = r × J, with r from the COM to the feet and J the push (mass × pop).
      // Weight back -> backflip rotation, weight forward -> frontflip.
      const feet = this.person.group.localToWorld(
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
    const h = groundAt(pred.x, pred.z); // the snow, or a rail's top

    if (h - pred.y > WALL) {
      // Ran into something steep (the side of a kicker): fall if fast,
      // otherwise just stop against it
      if (speed > WALL_CRASH_SPEED) this.hitWall = true;
      else this.velocity.multiplyScalar(0);
      return;
    }
    if (pred.y > h + 0.02) {
      this.grounded = false;
      // Rolled off a lip, crest or cliff: no push, so no flip; the body
      // keeps some of the turn it was carving. (Not all of it: with no pop
      // to wind against, a small turn at the edge of a big cliff would
      // become a half spin over three seconds of air.)
      this.flipMomentum = 0;
      this.spinMomentum = this.mass.yawInertia * this.turnRate * ROLL_OFF_SPIN;
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
    const turned = wrapAngle(this.heading - headingBefore);
    this.airSpin += turned;
    this.spinRate = dt > 0 ? turned / dt : 0;

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
    // Coming down on a rail: any way round is fine (skis along it, or
    // across it for a boardslide), as long as we're upright
    const rail = railAt(feet.x, feet.z, this.railContact);
    const onRail = !!rail && feet.y >= rail.top - RAIL_CATCH_BELOW;
    const flipOff = bodyUp.angleTo(onRail ? rail.normal : this.footprintNormal(feet.x, feet.z, tmpN));
    const bad =
      this.current.grab > GRAB_LAND_MAX
        ? 'landed still holding the grab'
        : (!onRail && facingOff >= CLEAN_SPIN) || flipOff >= CLEAN_FLIP
          ? `bad landing: facing off ${facingOff.toFixed(2)}, flip off ${flipOff.toFixed(2)}`
          : '';
    if (bad && this.crashes) {
      this.crash(bad);
      return;
    }
    // (Crashes off: ride it away; the skis swing onto the snow a bit slower)
    const saved = !!bad;

    // The skis slap onto the slope over the next moment (see updatePose),
    // starting from how they were in the air
    this.object.updateMatrixWorld(true);
    const airTilt = tmpRot.copy(this.airQ);
    // Clean: back to the ground representation (object at the feet, turned
    // to the heading), feet settled onto the snow, and ride on
    p.set(feet.x, onRail ? rail.top : heightAt(feet.x, feet.z), feet.z);
    this.object.quaternion.identity();
    this.body.quaternion.identity();
    this.airL.set(0, 0, 0);
    this.airOmega.set(0, 0, 0);
    this.switchStance = landSwitch;
    // (On a rail the skis stay pointing however they came down)
    if (!onRail) this.heading = landSwitch ? travel + Math.PI : travel;
    // Stance (relative to the heading) = the air orientation, so the skis
    // start their slap from where they really were
    this.stance.quaternion.setFromAxisAngle(UP, -this.heading).multiply(airTilt);
    this.slapTime = saved ? SLAP_TIME * 2.5 : SLAP_TIME;
    this.squashGrace = SQUASH_GRACE;
    this.pitch = 0;
    this.spinMomentum = 0;
    this.flipVel = 0;
    this.flipMomentum = 0;

    const n = onRail ? tmpN.copy(rail.normal) : normalAt(p.x, p.z, tmpN);
    // How hard we hit: speed into the slope. Really hard: squash the body
    // right down, then (unrealistically) spring back up into a little hop.
    const impact = -this.velocity.dot(n);
    if (impact > HARD_LANDING) {
      this.secondary.compress.velocity -= SQUASH_KICK;
      this.bounceTimer = BOUNCE_DELAY;
      // (Scaled per map: in the backcountry the ground keeps falling away
      // below a landing, so a big hop off a cliff became a second long,
      // crooked air)
      this.bounceSpeed = MAP_BOUNCE * Math.min(BOUNCE_MAX, BOUNCE_MIN + (impact - HARD_LANDING) * BOUNCE_PER_IMPACT);
    }
    const dir = onRail ? this.railDir(rail, tmpDir) : this.rideDir(n, tmpDir);
    const along = Math.max(0, this.velocity.dot(dir));
    this.velocity.copy(dir).multiplyScalar(along);
    this.grounded = true;

    // Back down on the rail after a hop: the slide carries on
    if (onRail && this.lastGrind.time > 0) {
      this.grindTime = this.lastGrind.time;
      this.grindAcross = this.lastGrind.across;
      this.lastGrind = { time: 0, across: 0 };
    }
    // Call out the trick: the rail slide we came off (if any), then the air
    const parts: string[] = [];
    if (this.lastGrind.time >= MIN_GRIND) {
      const kind = this.lastGrind.across > this.lastGrind.time / 2 ? 'Boardslide' : '50-50';
      parts.push(`${kind} ${this.lastGrind.time.toFixed(1)} s`);
    }
    this.lastGrind = { time: 0, across: 0 };
    const grabbed = this.grabTime >= MIN_GRAB;
    const shifty = this.shiftyTime >= MIN_GRAB;
    let trick = trickName(this.airSpin, pitch, this.takeoffSwitch);
    const grabName = this.board ? 'Indy' : this.bike ? 'No-hander' : 'X-Tail';
    if (grabbed) trick = trick ? `${trick} ${grabName}` : grabName;
    const shiftyName = this.bike ? 'Tabletop' : 'Shifty';
    if (shifty) trick = trick ? `${trick} ${shiftyName}` : shiftyName;
    const points = trickPoints(this.airSpin, pitch, grabbed) + (shifty ? POINTS.shifty : 0);
    if (saved) {
      // A crash ridden away (crashes off): half points
      this.onLand?.(trick ? `Sketchy ${trick}` : 'Sketchy', false, Math.round(points / 2));
      return;
    }
    if (trick) parts.push(trick);
    if (parts.length) this.onLand?.(parts.join(' + '), true, points);
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
    const skiTurn = steady ? wrapAngle(this.heading + this.skid - this.prevHeading - this.prevSkid) : 0;
    this.prevHeading = this.heading;
    this.prevSkid = this.skid;
    this.prevGrounded = this.grounded;

    // On the snow the upper body leans towards facing down the fall line
    // (skis across the hill, chest down it); riding switch the look takes
    // care of the upper body instead
    let yawTarget = 0;
    if (!this.grounded) {
      yawTarget = THREE.MathUtils.clamp(this.spinRate * SPIN_LEAD, -MAX_SPIN_LEAD, MAX_SPIN_LEAD);
    } else if (!this.switchStance) {
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
      // (Turned further while hockey-stopping: the skis swing across)
      this.object.rotation.set(0, this.heading + this.skid, 0);
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
      const n = tmpN.copy(this.tiltWorld).applyAxisAngle(UP, -(this.heading + this.skid));
      // Across a steep slope, don't stand square to it: stay nearer upright
      // and tip the skis onto their edges instead (or the rider, leaning
      // into a turn on top of a 33° side slope, put his chest in the snow)
      const across = Math.atan2(n.x, n.y);
      const a = Math.abs(across);
      if (a > SIDE_TILT_FULL) {
        const kept = Math.sign(across) * (SIDE_TILT_FULL + (a - SIDE_TILT_FULL) * SIDE_TILT_BEYOND);
        const len = Math.hypot(n.x, n.y);
        n.x = Math.sin(kept) * len;
        n.y = Math.cos(kept) * len;
        n.normalize();
      }
      tmpQ2.setFromUnitVectors(UP, n);
      // Right after a landing the skis slap down onto the slope over a few
      // hundredths of a second rather than snapping in one frame (the
      // ragdoll stands on them: a snap would wrench its legs)
      if (this.slapTime > 0) {
        this.slapTime -= dt;
        this.stance.quaternion.slerp(tmpQ2, 1 - Math.exp(-SLAP_RATE * dt));
      } else {
        this.stance.quaternion.copy(tmpQ2);
      }
    }

    if (!input) return;
    // Faster in the air, so tucking and opening up respond quickly
    const ease = 1 - Math.exp(-(this.grounded ? 8 : 14) * dt);

    // Lean into the turn, more at speed; upright in the air
    // Riding switch, the body's left is the travel direction's right
    const sideSign = this.switchStance ? -1 : 1;
    // (In physical mode the whole body tips into the turn by itself, so the
    // pose adds no lean of its own.)
    // Leaning in as far as the turn pulls outwards (balanced: lean angle =
    // atan(sideways pull / g)), at least the usual amount. (With a fixed
    // lean, fast turns pulled ~2 g outwards against ~25° of lean and threw
    // the body to the outside: across a steep slope, into the snow uphill.)
    // (The pull is smoothed: a held carve builds it, quick taps don't throw
    // the body from side to side)
    this.turnPull += (this.speed * this.turnRate - this.turnPull) * (1 - Math.exp(-PULL_RATE * dt));
    const usual = input.steer * MAX_LEAN * Math.min(1, this.speed / 15);
    const balanced = Math.sign(this.turnPull) * Math.min(MAX_BALANCE_LEAN, Math.atan(Math.abs(this.turnPull) / GRAVITY));
    const lean = Math.abs(balanced) > Math.abs(usual) && Math.sign(balanced) === Math.sign(usual) ? balanced : usual;
    const targetLean = this.grounded && !this.ride ? sideSign * lean : 0;
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
      // S: for flips: arching back in a backflip (or with no flip going),
      // folded into a ball in a frontflip. A/D: arms hugged in,
      // upright (fast spins).
      // W: open up (slow everything, and windmill to spot the landing).
      // Space: the X tail grab (over everything else).
      Object.assign(
        t,
        input.jump
          ? this.board
            ? AIR_INDY
            : AIR_GRAB
          : input.brake
            ? this.flipMomentum >= 0
              ? AIR_ARCH
              : AIR_TUCK
            : input.tuck
              ? AIR_OPEN
              : input.steer !== 0
                ? AIR_SPIN
                : AIR,
      );
    } else {
      Object.assign(t, input.tuck && !input.jump ? TUCK : RIDING);
      if (this.charge > 0) lerpPose(t, CROUCH, this.charge, t);
      if (this.weight > 0) lerpPose(t, LEAN_BACK, this.weight, t);
      else if (this.weight < 0) lerpPose(t, LEAN_FORWARD, -this.weight, t);
    }
    t.lean = this.lean;
    if (this.bike) {
      // On the bike: bent forward over the bars (hands on the grips, see
      // Person), hips a little back, a bit lower in the air
      t.torsoPitch = Math.max(t.torsoPitch, BIKE_POSE.torsoPitch);
      t.hipBack = BIKE_POSE.hipBack + (t.hipBack - RIDING.hipBack) * 0.5;
      t.hipHeight = Math.min(t.hipHeight, this.grounded ? BIKE_POSE.hipHeight : BIKE_POSE.hipHeight - 0.04);
    }
    // Shifty (Right Shift, in the air): skis turned 45° to the left, tips
    // dipped, shoulders the other way, held as long as the key is; it
    // springs back when let go
    t.shifty = !this.grounded && input.shifty ? 1 : 0;
    // Wind-up shows as shoulders turned back against the coming spin
    t.twist = this.grounded ? -this.windup * WINDUP_TWIST : 0;
    // Switch: shoulders open up towards the look, head turns the rest
    t.look = this.switchStance && this.grounded ? this.lookSide : 0;
    t.twist += t.look * SWITCH_TWIST;
    t.twist -= t.shifty * SHIFTY.shoulders * 2; // (shoulders turned against the skis)
    if (this.board) {
      // Sideways on the board: shoulders opened a little towards the nose
      // (the tail, riding switch) and the head turned to look where we're
      // going. Leaning into a turn tips the body over the toe or heel edge
      // instead: forward over the toes, back onto the heels.
      const way = this.switchStance ? -1 : 1;
      t.twist += way * BOARD_TWIST - t.look * SWITCH_TWIST; // (instead of the skis' switch look)
      t.look = way * BOARD_LOOK;
      t.torsoPitch -= t.lean * BOARD_EDGE_PITCH;
      t.hipBack += t.lean * BOARD_EDGE_HIPS;
      t.lean = 0;
    }
    if (this.grounded && this.skid !== 0) {
      // Hockey stop: shoulders stay facing down the hill while the legs
      // swing across, sinking a little and leaning back against the slide
      const amount = Math.abs(this.skid) / SKID_ANGLE;
      t.twist -= this.skid * SKID_COUNTER;
      t.lean += Math.sign(this.skid) * SKID_LEAN * amount;
      lerpPose(t, CROUCH, 0.35 * amount, t);
    }
    lerpPose(this.current, t, ease, this.current);
    this.updateSecondary(dt);
    if (this.grounded) {
      // Where the mass would be without the springy layer (for the pop)
      this.person.pose(this.current);
      this.person.massProperties(...this.skiRods(), tmpMass);
      this.intendedCom.copy(tmpMass.com);
    }
    this.person.pose(this.current, this.secondary);
    this.placeSkis();
    if (this.bike) this.animateBike(dt, input);
    this.updateMass(!this.grounded);
  }
}
