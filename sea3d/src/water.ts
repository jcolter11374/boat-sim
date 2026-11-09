// The sea surface mesh: the same Gerstner sea as waves.ts, drawn with a grid
// that is fine near the boats and coarse towards the horizon, coloured by
// height with foam on the crests.

import * as THREE from "three";
import type { Quality } from "./boats/parts";
import { displace, type WaveComponent } from "./waves";

export const SEA_SIZE = 400; // m, side of the patch of sea
const GRID: Record<Quality, { n: number; centre: number }> = {
  low: { n: 110, centre: 0.45 }, // segments per side, grid spacing at the centre (m)
  high: { n: 220, centre: 0.22 },
};

const DEEP = new THREE.Color(0x0b3a5a);
const SHALLOW = new THREE.Color(0x2d86ad);
const FOAM = new THREE.Color(0xf4f8fb);

export class Sea {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
  private base = new Float32Array();
  private colours = new Float32Array();
  private foamAmount = 0;
  private hs = 1;
  readonly steepness = 0.5;

  constructor(quality: Quality) {
    const material = new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      roughness: 0.14,
      metalness: 0,
      clearcoat: 0.6,
      clearcoatRoughness: 0.08,
      envMapIntensity: 0.9,
      transparent: true,
      opacity: 0.93,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.mesh.renderOrder = 10; // after the hulls, so keels show through
    this.setQuality(quality);
  }

  /** Grid that is fine near the middle: x = a u + b u^3 for u in [-1, 1]. */
  setQuality(quality: Quality): void {
    const { n, centre } = GRID[quality];
    const half = SEA_SIZE / 2;
    const a = (centre * n) / 2;
    const b = half - a;
    const geo = new THREE.PlaneGeometry(2, 2, n, n);
    geo.rotateX(-Math.PI / 2);
    const p = geo.attributes.position.array as Float32Array;
    for (let i = 0; i < p.length; i += 3) {
      const u = p[i];
      const v = p[i + 2];
      p[i] = a * u + b * u * u * u;
      p[i + 2] = a * v + b * v * v * v;
    }
    this.base = Float32Array.from(p);
    this.colours = new Float32Array(p.length);
    geo.setAttribute("color", new THREE.BufferAttribute(this.colours, 3));
    this.mesh.geometry.dispose();
    this.mesh.geometry = geo;
  }

  get vertexCount(): number {
    return this.base.length / 3;
  }

  setSea(hs: number): void {
    this.hs = hs;
    // Whitecaps start around a fresh breeze; none on a calm sea.
    this.foamAmount = THREE.MathUtils.clamp((hs - 0.8) / 3.2, 0, 1); // GUESS display tuning
  }

  setSeeThrough(on: boolean): void {
    this.mesh.material.opacity = on ? 0.45 : 0.93;
  }

  update(comps: WaveComponent[], t: number): void {
    const geo = this.mesh.geometry;
    const pos = geo.attributes.position;
    const arr = pos.array as Float32Array;
    const col = this.colours;
    const amp = this.hs / 2;
    const foam = this.foamAmount;
    for (let i = 0; i < arr.length; i += 3) {
      const x0 = this.base[i];
      const z0 = this.base[i + 2];
      const [dx, y, dz] = displace(comps, x0, z0, t, this.steepness);
      arr[i] = x0 + dx;
      arr[i + 1] = y;
      arr[i + 2] = z0 + dz;
      // Colour: deep in the troughs, lighter on the faces, foam on high crests.
      const h = amp > 0 ? y / amp : 0; // about -2..2
      const lift = THREE.MathUtils.clamp(0.5 + 0.3 * h, 0, 1);
      let r = DEEP.r + (SHALLOW.r - DEEP.r) * lift;
      let g = DEEP.g + (SHALLOW.g - DEEP.g) * lift;
      let b = DEEP.b + (SHALLOW.b - DEEP.b) * lift;
      if (foam > 0 && h > 0.9) {
        // Patchy: a cheap moving pattern so whitecaps don't form perfect stripes.
        const patch = 0.5 + 0.5 * Math.sin(x0 * 0.31 + z0 * 0.17 + t * 0.4) * Math.sin(z0 * 0.23 - x0 * 0.11);
        const f = foam * THREE.MathUtils.smoothstep(h, 0.9, 1.6) * (0.35 + 0.65 * patch);
        r += (FOAM.r - r) * f;
        g += (FOAM.g - g) * f;
        b += (FOAM.b - b) * f;
      }
      col[i] = r;
      col[i + 1] = g;
      col[i + 2] = b;
    }
    pos.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.computeVertexNormals();
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
