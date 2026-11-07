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
}

export function readControls(): Controls {
  return {
    steer:
      (held('KeyA', 'ArrowLeft') ? 1 : 0) - (held('KeyD', 'ArrowRight') ? 1 : 0),
    tuck: held('KeyW', 'ArrowUp'),
    brake: held('KeyS', 'ArrowDown'),
    jump: held('Space'),
  };
}
