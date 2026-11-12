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
const DOME_R = 9000; // m, the sphere the sky's cloud is painted on (inside the camera's far plane)
/** Quality steps: Low draws one cheaper layer, High the deck and scud with shading, Ultra adds detail. */
export type CloudQuality = "low" | "high" | "ultra";

const cloudVert = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
// The sky's cloud, painted on a dome round the camera. Each pixel follows its view ray up
// to three heights, so the cloud has real perspective all the way down to the horizon
// (the old flat sheet at 600 m stopped short of it, leaving a bare band, and its noise
// stretched into swirls at low angles). Detail fades with distance into the haze, and the
// last few degrees above the horizon are the haze itself, the same colour as the sea's
// far fade (the scene fog), so sky and sea meet without a line.
//
//  - Cumulus (fair weather), 1200 m: rounded heaps, lit on the side facing the sun (a
//    surface direction from the heap's own shape), grey flat bases, silver edges against
//    the sun, orange then rose at sunset.
//  - Deck (overcast and storm), 1600 m: broad soft lumps, darker where thick; where it
//    thins near the sun the light comes through as a brighter, warmer patch.
//  - Scud (a blow), 350 m: ragged low cloud torn into streaks along the wind, moving fast.
//  - Rain: grey curtains hanging from the deck in the distance, where it is raining.
//
// Driven by the voyage: cover (from the logged sunlight), storm (wind), rain (logged mm/h),
// wind (drift and the scud's direction). uQ: 0 Low, 1 High, 2 Ultra.
const cloudFrag = /* glsl */ `
uniform float uCover, uStorm, uRain, uWarm, uQ, uTime, uLight;
uniform vec2 uDrift, uScud, uWind;
uniform vec3 uCam, uSunDir, uLit, uShade, uHaze, uGlow;
varying vec3 vWorld;
${noise}
// fbm whose finer octaves fade out as the ground they cover grows (lod 0 sharp .. 1 soft):
// that is what stops distant cloud turning to swirls and shimmer.
float fbmL(vec2 p, float lod, int oct) {
  float v = 0.0, a = 0.5, w = 0.0;
  for (int k = 0; k < 6; k++) {
    if (k >= oct) break;
    float keep = 1.0 - smoothstep(float(k) - 1.5, float(k) - 0.5, lod * 5.0);
    v += a * keep * vnoise(p); w += a * keep;
    p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5;
  }
  return v / max(w, 1e-3);
}
vec2 onLayer(vec3 dir, float h) { return uCam.xz + dir.xz * (h - uCam.y) / max(dir.y, 0.02); }
// How blurred a layer is here, 0 sharp .. 1 gone to its average: a pixel near the horizon
// covers a long strip of cloud (distance, and foreshortening at a grazing angle), so its
// detail is filtered away instead of aliasing into swirls. scale: the layer's feature size.
float footprint(float dist, float el, float scale) {
  float px = dist * 0.0012 / max(el, 0.01); // ~ metres of cloud along the view per pixel
  return smoothstep(0.08, 0.8, px / scale);
}
void main() {
  vec3 dir = normalize(vWorld - uCam);
  if (dir.y < -0.02) discard;
  float el = max(dir.y, 0.0);
  int oct = uQ < 0.5 ? 3 : uQ < 1.5 ? 5 : 6;
  float facing = dot(dir, uSunDir);
  float sunUp = smoothstep(-0.06, 0.12, uSunDir.y);
  vec3 col = vec3(0.0);
  float rainC = 0.0; // how much a rain curtain hides here (drawn after the horizon haze)
  float alpha = 0.0;
  // Composite front to back: scud (nearest), then cumulus, then the deck.
  // ---- scud ----
  float scudAmt = smoothstep(0.35, 0.9, uStorm) * (0.6 + 0.4 * smoothstep(0.5, 4.0, uRain));
  if (scudAmt > 0.01) {
    vec2 q = onLayer(dir, 350.0);
    float dist = length(q - uCam.xz);
    float lod = footprint(dist, el, 900.0);
    vec2 wd = length(uWind) > 0.1 ? normalize(uWind) : vec2(1.0, 0.0);
    // Wind-aligned coordinates, stretched along the wind: torn streaks, not blobs.
    vec2 r = vec2(dot(q + uScud, wd), dot(q + uScud, vec2(-wd.y, wd.x)));
    float n = fbmL(r / vec2(4200.0, 1300.0), lod, oct);
    if (uQ > 0.5) n += 0.3 * (fbmL(r / vec2(900.0, 260.0) + 4.7, min(1.0, lod * 1.8), oct) - 0.5) * (1.0 - lod);
    n = mix(n, 0.5, lod);
    // Soft, wide edges: scud is wet vapour, not cut-out shapes.
    float d = smoothstep(0.5 - 0.12 * scudAmt, 0.88, n) * scudAmt * 0.6;
    // Ragged scud: paler grey wisps against the dark deck, a touch darker in their cores.
    vec3 c = uHaze * mix(0.68, 0.84, smoothstep(0.85, 0.55, n)) * (0.85 + 0.15 * uLight);
    c = mix(c, uHaze, smoothstep(1500.0, 9000.0, dist));
    col += (1.0 - alpha) * d * c; alpha += (1.0 - alpha) * d;
  }
  // ---- cumulus ----
  // Under a closing deck the heaps lose their sun and merge into it.
  // Overcast, a blow, or steady rain (rain falls from a deck, whatever the sunlight said) close the sky.
  float deckAmt = max(max(smoothstep(0.55, 0.95, uCover), smoothstep(0.15, 0.7, uStorm)), smoothstep(0.05, 0.8, uRain));
  float cuAmt = (1.0 - smoothstep(0.55, 0.95, max(uStorm, uCover))) * (1.0 - deckAmt);
  if (cuAmt > 0.01 && alpha < 0.99) {
    vec2 q = onLayer(dir, 1200.0) + uDrift;
    float dist = length(q - uDrift - uCam.xz);
    float lod = footprint(dist, el, 700.0);
    vec2 p = q / 1800.0;
    vec2 w = p + 0.45 * vec2(vnoise(p * 0.8 + 3.1), vnoise(p * 0.8 + 8.3));
    float n = mix(fbmL(w, lod, oct), 0.45, lod);
    float edge = 1.0 - (0.42 + 0.5 * uCover);
    float d = smoothstep(edge - 0.01, edge + 0.08 + 0.4 * lod, n);
    // Far heaps thin out into the clear sky's own horizon (not into the fog colour, which is darker).
    d *= 1.0 - smoothstep(9000.0, 30000.0, dist);
    if (d > 0.003) {
      float thick = smoothstep(edge, edge + 0.28, n);
      // The heap's surface direction from its own shape: up its slope towards the middle.
      float shade = 0.5;
      if (uQ > 0.5) {
        vec2 sunH = uSunDir.xz / max(length(uSunDir.xz), 1e-3);
        float toward = fbmL(w + sunH * 0.08, lod, oct) - n;
        shade = clamp(0.5 * thick + 2.4 * toward, 0.0, 1.0);
      } else shade = 0.3 + 0.4 * thick;
      float side = smoothstep(2500.0, 12000.0, dist); // far off you see the sunlit sides, not the base
      float baseShade = mix(0.3 + 0.6 * shade, shade * (0.35 + 0.65 * smoothstep(-0.3, 0.6, facing)), side);
      vec3 c = mix(uLit, uShade, clamp(baseShade, 0.0, 1.0));
      c += uLit * pow(max(facing, 0.0), 6.0) * (1.0 - thick) * 0.9 * sunUp; // silver lining
      c += uGlow * uWarm * (0.35 + 0.65 * smoothstep(-0.5, 0.8, facing)) * (1.0 - 0.45 * thick);
      c = mix(c, uHaze, 0.5 * smoothstep(4000.0, 26000.0, dist));
      d *= cuAmt;
      col += (1.0 - alpha) * d * c; alpha += (1.0 - alpha) * d;
    }
  }
  // ---- deck ----
  if (deckAmt > 0.01 && alpha < 0.99) {
    float h = 1600.0 - 500.0 * smoothstep(0.5, 6.0, uRain); // rain brings the deck down
    vec2 q = onLayer(dir, h) + uDrift * 0.6;
    float dist = length(q - uDrift * 0.6 - uCam.xz);
    float lod = footprint(dist, el, 2500.0);
    vec2 p = q / 5200.0;
    // Low skips the slow warp that bends the lumps into rolls.
    vec2 warp = uQ > 0.5 ? 0.7 * vec2(vnoise(p * 0.4 + 1.3), vnoise(p * 0.4 + 6.1)) : vec2(0.0);
    float n = fbmL(p + warp, lod, oct);
    n = mix(n, 0.5, lod);
    // Mostly thick and dark; here and there thinner and paler. Few thin spots in a full gale with rain.
    float wet = smoothstep(0.5, 5.0, uRain);
    float thin = smoothstep(0.55, 0.88, n) * (1.0 - 0.5 * smoothstep(0.75, 1.0, uStorm)) * (1.0 - 0.4 * wet);
    // Big slow bands of darker and lighter cloud (tens of km) under the lumps.
    float band = vnoise(q / 22000.0 + 2.3);
    // A heavy deck is darker than the horizon: darkest overhead, lightening as you look
    // further off through miles of thinner cloud and haze. Its lumps are soft, low contrast.
    float overhead = smoothstep(0.03, 0.5, el);
    float dark = 0.72 - (0.2 + 0.1 * uStorm + 0.08 * wet) * overhead - 0.1 * band + 0.16 * (n - 0.5);
    vec3 c = uHaze * mix(dark, 0.9, thin);
    // Light through the deck: a brighter, warmer patch towards the sun where it is thin.
    float toSun = pow(max(facing, 0.0), 3.0) * (0.35 + 0.65 * thin) * sunUp;
    c += vec3(1.0, 0.84, 0.62) * uLight * toSun * 0.6 * (1.0 - 0.85 * wet); // a downpour hides it
    c += uGlow * uWarm * 0.35 * smoothstep(-0.2, 0.9, facing) * thin * (1.0 - 0.6 * uStorm);
    c = mix(c, uHaze, smoothstep(6000.0, 45000.0, dist) * 0.85);
    col += (1.0 - alpha) * deckAmt * c; alpha += (1.0 - alpha) * deckAmt;
  }
  // The horizon: everything goes to the haze over the last few degrees, as the sea does.
  // In a downpour the mist swallows the lower sky too, not just the last few degrees.
  float hz = 1.0 - smoothstep(0.0, 0.16 + 0.3 * smoothstep(2.0, 8.0, uRain), el);
  // Under a deck the cloud goes to the haze (the sea's far fade); in clear weather it thins
  // away and the sky's own horizon shows, which the haze would only darken.
  float hz2 = hz * hz * (3.0 - 2.0 * hz);
  col = mix(col, uHaze * alpha, hz2 * deckAmt);
  float keep = 1.0 - hz2 * (1.0 - deckAmt);
  col *= keep; alpha *= keep;
  // A low sun behind a deck: the far edge of the cloud lights up warm along the horizon
  // towards it, the light coming in under the deck from clear sky beyond.
  float lowSun = smoothstep(-0.07, 0.0, uSunDir.y) * (1.0 - smoothstep(0.1, 0.35, uSunDir.y));
  float under = pow(max(dot(normalize(dir.xz), normalize(uSunDir.xz + 1e-4)), 0.0), 6.0) * (1.0 - smoothstep(0.0, 0.12, el));
  // Not through a downpour: the rain hides the clear sky beyond, and the horizon stays haze-grey.
  col += alpha * vec3(1.0, 0.62, 0.36) * under * lowSun * uLight * (0.25 + 0.35 * smoothstep(0.3, 0.9, uStorm + uCover)) * (1.0 - smoothstep(0.5, 4.0, uRain));
  // Behind the cloud, the bottom of the sky itself fades into the same haze.
  // Rain: grey curtains hanging from the deck to the sea in the distance, on the bearings
  // where it is raining, drifting with the wind; darker at the foot, streaked.
  if (uRain > 0.05 && deckAmt > 0.01) {
    vec2 wd = length(uWind) > 0.1 ? normalize(uWind) : vec2(1.0, 0.0);
    // Curtains lean with the wind: the bearing shifts a little with height.
    float lean = dot(vec2(-dir.z, dir.x), wd) * el * 0.6;
    float az = atan(dir.z, dir.x) + lean;
    float slide = dot(uDrift, vec2(-wd.y, wd.x)) * 0.00002; // curtains move across the view with the wind
    float shower = fbmL(vec2(az * 3.2 + slide, 3.7), 0.0, 3);
    float curtain = smoothstep(0.5 - 0.1 * smoothstep(1.0, 8.0, uRain), 0.68, shower);
    // Each shower its own height (smoothly, so no hard edges), densest at the sea, thinning upward into the deck.
    float tall = 0.03 + 0.045 * vnoise(vec2(az * 2.1 + slide + 9.1, 1.3));
    float hang = 1.0 - smoothstep(0.0, tall, el);
    hang *= hang * (3.0 - 2.0 * hang);
    float streak = 0.8 + 0.2 * vnoise(vec2(az * 420.0, el * 3.0 + uTime * 0.5));
    // In a downpour the mist is all round: far curtains are lost in it, and the horizon is haze.
    rainC = curtain * hang * streak * smoothstep(0.05, 3.0, uRain) * 0.75 * deckAmt * (1.0 - 0.85 * smoothstep(2.0, 8.0, uRain));
  }
  float hb = (1.0 - smoothstep(-0.01, 0.09, el)) * deckAmt;
  col += (1.0 - alpha) * uHaze * hb; alpha += (1.0 - alpha) * hb;
  col = mix(col, uShade * 0.85 * alpha, rainC);
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(col / max(alpha, 1e-3), alpha);
  // Same exposure and colour space as everything else when drawn straight to the screen
  // (Low, or no post-processing); no-ops when drawn into the post-processing target.
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  // Where the sky is haze it is the fog's own colour, put on after tone mapping as three
  // puts fog on the sea, so the fogged-out sea meets the sky without a line.
  float asFog = max(hz2 * deckAmt, hb);
  gl_FragColor = vec4(mix(gl_FragColor.rgb, uHaze, asFog), max(gl_FragColor.a, asFog));
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
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Clouds {
  readonly group = new THREE.Group();
  /** What's shown now: cloud cover and fog, both 0..1. */
  cover = 0;
  fog = 0;
  private dayCover = 0.3; // last daytime reading, held through the night
  private layer: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private scud = new THREE.Vector2();
  private rain = 0;
  private banks: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>[] = [];
  private drift = new THREE.Vector2();
  private snapped = false;

  constructor(quality: CloudQuality = "high") {
    const layer = new THREE.ShaderMaterial({
      vertexShader: cloudVert,
      fragmentShader: cloudFrag,
      uniforms: {
        uCover: { value: 0 },
        uStorm: { value: 0 },
        uRain: { value: 0 },
        uQ: { value: quality === "low" ? 0 : quality === "ultra" ? 2 : 1 },
        uTime: { value: 0 },
        uLight: { value: 1 },
        uDrift: { value: new THREE.Vector2() },
        uScud: { value: new THREE.Vector2() },
        uWind: { value: new THREE.Vector2(1, 0) },
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
    this.layer = new THREE.Mesh(new THREE.SphereGeometry(DOME_R, 48, 24), layer);
    layer.side = THREE.BackSide;
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
    rainMmH: number | null = null,
  ): void {
    if (cover != null) this.dayCover = cover;
    // Rain, mm/h: the logged rate, or (older replays) what the storm suggests.
    const rainWant = rainMmH ?? 6 * SM(storm, 0.4, 1);
    // Rain falls from a deck: steady rain covers the sky (and so dims the sun and its glitter on the sea).
    const want = Math.max(this.dayCover, SM(storm, 0.1, 0.7), SM(this.rain, 0.05, 0.8));
    const k = this.snapped ? 1 : Math.min(1, dt * 0.8);
    this.snapped = false;
    this.cover += (want - this.cover) * k;
    this.fog += (fog - this.fog) * k;
    this.rain += (rainWant - this.rain) * k;

    // Cloud drifts with the wind up there (stronger than at the sea); the low scud races.
    this.drift.x -= windX * 1.6 * dt;
    this.drift.y -= windZ * 1.6 * dt;
    this.scud.x -= windX * 2.2 * dt;
    this.scud.y -= windZ * 2.2 * dt;
    const cam = camera.position;
    this.layer.position.copy(cam);
    const u = this.layer.material.uniforms;
    // Even a "clear" reading keeps a few small fair-weather cumulus (they hardly dim the sun): looks only.
    u.uCover.value = this.cover;
    u.uStorm.value = storm;
    u.uRain.value = this.rain;
    u.uTime.value = t;
    u.uLight.value = light;
    u.uDrift.value.copy(this.drift);
    u.uScud.value.copy(this.scud);
    if (Math.hypot(windX, windZ) > 0.1) u.uWind.value.set(windX, windZ);
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

  /**
   * What the sea should reflect near the horizon: rgb the cloud sky's colour there (the
   * haze, linear like the fog colour) and w how much of the sky the deck hides (0 clear,
   * 1 closed). For the sea's far reflection (seaUniforms.uSeaSky), so sky and sea agree.
   */
  seaSky(out: THREE.Vector4): THREE.Vector4 {
    const u = this.layer.material.uniforms;
    const h = u.uHaze.value as THREE.Color;
    const deck = Math.max(SM(this.cover, 0.55, 0.95), SM(u.uStorm.value as number, 0.15, 0.7), SM(this.rain, 0.05, 0.8));
    return out.set(h.r, h.g, h.b, deck);
  }

  /** Low draws one cheaper layer; High the deck and scud with shading; Ultra more detail. */
  setQuality(q: CloudQuality): void {
    this.layer.material.uniforms.uQ.value = q === "low" ? 0 : q === "ultra" ? 2 : 1;
  }

  /** How much the rain hides the sun, 0..1 (for the atmosphere's light): drizzle already
   * mutes it by half (an overcast day), steady rain from 4 mm/h hides it. */
  get rainShade(): number {
    return 0.5 * SM(this.rain, 0.1, 0.8) + 0.5 * SM(this.rain, 0.8, 4);
  }

  /** Jump straight to the weather at the next update (after a seek), rather than easing into it. */
  snap(): void {
    this.snapped = true;
  }

  /** Thick fog and heavy rain close the haze in; call after the atmosphere has set its own. */
  closeIn(fog: THREE.Fog): void {
    const thick = SM(this.fog, 0.55, 1);
    fog.near = THREE.MathUtils.lerp(fog.near, 15, thick);
    fog.far = THREE.MathUtils.lerp(fog.far, 380, thick);
    // Rain is a mist of its own, on the same haze colour as the sea's far fade: drizzle
    // softens the horizon, and a downpour shuts the world in to a few hundred metres
    // (about 140 m by 6 mm/h: a tropical downpour's grey wall). Eased in log distance so the close-in is even, not sudden.
    const mist = 0.55 * SM(this.rain, 0.05, 0.7) + 0.45 * SM(this.rain, 1, 6);
    if (mist > 0) {
      const far = Math.exp(THREE.MathUtils.lerp(Math.log(fog.far), Math.log(140), mist));
      fog.far = Math.min(fog.far, far);
      // Grey from close by: a downpour's air is thick, not just its horizon (Elena).
      fog.near = Math.min(fog.near, THREE.MathUtils.lerp(fog.near, 0, mist));
    }
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
