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

/** Which colour you see from a bearing off the bow (degrees, clockwise), or null for none. */
export function seenFrom(kind: NavLighting, bearing: number): number | null {
  const b = ((bearing % 360) + 360) % 360;
  for (const a of arcsFor(kind)) if (b >= a.from && b < a.to) return a.colour;
  return null;
}

let glowTex: THREE.Texture | null = null;
/** A soft round glow with a bright core. */
function glow(): THREE.Texture {
  if (glowTex) return glowTex;
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
  const lights = new THREE.Group();
  lights.name = "nav_lights";
  lights.position.copy(at);
  for (const a of arcsFor(kind)) {
    const m = new THREE.SpriteMaterial({ map: glow(), color: a.colour, sizeAttenuation: false, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uArc = { value: new THREE.Vector2(a.from, a.to) };
      sh.uniforms.uNight = NAV_NIGHT;
      sh.vertexShader = sh.vertexShader
        .replace("void main() {", "uniform vec2 uArc;\nvarying float vLit;\nvoid main() {")
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
          vLit = smoothstep(uArc.x - 1.0, uArc.x + 1.0, b) * (1.0 - smoothstep(uArc.y - 1.0, uArc.y + 1.0, b));
          if (uArc.y - uArc.x >= 359.0) vLit = 1.0;`,
        );
      sh.fragmentShader = sh.fragmentShader
        .replace("void main() {", "uniform float uNight;\nvarying float vLit;\nvoid main() {")
        .replace("#include <opaque_fragment>", "diffuseColor.a *= vLit * uNight;\n#include <opaque_fragment>");
    };
    m.customProgramCacheKey = () => "boatsim-navlight-v1";
    const s = new THREE.Sprite(m);
    s.scale.setScalar(0.034);
    s.renderOrder = 30;
    lights.add(s);
  }
  group.add(lights);
  return lights;
}

/** Free the lights' materials (the shared glow texture stays). */
export function disposeNavLights(lights: THREE.Object3D): void {
  lights.traverse((o) => {
    if (o instanceof THREE.Sprite) o.material.dispose();
  });
}
