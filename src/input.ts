// Jibnut
// Copyright (C) 2026 Frans Ljung
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE
// file for details.

/** Keyboard state for WASD (and arrow keys as a fallback). */
const down = new Set<string>();

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') e.preventDefault(); // don't scroll or click buttons
  down.add(e.code);
});
window.addEventListener('keyup', (e) => down.delete(e.code));
window.addEventListener('blur', () => down.clear()); // don't get stuck turning

const held = (...codes: string[]) => codes.some((c) => down.has(c));

export interface Controls {
  /** -1 = turn right, +1 = turn left */
  steer: number;
  tuck: boolean;
  brake: boolean;
  /** Held to charge a jump; the jump fires on release. */
  jump: boolean;
  /** In the air: a shifty (held). */
  shifty?: boolean;
}

export function readControls(): Controls {
  const keys = (held('KeyA', 'ArrowLeft') ? 1 : 0) - (held('KeyD', 'ArrowRight') ? 1 : 0);
  const p = padState;
  return {
    steer: THREE_CLAMP(keys + p.steer),
    tuck: held('KeyW', 'ArrowUp') || p.tuck,
    brake: held('KeyS', 'ArrowDown') || p.brake,
    jump: held('Space') || p.jump,
    shifty: held('ShiftRight') || p.shifty,
  };
}

const THREE_CLAMP = (v: number) => Math.max(-1, Math.min(1, v));

// ---------------------------------------------------------------------------
// Gamepad (an Xbox controller, or any pad the browser maps to its "standard"
// layout). Read once a frame by pollGamepad().
//
//   Left stick / D-pad   steer (the stick is analog)
//   RT or stick up       tuck / pedal          LT or stick down   brake
//   A                    jump (hold: grab)     B or RB            shifty
//   X                    restart               Y                  camera
//   Menu                 menu
//
// In the menus: D-pad or stick to move between buttons, A to press, B back.

const B = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
const DEAD = 0.2; // stick dead zone
const padState = { steer: 0, tuck: false, brake: false, jump: false, shifty: false };
const wasDown: boolean[] = [];
let navHeld = '';
let navRepeatAt = 0;

/** The first connected pad, if any. */
function activePad(): Gamepad | null {
  const pads = navigator.getGamepads?.() ?? [];
  for (const p of pads) if (p && p.connected) return p;
  return null;
}

/** Shake the controller (if it can): strength 0..1, for ms. */
export function rumble(strength: number, ms: number): void {
  const pad = activePad() as (Gamepad & { vibrationActuator?: { playEffect?: (t: string, o: object) => Promise<unknown> } }) | null;
  pad?.vibrationActuator?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: strength, weakMagnitude: Math.min(1, strength * 1.3) })?.catch(() => {});
}

/** As if a key was pressed (the game's own key handlers do the rest). */
function press(code: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
}

/**
 * Read the pad: riding controls for readControls, and its buttons as key
 * presses. `menu`: the menu is up (the pad moves between its buttons there).
 */
export function pollGamepad(menu: HTMLElement | null): void {
  const pad = activePad();
  if (!pad) {
    padState.steer = 0;
    padState.tuck = padState.brake = padState.jump = padState.shifty = false;
    return;
  }
  const btn = (i: number) => !!pad.buttons[i]?.pressed;
  const val = (i: number) => pad.buttons[i]?.value ?? 0;
  const pressed = (i: number) => btn(i) && !wasDown[i];
  const dz = (v: number) => (Math.abs(v) < DEAD ? 0 : Math.sign(v) * ((Math.abs(v) - DEAD) / (1 - DEAD)));
  const sx = dz(pad.axes[0] ?? 0);
  const sy = dz(pad.axes[1] ?? 0); // (+ = down)

  if (menu) {
    padState.steer = 0;
    padState.tuck = padState.brake = padState.jump = padState.shifty = false;
    menuNav(menu, pad, sx, sy, pressed);
  } else {
    padState.steer = THREE_CLAMP(-sx + (btn(B.LEFT) ? 1 : 0) - (btn(B.RIGHT) ? 1 : 0));
    padState.tuck = val(B.RT) > 0.3 || sy < -0.5 || btn(B.UP);
    padState.brake = val(B.LT) > 0.3 || sy > 0.5 || btn(B.DOWN);
    padState.jump = btn(B.A);
    padState.shifty = btn(B.B) || btn(B.RB);
    if (pressed(B.X)) press('KeyR');
    if (pressed(B.Y)) press('KeyC');
    if (pressed(B.MENU)) press('Escape');
  }
  for (let i = 0; i < pad.buttons.length; i++) wasDown[i] = btn(i);
}

/** Menu navigation: move focus to the nearest button that way; A presses, B goes back. */
function menuNav(menu: HTMLElement, pad: Gamepad, sx: number, sy: number, pressed: (i: number) => boolean): void {
  const btn = (i: number) => !!pad.buttons[i]?.pressed;
  const dir =
    btn(B.UP) || sy < -0.5 ? 'up' : btn(B.DOWN) || sy > 0.5 ? 'down' : btn(B.LEFT) || sx < -0.5 ? 'left' : btn(B.RIGHT) || sx > 0.5 ? 'right' : '';
  const now = performance.now();
  // A direction moves once, then repeats while held
  let move = '';
  if (dir && dir !== navHeld) {
    move = dir;
    navRepeatAt = now + 380;
  } else if (dir && now >= navRepeatAt) {
    move = dir;
    navRepeatAt = now + 140;
  }
  navHeld = dir;

  const items = [...menu.querySelectorAll<HTMLElement>('button, a[href], input[type="range"]')].filter(
    (el) => el.offsetParent !== null && !(el as HTMLButtonElement).disabled,
  );
  if (!items.length) return;
  let current = document.activeElement as HTMLElement | null;
  if (!current || !items.includes(current)) current = null;
  if (move) {
    // A slider takes left / right for itself
    if (current instanceof HTMLInputElement && (move === 'left' || move === 'right')) {
      if (move === 'left') current.stepDown();
      else current.stepUp();
      current.dispatchEvent(new Event('input', { bubbles: true }));
      current.dispatchEvent(new Event('change', { bubbles: true }));
    } else focusItem(current ? nearest(current, items, move) ?? current : items[0]);
  }
  if (pressed(B.A)) {
    if (current && !(current instanceof HTMLInputElement)) current.click();
    else if (!current) focusItem(items[0]);
  }
  if (pressed(B.B)) {
    const back = items.find((el) => el.classList.contains('back'));
    back?.click();
  }
}

function focusItem(el: HTMLElement): void {
  document.querySelectorAll('.pad-focus').forEach((e) => e.classList.remove('pad-focus'));
  el.classList.add('pad-focus');
  el.focus({ preventScroll: false });
  el.scrollIntoView({ block: 'nearest' });
}

/** The closest item from `from` in a direction (by the centres of their boxes). */
function nearest(from: HTMLElement, items: HTMLElement[], dir: string): HTMLElement | null {
  const a = from.getBoundingClientRect();
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of items) {
    if (el === from) continue;
    const b = el.getBoundingClientRect();
    const dx = b.left + b.width / 2 - ax;
    const dy = b.top + b.height / 2 - ay;
    const along = dir === 'up' ? -dy : dir === 'down' ? dy : dir === 'left' ? -dx : dx;
    const across = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy);
    if (along <= 2) continue; // not that way
    const score = along + across * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}
