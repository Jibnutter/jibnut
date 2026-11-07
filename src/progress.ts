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
 * What the player has earned and bought, kept in this browser
 * (localStorage): Nuts (the currency: finishing a run earns half its
 * score), the store items they own, and what they're wearing.
 */

/** A piece of clothing: which slot it goes in, and what it looks like. */
export interface Item {
  id: string;
  name: string;
  price: number;
  slot: 'bottom' | 'top' | 'gear';
  kind: 'shorts' | 'pants' | 'tee' | 'jacket' | 'skis' | 'wide-skis' | 'board' | 'bike';
  color: number;
}

/** What you start in (free, always owned). */
export const DEFAULT_BOTTOM: Item = { id: 'green-shorts', name: 'Green baggy shorts', price: 0, slot: 'bottom', kind: 'shorts', color: 0x3f8f3a };
export const DEFAULT_TOP: Item = { id: 'white-tee', name: 'White T-shirt', price: 0, slot: 'top', kind: 'tee', color: 0xf1efe8 };
export const DEFAULT_GEAR: Item = { id: 'skis', name: 'Twin-tip skis', price: 0, slot: 'gear', kind: 'skis', color: 0x16213a };
const DEFAULTS = { bottom: DEFAULT_BOTTOM, top: DEFAULT_TOP, gear: DEFAULT_GEAR };

/** The store. */
export const STORE: Item[] = [
  { id: 'black-pants', name: 'Black baggy snowpants', price: 1200, slot: 'bottom', kind: 'pants', color: 0x1b1c1f },
  { id: 'white-jacket', name: 'White windbreaker', price: 1000, slot: 'top', kind: 'jacket', color: 0xf4f5f2 },
  { id: 'zebra-skis', name: 'Wide zebra skis', price: 4000, slot: 'gear', kind: 'wide-skis', color: 0xf4f4f1 },
  { id: 'mtb', name: 'Full-suspension MTB', price: 3000, slot: 'gear', kind: 'bike', color: 0xff7a1c },
];

/** Everything there is: the free starting gear and the store's. */
export const ALL: Item[] = [DEFAULT_GEAR, DEFAULT_TOP, DEFAULT_BOTTOM, ...STORE];

export interface Outfit {
  bottom: Item;
  top: Item;
  /** Which skis (or the bike). */
  gear: Item;
}

const KEY = 'jibnut.progress';
const OLD_NUTS_KEY = 'jibnut.nuts';

interface Saved {
  nuts: number;
  owned: string[];
  wearing: { bottom: string; top: string; gear: string };
}

function load(): Saved {
  const fresh: Saved = { nuts: 0, owned: [], wearing: { bottom: DEFAULT_BOTTOM.id, top: DEFAULT_TOP.id, gear: DEFAULT_GEAR.id } };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Saved>;
      return { ...fresh, ...saved, wearing: { ...fresh.wearing, ...saved.wearing } };
    }
    // Nuts saved before the store existed
    fresh.nuts = Math.max(0, Number(localStorage.getItem(OLD_NUTS_KEY)) || 0);
  } catch {
    // storage blocked or garbled: start fresh
  }
  return fresh;
}

const state = load();

/**
 * Items taken out of the store: anyone who bought one gets their Nuts back
 * (and is put back on the default in that slot).
 */
const RETIRED: { id: string; price: number; slot: Item['slot'] }[] = [{ id: 'snowboard', price: 1500, slot: 'gear' }];
for (const r of RETIRED) {
  if (!state.owned.includes(r.id)) continue;
  state.owned = state.owned.filter((id) => id !== r.id);
  state.nuts += r.price;
  if (state.wearing[r.slot] === r.id) state.wearing[r.slot] = DEFAULTS[r.slot].id;
  save();
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // storage blocked: it still counts for this visit
  }
}

const listeners: (() => void)[] = [];
/** Call fn whenever Nuts, owned items or the outfit change. */
export function onProgress(fn: () => void): void {
  listeners.push(fn);
}
function changed(): void {
  save();
  for (const fn of listeners) fn();
}

export function nuts(): number {
  return state.nuts;
}

export function addNuts(n: number): void {
  state.nuts += n;
  changed();
}

export function owns(item: Item): boolean {
  return item.price === 0 || state.owned.includes(item.id);
}

/** Buy an item (if affordable): it's put on straight away. */
export function buy(item: Item): boolean {
  if (owns(item) || state.nuts < item.price) return false;
  state.nuts -= item.price;
  state.owned.push(item.id);
  state.wearing[item.slot] = item.id;
  changed();
  return true;
}

export function wearing(item: Item): boolean {
  return state.wearing[item.slot] === item.id;
}

/** Put an owned item on (instead of whatever's in its slot). */
export function wear(item: Item): void {
  if (!owns(item) || wearing(item)) return;
  state.wearing[item.slot] = item.id;
  changed();
}

/** Put an owned item on, or (if already wearing it) back to the default. */
export function toggleWear(item: Item): void {
  if (!owns(item)) return;
  const def = DEFAULTS[item.slot];
  state.wearing[item.slot] = wearing(item) ? def.id : item.id;
  changed();
}

export function outfit(): Outfit {
  const all = ALL;
  const find = (id: string, def: Item) => {
    const item = all.find((i) => i.id === id);
    return item && owns(item) ? item : def;
  };
  return {
    bottom: find(state.wearing.bottom, DEFAULT_BOTTOM),
    top: find(state.wearing.top, DEFAULT_TOP),
    gear: find(state.wearing.gear, DEFAULT_GEAR),
  };
}
