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
uniform float uBreak, uMoon, uWall;
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
  vec2 w = r + 0.35 * vec2(vnoise(r * 0.5 + 2.7), vnoise(r * 0.5 + 6.1));
  float big = cells(w * 1.9);
  float bumps = cells(w * 5.2 + 7.3);
  float mass = fbmL(w * 0.7, lod, max(oct - 1, 2));
  float k = 1.0 - smoothstep(0.2, 0.9, lod); // cells blur away with distance
  float v = 0.46 * big * k + 0.14 * bumps * (1.0 - smoothstep(0.0, 0.5, lod)) + 0.5 * mass - 0.04;
  return mix(0.5, v, 1.0 - 0.6 * lod) + 0.01;
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
  float deckAmt = max(max(smoothstep(0.55, 0.95, uCover), smoothstep(0.15, 0.7, uStorm)), smoothstep(0.1, 1.5, uRain));
  float cuAmt = (1.0 - smoothstep(0.55, 0.95, max(uStorm, uCover))) * (1.0 - deckAmt);
  if (cuAmt > 0.01 && alpha < 0.99) {
    vec2 q = onLayer(dir, 1200.0) + uDrift;
    float dist = length(q - uDrift - uCam.xz);
    float lod = footprint(dist, el, 700.0);
    vec2 p = q / 1800.0;
    vec2 w = p + 0.45 * vec2(vnoise(p * 0.8 + 3.1), vnoise(p * 0.8 + 8.3));
    // Hana: separate rounded heaps (cells) with knobbly detail, blue sky between them.
    float heaps = cells(w * 1.15 + uSeed);
    float n = mix(0.5 * heaps + 0.5 * fbmL(w, lod, oct) + 0.05, 0.45, lod);
    float edge = 1.0 - (0.3 + 0.42 * uCover);
    float d = smoothstep(edge - 0.004, edge + 0.025 + 0.4 * lod, n); // crisp cauliflower edge
    // Far heaps thin out into the clear sky's own horizon (not into the fog colour, which is darker).
    d *= 1.0 - smoothstep(9000.0, 30000.0, dist);
    if (d > 0.003) {
      float thick = smoothstep(edge, edge + 0.28, n);
      // The heap's surface direction from its own shape: up its slope towards the middle.
      float shade = 0.5;
      if (uQ > 0.5) {
        vec2 sunH = uSunDir.xz / max(length(uSunDir.xz), 1e-3);
        float toward = (0.5 * cells((w + sunH * 0.08) * 1.15 + uSeed) + 0.5 * fbmL(w + sunH * 0.08, lod, oct) + 0.05) - n;
        shade = clamp(0.5 * thick + 2.4 * toward, 0.0, 1.0);
      } else shade = 0.3 + 0.4 * thick;
      float side = smoothstep(2500.0, 12000.0, dist); // far off you see the sunlit sides, not the base
      // Overhead: thin rims glow white with the sun through them, thick middles are the flat grey base.
      float baseShade = mix(0.15 + 0.6 * thick + 0.25 * shade, shade * (0.25 + 0.75 * smoothstep(-0.3, 0.6, facing)), side);
      // Golden hour: sunlit sides go warm gold, the shade stays cool blue-grey.
      float gold = smoothstep(0.0, 0.06, uSunDir.y) * (1.0 - smoothstep(0.14, 0.45, uSunDir.y));
      // (the flat bases overhead see the blue sky more than the sun: they stay neutral)
      // Sunlit tops bright white; at golden hour gold on the sun side, pink further round.
      vec3 goldC = mix(vec3(1.3, 0.85, 0.72), vec3(1.35, 1.0, 0.62), smoothstep(-0.2, 0.7, facing));
      vec3 lit = uLit * 1.3 * mix(vec3(1.0), goldC, gold * (0.6 + 0.4 * side));
      // Shade is cool blue-grey (lit by the blue sky), never the haze's warm brown.
      vec3 cool = dot(uShade, vec3(0.2126, 0.7152, 0.0722)) * vec3(0.84, 0.92, 1.1);
      vec3 c = mix(lit, mix(uShade, cool, 0.75), clamp(baseShade, 0.0, 1.0));
      c += lit * pow(max(facing, 0.0), 6.0) * (1.0 - thick) * 0.9 * sunUp; // silver lining
      // Once the sun is on the horizon or below it, the undersides glow orange then rose.
      c += uGlow * uWarm * 0.6 * smoothstep(-0.2, 0.8, facing) * (1.0 - 0.45 * thick) * (1.0 - smoothstep(0.0, 0.06, uSunDir.y));
      c = mix(c, uHaze, 0.5 * smoothstep(4000.0, 26000.0, dist));
      d *= cuAmt;
      col += (1.0 - alpha) * d * c; alpha += (1.0 - alpha) * d;
    }
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
  float hz = (1.0 - smoothstep(0.0, mix(0.16, 0.07, deckAmt), el)) * (1.0 - 0.75 * brkSide); // the break stays bright
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
    float az = atan(dir.z, dir.x);
    float on = smoothstep(mix(0.82, 0.35, uWall), 1.0, dot(normalize(dir.xz + 1e-5), uWallDir));
    // A thunderstorm seen from afar (Ines: never a coastline): towering heaps with bright
    // sunlit tops and an anvil spreading at the top, a dark flat base lifted off the
    // horizon, and soft grey rain curtains hanging from it with paler sky between them.
    // Outline: a few broad heaps, smaller turrets on them, cauliflower lumps along the rim.
    float az1 = az + uTime * 0.0005;
    float towers = 0.55 * cells(vec2(az1 * 5.0, 0.3) + uSeed) + 0.3 * cells(vec2(az1 * 13.0, 1.7) + uSeed) + 0.15 * cells(vec2(az1 * 31.0, 2.9) + uSeed);
    towers = towers * towers;
    float rim = cells(vec2(az1 * 70.0, el * 150.0) + uSeed * 3.0);
    float top = mix(0.03, 0.2, uWall) * (0.15 + 0.85 * towers) * (0.4 + 0.6 * on) * (0.85 + 0.15 * rim);
    // The base: flat, a little ragged, lifted off the horizon.
    float base = mix(0.008, 0.028, uWall) * (0.8 + 0.4 * fbmL(vec2(az1 * 30.0, 4.1) + uSeed, 0.0, 2));
    float h01 = clamp((el - base) / max(top - base, 1e-4), 0.0, 1.0);
    float body = on * smoothstep(base - 0.002, base + 0.002, el) * (1.0 - smoothstep(top * 0.97, top * 1.03, el));
    // The anvil: a thinner, wider shelf at the top, brightest of all.
    float onA = smoothstep(mix(0.9, 0.3, uWall), 1.0, dot(normalize(dir.xz + 1e-5), uWallDir));
    float topA = mix(0.03, 0.2, uWall) * 0.8;
    float anvil = onA * smoothstep(topA * 0.84, topA * 0.9, el) * (1.0 - smoothstep(topA * 0.97, topA * 1.04, el)) * smoothstep(0.3, 0.8, uWall);
    // Rain under the base: soft slanting veils with paler gaps, fading into the sea haze.
    float curtains = smoothstep(0.3, 0.75, fbmL(vec2(az1 * 9.0 + el * 25.0 + uTime * 0.002, el * 30.0) + uSeed * 2.0, 0.0, 3));
    float rain = on * (1.0 - smoothstep(base - 0.004, base + 0.002, el)) * smoothstep(-0.004, base * 0.8, el) * (0.15 + 0.55 * curtains);
    vec3 dark = mix(uHaze * 0.75, uBelly * 0.75, smoothstep(0.05, 0.6, uWall));
    vec3 lit = mix(uHaze, uLit * 1.45, 0.4 + 0.6 * sunUp);
    // Each lump lit on top and shaded under, so the towers read as heaped cloud.
    float lump = cells(vec2(az1 * 28.0, el * 90.0) + uSeed);
    float litK = smoothstep(0.0, 0.45, h01 + 0.15 * (lump - 0.5));
    vec3 wc = mix(dark, lit, litK);
    wc *= 0.8 + 0.2 * mix(1.0, lump, smoothstep(0.1, 0.5, h01));
    wc = mix(wc, lit * 1.05, anvil);
    vec3 rc = mix(uHaze * 0.9, dark * 1.1, curtains);
    float wa = max(body, anvil * 0.8) * mix(0.55, 0.97, uWall);
    float ra = rain * mix(0.35, 0.8, uWall);
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
  float hb = (1.0 - smoothstep(-0.01, 0.03, el)) * deckAmt;
  col += (1.0 - alpha) * uHaze * hb; alpha += (1.0 - alpha) * hb;
  col = mix(col, uBelly * 1.6 * alpha, rainC); // steel-grey curtains (Kai's, in the deck's colours)
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(col / max(alpha, 1e-3), alpha);
  // Same exposure and colour space as everything else when drawn straight to the screen
  // (Low, or no post-processing); no-ops when drawn into the post-processing target.
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
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
        uSteel: { value: new THREE.Color() },
        uBelly: { value: new THREE.Color() },
        uBrk: { value: new THREE.Color() },
        uBreak: { value: 0 },
        uSeed: { value: new THREE.Vector2() },
        uMoon: { value: 0 },
        uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
        uWall: { value: 0 },
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
    const want = Math.max(this.dayCover, SM(storm, 0.1, 0.7), SM(this.rain, 0.1, 1.5));
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
    const deck = Math.max(SM(this.cover, 0.55, 0.95), SM(u.uStorm.value as number, 0.15, 0.7), SM(this.rain, 0.1, 1.5));
    return out.set(h.r, h.g, h.b, deck);
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

  /** How much the rain hides the sun, 0..1 (for the atmosphere's light): from 0.5 mm/h, all by 4. */
  get rainShade(): number {
    return SM(this.rain, 0.5, 4);
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
    // Heavy rain is a mist of its own: the horizon goes and the haze closes to a few km
    // (about 2.5 km in a 10 mm/h downpour), on the same haze colour as the sea's far fade.
    const mist = SM(this.rain, 2, 10);
    fog.near = Math.min(fog.near, THREE.MathUtils.lerp(fog.near, 60, mist));
    fog.far = Math.min(fog.far, THREE.MathUtils.lerp(fog.far, 2500, mist));
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
