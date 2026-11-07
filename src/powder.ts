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
import { heightAt, normalAt, powderAt, powderAmount, POWDER_DEPTH } from './terrain';
import { railAt } from './rails';
import type { Skier } from './skier';
import type { Controls } from './input';

/**
 * Deep powder: the snow you see sits on top of the surface the skis ride
 * on (see powderAt), so they're buried in it. Riding throws up
 * spray, and the skis leave grooves behind them.
 *
 * Spray: soft white puffs thrown off the skis, a little when running
 * straight, clouds when carving hard or braking, and a burst on landing.
 * They fly out, hang in the air (powder is light: strong air drag) and fade.
 *
 * Tracks: a groove behind each ski on the powder's surface, kept for a long
 * way back.
 */

// Spray
const MAX_PUFFS = 4000;
const STRAIGHT_RATE = 6; // puffs per second per ski per m/s, running straight
const CARVE_RATE = 30; // ... more per rad/s of turning
const BRAKE_RATE = 25; // ... and when braking (skis skidding sideways)
const LAND_BURST = 260; // puffs on landing (scaled by how hard)
const GROOMED_SPRAY = 0.2; // of the spray on groomed snow
const DRAG = 2.6; // 1/s: powder hangs in the air
const GRAVITY = -9.81;

// Tracks
const MAX_TRACK_POINTS = 3000; // per ski
const TRACK_STEP = 0.3; // m between track points
const TRACK_WIDTH = 0.24;

const TRACK_DROP = 300; // when full, forget this many of the oldest points at once

/**
 * One ski's groove: a strip of three vertices across (edge, groove, edge)
 * per track point, built once when the point is laid down.
 */
interface Track {
  mesh: THREE.Mesh;
  count: number; // track points laid down
  /** Point k joins back to point k-1 (0: the track starts again here). */
  joined: Uint8Array;
  indexCount: number;
  last: THREE.Vector3 | null;
}

export class Powder {
  readonly group = new THREE.Group();

  // Spray: a pool of puffs
  private readonly pos = new Float32Array(MAX_PUFFS * 3);
  private readonly vel = new Float32Array(MAX_PUFFS * 3);
  private readonly life = new Float32Array(MAX_PUFFS); // seconds left (0: free)
  private readonly maxLife = new Float32Array(MAX_PUFFS);
  private readonly size = new Float32Array(MAX_PUFFS); // drawn size (m)
  private readonly alpha = new Float32Array(MAX_PUFFS);
  private readonly baseSize = new Float32Array(MAX_PUFFS);
  private next = 0;
  private readonly points: THREE.Points;

  private readonly tracks: Track[];
  private wasGrounded = true;
  private lastFallSpeed = 0;

  constructor() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    this.points = new THREE.Points(geo, sprayMaterial());
    this.points.frustumCulled = false;
    this.group.add(this.points);

    const trackMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      polygonOffset: true, // drawn over the snow it lies on
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const colors = trackColors();
    this.tracks = [0, 1].map(() => {
      const g = new THREE.BufferGeometry();
      // Three vertices across each track point: edge, groove, edge
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_TRACK_POINTS * 9), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(MAX_TRACK_POINTS * 9), 3));
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      g.setIndex(new THREE.BufferAttribute(new Uint32Array(MAX_TRACK_POINTS * 12), 1));
      g.setDrawRange(0, 0);
      const mesh = new THREE.Mesh(g, trackMat);
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      return { mesh, count: 0, joined: new Uint8Array(MAX_TRACK_POINTS), indexCount: 0, last: null };
    });
  }

  /** Puff sizes are in metres: tell them the view's pixel height and field of view. */
  setView(heightPx: number, fovDeg: number): void {
    (this.points.material as THREE.ShaderMaterial).uniforms.scale.value =
      heightPx / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
  }

  /** A fresh run: wipe the tracks and any spray still in the air. */
  clear(): void {
    for (const track of this.tracks) {
      track.count = 0;
      track.indexCount = 0;
      track.last = null;
      track.mesh.geometry.setDrawRange(0, 0);
    }
    this.life.fill(0);
    this.alpha.fill(0);
    this.points.geometry.attributes.aAlpha.needsUpdate = true;
    this.wasGrounded = true; // (no landing burst at the start)
  }

  update(dt: number, skier: Skier, input: Controls): void {
    if (dt <= 0) return;
    const riding = skier.mode === 'riding';
    const v = skier.velocity;
    const speed = skier.speed;
    const ski = [skier.skiWorld(0, tmpA), skier.skiWorld(1, tmpB)];
    const onSnow = (p: THREE.Vector3) => {
      const rail = railAt(p.x, p.z);
      return !(rail && p.y > rail.top - 0.1); // not on a rail
    };

    if (riding && skier.grounded) {
      // Along the skis (turned across when hockey-stopping)
      const fwd = skier.forward(tmpF).applyAxisAngle(UP, skier.skidAngle);
      const side = tmpS.set(-fwd.z, 0, fwd.x); // to the right
      const turn = skier.turning; // rad/s, + = left
      const braking = input.brake && !input.jump;
      // Puffs per second per ski
      const rate = speed * (STRAIGHT_RATE + CARVE_RATE * Math.abs(turn) + (braking ? BRAKE_RATE : 0));
      for (const p of ski) {
        if (!onSnow(p)) continue;
        // Groomed snow throws up only a little (mostly when carving and braking)
        const deep = powderAmount(p.x, p.z);
        let n = rate * dt * (GROOMED_SPRAY + (1 - GROOMED_SPRAY) * deep);
        while (n > 0) {
          if (n < 1 && Math.random() > n) break;
          n -= 1;
          // Off the ski somewhere along its length, thrown out to the
          // outside of the turn (or both ways when going straight), up,
          // and left behind as the skier moves on
          const along = (Math.random() - 0.5) * 1.4;
          // (Hockey stop: the skis scrape the snow ahead of them, downhill)
          const skidding = Math.abs(skier.skidAngle) > 0.3;
          const out = skidding
            ? Math.sign(side.x * v.x + side.z * v.z) || 1
            : turn !== 0 ? -Math.sign(turn) : Math.random() < 0.5 ? -1 : 1;
          const throwOut = (0.5 + Math.abs(turn) * 1.6 + (braking ? 1.5 : 0)) * Math.min(1, speed / 8) * (0.5 + Math.random());
          this.emit(
            p.x + fwd.x * along,
            heightAt(p.x, p.z) + POWDER_DEPTH * 0.7,
            p.z + fwd.z * along,
            v.x * (0.25 + Math.random() * 0.4) + side.x * out * throwOut * 2.2 + (Math.random() - 0.5),
            (0.8 + Math.random() * 1.8) * Math.min(1, 0.3 + speed / 10) + Math.abs(turn) * 0.6,
            v.z * (0.25 + Math.random() * 0.4) + side.z * out * throwOut * 2.2 + (Math.random() - 0.5),
            0.6 + Math.random() * 0.9,
            0.12 + Math.random() * 0.12,
          );
        }
      }
      // Just landed: a burst all round, bigger the harder we came down
      if (!this.wasGrounded && onSnow(ski[0])) {
        const hard = Math.min(1.5, 0.3 + this.lastFallSpeed / 10);
        const c = tmpC.addVectors(ski[0], ski[1]).multiplyScalar(0.5);
        const deep = powderAmount(c.x, c.z);
        for (let k = 0; k < LAND_BURST * hard * (0.15 + 0.85 * deep); k++) {
          const a = Math.random() * Math.PI * 2;
          const r = (1 + Math.random() * 3) * hard;
          this.emit(
            c.x + Math.cos(a) * 0.4,
            heightAt(c.x, c.z) + POWDER_DEPTH * 0.7,
            c.z + Math.sin(a) * 0.4,
            v.x * 0.4 + Math.cos(a) * r,
            1 + Math.random() * 3 * hard,
            v.z * 0.4 + Math.sin(a) * r,
            0.8 + Math.random() * 1.0,
            0.15 + Math.random() * 0.15,
          );
        }
      }
    }
    // Crashing: the body ploughs through the powder
    if (!riding) {
      const c = skier.centre(tmpC);
      const ground = heightAt(c.x, c.z) + POWDER_DEPTH;
      if (c.y - ground < 0.5) {
        for (let k = 0; k < 60 * dt * Math.max(2, speed) * (0.2 + 0.8 * powderAmount(c.x, c.z)); k++) {
          this.emit(
            c.x + (Math.random() - 0.5) * 0.8,
            ground,
            c.z + (Math.random() - 0.5) * 0.8,
            (Math.random() - 0.5) * 3,
            1 + Math.random() * 2.5,
            (Math.random() - 0.5) * 3,
            0.7 + Math.random() * 0.8,
            0.15 + Math.random() * 0.15,
          );
        }
      }
    }
    this.wasGrounded = !riding || skier.grounded;
    this.lastFallSpeed = Math.max(0, -v.y);

    this.updatePuffs(dt);
    this.updateTracks(riding && skier.grounded, ski, onSnow);
  }

  private emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number): void {
    const i = this.next;
    this.next = (this.next + 1) % MAX_PUFFS;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.life[i] = life;
    this.maxLife[i] = life;
    this.baseSize[i] = size;
  }

  private updatePuffs(dt: number): void {
    const drag = Math.exp(-DRAG * dt);
    for (let i = 0; i < MAX_PUFFS; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const o = i * 3;
      this.vel[o] *= drag;
      this.vel[o + 1] = this.vel[o + 1] * drag + GRAVITY * 0.35 * dt; // light: falls slowly
      this.vel[o + 2] *= drag;
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
      const t = 1 - this.life[i] / this.maxLife[i]; // 0 -> 1 over its life
      this.size[i] = this.baseSize[i] * (1 + 3 * t); // puffs out as it spreads
      this.alpha[i] = Math.min(1, t * 8) * (1 - t) * 0.75;
    }
    const geo = this.points.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aSize.needsUpdate = true;
    geo.attributes.aAlpha.needsUpdate = true;
  }

  private updateTracks(onGround: boolean, ski: THREE.Vector3[], onSnow: (p: THREE.Vector3) => boolean): void {
    this.tracks.forEach((track, i) => {
      const p = ski[i];
      if (!onGround || !onSnow(p)) {
        track.last = null; // lifted off: the next point starts a new track
        return;
      }
      // Grooves only in powder (groomed snow keeps no real track)
      if (powderAmount(p.x, p.z) < 0.3) {
        track.last = null;
        return;
      }
      if (track.last && track.last.distanceToSquared(p) < TRACK_STEP * TRACK_STEP) return;
      // Moved far (a restart): don't join across
      const joined = !!track.last && track.last.distanceTo(p) < 3;
      this.addTrackPoint(track, p, joined ? track.last : null);
      track.last = (track.last ?? new THREE.Vector3()).copy(p);
    });
  }

  /** Lay down one more piece of groove at p (joined on from prev, if given). */
  private addTrackPoint(track: Track, p: THREE.Vector3, prev: THREE.Vector3 | null): void {
    const geo = track.mesh.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const nrm = geo.attributes.normal as THREE.BufferAttribute;
    const index = geo.index!;
    if (track.count === MAX_TRACK_POINTS) {
      // Full: forget the oldest stretch, and re-join what's left
      const arr = pos.array as Float32Array;
      const narr = nrm.array as Float32Array;
      arr.copyWithin(0, TRACK_DROP * 9, track.count * 9);
      narr.copyWithin(0, TRACK_DROP * 9, track.count * 9);
      track.joined.copyWithin(0, TRACK_DROP, track.count);
      track.joined[0] = 0;
      track.count -= TRACK_DROP;
      track.indexCount = 0;
      for (let k = 1; k < track.count; k++) if (track.joined[k]) this.joinSegment(track, k);
    }
    const k = track.count++;
    // Across the track: square to its direction (from the last point)
    let dx = prev ? p.x - prev.x : 0;
    let dz = prev ? p.z - prev.z : 1;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    const sx = -dz * (TRACK_WIDTH / 2);
    const sz = dx * (TRACK_WIDTH / 2);
    const n = normalAt(p.x, p.z, tmpN);
    for (let c = 0; c < 3; c++) {
      const x = p.x + sx * (c - 1);
      const z = p.z + sz * (c - 1);
      // Just on the powder's surface (the groove's colour does the rest;
      // a little above, as the surface mesh is flat between its grid points)
      pos.setXYZ(k * 3 + c, x, powderAt(x, z) + 0.02, z);
      nrm.setXYZ(k * 3 + c, n.x, n.y, n.z);
    }
    track.joined[k] = prev ? 1 : 0;
    if (prev && k > 0) this.joinSegment(track, k);
    pos.needsUpdate = true;
    nrm.needsUpdate = true;
    index.needsUpdate = true;
    geo.setDrawRange(0, track.indexCount);
  }

  /** The two quads joining track point k-1 to k, facing up. */
  private joinSegment(track: Track, k: number): void {
    const geo = track.mesh.geometry;
    const index = geo.index!.array as Uint32Array;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const s = (k - 1) * 3;
    const e = k * 3;
    // Which way round faces up depends on which way the track runs
    const ax = pos.getX(e) - pos.getX(s);
    const az = pos.getZ(e) - pos.getZ(s);
    const bx = pos.getX(s + 1) - pos.getX(s);
    const bz = pos.getZ(s + 1) - pos.getZ(s);
    const up = az * bx - ax * bz > 0; // y of (e - s) × (s+1 - s)
    const quads = [
      [s, e, s + 1, s + 1, e, e + 1],
      [s + 1, e + 1, s + 2, s + 2, e + 1, e + 2],
    ];
    for (const q of quads) {
      index.set(up ? q : [q[0], q[2], q[1], q[3], q[5], q[4]], track.indexCount);
      track.indexCount += 6;
    }
  }
}

/** Track colours: snow-white at the edges, a blue-grey shadow down the groove. */
function trackColors(): Float32Array {
  const c = new Float32Array(MAX_TRACK_POINTS * 3 * 3);
  const edge = new THREE.Color(0xf2f5fa).convertSRGBToLinear();
  const groove = new THREE.Color(0x93a7c4).convertSRGBToLinear();
  for (let k = 0; k < MAX_TRACK_POINTS; k++) {
    for (let j = 0; j < 3; j++) {
      const col = j === 1 ? groove : edge;
      c.set([col.r, col.g, col.b], (k * 3 + j) * 3);
    }
  }
  return c;
}

/** Soft round puffs, sized in metres, each with its own opacity. */
function sprayMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { scale: { value: 800 } },
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aAlpha;
      uniform float scale;
      varying float vAlpha;
      void main() {
        vAlpha = aAlpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aAlpha > 0.0 ? aSize * scale / -mv.z : 0.0;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d) * 2.0;
        float soft = smoothstep(1.0, 0.2, r);
        if (soft <= 0.0) discard;
        gl_FragColor = vec4(0.97, 0.98, 1.0, vAlpha * soft);
      }`,
  });
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const tmpF = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const tmpN = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
