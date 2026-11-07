import { MAP, MAPS } from './terrain';
import * as progress from './progress';

export type Page = 'main' | 'maps' | 'locker' | 'store' | 'controls';

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
          <button type="button" data-go="locker">Locker</button>
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

      <section class="page locker">
        <div class="crumb">Jibnut</div>
        <h2>Locker</h2>
        <div class="slots"></div>
        <p class="store-help">Get more in the Store.</p>
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
          <dt><kbd>Space</kbd></dt><dd>Hold: X tail grab (skis crossed, right hand on the right tail). Let go before you land!</dd>
          <dt class="group">Rails</dt><dd class="group"></dd>
          <dt><kbd>A</kbd> / <kbd>D</kbd></dt><dd>Swing the skis across for a boardslide</dd>
          <dt class="group">Anytime</dt><dd class="group"></dd>
          <dt><kbd>C</kbd></dt><dd>First / third person</dd>
          <dt><kbd>R</kbd></dt><dd>Restart the run</dd>
          <dt><kbd>Esc</kbd></dt><dd>Menu</dd>
          <dt><kbd>P</kbd></dt><dd>Physical skiing (experimental)</dd>
          <dt><kbd>K</kbd></dt><dd>Show collision shapes</dd>
        </dl>
        <button type="button" class="back" data-go="main">Back</button>
      </section>`;
    document.body.appendChild(this.el);
    progress.onProgress(() => this.refresh());
    this.refresh();

    this.el.addEventListener('click', (e) => {
      const button = (e.target as HTMLElement).closest('button');
      if (!button) return;
      if (button.dataset.buy) {
        progress.buy(progress.STORE.find((i) => i.id === button.dataset.buy)!);
      } else if (button.dataset.wear) {
        progress.wear(progress.ALL.find((i) => i.id === button.dataset.wear)!);
      } else if (button.dataset.setting === 'crashes') this.setCrashes(!this.crashes);
      else if (button.dataset.go) this.go(button.dataset.go as Page);
      else if (button.dataset.map) this.start(Number(button.dataset.map));
    });
    window.addEventListener('keydown', (e) => {
      if (!this.visible) return;
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
