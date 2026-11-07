import * as THREE from 'three';

/**
 * Secondary motion: the soft, springy layer on top of the posed body.
 *
 * The posing code says where the body *wants* to be. This layer adds how a
 * real body *lags and bounces* on the way there: legs compress on landings
 * like suspension, the torso tips when you brake or accelerate, arms trail
 * like loose pendulums, the head nods, and the upper body turns separately
 * from the skis (it keeps facing where it was while the skis pivot, and
 * leans towards facing down the fall line).
 *
 * Every part is a damped spring pushed by what the body feels: the change in
 * velocity each frame minus gravity (a "felt impulse", in m/s), given in the
 * stance frame (x right, y up through the body, z backwards).
 */

class Spring {
  value = 0;
  velocity = 0;
  private readonly omega: number;
  private readonly zeta: number;
  private readonly min: number;
  private readonly max: number;

  /**
   * @param omega natural frequency (rad/s): how quickly it springs back
   * @param zeta damping ratio: < 1 bounces, 1 settles without overshoot
   */
  constructor(omega: number, zeta: number, min = -Infinity, max = Infinity) {
    this.omega = omega;
    this.zeta = zeta;
    this.min = min;
    this.max = max;
  }

  step(dt: number, target = 0): void {
    const { omega: w, zeta: z } = this;
    // Semi-implicit Euler: stable for these frequencies at small steps
    this.velocity += (-w * w * (this.value - target) - 2 * z * w * this.velocity) * dt;
    this.value += this.velocity * dt;
    if (this.value < this.min || this.value > this.max) {
      // Hit the end stop (a fully bent knee, say): stop there
      this.value = THREE.MathUtils.clamp(this.value, this.min, this.max);
      this.velocity = 0;
    }
  }

  reset(): void {
    this.value = 0;
    this.velocity = 0;
  }
}

// How strongly each felt impulse (m/s) kicks each spring
const COMPRESS_GAIN = 0.11; // m/s of hip drop speed per m/s of upward kick
const PITCH_FROM_BRAKE = 0.08; // rad/s of torso pitch per m/s of fore/aft kick
const PITCH_FROM_LANDING = 0.12; // the chest keeps falling on a hard landing
const ROLL_GAIN = 0.07;
const HAND_GAIN = 0.05; // hands trail the body
const HEAD_GAIN = 0.1;

export class SecondaryMotion {
  /** Hip drop (negative) or extension (positive), metres. */
  readonly compress = new Spring(9, 0.45, -0.32, 0.08);
  /** Extra forward (+) / back (-) torso pitch, radians. */
  readonly pitch = new Spring(7, 0.5, -0.5, 0.6);
  /** Extra sideways torso roll, radians (+ = left). */
  readonly roll = new Spring(7, 0.55, -0.4, 0.4);
  /** Upper body (hips up) turned relative to the skis, radians (+ = left). */
  readonly yaw = new Spring(5, 0.75, -0.7, 0.7);
  /** Head nod, radians (+ = chin down). */
  readonly nod = new Spring(10, 0.4, -0.4, 0.5);
  /** Hand offsets from where the pose puts them, per hand, x/y/z. */
  readonly hands = [0, 1].map(() => [0, 1, 2].map(() => new Spring(5, 0.35, -0.3, 0.3)));

  reset(): void {
    for (const s of [this.compress, this.pitch, this.roll, this.yaw, this.nod, ...this.hands.flat()]) s.reset();
  }

  /**
   * @param dt        seconds since last frame
   * @param felt      felt impulse this frame in the stance frame (m/s)
   * @param skiTurn   how much the skis turned this frame (rad, + = left)
   * @param yawTarget where the upper body wants to face relative to the skis
   */
  update(dt: number, felt: THREE.Vector3, skiTurn: number, yawTarget: number): void {
    // Kicks from the felt impulse. Upward = the snow pushing up harder than
    // usual (a landing): legs give, the chest keeps falling, the head nods.
    this.compress.velocity -= felt.y * COMPRESS_GAIN * 9;
    this.pitch.velocity += -felt.z * PITCH_FROM_BRAKE * 7 + Math.max(0, felt.y) * PITCH_FROM_LANDING * 7;
    this.roll.velocity += felt.x * ROLL_GAIN * 7;
    this.nod.velocity += Math.max(0, felt.y) * HEAD_GAIN * 10;
    this.hands.forEach((hand) => {
      // Hands lag: they move opposite to the push the body gets
      hand[0].velocity -= felt.x * HAND_GAIN * 5;
      hand[1].velocity -= felt.y * HAND_GAIN * 5;
      hand[2].velocity -= felt.z * HAND_GAIN * 5;
    });

    // The upper body keeps facing where it was while the skis turn under it
    this.yaw.value = THREE.MathUtils.clamp(this.yaw.value - skiTurn, -0.7, 0.7);

    // Step the springs in small slices so stiff ones stay stable
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.compress.step(h);
      this.pitch.step(h);
      this.roll.step(h);
      this.yaw.step(h, yawTarget);
      this.nod.step(h);
      for (const s of this.hands.flat()) s.step(h);
    }
  }

  /** Current hand offset for hand i (0 left, 1 right), stance frame. */
  hand(i: number, out: THREE.Vector3): THREE.Vector3 {
    const [x, y, z] = this.hands[i];
    return out.set(x.value, y.value, z.value);
  }
}
