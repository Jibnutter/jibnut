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
import { mulberry32, SUMMER_MAP } from './terrain';

/**
 * Cel-shaded spruces.
 *
 * Each tree is built in code: a trunk and a stack of branch tiers, each tier
 * a star-shaped skirt (branch tips drooping down and out, notches between
 * them), smaller towards the top, with snow lying on the upper tiers. A few
 * variants are made, and the forest is instances of them, each turned,
 * scaled and tinted differently.
 *
 * The look: toon shading (light falls off in a few hard bands, not a smooth
 * gradient) and a dark ink outline, drawn as a slightly inflated copy of
 * the tree turned inside out (only its rim shows, round the silhouette).
 */

const VARIANTS = 4;
const TIPS = 7; // branch tips round each tier
const OUTLINE = 0.07; // m: the ink line's thickness
const OUTLINE_COLOR = 0x0e1a16;

interface TreeShape {
  needles: THREE.BufferGeometry;
  snow: THREE.BufferGeometry;
  trunk: THREE.BufferGeometry;
  outline: THREE.BufferGeometry;
}

/**
 * One tier: a skirt of branches from its top (apex, on the trunk) out to a
 * ring of drooping tips with notches between them, and an underside back in
 * to the trunk. Vertices are shared (indexed), so normals come out smooth
 * enough to inflate for the outline.
 */
function tier(
  rand: () => number,
  baseY: number,
  topY: number,
  radius: number,
  droop: number,
  shade: number,
  snow = false,
): THREE.BufferGeometry {
  // Snow: a cap lying on the top of the tier, over its inner part (it
  // doesn't reach the drooping tips): the same skirt shrunk towards its
  // apex, so it lies along the branches, then raised just above them
  const scale = snow ? 0.72 : 1;
  const lift = snow ? 0.1 : 0;
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const turn = rand() * Math.PI * 2;
  const v = (x: number, y: number, z: number, c: number) => {
    pos.push(x * scale, topY + (y - topY) * scale + lift, z * scale);
    col.push(c, c, c);
    return pos.length / 3 - 1;
  };
  const apex = v(0, topY, 0, shade * 1.05);
  const under = v(0, baseY + (topY - baseY) * 0.3, 0, shade * 0.45);
  const ring: number[] = [];
  for (let k = 0; k < TIPS * 2; k++) {
    const a = turn + (k / (TIPS * 2)) * Math.PI * 2 + (rand() - 0.5) * 0.25;
    const tip = k % 2 === 0;
    // Tips reach out and droop; notches sit in and higher
    const r = radius * (tip ? 0.85 + rand() * 0.3 : 0.5 + rand() * 0.12);
    const y = tip ? baseY - droop * (0.7 + rand() * 0.6) : baseY + (topY - baseY) * 0.22;
    ring.push(v(Math.cos(a) * r, y, Math.sin(a) * r, shade * (tip ? 0.9 : 0.8)));
  }
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    idx.push(apex, b, a); // the top, facing out and up
    idx.push(under, a, b); // the underside, facing down
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

/** A spruce: trunk, branch tiers and snow, plus its outline shell. */
function spruce(seed: number): TreeShape {
  const rand = mulberry32(seed);
  const height = 9 + rand() * 4;
  const tiers = 6 + Math.floor(rand() * 2);
  const crownBase = 0.9 + rand() * 0.4; // bare trunk below the lowest branches
  const width = 0.3 + rand() * 0.07; // crown radius at the bottom, per metre of height
  const snowy = 0.5 + rand() * 0.45; // how much of the crown carries snow

  const needleParts: THREE.BufferGeometry[] = [];
  const snowParts: THREE.BufferGeometry[] = [];
  const span = height - crownBase;
  for (let t = 0; t < tiers; t++) {
    // Tiers overlap, each a little shorter than the one below
    const f0 = t / tiers;
    const f1 = Math.min(1, (t + 1.9) / tiers);
    const baseY = crownBase + span * f0 * 0.92;
    const topY = crownBase + span * f1;
    const radius = height * width * (1 - f0) ** 0.95 + 0.25;
    const droop = 0.35 + radius * 0.18;
    const shade = 0.85 + rand() * 0.15;
    const seedT = rand();
    needleParts.push(tier(mulberry32(seed * 31 + t), baseY, topY, radius, droop, shade));
    // Snow on the upper side of the tiers (more on the higher ones), a
    // smaller skirt lying just on top
    if (t >= tiers * (1 - snowy) || seedT < snowy * 0.5) {
      // (the same seed: the cap follows this tier's own branches)
      snowParts.push(tier(mulberry32(seed * 31 + t), baseY, topY, radius, droop, 1, true));
    }
  }
  const needles = mergeGeometries(needleParts);
  needles.computeVertexNormals();
  const snow = snowParts.length ? mergeGeometries(snowParts) : new THREE.BufferGeometry();
  if (snowParts.length) snow.computeVertexNormals();
  const trunk = new THREE.CylinderGeometry(0.12, 0.3, crownBase + span * 0.5, 7)
    .translate(0, (crownBase + span * 0.5) / 2, 0)
    .toNonIndexed();
  trunk.computeVertexNormals();

  // The outline shell: the crown's silhouette, pushed out along its normals
  const outline = needles.clone();
  const p = outline.attributes.position as THREE.BufferAttribute;
  const n = outline.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(i, p.getX(i) + n.getX(i) * OUTLINE, p.getY(i) + n.getY(i) * OUTLINE, p.getZ(i) + n.getZ(i) * OUTLINE);
  }
  outline.deleteAttribute('color');
  return { needles, snow, trunk, outline };
}

/** Light in three hard bands: shade, mid, lit. */
function toonGradient(): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([70, 150, 255]), 3, 1, THREE.RedFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The forest: a cel-shaded spruce at each spot, picked from the variants,
 * turned, scaled and tinted at random (seeded, so it's the same each time).
 */
export function createForest(spots: THREE.Vector3[], seed = 42): THREE.Group {
  const rand = mulberry32(seed);
  const shapes = Array.from({ length: VARIANTS }, (_, i) => spruce(1000 + i * 77));
  const gradient = toonGradient();
  // Shade never goes fully black: a cool emissive stands in for sky light
  // (toon materials ignore the environment map)
  // Flat shaded: each facet one tone, crisp like a cel drawing
  const needleMat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: gradient, emissive: 0x0b1a1c });
  const snowMat = new THREE.MeshToonMaterial({ color: 0xf4f8ff, gradientMap: gradient, emissive: 0x3a4a62 });
  // (supported by the toon shader, missing from its typings)
  for (const mat of [needleMat, snowMat]) (mat as unknown as { flatShading: boolean }).flatShading = true;
  const trunkMat = new THREE.MeshToonMaterial({ color: 0x5a3b26, gradientMap: gradient, emissive: 0x140c08 });
  const inkMat = new THREE.MeshBasicMaterial({ color: OUTLINE_COLOR, side: THREE.BackSide });

  // Which variant each tree is
  const byVariant: number[][] = shapes.map(() => []);
  spots.forEach((_, i) => byVariant[Math.floor(rand() * VARIANTS)].push(i));

  const group = new THREE.Group();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const tint = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);
  shapes.forEach((shape, v) => {
    const ids = byVariant[v];
    if (!ids.length) return;
    const needles = new THREE.InstancedMesh(shape.needles, needleMat, ids.length);
    const snow = new THREE.InstancedMesh(shape.snow, snowMat, ids.length);
    const trunk = new THREE.InstancedMesh(shape.trunk, trunkMat, ids.length);
    const ink = new THREE.InstancedMesh(shape.outline, inkMat, ids.length);
    // They cast shadows on the snow, but don't take any: a tree shading
    // itself through its own overlapping tiers came out as streaky smudges,
    // not clean cel shading
    // (The snow lies on the branches: their shadow already covers it)
    for (const mesh of [needles, trunk]) mesh.castShadow = true;
    ids.forEach((spot, k) => {
      const s = 0.7 + rand() * 0.75;
      q.setFromAxisAngle(up, rand() * Math.PI * 2);
      m.compose(spots[spot], q, scale.set(s, s * (0.9 + rand() * 0.25), s));
      for (const mesh of [needles, snow, trunk, ink]) mesh.setMatrixAt(k, m);
      // Deep spruce greens, a little different on each tree
      needles.setColorAt(k, tint.setHSL(0.36 + rand() * 0.06, 0.32 + rand() * 0.18, (SUMMER_MAP ? 0.24 : 0.2) + rand() * 0.08));
    });
    group.add(needles, trunk, ink);
    if (!SUMMER_MAP) group.add(snow); // (summer: bare branches)
  });
  return group;
}
