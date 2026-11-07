import * as THREE from 'three';

/**
 * Ski boots.
 *
 * A ski boot is two parts that hinge at the ankle: the lower shell is
 * clamped in the binding (built with the ski, see skiModel), and the tall
 * cuff wraps the lower shin, so it is worn on the shin and leans with it.
 * The cuff has two buckles and a power strap at the top.
 *
 * The cuff is built in the shin's own frame: +Y runs along the bone towards
 * the ankle; -Z is roughly forward.
 */

export const BOOT_COLOR = 0x18191b;
const SOLE_COLOR = 0x2c2c2c;
const BUCKLE_COLOR = 0xc8ccd0;
const STRAP_COLOR = 0xff7a1c; // orange, like the goggle lens

let materials: Record<'shell' | 'sole' | 'buckle' | 'strap', THREE.Material> | null = null;
function mats() {
  materials ??= {
    shell: new THREE.MeshStandardMaterial({ color: BOOT_COLOR, roughness: 0.3, metalness: 0.05, side: THREE.DoubleSide }),
    sole: new THREE.MeshStandardMaterial({ color: SOLE_COLOR, roughness: 0.9 }),
    buckle: new THREE.MeshStandardMaterial({ color: BUCKLE_COLOR, roughness: 0.3, metalness: 0.8 }),
    strap: new THREE.MeshStandardMaterial({ color: STRAP_COLOR, roughness: 0.7, side: THREE.DoubleSide }),
  };
  return materials;
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  parent.add(m);
  return m;
}

/** A round open tube through (radius, y) points, squashed by `depth` front to back. */
function lathe(profile: [number, number][], depth: number, segments = 28): THREE.BufferGeometry {
  const geo = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), segments);
  geo.scale(1, 1, depth);
  return geo;
}

/**
 * The boot's lower shell and sole, in the ski's frame (toe towards -Z, the
 * ankle above z = 0, the binding's top at y ≈ 0.017).
 */
export function createBootShell(): THREE.Group {
  const m = mats();
  const boot = new THREE.Group();
  // Side view of the shell: toe box, instep rising to the ankle, heel
  const outline: [number, number][] = [
    [-0.155, 0.045],
    [0.148, 0.045],
    [0.152, 0.085],
    [0.125, 0.135],
    [0.07, 0.165],
    [-0.025, 0.165],
    [-0.075, 0.125],
    [-0.13, 0.095],
    [-0.158, 0.07],
  ];
  const shape = new THREE.Shape(outline.map(([z, y]) => new THREE.Vector2(z, y)));
  const width = 0.09;
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: width,
    bevelEnabled: true,
    bevelThickness: 0.014,
    bevelSize: 0.014,
    bevelSegments: 4,
    curveSegments: 8,
  });
  // Shape's x becomes the boot's length (z), its extrusion the width (x)
  geo.rotateY(-Math.PI / 2);
  geo.translate(width / 2, 0, 0);
  geo.computeVertexNormals();
  mesh(geo, m.shell, boot);
  // Sole, with a thicker heel
  const sole = mesh(new THREE.BoxGeometry(0.112, 0.026, 0.33), m.sole, boot);
  sole.position.set(0, 0.03, -0.003);
  // Two buckles over the instep, on the outside
  for (const [z, y] of [
    [-0.085, 0.118],
    [-0.035, 0.15],
  ]) {
    const b = mesh(new THREE.BoxGeometry(0.03, 0.012, 0.022), m.buckle, boot);
    b.position.set(0.045, y, z);
    b.rotation.z = -0.5;
  }
  return boot;
}

/**
 * The boot's cuff, worn on the shin. halfShin: half the shin's length (the
 * ankle is at +halfShin); side: -1 left, +1 right (buckles on the outside).
 */
export function createBootCuff(halfShin: number, side: number): THREE.Group {
  const m = mats();
  const cuff = new THREE.Group();
  const ankle = halfShin;
  // Tall and stiff, a little wider at the ankle, deeper front to back
  mesh(
    lathe(
      [
        [0.078, ankle + 0.04],
        [0.09, ankle + 0.005],
        [0.09, ankle - 0.08],
        [0.086, ankle - 0.19],
        [0.088, ankle - 0.24],
        [0.082, ankle - 0.246], // rolled top edge, turning in
      ],
      1.15,
    ),
    m.shell,
    cuff,
  );
  // Power strap round the top
  mesh(
    lathe(
      [
        [0.092, ankle - 0.19],
        [0.092, ankle - 0.228],
      ],
      1.15,
    ),
    m.strap,
    cuff,
  );
  // Two buckles down the front and outside
  for (const y of [ankle - 0.06, ankle - 0.14]) {
    const b = mesh(new THREE.BoxGeometry(0.034, 0.013, 0.024), m.buckle, cuff);
    const a = -Math.PI / 2 + side * 0.7; // round from the front towards the outside
    b.position.set(Math.cos(a) * 0.092, y, Math.sin(a) * 0.092 * 1.15);
    b.rotation.y = -a;
  }
  return cuff;
}
