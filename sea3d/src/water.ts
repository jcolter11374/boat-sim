// The sea surface mesh: the same Gerstner sea as waves.ts, drawn with a grid
// that is fine near the boats and stretches out to the horizon.
//
// The grid's cells grow with distance from the boat. Every wave train moves the
// vertices wherever the cells are small enough to draw it (five or more to its
// wavelength): near the boat all of them, a few hundred metres out the long
// swells only, so the big seas run on towards the horizon instead of flattening
// out (Elena: a crest should rise above the skyline from a low camera). The
// fragment shader adds the slope of the trains the grid leaves out. The shader adds
// what the grid is too coarse to carry: small ripples and sun glitter, long
// swell texture in the distance, light glowing through the wave tops, and
// patchy whitecap foam. All of that is looks only; the physics reads waves.ts.
//
// The waves are moved on the graphics card (vertex shader), with the same
// Gerstner maths as waves.ts displace(): the page used to do it in JavaScript
// for every vertex every frame, which made High stutter.

import * as THREE from "three";
import type { Quality } from "./boats/parts";
import { MAX_GPU_WAVES, gpuWaves, heightAt, type WaveComponent } from "./waves";
import { PLACE } from "./land/place";
import { foamStreaks, whiteCrests } from "./storm";
import { SEA_SURFACE_PARS, seaUniforms, writeSeaUniforms } from "./seaSurface";
import { RAIN_RINGS, rainUniforms } from "./rainRings";
import { ShortWaveLayer, windSeaFrom, type Detail } from "./seaDetail";
import { BOAT_WASH_FRAGMENT, BOAT_WASH_PARS, BOAT_WASH_VERTEX, washUniforms } from "./boatWash";

// The hulls' wash, all of it off on Low (the sea there is Low's whole frame budget).
const WASH_PARS_FULL = `\n#ifndef SEA_LITE\n${BOAT_WASH_PARS}\n#endif\n`;
const MAX_WAVES = MAX_GPU_WAVES; // wave trains the shader can carry

export const SEA_SIZE = 400; // m, side of the patch of moving sea
// m, half-width of the whole sea out to the horizon; off real land (?place=) it
// reaches the islands tens of km away.
export const HORIZON = PLACE ? 60000 : 3000;
const GRID: Record<Quality, { n: number; centre: number }> = {
  low: { n: 110, centre: 0.45 }, // segments per side, grid spacing at the centre (m)
  high: { n: 288, centre: 0.2 },
};
// Whitecaps and lighting change to their far-off look between these distances (m).
const FADE_IN = 100;
const FADE_OUT = 170;
// The waves lie down before the grid's last, very long cells (m).
const FLAT_IN = 2000;
const FLAT_OUT = 2800;

// The sea hides what's under it (Elena's fix 3): at 0.95 every keel and pod showed as a
// dark stilt from above, the sky drawn behind the sea being brighter than the hull. What
// shows just under the surface comes from the hull side instead (boats/inWater.ts).
const SEA_OPACITY = 1;
const DEEP = new THREE.Color(0x041d33);
const SHALLOW = new THREE.Color(0x135a7e);
// Chesapeake Bay water: shallow and full of silt and plankton, a green-grey, not
// the ocean's blue (Elena). GUESS colours, matched by eye to Bay photographs.
const BAY_DEEP = new THREE.Color(0x1f3326); // silt scatters light back up: paler, greener than ocean
const BAY_SHALLOW = new THREE.Color(0x3a5340);

/** Inside Chesapeake Bay (west of the line from Cape Charles to Cape Henry), roughly. */
export function inChesapeake(lat: number, lon: number): boolean {
  return lat > 36.85 && lat < 39.65 && lon > -77.4 && lon < -75.97;
}

// How much of a wave train (wavenumber k) a grid of this spacing draws: all of
// it with five or more cells to the wavelength, none below three.
const CARRY = /* glsl */ `
// Low (detail "off") compiles without the short-wave code at all, to stay in its frame budget (Maya).
#ifdef SEA_LITE
#define SEA_DET_N 0
#else
#define SEA_DET_N uSeaDetN
#endif
// A train is carried by the grid only with 5+ cells per wavelength: fewer alias into curved moire arcs (Ines).
float seaCarry(float k, float cell) { return 1.0 - smoothstep(0.12, 0.2, k * cell * 0.15915494); }
`;

const VERT_HEAD = SEA_SURFACE_PARS + CARRY + /* glsl */ `
attribute float fade;      // 1 where the waves move the grid, 0 at the flat edge
attribute float cell;      // the grid's spacing here (m)
attribute float edge;      // 1 on the grid's outer rim: lifted to the eye's level so it meets the horizon
uniform float uAmp;        // Hs / 2
uniform float uFoamAmt;    // crest foam, 0..1
uniform float uTime;
uniform int uN;            // wave trains in use
uniform float uQ;          // sideways (trochoidal) scale so crests never fold
uniform vec4 uWa[${MAX_WAVES}]; // amplitude, k, omega, phase
uniform vec2 uWd[${MAX_WAVES}]; // direction of travel (x, z)
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform float uStorm;      // 0 fair .. 1 a gale: the sea goes slate-dark and heavy (Elena)
varying vec3 vWPos;
varying float vFoam;
varying float vCrest;
varying float vFade;
#ifndef SEA_LITE
varying float vCell;
#endif
vec3 gDisp;
vec3 gNorm;
// Same as waves.ts displace(), plus the surface slope for the normal.
void gerstner(vec2 p, float w) {
  vec3 d = vec3(0.0);
  vec3 tx = vec3(1.0, 0.0, 0.0);
  vec3 tz = vec3(0.0, 0.0, 1.0);
  if (w > 0.0) {
    for (int i = 0; i < ${MAX_WAVES}; i++) {
      if (i >= uN) break;
      vec4 a = uWa[i];
      vec2 u = uWd[i];
      float th = a.y * dot(u, p) - a.z * uTime + a.w;
      float s = sin(th), c = cos(th);
      float k = a.y;
#ifdef SEA_LITE
      float amp = a.x;
#else
      float amp = a.x * seaCarry(k, cell); // trains too short for the cells here are left to the shading
#endif
      float qa = uQ * amp;
      d += vec3(-qa * u.x * s, amp * c, -qa * u.y * s);
      tx += vec3(-qa * k * u.x * u.x * c, -amp * k * u.x * s, -qa * k * u.x * u.y * c);
      tz += vec3(-qa * k * u.x * u.y * c, -amp * k * u.y * s, -qa * k * u.y * u.y * c);
    }
  }
  gDisp = d * w;
  // The FFT short waves (seaDetail.ts) move the near sea on Medium and High.
  if (SEA_DET_N > 0) gDisp += seaDetDisplace(p) * w * (1.0 - smoothstep(0.6, 2.0, cell));
  tx = mix(vec3(1.0, 0.0, 0.0), tx, w);
  tz = mix(vec3(0.0, 0.0, 1.0), tz, w);
  gNorm = normalize(cross(tz, tx));
}
`;
const VERT_NORMAL = /* glsl */ `
gerstner(position.xz, fade);
objectNormal = gNorm;
#ifndef SEA_LITE
{
  // The hulls' own waves (boatWash.ts) tilt the surface too (not on Low: five boatWave
  // calls a vertex was Low's frame budget; Ravi, 12 Nov).
  vec2 pw = (modelMatrix * vec4(position + gDisp, 1.0)).xz;
  float e = 0.08;
  float dx = (boatWave(pw + vec2(e, 0.0)) - boatWave(pw - vec2(e, 0.0))) / (2.0 * e);
  float dz = (boatWave(pw + vec2(0.0, e)) - boatWave(pw - vec2(0.0, e))) / (2.0 * e);
  objectNormal = normalize(objectNormal + vec3(-dx, 0.0, -dz));
}
#endif
`;
const VERT_POS = /* glsl */ `
transformed += gDisp;
#ifndef SEA_LITE
${BOAT_WASH_VERTEX}
#endif
// The sea is flat, so its rim (3 km off) would sit a few pixels under the horizon with a
// sliver of sky below it (Ines's hairline). Lift the rim to the eye's own level: the
// last stretch then rises to the horizon line and fades into the haze there.
// No branch: edge is 0 or 1, and a mix costs Low (software graphics) less than an if.
transformed.y = mix(transformed.y, cameraPosition.y - 1e-4 * length(transformed.xz - cameraPosition.xz), edge);
`;
const VERT_BODY = /* glsl */ `
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vFade = fade;
#ifndef SEA_LITE
vCell = cell;
#endif
float hRel = uAmp > 0.0 ? gDisp.y / uAmp : 0.0; // about -2..2
vCrest = clamp(gDisp.y / max(uAmp, 0.05), -1.0, 1.5);
vFoam = uFoamAmt > 0.0 ? uFoamAmt * smoothstep(0.4, 1.3, hRel) : 0.0;
#ifdef USE_COLOR
  // Deep in the troughs, lighter on the faces; slate and heavy in a blow.
  vec3 deep = mix(uDeep, vec3(0.035, 0.07, 0.09), uStorm);
  vec3 shallow = mix(uShallow, vec3(0.13, 0.22, 0.25), uStorm);
  vColor.rgb = mix(deep, shallow, clamp(0.5 + 0.3 * (1.0 + 0.5 * uStorm) * hRel, 0.0, 1.0)); // deeper troughs in a gale (Ines)
#endif
`;

const POINT_LIGHTS_IF = "#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )";
/** The light loop without point lights (the deck light lights the boat, not the sea). */
const LIGHTS_NO_POINT = THREE.ShaderChunk.lights_fragment_begin.replace(POINT_LIGHTS_IF, "#if 0");

const FRAG_HEAD = SEA_SURFACE_PARS + CARRY + /* glsl */ `
uniform float uStorm;
uniform float uBay;       // 0 ocean .. 1 Chesapeake Bay: murky green-grey water that mirrors less blue
uniform float uTime;
uniform vec2 uFlow;       // water gone past the boat (m), so foam lanes and noise drift with it
uniform vec3 uSunDir;
uniform float uSunI;
uniform vec3 uGlow;
uniform float uRough;
uniform float uRoughFar;  // the far sea's glitter spread from the wind (Cox and Munk 1954: slope variance ~ 0.003 + 0.005 U)
uniform float uCover;
uniform float uStreak;
uniform vec4 uWreck;      // a wreck on the bottom: x, z, half its length, half its beam (m)
uniform vec2 uWreckK;     // how clearly it shows (0 = not at all), how deep it lies (m)
uniform vec2 uWind;
uniform float uChop;
uniform int uN;
uniform float uQ;
uniform vec4 uWa[${MAX_WAVES}];
uniform vec2 uWd[${MAX_WAVES}];
uniform sampler2D tMirror;
uniform mat4 uMirrorM;
uniform float uMirror;
uniform float uMirrorY;
varying vec3 vWPos;
varying float vFoam;
varying float vCrest;
varying float vFade;
#ifndef SEA_LITE
varying float vCell;
#endif

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
// Slope (d height / dx, d height / dz) of one deep-water ripple train.
vec2 ripple(vec2 p, float L, float ang, float slope, float t) {
  float k = 6.2831853 / L;
  vec2 d = vec2(cos(ang), sin(ang));
  float ph = k * dot(d, p) - sqrt(9.81 * k) * t;
  return d * (slope * cos(ph));
}
// Sum of ripple trains, each faded out once it is too small for the pixel
// (so the distance doesn't shimmer), plus long swell texture far out where the
// grid itself is flat.
vec2 rippleSlope(vec2 p, float t, float fp, float far) {
  vec2 g = vec2(0.0);
  float patchy = 0.55 + 0.9 * vnoise(p * 0.035 + t * 0.02);
  g += ripple(p, 0.33, 0.4, 0.035, t) * smoothstep(1.5, 5.0, 0.33 / fp);
  g += ripple(p, 0.57, 2.1, 0.032, t) * smoothstep(1.5, 5.0, 0.57 / fp);
  g += ripple(p, 0.91, 3.9, 0.03, t) * smoothstep(1.5, 5.0, 0.91 / fp);
  g += ripple(p, 1.63, 5.3, 0.028, t) * smoothstep(1.5, 5.0, 1.63 / fp);
  g += ripple(p, 2.71, 1.2, 0.025, t) * smoothstep(1.5, 5.0, 2.71 / fp);
  g += ripple(p, 4.30, 4.6, 0.022, t) * smoothstep(1.5, 5.0, 4.30 / fp);
  g *= patchy * uRough;
  // Wind chop (High and up): short-crested waves a few metres long, spread
  // round the wind, so the swell's long regular lines break up like real sea.
  if (uChop > 0.0) {
    float wa = atan(uWind.y, uWind.x);
    vec2 c = ripple(p, 2.3, wa + 0.35, 0.05, t) * smoothstep(1.5, 5.0, 2.3 / fp)
           + ripple(p, 3.1, wa - 0.62, 0.05, t) * smoothstep(1.5, 5.0, 3.1 / fp)
           + ripple(p, 4.4, wa + 0.95, 0.045, t)
           + ripple(p, 5.9, wa - 0.18, 0.045, t)
           + ripple(p, 7.7, wa + 1.25, 0.04, t)
           + ripple(p, 9.6, wa - 1.05, 0.04, t);
    float gust = 0.6 + 0.8 * vnoise(p * 0.02 + uWind * t * 0.03); // patches of stronger wind
    g += c * uChop * gust * (1.0 - far);
  }
  return g;
}
// The finest wind texture, under anything the FFT draws: ripples from 12 cm to
// 2 m spread round the wind, in gusty patches (catspaws) that drift downwind,
// growing with the wind (Elena: storm water is covered in small sharp chop,
// never smooth gel). Each train fades once it is too small for the pixel.
vec2 microSlope(vec2 p, float t, float fp) {
  float wa = atan(uWind.y, uWind.x);
  // Warped at two scales, so no train runs ruler-straight and no beat pattern repeats.
  vec2 pw = p + 0.9 * vec2(vnoise(p * 0.31), vnoise(p * 0.31 + 4.0)) + 0.3 * vec2(vnoise(p * 1.7 + 2.0), vnoise(p * 1.7 + 6.0));
  vec2 g = vec2(0.0);
  float L = 0.12;
  for (int i = 0; i < 11; i++) {
    // Light airs scatter ripples every way; a breeze lines them up (Ines: no parallel rows in a calm).
    float ang = wa + mix(2.6, 1.3, smoothstep(0.15, 0.6, uRoughFar)) * sin(float(i) * 2.399);
    float amp = 0.3 + 1.4 * vnoise(p * (0.9 / L) * 0.15 + float(i) * 7.3); // each train comes and goes in patches
    g += ripple(pw, L, ang, 0.045 * amp, t) * smoothstep(2.0, 6.0, L / fp);
    L *= 1.32;
  }
  float gust = 0.45 + 1.0 * smoothstep(0.3, 0.8, vnoise(p * 0.025 - uWind * t * 0.04 + 9.0));
  return g * gust * max(uRoughFar, 0.3); // even light airs keep fine ripples near the lens (Ines: title hero)
}
// Out where the grid is flat, the same wave trains the near sea moves with,
// carried on in the shading only: their slopes, each faded out once it is too
// short for the pixel. So the sea keeps its real, irregular pattern to the
// horizon instead of a few regular bands, and there is no seam where the
// moving patch ends. Wave groups: the trains beat against each other already;
// a slow patchiness on top keeps big stretches from looking the same.
vec2 swellSlope(vec2 p, float t, float fp) {
  vec2 g = vec2(0.0);
  for (int i = 0; i < ${MAX_WAVES}; i++) {
    if (i >= uN) break;
    vec4 a = uWa[i];
    vec2 u = uWd[i];
    float th = a.y * dot(u, p) - a.z * t + a.w;
    float L = 6.2831853 / a.y;
#ifdef SEA_LITE
    float left = 1.0; // Low: weighted once, outside the loop (as main)
#else
    float left = 1.0 - vFade * seaCarry(a.y, vCell); // what the grid didn't draw
    if (left < 0.01) continue;
#endif
    g -= u * (a.x * a.y * sin(th)) * smoothstep(1.5, 6.0, L / fp) * left;
  }
  return g * (0.75 + 0.5 * vnoise(p * 0.004 + t * 0.003));
}
vec3 seaColdSky(vec3 c) {
  // Under a gale's overcast the sea mirrors grey cloud, not the clear sky the
  // reflections are lit from: greyer and darker (Elena: slate, not pale blue).
  float lumS = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(c, lumS * vec3(0.9, 0.96, 1.0) * 0.5, uStorm);
  // Rain greys it further: a paler, flatter sea under a shower (Ines).
  c = mix(c, dot(c, vec3(0.2126, 0.7152, 0.0722)) * vec3(0.95, 0.98, 1.0), 0.7 * uRain.x);
  float low = 1.0 - smoothstep(0.12, 0.45, uSunDir.y);
  if (low <= 0.0) return c;
  vec3 Vs = normalize(cameraPosition - vWPos);
  float path = pow(max(dot(normalize(-Vs.xz + 1e-5), normalize(uSunDir.xz + 1e-5)), 0.0), 6.0);
  path *= (1.0 - uRain.x) * (1.0 - uSeaSky.w); // no warm path through rain or a closed deck
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return mix(c, lum * vec3(0.86, 0.95, 1.06), low * (1.0 - path) * 0.85);
}
`;

const FRAG_COLOUR = /* glsl */ `
// Rain and a closed cloud deck take the colour out of the water itself too:
// paler and greyer, not a saturated blue under a downpour (Ines, Kai).
#ifndef SEA_LITE
if (uRain.x > 0.0 || uSeaSky.w > 0.0) { // uniform branch: a clear day pays nothing
  float grey = max(0.65 * uRain.x, 0.8 * uSeaSky.w); // no bright blue under cloud (Sam, Ines)
  float lumW = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(lumW * 1.25) * vec3(0.93, 0.97, 1.0), grey);
}
#endif
float distXZ = length(vWPos.xz - cameraPosition.xz);
// A wreck on the bottom, seen as a dark shape through clear, calm water; the
// surface's movement makes it waver, and the deeper it lies the softer it is.
float wreckShade = 0.0;
float wreckRim = 0.0;
if (uWreckK.x > 0.001) {
  vec2 pw = vWPos.xz - uWreck.xy;
  pw += (vec2(vnoise(vWPos.xz * 0.15 + uTime * 0.4), vnoise(vWPos.xz * 0.15 - uTime * 0.35 + 3.0)) - 0.5) * (0.4 + 0.02 * uWreckK.y);
  vec2 aw = abs(pw);
  // A hull: a long rounded shape, lying north-south (its real heading isn't in our sources).
  float dw = length(max(aw - vec2(0.0, uWreck.z - uWreck.w), 0.0)) - uWreck.w;
  float soft = 0.4 + 0.03 * uWreckK.y;
  float inside = 1.0 - smoothstep(-soft, soft, dw);
  float rim = 1.0 - smoothstep(0.0, soft, abs(dw - soft));
  wreckShade = uWreckK.x * 0.6 * inside;
  wreckRim = uWreckK.x * rim;
}
float farMix = smoothstep(${FADE_IN.toFixed(1)}, ${FADE_OUT.toFixed(1)}, length(vWPos.xz)) ;
// The FFT short waves (seaDetail.ts): each patch fades to its average once its
// texels are smaller than the pixel, so the distance doesn't shimmer.
vec4 detA = vec4(0.0);
vec4 detB = vec4(0.0, 0.0, 1.0, 0.0);
float detFar = 1.0;
if (SEA_DET_N > 0) {
  // Footprint by area, not the long axis, so the detail holds on at a glancing angle.
  vec2 fdx = dFdx(vWPos.xz), fdy = dFdy(vWPos.xz);
  float fpD = max(mix(sqrt(length(fdx) * length(fdy)), max(length(fdx), length(fdy)), 0.55), 1e-4);
  float tx0 = uSeaDetSize.x / uSeaDetRes;
  float w0 = 1.0 - smoothstep(0.8 * tx0, 3.0 * tx0, fpD);
  vec4 a0 = texture2D(uSeaDetA0, seaDetUv0(vWPos.xz));
  vec4 b0 = texture2D(uSeaDetB0, seaDetUv0(vWPos.xz));
  detA = a0 * w0;
  detB = vec4(b0.xy * w0, mix(1.0, b0.z, w0), 0.0);
  detFar = 1.0 - w0;
  // Foam left behind a breaking crest as it runs on downwind: brightest at the
  // breaking edge, trailing off behind it.
  vec2 wdn = normalize(uWind + vec2(1e-5));
  float trail = texture2D(uSeaDetA0, seaDetUv0(vWPos.xz + wdn * 0.8)).w * 0.75;
  trail = max(trail, texture2D(uSeaDetA0, seaDetUv0(vWPos.xz + wdn * 1.7)).w * 0.5);
  trail = max(trail, texture2D(uSeaDetA0, seaDetUv0(vWPos.xz + wdn * 2.7)).w * 0.3);
  detA.w = max(detA.w, trail * w0);
  if (SEA_DET_N > 1) {
    float tx1 = uSeaDetSize.y / uSeaDetRes;
    float w1 = 1.0 - smoothstep(0.8 * tx1, 3.0 * tx1, fpD);
    vec4 a1 = texture2D(uSeaDetA1, seaDetUv1(vWPos.xz));
    vec4 b1 = texture2D(uSeaDetB1, seaDetUv1(vWPos.xz));
    detA.w = max(detA.w, a1.w * w1);
    detB.xy += b1.xy * w1;
    detB.z = min(detB.z, mix(1.0, b1.z, w1));
    detFar = (1.0 - w0) * (1.0 - w1);
  }
}
// Whitecaps: scattered by the wind everywhere (uCover is the share of sea
// that is white), more on high crests (vFoam), drawn out into streaks along
// the wind.
vec2 wd = uWind;
vec2 pf = vWPos.xz + uFlow;
vec2 q = vec2(dot(pf, wd), dot(pf, vec2(-wd.y, wd.x)));
// Each octave gives way to its average once its blobs are smaller than the pixel, so
// a wide white sea far off is an even white, not a shimmer of speckles.
float fpF = max(length(fwidth(vWPos.xz)), 1e-4);
float o2 = smoothstep(0.08, 0.3, fpF);
float o3 = smoothstep(0.02, 0.1, fpF);
#ifdef SEA_LITE
// Low has no separate streak lanes (their straight lines read as seams, Elena): in a gale its
// caps are drawn out along the wind instead, into broken, uneven streaks, for free.
float stx = 1.0 - 0.5 * min(uStreak * 4.0, 1.0);
float fn = vnoise(vec2(q.x * 0.5 * stx, q.y * 1.4) + vec2(uTime * 0.05, 0.0)) * 0.5
         + mix(vnoise(vec2(q.x * 1.6 * stx, q.y * 4.0) - uTime * 0.08), 0.5, smoothstep(0.03, 0.12, fpF)) * 0.3 // fades sooner: far off it drew fine regular dashes
#else
float fn = vnoise(vec2(q.x * 0.5, q.y * 1.4) + vec2(uTime * 0.05, 0.0)) * 0.5
         + mix(vnoise(vec2(q.x * 1.6, q.y * 4.0) - uTime * 0.08), 0.5, o2) * 0.3
#endif
         + mix(vnoise(vWPos.xz * 7.0 + uTime * 0.2), 0.5, o3) * 0.2;
#ifdef SEA_LITE
// Low has only this noise mask for its caps, tuned for Monahan's few per cent: past that it
// turned the whole sea white at force 8 (whiteCrests() is ~0.3 there). Medium and up get their
// extra white from the short waves' foam instead.
float thr = 0.8 - 1.4 * min(uCover, 0.15) - 0.35 * vFoam * (1.0 - smoothstep(0.04, 0.15, fpF)); // far crests' foam drew rows of fine dashes
#else
float thr = 0.8 - 1.4 * uCover - 0.35 * vFoam;
#endif
#ifdef SEA_LITE
// Thin and see-through at the edge, whiter inside: not a flat paper cut-out (Elena).
float foamMask = smoothstep(thr, thr + 0.05, fn) * (0.45 + 0.55 * smoothstep(thr + 0.05, thr + 0.22, fn)) * step(0.002, uCover + vFoam) * (1.0 - 0.6 * farMix);
#else
float foamMask = smoothstep(thr, thr + 0.1, fn) * step(0.002, uCover + vFoam) * (1.0 - 0.6 * farMix);
#endif
float foamSunk = 0.0; // bubbles just under the surface round a fresh cap (Medium and up)
if (SEA_DET_N > 0) {
  // Whitecaps where the FFT's crests fold over, fading over seconds; as a patch
  // fades it breaks up into flecks instead of shrinking as a blob (Elena). The big
  // waves' high crests add a little, broken up the same way. Far off, where the
  // texels are finer than the pixel, the sea's average whiteness.
  float fresh = detA.w; // 1 as a crest breaks, halving every few seconds after
  // Foam texture: a few octaves of noise, rotated against each other so no grid
  // shows. A fresh patch covers most of it; as it fades only the highest parts
  // stay above the rising threshold, so it breaks into flecks and holes instead
  // of shrinking as a cut-out shape.
  vec2 qf = vec2(q.x * 0.45, q.y); // drawn out along the wind
  vec2 r1 = mat2(0.8, -0.6, 0.6, 0.8) * qf;
  vec2 r2 = mat2(0.96, -0.28, 0.28, 0.96) * vec2(pf.x * 0.6, pf.y); // wind-aligned too, so caps tear along the wind
  float tex = vnoise(qf * 1.1) * 0.25 + vnoise(r1 * 2.9 + 7.0) * 0.3
            + mix(vnoise(r2 * 7.7 + 3.0), 0.5, o3) * 0.25 + mix(vnoise(pf * 19.0 + 1.0), 0.5, o3) * 0.2;
  float th = mix(0.7, 0.32, smoothstep(0.02, 0.7, fresh)); // even fresh foam leaves holes: no solid clumps (Ines)
  // Thick and opaque where it's piled up, thin and see-through elsewhere; the
  // edge softens with the pixel's footprint so it never cuts out sharp from afar.
  // A breaking crest has a crisp edge; old foam goes to lace (holes through it) (Ines, Elena).
  float edge = mix(0.25, 0.1, smoothstep(0.3, 0.9, fresh)) + 1.5 * fpF; // soft even when fresh: no paper cut-outs (Ines, round 5)
  float lace = mix(smoothstep(0.35, 0.6, mix(vnoise(r2 * 13.0 + 5.0), 0.5, o3)), 1.0, 0.4 * smoothstep(0.25, 0.9, fresh)); // even a fresh cap is torn
  float young = smoothstep(th, th + edge, tex) * mix(0.35, 1.0, smoothstep(th + 0.08, th + 0.35, tex))
              * mix(0.6, 0.95, smoothstep(0.6, 1.0, fresh)) * lace;
  float near = young + 0.35 * vFoam * smoothstep(0.66, 0.78, tex + 0.3 * fresh) * step(0.002, uCover);
  // Where the patch's texels are finer than the pixel (far off, and on wave backs seen edge on),
  // the wind's own scattered caps (the noise mask above, broken up by the foam texture), not an even white sheen: a sheen there
  // drew smooth white smears along every wave back (Ines, round 6).
  foamMask = mix(clamp(near, 0.0, 1.0), max(foamMask * mix(smoothstep(0.35, 0.65, tex), 0.6, o2), 0.25 * uCover), detFar) * (1.0 - 0.5 * farMix);
  // Round a fresh cap the water is milky with bubbles just under the surface, so the foam
  // reads as sunk into the sea with soft edges, not laid on top of it (Ines, round 5). Only round
  // young, textured foam: at force 8 the old foam field covers a third of the sea, and a milky
  // tint over all of it drew big flat pale slabs with the coarse patch's straight edges (Elena).
  foamSunk = smoothstep(0.25, 0.6, fresh) * smoothstep(0.3, 0.7, tex) * (1.0 - clamp(near, 0.0, 1.0)) * (1.0 - detFar);
}
// Blown foam (force 7 and up, storm.ts): long narrow lanes along the wind, drifting
// downwind; where they're finer than a pixel, their average whiteness instead.
#ifdef SEA_LITE
// Low draws no lanes: its caps stretch along the wind instead (above).
#else
if (uStreak > 0.001) {
  vec2 qs = q - vec2(uTime * 1.2, 0.0);
  // Wander the lanes sideways a little, so they meander and split instead of running as ruled bars.
  qs.y += 1.5 * vnoise(qs * vec2(0.012, 0.06)) + 0.4 * vnoise(qs * vec2(0.05, 0.3)); // straight, parallel lanes; no curls (Sam)
  // Thin filaments, not bands: the lines where a noise stretched along the wind
  // crosses its middle (a few tens of cm wide, some metres apart), broken into
  // dashes and wisps, and only some lanes carry foam; more as the wind rises.
  float r = vnoise(vec2(qs.x * 0.05, qs.y * 0.35));
  float ridge = 1.0 - abs(2.0 * r - 1.0);
  float fwR = fwidth(ridge);
  float line = smoothstep(0.91 - 1.5 * fwR, 0.985, ridge) * mix(1.0, 0.35, clamp(fwR * 4.0, 0.0, 1.0)); // thin: wide soft lanes read as glossy smears (Ines, round 6)
  float brk = vnoise(vec2(qs.x * 0.8, qs.y * 1.5) + 31.0) * 0.6
            + mix(vnoise(vec2(qs.x * 0.9, qs.y * 5.0) + 7.0), 0.5, smoothstep(0.05, 0.25, fpF)) * 0.4;
  // Lanes come and go every few tens of metres along the wind, and break into
  // dashes within that, so none reads as one long straight stick (Ines, Iris).
  float present = smoothstep(0.62 - uStreak, 0.8 - uStreak, vnoise(vec2(qs.x * 0.035, qs.y * 0.12) + 3.0));
  float lanes = line * smoothstep(0.45, 0.75, brk) * present;
  // Lumpy and frothy along their length, like the foam they are, not smooth ribbons.
  lanes *= mix(smoothstep(0.3, 0.7, vnoise(vec2(qs.x * 2.5, qs.y * 9.0) + 11.0)), 0.5, smoothstep(0.05, 0.25, fpF));
  // Lanes clearer near the lens, fainter where many crowd into a pixel (Ines).
  float streak = mix(mix(0.6, 0.35, smoothstep(10.0, 60.0, length(vWPos - cameraPosition))) * lanes, 0.4 * (uStreak + uCover), smoothstep(0.4, 1.5, fpF));
  foamMask = max(foamMask, streak);
}
#endif
#ifndef SEA_LITE
diffuseColor.rgb *= 1.0 - 0.2 * smoothstep(0.15, 0.6, uSeaSky.w) * smoothstep(0.1, 0.4, uSunDir.y); // the water body darker under a daytime deck; the foam keeps its white (Ines, round 6)
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.8 + vec3(0.02, 0.05, 0.05), 0.4 * foamSunk); // GUESS tint
#endif
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.9, 0.91), foamMask * (SEA_DET_N > 0 ? 0.88 : 1.0)); // off-white, a little see-through
#ifndef SEA_LITE
${BOAT_WASH_FRAGMENT}
#endif
`;

const FRAG_ROUGH = /* glsl */ `
if (SEA_DET_N > 0) roughnessFactor = mix(roughnessFactor, 0.05 + 0.22 * uRoughFar, detFar * (1.0 - farMix * 0.3));
// Ripples finer than anything drawn still scatter the light (Cox and Munk): a
// floor on the roughness that rises with the wind, so the sun's and moon's
// paths break into glints instead of lying on a wave face as one bright rod.
#ifndef SEA_LITE
roughnessFactor = max(roughnessFactor, 0.06 + 0.14 * uRoughFar);
#endif
// Matte where there's foam, but eased in from the FFT's smooth foam field rather than the
// crisp lace mask, so foam patches don't get glossy rims (Ines: puddle outlines). Old, faded
// foam stays glossy: matte over the whole old field read as flat pale slabs at noon (Elena).
float foamShade = SEA_DET_N > 0 ? max(0.6 * smoothstep(0.3, 0.8, detA.w), 0.6 * foamMask) : foamMask;
roughnessFactor = mix(roughnessFactor, 0.75, foamShade);
`;

const FRAG_NORMAL = /* glsl */ `
{
  float fp = max(length(fwidth(vWPos.xz)), 1e-4);
  // Chosen by the preprocessor, not a ?: (a software renderer may run both sides).
#ifdef SEA_LITE
  vec2 s = rippleSlope(vWPos.xz, uTime, fp, farMix) * (1.0 - 0.7 * foamMask);
#else
  vec2 s = uSeaDetN > 0 ? (detB.xy + microSlope(vWPos.xz + uFlow, uTime, fp) * (1.0 - 0.3 * uRain.x)) * (1.0 - 0.5 * foamShade) : rippleSlope(vWPos.xz, uTime, fp, farMix) * (1.0 - 0.7 * foamMask);
#endif
#ifndef SEA_LITE
  s += rainSlope(vWPos.xz + uFlow, uTime, fp) * (1.0 - foamMask); // rain rings (Kai, rainRings.ts); not on Low (budget)
#endif
#ifdef SEA_LITE
  if (vFade < 0.999) s += swellSlope(vWPos.xz, uTime, fp) * (1.0 - vFade); // Low: no vCell, as main
#else
  if (vFade < 0.999 || vCell > 0.0) s += swellSlope(vWPos.xz, uTime, fp); // no gate on the cell size: that made a step 20-30 m off (Kai, Ines)
#endif
  vec3 nW = (vec4(normal, 0.0) * viewMatrix).xyz; // view -> world
  nW = normalize(nW + vec3(-s.x, 0.0, -s.y));
  normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
}
`;

const FRAG_GLOW = /* glsl */ `
{
  // Light shining through the thin tops of waves: strongest looking towards a
  // low sun, on crests, never on foam.
  vec3 V = normalize(cameraPosition - vWPos);
  vec2 vh = normalize(V.xz + 1e-5);
  vec2 sh = normalize(-uSunDir.xz + 1e-5);
  float back = max(dot(vh, sh), 0.0);
  float crest = smoothstep(-0.2, 1.2, vCrest);
  float lowSun = 1.0 - 0.6 * smoothstep(0.3, 0.9, uSunDir.y);
  totalEmissiveRadiance += vec3(0.9, 0.95, 1.0) * foamMask * (0.06 * smoothstep(0.0, 0.25, uSunI) + 0.25 * uSunI); // no glow on a moonless night
  totalEmissiveRadiance += uGlow * uSunI * crest * (0.35 + 0.65 * back * back) * lowSun * (1.0 - foamMask) * (1.0 - farMix);
}
`;

// The land, town and boats mirrored in calm water (mirror.ts): looked up where this
// pixel of flat sea is, pushed about by the wave slopes, stronger at grazing angles.
// A low sun warms the sky's reflection only along its own path across the water;
// elsewhere the sea stays a cold slate (Elena). Looks only.
const FRAG_SKY = /* glsl */ `
// Under a cloud deck the sea mirrors the deck (its colour from the sky's owner,
// seaUniforms.uSeaSky), so the far sea meets the sky's own horizon colour with
// no line between them. The planar mirror (boats, land) keeps its picture.
// A mostly closed deck already hides the clear sky map: swap it out early, so no
// warm slot or blue patch of it shows as squiggles on the wave facets (Elena, F8 dusk).
float deckS = smoothstep(0.15, 0.6, uSeaSky.w);
#ifdef SEA_LITE
// Low: the deck's colour and no sun glitter under it, without branches (Maya's frame budget).
// By day the mirrored deck comes back darker, so the far sea goes slate, not a pale band (Elena).
radiance = mix(radiance, uSeaSky.rgb * (1.0 - 0.35 * smoothstep(0.1, 0.4, uSunDir.y)), deckS);
// The body lit grey by the deck, not by the clear sky's blue (Elena: Low read bright blue under a grey deck).
iblIrradiance = mix(iblIrradiance, vec3(dot(iblIrradiance, vec3(0.2126, 0.7152, 0.0722))), deckS);
reflectedLight.directSpecular *= 1.0 - max(uRain.x, uSeaSky.w);
#else
// An overcast deck is not one flat grey: it is brighter overhead than at the horizon (the
// CIE overcast sky, L ~ (1 + 2 sin h) / 3), and a face tipped to mirror the water beyond
// sees darker sea. Mirrored as one flat colour, every ripple vanished and the near water read
// as a smooth slab (Ines, round 5); a gentle gradient lets the chop show. Flat at the horizon,
// so the far sea still meets the sky.
vec3 Vd = normalize(cameraPosition - vWPos);
vec3 Rd = reflect(-Vd, inverseTransformDirection(normal, viewMatrix));
float deckG = (1.0 + 0.25 * clamp(Rd.y, 0.0, 1.0)) * mix(0.7, 1.0, smoothstep(-0.3, 0.05, Rd.y)); // GUESS strengths
radiance = mix(seaColdSky(radiance), uSeaSky.rgb * deckG, deckS);
// The sea's body is lit by the deck too, not the clear sky's blue: same brightness, the deck's hue.
iblIrradiance = mix(iblIrradiance, uSeaSky.rgb * (dot(iblIrradiance, vec3(0.2126, 0.7152, 0.0722)) / max(dot(uSeaSky.rgb, vec3(0.2126, 0.7152, 0.0722)), 1e-3)), deckS);
// Rain or a closed deck hides the sun: no bright spot of it left in the sky map's
// reflection (a capped, cloud-lit sky instead).
radiance = mix(radiance, min(radiance, max(uSeaSky.rgb * 1.5, vec3(0.08))), max(uRain.x, deckS));
// Under a daytime deck a gale's sea is dark slate with the foam the brightest thing in it:
// the mirrored deck comes back well under the sky's own grey, so no wave face shines like
// cling film (Ines, round 6). Dusk and night are dark already. GUESS strength.
radiance *= 1.0 - 0.35 * deckS * smoothstep(0.1, 0.4, uSunDir.y);
// Even a moonless night sky glows a little (starlight, airglow): enough for the
// wave faces to read faintly instead of a black void (Leo). Nothing by day.
// The Bay's silty water: the sky it mirrors comes back greyer and a little green,
// so it never reads as open-ocean blue at noon (Ines #5, backlog 16).
radiance = mix(radiance, dot(radiance, vec3(0.2126, 0.7152, 0.0722)) * vec3(0.9, 1.02, 0.92), 0.6 * uBay);
#endif
#ifndef SEA_LITE
radiance = max(radiance, vec3(0.014, 0.019, 0.032));
// The sun's own highlight (direct light): on water this smooth even a 1 % sun makes a
// glitter path, so rain or a closed deck takes it out too (Kai, Ines F8 #3).
reflectedLight.directSpecular *= 1.0 - max(uRain.x, uSeaSky.w);
#endif
// Through a break in the deck, the one glitter left: a column in the break's warm light,
// from rays reflected low toward the sun's bearing, weighted as the sky draws it (Hana, Sam).
#ifndef SEA_LITE
if (uSeaBreak.w > 0.001) {
  vec3 Vb = normalize(cameraPosition - vWPos);
  // From the big waves' faces only (not the ripples), so it reads as a dull sheen on the
  // wave faces toward the slot, not a lace of sparks (Sam, Elena).
  // Half-flattened toward straight up, so the reflected ray swings slowly across the faces
  // and the sheen comes in broad gradients, not as a bright rim on every facet (Elena, Ines).
  vec3 Nb = normalize(mix(vec3(0.0, 1.0, 0.0), inverseTransformDirection(geometryNormal, viewMatrix), 0.5));
  vec3 Rb = reflect(-Vb, Nb);
  // A column toward the slot, picked by the view's own bearing (smooth across the screen),
  // not by each facet's reflected bearing, which drew a copper rim round every facet (Elena, Ines).
  float col = smoothstep(0.8, 1.0, dot(normalize(-Vb.xz + 1e-5), normalize(uSunDir.xz + 1e-5)));
  col *= col;
  // On the far sea only, where the water mirrors the sky just over the horizon; the near
  // water mirrors the deck overhead (a wash over it all read as a brown sea).
  col *= 1.0 - smoothstep(0.02, 0.12, Vb.y);
  // The faces tilted to catch the low light; broad and soft only.
  float lowB = exp(-12.0 * max(Rb.y, 0.0)) * smoothstep(-0.4, 0.1, Rb.y) * (1.0 - smoothstep(0.12, 0.35, uSunDir.y)); // a low sun's break only
  radiance += 0.22 * uSeaBreak.rgb * uSeaBreak.w * (1.0 - uRain.x) * col * lowB; // none through a downpour (Kai)
}
#endif
`;

const FRAG_MIRROR = /* glsl */ `
// The wreck darkens the light coming up out of the water, not the sky's reflection
// off the top, so it shows looking down and fades at a glancing angle.
if (wreckShade > 0.0) {
  vec3 Vw = normalize(cameraPosition - vWPos);
  float up = clamp(Vw.y, 0.0, 1.0);
  outgoingLight *= 1.0 - wreckShade * (0.35 + 0.65 * up) * (1.0 - foamMask);
  // Its edge catches a little light from above: a faint paler outline against the deep blue.
  outgoingLight += vec3(0.05, 0.1, 0.1) * wreckRim * up * (1.0 - foamMask);
}
#ifndef SEA_LITE
// The hull hides the sky from the water right beside it: a soft dark contact line.
outgoingLight *= 1.0 - 0.6 * washShade(vWPos.xz) * (1.0 - foamMask);
#endif
if (uMirror > 0.001) {
  vec3 nWm = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
  vec4 pc = uMirrorM * vec4(vWPos.x, uMirrorY, vWPos.z, 1.0);
  vec2 uv = pc.xy / pc.w + nWm.xz * (0.1 + 0.25 * (1.0 - uMirror)); // the ripples break it up
  // Three taps smeared up and down, as ripples stretch a reflection (Ines r5: not
  // mirror-crisp, no stair-stepped edge). The mirror clears to transparent black, so
  // un-premultiply or the edges go dark.
#ifdef SEA_LITE
  vec4 m = texture2D(tMirror, clamp(uv, vec2(0.001), vec2(0.999)));
#else
  vec2 bl = vec2(0.0015, 0.004);
  vec4 m = (2.0 * texture2D(tMirror, clamp(uv, vec2(0.001), vec2(0.999)))
          + texture2D(tMirror, clamp(uv + bl, vec2(0.001), vec2(0.999)))
          + texture2D(tMirror, clamp(uv - bl, vec2(0.001), vec2(0.999)))) * 0.25;
#endif
  m.rgb /= max(m.a, 0.05);
#ifndef SEA_LITE
  m.rgb = seaColdSky(m.rgb);
#endif
  vec3 Vm = normalize(cameraPosition - vWPos);
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(nWm, Vm), 0.0), 5.0);
  // A reflected hull is its own colour, darker and drawn toward the water's (Ines): it
  // replaces the sky's reflection where it hides the sky, so it must dominate there
  // rather than tint the bright sky-lit sea (a half mix of orange and sky reads pink).
  // Darken it rather than mix blue into it: blue added to a bright orange reads pink,
  // a darker orange reads as the hull seen in deep water (brown-orange).
  float lumM = dot(m.rgb, vec3(0.2126, 0.7152, 0.0722));
  m.rgb = mix(m.rgb, vec3(lumM), 0.15) * 0.55 + outgoingLight * 0.06;
  // How smooth the water is sets how sharp the image is, not how much of it: a half-strength
  // reflection is a tint, and tints shift the hue. Fade it only as the mirror switches off.
  float k = m.a * smoothstep(0.0, 0.35, uMirror) * clamp(0.85 + fres, 0.0, 0.95) * (1.0 - foamMask);
  outgoingLight = mix(outgoingLight, m.rgb, k);
}
`;

// Under a deck the far sea converges on the sky's own horizon colour (seaSky().rgb, Hana), over the last
// ~1.7 degrees below it (about 20 rows at 720p), after the fog, in the space the sky's
// haze are mixed in, so sea and sky meet without a knife edge (Ines, Hana).
const FRAG_HAZE = /* glsl */ `
#ifndef SEA_LITE
if (uSeaSky.w > 0.2) { // uniform branch: only under a deck
  vec3 Vh = normalize(vWPos - cameraPosition);
  // The last ~1.7 degrees (about 20 rows at 720p), and after the scene fog: the fog colour is
  // a little paler than the sky's own horizon, which drew a thin pale line (Ines, round 5).
  float hz = 1.0 - smoothstep(0.0, 0.03, -Vh.y);
  // Toward a break the sky's horizon is the break's light, not the haze: leave the sea be there.
  hz *= 1.0 - uSeaBreak.w * (1.0 - smoothstep(0.12, 0.35, uSunDir.y)) * smoothstep(0.35, 0.97, dot(normalize(Vh.xz + 1e-5), normalize(uSunDir.xz + 1e-5)));
  // gl_FragColor is already in the output space here, so the haze goes there too.
  gl_FragColor.rgb = mix(gl_FragColor.rgb, linearToOutputTexel(vec4(uSeaSky.rgb, 1.0)).rgb, hz * smoothstep(0.2, 0.8, uSeaSky.w));
}
#endif
`;

export class Sea {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
  private base = new Float32Array();
  private colours = new Float32Array();
  private foamAmount = 0;
  private hs = 1;
  private bayKnown = false;
  readonly steepness = 0.5;
  /** Shader inputs: set sunDir/sunIntensity from the scene's light. */
  readonly uniforms = {
    uTime: { value: 0 },
    uBay: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunI: { value: 1 },
    uGlow: { value: new THREE.Color(0x0d6f6a).multiplyScalar(0.55) },
    uRough: { value: 1 },
    uRoughFar: { value: 0.3 },
    uStorm: { value: 0 },
    uFlow: { value: new THREE.Vector2() },
    uAmp: { value: 0.5 },
    uCover: { value: 0 },
    uStreak: { value: 0 },
    uWreck: { value: new THREE.Vector4() },
    uWreckK: { value: new THREE.Vector2() },
    uWind: { value: new THREE.Vector2(1, 0) },
    uChop: { value: 0 },
    uFoamAmt: { value: 0 },
    uN: { value: 0 },
    uQ: { value: 0 },
    uWa: { value: Array.from({ length: MAX_WAVES }, () => new THREE.Vector4()) },
    uWd: { value: Array.from({ length: MAX_WAVES }, () => new THREE.Vector2()) },
    uDeep: { value: new THREE.Vector3(DEEP.r, DEEP.g, DEEP.b) },
    uShallow: { value: new THREE.Vector3(SHALLOW.r, SHALLOW.g, SHALLOW.b) },
    tMirror: { value: null as THREE.Texture | null },
    uMirrorM: { value: new THREE.Matrix4() },
    uMirror: { value: 0 },
    uMirrorY: { value: 0 },
  };
  private detail = 0; // wind chop on (High) or off (Low)
  /** The FFT short waves (seaDetail.ts); "off" keeps the old ripples. */
  private layer: ShortWaveLayer | null = null;
  private towards = new THREE.Vector2(1, 0);
  private quality: Quality;
  private reach = HORIZON;

  constructor(quality: Quality) {
    const material = new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      roughness: 0.05,
      metalness: 0,
      ior: 1.333,
      specularIntensity: 1,
      envMapIntensity: 0.7,
      transparent: true,
      // Opaque: at 0.95 the dark keel, rudder and pods showed through a calm sea as
      // "stilts" under the hull (Elena, Sam). Anything under the surface is hidden by the
      // water; "See under the water" (setSeeThrough) still opens it up.
      opacity: SEA_OPACITY,
      side: THREE.DoubleSide,
    });
    material.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.uniforms, seaUniforms, rainUniforms, washUniforms);
      sh.vertexShader =
        VERT_HEAD +
        WASH_PARS_FULL +
        sh.vertexShader
          .replace("#include <beginnormal_vertex>", "#include <beginnormal_vertex>\n" + VERT_NORMAL)
          .replace("#include <begin_vertex>", "#include <begin_vertex>\n" + VERT_POS)
          .replace("#include <project_vertex>", "#include <project_vertex>\n" + VERT_BODY);
      // The boat's night deck light (helm.ts, #358) lights its deck and gear, not the
      // sea: lit from a lamp a metre up, the sea's blue turned into a cyan pool under the
      // hull that read as a hover light (Leo, Elena's audit item 12). Point lights skip it.
      sh.fragmentShader = (RAIN_RINGS + FRAG_HEAD + WASH_PARS_FULL + sh.fragmentShader)
        .replace("#include <color_fragment>", "#include <color_fragment>\n" + FRAG_COLOUR)
        .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n" + FRAG_ROUGH)
        .replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\n" + FRAG_NORMAL)
        .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n" + FRAG_GLOW)
        .replace("#include <lights_fragment_maps>", "#include <lights_fragment_maps>\n" + FRAG_SKY)
        .replace("#include <opaque_fragment>", FRAG_MIRROR + "\n#include <opaque_fragment>")
        .replace("#include <fog_fragment>", "#include <fog_fragment>\n" + FRAG_HAZE)
        .replace("#include <lights_fragment_begin>", LIGHTS_NO_POINT);
    };
    material.customProgramCacheKey = () => "boatsim-sea-v15-washlite";
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.mesh.renderOrder = 10; // after the hulls (and "See under the water" lets them show through)
    this.mesh.frustumCulled = false;
    this.quality = quality;
    this.setQuality(quality);
    this.setDetail(quality === "low" ? "off" : "medium");
  }

  /**
   * How much short-wave detail to draw: "low" (shading only), "medium",
   * "high" (Ultra) or "off" (the old ripples). Needs WebGL2 (half-float
   * textures read in the vertex shader); pages without it should pass "off".
   */
  setDetail(d: Detail): void {
    if (this.layer?.detail === d) return;
    this.layer?.dispose();
    this.layer = d === "off" ? null : new ShortWaveLayer(d);
    if (!this.layer) seaUniforms.uSeaDetN.value = 0;
    const m = this.mesh.material as THREE.MeshStandardMaterial;
    const lite = d === "off";
    if (lite !== "SEA_LITE" in (m.defines ?? {})) {
      // Keep three's own defines (STANDARD, PHYSICAL): only add or drop ours.
      const defs: Record<string, string> = { ...(m.defines ?? {}) };
      if (lite) defs.SEA_LITE = "";
      else delete defs.SEA_LITE;
      m.defines = defs;
      m.needsUpdate = true;
    }
  }

  /** Short-wave detail now ("off" when the old ripples are drawn). */
  get detailLevel(): Detail {
    return this.layer?.detail ?? "off";
  }

  /** Bay water (green-grey) or the open ocean's blue; eases over a few seconds' worth of calls. */
  setBay(bay: boolean): void {
    const k = this.bayKnown ? 0.05 : 1; // the first call sets it outright
    this.bayKnown = true;
    const d = this.uniforms.uDeep.value;
    const sh = this.uniforms.uShallow.value;
    const td = bay ? BAY_DEEP : DEEP;
    const ts = bay ? BAY_SHALLOW : SHALLOW;
    d.set(d.x + (td.r - d.x) * k, d.y + (td.g - d.y) * k, d.z + (td.b - d.z) * k);
    sh.set(sh.x + (ts.r - sh.x) * k, sh.y + (ts.g - sh.y) * k, sh.z + (ts.b - sh.z) * k);
    this.uniforms.uBay.value += ((bay ? 1 : 0) - this.uniforms.uBay.value) * k;
  }

  /**
   * The boat moved (dx, dz) m through the water this frame: the short waves,
   * foam and streaks flow past. (The big waves flow in waves.ts Sea.flow; call both.)
   */
  flow(dx: number, dz: number): void {
    this.layer?.flow(dx, dz);
    const f = this.uniforms.uFlow.value;
    f.set((f.x + dx) % 10000, (f.y + dz) % 10000);
  }

  /** Height of the short waves at scene (x, z) (m), as drawn: add to waves.ts heightAt() for the whole surface. */
  detailHeightAt(x: number, z: number): number {
    return this.layer?.heightAt(x, z) ?? 0;
  }

  /**
   * The whole drawn surface's height at scene (x, z) (m): the big waves (waves.ts,
   * exactly as the physics feels them) plus the short waves as drawn. For looks
   * that must sit on the water (wash, spray, the waterline band); the boat's
   * motion keeps to the big waves alone.
   */
  surfaceAt(comps: WaveComponent[], x: number, z: number, t: number): number {
    return heightAt(comps, x, z, t, this.steepness) + this.detailHeightAt(x, z);
  }

  /** How far the sea reaches from the boat (m). */
  get horizon(): number {
    return this.reach;
  }

  /** Reach out to h metres, as when real land comes into view (rebuilds the grid, so not every frame). */
  setHorizon(h: number): void {
    if (h === this.reach) return;
    this.reach = h;
    this.setQuality(this.quality);
  }

  /** Grid that is fine near the middle and reaches the horizon at the edge:
   *  x = a u + b u^3 + c u^7 for u in [-1, 1], so the cells grow steadily outwards. */
  setQuality(quality: Quality): void {
    const { n, centre } = GRID[quality];
    this.quality = quality;
    this.detail = quality === "high" ? 1 : 0;
    this.uniforms.uChop.value = this.detail * this.chopFor(this.wind);
    const half = SEA_SIZE / 2;
    const a = (centre * n) / 2;
    const b = half - a;
    const c = this.reach - half;
    const du = 2 / n;
    const geo = new THREE.PlaneGeometry(2, 2, n, n);
    geo.rotateX(-Math.PI / 2);
    const p = geo.attributes.position.array as Float32Array;
    const fade = new Float32Array(p.length / 3);
    const cell = new Float32Array(p.length / 3);
    const edge = new Float32Array(p.length / 3);
    // Low keeps the old, cheap sea (Maya's frame budget: Low within 15% of before):
    // waves only in the patch round the boat, flat beyond with the far swell in
    // the shading, as main drew it. cell 0 draws every train in the patch.
    const low = quality === "low";
    const pw = low ? 25 : 7; // odd, so the grid keeps its sign
    const at = (u: number) => a * u + b * u ** 3 + c * u ** pw;
    const step = (u: number) => (low ? 0 : (a + 3 * b * u * u + pw * c * u ** (pw - 1)) * du);
    for (let i = 0; i < p.length; i += 3) {
      const u = p[i];
      const v = p[i + 2];
      p[i] = at(u);
      p[i + 2] = at(v);
      const r = Math.hypot(p[i], p[i + 2]);
      fade[i / 3] = 1 - (low ? THREE.MathUtils.smoothstep(r, FADE_IN, FADE_OUT) : THREE.MathUtils.smoothstep(r, FLAT_IN, FLAT_OUT));
      cell[i / 3] = Math.max(step(u), step(v));
      edge[i / 3] = Math.max(Math.abs(u), Math.abs(v)) > 0.9999 ? 1 : 0;
    }
    this.base = Float32Array.from(p);
    this.colours = new Float32Array(p.length);
    geo.setAttribute("color", new THREE.BufferAttribute(this.colours, 3));
    geo.setAttribute("fade", new THREE.BufferAttribute(fade, 1));
    geo.setAttribute("cell", new THREE.BufferAttribute(cell, 1));
    geo.setAttribute("edge", new THREE.BufferAttribute(edge, 1));
    this.mesh.geometry.dispose();
    this.mesh.geometry = geo;
    this.paintFlat();
  }

  /** The sea's significant wave height now (m), as last set. */
  get waveHeight(): number {
    return this.hs;
  }

  get vertexCount(): number {
    return this.base.length / 3;
  }

  /** Sea state for the looks: Hs (m), and the wind if known (m/s, and the
   *  scene direction it blows towards). Without a wind, one that would raise
   *  this sea is assumed (fully developed sea, Hs = 0.0246 U^2). */
  setSea(hs: number, windMs?: number, towards?: THREE.Vector2): void {
    this.hs = hs;
    // Crest foam starts around a fresh breeze; none on a calm sea.
    this.foamAmount = THREE.MathUtils.clamp((hs - 0.8) / 3.2, 0, 1); // GUESS display tuning
    this.uniforms.uAmp.value = hs / 2;
    this.uniforms.uRough.value = THREE.MathUtils.clamp(0.6 + hs / 5, 0.6, 1.4); // GUESS display tuning
    const u = windMs ?? Math.sqrt(hs / 0.0246);
    // Share of the sea white with breaking crests, and under blown foam (storm.ts, Beaufort).
    this.uniforms.uCover.value = whiteCrests(u);
    this.uniforms.uStreak.value = foamStreaks(u);
    if (towards && towards.lengthSq() > 0) {
      this.uniforms.uWind.value.copy(towards).normalize();
      this.towards.copy(towards);
    }
    this.wind = u;
    // Slate and heavy from a near gale up (force 6 to 9).
    this.uniforms.uStorm.value = THREE.MathUtils.smoothstep(u, 11, 22);
    this.uniforms.uRoughFar.value = THREE.MathUtils.clamp(u / 15, 0.05, 1.2);
    this.layer?.setSea(this.windSea ?? windSeaFrom(hs, u, this.towards), u);
    this.uniforms.uChop.value = this.detail * this.chopFor(u);
  }

  private wind = 6;
  private windSea: { hs: number; tp: number; direction: number } | null = null;
  /** The wind sea itself when the page knows it (Hs m, peak period s, compass direction it comes FROM); null to estimate from the wind. */
  setWindSea(ws: { hs: number; tp: number; dirFrom: number } | null): void {
    this.windSea = ws && { hs: ws.hs, tp: ws.tp, direction: (((ws.dirFrom + 90) % 360) * Math.PI) / 180 };
  }
  /** Chop strength from the wind (m/s): faint in a light air, full in a gale. */
  private chopFor(u: number): number {
    return THREE.MathUtils.clamp(0.25 + u / 14, 0.25, 1.3); // GUESS display tuning
  }

  setSeeThrough(on: boolean): void {
    this.mesh.material.opacity = on ? 0.45 : SEA_OPACITY;
  }

  /** Mirror the land and boats (mirror.ts): its texture, world-to-texture matrix and strength (0 off). */
  setMirror(tex: THREE.Texture | null, m: THREE.Matrix4, strength: number, level = 0): void {
    this.uniforms.uMirrorY.value = level;
    this.uniforms.tMirror.value = tex;
    this.uniforms.uMirrorM.value.copy(m);
    this.uniforms.uMirror.value = tex ? strength : 0;
  }

  /**
   * A wreck on the bottom to show through the water (pois.ts wreckBelow): where it lies
   * from the boat (m east, m south), its length and beam (m), its depth (m), and how
   * clearly it shows (0 hides it).
   */
  setWreck(x: number, z: number, length: number, beam: number, depth: number, clear: number): void {
    this.uniforms.uWreck.value.set(x, z, length / 2, beam / 2);
    this.uniforms.uWreckK.value.set(clear, depth);
  }

  /** Point the glitter and the glow at the scene's sun (world direction towards it). */
  setSun(dir: THREE.Vector3, intensity: number): void {
    this.uniforms.uSunDir.value.copy(dir).normalize();
    this.uniforms.uSunI.value = intensity;
  }

  private paintFlat(): void {
    const col = this.colours;
    const mid = DEEP.clone().lerp(SHALLOW, 0.5);
    for (let i = 0; i < col.length; i += 3) {
      col[i] = mid.r;
      col[i + 1] = mid.g;
      col[i + 2] = mid.b;
    }
  }

  /** Move the waves: hands this frame's wave trains to the shader. */
  update(comps: WaveComponent[], t: number): void {
    const u = this.uniforms;
    u.uTime.value = t;
    // Packed by waves.ts so the shader uses exactly displace()'s numbers.
    const w = gpuWaves(comps, this.steepness);
    u.uQ.value = w.q;
    for (let i = 0; i < w.n; i++) {
      u.uWa.value[i].fromArray(w.wa, i * 4);
      u.uWd.value[i].fromArray(w.wd, i * 2);
    }
    const n = w.n;
    u.uN.value = n;
    u.uAmp.value = this.hs / 2;
    u.uFoamAmt.value = this.foamAmount;
    // The same sea for every material that reads it (seaSurface.ts: boats' waterline, underwater fade).
    writeSeaUniforms(comps, t, this.steepness);
    this.layer?.update(t);
  }

  dispose(): void {
    this.layer?.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
