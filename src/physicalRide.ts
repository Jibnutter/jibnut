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
import { heightAt, normalAt } from './terrain';
import type { Ragdoll } from './ragdoll';

/**
 * Fully physical skiing (toggle with P). The skis are free bodies; nothing
 * places them. Each physics substep this adds what a ski on snow does:
 *
 *   support     the snow holds each ski up: stiff springs at its tip, middle
 *               and tail push it out of the exact snow surface (not Rapier's
 *               mesh contacts, whose triangle edges launched skis at speed)
 *   edge grip   sideways sliding of a ski on the snow is resisted: motion is
 *               turned along the skis (carving)
 *   drag        air resistance, tucking halves it; snowplow braking
 *   steering    A/D twist the skis about the slope's normal; the body
 *               follows through the ankles and hips
 *   balance     a gentle assist keeping the pelvis upright over the skis
 *               (a cheat: real riders balance with tiny constant corrections)
 *
 * Jumps push the whole body off the snow, with a flip from where the centre
 * of mass is relative to the feet and a spin from the wind-up and carving,
 * the same physics as the regular controller. In the air nothing pushes on
 * the body: tucking spins it faster purely through the ragdoll's own
 * physics. Landing, bouncing and crashing are the ragdoll's.
 */

const GRAVITY = 9.81;
// Ski on snow
const CONTACT = 0.07; // m: ski centre this close to the snow counts as touching
// Snow support, per ski, shared over its tip, middle and tail. Holds ~half
// the rider (420 N) with ~2 cm of sink; damped so landings don't rebound
// (the quirky bounce is added on purpose instead).
const SUPPORT_STIFFNESS = 24000; // N/m per ski
const SUPPORT_DAMPING = 1400; // N·s/m per ski
const SKI_SAMPLES = [-0.72, 0, 0.72]; // along the ski (body-local z), metres
const SKI_BOTTOM = -0.015; // ski base below its body origin
const GRIP_RATE = 9; // 1/s: how quickly sideways sliding is taken out
const GRIP_MAX = 1.6 * GRAVITY; // m/s²: the most the edges can hold (then they skid)
// Gliding friction: lower than the controller's 0.05, because the physical
// skis already lose a little to their springy support and to meeting curved
// ramps with their full length (lip speeds came out 6-10 km/h slower)
const SNOW_FRICTION = 0.02;
const AIR_DRAG = 0.004; // per metre, as in the controller
const TUCK_DRAG = 0.002;
const BRAKE_DECEL = 4; // m/s²
// Steering: a target turn rate like the controller's, reached by twisting
const TURN_RATE = 2.2; // rad/s when slow, wider at speed
const TURN_RESPONSE = 7; // 1/s
const SKI_YAW_INERTIA = 4; // kg m²: the rider turning on its skis, for the twist torque
// Balance assist on the pelvis
const BALANCE_STIFFNESS = 900; // N·m per radian off upright
const BALANCE_DAMPING = 90; // N·m per rad/s
// Jump push, matching the controller
const POP_MIN = 2.5;
const POP_MAX = 7.5;
const WIND_MOMENTUM = 14;
// Hard-landing bounce, matching the controller
const HARD_LANDING = 8;
const BOUNCE_DELAY = 0.14;
const BOUNCE_MIN = 2;
const BOUNCE_PER_IMPACT = 0.5;
const BOUNCE_MAX = 6;

export interface RideInput {
  steer: number;
  tuck: boolean;
  brake: boolean;
  /** In the air: windmill to line up with the slope below (W). */
  spot: boolean;
}
const SPOT_STRENGTH = 0.35; // of the balance assist, in the air while spotting

export class PhysicalRide {
  private readonly ragdoll: Ragdoll;
  /** Feet centre, facing, touching the snow, centre of mass and its velocity. */
  readonly feet = new THREE.Vector3();
  heading = 0;
  grounded = true;
  readonly com = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  mass = 1;
  private bounceTimer = 0;
  private bounceSpeed = 0;
  private wasGrounded = true;
  private lastVelocity = new THREE.Vector3();
  onBounce?: () => void;

  constructor(ragdoll: Ragdoll) {
    this.ragdoll = ragdoll;
    ragdoll.freeSkis();
    this.read();
  }

  /** Update the readings from the bodies (call after stepping). */
  read(): void {
    const skis = this.ragdoll.skiBodies;
    this.feet.set(0, 0, 0);
    let fx = 0;
    let fz = 0;
    let touching = 0;
    for (const ski of skis) {
      const t = ski.translation();
      this.feet.x += t.x / 2;
      this.feet.y += t.y / 2;
      this.feet.z += t.z / 2;
      const f = tmpA.set(0, 0, -1).applyQuaternion(quat(ski, tmpQ));
      fx += f.x;
      fz += f.z;
      if (t.y - heightAt(t.x, t.z) < CONTACT) touching++;
    }
    if (fx * fx + fz * fz > 1e-4) this.heading = Math.atan2(-fx, -fz);
    this.grounded = touching > 0;
    this.mass = this.ragdoll.massState(this.com, this.velocity);
  }

  /** Forces for the next physics substep (they last one substep). */
  substep(input: RideInput): void {
    const ragdoll = this.ragdoll;
    const bodies = ragdoll.bodies;
    for (const b of bodies) {
      b.resetForces(true);
      b.resetTorques(true);
    }
    const skis = ragdoll.skiBodies;
    // Fresh centre of mass for this substep (it moves ~0.3 m a frame at speed)
    this.mass = ragdoll.massState(this.com, this.velocity);
    const moment = tmpMoment.set(0, 0, 0);

    // The snow holds each ski up, at its tip, middle and tail
    for (const ski of skis) snowSupport(ski);

    // Which skis are on the snow, and the slope under them
    const n = normalAt(this.feet.x, this.feet.z, tmpN);
    let onSnow = 0;
    const lateral = tmpLat.set(0, 0, 0);
    let latSpeed = 0;
    for (const ski of skis) {
      const t = ski.translation();
      if (t.y - heightAt(t.x, t.z) >= CONTACT) continue;
      onSnow++;
      // The ski's sideways direction, laid onto the slope
      const l = tmpA.set(1, 0, 0).applyQuaternion(quat(ski, tmpQ));
      l.addScaledVector(n, -l.dot(n)).normalize();
      const v = ski.linvel();
      latSpeed += tmpB.set(v.x, v.y, v.z).dot(l);
      lateral.add(l);
    }

    // Accelerations for the whole body (every part alike, so it's stable).
    // The snow's forces (grip, friction, braking) really act at the skis,
    // below the centre of mass: that also twists the body (it's what holds
    // up a lean into a turn, and pitches you forward when braking). That
    // twist is added separately, spread over the body, below.
    const acc = tmpAcc.set(0, 0, 0);
    if (onSnow > 0) {
      lateral.normalize();
      latSpeed /= onSnow;
      // Edge grip: take out sideways sliding, up to what the edges hold.
      // Half the grip on one ski.
      const grip = THREE.MathUtils.clamp(latSpeed * GRIP_RATE, -GRIP_MAX, GRIP_MAX) * (onSnow / 2);
      acc.addScaledVector(lateral, -grip);
      // Gliding friction, plus snowplow braking, against the direction of
      // travel along the snow
      const along = tmpB.copy(this.velocity).addScaledVector(n, -this.velocity.dot(n));
      if (along.lengthSq() > 0.01) {
        const decel = SNOW_FRICTION * GRAVITY * n.y * (onSnow / 2) + (input.brake ? BRAKE_DECEL : 0);
        acc.addScaledVector(along.normalize(), -decel);
      }
      // Moment of the snow's force about the centre of mass: r × F, with r
      // from the centre of mass down to the feet
      const r = tmpC.copy(this.feet).sub(this.com);
      const snowMoment = tmpD.crossVectors(r, acc).multiplyScalar(this.mass);
      // Keep only the tipping part. Real edges grip along their length, not
      // at one point, so they don't swing the body round like a weathervane
      // (a point grip just behind the centre of mass did, overpowering the
      // steering): turning is the steering's job
      snowMoment.addScaledVector(n, -snowMoment.dot(n));
      moment.add(snowMoment);
    }
    // Air drag (tucking halves it)
    const speed = this.velocity.length();
    if (speed > 0.01) acc.addScaledVector(this.velocity, -(input.tuck ? TUCK_DRAG : AIR_DRAG) * speed);
    for (const b of bodies) {
      const m = b.mass();
      b.addForce({ x: acc.x * m, y: acc.y * m, z: acc.z * m }, true);
    }

    if (onSnow === 0 && input.spot) this.uprightTorque(n, SPOT_STRENGTH, moment);
    if (onSnow > 0) {
      // Steering: twist the skis about the slope's normal towards a target
      // turn rate (tighter when slow, wider at speed)
      const target = input.steer * (TURN_RATE / (1 + speed / 25));
      let yawRate = 0;
      for (const ski of skis) {
        const w = ski.angvel();
        yawRate += tmpB.set(w.x, w.y, w.z).dot(n) / skis.length;
      }
      const torque = (SKI_YAW_INERTIA * TURN_RESPONSE * (target - yawRate)) / skis.length;
      for (const ski of skis) ski.addTorque({ x: n.x * torque, y: n.y * torque, z: n.z * torque }, true);

      // Balance: lean the body along the snow's total push (support along the
      // normal plus grip, friction and braking): in a turn that's leaning in
      // just enough that the push goes through the centre of mass, which is
      // what keeps a real skier from falling in or out
      const snowPush = tmpPush.copy(n).multiplyScalar(GRAVITY * n.y);
      if (onSnow > 0) snowPush.add(tmpB.copy(acc).addScaledVector(this.velocity, (input.tuck ? TUCK_DRAG : AIR_DRAG) * speed));
      this.uprightTorque(snowPush.normalize(), 1, moment);
    }
    this.applyMoment(moment);
  }

  /**
   * Turn the whole body by a moment (N·m) about its centre of mass without
   * pushing it anywhere: each part gets m × (α × r), α = moment / inertia.
   * Spread over every part like this it stays stable; a big torque on one
   * light part (a ski, the pelvis) would fling it about.
   */
  private applyMoment(moment: THREE.Vector3): void {
    const size = moment.length();
    if (size < 1e-6) return;
    const axis = tmpN2.copy(moment).divideScalar(size);
    const bodies = this.ragdoll.bodies;
    let I = 0;
    for (const b of bodies) {
      const t = b.translation();
      const d = tmpD.set(t.x - this.com.x, t.y - this.com.y, t.z - this.com.z);
      I += b.mass() * d.addScaledVector(axis, -d.dot(axis)).lengthSq();
    }
    const alpha = tmpW.copy(axis).multiplyScalar(size / Math.max(I, 1));
    for (const b of bodies) {
      const t = b.translation();
      const r = tmpD.set(t.x - this.com.x, t.y - this.com.y, t.z - this.com.z);
      const f = tmpA.crossVectors(alpha, r).multiplyScalar(b.mass());
      b.addForce({ x: f.x, y: f.y, z: f.z }, true);
    }
  }

  /** Add a moment turning the body so the pelvis's up points along `up`. */
  private uprightTorque(n: THREE.Vector3, strength: number, moment: THREE.Vector3): void {
    const pelvis = this.ragdoll.pelvis;
    const up = tmpA.set(0, 1, 0).applyQuaternion(quat(pelvis, tmpQ));
    const axis = tmpB.crossVectors(up, n);
    const angle = Math.atan2(axis.length(), up.dot(n));
    const w = pelvis.angvel();
    const wPerp = tmpC.set(w.x, w.y, w.z);
    wPerp.addScaledVector(up, -wPerp.dot(up)); // only damp tipping, not turning
    if (angle > 1e-4) axis.normalize().multiplyScalar(BALANCE_STIFFNESS * angle);
    else axis.set(0, 0, 0);
    axis.addScaledVector(wPerp, -BALANCE_DAMPING).multiplyScalar(strength);
    moment.add(axis);
  }

  /** After each frame's physics: hard-landing bounce bookkeeping. */
  afterFrame(dt: number): void {
    const n = normalAt(this.feet.x, this.feet.z, tmpN);
    if (this.grounded && !this.wasGrounded) {
      const impact = -this.lastVelocity.dot(n);
      if (impact > HARD_LANDING) {
        this.bounceTimer = BOUNCE_DELAY;
        this.bounceSpeed = Math.min(BOUNCE_MAX, BOUNCE_MIN + (impact - HARD_LANDING) * BOUNCE_PER_IMPACT);
      }
    }
    if (this.bounceTimer > 0) {
      this.bounceTimer -= dt;
      if (this.bounceTimer <= 0 && this.grounded) {
        this.ragdoll.kick(tmpB.copy(n).multiplyScalar(this.bounceSpeed), ZERO, this.com);
        this.onBounce?.();
      }
    }
    this.wasGrounded = this.grounded;
    this.lastVelocity.copy(this.velocity);
  }

  /**
   * The jump: push the whole body off along the slope's normal, from the
   * feet. If the centre of mass isn't over the feet the push also starts a
   * flip (angular impulse r × J), and the wind-up plus any carving becomes
   * spin about the body's long axis.
   * @param charge 0..1 how long Space was held
   * @param windup -1..1 spin wind-up (+ = left)
   * @param turnRate rad/s we were turning on the snow
   */
  pop(charge: number, windup: number, turnRate: number): void {
    if (!this.grounded) return;
    const n = normalAt(this.feet.x, this.feet.z, tmpN);
    const pop = POP_MIN + (POP_MAX - POP_MIN) * charge;
    const impulse = tmpB.copy(n).multiplyScalar(this.mass * pop);
    const r = tmpA.copy(this.feet).sub(this.com);
    const L = tmpC.crossVectors(r, impulse); // flip (and some roll)
    // Spin about the body's long axis (≈ the slope's normal at takeoff)
    L.addScaledVector(n, windup * WIND_MOMENTUM + SKI_YAW_INERTIA * turnRate);
    // Turn momentum into spin with the body's inertia about the centre of
    // mass (approximated: rigid for this instant, about the momentum's axis)
    const axis = tmpN2.copy(L);
    const size = axis.length();
    const w = tmpW.set(0, 0, 0);
    if (size > 1e-6) {
      axis.divideScalar(size);
      let I = 0;
      for (const b of this.ragdoll.bodies) {
        const t = b.translation();
        const d = tmpD.set(t.x - this.com.x, t.y - this.com.y, t.z - this.com.z);
        const perp = d.addScaledVector(axis, -d.dot(axis)).lengthSq();
        I += b.mass() * perp;
      }
      w.copy(axis).multiplyScalar(size / Math.max(I, 1));
    }
    this.ragdoll.kick(tmpD.copy(n).multiplyScalar(pop), w, this.com);
  }
}

/**
 * Snow support for one free ski: wherever a sample point along its base has
 * sunk below the snow surface, push it back out along the surface normal
 * (spring on the depth, damper on the speed into the snow).
 */
export function snowSupport(ski: import('@dimforge/rapier3d-compat').RigidBody): void {
  const t = ski.translation();
  const q = quat(ski, tmpQ);
  const k = SUPPORT_STIFFNESS / SKI_SAMPLES.length;
  const c = SUPPORT_DAMPING / SKI_SAMPLES.length;
  for (const along of SKI_SAMPLES) {
    const p = tmpS.set(0, SKI_BOTTOM, along).applyQuaternion(q).add(tmpS2.set(t.x, t.y, t.z));
    const depth = heightAt(p.x, p.z) - p.y;
    if (depth <= 0) continue;
    const nrm = normalAt(p.x, p.z, tmpSn);
    // Velocity of that point of the ski: v + w × r
    const v = ski.linvel();
    const w = ski.angvel();
    const r = tmpS3.set(p.x - t.x, p.y - t.y, p.z - t.z);
    const pv = tmpS4.set(w.x, w.y, w.z).cross(r).add(tmpS5.set(v.x, v.y, v.z));
    const into = pv.dot(nrm);
    const f = Math.max(0, k * depth - c * into);
    ski.addForceAtPoint({ x: nrm.x * f, y: nrm.y * f, z: nrm.z * f }, { x: p.x, y: p.y, z: p.z }, true);
  }
}

function quat(body: { rotation(): { x: number; y: number; z: number; w: number } }, out: THREE.Quaternion): THREE.Quaternion {
  const r = body.rotation();
  return out.set(r.x, r.y, r.z, r.w);
}

const ZERO = new THREE.Vector3();
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const tmpD = new THREE.Vector3();
const tmpN = new THREE.Vector3();
const tmpN2 = new THREE.Vector3();
const tmpW = new THREE.Vector3();
const tmpLat = new THREE.Vector3();
const tmpAcc = new THREE.Vector3();
const tmpMoment = new THREE.Vector3();
const tmpPush = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const tmpS2 = new THREE.Vector3();
const tmpS3 = new THREE.Vector3();
const tmpS4 = new THREE.Vector3();
const tmpS5 = new THREE.Vector3();
const tmpSn = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
