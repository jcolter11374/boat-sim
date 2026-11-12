// Rain in a blow: thin streaks falling round the camera, slanted by the wind.
// Everything moves on the graphics card (each drop's place is worked out from
// the time in the vertex shader), so it costs almost nothing on the CPU.
// How hard it rains comes from the replay's logged rain (rainFromRate); older replays
// without it follow the wind (rainFromStorm). Subtle on purpose: thin, varied streaks,
// fewer and fainter in drizzle, never water on the lens.

import * as THREE from "three";

const BOX = 26; // m, the cube of rain kept round the camera
const FALL = 9; // m/s, a raindrop's falling speed

const vert = /* glsl */ `
uniform float uTime, uBox, uFall, uLen;
uniform vec4 uFadeR; // fades in from x to y m, out from z to w m
uniform float uLucky; // share of drops drawn as long bright streaks
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
  // Shorter close to the lens, so the nearest drops are flecks, not lines across the frame.
  float dh = length(p - uCam);
  float lucky = step(1.0 - uLucky, fract(aSeed.w * 13.7 + aSeed.z * 5.1)); // one drop in ~17 catches the light: a long bright streak
  p -= normalize(vel) * uLen * (1.0 + 3.0 * lucky) * clamp(dh / 7.0, 0.15, 1.0) * aEnd;
  vEnd = aEnd;
  vec3 d = p - uCam;
  // Close drops are the streaks you see; a few metres off they thin into a grey texture.
  float dl = length(d);
  vFade = smoothstep(uFadeR.x, uFadeR.y, dl) * (1.0 - smoothstep(uFadeR.z, uFadeR.w, dl)) * (1.0 - smoothstep(0.35 * uBox, 0.5 * uBox, dl));
  float b = fract(aSeed.w * 7.31 + aSeed.x * 3.7);
  vBright = (0.45 + 0.35 * b) * (1.0 - lucky) + lucky; // a fine grain of drops, a few bright streaks on top
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
  // Drizzle still shows (fine, sparse streaks); a steady 4 mm/h is the full downpour.
  return 0.75 * THREE.MathUtils.smoothstep(mmPerHour, 0.1, 4) + 0.25 * THREE.MathUtils.smoothstep(mmPerHour, 0.05, 0.6);
}

/** Fallback for replays with no rain column: how hard it rains, 0..1, for a storm level 0 (fair) .. 1 (gale). */
export function rainFromStorm(storm: number): number {
  return THREE.MathUtils.smoothstep(storm, 0.3, 0.85);
}

function dropGeometry(drops: number, seed0: number): THREE.BufferGeometry {
  const seed = new Float32Array(drops * 2 * 4);
  const end = new Float32Array(drops * 2);
  let s = seed0;
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
  return g;
}

function dropMaterial(box: number, fade: THREE.Vector4): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: {
      uTime: { value: 0 },
      uBox: { value: box },
      uFall: { value: FALL },
      uLen: { value: 0.6 },
      uFadeR: { value: fade },
      uLucky: { value: 0.06 },
      uCam: { value: new THREE.Vector3() },
      uWind: { value: new THREE.Vector2() },
      uAmount: { value: 0 },
      uColor: { value: new THREE.Color(0xc8d2dc) },
    },
    transparent: true,
    depthWrite: false,
    fog: false,
  });
}

/** The far layer: from 8 m out to ~45 m, only in heavy rain, a grey veil of fine drops. */
const FAR_BOX = 100;

export class Rain {
  /** The near drops; the far veil is its child, so adding this adds both. */
  readonly mesh: THREE.LineSegments;
  private mat: THREE.ShaderMaterial;
  private far: THREE.LineSegments;
  private farMat: THREE.ShaderMaterial;
  amount = 0;

  constructor(drops = 70000, farDrops = 60000) {
    this.mat = dropMaterial(BOX, new THREE.Vector4(1.2, 3.0, 1.5, 0.45 * BOX));
    this.mesh = new THREE.LineSegments(dropGeometry(drops, 12345), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20; // over the sea and the spray
    this.mesh.visible = false;
    this.farMat = dropMaterial(FAR_BOX, new THREE.Vector4(8, 18, 22, 46));
    this.far = new THREE.LineSegments(dropGeometry(farDrops, 777), this.farMat);
    this.far.frustumCulled = false;
    this.far.renderOrder = 19;
    this.mesh.add(this.far);
  }

  /**
   * Per frame. amount 0..1; wind in m/s towards +x (east) and +z (south) in scene
   * terms; light 0..1 dims the drops at night.
   */
  update(t: number, camera: THREE.Camera, amount: number, windX: number, windZ: number, light: number): void {
    this.amount = amount;
    this.mesh.visible = amount > 0.01;
    if (!this.mesh.visible) return;
    // Drops drift with the wind, but slower than it (they're heavy and near the sea, where it's slower).
    // In a gale they fly nearly flat; in light air they barely lean.
    const k = 0.4 + 0.3 * THREE.MathUtils.smoothstep(Math.hypot(windX, windZ), 8, 20);
    for (const m of [this.mat, this.farMat]) {
      const u = m.uniforms;
      u.uTime.value = t;
      u.uCam.value.copy(camera.position);
      u.uWind.value.set(windX * k, windZ * k);
      // A little darker than the pale storm sky, so the streaks read against it as well as against the sea.
      u.uColor.value.setRGB(0.3 + 0.32 * light, 0.33 + 0.34 * light, 0.38 + 0.36 * light);
    }
    const u = this.mat.uniforms;
    u.uAmount.value = 0.9 * Math.sqrt(amount) * (1 + 0.7 * THREE.MathUtils.smoothstep(amount, 0.6, 1)); // drizzle faint, a downpour a dense texture, never a wall
    const sheets = THREE.MathUtils.smoothstep(amount, 0.6, 1);
    u.uLen.value = 0.07 + 0.09 * amount + 0.2 * sheets; // short flecks; a downpour's drops streak into sheets
    u.uLucky.value = 0.06 + 0.24 * sheets;
    // Show only a share of the drops in light rain.
    this.mesh.geometry.setDrawRange(0, Math.ceil(this.mesh.geometry.getAttribute("aEnd").count * (0.12 + 0.38 * amount + 0.5 * THREE.MathUtils.smoothstep(amount, 0.6, 1)) / 2) * 2); // a downpour twice as dense as steady rain
    // The far veil: only in heavy rain, so a downpour greys the air out to the mist.
    const heavy = THREE.MathUtils.smoothstep(amount, 0.45, 0.95);
    this.far.visible = heavy > 0.01;
    this.farMat.uniforms.uAmount.value = 1.0 * heavy;
    this.farMat.uniforms.uLen.value = 0.8 + 0.7 * amount; // farther off, so longer to show at all
    this.far.geometry.setDrawRange(0, Math.ceil(this.far.geometry.getAttribute("aEnd").count * heavy / 2) * 2);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.far.geometry.dispose();
    this.farMat.dispose();
  }
}
