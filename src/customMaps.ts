// Jibnut
// Copyright (C) 2026 Frans Ljung
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE
// file for details.

/**
 * Maps made in the map builder, saved in this browser (localStorage).
 *
 * A map is a plain slope (see CUSTOM in terrain.ts) plus what the player
 * did to it: the terrain raised and lowered (a height grid), trees, the
 * spawn point and a name. Kickers ("lips") are kept by the Kickers class,
 * under the map's id.
 */

/** The editable area: x from -HALF_X to HALF_X, z from TOP_Z down to BOTTOM_Z, on a grid of CELL. */
export const SCULPT = { halfX: 150, topZ: 20, bottomZ: -640, cell: 2 };
export const GRID_W = Math.round((2 * SCULPT.halfX) / SCULPT.cell) + 1;
export const GRID_H = Math.round((SCULPT.topZ - SCULPT.bottomZ) / SCULPT.cell) + 1;

export interface CustomMap {
  id: string;
  name: string;
  spawn: { x: number; z: number; yaw: number };
  trees: { x: number; z: number }[];
  /** The terrain's raise/lower, per grid point in centimetres (Int16), base64; empty: flat. */
  sculpt: string;
  updated: number;
}

const KEY = 'jibnut.maps';
export const MAX_TREES = 800;

function storage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadMaps(): CustomMap[] {
  try {
    const raw = storage()?.getItem(KEY);
    return raw ? (JSON.parse(raw) as CustomMap[]) : [];
  } catch {
    return [];
  }
}

function saveAll(maps: CustomMap[]): boolean {
  try {
    storage()?.setItem(KEY, JSON.stringify(maps));
    return true;
  } catch {
    return false; // full or blocked
  }
}

/** Save (add or replace) a map. False if the browser's storage is full. */
export function saveMap(map: CustomMap): boolean {
  const maps = loadMaps().filter((m) => m.id !== map.id);
  maps.push({ ...map, updated: Date.now() });
  return saveAll(maps);
}

export function deleteMap(id: string): void {
  saveAll(loadMaps().filter((m) => m.id !== id));
  try {
    storage()?.removeItem(`jibnut.kickers.${id}`);
  } catch {
    // never mind
  }
}

export function newMap(name: string): CustomMap {
  const map: CustomMap = {
    id: `custom-${Date.now().toString(36)}`,
    name: cleanName(name),
    spawn: { x: 0, z: -12, yaw: 0 }, // (just over the top edge, on the slope)
    trees: [],
    sculpt: '',
    updated: Date.now(),
  };
  saveMap(map);
  return map;
}

/** A map name: trimmed, at most 24 characters, never empty. */
export function cleanName(name: string): string {
  return name.trim().slice(0, 24) || 'My map';
}

/** The height grid, as a Float32Array of metres (GRID_W × GRID_H, row by row from the top). */
export function decodeSculpt(sculpt: string): Float32Array {
  const out = new Float32Array(GRID_W * GRID_H);
  if (!sculpt) return out;
  try {
    const bin = atob(sculpt);
    const n = Math.min(out.length, bin.length >> 1);
    for (let i = 0; i < n; i++) {
      let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      if (v & 0x8000) v -= 0x10000;
      out[i] = v / 100;
    }
  } catch {
    // garbled: flat
  }
  return out;
}

export function encodeSculpt(grid: Float32Array): string {
  let bin = '';
  const chunk: number[] = [];
  for (let i = 0; i < grid.length; i++) {
    const v = Math.max(-32767, Math.min(32767, Math.round(grid[i] * 100))) & 0xffff;
    chunk.push(v & 0xff, v >> 8);
    if (chunk.length >= 8192) {
      bin += String.fromCharCode(...chunk);
      chunk.length = 0;
    }
  }
  bin += String.fromCharCode(...chunk);
  return btoa(bin);
}
