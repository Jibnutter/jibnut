import * as THREE from 'three';
import { createBootShell } from './gear';

/**
 * A twin-tip snowboard (an original design, no brand graphics), built in two
 * halves: one under each foot. The rig and ragdoll treat each foot's half
 * like a ski (each is placed under its boot; the ragdoll joins the two
 * rigidly), so together they look and move as one board.
 *
 * In a half's own frame the boot is at the origin and the board runs along
 * z (nose towards -z); x is across it (the toe edge on +x, for a regular
 * rider facing that way).
 */

export const BOARD_LENGTH = 1.55;
const WAIST = 0.25; // width underfoot
const TIP_WIDTH = 0.29; // at the widest, near nose and tail
const ROUND = 0.22; // the rounded nose and tail
const THICKNESS = 0.018;
const RISE = 0.07; // nose and tail turned up
const RISE_LENGTH = 0.24;
const SECTIONS = 40; // per half
/** Half the distance between the bindings. */
export const BOARD_STANCE = 0.26;
/** How far the bindings are turned from straight across (rad): front, back ("duck"). */
const BINDING_ANGLE = [0.26, -0.1];

/** The shape along the board (z from the middle): width, height of the base, thickness. */
function profile(z: number): { w: number; y: number; t: number } {
  const half = BOARD_LENGTH / 2;
  const a = Math.abs(z);
  let w = WAIST + (TIP_WIDTH - WAIST) * Math.min(1, (a / (half - ROUND)) ** 2);
  if (a > half - ROUND) {
    const u = (a - (half - ROUND)) / ROUND;
    w *= Math.sqrt(Math.max(0, 1 - u * u)) * 0.85 + 0.15 * (1 - u); // round, a little blunt
  }
  const start = half - RISE_LENGTH;
  const y = a > start ? RISE * ((a - start) / RISE_LENGTH) ** 2 : 0;
  return { w, y, t: THICKNESS };
}

/** One half of the board's body, from board z0 to z1, shifted so the foot (at zFoot) is the origin. */
function halfGeometry(z0: number, z1: number, zFoot: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const bottom = -0.015;
  const strips: { verts: (p: ReturnType<typeof profile>) => [number, number][]; group: number }[] = [
    { verts: (p) => [[-p.w / 2, bottom + p.y + p.t], [p.w / 2, bottom + p.y + p.t]], group: 0 },
    { verts: (p) => [[p.w / 2, bottom + p.y], [-p.w / 2, bottom + p.y]], group: 1 },
    { verts: (p) => [[-p.w / 2, bottom + p.y], [-p.w / 2, bottom + p.y + p.t]], group: 1 },
    { verts: (p) => [[p.w / 2, bottom + p.y + p.t], [p.w / 2, bottom + p.y]], group: 1 },
  ];
  const groups: { start: number; count: number; group: number }[] = [];
  for (const strip of strips) {
    const first = pos.length / 3;
    const startIdx = idx.length;
    for (let i = 0; i <= SECTIONS; i++) {
      const z = z0 + ((z1 - z0) * i) / SECTIONS;
      const [a, b] = strip.verts(profile(z));
      pos.push(a[0], a[1], z - zFoot, b[0], b[1], z - zFoot);
      // Texture across the whole board: u across, v from nose (0) to tail (1)
      const v = (z + BOARD_LENGTH / 2) / BOARD_LENGTH;
      uv.push(0, v, 1, v);
      if (i < SECTIONS) {
        const k = first + i * 2;
        idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
      }
    }
    groups.push({ start: startIdx, count: idx.length - startIdx, group: strip.group });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  for (const g of groups) geo.addGroup(g.start, g.count, g.group);
  geo.computeVertexNormals();
  return geo;
}

/** Topsheet: off-white with a big orange circle across the middle and black stripes towards the ends. */
function topsheetTexture(): THREE.CanvasTexture {
  const w = 128;
  const h = 640;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ece9e1';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#ff7a1c';
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, w * 0.42, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#16181b';
  for (const y of [70, 100, 120, h - 120, h - 100, h - 70]) ctx.fillRect(0, y, w, 10);
  ctx.fillRect(0, h / 2 - 4, w, 8);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

let shared: { materials: THREE.Material[]; binding: THREE.Material; strap: THREE.Material } | null = null;
function sharedParts() {
  shared ??= {
    materials: [
      new THREE.MeshStandardMaterial({ map: topsheetTexture(), roughness: 0.35, metalness: 0.05 }),
      new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.5 }),
    ],
    binding: new THREE.MeshStandardMaterial({ color: 0x1d1f22, roughness: 0.5, metalness: 0.2 }),
    strap: new THREE.MeshStandardMaterial({ color: 0xff7a1c, roughness: 0.6 }),
  };
  return shared;
}

/**
 * One foot's half of the board, with its binding and boot. i = 0 is the
 * front foot (the nose half, foot at board z = -BOARD_STANCE), 1 the back.
 */
export function createBoardHalf(i: number): THREE.Group {
  const parts = sharedParts();
  const half = new THREE.Group();
  const zFoot = i === 0 ? -BOARD_STANCE : BOARD_STANCE;
  const [z0, z1] = i === 0 ? [-BOARD_LENGTH / 2, 0] : [0, BOARD_LENGTH / 2];
  const body = new THREE.Mesh(halfGeometry(z0, z1, zFoot), parts.materials);
  body.castShadow = true;
  half.add(body);

  // Binding: a base disc, a highback behind the heel and two straps over
  // the boot; boot and binding turned across the board (toe towards +x)
  const binding = new THREE.Group();
  binding.rotation.y = -Math.PI / 2 + BINDING_ANGLE[i];
  const box = (w: number, h: number, l: number, x: number, y: number, z: number, mat: THREE.Material, tilt = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), mat);
    m.position.set(x, y, z);
    m.rotation.x = tilt;
    m.castShadow = true;
    binding.add(m);
  };
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.012, 20), parts.binding);
  disc.position.y = 0.009;
  binding.add(disc);
  box(0.1, 0.018, 0.3, 0, 0.012, 0, parts.binding); // baseplate
  box(0.12, 0.22, 0.02, 0, 0.14, 0.17, parts.binding, -0.25); // highback
  box(0.135, 0.03, 0.07, 0, 0.13, -0.02, parts.strap); // ankle strap
  box(0.125, 0.025, 0.05, 0, 0.09, -0.14, parts.strap); // toe strap
  binding.add(createBootShell());
  half.add(binding);
  return half;
}
