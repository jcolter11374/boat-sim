// Real-world finishes for the detailed boats' materials (blender/*.py names
// them): rotomoulded plastic is waxy and a little rough, not glossy; solar
// panels are glass with an anti-reflective coat that glints blue-violet;
// stainless is brushed; lead goes dull; epoxy-glass is satin. three.js's
// physical material does the work; this only sets it up, once per material.

import * as THREE from "three";

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
    m.sheen = 0.25;
    m.sheenRoughness = 0.5;
    m.sheenColor.set(0xffe2c8);
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

/** Give a detailed model's materials their real-world finish (each material once; they're shared). */
export function applyFinishes(root: THREE.Object3D): void {
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!(m instanceof THREE.MeshPhysicalMaterial) || m.userData.finished) continue;
      const f = FINISHES[m.name];
      if (!f) continue;
      f(m);
      m.userData.finished = true;
      m.needsUpdate = true;
    }
  });
}
