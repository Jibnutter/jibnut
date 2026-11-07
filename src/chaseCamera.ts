import * as THREE from 'three';
import { heightAt } from './terrain';
import type { Skier } from './skier';

const DISTANCE = 7; // metres behind the skier
const HEIGHT = 3; // metres above the snow under the camera
const LOOK_AHEAD = 4; // look at a point this far in front of the skier
const STIFFNESS = 4; // higher = camera catches up faster

/**
 * Third-person camera that trails behind the skier and swings round as it
 * turns. It eases towards its ideal spot each frame, so speed changes feel smooth rather than rigid.
 */
export class ChaseCamera {
  private readonly desired = new THREE.Vector3();
  private readonly lookAt = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly centre = new THREE.Vector3();

  private readonly camera: THREE.PerspectiveCamera;
  private readonly target: Skier;

  constructor(camera: THREE.PerspectiveCamera, target: Skier) {
    this.camera = camera;
    this.target = target;
  }

  private computeDesired(): void {
    // Follow the centre of mass, which stays steady while the skier flips
    // or tumbles (the feet swing around it)
    const p = this.target.centre(this.centre);
    // Follow the direction of travel, not the way the bean faces, so the
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

  /** Jump straight to the ideal position (on start and restart). */
  snap(): void {
    this.computeDesired();
    this.camera.position.copy(this.desired);
    this.camera.lookAt(this.lookAt);
  }

  update(dt: number): void {
    this.computeDesired();
    // Frame-rate independent smoothing
    const t = 1 - Math.exp(-STIFFNESS * dt);
    this.camera.position.lerp(this.desired, t);
    this.camera.lookAt(this.lookAt);
  }
}
