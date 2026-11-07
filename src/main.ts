import * as THREE from 'three';
import { SkyDome, skyEnvironment } from './sky';
import { Sunlight } from './sunlight';

const EXPOSURE = 0.6;
const ENV_INTENSITY = 0.45;
const FOG_COLOR = 0xbfd3e6; // the haze along the horizon
import './style.css';
import { Skier } from './skier';
import { ChaseCamera } from './chaseCamera';
import { readControls } from './input';
import { createTerrain, MAP, SHOWCASE, heightAt, courseX, START_Z, FINISH_Z, END_Z, DECK_END_Z } from './terrain';
import { Scenery } from './scenery';
import { createRails } from './rails';
import { Powder } from './powder';
import { StartScreen } from './startScreen';
import * as progress from './progress';
import { Physics } from './physics';
import { PhysicsDebug } from './physicsDebug';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap; // soft-edged shadows
// Filmic tone mapping: the sky is in physical (HDR) units, and bright snow
// rolls off softly instead of clipping flat white
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = EXPOSURE;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// Sky (sun and clouds); distant terrain fades into the haze at the horizon
const sky = new SkyDome();
scene.add(sky.mesh);
scene.fog = new THREE.Fog(FOG_COLOR, 150, 1100);
// Ambient light and reflections from the sky itself (see skyEnvironment)
scene.environment = skyEnvironment(renderer);
scene.environmentIntensity = ENV_INTENSITY;

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);

// Riders start at the top of the roll-in, just past the start gate
const startZ = START_Z;

scene.add(createTerrain());
scene.add(createRails());
const powder = new Powder(); // spray and ski tracks
scene.add(powder.group);
const scenery = new Scenery();
scene.add(scenery.group);

const physics = await Physics.create();
const skier = new Skier(physics);
skier.reset(courseX(startZ), startZ);
scene.add(skier.object); // hidden: the controller's posed target
scene.add(skier.view); // the ragdoll you see

const chase = new ChaseCamera(camera, skier);
chase.snap();

// Collision shapes overlay, toggled with C
const physicsDebug = new PhysicsDebug(physics);
scene.add(physicsDebug.lines);

// Lighting: the sun, with cascaded shadows (near and far). The sky's light
// comes from the environment map.
const sunlight = new Sunlight(scene, camera);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  sunlight.updateFrustums();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// HUD: speed readout, jump power bar and controls hint
const hud = document.createElement('div');
hud.id = 'hud';
hud.innerHTML = `
  <div class="map">${MAP.name}</div>
  <div class="score"><span class="label">Score</span> <span class="value">0</span></div>
  <div class="speed"></div>
  <div class="power"><div class="fill"></div></div>
  <div class="hint">Esc menu &amp; controls · R restart · C camera · P physical skiing · K colliders</div>`;
document.body.appendChild(hud);
const speedEl = hud.querySelector<HTMLDivElement>('.speed')!;
const scoreEl = hud.querySelector<HTMLSpanElement>('.score .value')!;
// This run's score: the points of every trick landed since the last restart
let score = 0;
let crossed = false; // over the finish line this run

// Nuts (the currency, see progress.ts): finishing a run earns half its score
function setScore(value: number): void {
  score = value;
  scoreEl.textContent = score.toLocaleString('en-US');
}

// First person: looking out through the goggles' orange lens
const goggleTint = document.createElement('div');
goggleTint.id = 'goggles';
renderer.domElement.after(goggleTint); // over the game, under the HUD

// Trick callout in the middle of the screen
const trickEl = document.createElement('div');
trickEl.id = 'trick';
document.body.appendChild(trickEl);
let trickTimer: number | undefined;
skier.onLand = (message, clean, points) => {
  setScore(score + points);
  trickEl.innerHTML = '';
  trickEl.append(message);
  if (points > 0) {
    const pts = document.createElement('div');
    pts.className = 'points';
    pts.textContent = `+${points}`;
    trickEl.append(pts);
  }
  trickEl.className = clean ? 'show' : message.startsWith('Sketchy') ? 'show sketchy' : 'show crash';
  clearTimeout(trickTimer);
  trickTimer = window.setTimeout(() => (trickEl.className = ''), 1500);
};
const powerEl = hud.querySelector<HTMLDivElement>('.fill')!;

function restart(): void {
  skier.reset(courseX(startZ), startZ);
  setScore(0); // a fresh run
  crossed = false;
  powder.clear(); // fresh snow for the new run
  chase.snap();
}
// Start screen: up first; Esc brings it back
const startScreen = new StartScreen();
// Wear what was bought in the store, and change when it changes
let dressedIn = '';
function dress(): void {
  const o = progress.outfit();
  const key = `${o.bottom.id}/${o.top.id}/${o.gear.id}`;
  if (key === dressedIn) return; // (Nuts changed, not the clothes)
  dressedIn = key;
  skier.setOutfit(o);
  skier.setBoard(o.gear.kind === 'board');
}
dress();
progress.onProgress(dress);
let playing = false;
hud.classList.add('hidden');
skier.view.visible = false; // (no rider until you drop in)
startScreen.whenCrashesSet((on) => (skier.crashes = on));
startScreen.whenStarted(() => {
  playing = true;
  skier.view.visible = true;
  hud.classList.remove('hidden');
  restart();
});
let menuAngle = 0; // the camera circles the rider while the menu is up

// The locker shows the rider, standing at the top in what they're wearing
let inLocker = false;
let lockerTime = 0;
startScreen.onPage = (page) => {
  inLocker = page === 'locker';
  skier.view.visible = inLocker;
  if (inLocker) {
    skier.reset(courseX(DECK_END_Z + 6), DECK_END_Z + 6);
    lockerTime = 0;
  }
};

window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && playing) {
    playing = false;
    hud.classList.add('hidden');
    trickEl.className = '';
    if (chase.firstPerson) {
      chase.toggle();
      sunlight.updateFrustums();
      goggleTint.classList.remove('on');
    }
    skier.view.visible = false;
    startScreen.show();
    return;
  }
  if (!playing) return; // the game's keys only work in the game
  if (e.code === 'KeyR') restart();
  if (e.code === 'KeyP' && !skier.board) {
    // Fully physical skiing on/off (from the start of a fresh run)
    skier.physicalMode = !skier.physicalMode;
    restart();
  }
  if (e.code === 'KeyC') {
    chase.toggle(); // first / third person
    sunlight.updateFrustums();
    goggleTint.classList.toggle('on', chase.firstPerson);
  }
  if (e.code === 'KeyK') {
    physicsDebug.visible = !physicsDebug.visible;
    skier.showColliders = physicsDebug.visible;
  }
});

// After the finish line riders skid to a stop; once stopped, start again
let stoppedFor = 0;

const timer = new THREE.Timer();
const tmpLocker = new THREE.Vector3();
const tmpLockerSide = new THREE.Vector3();

renderer.setAnimationLoop((time) => {
  timer.update(time);
  const dt = Math.min(timer.getDelta(), 0.05); // avoid huge steps after a tab switch

  scenery.update(dt);
  if (playing) {
    const finished = skier.mode === 'riding' && skier.object.position.z < FINISH_Z;
    if (finished && !crossed) {
      // Over the finish line: call out the run's score
      crossed = true;
      clearTimeout(trickTimer);
      trickEl.innerHTML = '';
      trickEl.append('Finish!');
      const pts = document.createElement('div');
      pts.className = 'points';
      pts.textContent = `Score ${score.toLocaleString('en-US')}`;
      trickEl.append(pts);
      const earned = Math.floor(score / 2);
      progress.addNuts(earned);
      const nutsEl = document.createElement('div');
      nutsEl.className = 'nuts-earned';
      nutsEl.textContent = `+${earned.toLocaleString('en-US')} Nuts`;
      trickEl.append(nutsEl);
      trickEl.className = 'show finish';
      trickTimer = window.setTimeout(() => (trickEl.className = ''), 3500);
    }
    const controls = readControls();
    skier.update(dt, finished && skier.grounded ? { ...controls, brake: true, jump: false } : controls);
    powder.update(dt, skier, controls);
    physicsDebug.update();
    stoppedFor = finished && skier.grounded && skier.speed < 0.5 ? stoppedFor + dt : 0;
    if (stoppedFor > 1.5 || skier.object.position.z < END_Z - 30) restart();
    chase.update(dt);
  } else if (inLocker) {
    // Locker: the rider standing still (clothes still moving), the camera
    // in front of them swaying slowly side to side, with the rider on the
    // right of the screen, clear of the menu
    lockerTime += dt;
    skier.preview(dt);
    const c = skier.centre(tmpLocker);
    const front = skier.board ? Math.PI / 2 : Math.PI; // the way the body faces (sideways on a board)
    const a = front + 0.55 * Math.sin(lockerTime * 0.4);
    const dist = window.innerWidth < 640 ? 4.2 : 3.2;
    camera.position.set(c.x + Math.sin(a) * dist, c.y + 0.5, c.z + Math.cos(a) * dist);
    // Look a little to the rider's side, so they stand right of centre
    const side = tmpLockerSide.set(Math.cos(a), 0, -Math.sin(a)).multiplyScalar(window.innerWidth < 640 ? 0 : -0.9);
    camera.lookAt(c.x + side.x, c.y + 0.05, c.z + side.z);
  } else {
    // Menu: a slow flyover circling the map's showpiece (Jumpline's first
    // jump and its rail, the backcountry's first cliff band)
    menuAngle += dt * 0.06;
    const { x, z } = SHOWCASE;
    const y = heightAt(x, z);
    const cx = x + Math.sin(menuAngle) * 38;
    const cz = z + Math.cos(menuAngle) * 38;
    // Never below the snow: on a steep mountain the uphill side of the
    // circle is far higher than the feature (looking out from under the
    // terrain showed its underside)
    camera.position.set(cx, Math.max(y + 16, heightAt(cx, cz) + 15), cz);
    camera.lookAt(x, y - 2, z);
  }
  powder.setView(renderer.domElement.height, camera.fov);

  const state =
    (skier.mode === 'tumbling' ? '  ·  crashed' : skier.grounded ? '' : '  ·  air') +
    (skier.switchStance && skier.mode === 'riding' ? '  ·  switch' : '') +
    (skier.physicalMode ? '  ·  physical' : '');
  speedEl.textContent = `${Math.round(skier.speed * 3.6)} km/h${state}`;
  powerEl.style.width = `${skier.charge * 100}%`;

  sky.update(dt, camera);
  sunlight.update();
  renderer.render(scene, camera);
});
