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
import { heightAt, KICKER, MAP, setPlacedKickers, type PlacedKicker } from './terrain';
import type { Physics, RAPIER } from './physics';

/**
 * Kickers the player places in the backcountry (see BuildMode).
 *
 * Each one is part of the ground (terrain.ts adds its shape to heightAt), so
 * the rider takes off from it like any other jump; here it gets a mesh to
 * see and a collider for the ragdoll to hit. They're saved in this browser,
 * per map.
 */

const MAX_KICKERS = 25;
const GRID = { along: 22, across: 12 }; // mesh resolution

export class Kickers {
  readonly group = new THREE.Group();
  private readonly list: PlacedKicker[] = [];
  private readonly meshes: THREE.Mesh[] = [];
  private readonly colliders: RAPIER.Collider[] = [];
  private readonly physics: Physics;
  private readonly key = `jibnut.kickers.${MAP.id}`;
  private readonly snow = new THREE.MeshStandardMaterial({ color: 0xf6f8fb, roughness: 0.85 });
  private readonly dye = new THREE.MeshStandardMaterial({ color: 0x2f6fd6, roughness: 0.9, side: THREE.DoubleSide });

  constructor(physics: Physics) {
    this.physics = physics;
    let saved: PlacedKicker[] = [];
    try {
      saved = JSON.parse(localStorage.getItem(this.key) ?? '[]') as PlacedKicker[];
    } catch {
      // storage blocked or garbled: start with none
    }
    for (const k of saved.slice(0, MAX_KICKERS)) this.add(k, false);
  }

  get count(): number {
    return this.list.length;
  }

  get full(): boolean {
    return this.list.length >= MAX_KICKERS;
  }

  /** Place one (it's rideable at once). */
  add(k: PlacedKicker, save = true): void {
    if (this.full) return;
    this.list.push({ ...k });
    setPlacedKickers(this.list);
    // Rebuild every mesh: a new kicker can overlap an old one's ground
    this.rebuild();
    if (save) this.save();
  }

  /** Take the last one away. */
  undo(): void {
    if (!this.list.length) return;
    this.list.pop();
    setPlacedKickers(this.list);
    this.rebuild();
    this.save();
  }

  clear(): void {
    this.list.length = 0;
    setPlacedKickers(this.list);
    this.rebuild();
    this.save();
  }

  private save(): void {
    try {
      localStorage.setItem(this.key, JSON.stringify(this.list));
    } catch {
      // storage blocked: they still stand for this visit
    }
  }

  private rebuild(): void {
    for (const m of this.meshes) {
      m.removeFromParent();
      m.geometry.dispose();
    }
    for (const c of this.colliders) this.physics.removeCollider(c);
    this.meshes.length = 0;
    this.colliders.length = 0;
    for (const k of this.list) {
      const geo = kickerGeometry(k, 0.02);
      const mesh = new THREE.Mesh(geo, this.snow);
      mesh.castShadow = mesh.receiveShadow = true;
      this.group.add(mesh);
      this.meshes.push(mesh);
      const lip = lipLine(k);
      const dye = new THREE.Mesh(lip, this.dye);
      this.group.add(dye);
      this.meshes.push(dye);
      this.colliders.push(this.physics.addStaticMesh(kickerGeometry(k, 0)));
    }
  }
}

/**
 * The kicker's surface, sampled from the ground (which includes it) over its
 * footprint, in world space, lifted a little so it sits over the snow mesh.
 */
export function kickerGeometry(k: PlacedKicker, lift: number): THREE.BufferGeometry {
  const fx = -Math.sin(k.yaw);
  const fz = -Math.cos(k.yaw);
  const sx = -fz; // across
  const sz = fx;
  const halfW = KICKER.halfWidth + KICKER.side;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= GRID.along; i++) {
    const along = -KICKER.length / 2 - 0.3 + ((KICKER.length + 1) * i) / GRID.along;
    for (let j = 0; j <= GRID.across; j++) {
      const across = -halfW + (2 * halfW * j) / GRID.across;
      const x = k.x + fx * along + sx * across;
      const z = k.z + fz * along + sz * across;
      pos.push(x, heightAt(x, z) + lift, z);
      if (i < GRID.along && j < GRID.across) {
        const a = i * (GRID.across + 1) + j;
        const b = a + GRID.across + 1;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // Face up, whichever way round the grid came out
  const n = geo.attributes.normal as THREE.BufferAttribute;
  if (n.count && n.getY(Math.floor(n.count / 2)) < 0) {
    for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
    geo.setIndex(idx);
    geo.computeVertexNormals();
  }
  return geo;
}

/** A blue dye line along the lip, as on a park kicker. */
function lipLine(k: PlacedKicker): THREE.BufferGeometry {
  const fx = -Math.sin(k.yaw);
  const fz = -Math.cos(k.yaw);
  const pos: number[] = [];
  const idx: number[] = [];
  const steps = 10;
  for (let j = 0; j <= steps; j++) {
    const across = -KICKER.halfWidth + (2 * KICKER.halfWidth * j) / steps;
    for (const along of [KICKER.length / 2 - 0.45, KICKER.length / 2 - 0.05]) {
      const x = k.x + fx * along - fz * across;
      const z = k.z + fz * along + fx * across;
      pos.push(x, heightAt(x, z) + 0.04, z);
    }
    if (j < steps) {
      const a = j * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}
