/**
 * Real land around the boat (?place=pico): Pico and Faial from the land-data
 * release. Heights are AWS Terrain Tiles; the colour is a cloud-free median of
 * Sentinel-2 passes ("contains modified Copernicus Sentinel data").
 *
 * Looks, on top of the plain heightmap:
 * - a band of dark wet basalt along the waterline (Pico's shore is black lava),
 * - surf: white bands that roll in towards the shore and a wash line at the
 *   water's edge, more of it in a bigger sea,
 * - haze: distant slopes fade towards the colour of the air,
 * - the earth curving away, so the far shore drops a little below the horizon.
 * Display only: the boat's physics never sees the land.
 */
import * as THREE from "three";
import type { Quality } from "../boats/parts";
import type { Place } from "./place";

const R_EARTH = 6371000;

interface Meta {
  nx: number;
  ny: number;
  lon0: number;
  lon1: number;
  lat0: number;
  lat1: number;
}

/** Shared by the land and the surf: drop the far ground with the earth's curve (world x, z from the boat). */
const CURVE = `
  vec4 wpC = modelMatrix * vec4(transformed, 1.0);
  transformed.y -= dot(wpC.xz, wpC.xz) / ${(2 * R_EARTH).toFixed(1)};
`;

const NOISE = `
float lhash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float lnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(lhash(i), lhash(i + vec2(1, 0)), f.x), mix(lhash(i + vec2(0, 1)), lhash(i + vec2(1, 1)), f.x), f.y);
}
`;

export class Island {
  readonly group = new THREE.Group();
  private surfMat: THREE.ShaderMaterial | null = null;
  private landUniforms: { uHaze: { value: THREE.Color }; uHazeK: { value: number } } = {
    uHaze: { value: new THREE.Color(0.7, 0.8, 0.9) },
    uHazeK: { value: 1 },
  };
  /** Surf sheet size (for tests). */
  surfTriangles = 0;
  /** True once the files have loaded and the land is in the scene. */
  ready = false;

  private constructor(private readonly place: Place) {
    this.group.name = "land";
  }

  /** Load the place's land; null when the files aren't published on this copy of the site. */
  static async load(place: Place, quality: Quality, base = "./land"): Promise<Island | null> {
    const get = async (f: string) => {
      const r = await fetch(`${base}/${place.land ?? place.key}_${f}`);
      if (!r.ok || (r.headers.get("content-type") ?? "").includes("text/html")) throw new Error(f);
      return r;
    };
    let meta: Meta;
    let hgt: Int16Array;
    let map: THREE.Texture;
    try {
      meta = await (await get("meta.json")).json();
      hgt = new Int16Array(await (await get("height.bin")).arrayBuffer());
      map = await new THREE.TextureLoader().loadAsync(`${base}/${place.key}_colour.jpg`);
    } catch {
      return null;
    }
    const isl = new Island(place);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 8;
    isl.build(meta, hgt, map, quality === "low" ? 4 : 2);
    isl.ready = true;
    return isl;
  }

  private build(meta: Meta, hgt: Int16Array, map: THREE.Texture, step: number): void {
    const { place } = this;
    const mx = 111320 * Math.cos((((meta.lat0 + meta.lat1) / 2) * Math.PI) / 180);
    const my = 110950;
    const at = (i: number, j: number) => hgt[Math.min(j, meta.ny - 1) * meta.nx + Math.min(i, meta.nx - 1)];
    const xOf = (i: number) => (meta.lon0 + ((meta.lon1 - meta.lon0) * i) / (meta.nx - 1) - place.lon) * mx;
    const zOf = (j: number) => -(meta.lat1 - ((meta.lat1 - meta.lat0) * j) / (meta.ny - 1) - place.lat) * my;

    // ---- the land ----
    const nx = Math.floor((meta.nx - 1) / step) + 1;
    const ny = Math.floor((meta.ny - 1) / step) + 1;
    const pos = new Float32Array(nx * ny * 3);
    const uv = new Float32Array(nx * ny * 2);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const si = Math.min(i * step, meta.nx - 1);
        const sj = Math.min(j * step, meta.ny - 1);
        const k = j * nx + i;
        pos[k * 3] = xOf(si);
        const h = at(si, sj);
        if (h > 0) pos[k * 3 + 1] = h;
        else {
          // The files have no sea floor. Drop sea points next to a cliff deep enough that
          // the slope between them meets the water close to the real shore, not out at sea.
          let nb = 0;
          for (let dj = -1; dj <= 1; dj++)
            for (let di = -1; di <= 1; di++) nb = Math.max(nb, at(Math.max(si + di * step, 0), Math.max(sj + dj * step, 0)));
          pos[k * 3 + 1] = -8 - 3 * nb;
        }
        pos[k * 3 + 2] = zOf(sj);
        uv[k * 2] = si / (meta.nx - 1);
        uv[k * 2 + 1] = 1 - sj / (meta.ny - 1);
      }
    const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
    let n = 0;
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i;
        idx.set([a, a + nx, a + 1, a + 1, a + nx, a + nx + 1], n);
        n += 6;
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.93, metalness: 0, color: new THREE.Color(1.2, 1.2, 1.2) });
    const lu = this.landUniforms;
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, lu);
      sh.vertexShader = sh.vertexShader
        .replace("void main() {", "varying float vH;\nvarying vec3 vW;\nvoid main() {")
        .replace("#include <begin_vertex>", `#include <begin_vertex>\nvH = transformed.y;\n${CURVE}\nvW = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
      sh.fragmentShader = sh.fragmentShader
        .replace("void main() {", `uniform vec3 uHaze;\nuniform float uHazeK;\nvarying float vH;\nvarying vec3 vW;\n${NOISE}\nvoid main() {`)
        .replace(
          "#include <map_fragment>",
          `#include <map_fragment>
          // Black basalt along the waterline, wet and darker at the bottom; broken up so it isn't a stripe.
          float br = lnoise(vW.xz * 0.05) * 0.6 + lnoise(vW.xz * 0.31) * 0.4;
          float rock = (1.0 - smoothstep(4.0 + 9.0 * br, 12.0 + 14.0 * br, vH)) * smoothstep(-3.0, -0.5, vH);
          vec3 basalt = vec3(0.045, 0.043, 0.042) * (0.7 + 0.6 * br);
          diffuseColor.rgb = mix(diffuseColor.rgb, basalt, rock * 0.85);
          diffuseColor.rgb *= mix(1.0, 0.55, 1.0 - smoothstep(0.0, 2.5, vH)); // wet`,
        )
        .replace(
          "#include <roughnessmap_fragment>",
          "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.35, 1.0 - smoothstep(0.0, 2.5, vH));",
        )
        .replace(
          "#include <fog_fragment>",
          `// Haze: far slopes fade into the colour of the air, more over the first tens of km.
          float hd = length(vW.xz);
          float haze = (1.0 - exp(-hd / (21000.0 * uHazeK))) * (1.0 - 0.35 * smoothstep(300.0, 2200.0, vH));
          gl_FragColor.rgb = mix(gl_FragColor.rgb, uHaze, clamp(haze, 0.0, 0.85));
          #include <fog_fragment>`,
        );
    };
    mat.customProgramCacheKey = () => "boatsim-land-v1";
    const land = new THREE.Mesh(geo, mat);
    land.name = "island";
    land.frustumCulled = false; // the curve moves vertices after culling's bounds
    this.group.add(land);

    // ---- the surf: a sheet just above the water along the shore ----
    // The height files have no sea floor (the sea is 0), so the surf is laid out by
    // distance from the shore: signed metres, positive offshore, negative inland.
    const W = meta.nx;
    const H = meta.ny;
    const cell = ((meta.lon1 - meta.lon0) / (W - 1)) * mx; // about 31 m
    const BIG = 1e9;
    const off = new Float32Array(W * H); // to the nearest land, for sea pixels
    const inl = new Float32Array(W * H); // to the nearest sea, for land pixels
    for (let k = 0; k < W * H; k++) {
      const land = hgt[k] > 0;
      off[k] = land ? 0 : BIG;
      inl[k] = land ? BIG : 0;
    }
    const D2 = Math.SQRT2;
    for (const d of [off, inl]) {
      for (let j = 0; j < H; j++)
        for (let i = 0; i < W; i++) {
          const k = j * W + i;
          let v = d[k];
          if (i > 0) v = Math.min(v, d[k - 1] + 1);
          if (j > 0) {
            v = Math.min(v, d[k - W] + 1);
            if (i > 0) v = Math.min(v, d[k - W - 1] + D2);
            if (i < W - 1) v = Math.min(v, d[k - W + 1] + D2);
          }
          d[k] = v;
        }
      for (let j = H - 1; j >= 0; j--)
        for (let i = W - 1; i >= 0; i--) {
          const k = j * W + i;
          let v = d[k];
          if (i < W - 1) v = Math.min(v, d[k + 1] + 1);
          if (j < H - 1) {
            v = Math.min(v, d[k + W] + 1);
            if (i < W - 1) v = Math.min(v, d[k + W + 1] + D2);
            if (i > 0) v = Math.min(v, d[k + W - 1] + D2);
          }
          d[k] = v;
        }
    }
    const signed = (i: number, j: number) => {
      const k = j * W + i;
      return hgt[k] > 0 ? -(inl[k] - 0.5) * cell : (off[k] - 0.5) * cell;
    };
    const REACH = 330; // m offshore that the surf can reach
    const spos: number[] = [];
    const sdep: number[] = [];
    const sidx: number[] = [];
    const vid = new Map<number, number>();
    const vert = (i: number, j: number) => {
      const k = j * W + i;
      let v = vid.get(k);
      if (v === undefined) {
        v = spos.length / 3;
        vid.set(k, v);
        spos.push(xOf(i), 0.45, zOf(j));
        sdep.push(signed(i, j));
      }
      return v;
    };
    for (let j = 0; j < H - 1; j++)
      for (let i = 0; i < W - 1; i++) {
        const ds = [signed(i, j), signed(i + 1, j), signed(i, j + 1), signed(i + 1, j + 1)];
        if (Math.min(...ds) > REACH || Math.max(...ds) < -cell) continue; // open water, or inland
        const a = vert(i, j);
        const b = vert(i + 1, j);
        const c = vert(i, j + 1);
        const d = vert(i + 1, j + 1);
        sidx.push(a, c, b, b, c, d);
      }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute("position", new THREE.Float32BufferAttribute(spos, 3));
    sg.setAttribute("depth", new THREE.Float32BufferAttribute(sdep, 1));
    sg.setIndex(sidx);
    this.surfTriangles = sidx.length / 3;
    this.surfMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uTime: { value: 0 }, uLight: { value: 1 }, uSea: { value: 1 } },
      ]),
      vertexShader: `
        attribute float depth;
        uniform float uTime;
        uniform float uSea;
        varying float vD;
        varying vec2 vXZ;
        #include <fog_pars_vertex>
        void main() {
          vec3 transformed = position;
          // White water stands up against the rocks (so it shows from a distance), surging with the sets.
          float surge = 0.6 + 0.4 * sin(uTime * 0.7 + position.x * 0.013 + position.z * 0.017);
          transformed.y += (1.0 - smoothstep(0.0, 40.0 + 25.0 * uSea, depth)) * (1.6 + 1.8 * uSea) * surge;
          ${CURVE}
          vD = depth;
          vec4 wp = modelMatrix * vec4(transformed, 1.0);
          vXZ = wp.xz;
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        uniform float uTime;
        uniform float uLight;
        uniform float uSea;
        varying float vD;
        varying vec2 vXZ;
        #include <fog_pars_fragment>
        ${NOISE}
        void main() {
          // vD: metres from the shore, out to sea.
          if (vD < -2.0) discard;
          float n = lnoise(vXZ * 0.02) * 0.6 + lnoise(vXZ * 0.11) * 0.4;
          // Breakers roll in: a phase that runs towards the shore as time goes on.
          float ph = vD * 0.11 + uTime * (0.9 + 0.3 * uSea) + n * 5.0;
          float reach = 90.0 + 140.0 * uSea;
          float bands = smoothstep(0.6, 0.97, sin(ph)) * (1.0 - smoothstep(0.35 * reach, reach, vD));
          bands *= smoothstep(0.25, 0.65, lnoise(vXZ * 0.03 + vec2(uTime * 0.05, 0.0)) + 0.25 * uSea);
          // The wash: white water where the sea meets the rock, pulsing with the sets.
          float wash = (1.0 - smoothstep(8.0, 22.0 + 22.0 * uSea, vD)) * smoothstep(-2.0, 2.0, vD);
          wash *= 0.6 + 0.4 * sin(uTime * 0.7 + n * 6.0);
          float a = clamp(max(bands * (0.35 + 0.5 * uSea), wash * 0.9), 0.0, 0.95);
          if (a < 0.01) discard;
          gl_FragColor = vec4(vec3(0.94, 0.97, 1.0) * uLight, a);
          #include <fog_fragment>
        }`,
    });
    const surf = new THREE.Mesh(sg, this.surfMat);
    surf.name = "surf";
    surf.frustumCulled = false;
    surf.renderOrder = 11; // over the sea, like the wake
    this.group.add(surf);
  }

  /** Each frame: the air's colour and light, the sea's size (m), the storm (0..1). */
  update(t: number, haze: THREE.Color, light: number, hs: number, storm: number): void {
    this.landUniforms.uHaze.value.copy(haze);
    this.landUniforms.uHazeK.value = 1 - 0.75 * storm; // much closer in a blow
    if (this.surfMat) {
      const u = this.surfMat.uniforms;
      u.uTime.value = t;
      u.uLight.value = light;
      u.uSea.value = THREE.MathUtils.clamp(hs / 2.5, 0.2, 1.6);
    }
  }
}
