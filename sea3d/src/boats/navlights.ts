// Navigation lights, as the international rules for preventing collisions at sea
// (COLREGs, 1972) set them out for each kind of boat, so at night you can tell
// which way a boat is heading from the lights you see:
//
//   sidelights: red on the port (left) side, green on the starboard (right) side,
//     each shining from dead ahead to 22.5 degrees behind the beam (112.5 degrees);
//   sternlight: white, shining aft over the 135 degrees the sidelights leave;
//   all-round light: white, all the way round.
//
// Which a boat carries:
//   our kayak and Randolph's drone: powered, under 7 m and under 7 knots, so one
//     all-round white light is enough (Rule 23(d)(ii));
//   the sailing boats (cruiser, dinghy, beach cat, sail drone): a sailing boat under
//     20 m may combine its sidelights and sternlight in one lantern at the masthead,
//     a "tricolour" (Rule 25(b)); we give them that;
//   the ocean rowing boat: a rowing boat may show a sailing boat's lights (Rule
//     25(d)(ii)); it carries a tricolour on its stern light pole.
// (A sailing boat under engine shows a powered boat's lights instead; the replays
// don't say when the stock cruiser motors at night, so it shows its sailing lights.)
//
// Each light is a glowing point that keeps its size on screen, like a real light
// seen at night, and is lit only when the camera is inside its arc. Display only.

import * as THREE from "three";

export type NavLighting = "all_round" | "tricolour";

/** Night 0..1 for every boat's lights (Atmosphere.set sets it): lights are on day and night but only show in the dark. */
export const NAV_NIGHT = { value: 0 };

/** The boat's own lamp as it falls on foam near it (wake, collar, spray): world x, y, z and
 *  strength (0 by day). Shared by reference: foam materials merge FOAM_LAMP_UNIFORMS, the
 *  page that owns the lamp moves it. Unlit foam can't take a real PointLight. */
export const FOAM_LAMP_UNIFORMS = {
  uFoamLamp: { value: new THREE.Vector4(0, 0, 0, 0) },
  uFoamLampR: { value: 1.5 }, // m: the light falls to half at this distance
};
/** GLSL: foamLamp(worldPos), the lamp's extra light on foam there. */
export const FOAM_LAMP_GLSL = /* glsl */ `
uniform vec4 uFoamLamp;
uniform float uFoamLampR;
float foamLamp(vec3 w) {
  vec3 d = w - uFoamLamp.xyz;
  return uFoamLamp.w / (1.0 + dot(d, d) / (uFoamLampR * uFoamLampR));
}
`;

/** One lantern's arc, in degrees from dead ahead, clockwise (to starboard): from, to. */
export interface Arc {
  colour: number;
  from: number;
  to: number;
}

export const RED = 0xff2a1a;
export const GREEN = 0x1aff7a; // navigation green is a little blue
export const WHITE = 0xfff4dc;

/** The lanterns at one spot for a kind of lighting. */
export function arcsFor(kind: NavLighting): Arc[] {
  if (kind === "all_round") return [{ colour: WHITE, from: 0, to: 360 }];
  return [
    { colour: GREEN, from: 0, to: 112.5 },
    { colour: WHITE, from: 112.5, to: 247.5 },
    { colour: RED, from: 247.5, to: 360 },
  ];
}

/** True when a bearing off the bow (degrees, clockwise) is inside an arc; an arc may run through dead ahead (from > to). */
export function inArc(a: Pick<Arc, "from" | "to">, bearing: number): boolean {
  const b = ((bearing % 360) + 360) % 360;
  if (a.to - a.from >= 360) return true;
  return a.from < a.to ? b >= a.from && b < a.to : b >= a.from || b < a.to;
}

/** Which colour you see from a bearing off the bow (degrees, clockwise), or null for none. */
export function seenFrom(kind: NavLighting, bearing: number): number | null {
  for (const a of arcsFor(kind)) if (inArc(a, bearing)) return a.colour;
  return null;
}

/** A lantern: its arcs, and where it sits in the builder frame. */
export interface Lantern {
  arcs: Arc[];
  at: THREE.Vector3;
}

export interface LanternLook {
  /** Size on screen (a fraction of the view's height). */
  size?: number;
  /** Fades out over the last part of this distance (m), when set: a light lost in the haze. */
  range?: { value: number };
}

let glowTex: THREE.Texture | null = null;
/** A soft round glow with a bright core. */
function glow(): THREE.Texture | null {
  if (glowTex) return glowTex;
  if (typeof document === "undefined") return null; // no page (unit tests)
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.12, "rgba(255,255,255,0.9)");
  r.addColorStop(0.3, "rgba(255,255,255,0.25)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

/**
 * Put a boat's lights on its model. `group` is the builder frame (x aft from the bow,
 * y up, z to port); `at` is the lantern's place in it.
 */
export function addNavLights(group: THREE.Object3D, kind: NavLighting, at: THREE.Vector3): THREE.Group {
  return addLanterns(group, [{ arcs: arcsFor(kind), at }]);
}

const NO_RANGE = { value: 0 };

/** Lanterns anywhere on a model (builder frame), each lit only inside its arcs and only after dark. */
export function addLanterns(group: THREE.Object3D, lanterns: Lantern[], look: LanternLook = {}): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "nav_lights";
  for (const l of lanterns) {
    for (const a of l.arcs) {
      const s = new THREE.Sprite(lanternMaterial(a, look.range ?? NO_RANGE));
      s.position.copy(l.at);
      s.scale.setScalar(look.size ?? 0.034);
      s.renderOrder = 30;
      lights.add(s);
    }
  }
  group.add(lights);
  return lights;
}

function lanternMaterial(a: Arc, range: { value: number }): THREE.SpriteMaterial {
  const m = new THREE.SpriteMaterial({ map: glow(), color: a.colour, sizeAttenuation: false, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uArc = { value: new THREE.Vector2(a.from, a.to) };
    sh.uniforms.uNight = NAV_NIGHT;
    sh.uniforms.uRange = range;
    sh.vertexShader = sh.vertexShader
      .replace("void main() {", "uniform vec2 uArc;\nuniform float uRange;\nvarying float vLit;\nvoid main() {")
      .replace(
        "#include <logdepthbuf_vertex>",
        `#include <logdepthbuf_vertex>
        // Where the camera is from the lantern, against the boat's bow (builder -x)
        // and starboard (builder -z); lit inside the arc, with a degree's soft edge.
        vec3 fwd = (modelMatrix * vec4(-1.0, 0.0, 0.0, 0.0)).xyz;
        vec3 stb = (modelMatrix * vec4(0.0, 0.0, -1.0, 0.0)).xyz;
        vec3 rel = cameraPosition - modelMatrix[3].xyz;
        float b = degrees(atan(dot(rel, stb), dot(rel, fwd)));
        b = b < 0.0 ? b + 360.0 : b;
        float on = smoothstep(uArc.x - 1.0, uArc.x + 1.0, b);
        float off = 1.0 - smoothstep(uArc.y - 1.0, uArc.y + 1.0, b);
        vLit = uArc.x < uArc.y ? on * off : max(on, off); // an arc through dead ahead runs past 360
        if (uArc.y - uArc.x >= 359.0) vLit = 1.0;
        if (uRange > 0.0) vLit *= 1.0 - smoothstep(0.6 * uRange, uRange, length(rel));`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace("void main() {", "uniform float uNight;\nvarying float vLit;\nvoid main() {")
      .replace("#include <opaque_fragment>", "diffuseColor.a *= vLit * uNight;\n#include <opaque_fragment>");
  };
  m.customProgramCacheKey = () => "boatsim-navlight-v2";
  return m;
}

/** Free the lights' materials (the shared glow texture stays). */
export function disposeNavLights(lights: THREE.Object3D): void {
  lights.traverse((o) => {
    if (o instanceof THREE.Sprite) o.material.dispose();
  });
}
