import RAPIER from '@dimforge/rapier3d-compat';
import type * as THREE from 'three';
import { terrainGeometry } from './terrain';

export { RAPIER };

const STEP = 1 / 120; // fixed physics timestep: fine steps keep ragdoll joints together in hard impacts

/**
 * The Rapier collision world: the terrain (course and surrounding mountain)
 * as triangle meshes. The skier's riding stays hand-written; this world
 * answers "is the body touching anything?" and simulates the skier once
 * they crash.
 */
export class Physics {
  readonly world: RAPIER.World;
  /** The terrain's colliders (course, then mountain). */
  readonly terrain: RAPIER.Collider[] = [];
  private accumulator = 0;

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = STEP;
    // Chains of joints (the ragdoll) need extra solver passes: at 8, a loose
    // knee could be forced 45° past its limit in a tumble; at 16 it holds.
    this.world.numSolverIterations = 16;
    this.addTerrain();
    this.world.step(); // build the query structures for the static colliders
  }

  /** Load the WebAssembly module and build the world. */
  static async create(): Promise<Physics> {
    await RAPIER.init();
    return new Physics();
  }

  /**
   * The terrain as triangle meshes, built from the same geometry as the
   * visible surfaces. (A Rapier heightfield would be lighter, but its capsule
   * overlap test never reports a hit, so the body would pass straight
   * through the snow.)
   */
  private addTerrain(): void {
    const { course, outer } = terrainGeometry();
    for (const geo of [course, outer]) {
      const vertices = geo.attributes.position.array as Float32Array;
      const indices = geo.index!.array as Uint32Array;
      this.terrain.push(
        this.world.createCollider(
          RAPIER.ColliderDesc.trimesh(vertices, indices, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES).setFriction(0.5),
        ),
      );
    }
  }

  /** Does a shape at this pose overlap the terrain? */
  shapeHits(shape: RAPIER.Shape, pos: THREE.Vector3, rot: THREE.Quaternion): boolean {
    let hit = false;
    this.world.intersectionsWithShape(
      pos,
      rot,
      shape,
      () => {
        hit = true;
        return false; // one is enough, stop searching
      },
      RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC, // only the static world
    );
    return hit;
  }

  /** Advance the simulation by real elapsed time, in fixed steps. */
  step(dt: number): void {
    this.accumulator = Math.min(this.accumulator + dt, 0.05); // cap catch-up after a stall
    while (this.accumulator >= STEP) {
      this.world.step();
      this.accumulator -= STEP;
    }
  }
}
