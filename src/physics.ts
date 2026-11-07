// Jibnut
// Copyright (C) 2026 Frans Ljung
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE
// file for details.

import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { terrainGeometry } from './terrain';
import { railSegments, RAIL_RADIUS } from './rails';

export { RAPIER };

// Fixed physics timestep. The always-on ragdoll stands on skis that stop
// dead when they land: at 120 Hz its knees and hips pulled apart by up to
// 47 cm for a frame on big landings; at 240 Hz, 8 cm. (More solver passes
// at 120 Hz didn't help.)
const STEP = 1 / 240;

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
    // Rails: a capsule along each straight piece of bar (slippery steel)
    for (const [a, b] of railSegments()) {
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const along = b.clone().sub(a);
      const rot = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), along.clone().normalize());
      this.world.createCollider(
        RAPIER.ColliderDesc.capsule(along.length() / 2, RAIL_RADIUS)
          .setTranslation(mid.x, mid.y, mid.z)
          .setRotation(rot)
          .setFriction(0.1),
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
      // Only the static world: not the ragdoll's bodies, including its skis,
      // which the controller moves directly (kinematic) while riding
      RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC,
    );
    return hit;
  }

  /**
   * Advance the simulation by real elapsed time, in fixed steps.
   * beforeSubstep(alpha) runs before each one, alpha going from just above
   * 0 to 1 across this frame's steps (for moving kinematic bodies smoothly).
   */
  step(dt: number, beforeSubstep?: (alpha: number) => void): void {
    this.accumulator = Math.min(this.accumulator + dt, 0.05); // cap catch-up after a stall
    const n = Math.floor(this.accumulator / STEP);
    for (let i = 1; i <= n; i++) {
      beforeSubstep?.(i / n);
      this.world.step();
      this.accumulator -= STEP;
    }
  }
}
