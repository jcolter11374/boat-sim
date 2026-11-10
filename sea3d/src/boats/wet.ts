// A wet boat: in rain and spray every surface gets glossier and a little
// darker, and water drops bead on the clear coat. One setting, 0 (dry) .. 1
// (soaked), for the whole model. Cosmetic.

import * as THREE from "three";

let drops: THREE.CanvasTexture | null = null;
/** A normal map of water drops (round bumps), shared by every wet boat. */
function dropTexture(): THREE.CanvasTexture {
  if (drops) return drops;
  const n = 256;
  const c = document.createElement("canvas");
  c.width = c.height = n;
  const g = c.getContext("2d")!;
  const img = g.createImageData(n, n);
  const hgt = new Float32Array(n * n);
  let s = 99;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 260; k++) {
    const cx = rnd() * n;
    const cy = rnd() * n;
    const r = 2 + rnd() * rnd() * 9;
    const run = rnd() < 0.25 ? 2 + rnd() * 3 : 1; // some drops have run down into streaks
    for (let y = -r * run; y <= r; y++)
      for (let x = -r; x <= r; x++) {
        const yy = y < 0 ? y / run : y;
        const d = 1 - (x * x + yy * yy) / (r * r);
        if (d <= 0) continue;
        const px = ((Math.round(cx + x) % n) + n) % n;
        const py = ((Math.round(cy + y) % n) + n) % n;
        hgt[py * n + px] = Math.max(hgt[py * n + px], Math.sqrt(d) * r);
      }
  }
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const h = (dx: number, dy: number) => hgt[((y + dy + n) % n) * n + ((x + dx + n) % n)];
      const nx = (h(-1, 0) - h(1, 0)) * 0.35;
      const ny = (h(0, -1) - h(0, 1)) * 0.35;
      const l = Math.hypot(nx, ny, 1);
      const i = (y * n + x) * 4;
      img.data[i] = 128 + 127 * (nx / l);
      img.data[i + 1] = 128 + 127 * (ny / l);
      img.data[i + 2] = 128 + 127 * (1 / l);
      img.data[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  drops = new THREE.CanvasTexture(c);
  drops.wrapS = drops.wrapT = THREE.RepeatWrapping;
  drops.repeat.set(14, 5);
  return drops;
}

interface Dry {
  m: THREE.MeshStandardMaterial;
  rough: number;
  color: THREE.Color;
  coat?: number;
  coatRough?: number;
}

export class Wetness {
  private mats: Dry[] = [];
  private level = -1;

  constructor(root: THREE.Object3D) {
    const seen = new Set<THREE.Material>();
    root.traverse((o) => {
      const ms = o instanceof THREE.Mesh ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of ms) {
        if (seen.has(m) || !(m instanceof THREE.MeshStandardMaterial) || m.emissiveIntensity > 0.5 || m.transparent) continue;
        seen.add(m);
        // The dry look is kept on the material, since a detailed model's materials are shared by every copy.
        m.userData.dry ??= {
          rough: m.roughness,
          color: m.color.clone(),
          ...(m instanceof THREE.MeshPhysicalMaterial ? { coat: m.clearcoat, coatRough: m.clearcoatRoughness } : {}),
        };
        this.mats.push({ m, ...(m.userData.dry as Omit<Dry, "m">) });
      }
    });
  }

  /** 0 dry .. 1 soaked. */
  set(w: number): void {
    w = THREE.MathUtils.clamp(w, 0, 1);
    if (Math.abs(w - this.level) < 0.01) return;
    const beads = w > 0.15;
    for (const d of this.mats) {
      // Water fills the surface's roughness and darkens it a little (light goes into the film).
      d.m.roughness = THREE.MathUtils.lerp(d.rough, Math.min(d.rough, 0.12), w);
      d.m.color.copy(d.color).multiplyScalar(1 - 0.18 * w * Math.min(1, d.rough * 2));
      if (d.coat !== undefined && d.m instanceof THREE.MeshPhysicalMaterial) {
        d.m.clearcoat = THREE.MathUtils.lerp(d.coat, 1, w);
        d.m.clearcoatRoughness = THREE.MathUtils.lerp(d.coatRough ?? 0.1, 0.04, w);
        const want = beads ? dropTexture() : null;
        if (d.m.clearcoatNormalMap !== want) {
          d.m.clearcoatNormalMap = want;
          d.m.needsUpdate = true;
        }
        d.m.clearcoatNormalScale.setScalar(0.9 * w);
      }
    }
    this.level = w;
  }
}
