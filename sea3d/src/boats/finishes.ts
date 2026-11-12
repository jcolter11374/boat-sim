// Real-world finishes for the detailed boats' materials (blender/*.py names
// them): rotomoulded plastic is waxy and a little rough, not glossy; solar
// panels are glass with an anti-reflective coat that glints blue-violet;
// stainless is brushed; lead goes dull; epoxy-glass is satin. three.js's
// physical material does the work; this only sets it up, once per material.

import * as THREE from "three";
import { NAV_NIGHT } from "./navlights";

let grain: THREE.DataTexture | null = null;
/** Fine value noise for "orange peel" and wear, as a roughness map (green channel). */
function grainTexture(): THREE.DataTexture {
  if (grain) return grain;
  const n = 128;
  const data = new Uint8Array(n * n * 4);
  let s = 4242;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const base = new Float32Array(n * n).map(() => rnd());
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      // A little blur so it reads as a soft texture, not pixels.
      let v = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) v += base[((y + dy + n) % n) * n + ((x + dx + n) % n)];
      const g = Math.round(255 * (0.82 + 0.18 * (v / 9)));
      data.set([g, g, g, 255], (y * n + x) * 4);
    }
  grain = new THREE.DataTexture(data, n, n);
  grain.wrapS = grain.wrapT = THREE.RepeatWrapping;
  grain.needsUpdate = true;
  return grain;
}

type Finish = (m: THREE.MeshPhysicalMaterial) => void;
const withGrain = (m: THREE.MeshPhysicalMaterial, repeat: number) => {
  const t = grainTexture().clone();
  t.repeat.set(repeat, repeat / 3);
  t.needsUpdate = true;
  m.roughnessMap = t;
};

const FINISHES: Record<string, Finish> = {
  // Rotomoulded polyethylene and its gelcoated foam dome: waxy, softly glossy, a faint sheen at grazing angles.
  hull: (m) => {
    m.roughness = 0.5;
    m.clearcoat = 0.3;
    m.clearcoatRoughness = 0.18;
    // Only a faint, orange-tinted sheen: a strong pale one washed the low sun out
    // to salmon and, at night, drew a neon strip along the sheer under the deck lamp.
    m.sheen = 0.08;
    m.sheenRoughness = 0.6;
    m.sheenColor.set(0xffb080);
    withGrain(m, 40);
  },
  transom: (m) => FINISHES.hull(m),
  dome: (m) => {
    m.roughness = 0.42;
    m.clearcoat = 0.45;
    m.clearcoatRoughness = 0.12;
    m.sheen = 0.2;
    m.sheenColor.set(0xffe2c8);
  },
  // Solar panels: tempered glass over the cells, with an anti-reflective coat that glints blue-violet.
  panel_fwd: (m) => {
    m.roughness = 0.1;
    m.metalness = 0.05;
    m.clearcoat = 1;
    m.clearcoatRoughness = 0.02;
    m.iridescence = 0.4;
    m.iridescenceIOR = 1.45;
    m.iridescenceThicknessRange = [180, 420];
    m.specularIntensity = 1;
  },
  panel_mid: (m) => FINISHES.panel_fwd(m),
  panel_aft: (m) => FINISHES.panel_fwd(m),
  beacon_top: (m) => FINISHES.panel_fwd(m),
  // Rubber rub strakes: matte.
  rubber: (m) => {
    m.roughness = 0.88;
    m.clearcoat = 0;
  },
  // G10 (glass-epoxy) keel and rudder: satin, with a thin coat.
  g10: (m) => {
    m.roughness = 0.55;
    m.clearcoat = 0.35;
    m.clearcoatRoughness = 0.25;
    withGrain(m, 12);
  },
  // Cast lead: dull grey metal.
  lead: (m) => {
    m.metalness = 0.75;
    m.roughness = 0.55;
    m.clearcoat = 0;
    withGrain(m, 6);
  },
  // Stainless fittings: brushed.
  steel: (m) => {
    m.metalness = 1;
    m.roughness = 0.28;
    m.anisotropy = 0.7;
  },
  // Plastic fittings: satin.
  black: (m) => {
    m.roughness = 0.6;
    m.clearcoat = 0;
  },
  white: (m) => {
    m.roughness = 0.45;
    m.clearcoat = 0.1;
  },
  beacon: (m) => {
    m.roughness = 0.4;
    m.clearcoat = 0.25;
  },
};

// Our model of the Randolph boat: generic finishes for what its parts look like
// (a painted hull, a sailcloth wing on a dark spar), not a claim about their materials.
const RANDOLPH_FINISHES: Record<string, Finish> = {
  hull: (m) => {
    m.roughness = 0.38;
    m.clearcoat = 0.55;
    m.clearcoatRoughness = 0.1;
    withGrain(m, 30);
  },
  transom: (m) => RANDOLPH_FINISHES.hull(m),
  hatch: (m) => {
    m.roughness = 0.35;
    m.clearcoat = 0.4;
  },
  teal: (m) => {
    m.roughness = 0.35;
    m.clearcoat = 0.5;
    m.clearcoatRoughness = 0.1;
  },
  fin: (m) => FINISHES.g10(m),
  lead: (m) => FINISHES.lead(m),
  weight: (m) => FINISHES.lead(m),
  panel_fwd: (m) => FINISHES.panel_fwd(m),
  panel_aft: (m) => FINISHES.panel_fwd(m),
  // The wing: sailcloth stretched on a frame, soft sheen, no gloss.
  wing: (m) => {
    m.roughness = 0.62;
    m.clearcoat = 0;
    m.sheen = 0.5;
    m.sheenRoughness = 0.6;
    m.sheenColor.set(0xffffff);
    m.side = THREE.DoubleSide;
  },
  // Dark composite spar: satin with a thin coat.
  spar: (m) => {
    m.metalness = 0.1;
    m.roughness = 0.4;
    m.clearcoat = 0.5;
    m.clearcoatRoughness = 0.15;
  },
  pvc: (m) => {
    m.roughness = 0.6;
    m.clearcoat = 0;
  },
  dark: (m) => FINISHES.black(m),
};

let fairing: THREE.DataTexture | null = null;
/**
 * A hull's fairing: a real hull is never a perfect mirror. Long, shallow
 * undulations (about a metre apart along the hull, a few tenths of a millimetre
 * deep) bend the reflections of the horizon a little. A normal map for the clear
 * coat; one tile is about 4 m along the hull by 1.5 m around it.
 */
function fairingTexture(): THREE.DataTexture {
  if (fairing) return fairing;
  const w = 256;
  const h = 64;
  let s = 7771;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  // A few smooth sine bumps with random phases, periodic over the tile.
  const terms = Array.from({ length: 9 }, (_, i) => ({ kx: 2 + (i % 4) + Math.floor(rnd() * 3), ky: Math.floor(rnd() * 3), p: rnd() * 6.283, a: 1 / (1 + i * 0.4) }));
  const hgt = (x: number, y: number) => terms.reduce((acc, t) => acc + t.a * Math.sin(6.283 * (t.kx * x + t.ky * y) + t.p), 0);
  const data = new Uint8Array(w * h * 4);
  const e = 1 / w;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const v = y / h;
      const nx = (hgt(u - e, v) - hgt(u + e, v)) * 0.6;
      const ny = (hgt(u, v - e) - hgt(u, v + e)) * 0.6 * (h / w);
      const l = Math.hypot(nx, ny, 1);
      data.set([128 + 127 * (nx / l), 128 + 127 * (ny / l), 128 + 127 * (1 / l), 255], (y * w + x) * 4);
    }
  fairing = new THREE.DataTexture(data, w, h);
  fairing.wrapS = fairing.wrapT = THREE.RepeatWrapping;
  fairing.needsUpdate = true;
  return fairing;
}

/** Stock boats' own looks, by key: the Pearson is a kept-up 1970s hull, the cruiser a new one. */
const STOCK_LOOK: Record<string, { fairing: number; coatRough: number }> = {
  stock_pearson31_2: { fairing: 0.35, coatRough: 0.22 },
  stock_cruiser31: { fairing: 0.12, coatRough: 0.15 },
};

/**
 * Finishes for the stock boats' Blender models (blender/build_stock.py names the
 * materials). The hull's gloss already varies by zone from its finish map
 * (glossy gelcoat, matte bottom paint, non-skid deck); this adds what glTF can't
 * carry: fairing in the reflections, satin teak, dull rigging wire. Each material once.
 */
export function applyStockFinishes(root: THREE.Object3D, key = ""): void {
  const look = STOCK_LOOK[key] ?? { fairing: 0.15, coatRough: 0.1 };
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!(m instanceof THREE.MeshStandardMaterial) || m.userData.finished) continue;
      m.userData.finished = true;
      const p = m instanceof THREE.MeshPhysicalMaterial ? m : null;
      switch (m.name) {
        case "hull":
        case "transom":
        case "cabin":
        case "cove_stripe":
          nightFloor(m);
          skyShade(m);
          if (p) {
            p.clearcoatRoughness = look.coatRough;
            if (look.fairing > 0) {
              const t = fairingTexture().clone();
              t.repeat.set(m.name === "hull" ? 2.4 : 1, m.name === "hull" ? 4 : 1);
              t.needsUpdate = true;
              p.clearcoatNormalMap = t;
              p.clearcoatNormalScale.setScalar(look.fairing);
            }
          }
          break;
        case "teak":
          m.roughness = 0.72;
          if (p) {
            p.clearcoat = 0;
            p.sheen = 0.2;
            p.sheenRoughness = 0.7;
            p.sheenColor.set(0xd9b48a);
          }
          break;
        case "wire":
          // Rigging wire is far thinner than a pixel at most distances: keep it dull,
          // or every strand sparkles.
          m.metalness = 0.5;
          m.roughness = 0.5;
          break;
        case "antifoul":
          m.roughness = 0.86;
          if (p) p.clearcoat = 0;
          break;
      }
      m.needsUpdate = true;
    }
  });
}

/**
 * At night a hull's topsides still catch a little sky glow and starlight, so the boat
 * shows as a faint shape and colour rather than a black cut-out (Elena, 12 Nov). Off by
 * day (NAV_NIGHT is 0). Chains onto any earlier onBeforeCompile.
 */
export function nightFloor(m: THREE.MeshStandardMaterial): void {
  if (m.userData.nightFloor) return;
  m.userData.nightFloor = true;
  const prev = m.onBeforeCompile.bind(m);
  const prevKey = m.customProgramCacheKey.bind(m);
  m.onBeforeCompile = (sh, r) => {
    prev(sh, r);
    sh.uniforms.uHullNight = NAV_NIGHT;
    sh.fragmentShader = sh.fragmentShader
      .replace("void main() {", "uniform float uHullNight;\nvoid main() {")
      .replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * vec3(0.05, 0.066, 0.1) * 0.45 * uHullNight;",
      );
  };
  m.customProgramCacheKey = () => `${prevKey()}|night-floor`;
}

/**
 * Sky shading on white topsides (Ines, 12 Nov): a hull lit only by an even sky reads as
 * flat plastic. Real topsides take most sky where they face up (deck, the flare), less
 * as they turn under toward the bilge, which also sees the dark sea rather than the sky,
 * and pick up a faint blue bounce off the water near the waterline. Scales the light
 * the hull already gets, so it goes dark at night with everything else.
 */
export function skyShade(m: THREE.MeshStandardMaterial): void {
  if (m.userData.skyShade) return;
  m.userData.skyShade = true;
  const prev = m.onBeforeCompile.bind(m);
  const prevKey = m.customProgramCacheKey.bind(m);
  m.onBeforeCompile = (sh, r) => {
    prev(sh, r);
    sh.vertexShader = sh.vertexShader
      .replace("void main() {", "varying vec3 vSkyN;\nvarying float vSkyY;\nvoid main() {")
      .replace(
        "#include <project_vertex>",
        "#include <project_vertex>\n  vSkyN = normalize(mat3(modelMatrix) * objectNormal);\n  vSkyY = (modelMatrix * vec4(transformed, 1.0)).y;",
      );
    sh.fragmentShader = sh.fragmentShader
      .replace("void main() {", "varying vec3 vSkyN;\nvarying float vSkyY;\nvoid main() {")
      .replace(
        "#include <lights_fragment_end>",
        `#include <lights_fragment_end>
  {
    float up = smoothstep(-0.75, 0.6, normalize(vSkyN).y);
    // Low on the topsides the hull sees the sea, not the sky: less light, a cool blue cast.
    float near = 1.0 - smoothstep(-0.1, 1.1, vSkyY);
    reflectedLight.indirectDiffuse *= mix(0.4, 1.1, up) * mix(1.0, 0.72, near) * mix(vec3(1.0), vec3(0.7, 0.9, 1.15), 0.7 * near);
    reflectedLight.directDiffuse *= mix(0.68, 1.0, up) * mix(1.0, 0.86, near);
  }`,
      );
  };
  m.customProgramCacheKey = () => `${prevKey()}|sky-shade`;
}

export type Boat = "kayak" | "randolph";

/** Give a detailed model's materials their real-world finish (each material once; they're shared). */
export function applyFinishes(root: THREE.Object3D, boat: Boat = "kayak"): void {
  const table = boat === "kayak" ? FINISHES : RANDOLPH_FINISHES;
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!(m instanceof THREE.MeshPhysicalMaterial) || m.userData.finished) continue;
      const f = table[m.name];
      if (!f) continue;
      f(m);
      if (m.name === "hull" || m.name === "transom") {
        nightFloor(m);
        skyShade(m);
      }
      m.userData.finished = true;
      m.needsUpdate = true;
    }
  });
}
