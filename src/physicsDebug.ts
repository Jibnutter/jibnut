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
import type { Physics } from './physics';

/**
 * Draws Rapier's colliders as lines: the tumbling skier's ragdoll.
 * The terrain is left out: it's huge and the snow already shows it.
 */
export class PhysicsDebug {
  readonly lines: THREE.LineSegments;
  private readonly physics: Physics;

  constructor(physics: Physics) {
    this.physics = physics;
    this.lines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true }),
    );
    this.lines.renderOrder = 1; // draw on top of everything
    this.lines.frustumCulled = false;
    this.lines.visible = false;
  }

  get visible(): boolean {
    return this.lines.visible;
  }
  set visible(on: boolean) {
    this.lines.visible = on;
  }

  update(): void {
    if (!this.lines.visible) return;
    const { vertices, colors } = this.physics.world.debugRender(
      undefined,
      (c) => !this.physics.terrain.includes(c),
    );
    const geo = this.lines.geometry;
    geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  }
}
