import * as THREE from 'three';
import { createBootShell } from './gear';

/**
 * Fat, boxy freeride twin-tip skis (an original design, no brand graphics).
 *
 * The ski is built as a real shape rather than a box: a little wider at the
 * tip and tail than underfoot (sidecut), slightly thinner towards the ends,
 * with both ends turned up (twin tip, so it rides switch too). The topsheet
 * gets its own painted graphic; sidewalls and base are black. On top sits a
 * binding (base plate, toe and heel pieces) with the boot in it.
 *
 * Wide and boxy: nearly straight sides, thick, and blunt square ends.
 *
 * Only the look changes: physics still treats each ski as a 1.6 m box.
 */

const LENGTH = 1.62;
// Fat, boxy freeride skis: wide, nearly straight-sided, thick, with blunt
// square-cornered tips and tails
const WAIST = 0.124; // width underfoot
const TIP_WIDTH = 0.134; // width at the widest point near each end (little sidecut)
const ROUND = 0.07; // length of the (square-cornered) ends
const THICKNESS = 0.028; // underfoot, only a little thinner at the ends
const RISE = { tip: 0.075, tail: 0.065 }; // how high each end turns up
const RISE_LENGTH = 0.24;
const SECTIONS = 64;

/** The shape along the ski: width, height of the base, and thickness. */
function profile(z: number): { w: number; y: number; t: number } {
  const half = LENGTH / 2;
  const a = Math.abs(z);
  // Sidecut: widest near the ends, narrowest underfoot
  let w = WAIST + (TIP_WIDTH - WAIST) * Math.min(1, (a / (half - ROUND)) ** 2);
  // Blunt ends: square with rounded corners (a superellipse)
  if (a > half - ROUND) {
    const u = (a - (half - ROUND)) / ROUND;
    w *= Math.max(0, 1 - u ** 4) ** 0.25;
  }
  // Both ends turn up (z < 0 is the tip, at the front)
  const start = half - RISE_LENGTH;
  const rise = z < 0 ? RISE.tip : RISE.tail;
  const y = a > start ? rise * ((a - start) / RISE_LENGTH) ** 2 : 0;
  const t = THICKNESS * (1 - 0.3 * Math.min(1, a / half) ** 3);
  return { w, y, t };
}

/** The ski's body: topsheet (group 0) and black sides and base (group 1). */
function skiGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const bottom = -0.015; // the base sits on the snow, like the old box
  // Four strips along the ski: top, base, left side, right side
  const strips: { verts: (p: ReturnType<typeof profile>) => [number, number][]; group: number }[] = [
    { verts: (p) => [[-p.w / 2, bottom + p.y + p.t], [p.w / 2, bottom + p.y + p.t]], group: 0 }, // top
    { verts: (p) => [[p.w / 2, bottom + p.y], [-p.w / 2, bottom + p.y]], group: 1 }, // base
    { verts: (p) => [[-p.w / 2, bottom + p.y], [-p.w / 2, bottom + p.y + p.t]], group: 1 }, // left side
    { verts: (p) => [[p.w / 2, bottom + p.y + p.t], [p.w / 2, bottom + p.y]], group: 1 }, // right side
  ];
  const groups: { start: number; count: number; group: number }[] = [];
  for (const strip of strips) {
    const first = pos.length / 3;
    const startIdx = idx.length;
    for (let i = 0; i <= SECTIONS; i++) {
      const z = -LENGTH / 2 + (LENGTH * i) / SECTIONS;
      const p = profile(z);
      const [a, b] = strip.verts(p);
      pos.push(a[0], a[1], z, b[0], b[1], z);
      const v = i / SECTIONS;
      uv.push(0, v, 1, v);
      if (i < SECTIONS) {
        const k = first + i * 2;
        idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); // facing outwards
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

/**
 * The topsheet graphic: a deep navy base, a bold sweep shading from lime to
 * teal across the middle, angular shards near the ends, and thin white edge
 * pinstripes. Drawn once, shared by both skis.
 */
function topsheetTexture(): THREE.CanvasTexture {
  const w = 64;
  const h = 512; // along the ski: top of the canvas is the tip
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#16213a';
  ctx.fillRect(0, 0, w, h);

  // The sweep: a broad diagonal band through the middle
  const grad = ctx.createLinearGradient(0, 150, 0, 360);
  grad.addColorStop(0, '#c6f53b');
  grad.addColorStop(1, '#19b7a8');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(0, 170);
  ctx.lineTo(w, 120);
  ctx.lineTo(w, 300);
  ctx.lineTo(0, 380);
  ctx.closePath();
  ctx.fill();

  // Shards near tip and tail
  ctx.fillStyle = '#ff6b2c';
  for (const [y0, flip] of [
    [40, 1],
    [440, -1],
  ] as const) {
    ctx.beginPath();
    ctx.moveTo(0, y0);
    ctx.lineTo(w, y0 + 26 * flip);
    ctx.lineTo(w * 0.35, y0 + 52 * flip);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillRect(10, 395, w - 20, 4);
  ctx.fillRect(10, 405, w - 34, 4);

  // Edge pinstripes the full length
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(3, 0, 2, h);
  ctx.fillRect(w - 5, 0, 2, h);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// Shared by every ski (and the ragdoll's copies of them)
let shared: { geometry: THREE.BufferGeometry; materials: THREE.Material[]; binding: THREE.Material } | null = null;
function sharedParts() {
  if (shared) return shared;
  const top = new THREE.MeshStandardMaterial({ map: topsheetTexture(), roughness: 0.35, metalness: 0.1 });
  const black = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.5 });
  shared = {
    geometry: skiGeometry(),
    materials: [top, black],
    binding: new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.4, metalness: 0.5 }),
  };
  return shared;
}

/** One ski with its binding and boot, at x across the stance. */
export function createSki(x: number): THREE.Group {
  const parts = sharedParts();
  const ski = new THREE.Group();

  const body = new THREE.Mesh(parts.geometry, parts.materials);
  body.castShadow = true;
  ski.add(body);

  // Binding: base plate, toe piece in front of the boot, heel piece behind
  const box = (w: number, h: number, l: number, y: number, z: number, mat: THREE.Material) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), mat);
    m.position.set(0, y, z);
    m.castShadow = true;
    ski.add(m);
    return m;
  };
  box(0.07, 0.012, 0.42, 0.011, 0, parts.binding);
  box(0.075, 0.035, 0.07, 0.03, -0.19, parts.binding);
  box(0.075, 0.045, 0.08, 0.035, 0.19, parts.binding);

  // Boot (its lower shell), in the binding
  ski.add(createBootShell());

  ski.position.set(x, 0.015, 0);
  return ski;
}
