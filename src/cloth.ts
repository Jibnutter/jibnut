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
import type { Segment } from './person';
import type { Ragdoll } from './ragdoll';

/**
 * Cloth garments (the shorts, the T-shirt): tubes of fabric worn over the
 * body's capsules.
 *
 * Every vertex is a particle (Verlet integration: it keeps its momentum),
 * and neighbouring particles are tied together by distance constraints:
 * along the rings and down the tubes (the weave), across the diagonals
 * (shear) and skipping one (so the fabric resists folding sharply).
 *
 * Each particle is also pulled gently towards where it sits on the body:
 * firmly at waistbands and cuffs, loosely elsewhere, so the loose parts
 * hang, swing and billow. Gravity pulls the fabric down, air drag makes it
 * trail at speed (with a little flutter), and it's kept outside the body's
 * capsules so it drapes round the limbs rather than through them.
 *
 * It follows the visible ragdoll, so it moves with the real body in tricks
 * and crashes.
 */

const SUBSTEPS = 3;
const ITERATIONS = 5; // constraint passes per substep
const GRAVITY = -9.81;
// Damping and drag act on the fabric's motion *relative to the body*: the
// body carries the clothes along. (Against still air, at 70 km/h they pulled
// every loose bit of fabric back at over 1 g and stretched it to 2-3x.)
const DAMPING = 0.96; // per substep, of the motion relative to the body
const WIND = 0.12; // 1/s: the oncoming air pushes loose fabric back (m/s² per m/s of speed)
const FLUTTER = 0.0025; // m of random jiggle per substep at 20 m/s
const MARGIN = 0.03; // fabric thickness kept outside the limbs
const SHEAR_STIFFNESS = 0.5;
const BEND_STIFFNESS = 0.25;
// Slack: fabric can't stretch but bunches up freely, and baggy clothes have
// extra length. Links only resist being pulled past rest × slack. Lots of
// slack over knees and elbows: bending them pulls the fabric apart.
// (With fixed lengths, a deep crouch stretched the knee fabric to 2-3x.)
const RING_SLACK = 1.05;
const LENGTH_SLACK = 1.2;
export const LOOSE_SLACK = 1.7;

/** A body part a ring hangs from: one bone, or [left, right] picked by side. */
export type BoneRef = number | [number, number];

/** A ring of fabric round a bone, in that bone's own frame. */
export interface ClothRing {
  bone: string; // named in the tube's bone map
  y: number; // along the bone (its local +Y runs from its first joint to its second)
  rx: number; // radius sideways (x) ...
  rz: number; // ... and front-to-back (z)
  cz?: number; // ring centre shifted backwards (+) from the bone
  cx?: number; // ... and out to the tube's side (mirrored for left/right tubes)
  /**
   * Also follows another bone, part of the way (linear blend): fabric round a
   * joint sits between the two parts. Weight at the front and at the back.
   */
  blend?: { bone: string; front: number; back: number };
  pin: number; // how firmly it's held to the body: fraction of the way per 1/60 s
  leash: number; // m: the furthest it can stray from its spot on the body
  /** Bones it's kept outside of (default: its own). */
  collide?: string[];
  /** Fabric thickness kept outside them (default MARGIN). */
  margin?: number;
  /** Fabric over a bending joint: links between two loose rings get LOOSE_SLACK. */
  loose?: boolean;
  /** A bum: the back pushed out this far (m) in two cheeks, with a crease between. */
  cheeks?: number;
  /** The ring lifted this far (m) at its front and back centres: arches between the legs. */
  crotch?: number;
}

/** How far round a ring the cheeks bulge (angle a: x = cos a, z = sin a; +z is the back). */
function cheekShape(a: number): number {
  const back = Math.PI / 2;
  const lobe = (c: number) => Math.exp(-(((a - c) / 0.5) ** 2));
  return lobe(back - 0.6) + lobe(back + 0.6); // (the crease: between the lobes, at the back centre)
}

/**
 * How much of the crotch lift a ring's point gets: narrow peaks at the front
 * and back centres, the back one lower (lifted fully there, it opened a dark
 * gap under the bum when sitting on the bike).
 */
function crotchShape(a: number): number {
  const s = Math.sin(a);
  return Math.abs(s) ** 8 * (s > 0 ? 0.35 : 1);
}

export interface ClothTube {
  rings: ClothRing[];
  segments: number; // particles round each ring
  bones: Record<string, BoneRef>;
  /** Which side a limb's tube is on: -1 left, +1 right; 0 for the body. */
  side: number;
}

interface Tube extends ClothTube {
  start: number; // first particle index
}

interface Constraint {
  a: number;
  b: number;
  rest: number;
  stiffness: number;
  /** Only resists stretching past rest (fabric bunches freely); else both ways. */
  slackOnly: boolean;
}

/** Pick a bone: on a body tube, a [left, right] pair by which side x is on. */
function resolve(ref: BoneRef, side: number): number {
  return typeof ref === 'number' ? ref : side < 0 ? ref[0] : ref[1];
}

/**
 * A finer mesh: between each pair of neighbouring key rings on the same bone,
 * add `extra` more rings (sizes, hold and leash interpolated).
 */
export function refine(keys: ClothRing[], extra = 1): ClothRing[] {
  const out: ClothRing[] = [];
  keys.forEach((ring, i) => {
    out.push(ring);
    const next = keys[i + 1];
    if (!next || next.bone !== ring.bone) return;
    for (let e = 1; e <= extra; e++) {
      const t = e / (extra + 1);
      const mix = (a: number, b: number) => a + (b - a) * t;
      const blend = ring.blend ?? next.blend;
      out.push({
        bone: ring.bone,
        y: mix(ring.y, next.y),
        rx: mix(ring.rx, next.rx),
        rz: mix(ring.rz, next.rz),
        cz: mix(ring.cz ?? 0, next.cz ?? 0),
        cx: mix(ring.cx ?? 0, next.cx ?? 0),
        blend: blend && {
          bone: blend.bone,
          front: mix(ring.blend?.front ?? 0, next.blend?.front ?? 0),
          back: mix(ring.blend?.back ?? 0, next.blend?.back ?? 0),
        },
        pin: Math.min(ring.pin, next.pin),
        leash: mix(ring.leash, next.leash),
        collide: ring.collide,
        margin: mix(ring.margin ?? MARGIN, next.margin ?? MARGIN),
        loose: ring.loose && next.loose,
        cheeks: mix(ring.cheeks ?? 0, next.cheeks ?? 0),
        crotch: mix(ring.crotch ?? 0, next.crotch ?? 0),
      });
    }
  });
  return out;
}

export class Cloth {
  readonly mesh: THREE.Mesh;
  protected readonly tubes: Tube[];
  protected readonly count: number;
  protected readonly pos: Float32Array; // current particle positions
  private readonly prev: Float32Array; // last substep's (Verlet: velocity = pos - prev)
  private readonly target: Float32Array; // where each particle sits on the body
  private readonly lastTarget: Float32Array; // ... and where it sat last frame
  private readonly local: Float32Array; // rest position in its bone's frame
  private readonly pin: Float32Array;
  private readonly leash: Float32Array;
  private readonly boneOf: Int8Array; // index into the bone list
  private readonly blendOf: Int8Array; // a bone it also follows (-1: none) ...
  private readonly blendWeight: Float32Array; // ... and how much
  private readonly blendLocal: Float32Array; // its rest position in that bone's frame
  private blendBound = false;
  private readonly ringBones: number[][] = []; // per tube ring: bones it's kept outside of
  private readonly ringMargin: number[][] = [];
  private constraints: Constraint[] = [];
  protected bones: THREE.Object3D[] = []; // visible bones (bound to the ragdoll)
  private readonly boneSegs: Segment[];
  private ragdoll: Ragdoll | null = null;
  private needsSnap = true;
  protected readonly tubeIndex: number[];
  private seams: [number, number, number][] | null = null; // triangles joining the tubes
  private readonly lastAnchor = new THREE.Vector3();
  private readonly anchor: number;

  /**
   * @param bones the body parts it's worn on (posed body; bound to the ragdoll later)
   * @param anchor the bone whose motion is the garment's "frame" (damping, wind)
   */
  constructor(bones: Segment[], tubes: ClothTube[], material: THREE.Material, anchor = 0) {
    this.boneSegs = bones;
    this.anchor = anchor;
    let start = 0;
    this.tubes = tubes.map((t) => {
      const tube = { ...t, start };
      start += t.rings.length * t.segments;
      return tube;
    });
    this.count = start;
    this.pos = new Float32Array(start * 3);
    this.prev = new Float32Array(start * 3);
    this.target = new Float32Array(start * 3);
    this.lastTarget = new Float32Array(start * 3);
    this.local = new Float32Array(start * 3);
    this.pin = new Float32Array(start);
    this.leash = new Float32Array(start);
    this.boneOf = new Int8Array(start);
    this.blendOf = new Int8Array(start).fill(-1);
    this.blendWeight = new Float32Array(start);
    this.blendLocal = new Float32Array(start * 3);

    // Rest positions in each bone's frame, and the mesh's triangles
    const index: number[] = [];
    for (const tube of this.tubes) {
      const n = tube.segments;
      tube.rings.forEach((ring, r) => {
        const side = tube.side;
        // (A tube in the middle, like the seat, is kept clear of both of a pair: both thighs)
        this.ringBones.push(
          (ring.collide ?? [ring.bone]).flatMap((b) => {
            const ref = tube.bones[b];
            return typeof ref === 'number' ? [ref] : side ? [resolve(ref, side)] : ref;
          }),
        );
        this.ringMargin.push([ring.margin ?? MARGIN]);
        for (let k = 0; k < n; k++) {
          const i = tube.start + r * n + k;
          const a = (k / n) * Math.PI * 2;
          const bulge = ring.cheeks ? ring.cheeks * cheekShape(a) : 0;
          const x = (ring.rx + bulge) * Math.cos(a) + (ring.cx ?? 0) * side;
          const y = ring.y + (ring.crotch ? ring.crotch * crotchShape(a) : 0);
          this.local.set([x, y, (ring.rz + bulge) * Math.sin(a) + (ring.cz ?? 0)], i * 3);
          this.pin[i] = ring.pin;
          this.leash[i] = ring.leash;
          this.boneOf[i] = resolve(tube.bones[ring.bone], side || Math.sign(x));
          if (ring.blend) {
            // The limb on this side; on a body tube, the one on the side this
            // point is on, less so towards the middle (front and back centre
            // stay with their own bone)
            this.blendOf[i] = resolve(tube.bones[ring.blend.bone], side || Math.sign(x));
            const front = (1 - Math.sin(a)) / 2;
            const { front: wf, back: wb } = ring.blend;
            this.blendWeight[i] = (wb + (wf - wb) * front) * (side ? 1 : Math.min(1, Math.abs(x) / 0.15));
          }
          if (r < tube.rings.length - 1) {
            const k1 = (k + 1) % n;
            const p00 = tube.start + r * n + k;
            const p01 = tube.start + r * n + k1;
            index.push(p00, p00 + n, p01, p01, p00 + n, p01 + n);
          }
        }
      });
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setIndex(index);
    this.tubeIndex = index;
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false; // it moves every frame
  }

  /** Wear it on this ragdoll (after it's built); it snaps into place. */
  bind(ragdoll: Ragdoll): void {
    this.ragdoll = ragdoll;
    this.bones = this.boneSegs.map((seg) => ragdoll.visualOf(seg.mesh));
    this.needsSnap = true;
  }

  /** Extra triangles sewing the tubes together (from the snapped positions). */
  protected stitch(): [number, number, number][] {
    return [];
  }

  /** Where every particle sits on the body right now. */
  private updateTargets(): void {
    for (const bone of this.bones) bone.updateMatrixWorld(true);
    for (let i = 0; i < this.count; i++) {
      tmpV.fromArray(this.local, i * 3).applyMatrix4(this.bones[this.boneOf[i]].matrixWorld);
      const t = this.blendOf[i];
      if (t >= 0 && this.blendBound) {
        tmpV2.fromArray(this.blendLocal, i * 3).applyMatrix4(this.bones[t].matrixWorld);
        tmpV.lerp(tmpV2, this.blendWeight[i]);
      }
      tmpV.toArray(this.target, i * 3);
    }
  }

  /** Where blended fabric sits relative to its second bone, from the pose it's first put on in. */
  private bindBlends(): void {
    this.updateTargets();
    for (let i = 0; i < this.count; i++) {
      const t = this.blendOf[i];
      if (t < 0) continue;
      tmpM.copy(this.bones[t].matrixWorld).invert();
      tmpV.fromArray(this.target, i * 3).applyMatrix4(tmpM).toArray(this.blendLocal, i * 3);
    }
    this.blendBound = true;
  }

  /** Put the cloth exactly on the body, at rest, and measure its rest lengths. */
  private snap(): void {
    if (!this.blendBound) this.bindBlends();
    this.updateTargets();
    this.pos.set(this.target);
    this.prev.set(this.target);
    this.lastTarget.set(this.target);
    // Rest lengths from the fabric as worn
    const c: Constraint[] = [];
    const link = (a: number, b: number, stiffness: number, slack: number, slackOnly = true) => {
      const dx = this.pos[a * 3] - this.pos[b * 3];
      const dy = this.pos[a * 3 + 1] - this.pos[b * 3 + 1];
      const dz = this.pos[a * 3 + 2] - this.pos[b * 3 + 2];
      c.push({ a, b, rest: Math.hypot(dx, dy, dz) * slack, stiffness, slackOnly });
    };
    if (!this.seams) {
      this.seams = this.stitch();
      this.mesh.geometry.setIndex([...this.tubeIndex, ...this.seams.flat()]);
    }
    for (const [a, b, d] of this.seams) {
      link(a, b, 1, LOOSE_SLACK);
      link(b, d, 1, LOOSE_SLACK);
      link(d, a, 1, LOOSE_SLACK);
    }
    for (const tube of this.tubes) {
      const n = tube.segments;
      const along = (r: number, r2: number) =>
        tube.rings[r].loose && tube.rings[r2].loose ? LOOSE_SLACK : LENGTH_SLACK;
      for (let r = 0; r < tube.rings.length; r++) {
        for (let k = 0; k < n; k++) {
          const i = tube.start + r * n + k;
          link(i, tube.start + r * n + ((k + 1) % n), 1, RING_SLACK); // round the ring
          if (r + 1 < tube.rings.length) {
            const sl = along(r, r + 1);
            link(i, i + n, 1, sl); // down the tube
            link(i, tube.start + (r + 1) * n + ((k + 1) % n), SHEAR_STIFFNESS, sl); // diagonals
            link(tube.start + r * n + ((k + 1) % n), i + n, SHEAR_STIFFNESS, sl);
          }
          if (r + 2 < tube.rings.length) link(i, i + 2 * n, BEND_STIFFNESS, along(r, r + 2)); // limits folding
          // Across the ring, both ways: keeps the tube round rather than flat
          link(i, tube.start + r * n + ((k + 2) % n), BEND_STIFFNESS, 1, false);
        }
      }
    }
    this.constraints = c;
    this.needsSnap = false;
  }

  /** A particle's position in a bone's frame (right after snapping). */
  protected localTo(bone: number, i: number): THREE.Vector3 {
    tmpM.copy(this.bones[bone].matrixWorld).invert();
    return new THREE.Vector3().fromArray(this.pos, i * 3).applyMatrix4(tmpM);
  }

  /** Particle indices of one ring. */
  protected ring(tube: number, r: number): number[] {
    const t = this.tubes[tube];
    return Array.from({ length: t.segments }, (_, k) => t.start + r * t.segments + k);
  }

  /** Turn triangles to wind the same way as the tubes (outwards from a point inside, in a bone's frame). */
  protected orient(tris: [number, number, number][], bone: number, inside: THREE.Vector3): [number, number, number][] {
    const pt = (i: number) => this.localTo(bone, i);
    const facesOut = (a: number, b: number, c: number) => {
      const pa = pt(a);
      const n = pt(b).sub(pa).cross(pt(c).sub(pa));
      return n.dot(pa.add(pt(b)).add(pt(c)).divideScalar(3).sub(inside)) > 0;
    };
    const [t0, t1, t2] = this.tubeIndex; // the first tube's first triangle
    const tubesOut = facesOut(t0, t1, t2);
    return tris.map(([a, b, c]) => (facesOut(a, b, c) === tubesOut ? [a, b, c] : [a, c, b]));
  }

  /** One frame of cloth simulation; call after the ragdoll has moved. */
  update(dt: number): void {
    if (!this.ragdoll || dt <= 0) return;
    // Body jumped (a reset, getting up): start the cloth fresh there
    const anchor = this.bones[this.anchor].getWorldPosition(tmpP);
    if (this.lastAnchor.distanceToSquared(anchor) > 4) this.needsSnap = true;
    // How far the body moves per substep (the garment's "frame")
    const bodyStep = tmpB.subVectors(anchor, this.lastAnchor).divideScalar(SUBSTEPS);
    this.lastAnchor.copy(anchor);
    if (this.needsSnap) {
      this.snap();
      this.syncMesh();
      return;
    }
    this.lastTarget.set(this.target);
    this.updateTargets();
    const capsules = this.capsules();

    const h = Math.min(dt, 1 / 30) / SUBSTEPS;
    const g = GRAVITY * h * h;
    // Wind: pushes against the direction of travel, harder the faster we go
    const wind = tmpW.copy(bodyStep).multiplyScalar((-WIND / h) * h * h);
    const bx = bodyStep.x;
    const by = bodyStep.y;
    const bz = bodyStep.z;
    const speed = Math.hypot(bx, by, bz) / h;
    const pos = this.pos;
    const prev = this.prev;
    for (let step = 0; step < SUBSTEPS; step++) {
      // Move: momentum (with drag), gravity, a little flutter at speed
      for (let i = 0; i < this.count; i++) {
        const o = i * 3;
        const free = 1 - this.pin[i];
        // Carried along with the body; the fabric's own swinging is damped
        let vx = bx + (pos[o] - prev[o] - bx) * DAMPING + wind.x * free;
        let vy = by + (pos[o + 1] - prev[o + 1] - by) * DAMPING + wind.y * free;
        let vz = bz + (pos[o + 2] - prev[o + 2] - bz) * DAMPING + wind.z * free;
        const f = FLUTTER * Math.min(1, speed / 20) * free;
        vx += (Math.random() - 0.5) * f;
        vy += (Math.random() - 0.5) * f;
        vz += (Math.random() - 0.5) * f;
        prev[o] = pos[o];
        prev[o + 1] = pos[o + 1];
        prev[o + 2] = pos[o + 2];
        pos[o] += vx;
        pos[o + 1] += vy + g;
        pos[o + 2] += vz;
      }
      for (let it = 0; it < ITERATIONS; it++) {
        // The weave
        for (const c of this.constraints) {
          const a = c.a * 3;
          const b = c.b * 3;
          const dx = pos[b] - pos[a];
          const dy = pos[b + 1] - pos[a + 1];
          const dz = pos[b + 2] - pos[a + 2];
          const d = Math.hypot(dx, dy, dz) || 1e-6;
          if (c.slackOnly && d <= c.rest) continue; // slack fabric: free to bunch
          const k = ((d - c.rest) / d) * 0.5 * c.stiffness;
          pos[a] += dx * k;
          pos[a + 1] += dy * k;
          pos[a + 2] += dz * k;
          pos[b] -= dx * k;
          pos[b + 1] -= dy * k;
          pos[b + 2] -= dz * k;
        }
      }
      // Held to the body: firmly at waistbands and cuffs, loosely elsewhere.
      // Each substep aims at where the body is part-way through the frame
      // (aiming at the frame's end dragged the fabric ahead of the body).
      const f = (step + 1) / SUBSTEPS;
      for (let i = 0; i < this.count; i++) {
        const o = i * 3;
        const k = 1 - Math.pow(1 - this.pin[i], h * 60);
        const tx = this.lastTarget[o] + (this.target[o] - this.lastTarget[o]) * f;
        const ty = this.lastTarget[o + 1] + (this.target[o + 1] - this.lastTarget[o + 1]) * f;
        const tz = this.lastTarget[o + 2] + (this.target[o + 2] - this.lastTarget[o + 2]) * f;
        pos[o] += (tx - pos[o]) * k;
        pos[o + 1] += (ty - pos[o + 1]) * k;
        pos[o + 2] += (tz - pos[o + 2]) * k;
        // Leash: free within reach of its spot on the body, never further
        // (keeps fast limb motion from flinging the fabric out and stretching it)
        const dx = pos[o] - tx;
        const dy = pos[o + 1] - ty;
        const dz = pos[o + 2] - tz;
        const d = Math.hypot(dx, dy, dz);
        const max = this.leash[i];
        if (d > max) {
          const q = max / d;
          pos[o] = tx + dx * q;
          pos[o + 1] = ty + dy * q;
          pos[o + 2] = tz + dz * q;
        }
      }
      // Kept outside the body: each ring only against its own bones. (Against
      // everything, baggy fabric that sits inside a neighbouring part, like a
      // pants leg's inner side inside the other leg, gets shoved outwards
      // constantly and stretched to twice its length.)
      let ringNo = 0;
      for (const tube of this.tubes) {
        for (let r = 0; r < tube.rings.length; r++, ringNo++) {
          const own = this.ringBones[ringNo].map((b) => capsules[b]);
          const margin = this.ringMargin[ringNo][0];
          const first = tube.start + r * tube.segments;
          for (let i = first; i < first + tube.segments; i++) this.pushOut(i, own, margin);
        }
      }
    }
    this.syncMesh();
  }

  /** The body's capsules (centre, axis, half length, radius). */
  private capsules(): { c: THREE.Vector3; ax: THREE.Vector3; half: number; r: number }[] {
    return this.bones.map((bone, b) => {
      const seg = this.boneSegs[b];
      const c = bone.getWorldPosition(new THREE.Vector3());
      const ax = new THREE.Vector3(0, 1, 0).applyQuaternion(bone.getWorldQuaternion(tmpQ));
      return { c, ax, half: seg.length / 2, r: seg.radius };
    });
  }

  private pushOut(i: number, capsules: ReturnType<Cloth['capsules']>, margin: number): void {
    const o = i * 3;
    const p = tmpV.fromArray(this.pos, o);
    const home = tmpH.fromArray(this.target, o);
    for (const cap of capsules) {
      // Nearest point on the capsule's axis
      const d = tmpD.subVectors(p, cap.c);
      const t = THREE.MathUtils.clamp(d.dot(cap.ax), -cap.half, cap.half);
      const near = tmpN.copy(cap.c).addScaledVector(cap.ax, t);
      const out = tmpD.subVectors(p, near);
      const dist = out.length();
      const r = cap.r + margin;
      if (dist >= r) continue;
      // Out on the side the fabric belongs on (towards its spot on the body):
      // fabric swept through a fast-moving limb would otherwise be pushed
      // out the far side and tangle round it, stretching the weave
      const homeOut = tmpO.subVectors(home, near);
      if (dist < 1e-6 || out.dot(homeOut) < 0) {
        const hd = homeOut.length();
        if (hd > 1e-6) p.copy(near).addScaledVector(homeOut, r / hd);
      } else {
        p.copy(near).addScaledVector(out, r / dist);
      }
    }
    p.toArray(this.pos, o);
  }

  private syncMesh(): void {
    const geo = this.mesh.geometry;
    (geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
  }
}

/** Zip two runs of vertices (running the same way) into a strip of triangles. */
export function zip(a: number[], b: number[], out: [number, number, number][]): void {
  let i = 0;
  let j = 0;
  while (i < a.length - 1 || j < b.length - 1) {
    const stepA = j >= b.length - 1 || (i < a.length - 1 && (i + 1) / (a.length - 1) <= (j + 1) / (b.length - 1));
    if (stepA) {
      out.push([a[i], a[i + 1], b[j]]);
      i++;
    } else {
      out.push([a[i], b[j + 1], b[j]]);
      j++;
    }
  }
}

const tmpM = new THREE.Matrix4();
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpD = new THREE.Vector3();
const tmpN = new THREE.Vector3();
const tmpH = new THREE.Vector3();
const tmpO = new THREE.Vector3();
const tmpP = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpB = new THREE.Vector3();
const tmpW = new THREE.Vector3();
