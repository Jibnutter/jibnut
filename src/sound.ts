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
import type { Skier } from './skier';
import type { Controls } from './input';
import { normalAt, SUMMER_MAP } from './terrain';
import { createHub, HUB_ENGAGEMENT } from './hubSound';

/**
 * The game's sound, all made on the fly with Web Audio (no sound files):
 *
 *   wind        filtered noise, rising with speed (and louder in the air)
 *   surface     skis/board hissing on snow, or tyres rumbling on dirt with
 *               gravel crackling; a scrape when braking or carving hard
 *   freewheel   the bike's rear hub clicking while you're not pedalling (a
 *               loud 60-tooth ratchet, see hubSound.ts)
 *   grind       a metallic ring sliding a rail
 *   one-shots   takeoff whoosh, landing thump (by how hard), crash, tumble
 *               thuds, a chime for a clean trick
 *   ambience    a breeze; in summer, birds
 *
 * Browsers only allow audio after the player has done something, so the
 * audio starts on the first click or key press. N mutes (remembered).
 */

const MUTE_KEY = 'jibnut.muted';
const MASTER = 0.8;
const WHEEL_R = 0.37; // m (as the bike's)
const HUB_LEVEL = 0.07;

const tmpN = new THREE.Vector3();
const tmpCentre = new THREE.Vector3();

/** A smooth gain/parameter change, without clicks. */
function glide(p: AudioParam, value: number, now: number, time = 0.06): void {
  p.setTargetAtTime(value, now, time);
}

export class Sound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  muted: boolean;

  // Continuous layers
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private hissGain!: GainNode;
  private hissFilter!: BiquadFilterNode;
  private rumbleGain!: GainNode;
  private rumbleFilter!: BiquadFilterNode;
  private scrapeGain!: GainNode;
  private scrapeFilter!: BiquadFilterNode;
  private grindGain!: GainNode;
  private hubGain!: GainNode;
  private hub: AudioWorkletNode | null = null;
  private breezeGain!: GainNode;

  // What the rider was doing last frame
  private wasGrounded = true;
  private wasTumbling = false;
  private readonly lastVel = new THREE.Vector3();
  private readonly lastCentre = new THREE.Vector3();
  private lastCentreSpeed = 0;
  private centreKnown = false;
  private crackleDebt = 0;
  private nextBird = 3;
  private sinceThud = 0;
  private hubSpeed = 0; // the rear wheel keeps spinning in the air

  constructor() {
    let saved = false;
    try {
      saved = localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      // (no storage: not muted)
    }
    this.muted = saved;
    const start = () => {
      this.start();
      if (this.ctx?.state === 'running') {
        window.removeEventListener('pointerdown', start);
        window.removeEventListener('keydown', start);
      }
    };
    window.addEventListener('pointerdown', start);
    window.addEventListener('keydown', start);
  }

  /** Sound on or off. */
  toggleMute(): boolean {
    this.muted = !this.muted;
    try {
      localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0');
    } catch {
      // (not remembered)
    }
    if (this.ctx) glide(this.master.gain, this.muted ? 0 : MASTER, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  private start(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return; // (no Web Audio: the game is silent)
    const ctx = new AC();
    this.ctx = ctx;

    // Master: a gentle compressor so stacked thumps don't clip
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.attack.value = 0.005;
    comp.release.value = 0.2;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : MASTER;
    this.master.connect(comp).connect(ctx.destination);

    // Two seconds of white noise, shared by every noisy sound
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    const layer = (type: BiquadFilterType, freq: number, q: number): [GainNode, BiquadFilterNode] => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      src.loopStart = Math.random(); // (each layer from its own spot: no phasing)
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(f).connect(g).connect(this.master);
      src.start(0, Math.random() * 2);
      return [g, f];
    };
    [this.windGain, this.windFilter] = layer('lowpass', 400, 0.5);
    [this.hissGain, this.hissFilter] = layer('bandpass', 3000, 0.6);
    [this.rumbleGain, this.rumbleFilter] = layer('lowpass', 250, 0.7);
    [this.scrapeGain, this.scrapeFilter] = layer('bandpass', 1200, 1.2);
    [this.breezeGain] = layer('lowpass', 500, 0.3);
    glide(this.breezeGain.gain, 0.025, ctx.currentTime, 1);

    // Rail grind: noise through two narrow resonances (steel ringing)
    {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      this.grindGain = ctx.createGain();
      this.grindGain.gain.value = 0;
      for (const [freq, level] of [
        [2350, 1],
        [3720, 0.6],
        [5100, 0.35],
      ]) {
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = freq;
        f.Q.value = 30;
        const g = ctx.createGain();
        g.gain.value = level * 6;
        src.connect(f).connect(g).connect(this.grindGain);
      }
      this.grindGain.connect(this.master);
      src.start();
    }

    // Freewheel: the hub's pawls clicking over its ratchet (see hubSound.ts)
    this.hubGain = ctx.createGain();
    this.hubGain.gain.value = 0;
    this.hubGain.connect(this.master);
    createHub(ctx)
      .then((hub) => {
        this.hub = hub;
        hub?.connect(this.hubGain);
      })
      .catch((e) => console.warn('No freewheel sound', e));
  }

  /** A short burst of filtered noise. */
  private burst(type: BiquadFilterType, freq: number, q: number, level: number, attack: number, decay: number, delay = 0, sweepTo?: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + attack + decay);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 1.5);
    src.stop(t + attack + decay + 0.05);
  }

  /** A low thump: a sine dropping in pitch. */
  private thump(level: number, from = 110, to = 38, decay = 0.28, delay = 0): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + decay + 0.05);
  }

  /** Touching down: a thump and the surface's crunch, by how hard (m/s into the slope). */
  private touchdown(impact: number, bike: boolean): void {
    const k = THREE.MathUtils.clamp(impact / 9, 0.08, 1.3);
    this.thump(0.5 * k, bike ? 130 : 100, 40, 0.18 + 0.15 * k);
    if (SUMMER_MAP) this.burst('lowpass', 900, 0.7, 0.35 * k, 0.004, 0.12 + 0.12 * k); // dirt
    else this.burst('bandpass', 1800, 0.8, 0.3 * k, 0.004, 0.1 + 0.15 * k, 0, 700); // snow crunch
    if (bike && k > 0.4) this.burst('bandpass', 3200, 6, 0.08 * k, 0.002, 0.05, 0.02); // the bike rattling
  }

  /** Off the lip: a short whoosh. */
  private takeoff(speed: number): void {
    const k = THREE.MathUtils.clamp(speed / 15, 0.2, 1);
    this.burst('bandpass', SUMMER_MAP ? 700 : 1600, 0.9, 0.12 * k, 0.01, 0.18, 0, SUMMER_MAP ? 300 : 600);
  }

  private crash(): void {
    this.thump(0.7, 90, 30, 0.45);
    this.burst('lowpass', SUMMER_MAP ? 700 : 1400, 0.6, 0.45, 0.005, 0.5);
    this.burst('bandpass', 2600, 4, 0.12, 0.002, 0.2, 0.06); // gear clattering
  }

  /** A clean trick: two quick rising notes. */
  chime(points: number): void {
    if (!this.ctx || points <= 0) return;
    const ctx = this.ctx;
    const base = points >= 1000 ? 784 : 659;
    [0, 0.09].forEach((delay, i) => {
      const t = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = base * (i ? 1.5 : 1);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.09, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.connect(g).connect(this.master);
      osc.start(t);
      osc.stop(t + 0.4);
    });
  }

  /** A bird: a few quick whistled sweeps. */
  private bird(): void {
    const ctx = this.ctx!;
    const notes = 2 + Math.floor(Math.random() * 4);
    const base = 2600 + Math.random() * 1800;
    for (let i = 0; i < notes; i++) {
      const t = ctx.currentTime + i * (0.09 + Math.random() * 0.06);
      const osc = ctx.createOscillator();
      const f0 = base * (0.9 + Math.random() * 0.25);
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.exponentialRampToValueAtTime(f0 * (Math.random() < 0.5 ? 1.35 : 0.75), t + 0.07);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.02, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      osc.connect(g).connect(this.master);
      osc.start(t);
      osc.stop(t + 0.1);
    }
  }

  /** Gravel popping under the tyres: tiny clicks, more the faster you go. */
  private crackle(dt: number, speed: number): void {
    this.crackleDebt += dt * speed * 3.5;
    let n = 0;
    while (this.crackleDebt >= 1 && n < 6) {
      this.crackleDebt -= Math.random() * 2;
      n++;
      const level = 0.02 + Math.random() * 0.05 * Math.min(1, speed / 12);
      this.burst('bandpass', 1200 + Math.random() * 3000, 3, level, 0.001, 0.01 + Math.random() * 0.02, Math.random() * dt);
    }
    if (this.crackleDebt > 3) this.crackleDebt = 0;
  }

  /**
   * Each frame. `riding`: a run is on (otherwise only the ambience plays,
   * e.g. behind the menu).
   */
  update(dt: number, skier: Skier, controls: Controls, riding: boolean): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;

    // Ambience
    if (SUMMER_MAP) {
      this.nextBird -= dt;
      if (this.nextBird <= 0) {
        this.bird();
        this.nextBird = 1.5 + Math.random() * 6;
      }
    }

    const tumbling = skier.mode === 'tumbling';
    const speed = riding ? skier.speed : 0;
    const grounded = skier.grounded && !tumbling;
    const grinding = grounded && skier.grinding;
    const bike = skier.bike;

    // Wind: grows with the square of speed (like drag), louder and
    // brighter in the air (no ground noise to hide it). (Tumbling: the
    // body's own speed; the controller's stands still.)
    const v = THREE.MathUtils.clamp((tumbling && riding ? this.lastCentreSpeed : speed) / 25, 0, 1.4);
    const air = riding && !grounded && !tumbling ? 1.4 : 1;
    glide(this.windGain.gain, 0.22 * v * v * air, now, 0.15);
    glide(this.windFilter.frequency, 250 + 1400 * v, now, 0.15);

    // The surface under you
    const rolling = riding && grounded && !grinding ? Math.min(1, speed / 14) : 0;
    const braking = riding && grounded && !grinding && controls.brake && speed > 1 ? 1 : 0;
    const carving = Math.abs(controls.steer) * rolling;
    if (bike) {
      // Tyres: a low rumble, plus a little hiss from the tread
      glide(this.rumbleGain.gain, 0.35 * rolling, now);
      glide(this.rumbleFilter.frequency, 140 + 260 * rolling, now);
      glide(this.hissGain.gain, (SUMMER_MAP ? 0.03 : 0.08) * rolling, now);
      glide(this.hissFilter.frequency, SUMMER_MAP ? 2200 : 3400, now);
      if (SUMMER_MAP && rolling > 0) this.crackle(dt, speed);
      // A skidding back tyre
      glide(this.scrapeGain.gain, 0.22 * braking * Math.min(1, speed / 6), now, 0.04);
      glide(this.scrapeFilter.frequency, SUMMER_MAP ? 900 : 1600, now);
    } else {
      // Skis or board: a hiss on the snow, crunchier carving, a hockey stop's spray
      glide(this.rumbleGain.gain, 0.1 * rolling, now);
      glide(this.rumbleFilter.frequency, 220, now);
      glide(this.hissGain.gain, 0.09 * rolling + 0.08 * carving, now);
      glide(this.hissFilter.frequency, 2600 + 1600 * rolling - 900 * carving, now);
      glide(this.scrapeGain.gain, 0.28 * braking * Math.min(1, speed / 6) + 0.05 * carving, now, 0.04);
      glide(this.scrapeFilter.frequency, 1400, now);
    }

    // Rail
    glide(this.grindGain.gain, grinding ? 0.05 + 0.08 * Math.min(1, speed / 10) : 0, now, 0.03);

    // Freewheel: buzzing whenever the wheel turns and the pedals don't
    // (spinning down slowly in the air)
    if (bike && riding && !tumbling) {
      this.hubSpeed = grounded ? speed : this.hubSpeed * Math.exp(-0.15 * dt);
      const pedalling = controls.tuck && grounded && speed < 9;
      const wheelHz = this.hubSpeed / (2 * Math.PI * WHEEL_R);
      const rate = this.hub?.parameters.get('rate');
      if (rate) glide(rate, wheelHz * HUB_ENGAGEMENT, now, 0.03);
      glide(this.hubGain.gain, pedalling || braking ? 0 : HUB_LEVEL, now, 0.02);
    } else {
      this.hubSpeed = 0;
      glide(this.hubGain.gain, 0, now, 0.05);
    }

    // One-shots, from what changed since last frame
    if (riding) {
      if (tumbling && !this.wasTumbling) this.crash();
      else if (!tumbling && !this.wasTumbling) {
        const p = skier.object.position;
        if (grounded && !this.wasGrounded) {
          // How hard we hit: the speed we had in the air, into the slope
          const n = normalAt(p.x, p.z, tmpN);
          this.touchdown(Math.max(0, -this.lastVel.dot(n)), bike);
        } else if (!grounded && this.wasGrounded && speed > 3) this.takeoff(speed);
      }
      // Tumbling: a thud whenever the body slams to a sudden stop
      this.sinceThud += dt;
      const c = skier.centre(tmpCentre);
      if (tumbling && this.centreKnown && dt > 0) {
        const cs = c.distanceTo(this.lastCentre) / dt;
        const lost = this.lastCentreSpeed - cs;
        if (lost > 3 && this.sinceThud > 0.12) {
          this.thump(Math.min(0.5, lost / 14), 95, 35, 0.2);
          this.burst('lowpass', SUMMER_MAP ? 600 : 1200, 0.6, Math.min(0.3, lost / 25), 0.003, 0.15);
          this.sinceThud = 0;
        }
        this.lastCentreSpeed = cs;
      } else this.lastCentreSpeed = speed;
      this.lastCentre.copy(c);
      this.centreKnown = true;
    } else this.centreKnown = false;

    this.wasGrounded = grounded;
    this.wasTumbling = tumbling;
    this.lastVel.copy(skier.velocity);
  }

  /** A new run: forget the last one (no landing thump from the respawn). */
  reset(): void {
    this.wasGrounded = true;
    this.wasTumbling = false;
    this.centreKnown = false;
    this.lastVel.set(0, 0, 0);
  }
}
