// Low cloud overhead and fog banks on the water.
//
// Cloud: a broken layer about 600 m up, drifting with the wind. How much of the
// sky it covers comes from the log: the replay has the sunlight reaching the sea
// (ghi), so comparing it with what a clear sky would give at that sun height says
// how cloudy it was (cloudFromSun). At night that can't be read, so the last
// daytime value holds, and a blow always brings cloud.
//
// Fog: the log has no visibility column, so fog is cosmetic. It follows the
// conditions that make sea fog in spring: light wind over the cold water north of
// about 39N (Gulf Stream's north wall, Grand Banks), on some days and not others
// (fogChance). Thin fog shows as banks sitting on the horizon; thick fog closes in.

import * as THREE from "three";

const SM = THREE.MathUtils.smoothstep;

/** Sunlight a clear sky gives at the sea surface, W/m², for a sun elevation in degrees (Haurwitz). */
export function clearSkyGhi(elDeg: number): number {
  const s = Math.sin(THREE.MathUtils.degToRad(elDeg));
  return s <= 0 ? 0 : 1098 * s * Math.exp(-0.057 / s);
}

/**
 * Cloud cover 0..1 from the logged sunlight and the sun's height, or null when
 * the sun is too low to tell (night, dawn and dusk).
 */
export function cloudFromSun(ghi: number | null, elDeg: number): number | null {
  if (ghi == null || !Number.isFinite(ghi) || elDeg < 8) return null;
  const clear = clearSkyGhi(elDeg);
  const k = THREE.MathUtils.clamp(ghi / clear, 0, 1.2); // clearness: 1 clear, ~0.3 overcast
  return THREE.MathUtils.clamp((1 - k) / 0.7, 0, 1);
}

/** A steady pseudo-random 0..1 per whole number (so a given voyage day is always foggy or always not). */
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Fog 0 (clear) .. 1 (thick) for a place, the wind speed in knots and the voyage
 * day. Cosmetic: the log has no visibility.
 */
export function fogChance(lat: number, lon: number, windKt: number, day: number): number {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 0;
  // Cold water: north of the Gulf Stream, and west of the mid-Atlantic where it is warmer.
  const cold = SM(lat, 37.5, 41) * (1 - SM(lon, -45, -35));
  const calm = 1 - SM(windKt, 8, 18);
  // Some days foggy, some not; blend across the day so it comes and goes rather than switching.
  const d = Math.floor(day);
  const f = day - d;
  const odds = (n: number) => SM(hash(n), 0.45, 0.8);
  const today = THREE.MathUtils.lerp(odds(d), odds(d + 1), SM(f, 0.7, 1));
  return THREE.MathUtils.clamp(cold * calm * today, 0, 1);
}

const noise = /* glsl */ `
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int k = 0; k < 5; k++) { v += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return v;
}`;

const ROSE = new THREE.Color(0.75, 0.38, 0.45); // cloud undersides after the sun has set
const CLOUD_Y = 600; // m, the cloud base
const CLOUD_R = 9000; // m, how far the layer reaches (it fades out well before)

const cloudVert = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
// The layer is drawn as fair-weather cumulus: rounded heaps with knobbly,
// cauliflower edges (a warped noise field for the heaps, a "billow" noise for
// the knobs). Each point looks a little way towards the sun: if there is more
// cloud that way, it is in its own shade. Overhead you see the grey, flat
// bases with bright thin edges; towards the horizon you see their sunlit
// sides, white with the sun behind you and dark with silver edges against it.
// Round sunset they glow orange underneath, then rose, then fade.
const cloudFrag = /* glsl */ `
uniform float uCover, uDark, uWarm;
uniform vec2 uDrift;
uniform vec3 uCam, uSunDir, uLit, uShade, uHaze, uGlow;
varying vec3 vWorld;
${noise}
float billow(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int k = 0; k < 4; k++) { v += a * abs(vnoise(p) * 2.0 - 1.0); p = p * 2.07 + vec2(5.3, 11.9); a *= 0.5; }
  return v;
}
float dens(vec2 p) {
  vec2 w = p + 0.45 * vec2(vnoise(p * 0.8 + 3.1), vnoise(p * 0.8 + 8.3));
  return 0.9 * fbm(w) + 0.26 * (1.0 - billow(w * 3.0 + 1.7)) - 0.15;
}
void main() {
  vec2 p = (vWorld.xz + uDrift) / 900.0;
  float n = dens(p);
  float edge = 1.0 - uCover;
  float d = smoothstep(edge - 0.015, edge + 0.07, n);
  if (d < 0.004) discard;
  float thick = smoothstep(edge, edge + 0.3, n);
  // Self-shade: more cloud towards the sun means this bit is in shadow.
  vec2 sunH = uSunDir.xz / max(length(uSunDir.xz), 1e-3);
  float toward = dens(p + sunH * 0.09) - n;
  float shade = clamp(0.55 * thick + 2.6 * toward, 0.0, 1.0);
  vec3 view = normalize(vWorld - uCam);
  float dist = length(vWorld.xz - uCam.xz);
  float side = smoothstep(700.0, 3500.0, dist);           // far off you see the sides, not the base
  float facing = dot(view, uSunDir);                        // +1 looking at the sun
  float baseShade = mix(0.35 + 0.65 * shade, shade * (0.4 + 0.6 * smoothstep(-0.3, 0.6, facing)), side);
  vec3 col = mix(uLit, uShade, clamp(baseShade, 0.0, 1.0) * (0.8 + 0.2 * uDark));
  // Silver lining: thin edges light up looking towards the sun.
  float rim = pow(max(facing, 0.0), 5.0) * (1.0 - thick);
  col += uLit * rim * 0.9;
  // Sunset: the undersides catch the low sun, strongest on the sun's side.
  col += uGlow * uWarm * (0.35 + 0.65 * smoothstep(-0.5, 0.8, facing)) * (1.0 - 0.45 * thick);
  float far = smoothstep(2500.0, 8000.0, dist);
  col = mix(col, uHaze, far);
  float a = d * (1.0 - smoothstep(5000.0, 8500.0, dist)) * 0.96;
  gl_FragColor = vec4(col, a);
}`;

const BANK_H = 70; // m, how tall a fog bank stands
const bankVert = /* glsl */ `
varying vec3 vWorld;
varying float vH;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vH = uv.y;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const bankFrag = /* glsl */ `
uniform float uFog, uTime, uSeed;
uniform vec3 uCam, uColor;
varying vec3 vWorld;
varying float vH;
${noise}
void main() {
  vec2 d = vWorld.xz - uCam.xz;
  float ang = atan(d.y, d.x);
  // Banks: some bearings have fog, others are clear; their tops billow.
  vec2 p = vec2(ang * 3.0 + uSeed, uTime * 0.01);
  float patchy = fbm(p);
  float bank = smoothstep(0.62 - 0.35 * uFog, 0.8 - 0.25 * uFog, patchy);
  float top = 0.55 + 0.45 * fbm(vec2(ang * 22.0 + uSeed, vH * 2.0 + uTime * 0.03));
  float a = bank * (1.0 - smoothstep(0.15 * top, top, vH)) * smoothstep(0.0, 0.04, vH) * uFog;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a * 0.9);
}`;

export class Clouds {
  readonly group = new THREE.Group();
  /** What's shown now: cloud cover and fog, both 0..1. */
  cover = 0;
  fog = 0;
  private dayCover = 0.3; // last daytime reading, held through the night
  private layer: THREE.Mesh<THREE.CircleGeometry, THREE.ShaderMaterial>;
  private banks: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>[] = [];
  private drift = new THREE.Vector2();
  private snapped = false;

  constructor() {
    const layer = new THREE.ShaderMaterial({
      vertexShader: cloudVert,
      fragmentShader: cloudFrag,
      uniforms: {
        uCover: { value: 0 },
        uDark: { value: 0 },
        uDrift: { value: new THREE.Vector2() },
        uCam: { value: new THREE.Vector3() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uLit: { value: new THREE.Color() },
        uWarm: { value: 0 },
        uGlow: { value: new THREE.Color(1.0, 0.55, 0.3) },
        uShade: { value: new THREE.Color() },
        uHaze: { value: new THREE.Color() },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.layer = new THREE.Mesh(new THREE.CircleGeometry(CLOUD_R, 48).rotateX(Math.PI / 2), layer);
    this.layer.renderOrder = 1; // over the sky and its grey lid, under the sea
    this.layer.frustumCulled = false;
    this.group.add(this.layer);
    // Two rings of banks at different distances, so they overlap with depth.
    for (const [r, seed] of [
      [420, 0],
      [900, 7.3],
    ]) {
      const m = new THREE.ShaderMaterial({
        vertexShader: bankVert,
        fragmentShader: bankFrag,
        uniforms: {
          uFog: { value: 0 },
          uTime: { value: 0 },
          uSeed: { value: seed },
          uCam: { value: new THREE.Vector3() },
          uColor: { value: new THREE.Color() },
        },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(r, r, BANK_H, 96, 1, true).translate(0, BANK_H / 2 - 2, 0), m);
      ring.renderOrder = 11; // over the sea
      ring.frustumCulled = false;
      ring.visible = false;
      this.banks.push(ring);
      this.group.add(ring);
    }
  }

  /**
   * Per frame. cover: the logged cloud reading (cloudFromSun) or null when it
   * can't be read; storm 0..1; fog 0..1 (fogChance); wind in m/s (scene x, z);
   * sunDir and haze from the atmosphere; light 0..1.
   */
  update(
    t: number,
    dt: number,
    camera: THREE.Camera,
    cover: number | null,
    storm: number,
    fog: number,
    windX: number,
    windZ: number,
    sunDir: THREE.Vector3,
    haze: THREE.Color,
    light: number,
  ): void {
    if (cover != null) this.dayCover = cover;
    const want = Math.max(this.dayCover, SM(storm, 0.1, 0.7));
    const k = this.snapped ? 1 : Math.min(1, dt * 0.8);
    this.snapped = false;
    this.cover += (want - this.cover) * k;
    this.fog += (fog - this.fog) * k;

    // Cloud drifts with the wind up there (stronger than at the sea).
    this.drift.x -= windX * 1.6 * dt;
    this.drift.y -= windZ * 1.6 * dt;
    const cam = camera.position;
    this.layer.position.set(cam.x, CLOUD_Y, cam.z);
    const u = this.layer.material.uniforms;
    // Above ~0.92 the sky's own grey lid already does the job; the layer adds the broken edges.
    // Even a "clear" reading keeps a few small fair-weather cumulus (they hardly dim the sun):
    // looks only.
    u.uCover.value = 0.42 + 0.5 * this.cover;
    u.uDark.value = storm;
    u.uDrift.value.copy(this.drift);
    u.uCam.value.copy(cam);
    u.uSunDir.value.copy(sunDir);
    const lit = 0.25 + 0.75 * light;
    u.uLit.value.setRGB(lit, lit, lit * 1.02);
    u.uShade.value.copy(haze).multiplyScalar(0.42 + 0.2 * light);
    u.uHaze.value.copy(haze);
    // Sun's height from its direction: glow from just before sunset until it is well down.
    const el = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(sunDir.y, -1, 1)));
    u.uWarm.value = SM(el, -7, -1) * (1 - SM(el, 3, 16)) * (1 - storm);
    // Orange while the sun is up, rose after it has gone.
    u.uGlow.value.setRGB(1.0, 0.5, 0.25).lerp(ROSE, 1 - SM(el, -3, 1)).multiplyScalar(0.9);
    this.layer.visible = true; // always a few fair-weather clouds, at least

    for (const b of this.banks) {
      b.visible = this.fog > 0.02;
      b.position.set(cam.x, 0, cam.z);
      const bu = b.material.uniforms;
      bu.uFog.value = this.fog;
      bu.uTime.value = t;
      bu.uCam.value.copy(cam);
      bu.uColor.value.copy(haze).lerp(new THREE.Color(1, 1, 1), 0.25 * light).multiplyScalar(0.85 + 0.15 * light);
    }
  }

  /** Jump straight to the weather at the next update (after a seek), rather than easing into it. */
  snap(): void {
    this.snapped = true;
  }

  /** Thick fog closes the haze right in; call after the atmosphere has set its own. */
  closeIn(fog: THREE.Fog): void {
    const thick = SM(this.fog, 0.55, 1);
    fog.near = THREE.MathUtils.lerp(fog.near, 15, thick);
    fog.far = THREE.MathUtils.lerp(fog.far, 380, thick);
  }

  dispose(): void {
    this.layer.geometry.dispose();
    this.layer.material.dispose();
    for (const b of this.banks) {
      b.geometry.dispose();
      b.material.dispose();
    }
  }
}
