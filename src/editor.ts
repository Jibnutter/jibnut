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
import { heightAt, refreshTerrain, SCULPT_GRID, SPAWN, CUSTOM, MAX_Z } from './terrain';
import { SCULPT, GRID_W, GRID_H, MAX_TREES, saveMap, encodeSculpt, cleanName, type CustomMap } from './customMaps';
import { kickerGhost } from './buildMode';
import type { Kickers } from './kickers';
import type { Physics } from './physics';
import type { Scenery } from './scenery';

/**
 * The map builder: fly round your map and shape it.
 *
 *   right mouse drag   look around         W A S D  fly    E / Q  up / down
 *   Shift              fly faster           1 to 8   pick a tool
 *   left mouse         use the tool         wheel    brush size (lip / spawn: turn it)
 *   Tab                test ride            Esc      menu
 *
 * Tools: raise, lower, smooth and flatten the terrain; place lips
 * (kickers), paint trees, set the spawn point, erase lips and trees.
 * Everything saves as you go.
 */

type Tool = 'raise' | 'lower' | 'smooth' | 'flatten' | 'lip' | 'tree' | 'spawn' | 'erase';
const TOOLS: { id: Tool; label: string }[] = [
  { id: 'raise', label: 'Raise' },
  { id: 'lower', label: 'Lower' },
  { id: 'smooth', label: 'Smooth' },
  { id: 'flatten', label: 'Flatten' },
  { id: 'lip', label: 'Lip' },
  { id: 'tree', label: 'Trees' },
  { id: 'spawn', label: 'Spawn' },
  { id: 'erase', label: 'Erase' },
];

const SPEED = 22; // m/s flying
const FAST = 3;
const LOOK = 0.004; // rad per pixel dragged
const SCULPT_RATE = 4; // m/s at the brush's middle
const SMOOTH_RATE = 6; // 1/s
const MAX_SCULPT = 60; // m up or down
const TREE_SPACING = 5; // m between painted trees
const TREES_PER_SECOND = 14;
const BRUSH = { min: 3, max: 40, start: 10 };
const SPAWN_MAX_Z = MAX_Z - 1;

export class Editor {
  active = false;
  /** Called to test-ride the map (Tab). */
  onTestRide: () => void = () => {};
  /** Called when the spawn point moves (the waiting rider moves with it). */
  onSpawn: () => void = () => {};

  private readonly camera: THREE.PerspectiveCamera;
  private readonly physics: Physics;
  private readonly kickers: Kickers;
  private readonly scenery: Scenery;
  private readonly map: CustomMap;
  private readonly trees: { x: number; z: number }[];
  private tool: Tool = 'raise';
  private radius = BRUSH.start;
  private turn = 0; // the lip's / spawn's extra turn from the wheel
  private yaw = 0;
  private pitch = -0.45;
  private readonly keys = new Set<string>();
  private readonly mouse = new THREE.Vector2(0, 0); // normalised device coords
  private looking = false;
  private painting = false;
  private flattenTo = 0;
  private treeTimer = 0;
  private stroke: { x0: number; z0: number; x1: number; z1: number } | null = null;
  private readonly aim = new THREE.Vector3();
  private aimValid = false;

  private readonly ring: THREE.Line;
  private readonly ghost: THREE.Mesh;
  private readonly spawnMarker: THREE.Group;
  private readonly panel: HTMLDivElement;
  private readonly status: HTMLDivElement;

  constructor(
    camera: THREE.PerspectiveCamera,
    canvas: HTMLElement,
    scene: THREE.Scene,
    physics: Physics,
    kickers: Kickers,
    scenery: Scenery,
  ) {
    if (!CUSTOM || !SPAWN) throw new Error('The editor needs a custom map');
    this.camera = camera;
    this.physics = physics;
    this.kickers = kickers;
    this.scenery = scenery;
    this.map = CUSTOM;
    this.trees = [...CUSTOM.trees];

    // The brush: a ring lying on the snow
    const ringGeo = new THREE.BufferGeometry();
    ringGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(65 * 3), 3));
    this.ring = new THREE.Line(ringGeo, new THREE.LineBasicMaterial({ color: 0xff7a1c, depthTest: false, transparent: true }));
    this.ring.renderOrder = 10;
    this.ring.frustumCulled = false;
    this.ring.visible = false;
    scene.add(this.ring);
    this.ghost = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ color: 0x5fd0ff, transparent: true, opacity: 0.45, depthWrite: false }),
    );
    this.ghost.visible = false;
    scene.add(this.ghost);
    this.spawnMarker = spawnMarker();
    this.spawnMarker.visible = false;
    scene.add(this.spawnMarker);
    this.placeSpawnMarker();

    // The panel: tools, brush size, the map's name, test ride and menu
    this.panel = document.createElement('div');
    this.panel.id = 'editor';
    this.panel.className = 'hidden';
    this.panel.innerHTML = `
      <div class="tools">${TOOLS.map((t, i) => `<button type="button" data-tool="${t.id}"><kbd>${i + 1}</kbd>${t.label}</button>`).join('')}</div>
      <div class="row">
        <label class="name">Map name <input type="text" maxlength="24" spellcheck="false" value=""></label>
        <span class="size"></span>
        <button type="button" data-act="ride">Test ride <kbd>Tab</kbd></button>
        <button type="button" data-act="menu">Menu <kbd>Esc</kbd></button>
      </div>`;
    this.status = document.createElement('div');
    this.status.className = 'status';
    this.panel.prepend(this.status);
    document.body.appendChild(this.panel);
    const name = this.panel.querySelector('input')!;
    name.value = this.map.name;
    name.addEventListener('input', () => {
      this.map.name = cleanName(name.value);
      this.save();
    });
    // (typing a name mustn't fly the camera or switch tools)
    name.addEventListener('keydown', (e) => e.stopPropagation());
    this.panel.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      if (b.dataset.tool) this.setTool(b.dataset.tool as Tool);
      if (b.dataset.act === 'ride') this.onTestRide();
      if (b.dataset.act === 'menu') window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' }));
      b.blur();
    });

    window.addEventListener('keydown', (e) => {
      if (!this.active || isTyping(e)) return;
      this.keys.add(e.code);
      const n = Number(e.key);
      if (n >= 1 && n <= TOOLS.length) this.setTool(TOOLS[n - 1].id);
      if (e.code === 'BracketLeft') this.resize(-2);
      if (e.code === 'BracketRight') this.resize(2);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.endStroke();
      this.looking = false;
    });
    canvas.addEventListener('contextmenu', (e) => this.active && e.preventDefault());
    canvas.addEventListener('mousedown', (e) => {
      if (!this.active) return;
      if (e.button === 2) this.looking = true;
      if (e.button === 0) this.startStroke();
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 2) this.looking = false;
      if (e.button === 0) this.endStroke();
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.active) return;
      const r = canvas.getBoundingClientRect();
      this.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      if (this.looking) {
        this.yaw -= e.movementX * LOOK;
        this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * LOOK, -1.5, 1.2);
      }
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        if (!this.active) return;
        e.preventDefault();
        if (this.tool === 'lip' || this.tool === 'spawn') this.turn += Math.sign(e.deltaY) * 0.15;
        else this.resize(-Math.sign(e.deltaY) * 2);
      },
      { passive: false },
    );
    this.setTool('raise');
  }

  /** Start editing, looking down the slope from above the spawn point. */
  enter(): void {
    this.active = true;
    this.panel.classList.remove('hidden');
    this.spawnMarker.visible = true;
    const s = SPAWN!;
    this.camera.position.set(s.x, heightAt(s.x, s.z) + 14, s.z + 18);
    this.yaw = s.yaw;
    this.pitch = -0.45;
  }

  exit(): void {
    this.active = false;
    this.endStroke();
    this.panel.classList.add('hidden');
    this.ring.visible = this.ghost.visible = this.spawnMarker.visible = false;
    this.keys.clear();
    this.looking = false;
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
    p.y = Math.max(p.y, heightAt(p.x, p.z) + 1.5);
    this.camera.quaternion.setFromEuler(tmpE.set(this.pitch, this.yaw, 0, 'YXZ'));
    this.camera.updateMatrixWorld();

    this.updateAim();
    this.updateCursor();

    // Use the tool while the button's held
    if (this.painting && this.aimValid) {
      if (this.tool === 'raise' || this.tool === 'lower' || this.tool === 'smooth' || this.tool === 'flatten') {
        this.sculpt(dt);
      } else if (this.tool === 'tree') {
        this.treeTimer -= dt;
        if (this.treeTimer <= 0) {
          this.treeTimer = 1 / TREES_PER_SECOND;
          this.paintTree();
        }
      } else if (this.tool === 'erase') this.erase();
    }
  }

  private setTool(t: Tool): void {
    this.tool = t;
    this.turn = 0;
    for (const b of this.panel.querySelectorAll<HTMLButtonElement>('[data-tool]')) b.classList.toggle('on', b.dataset.tool === t);
    this.updateStatus();
  }

  private resize(d: number): void {
    this.radius = THREE.MathUtils.clamp(this.radius + d, BRUSH.min, BRUSH.max);
    this.updateStatus();
  }

  private updateStatus(): void {
    const help: Record<Tool, string> = {
      raise: 'Hold the left mouse button to raise the snow',
      lower: 'Hold the left mouse button to dig it down',
      smooth: 'Hold to smooth out bumps and edges',
      flatten: 'Hold: levels everything to the height where you started',
      lip: 'Click to place a lip (kicker), facing the way you look · wheel turns it',
      tree: 'Hold to paint trees inside the brush',
      spawn: 'Click to set where the run starts, facing the way you look · wheel turns it',
      erase: 'Hold to remove trees and lips inside the brush',
    };
    this.status.textContent = `${help[this.tool]} · right-drag to look · WASD fly · E/Q up/down · Shift faster`;
    const sized = this.tool !== 'lip' && this.tool !== 'spawn';
    this.panel.querySelector('.size')!.textContent = sized ? `Brush ${this.radius} m · wheel or [ ]` : '';
  }

  /** Where the mouse points on the snow: march along the ray until it goes under. */
  private updateAim(): void {
    tmpRay.setFromCamera(this.mouse, this.camera);
    const o = tmpRay.ray.origin;
    const d = tmpRay.ray.direction;
    this.aimValid = false;
    let prev = 0;
    for (let t = 0.5; t < 600; t += t < 60 ? 0.5 : 2) {
      const x = o.x + d.x * t;
      const y = o.y + d.y * t;
      const z = o.z + d.z * t;
      if (y <= heightAt(x, z)) {
        // Refine between the last two steps
        let a = prev;
        let b = t;
        for (let i = 0; i < 8; i++) {
          const m = (a + b) / 2;
          if (o.y + d.y * m <= heightAt(o.x + d.x * m, o.z + d.z * m)) b = m;
          else a = m;
        }
        this.aim.set(o.x + d.x * b, 0, o.z + d.z * b);
        this.aim.y = heightAt(this.aim.x, this.aim.z);
        this.aimValid = inBounds(this.aim.x, this.aim.z);
        return;
      }
      prev = t;
    }
  }

  private updateCursor(): void {
    const sized = this.tool !== 'lip' && this.tool !== 'spawn';
    this.ring.visible = this.aimValid && sized;
    if (this.ring.visible) {
      const pos = this.ring.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * Math.PI * 2;
        const x = this.aim.x + Math.cos(a) * this.radius;
        const z = this.aim.z + Math.sin(a) * this.radius;
        pos.setXYZ(i, x, heightAt(x, z) + 0.3, z);
      }
      pos.needsUpdate = true;
    }
    this.ghost.visible = this.aimValid && this.tool === 'lip' && !this.kickers.full;
    if (this.ghost.visible) {
      this.ghost.geometry.dispose();
      this.ghost.geometry = kickerGhost(this.aim.x, this.aim.z, this.yaw + this.turn);
    }
    if (this.tool === 'spawn' && this.aimValid) {
      // The marker follows the mouse until clicked
      this.spawnMarker.position.copy(this.aim);
      this.spawnMarker.rotation.y = this.yaw + this.turn;
    } else this.placeSpawnMarker();
  }

  private startStroke(): void {
    if (!this.aimValid) return;
    if (this.tool === 'lip') {
      this.kickers.add({ x: this.aim.x, z: this.aim.z, yaw: this.yaw + this.turn });
      return;
    }
    if (this.tool === 'spawn') {
      // (not above the top of the slope: riders can't start up there)
      if (this.aim.z > SPAWN_MAX_Z) return;
      SPAWN!.x = this.aim.x;
      SPAWN!.z = this.aim.z;
      SPAWN!.yaw = this.yaw + this.turn;
      this.map.spawn = { ...SPAWN! };
      this.placeSpawnMarker();
      this.save();
      this.onSpawn();
      return;
    }
    this.painting = true;
    this.treeTimer = 0;
    this.flattenTo = this.aim.y;
    this.stroke = { x0: this.aim.x, z0: this.aim.z, x1: this.aim.x, z1: this.aim.z };
  }

  private endStroke(): void {
    if (!this.painting) return;
    this.painting = false;
    const s = this.stroke;
    this.stroke = null;
    if (!s) return;
    const r = this.radius + 2;
    if (this.tool === 'raise' || this.tool === 'lower' || this.tool === 'smooth' || this.tool === 'flatten') {
      // The full touch-up: shading, the collider, lips and trees on the new ground
      refreshTerrain(s.x0 - r, s.z0 - r, s.x1 + r, s.z1 + r, true);
      this.physics.rebuildCourse();
      this.kickers.refresh();
      this.scenery.setTrees(this.trees);
    }
    this.save();
  }

  private grow(x: number, z: number): void {
    const s = this.stroke!;
    s.x0 = Math.min(s.x0, x);
    s.z0 = Math.min(s.z0, z);
    s.x1 = Math.max(s.x1, x);
    s.z1 = Math.max(s.z1, z);
  }

  /** Raise, lower, smooth or flatten the grid inside the brush (soft-edged). */
  private sculpt(dt: number): void {
    const g = SCULPT_GRID;
    const r = this.radius;
    const cx = this.aim.x;
    const cz = this.aim.z;
    const i0 = Math.max(0, Math.floor((cx - r + SCULPT.halfX) / SCULPT.cell));
    const i1 = Math.min(GRID_W - 1, Math.ceil((cx + r + SCULPT.halfX) / SCULPT.cell));
    const j0 = Math.max(0, Math.floor((SCULPT.topZ - (cz + r)) / SCULPT.cell));
    const j1 = Math.min(GRID_H - 1, Math.ceil((SCULPT.topZ - (cz - r)) / SCULPT.cell));
    const before = this.tool === 'smooth' ? g.slice() : null;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = -SCULPT.halfX + i * SCULPT.cell;
        const z = SCULPT.topZ - j * SCULPT.cell;
        const d = Math.hypot(x - cx, z - cz) / r;
        if (d >= 1) continue;
        const w = 0.5 + 0.5 * Math.cos(d * Math.PI); // soft falloff
        const k = j * GRID_W + i;
        if (this.tool === 'raise') g[k] += SCULPT_RATE * w * dt;
        else if (this.tool === 'lower') g[k] -= SCULPT_RATE * w * dt;
        else if (this.tool === 'flatten') {
          const now = heightAt(x, z);
          g[k] += (this.flattenTo - now) * Math.min(1, 4 * w * dt);
        } else if (before && i > 0 && j > 0 && i < GRID_W - 1 && j < GRID_H - 1) {
          const avg = (before[k - 1] + before[k + 1] + before[k - GRID_W] + before[k + GRID_W]) / 4;
          g[k] += (avg - before[k]) * Math.min(1, SMOOTH_RATE * w * dt);
        }
        g[k] = THREE.MathUtils.clamp(g[k], -MAX_SCULPT, MAX_SCULPT);
      }
    }
    this.grow(cx - r, cz - r);
    this.grow(cx + r, cz + r);
    refreshTerrain(cx - r - 2, cz - r - 2, cx + r + 2, cz + r + 2, false);
  }

  private paintTree(): void {
    if (this.trees.length >= MAX_TREES) return;
    // A random spot in the brush, not too close to another tree
    for (let tries = 0; tries < 6; tries++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * this.radius;
      const x = this.aim.x + Math.cos(a) * d;
      const z = this.aim.z + Math.sin(a) * d;
      if (!inBounds(x, z)) continue;
      if (this.trees.some((t) => Math.hypot(t.x - x, t.z - z) < TREE_SPACING)) continue;
      this.trees.push({ x, z });
      this.scenery.setTrees(this.trees);
      this.grow(x, z);
      return;
    }
  }

  private erase(): void {
    const r = this.radius;
    const n = this.trees.length;
    for (let i = this.trees.length - 1; i >= 0; i--) {
      const t = this.trees[i];
      if (Math.hypot(t.x - this.aim.x, t.z - this.aim.z) < r) this.trees.splice(i, 1);
    }
    if (this.trees.length !== n) this.scenery.setTrees(this.trees);
    while (this.kickers.removeNear(this.aim.x, this.aim.z, r)) {
      // (all of them inside the brush)
    }
    this.grow(this.aim.x, this.aim.z);
  }

  private placeSpawnMarker(): void {
    const s = SPAWN!;
    this.spawnMarker.position.set(s.x, heightAt(s.x, s.z), s.z);
    this.spawnMarker.rotation.y = s.yaw;
  }

  private save(): void {
    this.map.trees = this.trees.map((t) => ({ x: Math.round(t.x * 10) / 10, z: Math.round(t.z * 10) / 10 }));
    this.map.sculpt = encodeSculpt(SCULPT_GRID);
    if (!saveMap(this.map)) this.status.textContent = 'Could not save: the browser’s storage is full';
  }
}

function inBounds(x: number, z: number): boolean {
  return Math.abs(x) <= SCULPT.halfX - 4 && z <= SCULPT.topZ - 4 && z >= SCULPT.bottomZ + 4;
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
}

/** The spawn point: an orange post with an arrow showing the way you'll face. */
function spawnMarker(): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0xff7a1c });
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.4, 8), mat);
  post.position.y = 1.2;
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.2, 12), mat);
  arrow.rotation.x = -Math.PI / 2; // pointing along -z (forward)
  arrow.position.set(0, 2.4, -0.6);
  g.add(post, arrow);
  return g;
}

const tmpF = new THREE.Vector3();
const tmpR = new THREE.Vector3();
const tmpE = new THREE.Euler();
const tmpRay = new THREE.Raycaster();
