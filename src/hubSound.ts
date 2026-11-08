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
 * The freewheel: a loud, high-engagement ratchet hub, modelled on a
 * Garbaruk RS (measured from a recording of one spinning down):
 *
 *   60 clicks per wheel turn (its loudness pattern repeats every 60)
 *   each click a sharp tick ringing for a few ms, bright: its spectrum
 *   near flat from 0.4 to 12 kHz (resonances fitted to match)
 *   ~3% jitter in the timing and ~15-20% in the loudness, click to click,
 *   the loudness following a fixed pattern round the wheel
 *
 * At speed the clicks run together into a buzz (some 400 a second at
 * 55 km/h), so they're made sample by sample in an AudioWorklet: one tick,
 * synthesised once from its resonances, replayed at each click.
 */

/** Clicks per wheel revolution. */
export const HUB_ENGAGEMENT = 60;

// (Runs on the audio thread; it is loaded from this source as a blob)
const PROCESSOR = `
const ENGAGEMENT = ${HUB_ENGAGEMENT};
// The tick's resonances: [Hz, amplitude, decay ms] (fitted to the
// recording's spectrum: near flat from 0.4 to 12 kHz, peaking round 2.5-3.5)
const MODES = [
  [700, 0.11, 2.3], [1100, 0.17, 1.8], [1820, 0.19, 1.8], [2880, 0.16, 4], [3150, 0.1, 4], [3750, 0.12, 3], [4540, 0.12, 4],
  [5790, 1.0, 0.2], [7000, 0.2, 4], [8400, 0.4, 0.2], [9500, 0.15, 4], [11800, 0.86, 0.38],
];
// The pawl striking: a broadband snap (amplitude, decay ms)
const SNAP = [0.69, 0.47];
class HubProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rate', defaultValue: 0, minValue: 0, maxValue: 4000, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    // Seeded randomness: the same hub every time
    let seed = 0x5eed;
    this.rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const n = Math.round(sampleRate * 0.012);
    const tick = new Float32Array(n);
    for (const [f, a, ms] of MODES) {
      const ph = this.rand() * Math.PI * 2;
      const k = 1 / (ms * 0.001 * sampleRate);
      for (let i = 0; i < n; i++) tick[i] += a * Math.exp(-i * k) * Math.sin(ph + (2 * Math.PI * f * i) / sampleRate);
    }
    for (let i = 0; i < n; i++) tick[i] += SNAP[0] * Math.exp(-i / (SNAP[1] * 0.001 * sampleRate)) * (this.rand() * 2 - 1);
    // (Faded out over its last 2 ms: no step where it's cut off)
    const fade = Math.round(sampleRate * 0.002);
    for (let i = 0; i < fade; i++) tick[n - 1 - i] *= i / fade;
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(tick[i]));
    for (let i = 0; i < n; i++) tick[i] /= peak;
    this.tick = tick;
    // Loudness round the wheel: each tooth its own
    this.pattern = Array.from({ length: ENGAGEMENT }, () => 0.8 + 0.4 * this.rand());
    this.tooth = 0;
    this.phase = 0;
    this.next = 1;
    this.voices = []; // [position in the tick, amplitude]
  }
  process(_inputs, outputs, params) {
    const out = outputs[0][0];
    const step = params.rate[0] / sampleRate;
    const tick = this.tick;
    for (let i = 0; i < out.length; i++) {
      if (step > 0) {
        this.phase += step;
        if (this.phase >= this.next) {
          this.phase -= this.next;
          this.next = 1 + (this.rand() - 0.5) * 0.06; // timing jitter
          this.tooth = (this.tooth + 1) % ENGAGEMENT;
          if (this.voices.length < 16) this.voices.push([0, this.pattern[this.tooth] * (0.92 + 0.16 * this.rand())]);
        }
      }
      let s = 0;
      for (let v = this.voices.length - 1; v >= 0; v--) {
        const voice = this.voices[v];
        s += tick[voice[0]] * voice[1];
        if (++voice[0] >= tick.length) this.voices.splice(v, 1);
      }
      out[i] = s;
    }
    return true;
  }
}
registerProcessor('jibnut-hub', HubProcessor);
`;

/**
 * The hub's sound source: set `rate` (clicks per second) as the wheel turns.
 * Null where AudioWorklets aren't available (the freewheel is then silent).
 */
export async function createHub(ctx: BaseAudioContext): Promise<AudioWorkletNode | null> {
  if (!ctx.audioWorklet) return null;
  const url = URL.createObjectURL(new Blob([PROCESSOR], { type: 'application/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  return new AudioWorkletNode(ctx, 'jibnut-hub', { numberOfInputs: 0, outputChannelCount: [1] });
}
