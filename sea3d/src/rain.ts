// Rain in a blow: thin streaks falling round the camera, slanted by the wind.
// Everything moves on the graphics card (each drop's place is worked out from
// the time in the vertex shader), so it costs almost nothing on the CPU.
// How hard it rains comes from the replay's logged rain (rainFromRate); older replays
// without it follow the wind (rainFromStorm). Subtle on purpose: thin, varied streaks,
// fewer and fainter in drizzle, never water on the lens.

import * as THREE from "three";

const BOX = 36; // m, the cube of rain kept round the camera
const FALL = 9; // m/s, a raindrop's falling speed

const vert = /* glsl */ `
uniform float uTime, uBox, uFall, uLen;
uniform vec3 uCam;
uniform vec2 uWind;     // m/s the drops drift sideways (x, z)
attribute vec4 aSeed;   // x, y, z in 0..1, and a speed jitter
attribute float aEnd;   // 0 = top of the streak, 1 = bottom
varying float vEnd;
varying float vFade;
varying float vBright;
void main() {
  float speed = uFall * (0.8 + 0.4 * aSeed.w);
  vec3 vel = vec3(uWind.x, -speed, uWind.y);
  // Each drop falls through the box and wraps round, so the box always surrounds the camera.
  vec3 p = aSeed.xyz * uBox + vel * uTime;
  p = mod(p - uCam + 0.5 * uBox, uBox) - 0.5 * uBox + uCam;
  // The streak: the drop's path over a short exposure.
  p -= normalize(vel) * uLen * aEnd;
  vEnd = aEnd;
  vec3 d = p - uCam;
  vFade = (1.0 - smoothstep(0.35 * uBox, 0.5 * uBox, length(d))) * smoothstep(0.6, 2.5, length(d));
  vBright = 0.35 + 0.65 * fract(aSeed.w * 7.31 + aSeed.x * 3.7); // drops catch the light unevenly
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const frag = /* glsl */ `
uniform float uAmount;
uniform vec3 uColor;
varying float vEnd;
varying float vFade;
varying float vBright;
void main() {
  // Tapered at both ends (a drop smeared over a short exposure), brightest just below the middle.
  float taper = smoothstep(0.0, 0.35, vEnd) * (1.0 - smoothstep(0.75, 1.0, vEnd));
  float a = uAmount * vFade * taper * vBright;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** How hard it rains, 0..1, from a logged rain rate in mm per hour (heavy at 4 mm/h and over). */
export function rainFromRate(mmPerHour: number): number {
  return THREE.MathUtils.smoothstep(mmPerHour, 0.1, 4);
}

/** Fallback for replays with no rain column: how hard it rains, 0..1, for a storm level 0 (fair) .. 1 (gale). */
export function rainFromStorm(storm: number): number {
  return THREE.MathUtils.smoothstep(storm, 0.3, 0.85);
}

export class Rain {
  readonly mesh: THREE.LineSegments;
  private mat: THREE.ShaderMaterial;
  amount = 0;

  constructor(drops = 9000) {
    const seed = new Float32Array(drops * 2 * 4);
    const end = new Float32Array(drops * 2);
    let s = 12345;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < drops; i++) {
      const v = [rnd(), rnd(), rnd(), rnd()];
      seed.set(v, i * 8);
      seed.set(v, i * 8 + 4);
      end[i * 2] = 0;
      end[i * 2 + 1] = 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(drops * 2 * 3), 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 4));
    g.setAttribute("aEnd", new THREE.BufferAttribute(end, 1));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        uTime: { value: 0 },
        uBox: { value: BOX },
        uFall: { value: FALL },
        uLen: { value: 0.6 },
        uCam: { value: new THREE.Vector3() },
        uWind: { value: new THREE.Vector2() },
        uAmount: { value: 0 },
        uColor: { value: new THREE.Color(0xc8d2dc) },
      },
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.LineSegments(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20; // over the sea and the spray
    this.mesh.visible = false;
  }

  /**
   * Per frame. amount 0..1; wind in m/s towards +x (east) and +z (south) in scene
   * terms; light 0..1 dims the drops at night.
   */
  update(t: number, camera: THREE.Camera, amount: number, windX: number, windZ: number, light: number): void {
    this.amount = amount;
    this.mesh.visible = amount > 0.01;
    if (!this.mesh.visible) return;
    const u = this.mat.uniforms;
    u.uTime.value = t;
    u.uCam.value.copy(camera.position);
    // Drops drift with the wind, but slower than it (they're heavy and near the sea, where it's slower).
    // In a gale they fly nearly flat; in light air they barely lean.
    const k = 0.4 + 0.3 * THREE.MathUtils.smoothstep(Math.hypot(windX, windZ), 8, 20);
    u.uWind.value.set(windX * k, windZ * k);
    u.uAmount.value = 0.75 * Math.sqrt(amount); // drizzle is faint, a downpour clear but never a wall
    u.uLen.value = 0.35 + 0.5 * amount; // heavier drops, longer streaks
    // A little darker than the pale storm sky, so the streaks read against it as well as against the sea.
    u.uColor.value.setRGB(0.3 + 0.32 * light, 0.33 + 0.34 * light, 0.38 + 0.36 * light);
    // Show only a share of the drops in light rain.
    this.mesh.geometry.setDrawRange(0, Math.ceil(this.mesh.geometry.getAttribute("aEnd").count * (0.25 + 0.75 * amount) / 2) * 2);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
