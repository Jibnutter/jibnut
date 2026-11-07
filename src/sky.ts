import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

/**
 * The sky: a physically based atmosphere (Rayleigh and Mie scattering) with
 * a sun disc and drifting clouds (three.js's Sky shader). It's a big box
 * that follows the camera, so it's always the backdrop.
 *
 * The sun in the sky and the sun that lights the scene point the same way
 * (SUN_DIRECTION), so shadows fall where the sky says they should.
 */

/** Towards the sun: a clear afternoon sun, about 40° up, behind and right of the downhill view. */
export const SUN_DIRECTION = new THREE.Vector3(0.62, 0.62, 0.48).normalize();

const SKY_GAIN = 0.45;

export class SkyDome {
  readonly mesh: Sky;
  private time = 0;

  constructor() {
    this.mesh = new Sky();
    // Inside the camera's far plane (2000 m): the corners must be too
    this.mesh.scale.setScalar(1500);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1; // drawn first, behind everything
    // The sky's own brightness, separate from the scene's exposure (at the
    // scene's exposure the physical sky was so bright that tone mapping
    // washed it out to a pale haze)
    const mat = this.mesh.material;
    mat.uniforms.skyGain = { value: SKY_GAIN };
    mat.fragmentShader = mat.fragmentShader
      .replace('void main() {', 'uniform float skyGain;\nvoid main() {')
      .replace('gl_FragColor = vec4( texColor, 1.0 );', 'gl_FragColor = vec4( texColor * skyGain, 1.0 );');
    const u = mat.uniforms;
    u.turbidity.value = 2; // clear mountain air
    u.rayleigh.value = 2.6; // a deep blue
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.85; // a tight glow round the sun
    u.sunPosition.value.copy(SUN_DIRECTION);
    // Fair-weather cumulus: broken cloud, fairly high, drifting slowly
    u.cloudCoverage.value = 0.42;
    u.cloudDensity.value = 0.55;
    u.cloudElevation.value = 0.55;
    u.cloudScale.value = 0.00025;
    u.cloudSpeed.value = 0.00004;
  }

  update(dt: number, camera: THREE.Camera): void {
    this.time += dt;
    this.mesh.material.uniforms.time.value = this.time;
    this.mesh.position.copy(camera.position);
  }
}
