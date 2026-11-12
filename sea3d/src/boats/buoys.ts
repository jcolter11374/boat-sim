// Channel buoys and marks, as US waters (IALA region B: "red, right, returning") mark them:
//   can: a green flat-topped cylinder, left to port coming in from sea;
//   nun: a red cylinder with a cone top, left to starboard;
//   lit buoy: a steel float with an open lattice tower, a light on top and a radar reflector,
//     red or green;
//   daybeacon: a pile driven into the bottom with a green square or red triangle board.
// Each carries a white number. Sizes are typical US Coast Guard ones (a first-class can or
// nun is about 1 m across and stands about 1.3 m out of the water; a lit steel buoy about
// 2 m across with a 3.5 m tower; a daybeacon board 1.2 m). GUESS where not stated.
//
// Frame: origin at the waterline, y up, the mark's front (its number) facing +z. About half
// a metre of float below the water. Matte paint with rust streaks, and weed at the waterline,
// drawn in the shader. Each mark is one merged mesh (one draw call) plus, where it has one,
// its number on a small textured plate. Sam does the bobbing, leaning and lights.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export type BuoyKind = "can" | "nun" | "lit_red" | "lit_green" | "daybeacon_red" | "daybeacon_green";
export const BUOY_KINDS: BuoyKind[] = ["can", "nun", "lit_red", "lit_green", "daybeacon_red", "daybeacon_green"];

const RED = 0xb3362b;
const GREEN = 0x2d6e45;
const STEEL = 0x3b3f44;
const PILE = 0x5b5247;
const WHITE = 0xe9e7e0;

/** How deep each mark's float goes below the waterline (m). */
export const BUOY_DRAFT = 0.5;

/** Marks on piles driven into the bottom: they don't bob, heave or lean (Sam). */
export const BUOY_FIXED: ReadonlySet<BuoyKind> = new Set<BuoyKind>(["daybeacon_red", "daybeacon_green"]);

/** Where each kind's light sits (m above the waterline), for Sam's lantern; null for unlit marks. */
export const BUOY_LIGHT_HEIGHT: Record<BuoyKind, number | null> = {
  can: null,
  nun: null,
  lit_red: 4.25,
  lit_green: 4.25,
  daybeacon_red: null,
  daybeacon_green: null,
};

function paint(g: THREE.BufferGeometry, colour: number): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  if (!ng.attributes.normal) ng.computeVertexNormals();
  ng.deleteAttribute("uv");
  const c = new THREE.Color(colour);
  const n = ng.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
  ng.setAttribute("color", new THREE.BufferAttribute(a, 3));
  return ng;
}

const cyl = (r0: number, r1: number, y0: number, y1: number, colour: number, segs = 16) => {
  const g = new THREE.CylinderGeometry(r1, r0, y1 - y0, segs, 1);
  g.translate(0, (y0 + y1) / 2, 0);
  return paint(g, colour);
};

const bar = (a: THREE.Vector3, b: THREE.Vector3, w: number, colour: number) => {
  const len = a.distanceTo(b);
  const g = new THREE.BoxGeometry(w, len, w);
  g.translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  g.applyQuaternion(q);
  g.translate(a.x, a.y, a.z);
  return paint(g, colour);
};

/** The mark's body, in the frame above (merged, vertex-coloured). */
export function buoyGeometry(kind: BuoyKind): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const d = -BUOY_DRAFT;
  if (kind === "can") {
    parts.push(cyl(0.48, 0.5, d, 1.3, GREEN), cyl(0.5, 0.5, 1.3, 1.36, GREEN), cyl(0.12, 0.12, 1.36, 1.5, STEEL, 8)); // body, lip, lifting eye
  } else if (kind === "nun") {
    parts.push(cyl(0.48, 0.5, d, 0.95, RED), cyl(0.5, 0.1, 0.95, 1.55, RED), cyl(0.1, 0.0, 1.55, 1.6, RED), cyl(0.05, 0.05, 1.58, 1.68, STEEL, 6)); // body 60%, a blunt cone 40%
  } else if (kind === "lit_red" || kind === "lit_green") {
    const c = kind === "lit_red" ? RED : GREEN;
    parts.push(cyl(0.85, 1.0, d, 0.45, c, 20), cyl(1.0, 0.9, 0.45, 0.65, c, 20)); // the float and its deck
    parts.push(cyl(0.95, 1.0, -0.15, 0.0, 0x26292c, 20)); // fendering band at the waterline
    // The lattice tower: four legs closing in, three rings of rails, panels for the colour.
    const foot = 0.62;
    const top = 3.9;
    const legs = [
      [1, 1],
      [-1, 1],
      [-1, -1],
      [1, -1],
    ];
    for (const [x, z] of legs) parts.push(bar(new THREE.Vector3(x * foot, 0.65, z * foot), new THREE.Vector3(x * 0.22, top, z * 0.22), 0.07, c));
    for (const y of [1.4, 2.4, 3.3]) {
      const k = foot + ((0.22 - foot) * (y - 0.65)) / (top - 0.65);
      for (let i = 0; i < 4; i++) {
        const [x0, z0] = legs[i];
        const [x1, z1] = legs[(i + 1) % 4];
        parts.push(bar(new THREE.Vector3(x0 * k, y, z0 * k), new THREE.Vector3(x1 * k, y, z1 * k), 0.05, c));
      }
    }
    // Daymark panels on two faces (front and back), between the lower rings.
    for (const s of [1, -1]) {
      const g = new THREE.PlaneGeometry(0.85, 0.85);
      g.translate(0, 1.95, 0);
      if (s < 0) g.rotateY(Math.PI);
      g.translate(0, 0, s * 0.47);
      parts.push(paint(g, c));
    }
    parts.push(cyl(0.3, 0.3, top, top + 0.08, STEEL), cyl(0.11, 0.11, top + 0.08, 4.4, 0xf2efe6, 10)); // light platform, lantern
    // A radar reflector: three plates crossed (an octahedral corner reflector) on a short arm.
    const rr = new THREE.OctahedronGeometry(0.22, 0);
    rr.translate(0.35, 3.55, 0);
    parts.push(paint(rr, 0xb7bcc1));
  } else {
    const red = kind === "daybeacon_red";
    parts.push(cyl(0.18, 0.2, -1.5, 4.25, PILE, 10)); // the pile, driven into the bottom
    // The board: a square (green) or a triangle point-up (red), with a reflective border.
    let board: THREE.BufferGeometry;
    let border: THREE.BufferGeometry;
    if (red) {
      const tri = (s: number) => {
        const sh = new THREE.Shape();
        sh.moveTo(-s / 2, -s * 0.43);
        sh.lineTo(s / 2, -s * 0.43);
        sh.lineTo(0, s * 0.43);
        sh.closePath();
        return new THREE.ExtrudeGeometry(sh, { depth: 0.03, bevelEnabled: false });
      };
      board = tri(1.25);
      border = tri(1.55);
    } else {
      board = new THREE.BoxGeometry(1.1, 1.1, 0.03);
      border = new THREE.BoxGeometry(1.32, 1.32, 0.03);
    }
    board.translate(0, 4.0, 0.23);
    border.translate(0, 4.0, 0.2);
    parts.push(paint(board, red ? RED : GREEN), paint(border, WHITE));
    parts.push(bar(new THREE.Vector3(-0.4, 3.4, 0.2), new THREE.Vector3(0.4, 3.4, 0.2), 0.08, PILE)); // the board's batten
  }
  const g = mergeGeometries(parts)!;
  for (const p of parts) p.dispose();
  g.computeBoundingSphere();
  return g;
}

/** Where the number plate goes (centre, m) and its size, facing +z. */
export function numberPlace(kind: BuoyKind): { at: THREE.Vector3; w: number; h: number } {
  switch (kind) {
    // Painted big on the can and nun (nearly the body's height) so it reads at 100-200 m.
    case "can":
      return { at: new THREE.Vector3(0, 0.62, 0), w: 0.95, h: 0.95 };
    case "nun":
      return { at: new THREE.Vector3(0, 0.48, 0), w: 0.85, h: 0.85 };
    case "lit_red":
    case "lit_green":
      return { at: new THREE.Vector3(0, 1.95, 0.485), w: 0.72, h: 0.72 }; // on the daymark panel
    case "daybeacon_red":
      return { at: new THREE.Vector3(0, 3.86, 0.275), w: 0.5, h: 0.5 }; // low in the triangle, where it's widest
    default:
      return { at: new THREE.Vector3(0, 4.0, 0.275), w: 0.62, h: 0.62 };
  }
}

const NUMBER_TEX = new Map<string, THREE.Texture>();

/** A white number (as painted on the mark) on a transparent plate; needs a page (canvas). */
function numberPlate(text: string, w: number, h: number, curve = 0): THREE.Mesh | null {
  if (typeof document === "undefined") return null;
  let tex = NUMBER_TEX.get(text);
  if (!tex) {
    const c = document.createElement("canvas");
    c.width = 128;
    c.height = 128;
    const x = c.getContext("2d")!;
    x.fillStyle = "#efede6";
    x.font = "bold 92px Arial, Helvetica, sans-serif";
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.fillText(text, 64, 70);
    tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    NUMBER_TEX.set(text, tex);
  }
  // On a round body the number wraps round it (a slice of cylinder just proud of the paint).
  const geo = curve > 0 ? new THREE.CylinderGeometry(curve, curve, h, 16, 1, true, -w / curve / 2, w / curve) : new THREE.PlaneGeometry(w, h);
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.6, alphaTest: 0.2 }));
  m.name = "number";
  return m;
}

/** Matte paint with rust streaks running down, and weed and slime at the waterline. */
function buoyMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05, envMapIntensity: 0.5 });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace("void main() {", "varying vec3 vBuoy;\nvoid main() {\n  vBuoy = position;");
    sh.fragmentShader = sh.fragmentShader
      .replace(
        "void main() {",
        `varying vec3 vBuoy;
float bHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float bNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(bHash(i), bHash(i + vec2(1, 0)), u.x), mix(bHash(i + vec2(0, 1)), bHash(i + vec2(1, 1)), u.x), u.y);
}
void main() {`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
  {
    float a = atan(vBuoy.z, vBuoy.x) * 3.0 + vBuoy.x * 4.0;
    float streak = smoothstep(0.62, 0.95, bNoise(vec2(a * 2.0, vBuoy.y * 0.6)) * 0.7 + bNoise(vec2(a * 6.0, vBuoy.y * 1.5)) * 0.3);
    diffuseColor.rgb = mix(diffuseColor.rgb * (0.9 + 0.15 * bNoise(vBuoy.xy * 6.0 + vBuoy.z * 3.0)), vec3(0.22, 0.09, 0.04), streak * 0.45);
    // Weed and slime from just under the water to a hand's width above it, ragged at the top.
    float top = 0.12 + 0.1 * bNoise(vec2(a * 3.0, 1.7));
    float weed = 1.0 - smoothstep(top - 0.06, top, vBuoy.y);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.1, 0.13, 0.07) * (0.8 + 0.4 * bNoise(vec2(a * 9.0, vBuoy.y * 20.0))), weed * 0.85);
  }`,
      );
  };
  m.customProgramCacheKey = () => "boatsim-buoy-v1";
  return m;
}

let material: THREE.MeshStandardMaterial | null = null;
const geos = new Map<BuoyKind, THREE.BufferGeometry>();

/** A mark, ready to place: its body ("body") and its number ("number", when there's a page to draw it). */
export function makeBuoy(kind: BuoyKind, number: string): THREE.Group {
  let g = geos.get(kind);
  if (!g) {
    g = buoyGeometry(kind);
    geos.set(kind, g);
  }
  material ??= buoyMaterial();
  const o = new THREE.Group();
  o.name = `buoy_${kind}`;
  const body = new THREE.Mesh(g, material);
  body.name = "body";
  o.add(body);
  const p = numberPlace(kind);
  const plate = numberPlate(number, p.w, p.h, kind === "can" || kind === "nun" ? 0.508 : 0);
  if (plate) {
    plate.position.copy(p.at);
    o.add(plate);
    if (kind === "can" || kind === "nun" || kind.startsWith("lit")) {
      // The same number on the back, so it reads from either side of the channel.
      const back = plate.clone();
      back.position.set(p.at.x, p.at.y, -p.at.z);  // (z = 0 for the round ones: the turn does it)
      back.rotation.y = Math.PI;
      o.add(back);
    }
  }
  return o;
}
