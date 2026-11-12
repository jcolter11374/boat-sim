// Spindrift: spray torn off the wave crests in a gale and blown downwind in low,
// flying sheets (force 8 and up, storm.ts). Puffs born at crest height round the
// camera fly with the wind for a second or two, rising a little and falling back,
// and fade. Everything moves on the graphics card (each puff's place comes from its
// seed and the time), so it costs almost nothing on the CPU.

import * as THREE from "three";

const BOX = 90; // m, the square of sea round the camera that throws spray
const LIFE = 1.8; // s, one puff's flight

const vert = /* glsl */ `
uniform float uTime, uBox, uLife, uLift, uSize, uScale;
uniform vec3 uCam;
uniform vec2 uWind;     // m/s the spray flies (x, z)
attribute vec4 aSeed;   // x, z in 0..1, the phase, the size
varying float vAlpha;
varying float vSeed;
float h1(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  float c = uTime / uLife + aSeed.z;
  float age = fract(c);
  float k = floor(c);
  // A new place on the sea for each flight, round where the camera is now.
  vec2 at = vec2(h1(k * 12.9898 + aSeed.x * 78.233), h1(k * 39.3468 + aSeed.y * 11.135)) - 0.5;
  vec2 xz = uCam.xz + at * uBox + uWind * age * uLife;
  // Thrown up off a crest, then falling back as it slows.
  float y = uLift * (0.4 + 0.6 * aSeed.w) + uLift * (1.6 * age - 1.4 * age * age);
  vec4 mv = viewMatrix * vec4(xz.x, y, xz.y, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = -mv.z;
  gl_PointSize = clamp(uSize * (0.5 + aSeed.w) * uScale / max(d, 0.5), 1.0, 64.0);
  float near = smoothstep(1.5, 6.0, d);
  float far = 1.0 - smoothstep(0.3 * uBox, 0.5 * uBox, length(xz - uCam.xz));
  vAlpha = sin(3.14159 * age) * near * far;
  vSeed = aSeed.w * 37.0 + k * 1.618;
}`;
const frag = /* glsl */ `
uniform float uAmount;
uniform vec3 uColor;
varying float vAlpha;
varying float vSeed;
float h2(vec2 q) { return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 q) {
  vec2 i = floor(q), f = fract(q);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  // A torn, flat wisp of spray, not a round disc (round soft discs read as lens bokeh):
  // squashed into a low sheet and broken up by its own noise.
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  p.y *= 2.4;
  float r = dot(p, p);
  float torn = vn(p * 2.5 + vSeed) * 0.65 + vn(p * 6.0 - vSeed) * 0.35;
  float a = uAmount * vAlpha * (1.0 - smoothstep(0.1, 1.0, r)) * smoothstep(0.35, 0.75, torn) * 0.6;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
}`;

export class Spindrift {
  readonly points: THREE.Points;
  private mat: THREE.ShaderMaterial;
  private count: number;
  amount = 0;

  constructor(puffs = 5000) {
    this.count = puffs;
    const seed = new Float32Array(puffs * 4);
    let s = 4242;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < seed.length; i++) seed[i] = rnd();
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(puffs * 3), 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 4));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        uTime: { value: 0 },
        uBox: { value: BOX },
        uLife: { value: LIFE },
        uLift: { value: 1 },
        uSize: { value: 0.35 },
        uScale: { value: 500 },
        uCam: { value: new THREE.Vector3() },
        uWind: { value: new THREE.Vector2() },
        uAmount: { value: 0 },
        uColor: { value: new THREE.Color(0xffffff) },
      },
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 15; // over the sea, under the rain
    this.points.visible = false;
  }

  /**
   * Per frame. amount 0..1 (storm.ts spindrift()); wind in m/s towards +x (east)
   * and +z (south); hs the wave height (m) the crests throw it from; light 0..1.
   */
  update(t: number, camera: THREE.PerspectiveCamera, viewHeight: number, amount: number, windX: number, windZ: number, hs: number, light: number): void {
    this.amount = amount;
    this.points.visible = amount > 0.01;
    if (!this.points.visible) return;
    const u = this.mat.uniforms;
    u.uTime.value = t;
    u.uCam.value.copy(camera.position);
    // Spray flies a little slower than the wind that carries it.
    u.uWind.value.set(windX * 0.7, windZ * 0.7);
    u.uLift.value = THREE.MathUtils.clamp(hs * 0.35, 0.5, 4);
    // Point sizes in pixels for a puff uSize metres across at 1 m.
    u.uScale.value = viewHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    u.uAmount.value = amount;
    const l = Math.min(0.2 + 1.0 * light, 1); // as bright as the foam it comes off, so it never reads as dirt
    u.uColor.value.setRGB(0.92 * l, 0.95 * l, 0.97 * l);
    this.points.geometry.setDrawRange(0, Math.ceil(this.count * (0.2 + 0.8 * amount)));
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.mat.dispose();
  }
}
