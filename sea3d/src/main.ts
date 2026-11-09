import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { SEA_STATES, components, displace, hsOf, type WaveComponent } from "./waves";

const SIZE = 400; // m, side of the visible patch of sea
const SEGMENTS = { low: 96, high: 224 };

const app = document.getElementById("app")!;
const seaSelect = document.getElementById("sea") as HTMLSelectElement;
const qualitySelect = document.getElementById("quality") as HTMLSelectElement;

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(window.innerWidth, window.innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const sky = new THREE.Color(0xbcd9ee);
scene.background = sky;
scene.fog = new THREE.Fog(sky, 120, SIZE * 0.55);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(-30, 18, 34);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 5;
controls.maxDistance = 150;

scene.add(new THREE.HemisphereLight(0xdfefff, 0x0b2233, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(-80, 35, -120); // low sun ahead: glints show the wave shapes
scene.add(sun);

const material = new THREE.MeshPhongMaterial({ color: 0x1b5a80, specular: 0x9fc8e0, shininess: 60 });
let sea: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshPhongMaterial> | null = null;
let base: Float32Array = new Float32Array();
let comps: WaveComponent[] = [];

// 4 m reference post so sizes read at a glance.
const post = new THREE.Mesh(
  new THREE.CylinderGeometry(0.08, 0.08, 4, 12),
  new THREE.MeshStandardMaterial({ color: 0xe8590c }),
);
scene.add(post);

function buildSea(quality: "low" | "high"): void {
  if (sea) {
    scene.remove(sea);
    sea.geometry.dispose();
  }
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEGMENTS[quality], SEGMENTS[quality]);
  geo.rotateX(-Math.PI / 2);
  base = Float32Array.from(geo.attributes.position.array as Float32Array);
  sea = new THREE.Mesh(geo, material);
  scene.add(sea);
  renderer.setPixelRatio(quality === "high" ? Math.min(window.devicePixelRatio, 2) : 1);
}

function setSea(key: string): void {
  comps = components(SEA_STATES[key]);
}

function updateSea(t: number): void {
  if (!sea) return;
  const pos = sea.geometry.attributes.position;
  const arr = pos.array as Float32Array;
  for (let i = 0; i < arr.length; i += 3) {
    const [dx, y, dz] = displace(comps, base[i], base[i + 2], t);
    arr[i] = base[i] + dx;
    arr[i + 1] = y;
    arr[i + 2] = base[i + 2] + dz;
  }
  pos.needsUpdate = true;
  sea.geometry.computeVertexNormals();
  const [, py] = displace(comps, 0, 0, t);
  post.position.y = py; // rides the surface: a first taste of Phase 1
}

seaSelect.addEventListener("change", () => setSea(seaSelect.value));
qualitySelect.addEventListener("change", () => buildSea(qualitySelect.value as "low" | "high"));
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

buildSea(qualitySelect.value as "low" | "high");
setSea(seaSelect.value);

// Hooks for the smoke test.
const status = { frames: 0, hs: 0 };
(window as unknown as { __sea3d: typeof status }).__sea3d = status;

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const t = clock.getElapsedTime();
  updateSea(t);
  controls.update();
  renderer.render(scene, camera);
  status.frames++;
  status.hs = hsOf(comps);
});
