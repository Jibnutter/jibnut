import * as THREE from 'three';
import './style.css';
import { Skier } from './skier';
import { ChaseCamera } from './chaseCamera';
import { readControls } from './input';
import { createTerrain, courseX, START_Z, FINISH_Z, END_Z } from './terrain';
import { Scenery } from './scenery';
import { Physics } from './physics';
import { PhysicsDebug } from './physicsDebug';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xa9cdee);
scene.fog = new THREE.Fog(0xc9def0, 120, 900);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);

// Riders start at the top of the roll-in, just past the start gate
const startZ = START_Z;

scene.add(createTerrain());
const scenery = new Scenery();
scene.add(scenery.group);

const physics = await Physics.create();
const skier = new Skier(physics);
skier.reset(courseX(startZ), startZ);
scene.add(skier.object);

const chase = new ChaseCamera(camera, skier);
chase.snap();

// Collision shapes overlay, toggled with C
const physicsDebug = new PhysicsDebug(physics);
scene.add(physicsDebug.lines);

// Lighting
scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.castShadow = true;
sun.target = skier.object; // keep the shadow area around the start
sun.shadow.camera.left = sun.shadow.camera.bottom = -40;
sun.shadow.camera.right = sun.shadow.camera.top = 40;
sun.shadow.mapSize.set(2048, 2048);
sun.position.copy(skier.object.position).add(new THREE.Vector3(30, 50, 20));
scene.add(sun);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// HUD: speed readout, jump power bar and controls hint
const hud = document.createElement('div');
hud.id = 'hud';
hud.innerHTML = `
  <div class="speed"></div>
  <div class="power"><div class="fill"></div></div>
  <div class="hint">A/D turn · W tuck · S brake · hold Space to jump: + S/W lean back/forward to flip, + A/D wind up to spin · in air: S tuck (flip faster), A/D arms in (spin faster), W open up + spot the landing · R restart · C colliders</div>`;
document.body.appendChild(hud);
const speedEl = hud.querySelector<HTMLDivElement>('.speed')!;

// Trick callout in the middle of the screen
const trickEl = document.createElement('div');
trickEl.id = 'trick';
document.body.appendChild(trickEl);
let trickTimer: number | undefined;
skier.onLand = (message, clean) => {
  trickEl.textContent = message;
  trickEl.className = clean ? 'show' : 'show crash';
  clearTimeout(trickTimer);
  trickTimer = window.setTimeout(() => (trickEl.className = ''), 1500);
};
const powerEl = hud.querySelector<HTMLDivElement>('.fill')!;

function restart(): void {
  skier.reset(courseX(startZ), startZ);
  chase.snap();
}
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR') restart();
  if (e.code === 'KeyC') {
    physicsDebug.visible = !physicsDebug.visible;
    skier.showColliders = physicsDebug.visible;
  }
});

// After the finish line riders skid to a stop; once stopped, start again
let stoppedFor = 0;

const timer = new THREE.Timer();
const sunOffset = new THREE.Vector3(30, 50, 20);

renderer.setAnimationLoop((time) => {
  timer.update(time);
  const dt = Math.min(timer.getDelta(), 0.05); // avoid huge steps after a tab switch

  physics.step(dt);
  const finished = skier.mode === 'riding' && skier.object.position.z < FINISH_Z;
  const controls = readControls();
  skier.update(dt, finished && skier.grounded ? { ...controls, brake: true, jump: false } : controls);
  physicsDebug.update();
  scenery.update(dt);
  stoppedFor = finished && skier.grounded && skier.speed < 0.5 ? stoppedFor + dt : 0;
  if (stoppedFor > 1.5 || skier.object.position.z < END_Z - 30) restart();

  chase.update(dt);
  sun.position.copy(skier.object.position).add(sunOffset);

  const state =
    (skier.mode === 'tumbling' ? '  ·  crashed' : skier.grounded ? '' : '  ·  air') +
    (skier.switchStance && skier.mode === 'riding' ? '  ·  switch' : '');
  speedEl.textContent = `${Math.round(skier.speed * 3.6)} km/h${state}`;
  powerEl.style.width = `${skier.charge * 100}%`;

  renderer.render(scene, camera);
});
