/**
 * The title's shore (Hana, 13 Nov 2026; John: "Maybe the boat is in a marina?"; Elena: "off
 * Annapolis at sunset", a thin band of roofs and trees on the horizon, softened by haze).
 *
 * The title's boat floats in Annapolis Roads, just off Greenbury Point: the town and the
 * State House dome about 3.4 km to the west, Bay Ridge 3 km to the south. Only the skyline is
 * drawn, not the land itself (the helm page's land there is about 7 MB and 40,000 objects;
 * Maya: too much for the first screen). public/title-skyline.bin holds, for each compass
 * bearing from that spot, how far off the shore is and how high the land, trees and roofs
 * stand (tools/title-skyline.py makes it from the same land files); here it becomes one
 * strip of triangles standing on the water, about 29 kB to fetch, one draw call.
 *
 * It loads after the title is up and is simply absent if the file doesn't come.
 */
import * as THREE from "three";

/** The spot (keep in step with tools/title-skyline.py), and where the sun sets there in June (compass degrees). */
export const SHORE = { lat: 38.97403, lon: -76.45254, sunsetAz: 300 };
/** The camera height the skyline was worked out for (m). */
export const SHORE_EYE = 1.5;
/** Nothing is drawn further off than this (m): inside the title's sea, which ends at 3 km. A farther shore is brought in to here at the height it appears to have. */
export const SHORE_REACH = 2600;
/** Haze: how much of the land's own colour is left at d metres. */
export const shoreClear = (d: number) => Math.exp(-d / 16000);
/**
 * The skyline is drawn half as tall again as it truly looks: 15 m of trees 2 km off is under
 * half a degree, a hairline on the title's long lens (Elena asked for a band a few percent
 * of the frame high). Distances and the shape along the horizon are true.
 */
export const SHORE_TALLER = 1.5;

export interface ShoreLight {
  /** Towards the sun (scene: x east, y up, z south). */
  sunDir: THREE.Vector3;
  /** The sun's colour and the haze's (linear). */
  sun: THREE.Color;
  haze: THREE.Color;
}

/** Land in its own shadow against the light, and land the low sun shines on (linear): woods, mostly. */
const SHADE = new THREE.Color(0.011, 0.014, 0.019);
const LIT = new THREE.Color(0.03, 0.05, 0.024);
/** How much more haze the lit side takes (Elena: in full light a bare outline read as a sandbar close by). */
const LIT_HAZE = 0.12;
/** How deep the tree crowns cut into the top edge (m, before SHORE_TALLER): a ragged tree line, not a smooth ridge. */
export const CROWN = 3;

export interface ShoreStrip {
  position: Float32Array;
  /** The colour as seen, haze and all (what the drawn texture averages to). */
  color: Float32Array;
  /** The land's own colour, before haze; the drawn texture varies it. */
  land: Float32Array;
  /** How much of the land's colour the haze leaves (0..1). */
  keep: Float32Array;
  /** Per vertex: along the shore (m, round the horizon at its distance), how sunlit (0..1), and the skyline's top there (m). */
  along: Float32Array;
  index: Uint32Array;
}

/**
 * The strip: two vertices (foot, top) for each bearing that has land, joined to the next
 * where that has land too. sunAz: the compass bearing the title's sun is drawn at; the
 * skyline is turned so that the true sunset bearing (SHORE.sunsetAz) falls on it.
 */
export function shoreStrip(data: Uint16Array, sunAz: number, light: ShoreLight): ShoreStrip {
  const n = data.length >> 1;
  const turn = SHORE.sunsetAz - sunAz;
  const sunH = new THREE.Vector2(light.sunDir.x, light.sunDir.z);
  if (sunH.lengthSq() > 1e-9) sunH.normalize();
  const position: number[] = [];
  const color: number[] = [];
  const land: number[] = [];
  const keeps: number[] = [];
  const along: number[] = [];
  const index: number[] = [];
  const c = new THREE.Color();
  const warm = new THREE.Color();
  let prev = -1; // the last bearing's foot vertex, when it had land
  for (let i = 0; i <= n; i++) {
    const k = i % n;
    const d = data[2 * k];
    const top = data[2 * k + 1] / 10;
    if (!d || (i === n && prev < 0)) {
      prev = -1;
      continue;
    }
    const b = ((k * 360) / n - turn) * (Math.PI / 180);
    const dx = Math.sin(b);
    const dz = -Math.cos(b);
    const r = Math.min(d, SHORE_REACH);
    const y = SHORE_EYE + (SHORE_TALLER * (top - SHORE_EYE) * r) / d;
    // Lit where the sun is behind the lens, in its own shadow where we look towards the sun.
    const facing = -(dx * sunH.x + dz * sunH.y);
    const lit = THREE.MathUtils.smoothstep(facing, -0.2, 0.7);
    c.copy(LIT).lerp(warm.copy(LIT).multiply(light.sun), 0.3).lerp(SHADE, 1 - lit);
    // The lit side gets more haze still: in full light a bare outline read as a sandbar close by, not a far shore (Elena).
    const clear = shoreClear(d) * (1 - LIT_HAZE * lit);
    const at = position.length / 3;
    for (const [yy, mist] of [
      [-0.8, 0.82], // a little more haze along the water
      [y, 1],
    ]) {
      position.push(dx * r, yy, dz * r);
      const keep = clear * mist;
      color.push(light.haze.r + (c.r - light.haze.r) * keep, light.haze.g + (c.g - light.haze.g) * keep, light.haze.b + (c.b - light.haze.b) * keep);
      land.push(c.r, c.g, c.b);
      keeps.push(keep);
      along.push((k * 2 * Math.PI * r) / n, lit, y);
    }
    if (prev >= 0) index.push(prev, at, prev + 1, prev + 1, at, at + 1);
    prev = at;
  }
  return {
    position: new Float32Array(position),
    color: new Float32Array(color),
    land: new Float32Array(land),
    keep: new Float32Array(keeps),
    along: new Float32Array(along),
    index: new Uint32Array(index),
  };
}

/** The skyline file as numbers; null when it isn't what we expect (a missing file can come back as a page). */
export function readSkyline(buf: ArrayBuffer): Uint16Array | null {
  if (buf.byteLength < 4 * 360 || buf.byteLength % 4 !== 0 || buf.byteLength > 4 * 36000) return null;
  const v = new DataView(buf);
  const out = new Uint16Array(buf.byteLength / 2);
  for (let i = 0; i < out.length; i++) out[i] = v.getUint16(2 * i, true);
  // Heights are tens of metres at most: anything else isn't our file.
  for (let i = 1; i < out.length; i += 2) if (out[i] > 3000) return null;
  return out;
}

/**
 * The shore as woods and roofs, not a flat cut-out (John, 13 Nov: "grey and unrealistic"). Each
 * pixel takes the land's colour varied in clumps a few metres across (crowns in light and in
 * their own shade), a little darker towards the water where the trees shade their own feet,
 * the low sun catching the crowns' tops on the lit side; then the haze for its distance. The top
 * edge is cut into crowns, so the skyline is ragged like a tree line. Linear colour in and the
 * renderer's output conversion out, like the MeshBasicMaterial it replaces.
 */
export function shoreMaterial(light: ShoreLight): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: "title-shore",
    side: THREE.DoubleSide,
    uniforms: {
      uHaze: { value: light.haze.clone() },
      uSun: { value: light.sun.clone() },
      uCrown: { value: CROWN * SHORE_TALLER },
    },
    vertexShader: /* glsl */ `
      attribute vec3 land;
      attribute float keep;
      attribute vec3 along;
      varying vec3 vLand;
      varying float vKeep;
      varying vec3 vAlong;
      varying float vY;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vLand = land;
        vKeep = keep;
        vAlong = along;
        vY = position.y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uHaze;
      uniform vec3 uSun;
      uniform float uCrown;
      varying vec3 vLand;
      varying float vKeep;
      varying vec3 vAlong;
      varying float vY;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      float h1(float x) { return fract(sin(x * 127.1) * 43758.5453); }
      float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n1(float x) { float i = floor(x); float f = fract(x); return mix(h1(i), h1(i + 1.0), f * f * (3.0 - 2.0 * f)); }
      float n2(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h2(i), h2(i + vec2(1.0, 0.0)), f.x), mix(h2(i + vec2(0.0, 1.0)), h2(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      void main() {
        #include <logdepthbuf_fragment>
        float u = vAlong.x;
        float lit = vAlong.y;
        float top = vAlong.z;
        // Crowns along the top: a few metres of shore is about a pixel on the title's lens at 2-3 km, so
        // the bumps are stands of trees 10 to 60 m across, with single tall trees among them.
        float crown = 0.5 * n1(u / 18.0) + 0.3 * n1(u / 55.0 + 7.0) + 0.2 * n1(u / 7.0 + 3.0);
        float edge = top - uCrown * (1.0 - crown);
        if (vY > edge) discard;
        // Clumps of woods, lit and shaded, and gaps where a roof or a lawn shows.
        float clump = 0.55 * n2(vec2(u / 14.0, vY / 3.0)) + 0.45 * n2(vec2(u / 45.0 + 11.0, vY / 8.0));
        vec3 c = vLand * (0.35 + 1.3 * clump);
        // Darker at their feet (their own shade); the crowns' tops catch the low sun on the lit side.
        float up = clamp(vY / max(edge, 1.0), 0.0, 1.0);
        c *= 0.7 + 0.45 * up;
        c += uSun * vLand * 2.2 * lit * smoothstep(0.7, 1.0, up) * clump;
        gl_FragColor = vec4(mix(uHaze, c, vKeep), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

export class TitleShore {
  readonly mesh: THREE.Mesh;

  private constructor(data: Uint16Array, sunAz: number, light: ShoreLight) {
    const s = shoreStrip(data, sunAz, light);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(s.position, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(s.color, 3));
    geo.setAttribute("land", new THREE.BufferAttribute(s.land, 3));
    geo.setAttribute("keep", new THREE.BufferAttribute(s.keep, 1));
    geo.setAttribute("along", new THREE.BufferAttribute(s.along, 3));
    geo.setIndex(new THREE.BufferAttribute(s.index, 1));
    // Its haze is its own (the scene's fog would hide it whole at this distance).
    this.mesh = new THREE.Mesh(geo, shoreMaterial(light));
    this.mesh.name = "title-shore";
    this.mesh.frustumCulled = false;
  }

  /** Fetch and build; null when the file isn't there or isn't right (the title is then open sea, as before). */
  static async load(sunAz: number, light: ShoreLight, url = "./title-skyline.bin"): Promise<TitleShore | null> {
    try {
      const r = await fetch(url);
      if (!r.ok || (r.headers.get("content-type") ?? "").includes("text/html")) return null;
      const data = readSkyline(await r.arrayBuffer());
      return data ? new TitleShore(data, sunAz, light) : null;
    } catch {
      return null;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
