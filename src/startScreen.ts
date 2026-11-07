// Jibnut
// Copyright (C) 2026 Frans Ljung
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE
// file for details.

import { MAP, MAPS, CUSTOM } from './terrain';
import { loadMaps, newMap, deleteMap, MAP_BUILDER_ENABLED } from './customMaps';
import { DESIGN_RANGES, DEFAULT_DESIGN, hasFrameModel } from './bikeModel';
import * as progress from './progress';

export type Page = 'main' | 'maps' | 'builder' | 'locker' | 'workshop' | 'store' | 'controls';

/**
 * The menu, over the live 3D scene (the camera circles the first jump while
 * it's up):
 *
 *   main      the game's name, and two buttons: Maps and Controls
 *   maps      each map, with what's on it and a button to drop in
 *   controls  the keys
 *
 * Esc (or Back) goes up a level; in the game, Esc brings the menu back.
 * Arrow keys / Tab move between buttons, Enter presses.
 */
export class StartScreen {
  readonly el: HTMLDivElement;
  private page: Page = 'main';
  private crashes = true;
  private onCrashes: (on: boolean) => void = () => {};
  private onStart: (map: number) => void = () => {};

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'start';
    this.el.innerHTML = `
      <section class="page main">
        <div class="logo">
          <h1 class="title" aria-label="Jibnut">${[...'JIBNUT'].map((c) => `<span>${c}</span>`).join('')}</h1>
          <div class="plank" aria-hidden="true"><i class="nail"></i><i class="nail"></i><i class="nail"></i></div>
        </div>
        <div class="tagline">Slopestyle in deep powder</div>
        <div class="nuts" title="Nuts: earned by finishing runs (half your score)"><span class="nut-icon" aria-hidden="true"></span><span class="nut-count">0</span> Nuts</div>
        <nav class="menu">
          <button type="button" data-go="maps">Maps</button>
          ${MAP_BUILDER_ENABLED ? '<button type="button" data-go="builder">Map builder</button>' : ''}
          <button type="button" data-go="locker">Locker</button>
          <button type="button" data-go="workshop">Bike workshop</button>
          <button type="button" data-go="store">Store</button>
          <button type="button" data-go="controls">Controls</button>
        </nav>
      </section>

      <section class="page maps">
        <div class="crumb">Jibnut</div>
        <h2>Maps</h2>
        <div class="cards">
          ${MAPS.map(
            (m, i) => `
            <article class="card">
              <h3>${m.name}</h3>
              <p>${m.description}</p>
              <ul class="features">${m.features.map((f) => `<li>${f}</li>`).join('')}</ul>
              <button type="button" class="play" data-map="${i}">Drop in</button>
            </article>`,
          ).join('')}
        </div>
        <button type="button" class="back" data-go="main">Back</button>
      </section>

      <section class="page builder">
        <div class="crumb">Jibnut</div>
        <h2>Map builder</h2>
        <form class="new-map">
          <input type="text" maxlength="24" placeholder="Name your map" spellcheck="false" aria-label="Map name">
          <button type="submit" class="play">Create</button>
        </form>
        <div class="my-maps"></div>
        <p class="store-help">Shape the snow, place lips and trees, set where the run starts. Maps are saved in this browser.</p>
        <button type="button" class="back" data-go="main">Back</button>
      </section>

      <section class="page locker">
        <div class="crumb">Jibnut</div>
        <h2>Locker</h2>
        <div class="slots"></div>
        <p class="store-help">Get more in the Store.</p>
        <button type="button" class="back" data-go="main">Back</button>
      </section>

      <section class="page workshop">
        <div class="crumb">Jibnut</div>
        <h2>Bike workshop</h2>
        <div class="design"></div>
        <p class="store-help">Design your mountain bike's frame. Buy the bike in the Store, ride it from the Locker.</p>
        <button type="button" class="back" data-go="main">Back</button>
      </section>

      <section class="page store">
        <div class="crumb">Jibnut</div>
        <h2>Store</h2>
        <div class="nuts wallet"><span class="nut-icon" aria-hidden="true"></span><span class="nut-count">0</span> Nuts</div>
        <div class="items">
          ${progress.STORE.map(
            (item) => `
            <article class="item" data-item="${item.id}">
              <div class="swatch" style="--c: #${item.color.toString(16).padStart(6, '0')}" data-kind="${item.kind}"></div>
              <div class="item-info">
                <h3>${item.name}</h3>
                <div class="price"><span class="nut-icon" aria-hidden="true"></span>${item.price.toLocaleString('en-US')}</div>
              </div>
              <button type="button" class="buy" data-buy="${item.id}"></button>
            </article>`,
          ).join('')}
        </div>
        <p class="store-help">Earn Nuts by finishing runs: half your score. Choose what to wear in the Locker.</p>
        <button type="button" class="back" data-go="main">Back</button>
      </section>

      <section class="page controls">
        <div class="crumb">Jibnut</div>
        <h2>Controls</h2>
        <div class="setting">
          <div>
            <div class="setting-name">Crashes</div>
            <div class="setting-help">Off: nothing ends your run. Bad landings are ridden away.</div>
          </div>
          <button type="button" class="switch" role="switch" aria-checked="true" data-setting="crashes">
            <span class="knob"></span><span class="state">On</span>
          </button>
        </div>
        <dl class="keys">
          <dt><kbd>A</kbd><kbd>D</kbd></dt><dd>Turn</dd>
          <dt><kbd>W</kbd></dt><dd>Tuck</dd>
          <dt><kbd>S</kbd></dt><dd>Brake (hockey stop, swinging the way you last turned)</dd>
          <dt><kbd>Space</kbd></dt><dd>Hold and release to jump: longer hold, bigger pop</dd>
          <dt>Space + <kbd>S</kbd> / <kbd>W</kbd></dt><dd>Lean back / forward for a backflip / frontflip</dd>
          <dt>Space + <kbd>A</kbd> / <kbd>D</kbd></dt><dd>Wind up a spin</dd>
          <dt class="group">In the air</dt><dd class="group"></dd>
          <dt><kbd>S</kbd></dt><dd>Tuck or arch: flip faster</dd>
          <dt><kbd>A</kbd> / <kbd>D</kbd></dt><dd>Arms in: spin faster</dd>
          <dt><kbd>W</kbd></dt><dd>Open up and spot the landing</dd>
          <dt><kbd>Right Shift</kbd></dt><dd>Hold: shifty (skis 45° to the left, tips down, shoulders the other way)</dd>
          <dt><kbd>Space</kbd></dt><dd>Hold: X tail grab (skis crossed, right hand on the right tail). Let go before you land!</dd>
          <dt class="group">Rails</dt><dd class="group"></dd>
          <dt><kbd>A</kbd> / <kbd>D</kbd></dt><dd>Swing the skis across for a boardslide</dd>
          <dt class="group">On the mountain bike</dt><dd class="group"></dd>
          <dt><kbd>W</kbd></dt><dd>Pedal</dd>
          <dt>Space + <kbd>S</kbd> / <kbd>W</kbd></dt><dd>Backflip / frontflip: yank the bars back, or throw the bike forward, off the lip</dd>
          <dt><kbd>Space</kbd> / <kbd>Right Shift</kbd></dt><dd>In the air: no-hander / tabletop</dd>
          <dt class="group">Anytime</dt><dd class="group"></dd>
          <dt><kbd>C</kbd></dt><dd>First / third person</dd>
          <dt><kbd>R</kbd></dt><dd>Restart the run</dd>
          <dt><kbd>Esc</kbd></dt><dd>Menu</dd>
          <dt><kbd>P</kbd></dt><dd>Physical skiing (experimental)</dd>
          <dt><kbd>K</kbd></dt><dd>Show collision shapes</dd>
        </dl>
        <button type="button" class="back" data-go="main">Back</button>
      </section>`;
    // The small print, along the bottom of the front page
    const legal = document.createElement('footer');
    legal.className = 'legal';
    legal.innerHTML = `Jibnut © 2026 Frans Ljung · Free software under the
      <a href="https://www.gnu.org/licenses/gpl-3.0.html" target="_blank" rel="noopener">GNU GPL v3 or later</a>
      · <a href="https://github.com/Jibnutter/jibnut" target="_blank" rel="noopener">Source code</a>`;
    this.el.querySelector('.page.main')!.appendChild(legal);
    document.body.appendChild(this.el);
    this.buildWorkshop();
    progress.onProgress(() => this.refresh());
    this.refresh();

    this.el.addEventListener('click', (e) => {
      const button = (e.target as HTMLElement).closest('button');
      if (!button) return;
      if (button.dataset.buy) {
        progress.buy(progress.STORE.find((i) => i.id === button.dataset.buy)!);
      } else if (button.dataset.wear) {
        progress.wear(progress.ALL.find((i) => i.id === button.dataset.wear)!);
      } else if (button.dataset.edit) {
        location.search = `?map=${button.dataset.edit}&edit=1`;
      } else if (button.dataset.ride) {
        location.search = `?map=${button.dataset.ride}&play=1`;
      } else if (button.dataset.del) {
        const map = loadMaps().find((m) => m.id === button.dataset.del);
        if (map && confirm(`Delete "${map.name}"? This can't be undone.`)) {
          deleteMap(map.id);
          // (if it's the map that's loaded, go back to the first one)
          if (map.id === MAP.id) location.search = '';
          else this.renderMyMaps();
        }
      } else if (button.dataset.setting === 'crashes') this.setCrashes(!this.crashes);
      else if (button.dataset.go) this.go(button.dataset.go as Page);
      else if (button.dataset.map) this.start(Number(button.dataset.map));
    });
    this.el.querySelector<HTMLFormElement>('.new-map')!.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = this.el.querySelector<HTMLInputElement>('.new-map input')!;
      const map = newMap(input.value);
      location.search = `?map=${map.id}&edit=1`;
    });
    this.renderMyMaps();
    window.addEventListener('keydown', (e) => {
      if (!this.visible) return;
      if ((e.target as HTMLElement | null)?.tagName === 'INPUT' && e.code !== 'Escape') return; // (typing)
      if (e.code === 'Escape' && this.page !== 'main') {
        e.preventDefault();
        this.go('main');
      } else if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
        // Move between this page's buttons
        e.preventDefault();
        const buttons = this.buttons();
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const step = e.code === 'ArrowDown' ? 1 : -1;
        buttons[(i + step + buttons.length) % buttons.length]?.focus();
      }
    });
    this.go('main');
  }

  /** Crashes on or off (see Skier.crashes); remembered in this browser. */
  whenCrashesSet(fn: (on: boolean) => void): void {
    this.onCrashes = fn;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem('jibnut.crashes');
    } catch {
      // storage blocked: just default to on
    }
    this.setCrashes(saved !== 'off');
  }

  private setCrashes(on: boolean): void {
    this.crashes = on;
    const sw = this.el.querySelector<HTMLButtonElement>('[data-setting="crashes"]')!;
    sw.setAttribute('aria-checked', String(on));
    sw.querySelector('.state')!.textContent = on ? 'On' : 'Off';
    try {
      localStorage.setItem('jibnut.crashes', on ? 'on' : 'off');
    } catch {
      // storage blocked: the setting still holds for this visit
    }
    this.onCrashes(on);
  }

  /** Show the player's Nuts, and each store item's state (buy / wear / wearing). */
  private refresh(): void {
    this.showDesign();
    const n = progress.nuts();
    for (const el of this.el.querySelectorAll('.nut-count')) el.textContent = n.toLocaleString('en-US');
    for (const item of progress.STORE) {
      const button = this.el.querySelector<HTMLButtonElement>(`[data-buy="${item.id}"]`)!;
      const card = button.closest('.item')!;
      const owned = progress.owns(item);
      const on = owned && progress.wearing(item);
      card.classList.toggle('owned', owned);
      card.classList.toggle('wearing', on);
      button.classList.toggle('short', !owned && n < item.price);
      button.textContent = owned ? 'Owned ✓' : n >= item.price ? 'Buy' : `Need ${(item.price - n).toLocaleString('en-US')} more`;
      button.disabled = owned || n < item.price;
    }
    // The locker: what you own, slot by slot; tap to wear it
    const slots: [progress.Item['slot'], string][] = [
      ['gear', 'Ride'],
      ['top', 'Top'],
      ['bottom', 'Bottom'],
    ];
    this.el.querySelector('.slots')!.innerHTML = slots
      .map(
        ([slot, label]) => `
        <div class="slot">
          <div class="slot-name">${label}</div>
          <div class="choices">
            ${progress.ALL.filter((i) => i.slot === slot && progress.owns(i))
              .map(
                (i) => `
              <button type="button" class="choice${progress.wearing(i) ? ' on' : ''}" data-wear="${i.id}" aria-pressed="${progress.wearing(i)}">
                <span class="swatch" style="--c: #${i.color.toString(16).padStart(6, '0')}" data-kind="${i.kind}"></span>
                <span>${i.name}</span>
              </button>`,
              )
              .join('')}
          </div>
        </div>`,
      )
      .join('');
  }

  get visible(): boolean {
    return !this.el.classList.contains('hidden');
  }

  get currentPage(): Page {
    return this.page;
  }

  /** Bring the menu back (from the game), on its main page. */
  show(): void {
    this.el.classList.remove('hidden');
    this.go('main');
  }

  /** Called with the chosen map when the player drops in. */
  whenStarted(fn: (map: number) => void): void {
    this.onStart = fn;
    // Arrived from picking this map: drop straight in (and tidy the URL, so
    // a reload shows the menu again, still on this map)
    const params = new URLSearchParams(location.search);
    if (params.get('play')) {
      params.delete('play');
      history.replaceState(null, '', `${location.pathname}?${params}`);
      this.start(MAPS.findIndex((m) => m.id === MAP.id));
    }
  }

  /** The bike workshop's controls: colours, geometry sliders and choices. */
  private buildWorkshop(): void {
    const box = this.el.querySelector<HTMLDivElement>('.design')!;
    const frameColors = [0xff7a1c, 0xd62e2e, 0x2f6fd6, 0x2bb673, 0xf2c230, 0x8a4fd8, 0xf4f4f1, 0x1d1f22];
    const forkColors = [0xd8a63a, 0x1d1f22, 0xb9c0c8, 0xff7a1c, 0xd62e2e, 0x2f6fd6];
    const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
    const swatches = (key: string, colors: number[]) =>
      `<div class="swatches">${colors.map((c) => `<button type="button" class="colour" data-key="${key}" data-value="${c}" style="--c: ${hex(c)}" aria-label="${hex(c)}"></button>`).join('')}</div>`;
    const slider = (key: keyof typeof DESIGN_RANGES, label: string, unit: (v: number) => string) => {
      const r = DESIGN_RANGES[key];
      return `<label class="slider">${label} <span class="val" data-val="${key}"></span>
        <input type="range" data-key="${key}" min="${r.min}" max="${r.max}" step="${r.step}" data-unit="${unit === mm ? 'mm' : 'deg'}"></label>`;
    };
    const mm = (v: number) => `${Math.round(v * 1000)} mm`;
    const deg = (v: number) => `${v.toFixed(1)}°`;
    const choice = (key: string, options: [string, string][]) =>
      `<div class="choice-row">${options.map(([v, l]) => `<button type="button" class="opt" data-key="${key}" data-value="${v}">${l}</button>`).join('')}</div>`;
    box.innerHTML = `
      <div class="field"><div class="field-name">Style</div>${choice('style', [['trail', 'Trail'], ['downhill', 'Downhill'], ...(hasFrameModel() ? [['mine', 'My frame'] as [string, string]] : [])])}</div>
      <div class="field"><div class="field-name">Frame colour</div>${swatches('frameColor', frameColors)}</div>
      <div class="field"><div class="field-name">Fork colour</div>${swatches('forkColor', forkColors)}</div>
      ${slider('headAngle', 'Head angle', deg)}
      ${slider('reach', 'Reach', mm)}
      ${slider('stack', 'Stack', mm)}
      ${slider('chainstay', 'Chainstay', mm)}
      <div class="field"><div class="field-name">Wheels</div>${choice('wheel', [['27.5', '27.5"'], ['29', '29"']])}</div>
      <div class="field"><div class="field-name">Tubes</div>${choice('tubes', [['slim', 'Slim'], ['normal', 'Normal'], ['burly', 'Burly']])}</div>
      <div class="field"><div class="field-name">Top tube</div>${choice('topTube', [['straight', 'Straight'], ['dropped', 'Dropped']])}</div>
      <button type="button" class="opt reset" data-reset="1">Reset to stock</button>`;
    const set = (key: string, value: string | number) => {
      const d = progress.bikeDesign() as unknown as Record<string, unknown>;
      d[key] = typeof value === 'string' && key !== 'tubes' && key !== 'topTube' && key !== 'style' ? Number(value) : value;
      progress.setBikeDesign(d as unknown as ReturnType<typeof progress.bikeDesign>);
    };
    box.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      if (b.dataset.reset) progress.setBikeDesign({ ...DEFAULT_DESIGN });
      else if (b.dataset.key) set(b.dataset.key, b.dataset.value!);
    });
    box.addEventListener('input', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.dataset.key) set(input.dataset.key, Number(input.value));
    });
    this.showDesign = () => {
      const d = progress.bikeDesign() as unknown as Record<string, number | string>;
      for (const b of box.querySelectorAll<HTMLButtonElement>('[data-key]')) {
        if (b.tagName !== 'BUTTON') continue;
        b.classList.toggle('on', String(d[b.dataset.key!]) === b.dataset.value);
      }
      for (const input of box.querySelectorAll<HTMLInputElement>('input[type=range]')) {
        input.value = String(d[input.dataset.key!]);
        const v = Number(d[input.dataset.key!]);
        box.querySelector(`[data-val="${input.dataset.key}"]`)!.textContent = input.dataset.unit === 'mm' ? mm(v) : deg(v);
      }
    };
    this.showDesign();
  }
  private showDesign: () => void = () => {};

  /** Your maps in the builder: ride, edit or delete each. */
  private renderMyMaps(): void {
    const maps = loadMaps().sort((a, b) => b.updated - a.updated);
    const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    this.el.querySelector('.my-maps')!.innerHTML = maps.length
      ? maps
          .map(
            (m) => `
        <article class="my-map">
          <h3>${esc(m.name)}</h3>
          <div class="my-map-buttons">
            <button type="button" class="play" data-ride="${m.id}">Ride</button>
            <button type="button" data-edit="${m.id}">Edit</button>
            <button type="button" class="del" data-del="${m.id}" aria-label="Delete ${esc(m.name)}">Delete</button>
          </div>
        </article>`,
          )
          .join('')
      : '<p class="store-help">No maps yet: name one and create it.</p>';
  }

  /** Called when arriving to edit a map (?edit=1). */
  whenEditing(fn: () => void): void {
    const params = new URLSearchParams(location.search);
    if (!params.get('edit') || !CUSTOM) return;
    params.delete('edit');
    history.replaceState(null, '', `${location.pathname}?${params}`);
    this.el.classList.add('hidden');
    (document.activeElement as HTMLElement | null)?.blur();
    fn();
  }

  /** Called whenever the menu changes page (the locker shows the rider). */
  onPage: (page: Page) => void = () => {};

  private go(page: Page): void {
    const from = this.page;
    this.page = page;
    this.el.dataset.page = page;
    this.onPage(page);
    // Focus the first button there (or, coming back, the one that led away)
    const back = page === 'main' && from !== 'main' ? this.el.querySelector<HTMLButtonElement>(`[data-go="${from}"]`) : null;
    (back ?? this.buttons()[0])?.focus();
  }

  private buttons(): HTMLButtonElement[] {
    return [...this.el.querySelectorAll<HTMLButtonElement>(`.page.${this.page} button`)];
  }

  private start(map: number): void {
    const id = MAPS[map].id;
    if (id !== MAP.id) {
      // Another map: the terrain is built once per page load, so load the
      // page again on that map, going straight into the run
      location.search = `?map=${id}&play=1`;
      return;
    }
    this.el.classList.add('hidden');
    (document.activeElement as HTMLElement | null)?.blur(); // Space mustn't press a button
    this.onStart(map);
  }
}
