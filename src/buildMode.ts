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
import { heightAt, KICKER, kickerHeightFor } from './terrain';
import { kickerGeometry, type Kickers } from './kickers';

/**
 * Build mode (M, in the backcountry): the rider waits while you fly a free
 * camera round the mountain and place kickers.
 *
 *   mouse        look around (click the view first to capture the mouse)
 *   W A S D      fly forward / left / back / right
 *   E / Q        up / down          Shift: faster
 *   wheel        turn the kicker
 *   click        place it           Backspace: remove the last one
 *   M            back to riding
 *
 * A see-through kicker shows where it'll go: where you're looking, on the
 * snow, facing the way you face (that's the way you'll ride it).
 */

const SPEED = 18; // m/s
const FAST = 3; // with Shift
const LOOK = 0.0022; // rad per pixel of mouse movement
const REACH = 250; // m: how far away you can place one
const MIN_HEIGHT = 2; // m: the camera stays this far above the snow

export class BuildMode {
  active = false;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly kickers: Kickers;
  private readonly canvas: HTMLElement;
  private yaw = 0; // camera heading
  private pitch = -0.35; // looking down a little
  private turn = 0; // the kicker's extra turn from the wheel
  private readonly keys = new Set<string>();
  private readonly ghost: THREE.Mesh;
  private readonly aim = new THREE.Vector3();
  private aimValid = false;
  /** Called with a short status line for the HUD. */
  onStatus: (text: string) => void = () => {};

  constructor(camera: THREE.PerspectiveCamera, kickers: Kickers, canvas: HTMLElement, scene: THREE.Scene) {
    this.camera = camera;
    this.kickers = kickers;
    this.canvas = canvas;
    this.ghost = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ color: 0x5fd0ff, transparent: true, opacity: 0.45, depthWrite: false }),
    );
    this.ghost.visible = false;
    scene.add(this.ghost);

    window.addEventListener('keydown', (e) => {
      if (!this.active) return;
      this.keys.add(e.code);
      if (e.code === 'Backspace') {
        e.preventDefault();
        this.kickers.undo();
        this.status();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('mousemove', (e) => {
      if (!this.active || document.pointerLockElement !== this.canvas) return;
      this.yaw -= e.movementX * LOOK;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * LOOK, -1.45, 1.2);
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.active || e.button !== 0) return;
      // First click captures the mouse for looking; after that, clicks place
      if (document.pointerLockElement !== this.canvas) {
        this.canvas.requestPointerLock?.();
        return;
      }
      this.place();
    });
    window.addEventListener(
      'wheel',
      (e) => {
        if (!this.active) return;
        this.turn += Math.sign(e.deltaY) * 0.15;
      },
      { passive: true },
    );
  }

  /** Start building, from where the camera is now. */
  enter(): void {
    this.active = true;
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    this.yaw = Math.atan2(-dir.x, -dir.z);
    this.pitch = THREE.MathUtils.clamp(Math.asin(dir.y), -1.2, 0.5);
    this.turn = 0;
    this.status();
  }

  exit(): void {
    this.active = false;
    this.ghost.visible = false;
    this.keys.clear();
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  update(dt: number): void {
    if (!this.active) return;
    // Fly
    const k = this.keys;
    const speed = SPEED * (k.has('ShiftLeft') || k.has('ShiftRight') ? FAST : 1) * dt;
    const fwd = tmpF.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = tmpR.set(-fwd.z, 0, fwd.x);
    const p = this.camera.position;
    if (k.has('KeyW')) p.addScaledVector(fwd, speed);
    if (k.has('KeyS')) p.addScaledVector(fwd, -speed);
    if (k.has('KeyD')) p.addScaledVector(right, speed);
    if (k.has('KeyA')) p.addScaledVector(right, -speed);
    if (k.has('KeyE')) p.y += speed;
    if (k.has('KeyQ')) p.y -= speed;
    p.y = Math.max(p.y, heightAt(p.x, p.z) + MIN_HEIGHT);
    this.camera.quaternion.setFromEuler(tmpE.set(this.pitch, this.yaw, 0, 'YXZ'));
    this.camera.updateMatrixWorld();

    // Aim: march along the view until it meets the snow
    const dir = this.camera.getWorldDirection(tmpD);
    this.aimValid = false;
    for (let t = 1; t < REACH; t += 0.5) {
      const x = p.x + dir.x * t;
      const y = p.y + dir.y * t;
      const z = p.z + dir.z * t;
      if (y <= heightAt(x, z)) {
        this.aim.set(x, y, z);
        this.aimValid = true;
        break;
      }
    }
    // The ghost: a see-through kicker there, rebuilt as it moves
    this.ghost.visible = this.aimValid && !this.kickers.full;
    if (this.ghost.visible) {
      const geo = kickerGhost(this.aim.x, this.aim.z, this.yaw + this.turn);
      this.ghost.geometry.dispose();
      this.ghost.geometry = geo;
    }
  }

  private place(): void {
    if (!this.aimValid || this.kickers.full) return;
    this.kickers.add({ x: this.aim.x, z: this.aim.z, yaw: this.yaw + this.turn });
    this.status();
  }

  private status(): void {
    const n = this.kickers.count;
    this.onStatus(
      `Build mode · ${n} kicker${n === 1 ? '' : 's'}${this.kickers.full ? ' (full)' : ''} · click the view to look · WASD fly · E/Q up/down · wheel turn · click place · Backspace undo · M ride`,
    );
  }
}

/** The ghost's shape: the kicker's ramp over the ground as it is now, a little above it. */
function kickerGhost(x: number, z: number, yaw: number): THREE.BufferGeometry {
  // (kickerGeometry samples the ground, which doesn't have this kicker yet:
  // add its shape on top)
  const geo = kickerGeometry({ x, z, yaw }, 0.06);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const height = kickerHeightFor({ x, z, yaw });
  for (let i = 0; i < pos.count; i++) {
    const dx = pos.getX(i) - x;
    const dz = pos.getZ(i) - z;
    const along = dx * fx + dz * fz + KICKER.length / 2;
    const across = Math.abs(dx * fz - dz * fx);
    const sides = 1 - THREE.MathUtils.smoothstep(across, KICKER.halfWidth, KICKER.halfWidth + KICKER.side);
    const t = THREE.MathUtils.clamp(along / KICKER.length, 0, 1);
    const up = along <= KICKER.length ? t * t : 1 - THREE.MathUtils.smoothstep(along - KICKER.length, 0, 0.5);
    pos.setY(i, pos.getY(i) + height * up * sides);
  }
  geo.computeVertexNormals();
  return geo;
}

const tmpF = new THREE.Vector3();
const tmpR = new THREE.Vector3();
const tmpD = new THREE.Vector3();
const tmpE = new THREE.Euler();
