/**
 * Trees on real land, from a land-cover mask on the land's own grid
 * (<land>_cover.png: 0 water or none, 1 trees, 2 grass, 3 marsh, 4 sand, 5 built),
 * plus single trees and tree rows that OpenStreetMap maps (<land>_trees.json, ODbL).
 *
 * Every tree is placed from its cell's own seed, so the same land always grows the
 * same trees. Full density near the boat, thinning with distance (the colour image
 * already shows far woods), never inside or against a building. Two kinds: broadleaf
 * (most of the Chesapeake's oaks and maples) and pines. Their crowns sway with the wind.
 * Display only.
 */
import * as THREE from "three";
import type { Quality } from "../boats/parts";
import type { LandGrid } from "./island";
import type { Place } from "./place";
import { bendWithEarth, metresPerDegree, rnd } from "./shader";

export const TREE_CLASS = 1;

export interface TreeOptions {
  /** m from the boat that trees reach. */
  radius: number;
  /** Most trees drawn. */
  max: number;
  /** m within which every tree cell is filled. */
  near: number;
  /** Trees per tree cell, near the boat. */
  perCell: number;
  seed: number;
}

export const TREE_OPTIONS: Record<Quality, TreeOptions> = {
  high: { radius: 4500, max: 60000, near: 700, perCell: 1.3, seed: 7 },
  low: { radius: 2500, max: 18000, near: 400, perCell: 1, seed: 7 },
};

/** OSM's mapped trees: points [lon, lat, height or null] and rows [[lon, lat], ...]. */
export interface MappedTrees {
  points?: [number, number, number | null][];
  rows?: [number, number][][];
}

const STRIDE = 5; // x, y, z, height, kind (0 broadleaf, 1 pine)

/**
 * Where the trees stand: STRIDE floats each, in metres from the place (x east, z south).
 * `blocked` keeps them out of buildings (world x, z).
 */
export function treeSpots(
  grid: LandGrid,
  cls: Uint8Array,
  hgt: Int16Array,
  at: { lat: number; lon: number; mid?: number },
  o: TreeOptions,
  blocked: (x: number, z: number) => boolean = () => false,
  mapped: MappedTrees = {},
): Float32Array {
  // at.mid: the latitude the land was laid out at, when not its own middle (the Bay's squares share one).
  const { mx, my } = metresPerDegree(at.mid ?? (grid.lat0 + grid.lat1) / 2);
  const scale = grid.scale ?? 1;
  // Bigger cells than the 11 m the density was tuned on hold more trees each (the squares' "tree_cell").
  const perCell = o.perCell * (grid.tree_cell ?? 1);
  const dlon = (grid.lon1 - grid.lon0) / (grid.nx - 1);
  const dlat = (grid.lat1 - grid.lat0) / (grid.ny - 1);
  const cx = dlon * mx;
  const cz = dlat * my;
  const xOf = (i: number) => (grid.lon0 + dlon * i - at.lon) * mx;
  const zOf = (j: number) => -(grid.lat1 - dlat * j - at.lat) * my;
  const iOf = (x: number) => (x / mx + at.lon - grid.lon0) / dlon;
  const jOf = (z: number) => (grid.lat1 - (at.lat - z / my)) / dlat;
  const ground = (x: number, z: number) => {
    const fi = iOf(x);
    const fj = jOf(z);
    const i = Math.floor(fi);
    const j = Math.floor(fj);
    if (i < 0 || j < 0 || i >= grid.nx - 1 || j >= grid.ny - 1) return -1;
    const a = fi - i;
    const b = fj - j;
    const h = (ii: number, jj: number) => hgt[jj * grid.nx + ii] * scale;
    return (h(i, j) * (1 - a) + h(i + 1, j) * a) * (1 - b) + (h(i, j + 1) * (1 - a) + h(i + 1, j + 1) * a) * b;
  };
  const i0 = Math.max(Math.floor(iOf(-o.radius)), 0);
  const i1 = Math.min(Math.ceil(iOf(o.radius)), grid.nx - 1);
  const j0 = Math.max(Math.floor(jOf(-o.radius)), 0);
  const j1 = Math.min(Math.ceil(jOf(o.radius)), grid.ny - 1);
  const keep = (d: number) => Math.min(1, Math.pow(o.near / Math.max(d, 1), 1.5));
  // How many there would be, so a big wood thins evenly instead of stopping at the cap.
  let expected = 0;
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      if (cls[j * grid.nx + i] !== TREE_CLASS || hgt[j * grid.nx + i] <= 0) continue;
      const d = Math.hypot(xOf(i), zOf(j));
      if (d <= o.radius) expected += perCell * keep(d);
    }
  const fit = expected > o.max ? o.max / expected : 1;
  const out: number[] = [];
  const add = (x: number, z: number, height: number, kind: number) => {
    if (out.length / STRIDE >= o.max || blocked(x, z)) return;
    const y = ground(x, z);
    if (y <= 0.3) return; // in the water, or off the grid
    out.push(x, y - 0.8, z, height, kind);
  };
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      if (cls[j * grid.nx + i] !== TREE_CLASS) continue;
      const x = xOf(i);
      const z = zOf(j);
      const d = Math.hypot(x, z);
      if (d > o.radius) continue;
      const p = perCell * keep(d) * fit;
      const r = rnd((Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ o.seed) >>> 0);
      const n = Math.floor(p) + (r() < p - Math.floor(p) ? 1 : 0);
      // Far trees stand for the ones left out, so they're drawn a little bigger.
      const grow = Math.min(1.5, 1 / Math.sqrt(Math.max(keep(d) * fit, 0.05)));
      for (let k = 0; k < n; k++) {
        const tx = x + (r() - 0.5) * cx;
        const tz = z + (r() - 0.5) * cz;
        const kind = r() < 0.82 ? 0 : 1;
        add(tx, tz, (9 + 10 * r()) * (kind ? 1.1 : 1) * Math.min(grow, 1 + 0.25 * (grow - 1)), kind);
      }
    }
  // Mapped trees, where the mask has no wood already (street trees, lines along a road).
  const notWood = (x: number, z: number) => {
    const i = Math.round(iOf(x));
    const j = Math.round(jOf(z));
    return i >= 0 && j >= 0 && i < grid.nx && j < grid.ny && cls[j * grid.nx + i] !== TREE_CLASS;
  };
  const r = rnd(o.seed + 1);
  for (const [lon, lat, h] of mapped.points ?? []) {
    const x = (lon - at.lon) * mx;
    const z = -(lat - at.lat) * my;
    if (Math.hypot(x, z) <= o.radius && notWood(x, z)) add(x, z, h && h > 2 ? h : 8 + 8 * r(), 0);
  }
  for (const row of mapped.rows ?? [])
    for (let k = 0; k + 1 < row.length; k++) {
      const ax = (row[k][0] - at.lon) * mx;
      const az = -(row[k][1] - at.lat) * my;
      const bx = (row[k + 1][0] - at.lon) * mx;
      const bz = -(row[k + 1][1] - at.lat) * my;
      const len = Math.hypot(bx - ax, bz - az);
      for (let s = 0; s < len; s += 8) {
        const x = ax + ((bx - ax) * s) / len;
        const z = az + ((bz - az) * s) / len;
        if (Math.hypot(x, z) <= o.radius && notWood(x, z)) add(x, z, 9 + 6 * r(), 0);
      }
    }
  return new Float32Array(out);
}

/** A tree 1 m tall, trunk brown and crown white (the instance colour greens it). */
function treeGeometry(kind: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const paint = (g: THREE.BufferGeometry, c: [number, number, number]) => {
    g.deleteAttribute("uv");
    const n = g.getAttribute("position").count;
    g.setAttribute("color", new THREE.Float32BufferAttribute(Array.from({ length: n * 3 }, (_, i) => c[i % 3]), 3));
    parts.push(g.index ? g.toNonIndexed() : g);
  };
  const trunk = new THREE.CylinderGeometry(0.018, 0.03, kind ? 0.4 : 0.55, 5);
  trunk.translate(0, kind ? 0.2 : 0.275, 0);
  paint(trunk, [0.32, 0.22, 0.16]);
  if (kind === 0) {
    // A lumpy round crown: an icosphere pushed in and out.
    const crown = new THREE.IcosahedronGeometry(1, 1);
    const p = crown.getAttribute("position");
    const r = rnd(3);
    for (let k = 0; k < p.count; k++) {
      const f = 0.85 + 0.3 * r();
      p.setXYZ(k, p.getX(k) * 0.34 * f, p.getY(k) * 0.3 * f, p.getZ(k) * 0.34 * f);
    }
    crown.translate(0, 0.66, 0);
    paint(crown, [1, 1, 1]);
  } else {
    for (const [r, h, y] of [
      [0.2, 0.42, 0.45],
      [0.15, 0.36, 0.66],
      [0.09, 0.28, 0.86],
    ]) {
      const c = new THREE.ConeGeometry(r, h, 7);
      c.translate(0, y, 0);
      paint(c, [0.8, 0.85, 0.8]);
    }
  }
  const g = parts.length > 1 ? (mergeAll(parts) ?? parts[0]) : parts[0];
  g.computeVertexNormals();
  return g;
}

function mergeAll(parts: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  let n = 0;
  for (const p of parts) n += p.getAttribute("position").count;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  let o = 0;
  for (const p of parts) {
    pos.set(p.getAttribute("position").array as Float32Array, o * 3);
    col.set(p.getAttribute("color").array as Float32Array, o * 3);
    o += p.getAttribute("position").count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return g;
}

export class Trees {
  readonly group = new THREE.Group();
  readonly count: number;
  private readonly uniforms = {
    uTime: { value: 0 },
    uWind: { value: 0 },
    uHaze: { value: new THREE.Color(0.7, 0.8, 0.9) },
    uHazeK: { value: 1 },
  };

  private constructor(spots: Float32Array) {
    this.group.name = "trees";
    this.count = spots.length / STRIDE;
    const u = this.uniforms;
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, flatShading: true });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace("void main() {", "uniform float uTime;\nuniform float uWind;\nvarying vec3 vW;\nvoid main() {")
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          {
            // The crown leans and rocks with the wind; the trunk's foot stays put.
            vec2 base = instanceMatrix[3].xz;
            float sway = sin(uTime * 1.3 + base.x * 0.07 + base.y * 0.05) * 0.6 + 0.4;
            transformed.x += transformed.y * transformed.y * 0.025 * uWind * sway;
          }`,
        );
      sh.vertexShader = sh.vertexShader.replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;");
      sh.fragmentShader = sh.fragmentShader.replace("void main() {", "uniform vec3 uHaze;\nuniform float uHazeK;\nvarying vec3 vW;\nvoid main() {").replace(
        "#include <fog_fragment>",
        `float hz = 1.0 - exp(-length(vW.xz) / (21000.0 * uHazeK));
        gl_FragColor.rgb = mix(gl_FragColor.rgb, uHaze, clamp(hz, 0.0, 0.85));
        #include <fog_fragment>`,
      );
    };
    bendWithEarth(mat, "boatsim-trees-v1", true);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const sc = new THREE.Vector3();
    const col = new THREE.Color();
    const r = rnd(5);
    for (const kind of [0, 1]) {
      const idx: number[] = [];
      for (let k = 0; k < this.count; k++) if (spots[k * STRIDE + 4] === kind) idx.push(k);
      if (!idx.length) continue;
      const im = new THREE.InstancedMesh(treeGeometry(kind), mat, idx.length);
      idx.forEach((k, n) => {
        const h = spots[k * STRIDE + 3];
        q.setFromAxisAngle(up, r() * Math.PI * 2);
        m.compose(pos.set(spots[k * STRIDE], spots[k * STRIDE + 1], spots[k * STRIDE + 2]), q, sc.set(h * (0.85 + 0.3 * r()), h, h * (0.85 + 0.3 * r())));
        im.setMatrixAt(n, m);
        // Summer greens, a few darker or yellower; pines darker still.
        if (kind === 0) col.setHSL(0.22 + 0.06 * r(), 0.35 + 0.2 * r(), 0.13 + 0.07 * r());
        else col.setHSL(0.3 + 0.04 * r(), 0.3 + 0.1 * r(), 0.09 + 0.04 * r());
        im.setColorAt(n, col);
      });
      im.name = kind ? "pines" : "broadleaf";
      im.frustumCulled = false; // the curve moves vertices after culling's bounds
      this.group.add(im);
    }
  }

  /**
   * Grow the place's trees on its land (already loaded), or null when it has no cover mask.
   * `blocked` keeps them out of buildings (world x, z).
   */
  static async load(
    place: Place,
    quality: Quality,
    grid: { meta: LandGrid; hgt: Int16Array },
    blocked?: (x: number, z: number) => boolean,
    base = "./land",
    opt: { mid?: number; options?: Partial<TreeOptions> } = {},
  ): Promise<Trees | null> {
    const name = place.land ?? place.key;
    // Only places baked with land cover have the files: don't ask for them elsewhere (a 404 in the console, #342).
    if (!grid.meta.cover) return null;
    const get = async (f: string) => {
      const r = await fetch(`${base}/${name}_${f}`);
      if (!r.ok || (r.headers.get("content-type") ?? "").includes("text/html")) throw new Error(f);
      return r;
    };
    let cls: Uint8Array;
    try {
      const bmp = await createImageBitmap(await (await get("cover.png")).blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
      if (bmp.width !== grid.meta.nx || bmp.height !== grid.meta.ny) throw new Error("cover grid");
      const cv = new OffscreenCanvas(bmp.width, bmp.height);
      const cx = cv.getContext("2d", { willReadFrequently: true })!;
      cx.drawImage(bmp, 0, 0);
      const px = cx.getImageData(0, 0, bmp.width, bmp.height).data;
      cls = new Uint8Array(bmp.width * bmp.height);
      for (let k = 0; k < cls.length; k++) cls[k] = px[k * 4];
    } catch {
      return null;
    }
    const mapped: MappedTrees = await get("trees.json")
      .then((r) => r.json() as Promise<MappedTrees>)
      .catch(() => ({}));
    const o = { ...TREE_OPTIONS[quality], ...opt.options };
    return new Trees(treeSpots(grid.meta, cls, grid.hgt, { lat: place.lat, lon: place.lon, mid: opt.mid }, o, blocked, mapped));
  }

  /** Each frame: the wind (m/s) for the sway, and the air's colour and the storm for the haze. */
  update(t: number, wind: number, haze: THREE.Color, storm: number): void {
    this.uniforms.uTime.value = t;
    this.uniforms.uWind.value = THREE.MathUtils.clamp(wind / 15, 0, 1.5);
    this.uniforms.uHaze.value.copy(haze);
    this.uniforms.uHazeK.value = 1 - 0.75 * storm;
  }
}
