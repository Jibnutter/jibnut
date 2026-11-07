import * as THREE from 'three';

/**
 * Secondary motion: intentions layered on top of the posed body.
 *
 * The ragdoll now provides the physical lag, wobble, floppy arms and head
 * nods by itself. What's left here are things the rider *does*: absorbing a
 * landing by folding the legs (and springing back), and turning the upper
 * body separately from the skis (it keeps facing where it was while the skis
 * pivot, and leans towards facing down the fall line). The torso, hand and
 * head springs remain but are switched off (gains 0) now the ragdoll does it.
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
const STEADY_TIME = 0.12; // s: loads lasting longer than this count as steady
// The ragdoll's real physics now does these:
const PITCH_FROM_BRAKE = 0;
const PITCH_FROM_LANDING = 0;
const ROLL_GAIN = 0;
const HAND_GAIN = 0;
const HEAD_GAIN = 0;

export class SecondaryMotion {
  /** Hip drop (negative) or extension (positive), metres. */
  readonly compress = new Spring(9, 0.35, -0.36, 0.1);
  /** Extra forward (+) / back (-) torso pitch, radians. */
  readonly pitch = new Spring(7, 0.5, -0.5, 0.6);
  /** Extra sideways torso roll, radians (+ = left). */
  readonly roll = new Spring(7, 0.55, -0.4, 0.4);
  /** Upper body (hips up) turned relative to the skis, radians (+ = left). */
  readonly yaw = new Spring(5, 0.6, -1.0, 1.0);
  /** Head nod, radians (+ = chin down). */
  readonly nod = new Spring(10, 0.4, -0.4, 0.5);
  /** Hand offsets from where the pose puts them, per hand, x/y/z. */
  readonly hands = [0, 1].map(() => [0, 1, 2].map(() => new Spring(5, 0.35, -0.3, 0.3)));

  /** Recent average of the upward kick: steady loads (a curved ramp) aren't landings. */
  private steadyUp = 0;

  reset(): void {
    this.steadyUp = 0;
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
    // Only sudden jolts fold the legs. A steady load, like the 2 g of a
    // curved takeoff ramp, is taken out (it would otherwise sink the rider
    // into a deep squat and drop the head into the ramp)
    const jolt = felt.y - this.steadyUp;
    this.steadyUp += (felt.y - this.steadyUp) * (1 - Math.exp(-dt / STEADY_TIME));
    this.compress.velocity -= jolt * COMPRESS_GAIN * 9;
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
    this.yaw.value = THREE.MathUtils.clamp(this.yaw.value - skiTurn, -1.0, 1.0);

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
