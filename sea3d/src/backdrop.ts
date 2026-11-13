// The real sea and sky behind a page of words (M3: the leaderboard in the game's look).
// DESIGN.md: "The real sea and sky behind every screen... No flat dark pages."
//
// The title's own light and sea (titleHero.ts: a low golden sun, a gentle swell), with no
// boat and nothing to steer: a slow look along the water, drawn behind the page's glass.
// The page loads this after its words are up, so the words never wait for the picture.

import * as THREE from "three";
import { Atmosphere } from "./atmosphere";
import type { Quality } from "./boats/parts";
import { HERO_SEA, HERO_SUN } from "./titleHero";
import { Sea } from "./water";
import { components } from "./waves";

/** Where the camera looks, degrees clockwise from north: off the sun's side, so the glare isn't behind the words. */
export function backdropAim(sunAz: number): number {
  return (sunAz - 38 + 360) % 360;
}

/** Low on a computer with no graphics card (it draws the sea in software), else High; ?quality=low|high wins. */
export function backdropQuality(asked: string | null, software: boolean): Quality {
  return asked === "low" || (asked !== "high" && software) ? "low" : "high";
}

export interface Backdrop {
  /** Frames drawn so far (for tests). */
  frames: number;
  quality: Quality;
  stop(): void;
}

/** Draw the sea and sky into `host` (a fixed, full-window element behind the page). */
export function mountBackdrop(host: HTMLElement, search = location.search): Backdrop {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.05, 12000);
  const atmos = new Atmosphere(renderer, scene, camera);
  atmos.set(HERO_SUN.el, HERO_SUN.az, 0, true);
  const quality = backdropQuality(new URLSearchParams(search).get("quality"), atmos.software);
  renderer.setPixelRatio(quality === "high" ? Math.min(window.devicePixelRatio, 2) : atmos.software ? 0.6 : 1);
  atmos.setBloom(quality === "high");
  atmos.setPixelRatio(renderer.getPixelRatio());
  const sea = new Sea(quality);
  scene.add(sea.mesh);
  const comps = components(HERO_SEA);
  sea.setSea(HERO_SEA.hs);

  // A few metres up, looking along the water with the horizon in the upper third.
  const aim = THREE.MathUtils.degToRad(backdropAim(HERO_SUN.az));
  const look = new THREE.Vector3(Math.sin(aim), 0, -Math.cos(aim));
  const place = (t: number) => {
    camera.position.set(0, 4.2 + Math.sin(t * 0.21) * 0.25, 0);
    camera.lookAt(look.x * 100, -6, look.z * 100);
  };
  const size = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    atmos.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener("resize", size);

  const clock = new THREE.Clock();
  // Someone who has asked their computer for less motion gets a still sea: a couple of seconds for the light to settle, then it holds.
  const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const out: Backdrop = {
    frames: 0,
    quality,
    stop() {
      renderer.setAnimationLoop(null);
      window.removeEventListener("resize", size);
    },
  };
  renderer.setAnimationLoop(() => {
    const t = clock.getElapsedTime();
    if (still && t > 2) return;
    place(t);
    sea.update(comps, t);
    sea.setSun(atmos.glintDir, atmos.glintLight);
    atmos.render();
    out.frames++;
  });
  return out;
}
