/**
 * Putting a paint scheme (paint.ts) on a boat model. Only ever the player's own boat: the
 * models' materials are shared between every copy on the page, so the painted boat gets
 * her own copies and the others (rivals, the ghost, demo boats) keep their colours.
 */
import * as THREE from "three";
import { loadPaint } from "../myboat";
import { BUILT, PAINTED_PARTS, paintOf, repaintHull, retint, type PaintForm, type PaintScheme } from "./paint";

/** Each painted mesh's own materials, to give back (not in userData: a clone would copy them as text). */
const owns = new WeakMap<THREE.Mesh, THREE.Material[]>();

/** Painted copies, by the material they were made from and the scheme (shared by every rebuild). */
const painted = new Map<string, THREE.Material>();

function pixels(image: CanvasImageSource & { width: number; height: number }): { cv: HTMLCanvasElement; ctx: CanvasRenderingContext2D; data: ImageData } | null {
  const cv = document.createElement("canvas");
  cv.width = image.width;
  cv.height = image.height;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0);
  return { cv, ctx, data: ctx.getImageData(0, 0, cv.width, cv.height) };
}

/** A texture like `map` with its picture run through `f`; null when the page can't read pictures. */
function remap(map: THREE.Texture, f: (px: Uint8ClampedArray, w: number, h: number) => Uint8ClampedArray): THREE.Texture | null {
  if (typeof document === "undefined" || !map.image) return null;
  try {
    const p = pixels(map.image as HTMLImageElement);
    if (!p) return null;
    p.data.data.set(f(p.data.data, p.cv.width, p.cv.height));
    p.ctx.putImageData(p.data, 0, 0);
    const t = map.clone();
    // Her own picture: a clone shares its source with the original, and setting .image would repaint every boat that uses it.
    t.source = new THREE.Source(p.cv);
    t.needsUpdate = true;
    return t;
  } catch {
    return null; // a picture the page may not read: she keeps her own colours
  }
}

const maps = new Map<string, THREE.Texture | null>();
/** A hull's repainted picture alone (the Boatyard keeps its own hull material and swaps the picture). */
export function paintedHullMap(map: THREE.Texture, built: string, scheme: PaintScheme, form?: PaintForm): THREE.Texture | null {
  const key = `${map.uuid}|${built}|${scheme.id}`;
  if (!maps.has(key)) maps.set(key, BUILT[built] ? remap(map, (px, w, h) => repaintHull(px, w, h, BUILT[built], scheme, form)) : null);
  return maps.get(key) ?? null;
}

/** A copy of a material that keeps everything done to it (the shader changes for the wet band, night look and so on). */
function copyOf<M extends THREE.Material>(m: M): M {
  const c = m.clone() as M;
  c.onBeforeCompile = m.onBeforeCompile;
  c.customProgramCacheKey = m.customProgramCacheKey;
  return c;
}

/** The hull's own painted material for a scheme (made once). built: the key in paint.ts BUILT. */
export function paintedMaterial(orig: THREE.Material, built: string, scheme: PaintScheme, form?: PaintForm): THREE.Material {
  const key = `${orig.uuid}|${built}|${scheme.id}`;
  const had = painted.get(key);
  if (had) return had;
  let out: THREE.Material = orig;
  const b = BUILT[built];
  const m = orig as THREE.MeshStandardMaterial;
  if (b && m.isMeshStandardMaterial) {
    if (m.name === "hull" && m.map) {
      const map = paintedHullMap(m.map, built, scheme, form);
      if (map) {
        const c = copyOf(m);
        c.map = map;
        out = c;
      }
    } else if (m.name in PAINTED_PARTS) {
      const hex = scheme[PAINTED_PARTS[m.name]];
      const c = copyOf(m);
      if (m.map) {
        // A plain colour with shadows baked in (the kayak's dome): the same picture in the new colour.
        const map = remap(m.map, (px) => retint(px, b.top, hex));
        if (map) c.map = map;
        else c.color.setHex(hex, THREE.SRGBColorSpace);
      } else c.color.setHex(hex, THREE.SRGBColorSpace);
      out = c;
    }
  }
  painted.set(key, out);
  return out;
}

/**
 * Paint a model, or with scheme null give her back her own colours. built: which boat's
 * build this is (a BoatSpec key, or "shape_cat" and the like). Safe to call again with
 * another scheme. Returns how many parts were (re)painted.
 */
export function applyPaint(root: THREE.Object3D, built: string, scheme: PaintScheme | null, form?: PaintForm, skip?: (m: THREE.Material) => boolean): number {
  let n = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const now = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const own: THREE.Material[] = owns.get(mesh) ?? now;
    const next = own.map((m) => (skip?.(m) ? m : scheme && (m.name === "hull" || m.name in PAINTED_PARTS) ? paintedMaterial(m, built, scheme, form) : m));
    if (next.every((m, i) => m === now[i])) return;
    owns.set(mesh, own);
    mesh.material = Array.isArray(mesh.material) ? next : next[0];
    n++;
  });
  return n;
}

/** The scheme the player chose, or null for the boat's own colours. ?paint=navy shows one without saving it (review frames). */
export function myPaint(): PaintScheme | null {
  const asked = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("paint");
  return paintOf(asked ?? loadPaint());
}

/** Paint the player's own boat as they chose, or give her back her own colours. Call again when the choice changes. */
export function paintMine(model: { root: THREE.Object3D; spec: { key: string }; form: PaintForm }): void {
  applyPaint(model.root, model.spec.key, myPaint(), model.form);
}
