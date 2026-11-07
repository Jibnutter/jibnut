import * as THREE from 'three';
import { heightAt } from './terrain';
import type { Skier } from './skier';

// Third person
const DISTANCE = 7; // metres behind the skier
const HEIGHT = 3; // metres above the snow under the camera
const LOOK_AHEAD = 4; // look at a point this far in front of the skier
const STIFFNESS = 4; // higher = camera catches up faster
const THIRD_FOV = 60;

// First person
const FIRST_FOV = 75; // wider: more sense of speed
const EYE_FORWARD = 0.1; // camera this far in front of the head's centre (at the goggles)
const EYE_UP = 0.03;
const GROUND_LOOK = 7; // on the snow, look at the snow this far ahead...
const GROUND_LOOK_HEIGHT = 0.5; // ...this far above it (eyes level, horizon steady)
const TURN_RATE_GROUND = 9; // how quickly the view swings to follow (1/s)
const TURN_RATE_AIR = 14;

/**
 * The camera: third person (trailing behind the skier) or first person
 * (in the rider's head), switched with C.
 *
 * Third person eases towards a spot behind and above the skier, so speed
 * changes feel smooth rather than rigid.
 *
 * First person sits at the goggles of the visible (ragdoll) head. On the
 * snow it looks ahead along the direction of travel with a level horizon,
 * which is how a skier's eyes actually behave (the head stays steady while
 * the body works). In the air and in crashes it turns with the head, so
 * flips, spins and tumbles are felt from inside.
 */
export class ChaseCamera {
  firstPerson = false;

  private readonly desired = new THREE.Vector3();
  private readonly lookAt = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly centre = new THREE.Vector3();
  private readonly eye = new THREE.Vector3();
  private readonly headRot = new THREE.Quaternion();
  private readonly targetRot = new THREE.Quaternion();
  private readonly lookMatrix = new THREE.Matrix4();

  private readonly camera: THREE.PerspectiveCamera;
  private readonly target: Skier;

  constructor(camera: THREE.PerspectiveCamera, target: Skier) {
    this.camera = camera;
    this.target = target;
  }

  /** Switch between first and third person. */
  toggle(): void {
    this.firstPerson = !this.firstPerson;
    this.target.firstPerson = this.firstPerson;
    this.camera.fov = this.firstPerson ? FIRST_FOV : THIRD_FOV;
    this.camera.near = this.firstPerson ? 0.03 : 0.1;
    this.camera.updateProjectionMatrix();
    this.snap();
  }

  private computeThird(): void {
    // Follow the centre of mass, which stays steady while the skier flips
    // or tumbles (the feet swing around it)
    const p = this.target.centre(this.centre);
    // Follow the direction of travel, not the way the rider faces, so the
    // camera stays steady while it spins in the air
    const h = this.target.travelHeading();
    const f = this.forward.set(-Math.sin(h), 0, -Math.cos(h));
    // Height is measured from the snow under the camera, not from the skier:
    // on a steep slope the ground behind is higher than the skier's feet.
    const x = p.x - f.x * DISTANCE;
    const z = p.z - f.z * DISTANCE;
    // In the air, also stay a little above the skier so big jumps stay in view.
    const y = Math.max(heightAt(x, z) + HEIGHT, p.y + 0.6);
    this.desired.set(x, y, z);
    this.lookAt.set(p.x + f.x * LOOK_AHEAD, p.y + 0.1, p.z + f.z * LOOK_AHEAD);
  }

  /** First person: where the eye is and which way it should face. */
  private computeFirst(): boolean {
    const skier = this.target;
    skier.eyes(this.eye, this.headRot);
    // Sit at the goggles, a little in front of the head's centre
    this.eye.add(this.forward.set(0, EYE_UP, -EYE_FORWARD).applyQuaternion(this.headRot));

    const riding = skier.mode === 'riding';
    if (riding && skier.grounded) {
      // On the snow: look ahead along the way we're going, a little above
      // the snow there, with the world's up (a steady, level horizon)
      const h = skier.travelHeading();
      const ax = this.eye.x - Math.sin(h) * GROUND_LOOK;
      const az = this.eye.z - Math.cos(h) * GROUND_LOOK;
      this.lookAt.set(ax, heightAt(ax, az) + GROUND_LOOK_HEIGHT, az);
      this.lookMatrix.lookAt(this.eye, this.lookAt, UP);
      this.targetRot.setFromRotationMatrix(this.lookMatrix);
    } else {
      // In the air (and tumbling): turn with the head. The head is tilted
      // forward with the chest; tilt the view back up by as much so a
      // crouched rider looks ahead, not at their skis.
      const lift = riding ? skier.headPitch : 0;
      this.targetRot.copy(this.headRot).multiply(TMP_Q.setFromAxisAngle(X_AXIS, lift));
    }
    return riding && skier.grounded;
  }

  /** Jump straight to the ideal position (on start and restart). */
  snap(): void {
    if (this.firstPerson) {
      this.computeFirst();
      this.camera.position.copy(this.eye);
      this.camera.quaternion.copy(this.targetRot);
      return;
    }
    this.computeThird();
    this.camera.position.copy(this.desired);
    this.camera.lookAt(this.lookAt);
  }

  update(dt: number): void {
    if (this.firstPerson) {
      const onSnow = this.computeFirst();
      // The eye stays in the head; the view turns smoothly (frame-rate
      // independent), a little quicker in the air to keep up with tricks
      this.camera.position.copy(this.eye);
      const rate = onSnow ? TURN_RATE_GROUND : TURN_RATE_AIR;
      this.camera.quaternion.slerp(this.targetRot, 1 - Math.exp(-rate * dt));
      return;
    }
    this.computeThird();
    // Frame-rate independent smoothing
    const t = 1 - Math.exp(-STIFFNESS * dt);
    this.camera.position.lerp(this.desired, t);
    this.camera.lookAt(this.lookAt);
  }
}

const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const TMP_Q = new THREE.Quaternion();
