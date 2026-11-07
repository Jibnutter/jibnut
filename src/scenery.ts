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
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  heightAt,
  courseX,
  mulberry32,
  COURSE_HALF,
  MAX_Z,
  DECK_END_Z,
  FINISH_Z,
  END_Z,
  MOUNTAIN_TOP_Z,
  MOUNTAIN_BOTTOM_Z,
  EDGE_LIMIT,
  IS_PARK,
} from './terrain';

/**
 * Everything around the course that isn't snow: the chairlift up the right
 * side, trees, the start hut and gate, the finish arch and fencing, and
 * marker poles along the edges. Visual only: none of it has colliders.
 */

// ---------------------------------------------------------------------------
// Chairlift

const LIFT_X = 62; // the lift line runs down the right side of the course
const LIFT_GAUGE = 2.6; // half the distance between the up and down cables
const TOWER_SPACING = 55;
const TOWER_HEIGHT = 11;
const CHAIR_SPACING = 16; // metres of cable between chairs
const LIFT_SPEED = 4.5; // m/s
const CHAIR_DROP = 2.6; // how far a chair hangs below the cable

/** A path through points, measured by distance along it. */
class Path {
  private readonly pts: THREE.Vector3[];
  private readonly dist: number[] = [0];
  readonly length: number;
  constructor(points: THREE.Vector3[]) {
    this.pts = points;
    for (let i = 1; i < points.length; i++) this.dist.push(this.dist[i - 1] + points[i].distanceTo(points[i - 1]));
    this.length = this.dist[this.dist.length - 1];
  }
  at(d: number, out: THREE.Vector3): THREE.Vector3 {
    d = ((d % this.length) + this.length) % this.length;
    let i = 1;
    while (i < this.dist.length - 1 && this.dist[i] < d) i++;
    const t = (d - this.dist[i - 1]) / (this.dist[i] - this.dist[i - 1] || 1);
    return out.lerpVectors(this.pts[i - 1], this.pts[i], t);
  }
}

class Chairlift {
  readonly group = new THREE.Group();
  private readonly loop: Path;
  private readonly chairs: THREE.InstancedMesh;
  private readonly count: number;
  private travelled = 0;

  constructor() {
    const topZ = MAX_Z + 25; // top station, just above the start
    const bottomZ = FINISH_Z - 30; // bottom station, beside the finish
    const steel = new THREE.MeshStandardMaterial({ color: 0x8a939c, metalness: 0.6, roughness: 0.4 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.6 });

    // Towers, evenly spaced; cable height = tower tops
    const towerZs: number[] = [];
    const n = Math.max(2, Math.round((topZ - bottomZ) / TOWER_SPACING));
    for (let i = 1; i < n; i++) towerZs.push(bottomZ + ((topZ - bottomZ) * i) / n);
    const cableHeight = (z: number) => heightAt(LIFT_X, z) + TOWER_HEIGHT;

    for (const z of towerZs) {
      const base = heightAt(LIFT_X, z);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, TOWER_HEIGHT, 10), steel);
      pole.position.set(LIFT_X, base + TOWER_HEIGHT / 2, z);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(LIFT_GAUGE * 2 + 1.2, 0.35, 0.5), steel);
      arm.position.set(LIFT_X, base + TOWER_HEIGHT + 0.3, z);
      this.group.add(pole, arm);
      for (const side of [-1, 1]) {
        const sheaves = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 2.2), dark);
        sheaves.position.set(LIFT_X + side * LIFT_GAUGE, base + TOWER_HEIGHT + 0.05, z);
        this.group.add(sheaves);
      }
    }

    // Stations: a building with the bullwheel the cable turns around
    for (const [z, facing] of [
      [topZ, 1],
      [bottomZ, -1],
    ] as const) {
      const base = heightAt(LIFT_X, z);
      const house = new THREE.Mesh(
        new THREE.BoxGeometry(9, 5, 8),
        new THREE.MeshStandardMaterial({ color: 0x9b4a32, roughness: 0.8 }),
      );
      house.position.set(LIFT_X + 9, base + 2.2, z + facing * 2);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(10, 0.5, 9), dark);
      roof.position.set(LIFT_X + 9, base + 4.9, z + facing * 2);
      const wheel = new THREE.Mesh(new THREE.TorusGeometry(LIFT_GAUGE, 0.18, 8, 32), dark);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(LIFT_X, cableHeight(z), z);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.8, TOWER_HEIGHT, 10), steel);
      post.position.set(LIFT_X, base + TOWER_HEIGHT / 2, z);
      for (const m of [house, roof, wheel, post]) m.castShadow = true;
      this.group.add(house, roof, wheel, post);
    }

    // The cable loop: up the right line, round the top wheel, down the left
    const stops = [bottomZ, ...towerZs, topZ];
    const line = (side: number, zs: number[]) => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < zs.length - 1; i++) {
        // Sag between supports: a gentle parabola, 0.6 m deep in the middle
        for (let k = 0; k < 8; k++) {
          const t = k / 8;
          const z = zs[i] + (zs[i + 1] - zs[i]) * t;
          const y = cableHeight(zs[i]) + (cableHeight(zs[i + 1]) - cableHeight(zs[i])) * t - 0.6 * 4 * t * (1 - t);
          pts.push(new THREE.Vector3(LIFT_X + side * LIFT_GAUGE, y, z));
        }
      }
      const last = zs[zs.length - 1];
      pts.push(new THREE.Vector3(LIFT_X + side * LIFT_GAUGE, cableHeight(last), last));
      return pts;
    };
    const up = line(1, stops);
    const down = line(-1, [...stops].reverse());
    this.loop = new Path([...up, ...down, up[0]]);

    // Draw the two cables
    const cableMat = new THREE.LineBasicMaterial({ color: 0x222222 });
    for (const pts of [up, down]) this.group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), cableMat));

    // Chairs: one merged model, instanced along the loop
    const parts = [
      new THREE.BoxGeometry(0.08, CHAIR_DROP, 0.08).translate(0, -CHAIR_DROP / 2, 0), // hanger
      new THREE.BoxGeometry(1.6, 0.1, 0.6).translate(0, -CHAIR_DROP, 0.1), // seat
      new THREE.BoxGeometry(1.6, 0.7, 0.08).translate(0, -CHAIR_DROP + 0.38, 0.38), // back
      new THREE.BoxGeometry(1.6, 0.06, 0.06).translate(0, -CHAIR_DROP + 0.7, -0.35), // safety bar
    ];
    this.count = Math.floor(this.loop.length / CHAIR_SPACING);
    this.chairs = new THREE.InstancedMesh(
      mergeGeometries(parts),
      new THREE.MeshStandardMaterial({ color: 0x3a4a5c, metalness: 0.3, roughness: 0.5 }),
      this.count,
    );
    this.chairs.castShadow = true;
    this.chairs.frustumCulled = false;
    this.group.add(this.chairs);
    this.update(0);
  }

  update(dt: number): void {
    this.travelled += LIFT_SPEED * dt;
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const ahead = new THREE.Vector3();
    for (let i = 0; i < this.count; i++) {
      const d = this.travelled + i * CHAIR_SPACING;
      this.loop.at(d, p);
      this.loop.at(d + 1, ahead);
      // Chairs face along their travel, hanging straight down
      const yaw = Math.atan2(ahead.x - p.x, ahead.z - p.z);
      m.makeRotationY(yaw).setPosition(p);
      this.chairs.setMatrixAt(i, m);
    }
    this.chairs.instanceMatrix.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Trees

function createTrees(): THREE.Group {
  const rand = mulberry32(42);
  const spots: THREE.Vector3[] = [];
  for (let tries = 0; spots.length < 1400 && tries < 20000; tries++) {
    const side = rand() < 0.5 ? -1 : 1;
    const z = MOUNTAIN_BOTTOM_Z + 30 + rand() * (MOUNTAIN_TOP_Z - MOUNTAIN_BOTTOM_Z);
    const x = courseX(z) + side * (EDGE_LIMIT + 11 + Math.pow(rand(), 0.7) * 190); // clear of the course
    if (IS_PARK) {
      if (Math.abs(x - LIFT_X) < 9) continue; // keep the lift line clear
      if (x > LIFT_X && x < LIFT_X + 18 && (z > MAX_Z || z < FINISH_Z - 10)) continue; // station clearings
    }
    // Patchy forest: skip where a slow wave says "clearing"
    if (Math.sin(x * 0.045) + Math.sin(z * 0.03 + 1) < -0.6) continue;
    spots.push(new THREE.Vector3(x, heightAt(x, z), z));
  }

  const foliage = mergeGeometries([
    new THREE.ConeGeometry(2.2, 4.5, 8).translate(0, 3.5, 0),
    new THREE.ConeGeometry(1.7, 3.8, 8).translate(0, 5.6, 0),
    new THREE.ConeGeometry(1.1, 3, 8).translate(0, 7.6, 0),
  ]);
  const trunk = new THREE.CylinderGeometry(0.25, 0.35, 2, 6).translate(0, 1, 0);
  const leaves = new THREE.InstancedMesh(foliage, new THREE.MeshStandardMaterial({ color: 0x2f5a3c, roughness: 0.9 }), spots.length);
  const wood = new THREE.InstancedMesh(trunk, new THREE.MeshStandardMaterial({ color: 0x4a3426, roughness: 0.9 }), spots.length);
  leaves.castShadow = wood.castShadow = true; // (long shadows across the snow)
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const tint = new THREE.Color();
  spots.forEach((p, i) => {
    const s = 0.7 + rand() * 0.8;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI * 2);
    m.compose(p, q, scale.set(s, s * (0.9 + rand() * 0.3), s));
    leaves.setMatrixAt(i, m);
    wood.setMatrixAt(i, m);
    // A little variety in the greens, some with a dusting of snow
    leaves.setColorAt(i, tint.setHSL(0.38 + rand() * 0.05, 0.3 + rand() * 0.15, 0.22 + rand() * 0.12));
  });
  const group = new THREE.Group();
  group.add(leaves, wood);
  return group;
}

// ---------------------------------------------------------------------------
// Start, finish, fencing, poles

function bannerTexture(text: string, bg: string, fg: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 96;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 512, 96);
  ctx.fillStyle = fg;
  ctx.font = 'bold 64px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, 52);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Two posts and a banner across the course at world z. */
function arch(z: number, halfSpan: number, height: number, text: string, color: string): THREE.Group {
  const group = new THREE.Group();
  const cx = courseX(z); // (centred on the course where it bends)
  const postMat = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
  for (const side of [-1, 1]) {
    const x = cx + side * halfSpan;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.6, height, 0.6), postMat);
    post.position.set(x, heightAt(x, z) + height / 2, z);
    post.castShadow = true;
    group.add(post);
  }
  const y = Math.max(heightAt(cx - halfSpan, z), heightAt(cx + halfSpan, z)) + height - 0.6;
  const banner = new THREE.Mesh(
    new THREE.PlaneGeometry(halfSpan * 2, 1.2),
    new THREE.MeshStandardMaterial({ map: bannerTexture(text, color, '#ffffff'), side: THREE.DoubleSide }),
  );
  banner.position.set(cx, y, z);
  group.add(banner);
  return group;
}

/** Orange netting along a line of points, on posts. */
function fence(points: [number, number][], height = 1.2): THREE.Group {
  const group = new THREE.Group();
  const pos: number[] = [];
  const idx: number[] = [];
  points.forEach(([x, z], i) => {
    const g = heightAt(x, z);
    pos.push(x, g, z, x, g + height, z);
    if (i > 0) {
      const a = (i - 1) * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  });
  const net = new THREE.BufferGeometry();
  net.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  net.setIndex(idx);
  net.computeVertexNormals();
  group.add(
    new THREE.Mesh(
      net,
      new THREE.MeshStandardMaterial({ color: 0xff6a1a, transparent: true, opacity: 0.75, side: THREE.DoubleSide }),
    ),
  );
  return group;
}

function startHut(): THREE.Group {
  const group = new THREE.Group();
  const z = MAX_Z - 4;
  const x = -12;
  const base = heightAt(x, z);
  const hut = new THREE.Mesh(
    new THREE.BoxGeometry(5, 3, 4),
    new THREE.MeshStandardMaterial({ color: 0x6b4a33, roughness: 0.9 }),
  );
  hut.position.set(x, base + 1.4, z);
  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(4, 1.6, 4),
    new THREE.MeshStandardMaterial({ color: 0x8a2f2f, roughness: 0.8 }),
  );
  roof.rotation.y = Math.PI / 4;
  roof.position.set(x, base + 3.7, z);
  hut.castShadow = roof.castShadow = true;
  group.add(hut, roof);
  return group;
}

/** Red and blue poles marking both edges of the course. */
function edgePoles(): THREE.InstancedMesh {
  const zs: number[] = [];
  for (let z = DECK_END_Z; z > FINISH_Z; z -= 10) zs.push(z);
  const poles = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.05, 0.05, 1.6, 6).translate(0, 0.8, 0),
    new THREE.MeshStandardMaterial({ roughness: 0.5 }),
    zs.length * 2,
  );
  const m = new THREE.Matrix4();
  const color = new THREE.Color();
  let i = 0;
  for (const z of zs) {
    for (const side of [-1, 1]) {
      const x = courseX(z) + side * (COURSE_HALF + 0.5);
      m.makeTranslation(x, heightAt(x, z), z);
      poles.setMatrixAt(i, m);
      poles.setColorAt(i, color.set(side < 0 ? 0xd0312d : 0x2f6fd6));
      i++;
    }
  }
  return poles;
}

export class Scenery {
  readonly group = new THREE.Group();
  private readonly lift: Chairlift | null = IS_PARK ? new Chairlift() : null;

  constructor() {
    this.group.add(createTrees());
    // The backcountry is just the mountain and its trees, and a finish
    // arch down in the valley
    if (!this.lift) {
      this.group.add(arch(FINISH_Z, 24, 7.5, 'FINISH', '#c0392b'));
      return;
    }
    this.group.add(this.lift.group, startHut(), edgePoles());
    // Banners hang high so the chase camera passes underneath
    this.group.add(arch(DECK_END_Z + 2, 8, 7.5, 'START', '#1f5fbf'));
    this.group.add(arch(FINISH_Z, 16, 7.5, 'FINISH', '#c0392b'));

    // Netting across the bottom of the braking zone and along the finish
    const across: [number, number][] = [];
    for (let x = -COURSE_HALF - 2; x <= COURSE_HALF + 2; x += 2) across.push([x, END_Z - 6]);
    this.group.add(fence(across, 1.6));
    for (const side of [-1, 1]) {
      const along: [number, number][] = [];
      for (let z = FINISH_Z; z >= END_Z - 6; z -= 2) along.push([side * (COURSE_HALF + 1), z]);
      this.group.add(fence(along));
    }
  }

  update(dt: number): void {
    this.lift?.update(dt);
  }
}
