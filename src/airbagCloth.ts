/**
 * The airbag's skin: a sheet of vinyl over pressurised air, simulated as a
 * grid of points that can each sink (or bulge) along the vertical. Each
 * point is pulled level with its neighbours (the skin's tension: a dent
 * spreads out and ripples), pushed back up by the air inside, and damped.
 * Whatever lands on it pushes the points under it down; the rider then rides
 * the dented surface (terrain.ts subtracts the dent from heightAt).
 */

export interface ClothRect {
  x0: number; // world x of the first column
  z0: number; // world z of the first row
  cols: number;
  rows: number;
  cell: number; // m between points
  /** How deep each point may sink before it bottoms out (row by row). */
  cap: Float32Array;
}

/** The skin's feel. */
export const CLOTH = {
  tension: 8, // m²/s²: pull level with the neighbours (wave speed √tension)
  air: 18, // 1/s²: the air pushing a dent back out
  volume: 900, // 1/s²: the whole bag pushing up as its air is squeezed (by the mean dent)
  damping: 4, // 1/s
  load: 40, // m/s²: a rider sitting on it (peak, at the middle of the contact)
  radius: 0.75, // m: the contact patch
  impact: 2.2, // of the landing speed, given to the points under the impact
  impactRadius: 1.1, // m
  bulge: 0.35, // m: how far a point may bulge up
  step: 1 / 240, // s
};

export class Cloth {
  readonly rect: ClothRect;
  /** Dent depth at each point, m (+ down). */
  readonly d: Float32Array;
  private readonly v: Float32Array;
  private readonly a: Float32Array;
  private acc = 0;
  private load: { x: number; z: number } | null = null;
  /** Changed since the last look (for the mesh). */
  dirty = false;
  private asleep = true;

  constructor(rect: ClothRect) {
    this.rect = rect;
    const n = rect.cols * rect.rows;
    this.d = new Float32Array(n);
    this.v = new Float32Array(n);
    this.a = new Float32Array(n);
  }

  /** Something sits on the skin at (x, z) this frame (null: nothing). */
  press(x: number, z: number): void {
    this.load = { x, z };
    this.asleep = false;
  }

  /** Something hit the skin at (x, z), coming down at speed (m/s). */
  hit(x: number, z: number, speed: number): void {
    const r = CLOTH.impactRadius;
    this.forEachNear(x, z, r * 2, (i, d2) => {
      this.v[i] += speed * CLOTH.impact * Math.exp(-d2 / (r * r));
    });
    this.asleep = false;
  }

  reset(): void {
    this.d.fill(0);
    this.v.fill(0);
    this.load = null;
    this.asleep = true;
    this.dirty = true;
  }

  /** Dent at world (x, z), m (+ down): bilinear between the points. 0 off the skin. */
  dentAt(x: number, z: number): number {
    const { x0, z0, cols, rows, cell } = this.rect;
    const fx = (x - x0) / cell;
    const fz = (z - z0) / cell;
    if (fx <= 0 || fz <= 0 || fx >= cols - 1 || fz >= rows - 1) return 0;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const i = iz * cols + ix;
    const d = this.d;
    return (d[i] * (1 - tx) + d[i + 1] * tx) * (1 - tz) + (d[i + cols] * (1 - tx) + d[i + cols + 1] * tx) * tz;
  }

  step(dt: number): void {
    if (this.asleep) return;
    this.acc = Math.min(this.acc + dt, 0.05);
    let moving = !!this.load;
    while (this.acc >= CLOTH.step) {
      this.acc -= CLOTH.step;
      moving = this.substep(CLOTH.step) || moving;
    }
    this.load = null;
    this.dirty = true;
    if (!moving) {
      this.asleep = true;
      this.d.fill(0);
      this.v.fill(0);
    }
  }

  /** One small step; whether anything still moves. */
  private substep(h: number): boolean {
    const { cols, rows, cell, cap } = this.rect;
    const { d, v, a } = this;
    const k = CLOTH.tension / (cell * cell);
    let mean = 0;
    for (let i = 0; i < d.length; i++) mean += d[i];
    mean /= d.length;
    const lift = CLOTH.volume * mean;
    for (let iz = 0; iz < rows; iz++) {
      for (let ix = 0; ix < cols; ix++) {
        const i = iz * cols + ix;
        // (The edge rows are held: the bag's seams to its sides)
        if (ix === 0 || iz === 0 || ix === cols - 1 || iz === rows - 1) {
          a[i] = 0;
          continue;
        }
        const lap = d[i - 1] + d[i + 1] + d[i - cols] + d[i + cols] - 4 * d[i];
        a[i] = k * lap - CLOTH.air * d[i] - lift - CLOTH.damping * v[i];
      }
    }
    const L = this.load;
    if (L) {
      const r = CLOTH.radius;
      this.forEachNear(L.x, L.z, r * 2, (i, d2) => {
        a[i] += CLOTH.load * Math.exp(-d2 / (r * r));
      });
    }
    let moving = false;
    for (let i = 0; i < d.length; i++) {
      v[i] += a[i] * h;
      let di = d[i] + v[i] * h;
      // Bottomed out (squashed flat onto the ground), or bulged as far as it goes
      if (di > cap[i]) {
        di = cap[i];
        if (v[i] > 0) v[i] *= -0.1;
      } else if (di < -Math.min(CLOTH.bulge, cap[i])) {
        // (Only up on top: the skirt round its foot stays on the ground)
        di = -Math.min(CLOTH.bulge, cap[i]);
        if (v[i] < 0) v[i] = 0;
      }
      d[i] = di;
      if (Math.abs(v[i]) > 2e-3 || Math.abs(di) > 2e-3) moving = true;
    }
    return moving;
  }

  private forEachNear(x: number, z: number, reach: number, fn: (i: number, d2: number) => void): void {
    const { x0, z0, cols, rows, cell } = this.rect;
    const ix0 = Math.max(1, Math.floor((x - reach - x0) / cell));
    const ix1 = Math.min(cols - 2, Math.ceil((x + reach - x0) / cell));
    const iz0 = Math.max(1, Math.floor((z - reach - z0) / cell));
    const iz1 = Math.min(rows - 2, Math.ceil((z + reach - z0) / cell));
    for (let iz = iz0; iz <= iz1; iz++) {
      const dz = z0 + iz * cell - z;
      for (let ix = ix0; ix <= ix1; ix++) {
        const dx = x0 + ix * cell - x;
        fn(iz * cols + ix, dx * dx + dz * dz);
      }
    }
  }
}
