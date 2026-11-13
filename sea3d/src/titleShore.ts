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
export const shoreClear = (d: number) => Math.exp(-d / 9000);
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

/** Land in its own shadow against the light, and land the low sun shines on (linear). */
const SHADE = new THREE.Color(0.012, 0.014, 0.02);
const LIT = new THREE.Color(0.045, 0.05, 0.045);

/**
 * The strip: two vertices (foot, top) for each bearing that has land, joined to the next
 * where that has land too. sunAz: the compass bearing the title's sun is drawn at; the
 * skyline is turned so that the true sunset bearing (SHORE.sunsetAz) falls on it.
 */
export function shoreStrip(data: Uint16Array, sunAz: number, light: ShoreLight): { position: Float32Array; color: Float32Array; index: Uint32Array } {
  const n = data.length >> 1;
  const turn = SHORE.sunsetAz - sunAz;
  const sunH = new THREE.Vector2(light.sunDir.x, light.sunDir.z);
  if (sunH.lengthSq() > 1e-9) sunH.normalize();
  const position: number[] = [];
  const color: number[] = [];
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
    const clear = shoreClear(d) * (1 - 0.45 * lit);
    const at = position.length / 3;
    for (const [yy, mist] of [
      [-0.8, 0.82], // a little more haze along the water
      [y, 1],
    ]) {
      position.push(dx * r, yy, dz * r);
      const keep = clear * mist;
      color.push(light.haze.r + (c.r - light.haze.r) * keep, light.haze.g + (c.g - light.haze.g) * keep, light.haze.b + (c.b - light.haze.b) * keep);
    }
    if (prev >= 0) index.push(prev, at, prev + 1, prev + 1, at, at + 1);
    prev = at;
  }
  return { position: new Float32Array(position), color: new Float32Array(color), index: new Uint32Array(index) };
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

export class TitleShore {
  readonly mesh: THREE.Mesh;

  private constructor(data: Uint16Array, sunAz: number, light: ShoreLight) {
    const s = shoreStrip(data, sunAz, light);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(s.position, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(s.color, 3));
    geo.setIndex(new THREE.BufferAttribute(s.index, 1));
    // Its haze is in its colours (the scene's fog would hide it whole at this distance).
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide }));
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
