import * as THREE from 'three';
import { BODY, type Person } from './person';
import { Cloth, refine, zip, type ClothRing } from './cloth';

/**
 * Baggy shorts or snowpants, with cloth physics (see Cloth).
 *
 * Three tubes of fabric sewn together: the seat round the hips and two wide
 * legs, reaching just past the knees (shorts) or down over the boots
 * (pants). Held firmly at the waistband (and the pants' cuffs), loosely
 * around the legs, so the fabric swings, flaps and bunches.
 */

const SEGMENTS = 20; // particles round each leg ring
const WAIST_SEGMENTS = 28;

// Bones: pelvis, thighs (left, right), shins (left, right)
const PELVIS = 0;

// Along a bone, -length/2 is its first joint and +length/2 its second:
// pelvis: hip centre -> up the spine; thigh: hip -> knee; shin: knee -> ankle
const T = BODY.thigh / 2;
const S = BODY.shin / 2;
const P = BODY.pelvis / 2;
// Key rings; more are filled in between (see refine) for a finer mesh
const WAIST_KEYS: ClothRing[] = [
  // Belt line: held fast
  { bone: 'pelvis', y: P + 0.02, rx: 0.17, rz: 0.14, cz: 0.025, pin: 1, leash: 0.01 },
  { bone: 'pelvis', y: 0, rx: 0.21, rz: 0.17, cz: 0.035, pin: 0.6, leash: 0.03 },
  // The seat: fuller at the back and shifted back over the butt, reaching
  // down past the hips and over the backs of the thighs, so crouching keeps
  // it covered and it reads as a rounded seat rather than a tube
  { bone: 'pelvis', y: -P - 0.02, rx: 0.26, rz: 0.2, cz: 0.035, pin: 0.2, leash: 0.07 },
  // ... tapering in at the bottom to meet the legs smoothly, no shelf.
  // Fabric round the hip joints also follows the thighs part of the way: the
  // front (groin) folds with the thigh, the back (the butt) stays with the
  // pelvis, so a thigh swung forward in a crouch doesn't leave the fabric
  // hanging below the seat and folding back up into a crease.
  { bone: 'pelvis', y: -P - 0.08, rx: 0.26, rz: 0.2, cz: 0.04, pin: 0.3, leash: 0.05, blend: { bone: 'thigh', front: 0.25, back: 0.0375 } },
  // The bottom of the seat is sewn to the tops of the legs (see stitch)
];
const THIGH_KEYS: ClothRing[] = [
  // The top of the leg goes round the hip and is sewn to the seat. It hangs
  // from the pelvis, not the thigh: a thigh swung forward in a crouch would
  // tilt it right over and fold the seam into a crease across the butt.
  { bone: 'pelvis', y: -P - 0.17, cx: BODY.hipWidth + 0.02, rx: 0.14, rz: 0.2, cz: 0.04, pin: 0.3, leash: 0.05, blend: { bone: 'thigh', front: 0.55, back: 0.1 } },
  // The seat drapes from the butt onto the back of the thigh: this ring
  // mostly follows the thigh, so the curve under the butt stays smooth
  { bone: 'pelvis', y: -P - 0.26, cx: BODY.hipWidth + 0.01, rx: 0.15, rz: 0.18, cz: 0.025, pin: 0.15, leash: 0.08, blend: { bone: 'thigh', front: 0.85, back: 0.55 } },
  { bone: 'thigh', y: -T * 0.25, rx: 0.155, rz: 0.16, pin: 0.08, leash: 0.1 },
  { bone: 'thigh', y: 0, rx: 0.16, rz: 0.17, pin: 0.04, leash: 0.14 },
  { bone: 'thigh', y: T * 0.5, rx: 0.155, rz: 0.165, pin: 0.05, leash: 0.13 },
];
const SHORTS_LEG: ClothRing[] = [
  ...THIGH_KEYS,
  // The hem: wide and loose, just past the knee. It goes with the thigh:
  // when the knee bends (deeply, knees up in a grab) shorts ride up the
  // thigh rather than following the shin round the fold, which stretched
  // the fabric over the knee to three times its length. Kept outside the
  // shin too, which folds up under it.
  { bone: 'thigh', y: T + 0.07, rx: 0.165, rz: 0.17, pin: 0.08, leash: 0.1, collide: ['thigh', 'shin'] },
];
const SHORTS_KNEE = SHORTS_LEG.length - 1;

const PANTS_LEG: ClothRing[] = [
  ...THIGH_KEYS,
  // Over the knee: halfway between thigh and shin (so a deep bend doesn't
  // stretch it round the fold), kept outside both, with lots of slack nearby
  { bone: 'shin', y: -S + 0.02, rx: 0.155, rz: 0.16, pin: 0.1, leash: 0.1, collide: ['thigh', 'shin'], blend: { bone: 'thigh', front: 0.5, back: 0.5 } },
  { bone: 'shin', y: -S * 0.4, rx: 0.15, rz: 0.155, pin: 0.04, leash: 0.12 },
  { bone: 'shin', y: S * 0.15, rx: 0.155, rz: 0.16, pin: 0.04, leash: 0.12 },
  { bone: 'shin', y: S * 0.65, rx: 0.165, rz: 0.17, pin: 0.08, leash: 0.08 }, // flaring over the boot
  { bone: 'shin', y: S + 0.03, rx: 0.13, rz: 0.15, pin: 0.6, leash: 0.02 }, // cuff, on the boot top
];
const PANTS_KNEE = THIGH_KEYS.length;

/** The refined leg, with the fabric within two rings of the knee loose. */
function legRings(keys: ClothRing[], knee: number): ClothRing[] {
  const rings = refine(keys);
  const k = rings.indexOf(keys[knee]);
  return rings.map((ring, r) => (Math.abs(r - k) <= 2 ? { ...ring, loose: true } : ring));
}

export class Bottoms extends Cloth {
  constructor(person: Person, kind: 'shorts' | 'pants', color: number) {
    const waist = refine(WAIST_KEYS);
    const leg = kind === 'pants' ? legRings(PANTS_LEG, PANTS_KNEE) : legRings(SHORTS_LEG, SHORTS_KNEE);
    super(
      [person.pelvis, person.thighs[0], person.thighs[1], person.shins[0], person.shins[1]],
      [
        { rings: waist, segments: WAIST_SEGMENTS, bones: { pelvis: PELVIS, thigh: [1, 2] }, side: 0 },
        // (left leg first, as in Person)
        { rings: leg, segments: SEGMENTS, bones: { pelvis: PELVIS, thigh: 1, shin: 3 }, side: -1 },
        { rings: leg, segments: SEGMENTS, bones: { pelvis: PELVIS, thigh: 2, shin: 4 }, side: 1 },
      ],
      new THREE.MeshStandardMaterial({ color, roughness: 0.85, side: THREE.DoubleSide }),
    );
  }

  /**
   * Triangles joining the seat's bottom ring to the legs' top rings, from
   * where they sit on the body now (in the pelvis's frame). Each half of the
   * seat (left, right) is sewn to the outer half of its leg; the inner
   * halves of the two legs are sewn to each other, front to back (the
   * crotch), so it's one garment with no gaps or edges.
   */
  protected stitch(): [number, number, number][] {
    const at = (i: number) => ({ i, p: this.localTo(PELVIS, i) });
    const seat = this.ring(0, this.tubes[0].rings.length - 1).map(at);
    const tops = [1, 2].map((t) => this.ring(t, 0).map(at));
    // Pelvis frame: x is sideways, z front (-) to back (+)
    const tris: [number, number, number][] = [];
    const inner: number[][] = [];
    const ends: { front: number; back: number }[] = [];
    for (const top of tops) {
      const cx = top.reduce((sum, v) => sum + v.p.x, 0) / top.length;
      const cz = top.reduce((sum, v) => sum + v.p.z, 0) / top.length;
      const side = Math.sign(cx);
      // Angle round the leg, from its front (-90°) through its outside to its back (+90°)
      const round = (v: { p: THREE.Vector3 }) => Math.atan2(v.p.z - cz, (v.p.x - cx) * side);
      const front = top.reduce((m, v) => (v.p.z < m.p.z ? v : m));
      const back = top.reduce((m, v) => (v.p.z > m.p.z ? v : m));
      const outer = top.filter((v) => (v.p.x - cx) * side >= 0 || v === front || v === back);
      outer.sort((u, v) => round(u) - round(v));
      // The seat's half on this side, front centre through the side to back centre
      const seatRound = (v: { p: THREE.Vector3 }) => Math.atan2(v.p.z, v.p.x * side);
      const half = seat.filter((v) => v.p.x * side >= -1e-4).sort((u, v) => seatRound(u) - seatRound(v));
      zip(half.map((v) => v.i), outer.map((v) => v.i), tris);
      ends.push({ front: front.i, back: back.i });
      const innerRun = top
        .filter((v) => (v.p.x - cx) * side < 0 || v === front || v === back)
        .sort((u, v) => u.p.z - v.p.z);
      inner.push(innerRun.map((v) => v.i));
    }
    zip(inner[0], inner[1], tris); // the crotch
    // Close the little gaps where the seat's centre line meets both legs
    const seatFront = seat.reduce((m, v) => (v.p.z < m.p.z && Math.abs(v.p.x) < 0.02 ? v : m), seat[0]);
    const seatBack = seat.reduce((m, v) => (v.p.z > m.p.z ? v : m));
    tris.push([seatFront.i, ends[0].front, ends[1].front], [seatBack.i, ends[0].back, ends[1].back]);
    // Facing out from a point inside the hips
    return this.orient(tris, PELVIS, new THREE.Vector3(0, -BODY.pelvis / 2, 0));
  }
}
