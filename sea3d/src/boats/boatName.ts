// The kayak's name on her stern quarters (Yuki, Lighting & Materials; Elena, 12 Nov 2026).
// Real small boats carry their name aft, where a boat alongside reads it. Ours shows
// the player's own name for her (myboat.ts, set in the Boatyard). Unnamed, the quarter
// stays clean: no default or generic label (Elena, 12 Nov).
// Dark navy letters in the Bluewater name face (NAME_TYPES), capitals 8.5 cm tall, laid on the hull as a
// decal so they follow its curve, with the same gloss as the gelcoat under them.
// Display only: no effect on the simulation.

import * as THREE from "three";
import { DecalGeometry } from "three/examples/jsm/geometries/DecalGeometry.js";
import { loadMyBoat, type MyBoat } from "../myboat";

/** Where the name sits, in the kayak builder frame (x aft from the bow, y up from the hull bottom). */
export const NAME_AT = { x: 2.42, y: 0.235 };
/** Letter height and the most the name may stretch along the hull (m). */
export const NAME_H = 0.085;
export const NAME_MAX_W = 0.62;
const NAVY = "#17243b";
/** Generic names the pages save on their own: not a name, so the hull stays clean. */
const GENERIC = new Set(["our kayak", "my kayak", "kayak"]);

/** The name to paint: the player's own for our kayak, else "" (nothing painted). */
export function hullName(mine: MyBoat | null): string {
  if (!mine || mine.kind !== "yard" || mine.base !== "kayak") return "";
  const n = mine.name.replace(/\s+/g, " ").trim().slice(0, 20); // the Boatyard caps names at 20 (Ines)
  return !n || GENERIC.has(n.toLowerCase()) ? "" : n;
}

/** The lettering face (SIL OFL, subset woff2 in public/fonts): a sign-writer's brush script,
 *  Yesteryear (Elena's pick, 12 Nov), drawn a touch heavier so it reads at chase distance. */
export const NAME_TYPES = {
  script: { family: "Bluewater Name Script", url: "./fonts/bw-name-script.woff2" },
} as const;
export type NameType = keyof typeof NAME_TYPES;
/** The face in use (until Elena picks with the wordmark). */
export let nameType: NameType = "script";
export function setNameType(t: NameType): void {
  nameType = t;
}
const loaded = new Map<NameType, Promise<boolean>>();
function loadType(t: NameType): Promise<boolean> {
  let p = loaded.get(t);
  if (!p) {
    const { family, url } = NAME_TYPES[t];
    p =
      typeof FontFace === "undefined" || typeof document === "undefined"
        ? Promise.resolve(false)
        : new FontFace(family, `url(${new URL(url, location.href).href})`)
            .load()
            .then((f) => ((document.fonts as unknown as { add(f: FontFace): void }).add(f), true))
            .catch(() => false);
    loaded.set(t, p);
  }
  return p;
}

/** Scale for a name `textW` long and `capH` tall (any units): 1, or less so a long name fits NAME_MAX_W. */
export function nameScale(textW: number, capH: number): number {
  const w = (textW / capH) * NAME_H;
  return Math.min(1, NAME_MAX_W / w);
}

const PX = 96; // font size on the canvas
const CH = 192; // canvas height: room for a script's swashes above and below
function nameCanvas(text: string, t: NameType): { tex: THREE.CanvasTexture; em: number; textW: number; capH: number } | null {
  if (typeof document === "undefined") return null;
  const font = `${PX}px "${NAME_TYPES[t].family}"`;
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.font = font;
  const m = ctx.measureText(text);
  const capH = ctx.measureText("H").actualBoundingBoxAscent || PX * 0.7;
  const tw = Math.ceil(m.actualBoundingBoxLeft + m.actualBoundingBoxRight + PX * 0.04) || Math.ceil(m.width);
  c.width = THREE.MathUtils.ceilPowerOfTwo(tw + 48);
  c.height = CH;
  const ctx2 = c.getContext("2d")!;
  ctx2.font = font;
  ctx2.fillStyle = NAVY;
  ctx2.textBaseline = "alphabetic";
  ctx2.textAlign = "center";
  ctx2.fillText(text, c.width / 2, CH / 2 + capH / 2);
  // A slight stroke in the same navy: a heavier hand, so the brush letters hold up small.
  ctx2.strokeStyle = NAVY;
  ctx2.lineJoin = "round";
  ctx2.lineWidth = PX * 0.04;
  ctx2.strokeText(text, c.width / 2, CH / 2 + capH / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { tex, em: c.width / c.height, textW: tw, capH };
}

const ray = new THREE.Raycaster();
const helper = new THREE.Object3D();

/**
 * Paint the name on both stern quarters of the hull mesh named "hull" under `inner`
 * (the kayak's builder-frame group), once the face has loaded. Resolves to the decal
 * meshes (none unnamed, or without a page). Replaces any name already painted.
 */
export async function paintBoatName(inner: THREE.Object3D, text = hullName(loadMyBoat()), t: NameType = nameType): Promise<THREE.Mesh[]> {
  for (const old of inner.children.filter((o) => o.name === "boat_name")) {
    old.removeFromParent();
    (old as THREE.Mesh).geometry.dispose();
  }
  if (!text || !(await loadType(t))) return [];
  // glTF splits a multi-material mesh into a group of meshes under the node's name.
  const node = inner.getObjectByName("hull");
  const hulls: THREE.Mesh[] = [];
  node?.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) hulls.push(o as THREE.Mesh);
  });
  const made = nameCanvas(text, t);
  if (!hulls.length || !made) return [];
  inner.updateMatrixWorld(true);
  const toInner = inner.matrixWorld.clone().invert();
  const hc = (NAME_H / made.capH) * CH * nameScale(made.textW, made.capH); // the canvas's height on the hull (m)
  const size = new THREE.Vector3(made.em * hc, hc, 0.12);
  const mat = new THREE.MeshPhysicalMaterial({
    map: made.tex,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    roughness: 0.3,
    clearcoat: 0.5,
    clearcoatRoughness: 0.12,
  });
  const out: THREE.Mesh[] = [];
  for (const side of [1, -1]) {
    // Find the hull side from outside, square to it.
    const from = new THREE.Vector3(NAME_AT.x, NAME_AT.y, side * 1.5).applyMatrix4(inner.matrixWorld);
    const dir = new THREE.Vector3(0, 0, -side).transformDirection(inner.matrixWorld);
    ray.set(from, dir);
    const hit = ray.intersectObjects(hulls, false)[0];
    if (!hit?.face) continue;
    const hull = hit.object as THREE.Mesh;
    const n = hit.face.normal.clone().transformDirection(hull.matrixWorld);
    n.y = 0; // keep the lettering level
    n.normalize();
    helper.position.copy(hit.point);
    helper.up.set(0, 1, 0).transformDirection(inner.matrixWorld);
    helper.lookAt(hit.point.clone().add(n));
    const geo = new DecalGeometry(hull, hit.point, helper.rotation.clone(), size);
    geo.applyMatrix4(toInner);
    const m = new THREE.Mesh(geo, mat);
    m.name = "boat_name";
    m.renderOrder = 1;
    inner.add(m);
    out.push(m);
  }
  return out;
}
