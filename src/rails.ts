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
import { courseX, heightAt, normalAt, JUMPS, MAP } from './terrain';

/**
 * Rails: steel bars to slide along (grind).
 *
 * A rail is a line of points along its top. Riders ride on it the same way
 * they ride on snow, with the rail as the ground: railAt() tells the skier
 * whether the rail is under them and how high its top is there. The first
 * stretch is a ride-on: it starts at the snow and kinks up, so you can ride
 * straight onto it; you can also ollie or drop onto it from above.
 *
 * Its shape is built from the terrain (heights from heightAt), so this has
 * no DOM: physics builds the rail's colliders from it too.
 */

export const RAIL_RADIUS = 0.035; // the steel bar
/** How far to either side of the bar the skis still sit on it (they're wide). */
const CATCH = 0.3;

export interface Rail {
  /** Points along the top of the bar, uphill end first. */
  points: THREE.Vector3[];
}

/**
 * A ride-on down rail on the side path to the right of the first jump,
 * alongside its takeoff and table. (The side path there is one steady
 * slope, so a straight bar stays the same height above it.)
 */
function sideRail(): Rail {
  const j = JUMPS[0];
  const OFFSET = 16.5; // m right of the course's centreline
  const HEIGHT = 0.55; // bar top above the snow
  const at = (z: number, h: number) => {
    const x = courseX(z) + OFFSET;
    return new THREE.Vector3(x, heightAt(x, z) + h, z);
  };
  const start = j.startZ - 8; // just before the side path steepens into the slope
  return {
    points: [
      // Ride-on: starts at the snow and curves up gently (several small
      // bends: one sharp kink would throw a fast rider into the air) ...
      at(start, 0.03),
      at(start - 2, 0.12),
      at(start - 4, 0.3),
      at(start - 6, 0.47),
      at(start - 8, HEIGHT),
      // ... then runs straight down beside the jump
      at(start - 22, HEIGHT),
    ],
  };
}

/** The rails on this map (only Jumpline has one). */
export const RAILS: Rail[] = MAP.id === 'jumpline' ? [sideRail()] : [];

export interface RailContact {
  /** Height of the top of the bar here. */
  top: number;
  /** Along the bar, downhill (unit). */
  dir: THREE.Vector3;
  /** Square to the bar, upwards (unit): the "slope normal" on the rail. */
  normal: THREE.Vector3;
  /** The point on the bar's centreline nearest (x, z), at its top. */
  point: THREE.Vector3;
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

/** Is (x, z) over a rail? If so: its top there, and its direction. */
export function railAt(x: number, z: number, out?: RailContact): RailContact | null {
  for (const rail of RAILS) {
    const pts = rail.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len2 = dx * dx + dz * dz;
      const t = ((x - a.x) * dx + (z - a.z) * dz) / len2;
      if (t < 0 || t > 1) continue;
      const px = a.x + dx * t;
      const pz = a.z + dz * t;
      if (Math.hypot(x - px, z - pz) > CATCH) continue;
      const c = out ?? { top: 0, dir: new THREE.Vector3(), normal: new THREE.Vector3(), point: new THREE.Vector3() };
      c.top = a.y + (b.y - a.y) * t;
      c.point.set(px, c.top, pz);
      c.dir.subVectors(b, a).normalize();
      // Up, square to the bar: the bar's sideways direction × along it
      const side = tmpA.set(-dz, 0, dx).normalize();
      c.normal.crossVectors(tmpB.copy(c.dir), side).normalize();
      if (c.normal.y < 0) c.normal.negate();
      return c;
    }
  }
  return null;
}

/** The ground for riding: the snow, or the top of a rail where there is one. */
export function groundAt(x: number, z: number): number {
  const h = heightAt(x, z);
  const rail = railAt(x, z, tmpContact);
  return rail ? Math.max(h, rail.top) : h;
}
const tmpContact: RailContact = { top: 0, dir: new THREE.Vector3(), normal: new THREE.Vector3(), point: new THREE.Vector3() };

/** Each rail as straight segments of bar (centreline ends), for colliders. */
export function railSegments(): [THREE.Vector3, THREE.Vector3][] {
  const out: [THREE.Vector3, THREE.Vector3][] = [];
  for (const rail of RAILS) {
    for (let i = 0; i < rail.points.length - 1; i++) {
      const down = new THREE.Vector3(0, -RAIL_RADIUS, 0);
      out.push([rail.points[i].clone().add(down), rail.points[i + 1].clone().add(down)]);
    }
  }
  return out;
}

/** The rails as you see them: a steel bar on posts with base plates, ends capped. */
export function createRails(): THREE.Group {
  const group = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0xb9c0c8, roughness: 0.25, metalness: 0.9 });
  const paint = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.6, metalness: 0.3 });
  const accent = new THREE.MeshStandardMaterial({ color: 0xff7a1c, roughness: 0.5 });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    return m;
  };

  for (const [a, b] of railSegments()) {
    // The bar
    const along = new THREE.Vector3().subVectors(b, a);
    const len = along.length();
    const bar = add(new THREE.CylinderGeometry(RAIL_RADIUS, RAIL_RADIUS, len, 16), steel);
    bar.position.copy(a).addScaledVector(along, 0.5);
    bar.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), along.normalize());
    // A rounded joint at each kink and end
    for (const p of [a, b]) add(new THREE.SphereGeometry(RAIL_RADIUS, 16, 10), steel).position.copy(p);

    // Posts down to the snow where the bar is high enough to need them
    const steps = Math.floor(len / 2.5);
    for (let k = 0; k <= steps; k++) {
      const p = a.clone().lerp(b, steps ? k / steps : 0.5);
      const snow = heightAt(p.x, p.z);
      const h = p.y - RAIL_RADIUS - snow;
      if (h < 0.15) continue;
      const post = add(new THREE.CylinderGeometry(0.03, 0.03, h + 0.1, 10), paint);
      post.position.set(p.x, snow + (h - 0.1) / 2, p.z);
      // Base plate, lying flat on the slope, with an orange marker band
      const plate = add(new THREE.BoxGeometry(0.3, 0.05, 0.5), paint);
      plate.position.set(p.x, snow + 0.01, p.z);
      const up = normalAt(p.x, p.z);
      const side = new THREE.Vector3().crossVectors(up, along).normalize();
      const fwd = new THREE.Vector3().crossVectors(side, up);
      plate.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(side, up, fwd));
      const band = add(new THREE.CylinderGeometry(0.034, 0.034, 0.08, 10), accent);
      band.position.set(p.x, snow + h * 0.55, p.z);
    }
  }
  return group;
}
