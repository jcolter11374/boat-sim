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

const STEEL = new THREE.Color(0.84, 0.95, 1.12); // cold blue-grey, relative to the haze's brightness
const GOLD = new THREE.Color(1.0, 0.83, 0.58); // the break with the sun well up
const COPPER = new THREE.Color(1.0, 0.5, 0.22); // the break at sunset
const EMBER = new THREE.Color(0.85, 0.32, 0.3); // the break after the sun has gone

/**
 * The storm sky's colours (Hana, 12 Nov 2026), from the haze colour (atmos.fog.color),
 * the sun's height in degrees, the storm 0..1 and cloud cover 0..1. The deck takes its
 * brightness from the haze, so it sits in the same exposure as the sea, but its own cold
 * steel hue. The break (warm light under the deck towards a low sun) is the brightest
 * thing in a stormy sky, gold by day, copper at sunset, ember just after.
 */
/** Under a full deck the sky meets the sea at this share of the haze colour (shader hzC). */
export const HORIZON_DECK = 1.0;

export function skyColours(haze: THREE.Color, sunEl: number, storm: number, cover: number) {
  const lum = Math.max(0.2126 * haze.r + 0.7152 * haze.g + 0.0722 * haze.b, 0.003);
  const steel = STEEL.clone().multiplyScalar(lum * 1.4);
  const belly = steel.clone().multiplyScalar(0.42);
  const deck = Math.max(SM(storm, 0.15, 0.7), SM(cover, 0.55, 0.95));
  const brk_amount = deck * SM(sunEl, -6, -0.5) * (1 - 0.6 * SM(sunEl, 14, 35));
  const brk = GOLD.clone().lerp(COPPER, 1 - SM(sunEl, 2, 16)).lerp(EMBER, 1 - SM(sunEl, -4, 0.5));
  brk.multiplyScalar(lum * 4.6 * (0.3 + 0.7 * SM(sunEl, -5, 1.5)));
  return { steel, belly, brk, brk_amount };
}

/** How much of a storm's wall shows, 0..1, at this many km from its centre. */
export function stormWall(km: number): number {
  return Number.isFinite(km) ? 1 - SM(km, 150, 900) : 0;
}

/**
 * The new fair-weather cumulus (heaps with real height) is switched off: it shows only with
 * ?cumulus=new in the address. Elena, 14 Nov 2026: the title keeps the clouds it was signed off
 * with, and at sea the heaps wait until they are a field on a shared flat base with the soft
 * high sheets kept above them. Until then every sky draws the earlier cumulus.
 */
export const CUMULUS_NEW = typeof location !== "undefined" && new URLSearchParams(location.search).get("cumulus") === "new";

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
uniform float uBreak, uMoon, uWall, uWallKm, uCuNew, uCuRT;
uniform sampler2D uCuTex;
uniform vec2 uCuRes, uCuTexSize;
uniform vec2 uWallDir;
uniform vec2 uDrift, uScud, uWind, uSeed;
uniform vec3 uCam, uSunDir, uMoonDir, uLit, uShade, uHaze, uGlow, uSteel, uBelly, uBrk;
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
float billowL(vec2 p, float lod, int oct) {
  float v = 0.0, a = 0.5, w = 0.0;
  for (int k = 0; k < 5; k++) {
    if (k >= oct) break;
    float keep = 1.0 - smoothstep(float(k) - 1.5, float(k) - 0.5, lod * 5.0);
    v += a * keep * abs(vnoise(p) * 2.0 - 1.0); w += a * keep;
    p = p * 2.07 + vec2(5.3, 11.9); a *= 0.5;
  }
  return v / max(w, 1e-3);
}
// Rounded cells: 1 at a cell's heart, falling to 0 at the dark gaps between cells
// (a soft Worley pattern). Cells sag in the middle: that is what gives a storm deck
// its lumpy, bulging underside rather than streaks.
float cells(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 9.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = vec2(h21(i + g), h21(i + g + 31.7));
    // Cells of different sizes, so the pattern isn't a regular net.
    float r = 0.75 + 0.5 * h21(i + g + 57.1);
    d1 = min(d1, length(g + 0.1 + 0.8 * o - f) / r);
  }
  return 1.0 - smoothstep(0.15, 0.85, d1);
}
// The deck in wind coordinates (x along the wind, y across): big lumpy cells (a little
// longer along the wind, so they line up in rolls), broken into separate masses by a
// slow field, with smaller bumps on their undersides.
float deckSide(float azD, float el, float calmDeck, float drift) {
  vec2 sv = vec2(azD * mix(9.0, 5.0, calmDeck) + drift, el * mix(40.0, 22.0, calmDeck)) + uSeed;
  vec2 warp = vec2(fbmL(sv * 0.5, 0.0, 2), fbmL(sv * 0.5 + 3.1, 0.0, 2)) - 0.5;  // no honeycomb
  vec2 sw = sv * vec2(1.0, 0.8) + 0.7 * warp;
  return 0.25 * fbmL(sv * 1.3, 0.0, 2) * (1.0 - 0.6 * calmDeck) + 0.5 * cells(sw) + 0.25 * cells(sw * 2.1 + 5.7) * (1.0 - 0.5 * calmDeck) + 0.15 * calmDeck;
}
float deckD(vec2 r, float lod, int oct) {
  // Torn, wind-stretched masses, not a tiling of round cells (Ines: "leopard spots"): a
  // strong two-scale warp, cells drawn out along the wind (r.x), and a slow mask that
  // tears some of them away so the pattern never repeats evenly.
  vec2 w = r + 0.9 * vec2(vnoise(r * 0.35 + 2.7), vnoise(r * 0.35 + 6.1)) + 0.3 * vec2(vnoise(r * 1.3 + 4.4), vnoise(r * 1.3 + 9.2));
  vec2 ws = w * vec2(0.6, 1.0);
  float big = cells(ws * 1.9);
  float bumps = cells(ws * 5.2 + 7.3);
  float mass = fbmL(w * 0.7, lod, max(oct - 1, 2));
  float tear = smoothstep(0.3, 0.7, vnoise(r * 0.22 + 1.9));
  float k = 1.0 - smoothstep(0.2, 0.9, lod); // cells blur away with distance
  float v = 0.36 * big * k * (0.45 + 0.55 * tear) + 0.12 * bumps * (1.0 - smoothstep(0.0, 0.5, lod)) + 0.6 * mass - 0.03;
  return mix(0.5, v, 1.0 - 0.6 * lod) + 0.01;
}
// ---- new fair cumulus (only with ?cumulus=new): heaps as height fields over a flat base ----
const float CU_BASE = 1400.0; // m, the flat base
const float CU_TOP = 1300.0;  // m above the base, the tallest head
// The heap here: x = its underside, y = its top, in m above the base (y <= x: clear sky).
// A few big heaps and scattered small ones, gathered in groups with whole stretches of empty
// sky between (Ines r2: about half as many). Each big heap is a dome with narrower heads
// stacked on it, and billows on those (domes on domes, never a box).
// Distance to the nearest of a jittered set of centres, weighted by each one's size (0 at a
// centre). A heap is a dome over that distance: no plateau, so no flat-topped boxes.
float cellD(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 9.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = vec2(h21(i + g), h21(i + g + 31.7));
    float r = 0.6 + 0.8 * h21(i + g + 57.1);
    d1 = min(d1, length(g + 0.1 + 0.8 * o - f) / r);
  }
  return d1;
}
// 3D value noise for the round bulges on a heap's surface (Ines r3: no flat faces).
float h31(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float n3(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h31(i), h31(i + vec3(1, 0, 0)), f.x), mix(h31(i + vec3(0, 1, 0)), h31(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(h31(i + vec3(0, 0, 1)), h31(i + vec3(1, 0, 1)), f.x), mix(h31(i + vec3(0, 1, 1)), h31(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float cuDome(float d, float R) { float q = clamp(d / R, 0.0, 1.0); return 1.0 - q * q; } // rounded shoulders that lean in to a dome: no cake sides, no cone
float cuClump(vec2 p) { return smoothstep(0.42, 0.78, fbmL(p * 0.16 + uSeed * 0.7, 0.0, 2)); }
vec2 cuShape(vec2 x, float detail) {
  vec2 p = (x + uDrift) / 1000.0;
  p += 0.3 * vec2(fbmL(p * 1.3 + 2.7, 0.0, 2), fbmL(p * 1.3 + 9.1, 0.0, 2)) - 0.15; // no round discs
  float clump = cuClump(p);
  float cov = 0.06 + 0.45 * uCover;
  // Radius of each heap, in cell units: none outside the groups, bigger at their hearts.
  // Fair-weather size (Ines r3): about a kilometre across, a fist or two wide overhead.
  float Rb = cov * mix(0.0, 1.8, clump);
  float Rs = cov * mix(0.0, 1.4, clump) * smoothstep(0.72, 0.88, vnoise(p * 0.9 + 3.3)); // only a few small ones (Ines r4: no popcorn)
  float dB = cellD(p * 0.6 + uSeed * 1.3);
  float dS = cellD(p * 2.0 + uSeed * 2.7 + 7.1);
  // The search (detail < 0) sees every heap 35% wider, so a ray can't step over a thin edge
  // between two samples: that per-pixel hit-or-miss was the last grain on small heaps' edges.
  float grow = detail < -0.5 ? 1.5 : 1.0;
  float db = Rb > 0.2 ? cuDome(dB, Rb * grow) : 0.0; // no slivers at a group's fringe
  // Small heaps (about 200 m) are culled (Elena r8): smaller than the search's step, they
  // came out full of holes that twinkled as they drifted.
  float ds = 0.0;
  float k = max(1.0 - dB / max(Rb, 1e-3), 0.9 * (ds > 0.0 ? 1.0 - dS / max(Rs, 1e-3) : 0.0));
  float tall = 0.55 + 0.7 * vnoise(p * 0.6 + uSeed * 1.7); // some heaps grow, some stay low
  // Never taller than wide (Elena r5: no cones): height capped by the heap's own radius in m.
  float top = max(db * min(360.0 * (0.6 + 0.4 * clump) * tall, 1.0 * Rb * 1667.0), ds * min(220.0 * (0.6 + 0.6 * clump), 0.7 * Rs * 500.0));
  // Heads: narrower round domes rising off the big heap, offset from its middle.
  float dH = cellD(p * 2.4 + uSeed * 4.3 + 2.2);
  float qh = clamp(dH / 0.7, 0.0, 1.0);
  top += db * db * pow(1.0 - qh * qh, 0.7) * 260.0 * tall; // heads only on the heap's upper part
  float bot = 20.0 * pow(1.0 - smoothstep(0.0, 0.3, k), 2.0); // the rim curls up off the flat base
  if (top > 0.0 && detail > 0.5) top += (fbmL(p * 4.0 + uSeed * 3.1, 0.0, 2) - 0.5) * 160.0 * smoothstep(0.0, 200.0, top);
  return vec2(bot, top);
}
// Cheap, generous test for the march's search (Kai: clear sky must cost little): could there
// be a heap here at all, and how tall (no warp, no detail; the margins cover them).
float cuMaybe(vec2 x) {
  vec2 p = (x + uDrift) / 1000.0;
  float clump = cuClump(p);
  float cov = 0.06 + 0.45 * uCover;
  if (cov * 1.8 * clump < 0.12) return 0.0; // outside the groups: open sky, one fbm and done (Kai)
  if (cellD(p * 0.6 + uSeed * 1.3) < cov * 1.8 * clump * 1.5 + 0.2) return 1200.0;
  return 0.0;
}
float gThick = 0.0; // the smooth heap's thickness at the last cuIn() point, m
float cuIn(vec3 P, float detail) { // < 0 inside a heap: how far in (m)
  vec2 s = cuShape(P.xz, detail);
  gThick = s.y - s.x;
  if (s.y <= s.x) return 1e3; // no heap over this spot: far outside (not "near" just for being at base height)
  float y = P.y - CU_BASE;
  // Round bulges, smaller ones on bigger ones, most detail towards the top (Ines r3: cumulus
  // has no flat faces). They carve the sides and top only, so the base stays flat and always
  // belongs to the heap above it (no loose ledges).
  float lump = 0.0;
  if (detail > 0.5) {
    vec3 q = P / vec3(230.0, 900.0, 230.0) + vec3(uSeed, 0.0); // nearly upright lobes: no shelves, no stacked tiers (Elena r5)
    float up = smoothstep(0.0, 500.0, y);
    lump = (n3(q) - 0.5) * 190.0 + (n3(P / vec3(110.0, 200.0, 110.0) + vec3(uSeed, 4.1)) - 0.5) * 110.0 * up; // cauliflower towards the head // no finer octave: finer than a step it only made speckle
  }
  // Near the base the bulges may only swell outward: one flat, level base under the whole heap
  // (the condensation level, the same height across the field), never a round cotton-ball bottom.
  lump += 0.4 * y; // sides lean in as they rise: each head narrows to a dome (Elena r6: no cakes)
  float d = max(s.x - y, y - s.y + lump);
  d = max(d, 0.5 * (150.0 - (s.y - s.x))); // on the smooth shape: bulges must not break a thin heap into dots // no thin slabs: a heap is at least ~90 m thick or not there
  return d;
}
vec4 cumulusVol(vec3 dir, float facing, float toSunH, float sunUp) {
  if (dir.y < 0.004) return vec4(0.0);
  float hor = max(length(dir.xz), 1e-3);
  float t0 = (CU_BASE - 150.0 - uCam.y) / dir.y;
  float t1 = (CU_BASE + CU_TOP + 250.0 - uCam.y) / dir.y;
  float tEnd = min(t1, 28000.0 / hor);
  if (t0 >= tEnd) return vec4(0.0);
  // 1) Find where the ray first comes near a heap (coarse, cheap shape).
  int N = uQ < 0.5 ? 20 : uQ < 1.5 ? 32 : 44;
  float dt = (tEnd - t0) / float(N);
  // Jitter fixed to the cloud, not the screen (Elena r8: holes must not twinkle): from where
  // the ray meets the base, drifting with the cloud, at about a pixel's size there.
  vec2 jq = ((uCam + dir * t0).xz + uDrift) / max(4.0, t0 * 0.0015);
  float jit = fract(vnoise(jq) * 9.0 + vnoise(jq * 0.37 + 5.3) * 5.0);
  float t = t0 + dt * jit;
  float tIn = -1.0;
  for (int i = 0; i < 56; i++) {
    if (i >= N) break;
    vec3 Pc = uCam + dir * t;
    float mb = cuMaybe(Pc.xz);
    if (mb > 0.0 && Pc.y - CU_BASE < mb + 60.0 && cuIn(Pc, -1.0) < 190.0 + 0.4 * dt * dir.y) { tIn = max(t - dt, t0); break; }
    t += dt;
  }
  if (tIn < 0.0) return vec4(0.0);
  float lo = tIn, hi = tIn + dt;
  for (int k = 0; k < 6; k++) { float m = 0.5 * (lo + hi); if (cuIn(uCam + dir * m, -1.0) < 190.0) hi = m; else lo = m; }
  // 2) Through the cloud in fine steps: soft density (thin at the edges, so they glow where
  //    the sun is behind them and stay soft), light from the sun through what lies towards it,
  //    and sky light from above.
  vec3 sunD = normalize(uSunDir);
  float gold = smoothstep(-0.02, 0.04, uSunDir.y) * (1.0 - smoothstep(0.14, 0.45, uSunDir.y));
  vec3 sunC = uLit * 9.0 * mix(vec3(1.0), vec3(1.5, 0.86, 0.5), gold); // gold to peach on the sunward tops at a low sun
  vec3 sky = dot(uLit, vec3(0.2126, 0.7152, 0.0722)) * mix(vec3(0.55, 0.64, 0.82), vec3(0.5, 0.48, 0.72), gold); // cool grey-violet in the shadows at dusk
  float cosT = dot(dir, sunD);
  float g = 0.55; // forward scattering: the silver lining towards the sun
  float phase = 0.55 + 0.45 * (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cosT, 1.5) * 0.25;
  float fs = 18.0 + 0.002 * lo; // step, m (longer far off)
  float T = 1.0; vec3 acc = vec3(0.0);
  float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))); // even dither, no grain
  float tt = lo + fs * fract(jit * 1.618 + 0.31); // the same cloud-fixed jitter
  float dFirst = -1.0;
  int M = int(float(uQ < 0.5 ? 12 : 30) * (1.0 - 0.6 * smoothstep(3000.0, 15000.0, lo * hor))); // fewer far off
  // Only steps inside cloud count against M: from far off, a shallow ray can run a long way
  // between "near a heap" and the heap itself, and stopping early cut heads off (loose slabs).
  int used = 0;
  int cap = uQ < 0.5 ? 40 : 80;
  for (int i = 0; i < 80; i++) {
    if (i >= cap || used >= M || T < 0.03 || tt > tEnd) break;
    vec3 P = uCam + dir * tt;
    float inside = -cuIn(P, uQ < 0.5 ? 0.0 : 1.0); // Low: no bulges (Kai)
    float thin = smoothstep(160.0, 400.0, gThick); // thin rims and thin heaps fade out softly instead of breaking into twinkling holes
    // Stride through clear air, faster where no heap stands at all, so a ray that grazes one
    // heap still reaches the next (else a whole heap came out as scattered dots).
    float st = inside < -200.0 ? (cuMaybe(P.xz) > 0.0 ? 2.5 * fs : max(2.5 * fs, 0.5 * dt)) : (gThick > 0.0 ? min(fs, max(gThick / 8.0, 8.0)) : fs); // finer steps through thin cloud, so a thin heap isn't left to a few random samples; fine steps anywhere near a heap: long strides skipped thin edges at random
    float dens = smoothstep(0.0, 20.0 + 1.2 * fs, inside) * thin; // crisp up close, soft far off // edge ramp wider than a step: no comb // crisp heads, a soft fringe
    if (dens > 0.001) {
      used++;
      if (dFirst < 0.0) dFirst = tt;
      // Light reaching this point from the sun, through the heap towards it.
      // (samples out to 500 m, so a heap backlit by a low sun is dark on the side we see)
      float od = smoothstep(-40.0, 80.0, -cuIn(P + sunD * 30.0, uQ < 0.5 ? 0.0 : 1.0)) * 60.0 // the silver line stays thin
               + smoothstep(-30.0, 120.0, -cuIn(P + sunD * 90.0, uQ < 0.5 ? 0.0 : 1.0)) * 260.0 // bulges shade each other
               + smoothstep(-30.0, 120.0, -cuIn(P + sunD * 500.0, 0.0)) * 700.0; // only the thinnest edges let the sun through: a thin silver line, not a halo
      float Tl = exp(-od * 0.014) * 0.88 + 0.12 * exp(-od * 0.003); // more multiple scattering: brilliant white, not smoke (Elena r5) // a little multiple scattering
      float hf = clamp((P.y - CU_BASE) / CU_TOP, 0.0, 1.0);
      vec3 L = sunC * Tl * phase + sky * (0.35 + 0.6 * hf);
      float sig = dens * 0.026;
      float aStep = 1.0 - exp(-sig * st);
      acc += T * aStep * L;
      T *= 1.0 - aStep;
    }
    tt += st;
  }
  float a = 1.0 - T;
  if (a < 0.003) return vec4(0.0);
  vec3 col = acc / a;
  float distH = length(dir.xz) * (dFirst > 0.0 ? dFirst : lo);
  // At a low sun: blue-grey away from it (Ines r1, kept); a rose glow once it sets.
  float lowS = smoothstep(-0.03, 0.01, uSunDir.y) * (1.0 - smoothstep(0.06, 0.2, uSunDir.y));
  float sunward = smoothstep(-0.4, 0.8, toSunH);
  col = mix(col, col * vec3(0.85, 0.85, 0.95), lowS * (1.0 - sunward) * 0.25); // a touch only: the shadows carry the cool (sky term)
  col += uGlow * uWarm * 0.5 * smoothstep(-0.2, 0.8, facing) * (1.0 - smoothstep(0.0, 0.06, uSunDir.y));
  col = mix(col, uHaze, 0.85 * smoothstep(4000.0, 22000.0, distH)); // the far row melts into the haze
  a *= 1.0 - smoothstep(14000.0, 25000.0, distH);
  return vec4(col, a);
}
// The fair-weather cumulus every sky draws (the new heaps replace it only with ?cumulus=new).
float fbmOld(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int k = 0; k < 5; k++) { v += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return v;
}
float billowOld(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int k = 0; k < 4; k++) { v += a * abs(vnoise(p) * 2.0 - 1.0); p = p * 2.07 + vec2(5.3, 11.9); a *= 0.5; }
  return v;
}
float densOld(vec2 p) {
  vec2 w = p + 0.45 * vec2(vnoise(p * 0.8 + 3.1), vnoise(p * 0.8 + 8.3));
  return 0.9 * fbmOld(w) + 0.26 * (1.0 - billowOld(w * 3.0 + 1.7)) - 0.15;
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
  vec2 sunH = uSunDir.xz / max(length(uSunDir.xz), 1e-3);
  float toSunH = dot(normalize(dir.xz + 1e-5), sunH);  // +1 looking along the sun's bearing
  float moonG = uMoon * (pow(max(dot(dir, uMoonDir), 0.0), 80.0) * 1.4 + pow(max(dot(dir, uMoonDir), 0.0), 8.0) * 0.3);
  // The break (Hana): towards a low sun the deck ends some way off and light comes in under it.
  float brkSide = uBreak * smoothstep(0.35, 0.97, toSunH) * (1.0 - smoothstep(0.5, 4.0, uRain)); // not through a downpour
  float brkFocus = 0.25 + 0.75 * pow(max(toSunH, 0.0), 10.0); // brightest round the sun's bearing
  // ---- scud ----
  // Ragged fractus under the deck: darker than the deck, torn along the wind, racing,
  // and changing shape as it goes. Against the break it shows as dark rags on the light.
  float scudAmt = smoothstep(0.3, 0.85, uStorm) * (0.7 + 0.3 * smoothstep(0.5, 4.0, uRain));
  if (scudAmt > 0.01) {
    vec2 q = onLayer(dir, mix(350.0, 220.0, smoothstep(0.4, 1.0, uStorm)));
    float dist = length(q - uCam.xz);
    float lod = footprint(dist, el, 700.0);
    vec2 wd = length(uWind) > 0.1 ? normalize(uWind) : vec2(1.0, 0.0);
    vec2 r = vec2(dot(q + uScud, wd), dot(q + uScud, vec2(-wd.y, wd.x)));
    vec2 morph = vec2(uTime * 0.012, uTime * 0.007);
    float n = fbmL(r / vec2(1300.0, 1250.0) + uSeed * 1.7 + morph, lod, oct);
    if (uQ > 0.5) n += 0.35 * (0.5 - billowL(r / vec2(360.0, 340.0) + 4.7 - morph * 3.0, lod, oct)) * (1.0 - lod);
    n = mix(n, 0.45, lod);
    // Patchy: separate rags with the deck showing between them, not a blanket.
    float d = smoothstep(0.58 - 0.06 * scudAmt, 0.78, n) * scudAmt * 0.8;
    d *= smoothstep(0.0, 0.025, el); // they sink into the haze at the horizon
    vec3 c = uBelly * mix(0.95, 0.7, smoothstep(0.6, 0.85, n));
    // Lit from below at their edges where the break throws light under the deck.
    c += uBrk * brkSide * 0.3 * (1.0 - smoothstep(0.6, 0.8, n)) * (1.0 - smoothstep(0.0, 0.12, el));
    c += vec3(0.5, 0.56, 0.68) * moonG * 0.4;
    c = mix(c, uHaze, smoothstep(1500.0, 11000.0, dist));
    col += (1.0 - alpha) * d * c; alpha += (1.0 - alpha) * d;
  }
  // ---- cumulus ----
  // Under a closing deck the heaps lose their sun and merge into it.
  // Overcast, a blow, or steady rain (rain falls from a deck, whatever the sunlight said) close the sky.
  float deckAmt = max(max(smoothstep(0.55, 0.95, uCover), smoothstep(0.15, 0.7, uStorm)), smoothstep(0.05, 0.8, uRain));
  float cuAmt = (1.0 - smoothstep(0.55, 0.95, max(uStorm, uCover))) * (1.0 - deckAmt);
  if (cuAmt > 0.01 && alpha < 0.99 && uCuNew < 0.5 && dir.y > 0.0) {
    // main's layer at 600 m, as it was drawn before the new sky (same look, now on the dome).
    vec2 qo = onLayer(dir, 600.0);
    vec2 po = (qo + uDrift) / 900.0;
    float n = densOld(po);
    float edge = 1.0 - (0.42 + 0.5 * uCover);
    float d = smoothstep(edge - 0.015, edge + 0.07, n);
    if (d > 0.004) {
      float thick = smoothstep(edge, edge + 0.3, n);
      vec2 sunH = uSunDir.xz / max(length(uSunDir.xz), 1e-3);
      float toward = densOld(po + sunH * 0.09) - n;
      float shade = clamp(0.55 * thick + 2.6 * toward, 0.0, 1.0);
      float dist = length(qo - uCam.xz);
      float side = smoothstep(700.0, 3500.0, dist);
      float baseShade = mix(0.35 + 0.65 * shade, shade * (0.4 + 0.6 * smoothstep(-0.3, 0.6, facing)), side);
      vec3 c = mix(uLit, uShade, clamp(baseShade, 0.0, 1.0) * (0.8 + 0.2 * uStorm));
      c += uLit * pow(max(facing, 0.0), 5.0) * (1.0 - thick) * 0.9;
      c += uGlow * uWarm * (0.35 + 0.65 * smoothstep(-0.5, 0.8, facing)) * (1.0 - 0.45 * thick);
      c = mix(c, uHaze, smoothstep(2500.0, 8000.0, dist));
      float a = d * (1.0 - smoothstep(5000.0, 8500.0, dist)) * 0.96 * cuAmt;
      col += (1.0 - alpha) * a * c; alpha += (1.0 - alpha) * a;
    }
  } else if (cuAmt > 0.01 && alpha < 0.99) {
    // Hana, round 2 (Ines): heaps with real height. Each heap is a dome standing on a flat
    // base; the view ray is marched through them, so from a low camera the far ones show
    // their sides and heads rising and catching the sun, and the near ones their flat bases.
    // Drawn at half resolution in its own pass (Kai: cost), then a soft 4-tap read here,
    // which also smooths the march's grain.
    vec4 cu;
    if (uCuRT > 0.5) {
      // Bilinear by hand (half-float targets may only filter nearest, which came out as blocks
      // on Low: Kai r5), on premultiplied colour so edges don't darken.
      vec2 st = gl_FragCoord.xy / uCuRes * uCuTexSize - 0.5;
      vec2 i0 = floor(st), fr = st - i0;
      vec2 it = 1.0 / uCuTexSize;
      vec4 c00 = texture2D(uCuTex, (i0 + 0.5) * it), c10 = texture2D(uCuTex, (i0 + vec2(1.5, 0.5)) * it);
      vec4 c01 = texture2D(uCuTex, (i0 + vec2(0.5, 1.5)) * it), c11 = texture2D(uCuTex, (i0 + 1.5) * it);
      cu = mix(mix(c00, c10, fr.x), mix(c01, c11, fr.x), fr.y);
      // Fill single-texel holes (a march that missed where all its neighbours hit) from the four
      // neighbours, so thin heads don't show pinholes that flicker as the cloud drifts (Elena r8).
      vec2 ic = (floor(st + 0.5) + 0.5) * it;
      vec4 nb = 0.25 * (texture2D(uCuTex, ic + vec2(it.x, 0.0)) + texture2D(uCuTex, ic - vec2(it.x, 0.0))
                      + texture2D(uCuTex, ic + vec2(0.0, it.y)) + texture2D(uCuTex, ic - vec2(0.0, it.y)));
      cu = mix(cu, nb, smoothstep(0.15, 0.45, nb.a - cu.a));
      cu.rgb /= max(cu.a, 1e-4);
    } else cu = cumulusVol(dir, facing, toSunH, sunUp);
    col += (1.0 - alpha) * cu.a * cuAmt * cu.rgb; alpha += (1.0 - alpha) * cu.a * cuAmt;
  }
  // ---- deck ----
  // Hana: the deck lies in long rolls along the wind (cloud streets), dark-bellied where
  // thick, pale and torn where thin, each roll lit on its sun side. Its own cold steel
  // colours (uSteel lit, uBelly dark), not the haze's, so a stormy dusk isn't brown.
  if (deckAmt > 0.01 && alpha < 0.99) {
    // A gale's deck is low, close and heavy (Sam): about 600 m, lower still in rain.
    float h = mix(1600.0, 650.0, smoothstep(0.25, 0.9, uStorm)) - 250.0 * smoothstep(0.5, 6.0, uRain);
    vec2 q = onLayer(dir, h) + uDrift * 0.6;
    float dist = length(q - uDrift * 0.6 - uCam.xz);
    float lod = footprint(dist, el, 2600.0);
    vec2 wd = length(uWind) > 0.1 ? normalize(uWind) : vec2(1.0, 0.0);
    // Outside a storm the sheet is broader and softer (Ines: big soft lumps, not veins).
    float calmDeck = 1.0 - smoothstep(0.25, 0.6, uStorm);
    vec2 r = vec2(dot(q, wd), dot(q, vec2(-wd.y, wd.x))) / (vec2(7400.0, 6600.0) * (0.45 + 0.55 * h / 1600.0) * (1.0 + 0.7 * calmDeck)) + uSeed;
    // Low skips the rolls and knobs (one plain noise), as Kai's cheap path does.
    float n = uQ > 0.5 ? deckD(r, lod, oct) : mix(fbmL(r, lod, oct), 0.5, lod);
    // Far off, where the detail has blurred away, the deck is seen edge-on: thin level
    // strata, lighter and darker, rather than a flat grey.
    float azD = atan(dir.z, dir.x);
    // Lumpy along the horizon (a degree or two across), thin in height: rolls seen side on.
    if (uQ > 0.5) {
      // Heavy masses, not combed lines (Elena): mostly lumps, a few degrees across, and
      // they take over low in the sky, where the deck's own pattern squashes into streaks.
      float sdrift = dot(uDrift, vec2(-wd.y, wd.x)) * 0.00015;
      float side = deckSide(azD, el, calmDeck, sdrift);
      // atan wraps at +-pi: blend in a copy measured from the opposite way, so no seam.
      if (abs(azD) > 2.6) side = mix(side, deckSide(azD - sign(azD) * 6.2831853, el, calmDeck, sdrift + 31.7), smoothstep(2.6, 3.1, abs(azD)));
      float sideW = max(smoothstep(0.0, 0.55, lod), (1.0 - smoothstep(0.04, 0.22, el)) * (1.0 - smoothstep(0.25, 0.6, uStorm)));
      n = mix(n, 0.34 + 0.46 * side, sideW);
    }
    float wet = smoothstep(0.5, 5.0, uRain);
    // In a full gale with rain it closes right over; seams open where it thins.
    float cov = 0.62 + 0.25 * uStorm - 0.12 * (1.0 - smoothstep(0.55, 0.95, uCover)) * (1.0 - uStorm);
    cov += 0.22 * smoothstep(0.8, 1.0, uCover) * (1.0 - uStorm); // a full overcast closes over
    float edge = 1.0 - cov;
    float body = smoothstep(edge - 0.08, edge + 0.22, n);
    float thick = smoothstep(0.36, 0.74, n); // around the mean, so bellies and thin seams both show
    // Each roll's sun side catches light, its lee side is shadowed.
    vec2 sr = vec2(dot(sunH, wd), dot(sunH, vec2(-wd.y, wd.x)));
    float slope = 0.0;
    if (uQ > 0.5) slope = deckD(r + sr * 0.05, lod, oct) - n;
    vec3 c = mix(uSteel, uBelly, pow(thick, 0.75));
    c *= 1.0 + clamp(-slope * 5.0, -0.45, 0.6) * (1.0 - lod) * (0.3 + 0.7 * uLight) * smoothstep(0.1, 0.35, el); // edge-on it combs into lines
    // Darkest overhead, lighter towards the horizon through miles of thinner cloud.
    float overhead = smoothstep(0.04, 0.6, el);
    c *= 1.0 - (0.1 + 0.1 * wet) * overhead;
    // Silver through thin cloud looking towards the sun.
    float sunUpD = smoothstep(-0.05, 0.1, uSunDir.y);
    c += uLit * pow(max(facing, 0.0), 5.0) * (1.0 - thick) * 0.45 * sunUpD;
    // Warm light coming in under the deck from the break catches the nearest roll bottoms.
    float under = brkSide * pow(1.0 - smoothstep(0.0, 0.16, el), 2.0);
    c += uBrk * under * (0.15 + 0.6 * (1.0 - thick)) * 0.45;
    c += uGlow * uWarm * 0.25 * smoothstep(-0.2, 0.9, facing) * (1.0 - thick);
    c += vec3(0.5, 0.56, 0.68) * moonG * (1.0 - 0.85 * thick);
    // A plain overcast sheet: gentle value changes, no bright veins.
    c = mix(c, mix(uSteel, uBelly, 0.62), 0.55 * calmDeck * smoothstep(0.7, 0.95, uCover));
    c = mix(c, uHaze, smoothstep(20000.0, 90000.0, dist) * 0.7);
    // Above the deck: a paler, smooth upper layer (no blue sky in a gale). In the break,
    // beyond the deck's far edge, warm clear light low on the horizon.
    vec3 upper = mix(uSteel * 1.25, uHaze, 0.3) + vec3(0.5, 0.56, 0.68) * moonG;
    // The deck's far edge is ragged: nearer on some bearings than others.
    float az = atan(dir.z, dir.x);
    // (scaled with the deck's height, so the slot keeps its few degrees of sky when the deck comes down)
    float edgeAt = (24000.0 + 40000.0 * fbmL(vec2(az * 7.0, 0.0) + uSeed + uDrift * 0.00002, 0.0, 5)) * h / 1600.0;
    // The edge follows the cloud's own lumps: thick masses hang on further out.
    float brk = brkSide * smoothstep(edgeAt * 0.5, edgeAt * 2.2, dist * (1.5 - 1.1 * n));
    float glowH = 1.0 - smoothstep(0.0, 0.04, el);
    // Far cloud lies in thin dark strands across the light, as it does in every real break.
    float strands = uQ > 0.5 ? smoothstep(0.56, 0.8, fbmL(vec2(az * 9.0, el * 160.0) + uSeed + uDrift * 0.00003, 0.0, 4)) : 0.0;
    // Brightest right on the horizon and round the sun itself, behind the deck's edge.
    float sunG = pow(max(facing, 0.0), 220.0) * 3.0 + pow(max(facing, 0.0), 14.0) * 0.6;
    vec3 light = uBrk * ((0.25 + 1.6 * glowH * glowH) * brkFocus + sunG) + uHaze * 0.3 * (1.0 - glowH);
    light = mix(light, mix(upper, uBelly, 0.3), strands * (0.25 + 0.45 * (1.0 - glowH)));
    // Rain shafts hanging from the far deck, grey against the light.
    if (uQ > 0.5) {
      float shaft = smoothstep(0.66, 0.86, fbmL(vec2(az * 18.0 + uDrift.x * 0.00004, el * 4.0) + uSeed * 3.1, 0.0, 3));
      shaft *= smoothstep(0.3, 1.0, uStorm) * (0.5 + 0.5 * smoothstep(0.0, 2.0, uRain));
      // Darkest under the cloud, fading as the rain falls towards the sea.
      light = mix(light, upper * 0.9, shaft * 0.5 * (0.35 + 0.65 * (1.0 - glowH)));
    }
    vec3 gap = mix(upper, light, smoothstep(0.0, 1.0, brk));
    float d = body * (1.0 - 0.97 * brk);
    vec3 dc = mix(gap, c, d);
    float da = deckAmt; // the break is painted here too, so nothing grey shows through behind it
    col += (1.0 - alpha) * da * dc; alpha += (1.0 - alpha) * da;
  }
  // The horizon: everything goes to the haze over the last few degrees, as the sea does.
  // Only the last few degrees: the cloud base runs down into the haze, with no flat band above it (Ines).
  // In a downpour the mist swallows the lower sky too, not just the last few degrees (Kai).
  // Under a deck the cloud frays down into the haze: the band's top rises and falls with the
  // bearing and the cloud's own lumps (Ines: no ruled edge).
  float frayN = fbmL(vec2(atan(dir.z, dir.x) * 7.0, el * 40.0) + uSeed * 1.9, 0.0, 3) - 0.5;
  float fray = deckAmt * frayN;
  float hz = (1.0 - smoothstep(0.0, mix(0.16, 0.07, deckAmt) * (1.0 + 0.9 * fray) + 0.3 * smoothstep(2.0, 8.0, uRain), el)) * (1.0 - 0.75 * brkSide); // the break stays bright
  // Under a deck the cloud goes to the haze (the sea's far fade); in clear weather it thins
  // away and the sky's own horizon shows, which the haze would only darken.
  float hz2 = hz * hz * (3.0 - 2.0 * hz);
  // Under a deck, a soft mist band a few degrees deep (Elena: no knife line), paling
  // toward the sea where the far rain and spray are lit.
  col = mix(col, uHaze * alpha * (1.0 + 0.25 * hz), hz * hz * deckAmt);
  float keep = 1.0 - hz2 * (1.0 - deckAmt);
  col *= keep; alpha *= keep;
  // ---- storm wall (Hana) ---- (after the clear-sky horizon fade, which would hide it)
  // A storm on its way: a dark wall of cloud low on the horizon on its bearing, faint and
  // hazy when it is far, taller, darker and wider as it closes (uWall 0..1, setStorm()).
  if (uWall > 0.01) {
    // Angle from the storm's bearing, so the wrap (and its seam) sits behind the viewer.
    vec2 nxz = normalize(dir.xz + 1e-5);
    float az = atan(nxz.x * uWallDir.y - nxz.y * uWallDir.x, dot(nxz, uWallDir));
    // One storm cell fills a sector of the horizon (about 30 degrees far off, 60 close),
    // fading out at its sides (Ines), not the whole width.
    float sector = mix(0.26, 0.52, smoothstep(0.2, 1.0, uWall)); // half-width, rad
    float on = 1.0 - smoothstep(sector * 0.45, sector, abs(az));
    float az1 = az + uTime * 0.0005;
    // Real geometry (Ines r3): heights in km at the storm's distance, less what the earth's
    // curve hides (D^2 / 2R, R = 7433 km with the usual refraction): from 400 km only the
    // anvil peeps over the horizon, at 150 km the towers stand with their base just hidden.
    float D = max(uWallKm, 40.0);
    float drop = D * D / 14866.0;
    float hkm = el * D + drop;        // height of this pixel at the storm, km (0 = its sea level)
    float skm = az1 * D;              // sideways along the horizon at the storm, km
    // One dominant tower, a little off the bearing (by the voyage's seed), with lower,
    // uneven towers beside it at irregular gaps. Each is a column with steep sides and a
    // broad, rounded head (never a ridge or a coastline). Smooth shapes only: the detail is
    // the outline itself, no per-pixel grain (Ines r3).
    float c0 = (fract(uSeed.x * 0.37) - 0.5) * sector * 0.6 * D;
    vec3 rs = fract(vec3(uSeed.x * 1.31, uSeed.y * 2.17, uSeed.x * 0.73 + uSeed.y)) - 0.5;
    float und = fbmL(vec2(skm * 0.09, 4.4) + uSeed, 0.0, 2); // broad lobes on the heads
    float topk = 0.0;
    // Which way the wind carries the top of the storm across the line of sight (+1 / -1).
    float wl = length(uWind);
    float wSide = wl > 0.5 ? dot(uWind / wl, vec2(uWallDir.y, -uWallDir.x)) : (fract(uSeed.y) - 0.5) * 2.0;
    float wSgn = wSide < 0.0 ? -1.0 : 1.0;
    // Stacked billows: each tower's sides bulge in and out with height, a few km a lobe.
    float bul = 2.2 * (fbmL(vec2(hkm * 0.45, skm * 0.05) + uSeed * 1.7, 0.0, 2) - 0.5)
      + 0.6 * (fbmL(vec2(hkm * 0.7, skm * 0.12) + uSeed * 2.3, 0.0, 2) - 0.5); // and smaller cauliflower bumps
    // tower(centre km, half-width km, top km): flat-ish dome with steep, bulging sides.
    // tx: across the tower that sets the outline here, -1..1 (which side faces the sun).
    float tx = 0.0;
    #define TOWER(c, w, h, e) { float xs = (skm - (c) + bul) / (w); float pr = sqrt(max(1.0 - pow(abs(xs), e), 0.0)); if ((h) * pr > topk) { topk = (h) * pr; tx = xs; } }
    // The main column widens continuously up into the anvil (Ines r4: no neck or gap),
    // much further downwind than upwind.
    float xm = (skm - c0 + bul) * wSgn;
    float flare = pow(smoothstep(7.0, 11.8, hkm), 1.5) * (xm > 0.0 ? 17.0 : 4.0);
    TOWER(c0, 7.5 + flare, 12.4, 4.0)
    TOWER(c0 - 19.0 - 8.0 * rs.x, 5.5, 7.5 + 2.0 * rs.y, 2.5)
    TOWER(c0 + 13.0 + 5.0 * rs.y, 6.0, 9.0 + 2.0 * rs.z, 3.0)
    TOWER(c0 + 30.0 + 8.0 * rs.z, 4.5, 5.5 + 1.5 * rs.x, 2.0)
    // ...all rising out of one lower mass, so it reads as one cell with several heads.
    TOWER(c0 + 4.0 * rs.y, 32.0, 4.0 + 1.0 * rs.z, 8.0)
    #undef TOWER
    topk *= on;
    float mass = smoothstep(1.5, 6.0, topk); // how much tower stands here, 0..1
    topk += (1.6 * (und - 0.5) + 0.7 * (fbmL(vec2(skm * 0.45, 6.1) + uSeed, 0.0, 2) - 0.5)) * mass; // cauliflower heads
    // Crisp towers (Elena): a hard edge a few hundred metres deep (never under about a
    // pixel and a half), soft only where the column spreads downwind into the plume.
    float edgeK = max(0.3 + 1.1 * smoothstep(9.0, 12.0, hkm) * step(0.0, xm), fwidth(hkm) * 1.5);
    // No thin slivers where only the last few hundred metres of a tower clear the horizon.
    float body = (1.0 - smoothstep(topk - edgeK, topk, hkm)) * smoothstep(1.3, 1.5, hkm) * smoothstep(drop + 0.4, drop + 1.4, topk);
    float h01 = clamp((hkm - 1.4) / max(topk - 1.4, 0.1), 0.0, 1.0);
    // The anvil: a flat-topped shelf about three times the column's width, thick over the
    // tower and thinning to a fine edge, spread downwind (the wind across the line of sight).
    // A long plume about 30 km downwind that thins out, a short blunt edge about 11 km
    // upwind, a lumpy underside (Ines r4: never a smooth lens).
    float ax = (skm - c0) * wSgn;
    float rag = fbmL(vec2(skm * 0.07, 9.1) + uSeed, 0.0, 2);
    bool down = ax > 0.0;
    float q = abs(ax) / (down ? 30.0 : 11.0) + (down ? 0.3 : 0.1) * (rag - 0.5);
    float lump = fbmL(vec2(skm * 0.2, 3.3) + uSeed * 1.3, 0.0, 2);
    float lo = (down ? mix(9.2, 13.0, smoothstep(0.15, 1.0, q)) : mix(9.2, 11.6, smoothstep(0.2, 1.0, q)))
      + 0.8 * (lump - 0.5) * smoothstep(0.1, 0.4, q);
    float hi = down ? mix(13.6, 13.2, smoothstep(0.4, 1.0, q)) : 13.6;
    float edge = down ? 1.0 - smoothstep(0.5, 1.0, q) : 1.0 - smoothstep(0.7, 1.0, q);
    float anvil = edge * smoothstep(lo, lo + 0.5, hkm) * (1.0 - smoothstep(hi - (down ? 0.9 : 0.75), hi, hkm))
      * (down ? 1.0 - 0.7 * smoothstep(0.25, 1.0, q) : 1.0) // the plume thins, so pales, downwind
      * smoothstep(0.3, 0.8, uWall) * on;
    // Rain under the base, only below the towers: a few broad, soft curtains of different
    // widths and darkness, some ending before they reach the sea (Ines).
    float curtains = smoothstep(0.35, 0.75, fbmL(vec2(skm * 0.06 + hkm * 0.15 + uTime * 0.001, 0.4) + uSeed * 2.0, 0.0, 2));
    float reach = fbmL(vec2(skm * 0.08, 5.3) + uSeed, 0.0, 2); // how far down each one gets
    float under = smoothstep(0.2, 0.6, mass); // the base and its rain stay inside the cell
    float rain = under * (1.0 - smoothstep(1.4, 1.5, hkm)) * smoothstep(1.3 * (1.0 - reach) - 0.1, 1.3 * (1.0 - reach) + 0.1, hkm) * curtains;
    // Grey rain shafts falling to the sea from under the main column, slanting with the wind
    // (Elena: that is what makes it threatening).
    float shafts = smoothstep(0.3, 0.65, fbmL(vec2(skm * 0.2 + hkm * 0.35 * wSgn + uTime * 0.002, 1.7) + uSeed, 0.0, 2));
    float mainU = 1.0 - smoothstep(0.55, 1.05, abs(skm - c0) / 8.0);
    float rainMain = mainU * on * (1.0 - smoothstep(1.4, 1.5, hkm)) * shafts;
    rain = max(rain * 0.7, rainMain);
    // Colours: a slate-dark lower body (trouble), the heads lit white-grey by the sun, the
    // light climbing each lobe; everything hazier the further off it is.
    vec3 dark = mix(uHaze * 0.66, uBelly * 0.4, smoothstep(0.05, 0.6, uWall));
    vec3 lit = mix(uHaze, uLit * 1.8, 0.4 + 0.6 * sunUp); // sunlit tops brighter than the sky behind
    // A low sun warms the heads facing it with the sky's rose and gold (Ines r4).
    float facing = dot(nxz, normalize(uSunDir.xz + 1e-4));
    float lowWarm = smoothstep(-0.06, 0.0, uSunDir.y) * (1.0 - smoothstep(0.08, 0.3, uSunDir.y));
    lit = mix(lit, lit * 0.7 + uGlow * 0.55, lowWarm * (0.45 + 0.4 * smoothstep(-0.5, 0.8, facing)));
    float lobe = fbmL(vec2(skm * 0.22, hkm * 0.3) + uSeed, 0.0, 2); // km-sized billows
    float litK = smoothstep(0.2, 0.75, h01 + 0.2 * (lobe - 0.5) + 0.1 * (und - 0.5));
    vec3 wc = mix(dark, lit, litK);
    // Side light (Elena): a low sun across the line of sight lights the towers' sun side
    // rose-gold with bright rims and leaves the far side blue-grey; front-lit it all glows,
    // back-lit it all goes dark with a lit rim.
    vec2 sXZ = normalize(uSunDir.xz + 1e-4);
    float sAcross = dot(sXZ, vec2(uWallDir.y, -uWallDir.x)); // + : sun on the +tx side (checked in frames)
    float sBehind = dot(sXZ, uWallDir);                       // + : sun behind the storm
    // Which side the sun is on: full strength once it is more than about 15 degrees off.
    float sSide = clamp(sAcross * 4.0, -1.0, 1.0);
    float lowSun = 1.0 - smoothstep(0.25, 0.7, uSunDir.y);
    float lam = clamp(0.5 + 0.7 * tx * sSide - 0.2 * sBehind, 0.0, 1.0);
    vec3 cool = dark * 0.55 + uHaze * vec3(0.5, 0.6, 0.8) * 0.4; // the shadow side, blue-grey
    float sideL = lowSun * smoothstep(0.1, 0.5, h01) * body;
    wc = mix(wc, cool, sideL * (1.0 - smoothstep(0.1, 0.5, lam)) * 0.85);
    wc = mix(wc, lit * 1.15 + uGlow * 0.35 * lowWarm, sideL * smoothstep(0.5, 0.95, lam) * 0.7); // the sun side glows
    float nearTop = 1.0 - smoothstep(0.0, 0.9, topk - hkm);
    float rimK = nearTop * (smoothstep(0.0, 0.7, tx * sSide) + 0.5 * smoothstep(0.5, 0.95, sBehind)) * lowSun * smoothstep(0.3, 0.7, h01);
    wc += (uGlow * (0.5 + 1.0 * lowWarm) + lit * 0.4) * min(rimK, 1.0) * 1.2; // bright rims
    // The base: dark and flat.
    wc *= mix(0.62, 1.0, smoothstep(1.4, 3.4, hkm));
    // The anvil: sunlit along its flat top, a shaded grey underside.
    wc = mix(wc, mix(mix(dark, lit, 0.55), lit * 1.05, smoothstep(lo, hi, hkm)), anvil * (1.0 - body * 0.5));
    // Seen through hundreds of km of air: paler and bluer with distance.
    float air = 1.0 - exp(-D / 380.0);
    wc = mix(wc, uHaze, 0.8 * air);
    // Seen through gaps in nearer cumulus it is softened by their haze, not black shards.
    wc = mix(wc, uHaze * 0.9, 0.45 * cuAmt * smoothstep(0.0, 0.5, uCover + 0.2));
    vec3 rc = mix(mix(dark, uHaze, 0.5), dark, max(curtains * 0.6, shafts * mainU * 0.85));
    rc = mix(rc, uHaze, 0.8 * air);
    float wa = max(body, anvil * 0.8) * mix(0.55, 0.97, uWall) * (1.0 - 0.5 * air);
    float ra = max(rain * mix(0.35, 0.85, uWall), rainMain * mix(0.5, 0.95, uWall)) * (1.0 - 0.5 * air);
    wc = mix(wc, rc, ra * (1.0 - max(body, anvil)));
    wa = max(wa, ra);
    col += (1.0 - alpha) * wa * wc; alpha += (1.0 - alpha) * wa;
  }
  // A low sun behind a deck: the far edge of the cloud lights up warm along the horizon
  // towards it, the light coming in under the deck from clear sky beyond.
  float lowSun = smoothstep(-0.07, 0.0, uSunDir.y) * (1.0 - smoothstep(0.1, 0.35, uSunDir.y));
  float under = pow(max(dot(normalize(dir.xz), normalize(uSunDir.xz + 1e-4)), 0.0), 6.0) * (1.0 - smoothstep(0.0, 0.12, el));
  col += alpha * vec3(1.0, 0.62, 0.36) * under * lowSun * uLight * (0.25 + 0.35 * smoothstep(0.3, 0.9, uStorm + uCover)) * (1.0 - uBreak) * (1.0 - smoothstep(0.5, 4.0, uRain)); // the break takes over; not through a downpour
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
  float hb = (1.0 - smoothstep(-0.01, 0.025 + 0.035 * (frayN + 0.5), el)) * deckAmt;
  col += (1.0 - alpha) * uHaze * hb; alpha += (1.0 - alpha) * hb;
  col = mix(col, uBelly * 1.6 * alpha, rainC); // steel-grey curtains (Kai's, in the deck's colours)
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(col / max(alpha, 1e-3), alpha);
  // Same exposure and colour space as everything else when drawn straight to the screen
  // (Low, or no post-processing); no-ops when drawn into the post-processing target.
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  // Where the sky is haze it is the fog's own colour, put on after tone mapping as three
  // puts fog on the sea, so the fogged-out sea meets the sky without a line.
  float asFog = max(hz2 * deckAmt, hb);
  // At night the far sea's fog (the airglow band Yuki and I agreed) is lighter than the
  // clear sky just above it: feather the sky down into it over a couple of degrees, so it
  // reads as a glow, not a lit edge (Ines).
  float glowN = 1.0 - smoothstep(0.0, 0.035, el);
  asFog = max(asFog, glowN * glowN * (1.0 - uLight));
  // Under a deck the horizon settles on the tone the mist band above it draws (HORIZON_DECK x
  // haze), not the bare haze, which showed as a bright hairline over the sea (Ines, Priya).
  vec3 hzC = uHaze; // the same colour three fogs the far sea to, so the sea's fully fogged edge is no brighter line
  // gl_FragColor is in the output space here (sRGB on screen or in an sRGB target), so the haze
  // must be converted too, as three does for the sea's fog; written raw it came out ~2.5x dark.
  hzC = linearToOutputTexel(vec4(hzC, 1.0)).rgb;
  gl_FragColor = vec4(mix(gl_FragColor.rgb, hzC, asFog), max(gl_FragColor.a, asFog));
}`;

// The new cumulus's own half-resolution pass: the same functions, one view ray per texel.
const cuPassVert = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
void main() { vUv = uv; vWorld = vec3(0.0); gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const cuPassFrag =
  cloudFrag.split("void main()")[0] +
  /* glsl */ `
uniform mat4 uInvProj, uCamWorld;
varying vec2 vUv;
void main() {
  vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 dir = normalize(mat3(uCamWorld) * (v.xyz / v.w));
  vec2 sunH = uSunDir.xz / max(length(uSunDir.xz), 1e-3);
  vec4 c = cumulusVol(dir, dot(dir, uSunDir), dot(normalize(dir.xz + 1e-5), sunH), smoothstep(-0.06, 0.12, uSunDir.y));
  gl_FragColor = vec4(c.rgb * c.a, c.a); // premultiplied, for the read-back's filtering
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
  // The new cumulus: its half-resolution pass (see cuPassFrag).
  private cuRT = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  private cuScene = new THREE.Scene();
  private cuCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private cuOn = false;

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
        uSteel: { value: new THREE.Color() },
        uBelly: { value: new THREE.Color() },
        uBrk: { value: new THREE.Color() },
        uBreak: { value: 0 },
        uSeed: { value: new THREE.Vector2() },
        uMoon: { value: 0 },
        uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
        uWall: { value: 0 },
        uWallKm: { value: 400 },
        uCuNew: { value: CUMULUS_NEW ? 1 : 0 },
        uCuRT: { value: 0 },
        uCuTex: { value: null },
        uCuRes: { value: new THREE.Vector2(1, 1) },
        uCuTexSize: { value: new THREE.Vector2(1, 1) },
        uWallDir: { value: new THREE.Vector2(1, 0) },
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
    if (CUMULUS_NEW) {
      const pass = new THREE.ShaderMaterial({
        vertexShader: cuPassVert,
        fragmentShader: cuPassFrag,
        uniforms: { ...layer.uniforms, uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() } },
        depthTest: false,
        depthWrite: false,
      });
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), pass);
      quad.frustumCulled = false;
      this.cuScene.add(quad);
      layer.uniforms.uCuTex.value = this.cuRT.texture;
      const size = new THREE.Vector2();
      this.layer.onBeforeRender = (renderer, _scene, camera) => {
        if (!this.cuOn) return;
        const prev = renderer.getRenderTarget();
        if (prev) size.set(prev.width, prev.height);
        else renderer.getDrawingBufferSize(size);
        const div = (layer.uniforms.uQ.value as number) < 0.5 ? 4 : 2; // Low: quarter resolution (Kai)
        const w = Math.max(1, Math.ceil(size.x / div)), h = Math.max(1, Math.ceil(size.y / div));
        if (this.cuRT.width !== w || this.cuRT.height !== h) this.cuRT.setSize(w, h);
        (layer.uniforms.uCuTexSize.value as THREE.Vector2).set(w, h);
        pass.uniforms.uInvProj.value.copy((camera as THREE.PerspectiveCamera).projectionMatrixInverse);
        pass.uniforms.uCamWorld.value.copy(camera.matrixWorld);
        (layer.uniforms.uCuRes.value as THREE.Vector2).copy(size);
        renderer.setRenderTarget(this.cuRT);
        renderer.clear();
        renderer.render(this.cuScene, this.cuCam);
        renderer.setRenderTarget(prev);
      };
    }
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
    // Sunlit white by day, near black by night (the moon's glow is added in the shader).
    const lit = 0.03 + 0.97 * light * light;
    u.uLit.value.setRGB(lit, lit, lit * 1.02);
    u.uShade.value.copy(haze).multiplyScalar(0.42 + 0.2 * light);
    u.uHaze.value.copy(haze);
    // Sun's height from its direction: glow from just before sunset until it is well down.
    const el = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(sunDir.y, -1, 1)));
    u.uWarm.value = SM(el, -7, -1) * (1 - SM(el, 3, 16)) * (1 - storm);
    // Orange while the sun is up, rose after it has gone.
    u.uGlow.value.setRGB(1.0, 0.5, 0.25).lerp(ROSE, 1 - SM(el, -3, 1)).multiplyScalar(0.9);
    // Hana: the deck's own colours and the break, from the haze's brightness (so they sit in
    // the same exposure as the sea) but cold steel in hue, whatever the hour.
    const sk = skyColours(haze, el, storm, this.cover);
    u.uSteel.value.copy(sk.steel);
    u.uBelly.value.copy(sk.belly);
    u.uBrk.value.copy(sk.brk);
    u.uBreak.value = sk.brk_amount;
    this.layer.visible = true; // always a few fair-weather clouds, at least
    {
      const deck = Math.max(SM(this.cover, 0.55, 0.95), SM(storm, 0.15, 0.7), SM(this.rain, 0.05, 0.8));
      const cuAmt = (1 - SM(Math.max(storm, this.cover), 0.55, 0.95)) * (1 - deck);
      this.cuOn = CUMULUS_NEW && cuAmt > 0.01; // as the shader's cuAmt
      u.uCuRT.value = this.cuOn ? 1 : 0;
    }

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
    // The colour the sky actually draws at the horizon (the shader's hzC), so the sea can meet it.
    const k = 1 - (1 - HORIZON_DECK) * deck;
    return out.set(h.r * k, h.g * k, h.b * k, deck);
  }

  /**
   * The break for the sea to mirror (Hana): rgb the warm light low in the sky on the sun's
   * bearing (linear, the same space as the fog colour; brightest at the horizon), w how
   * strong the break is now (0 none .. 1 full). The sea should mirror it only for reflected
   * rays near the horizon on the sun's bearing (smoothstep(0.35, 0.97, cos of the bearing
   * difference), as the sky draws it), and under a deck its sun glitter should be this
   * colour in a narrow column, not white (Sam's rule: no white glitter under a full deck).
   */
  seaBreak(out: THREE.Vector4): THREE.Vector4 {
    const u = this.layer.material.uniforms;
    const c = u.uBrk.value as THREE.Color;
    return out.set(c.r * 1.85, c.g * 1.85, c.b * 1.85, u.uBreak.value as number);
  }

  /**
   * A storm on its way (Ravi's stormFromBoat: compass bearing and km to its centre), or
   * null for none. Its wall of cloud shows low on the horizon on that bearing from about
   * 900 km, growing until it is overhead at about 150 km.
   */
  setStorm(storm: { bearing: number; km: number } | null): void {
    const u = this.layer.material.uniforms;
    u.uWall.value = storm ? stormWall(storm.km) : 0;
    if (storm && Number.isFinite(storm.km)) u.uWallKm.value = storm.km;
    if (storm) {
      const b = THREE.MathUtils.degToRad(storm.bearing);
      (u.uWallDir.value as THREE.Vector2).set(Math.sin(b), -Math.cos(b)); // scene x east, z south
    }
  }

  /** A different sky for each voyage: the same voyage always gets the same one. */
  seed(n: number): void {
    const h = (k: number) => {
      const x = Math.sin(n * 12.9898 + k * 78.233) * 43758.5453;
      return x - Math.floor(x);
    };
    this.layer.material.uniforms.uSeed.value.set(h(1) * 40, h(2) * 40);
  }

  /** The moon (unit vector) and its light 0..1 (atmosphere.moonDir, moonlight): it glows through thin cloud. */
  setMoon(dir: THREE.Vector3, light: number): void {
    const u = this.layer.material.uniforms;
    u.uMoonDir.value.copy(dir);
    u.uMoon.value = light;
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
    // (about 400 m by 6 mm/h). Eased in log distance so the close-in is even, not sudden.
    const mist = 0.55 * SM(this.rain, 0.05, 0.7) + 0.45 * SM(this.rain, 1, 6);
    if (mist > 0) {
      const far = Math.exp(THREE.MathUtils.lerp(Math.log(fog.far), Math.log(400), mist));
      fog.far = Math.min(fog.far, far);
      fog.near = Math.min(fog.near, THREE.MathUtils.lerp(fog.near, 20, mist));
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
