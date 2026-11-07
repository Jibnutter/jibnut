import * as THREE from 'three';

/**
 * Headgear: a black skate-style helmet (a round, smooth dome coming low at
 * the back and over the ears, with a rolled edge and a few round vents on
 * top) and white-framed goggles with an orange mirrored lens, their white
 * strap round the back of the helmet.
 *
 * Built in the head's frame: centred on the head, face towards -Z, up +Y.
 */

const GOGGLE_COLOR = 0xf4f4f2;
const LENS_COLOR = 0xff7a1c;

/**
 * Direction on a sphere around the head. phi: round from the face (0) to
 * the left (+) and right (-), ±π at the back; theta: down from the top.
 */
function dir(theta: number, phi: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(Math.sin(theta) * Math.sin(phi), Math.cos(theta), -Math.sin(theta) * Math.cos(phi));
}

/**
 * A patch of a (stretched) sphere: phi from phi0 to phi1 round, theta from
 * top(phi) to bottom(phi) down. scale stretches it (an egg-shaped helmet).
 */
function patch(
  radius: number,
  phi0: number,
  phi1: number,
  top: (phi: number) => number,
  bottom: (phi: number) => number,
  cols: number,
  rows: number,
  scale = new THREE.Vector3(1, 1, 1),
): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const d = new THREE.Vector3();
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const phi = phi0 + ((phi1 - phi0) * i) / cols;
      const theta = top(phi) + ((bottom(phi) - top(phi)) * j) / rows;
      dir(theta, phi, d).multiplyScalar(radius).multiply(scale);
      pos.push(d.x, d.y, d.z);
      if (i < cols && j < rows) {
        const a = j * (cols + 1) + i;
        const b = a + cols + 1;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** A tube following a closed or open line of points. */
function rim(points: THREE.Vector3[], thickness: number, closed: boolean): THREE.BufferGeometry {
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points, closed), points.length * 2, thickness, 8, closed);
}

export function createHeadgear(headRadius: number): THREE.Group {
  const gear = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    gear.add(m);
    return m;
  };

  // --- Helmet ---
  const shell = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.45, metalness: 0.1, side: THREE.DoubleSide });
  const R = headRadius + 0.028;
  const egg = new THREE.Vector3(1, 1, 1.07); // a little longer front to back
  // The edge: just above the eyebrows at the front, lower over the ears,
  // and well down the back of the head
  const edge = (phi: number) => {
    const back = (1 - Math.cos(phi)) / 2; // 0 at the face, 1 at the back
    return 1.2 + 0.72 * back ** 0.8;
  };
  add(patch(R, -Math.PI, Math.PI, () => 0, edge, 72, 28, egg), shell);
  // Rolled edge all the way round
  const edgePoints: THREE.Vector3[] = [];
  for (let k = 0; k < 64; k++) {
    const phi = -Math.PI + (k / 64) * Math.PI * 2;
    edgePoints.push(dir(edge(phi), phi).multiplyScalar(R - 0.004).multiply(egg));
  }
  add(rim(edgePoints, 0.009, true), shell);
  // Round vents on top: dark holes in two rows
  const vent = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.9 });
  const ventGeo = new THREE.CircleGeometry(0.011, 16);
  for (const [theta, phi] of [
    [0.45, 0.35], [0.45, -0.35], [0.6, 0], [0.75, 0.6], [0.75, -0.6],
    [1.0, 0.25], [1.0, -0.25], [1.15, 0.85], [1.15, -0.85],
  ]) {
    const n = dir(theta, phi);
    const v = add(ventGeo, vent);
    v.castShadow = false;
    v.position.copy(n).multiplyScalar(R + 0.001).multiply(egg);
    v.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  }

  // --- Goggles ---
  const frame = new THREE.MeshStandardMaterial({ color: GOGGLE_COLOR, roughness: 0.35, side: THREE.DoubleSide });
  const lens = new THREE.MeshPhysicalMaterial({
    color: LENS_COLOR,
    metalness: 0.5, // a mirrored lens: reflects the sky and snow, tinted orange
    roughness: 0.08,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    emissive: LENS_COLOR,
    emissiveIntensity: 0.35,
    side: THREE.DoubleSide,
  });
  // White strap, matching the frame (and showing up on the black helmet)
  const strap = new THREE.MeshStandardMaterial({ color: GOGGLE_COLOR, roughness: 0.7, side: THREE.DoubleSide });
  // Sitting just under the helmet's front edge, wrapping round the face
  const G = headRadius + 0.03;
  const FRAME_TOP = 1.24;
  const FRAME_BOTTOM = 1.98;
  const FRAME_HALF = 1.3; // round the face: radians each side
  // The lower edge dips at the nose bridge
  const nose = (phi: number) => -0.16 * Math.exp(-((phi / 0.22) ** 2));
  add(patch(G, -FRAME_HALF, FRAME_HALF, () => FRAME_TOP, (phi) => FRAME_BOTTOM + nose(phi), 48, 6), frame);
  add(
    patch(G + 0.006, -FRAME_HALF + 0.12, FRAME_HALF - 0.12, () => FRAME_TOP + 0.07, (phi) => FRAME_BOTTOM - 0.07 + nose(phi), 48, 6),
    lens,
  );
  // A white rim round the frame
  const outline: THREE.Vector3[] = [];
  const steps = 40;
  for (let k = 0; k <= steps; k++) {
    const phi = -FRAME_HALF + (2 * FRAME_HALF * k) / steps;
    outline.push(dir(FRAME_TOP, phi).multiplyScalar(G + 0.002));
  }
  for (let k = steps; k >= 0; k--) {
    const phi = -FRAME_HALF + (2 * FRAME_HALF * k) / steps;
    outline.push(dir(FRAME_BOTTOM + nose(phi), phi).multiplyScalar(G + 0.002));
  }
  add(rim(outline, 0.007, true), frame);
  // The strap, round the back of the helmet
  const strapR = R + 0.006;
  add(
    patch(strapR, FRAME_HALF - 0.05, Math.PI * 2 - FRAME_HALF + 0.05, () => 1.5, () => 1.72, 40, 2, egg),
    strap,
  );
  return gear;
}
