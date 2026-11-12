// Dev-only: every channel mark in a row on the sea, for review frames. ?cam=x,y,z&look=x,y,z&fov=&el=&az=
import * as THREE from "three";
import { Atmosphere } from "../src/atmosphere";
import { Sea } from "../src/water";
import { SEA_STATES, components } from "../src/waves";
import { BUOY_KINDS, makeBuoy } from "../src/boats/buoys";
const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const vec = (k: string, d: number[]) => new THREE.Vector3(...(q.get(k)?.split(",").map(Number) ?? d));
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.55;
document.getElementById("app")!.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(num("fov", 38), innerWidth / innerHeight, 0.1, 20000);
const atmos = new Atmosphere(renderer, scene, camera);
atmos.set(num("el", 25), num("az", 230), 0, true);
const sea = new Sea("high");
const comps = components(SEA_STATES.calm);
sea.setSea(0.4);
scene.add(sea.mesh);
BUOY_KINDS.forEach((k, i) => {
  const b = makeBuoy(k, String([3, 4, 6, 7, 10, 11][i]));
  b.position.set((i - 2.5) * 4.5, 0, 0);
  b.rotation.y = 0.25;
  scene.add(b);
});
camera.position.copy(vec("cam", [0, 3.5, 30]));
camera.lookAt(vec("look", [0, 1.6, 0]));
const st = { frames: 0 };
(window as any).__st = st;
renderer.setAnimationLoop(() => {
  sea.update(comps, 12);
  sea.setSun(atmos.glintDir, atmos.glintLight);
  atmos.render();
  st.frames++;
});
