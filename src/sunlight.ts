import * as THREE from 'three';
import { CSM } from 'three/addons/csm/CSM.js';
import { SUN_DIRECTION } from './sky';

/**
 * The sun, with cascaded shadow maps: the view is split into distance
 * bands, each with its own shadow map, so shadows are sharp near the rider
 * and still there far down the hill (jumps, cliffs and trees out to
 * MAX_SHADOW_DISTANCE cast them).
 *
 * Every lit material needs a small shader addition for it; materials made
 * later (clothes changed in the locker, a new ragdoll) are picked up as
 * they appear.
 */

const MAX_SHADOW_DISTANCE = 400; // m
const CASCADES = 3;
const MAP_SIZE = 2048;
const INTENSITY = 3.4;
const COLOR = 0xfff1df; // a warm sun

export class Sunlight {
  private readonly csm: CSM;
  private readonly scene: THREE.Scene;
  private readonly done = new WeakSet<THREE.Material>();

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.scene = scene;
    this.csm = new CSM({
      camera,
      parent: scene,
      cascades: CASCADES,
      maxFar: MAX_SHADOW_DISTANCE,
      mode: 'practical', // more detail close up, where the rider is
      shadowMapSize: MAP_SIZE,
      lightDirection: SUN_DIRECTION.clone().negate(), // the way the light travels
      lightIntensity: INTENSITY,
      lightMargin: 120, // tall things just outside a band still cast into it
      shadowBias: -0.0002,
    });
    this.csm.fade = true; // blend between bands instead of a visible seam
    for (const light of this.csm.lights) {
      light.color.set(COLOR);
      light.shadow.normalBias = 0.04; // no speckled "acne" on the snow
    }
  }

  /** Call after the camera's field of view or aspect changes. */
  updateFrustums(): void {
    this.csm.updateFrustums();
  }

  /** Once a frame, before rendering. */
  update(): void {
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        if (this.done.has(m)) continue;
        this.done.add(m);
        const lit = m as THREE.MeshStandardMaterial;
        if (lit.isMeshStandardMaterial || (m as THREE.MeshLambertMaterial).isMeshLambertMaterial || (m as THREE.MeshPhongMaterial).isMeshPhongMaterial) {
          this.csm.setupMaterial(m);
          m.needsUpdate = true;
        }
      }
    });
    this.csm.update();
  }
}
