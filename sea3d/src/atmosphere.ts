// Sky, sun, stars, haze and the glow around bright things, shared by both pages.
//
// set(elevation, azimuth, storm) puts the sun where it really was (the voyage
// page works that out from the log's time and position), with warm light at
// sunrise and sunset, stars and a dim moonlight at night, and grey, close haze
// in a blow. Reflections on the water and hulls follow the sky as it changes.

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { BokehPass } from "three/examples/jsm/postprocessing/BokehPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { HORIZON } from "./water";
import { BRIGHT_STARS, equatorialVector, moonEquatorial, moonPhase, sunEquatorial, toHorizon } from "./sky";

const rad = THREE.MathUtils.degToRad;
const smooth = THREE.MathUtils.smoothstep;

/** Where the sun is (degrees) for a UTC time and place. Low-precision
 *  almanac formulas, good to about half a degree: plenty for pictures.
 *  Azimuth is the compass bearing, clockwise from north. */
export function sunPosition(ms: number, lat: number, lon: number): { el: number; az: number } {
  const s = sunEquatorial(ms);
  return toHorizon(s.ra, s.dec, ms, lat, lon);
}

/** Compass bearing and elevation -> unit vector in the scene (x east, y up, z south). */
export function compassToScene(elDeg: number, azDeg: number, out = new THREE.Vector3()): THREE.Vector3 {
  const el = rad(elDeg);
  const az = rad(azDeg);
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

const DAY_HAZE = new THREE.Color(0xabc3d7);
const DUSK_HAZE = new THREE.Color(0xd8a58a);
const NIGHT_HAZE = new THREE.Color(0x0a1424);
const STORM_HAZE = new THREE.Color(0x7d8a94);
const NOON_SUN = new THREE.Color(0xfff1dc);
const LOW_SUN = new THREE.Color(0xff9a5a);
const MOON = new THREE.Color(0x9fb6e8);

const VERT = "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }";

/** Colour grade in scene light (before tone mapping): a touch more contrast and
 * colour on fair days, warmer near sunrise and sunset, colder and greyer in a blow. */
const GRADE = {
  uniforms: { tDiffuse: { value: null }, storm: { value: 0 }, warm: { value: 0 } },
  vertexShader: VERT,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float storm; uniform float warm; varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, 1.1 - 0.4 * storm);
      c *= mix(vec3(1.0), vec3(1.07, 1.0, 0.9), warm) * mix(vec3(1.0), vec3(0.93, 0.98, 1.05), storm);
      c = pow(max(c, 0.0) / 0.18, vec3(1.07 + 0.05 * (1.0 - storm))) * 0.18; // contrast round mid grey
      gl_FragColor = vec4(c, 1.0);
    }`,
};

/** Film look on the finished picture: soft darkening at the edges, a hint of
 * colour fringing there like a real lens, and fine grain. */
const FILM = {
  uniforms: { tDiffuse: { value: null }, time: { value: 0 }, res: { value: new THREE.Vector2(1, 1) } },
  vertexShader: VERT,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float time; uniform vec2 res; varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 d = vUv - 0.5;
      float r = length(d * vec2(res.x / res.y, 1.0));
      vec2 ca = d * 0.0025 * r;
      vec3 c = vec3(texture2D(tDiffuse, vUv + ca).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - ca).b);
      c *= mix(1.0, smoothstep(1.15, 0.35, r), 0.32);
      c += (hash(vUv * res + fract(time) * 917.0) - 0.5) * 0.022;
      gl_FragColor = vec4(c, 1.0);
    }`,
};

/**
 * The stock sky model makes a clear day pale and milky: nearly white at the
 * horizon and only a washed blue overhead, so the sea (which mirrors it) goes
 * white too. Real clear air over the open ocean is a deep blue high up, paling
 * to a bright, slightly hazy band just above the horizon, with a white glow
 * round the sun. This adds that on top of the stock model (uClear 0..1: how much
 * clear, sunlit sky there is; 0 at night and in a blow, so those stay as they were).
 */
function deepenSky(m: THREE.ShaderMaterial): void {
  m.uniforms.uClear = { value: 1 };
  m.uniforms.uWarm = { value: 0 };
  m.uniforms.uTwilight = { value: 0 };
  m.uniforms.uNight = { value: 0 };
  m.uniforms.uMoonSky = { value: 1 };
  m.fragmentShader = m.fragmentShader
    .replace("void main() {", "uniform float uClear;\nuniform float uWarm;\nuniform float uTwilight;\nuniform float uNight;\nuniform float uMoonSky;\nvoid main() {")
    .replace(
      "gl_FragColor = vec4( retColor, 1.0 );",
      /* glsl */ `
      {
        float hgt = max(direction.y, 0.0);
        float lum = dot(retColor, vec3(0.2126, 0.7152, 0.0722));
        // Clear air: bluer and darker going up, but not in the bright glow round the sun.
        float glow = smoothstep(0.75, 0.995, cosTheta);
        float up = smoothstep(0.0, 0.55, hgt);
        vec3 deep = mix(vec3(1.0), vec3(0.42, 0.62, 1.08), up * (1.0 - glow));
        vec3 graded = mix(vec3(lum), retColor, 1.35) * deep;
        // Just above the horizon: a pale, bright band of haze rather than flat white.
        float band = 1.0 - smoothstep(0.0, 0.12, hgt);
        graded = mix(graded, retColor * vec3(0.8, 0.9, 1.03), band * 0.6);
        // Low sun: warm the sky on the sun's side, rose and violet opposite (the "belt of Venus").
        float sunSide = 0.5 + 0.5 * cosTheta;
        vec3 dusk = mix(vec3(0.95, 0.82, 1.0), vec3(1.18, 0.86, 0.62), sunSide);
        graded *= mix(vec3(1.0), dusk, uWarm * (1.0 - 0.6 * up));
        retColor = mix(retColor, max(graded, 0.0), uClear);
        // Twilight, sun just below the horizon: the sky keeps a glow for half an hour
        // or so. Orange low on the sun's side, a deepening blue overhead, and a
        // rose band low on the opposite side above the earth's blue shadow.
        float sunward = smoothstep(-0.2, 1.0, cosTheta);
        float low = 1.0 - smoothstep(0.0, 0.35, hgt);
        vec3 tw = vec3(0.025, 0.05, 0.11) * (1.0 - 0.5 * low);                 // twilight blue
        tw += vec3(0.32, 0.13, 0.04) * pow(sunward, 3.0) * low * low;          // afterglow
        float belt = smoothstep(0.03, 0.09, hgt) * (1.0 - smoothstep(0.09, 0.22, hgt));
        tw += vec3(0.11, 0.06, 0.08) * belt * (1.0 - sunward);                // rose band
        tw += vec3(0.01, 0.02, 0.05) * (1.0 - smoothstep(0.0, 0.05, hgt)) * (1.0 - sunward); // earth's shadow
        retColor += tw * uTwilight;
        // Full night: the stock model leaves a muddy brown glow; a clear night at sea
        // is a deep navy, a shade lighter down by the horizon.
        float nl = dot(retColor, vec3(0.2126, 0.7152, 0.0722));
        // Moonlight lifts it; with no moon it's close to black apart from the stars.
        vec3 navy = vec3(0.012, 0.02, 0.045) * (1.0 + 1.2 * (1.0 - smoothstep(0.0, 0.25, hgt))) * uMoonSky + nl * vec3(0.25, 0.35, 0.6);
        retColor = mix(retColor, navy, uNight);
      }
      gl_FragColor = vec4( retColor, 1.0 );`,
    );
}

export class Atmosphere {
  readonly sky = new Sky();
  readonly sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
  readonly moon = new THREE.DirectionalLight(MOON, 0);
  readonly hemi = new THREE.HemisphereLight(0xcfe6ff, 0x0b2a3f, 0.5);
  readonly fog = new THREE.Fog(DAY_HAZE.getHex(), 150, HORIZON * 0.9);
  /** The night sky, turned to the real time and place by setCelestial(): faint stars plus the bright named ones. */
  readonly stars = new THREE.Group();
  private starMats: THREE.PointsMaterial[] = [];
  /** The moon's disc, lit on the side facing the sun (so it shows its real phase). */
  readonly moonDisc: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  /** Unit vector towards the moon, its elevation (degrees) and how much of it is lit (0..1). */
  readonly moonDir = new THREE.Vector3();
  moonEl = 35;
  moonLit = 0.6;
  /** Moonlight now, 0 (new moon or moon down) .. 1 (full moon up, clear). */
  moonlight = 0;
  moonPhaseName = "";
  /** Bright stars by name, as unit vectors in the scene (for labels). */
  readonly starDirs = new Map<string, THREE.Vector3>();
  /** A grey lid over the sky in a blow (the sky shader has no cloud). */
  readonly overcast = new THREE.Mesh(
    new THREE.SphereGeometry(HORIZON * 2, 32, 16),
    new THREE.MeshBasicMaterial({ side: THREE.BackSide, transparent: true, opacity: 0, fog: false, depthWrite: false }),
  );
  /** Unit vector towards the sun, and how bright it is (0 night .. 1 clear day). */
  readonly sunDir = new THREE.Vector3(0, 1, 0);
  sunLight = 1;
  /** The light that makes glints on the water: the sun by day, the moon at night. */
  readonly glintDir = new THREE.Vector3(0, 1, 0);
  glintLight = 1;
  exposure = 0.55;
  /** Overall light level for unlit things like foam particles, 0..1. */
  ambient = 1;

  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private wantBloom = false;
  /** Ultra: lens focus, colour grade, film look, sun shadows. Opt-in, real graphics card only. */
  ultra = false;
  private bokeh: BokehPass | null = null;
  private grade: ShaderPass | null = null;
  private film: ShaderPass | null = null;
  private storm = 0;
  private reach = HORIZON;
  private dusk = 0;
  private pmrem: THREE.PMREMGenerator;
  private envScene = new THREE.Scene();
  private envRT: THREE.WebGLRenderTarget | null = null;
  private envKey = [NaN, NaN, NaN];
  private envAt = -1e9;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.Camera,
  ) {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const gl = renderer.getContext();
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    // ?gl=full draws everything even on software graphics (slow; for screenshots).
    this.software = /swiftshader|llvmpipe|software|basic render/i.test(gpu) && new URLSearchParams(location.search).get("gl") !== "full";
    this.sky.scale.setScalar(HORIZON * 3);
    deepenSky(this.sky.material);
    const su = this.sky.material.uniforms;
    su.rayleigh.value = 1.4;
    su.mieCoefficient.value = 0.004;
    su.mieDirectionalG.value = 0.85;
    this.envScene.add(this.sky.clone()); // shares the sky's material, so it follows it
    this.pmrem = new THREE.PMREMGenerator(renderer);

    // Stars, placed on the sky's own sphere (equator and pole): setCelestial()
    // turns the whole sphere to the right time and place. Faint ones at random
    // (they only make the sky look right); the bright ones are the real stars.
    const R = HORIZON * 2.5;
    const field = (pts: [number, number, number][], cols: number[][], size: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pts.flatMap((v) => v.map((x) => x * R))), 3));
      g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(cols.flat()), 3));
      const m = new THREE.PointsMaterial({ size, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, fog: false, depthWrite: false });
      this.starMats.push(m);
      const pts3 = new THREE.Points(g, m);
      pts3.renderOrder = -1;
      pts3.frustumCulled = false;
      this.stars.add(pts3);
    };
    {
      const pts: [number, number, number][] = [];
      const cols: number[][] = [];
      for (let i = 0; i < 3200; i++) {
        const z = Math.random() * 2 - 1;
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(1 - z * z);
        pts.push([Math.cos(a) * r, Math.sin(a) * r, z]);
        const b = 0.2 + 0.6 * Math.random() ** 4;
        const warm = Math.random();
        cols.push([b * (0.85 + 0.15 * warm), b * 0.9, b * (1 - 0.15 * warm)]);
      }
      field(pts, cols, 1.5);
    }
    for (const [lo, hi, size] of [[-2, 0.6, 4.6], [0.6, 1.6, 3.7], [1.6, 9, 3.0]] as const) {
      const sel = BRIGHT_STARS.filter((st) => st.mag >= lo && st.mag < hi);
      field(
        sel.map((st) => equatorialVector(st.ra * 15, st.dec)),
        sel.map((st) => (/Betelgeuse|Antares|Aldebaran|Arcturus/.test(st.name) ? [1, 0.78, 0.6] : [0.92, 0.95, 1])),
        size,
      );
    }
    this.stars.matrixAutoUpdate = false;
    this.moonDisc = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        uniforms: { uSun: { value: new THREE.Vector3(1, 0, 0) }, uAlpha: { value: 0 }, uGlow: { value: 1 } },
        vertexShader: VERT,
        fragmentShader: `
          uniform vec3 uSun; uniform float uAlpha; uniform float uGlow; varying vec2 vUv;
          float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y); }
          void main() {
            vec2 p = vUv * 2.0 - 1.0;
            float r2 = dot(p, p);
            float edge = 1.0 - smoothstep(0.92, 1.0, r2);
            if (edge <= 0.0) discard;
            vec3 n = vec3(p, sqrt(max(1.0 - r2, 0.0)));
            float lit = smoothstep(-0.04, 0.08, dot(n, normalize(uSun)));
            float maria = 0.78 + 0.22 * vnoise(p * 3.0 + 4.0) - 0.12 * smoothstep(0.55, 0.8, vnoise(p * 2.2 + 1.3));
            vec3 c = vec3(0.98, 0.96, 0.9) * maria * mix(0.05, 1.0, lit) * uGlow;
            gl_FragColor = vec4(c, edge * uAlpha * mix(0.12, 1.0, lit));
          }`,
        transparent: true,
        depthWrite: false,
        fog: false,
      }),
    );
    this.moonDisc.renderOrder = -1;
    this.moonDisc.frustumCulled = false;
    this.setCelestial(Date.UTC(2020, 4, 1, 3), 38, -50); // a spring night mid-ocean until a page says otherwise
    this.overcast.renderOrder = -1;
    // Sun shadows (Ultra): a tight box round the boat, moved by shadowAround().
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -4;
    sc.right = sc.top = 4;
    sc.near = 1;
    sc.far = 220;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.sun.shadow.radius = 3;
    scene.add(this.sun.target);
    scene.add(this.sky, this.overcast, this.stars, this.moonDisc, this.sun, this.moon, this.hemi);
    scene.fog = this.fog;
    this.set(30, 210, 0, true);
  }

  /** Sun elevation and compass bearing in degrees; storm 0 (fair) .. 1 (gale). */
  set(elDeg: number, azDeg: number, storm: number, forceEnv = false): void {
    compassToScene(elDeg, azDeg, this.sunDir);
    const su = this.sky.material.uniforms;
    su.sunPosition.value.copy(this.sunDir);
    su.turbidity.value = 4 + 8 * storm;
    su.rayleigh.value = 1.4 + 1.2 * (1 - smooth(elDeg, 0, 15)); // redder near the horizon

    const day = smooth(elDeg, -5, 6); // 0 night .. 1 day
    const dusk = day * (1 - smooth(elDeg, 2, 22)); // low-sun warmth
    const night = 1 - smooth(elDeg, -10, -2);
    this.sunLight = day * (1 - 0.6 * storm);
    this.sun.color.copy(NOON_SUN).lerp(LOW_SUN, 1 - smooth(elDeg, 0, 25));
    this.sun.intensity = 2.4 * this.sunLight;
    this.sun.position.copy(this.sunDir).multiplyScalar(100);
    const moonUp = smooth(this.moonEl, -1, 4);
    // How much the moon lights the night: a half moon gives about a tenth of a full
    // moon's light (it falls off much faster than the lit fraction), a new moon none.
    const moonlight = moonUp * Math.pow(this.moonLit, 2.2) * (1 - 0.8 * storm);
    this.moonlight = moonlight;
    this.moon.intensity = 0.9 * night * moonlight;
    // Starlight alone is very dim: a moonless night at sea is nearly black.
    this.hemi.intensity = (0.022 + 0.1 * moonlight) * (1 - day) + 0.5 * day;
    this.hemi.color.set(0xcfe6ff).lerp(MOON, 1 - day);
    for (const m of this.starMats) m.opacity = night * (1 - storm);
    this.moonDisc.material.uniforms.uAlpha.value = moonUp * (1 - 0.85 * storm) * (0.35 + 0.65 * (1 - day));
    this.moonDisc.material.uniforms.uGlow.value = 1.2 + 1.4 * (1 - day);
    this.overcast.material.opacity = 0.88 * smooth(storm, 0.15, 0.9);
    const dark = 0.05 + 0.13 * moonlight; // what the night leaves, moonless .. full moon
    this.ambient = dark + (1 - dark) * day * (1 - 0.4 * storm);

    this.fog.color.copy(DAY_HAZE).lerp(DUSK_HAZE, dusk).lerp(NIGHT_HAZE, 1 - day);
    this.fog.color.lerp(STORM_HAZE.clone().multiplyScalar(0.25 + 0.75 * day), storm);
    this.fog.near = 300 * (1 - 0.9 * storm);
    this.fog.far = this.horizon * (0.9 - 0.77 * storm);
    // Eyes adjust a little to the dark, more so by moonlight.
    this.exposure = (0.55 - 0.17 * storm) * (1 + (1 - day) * (0.15 + 0.35 * moonlight));
    this.renderer.toneMappingExposure = this.exposure;
    this.overcast.material.color.copy(this.fog.color);

    // The moon makes the glints at night.
    if (day > 0.15 || this.moonEl < 0) {
      this.glintDir.copy(this.sunDir);
      this.glintLight = day > 0.15 ? this.sunLight : 0;
    } else {
      this.glintDir.copy(this.moon.position).normalize();
      this.glintLight = this.moon.intensity * 0.6;
    }
    if (this.bloom) this.bloom.strength = 0.22 + 0.25 * dusk + 0.15 * night;
    this.storm = storm;
    this.dusk = dusk;
    su.uClear.value = smooth(elDeg, -4, 4) * (1 - smooth(storm, 0.1, 0.8));
    su.uNight.value = 1 - smooth(elDeg, -14, -6);
    su.uMoonSky.value = 0.35 + 0.65 * moonlight;
    su.uTwilight.value = smooth(elDeg, -12, -4) * (1 - smooth(elDeg, -1, 5)) * (1 - 0.85 * storm);
    su.uWarm.value = (1 - smooth(elDeg, 1, 14)) * smooth(elDeg, -6, -1) * (1 - storm);

    // Re-light reflections when the sky has changed enough, a few times a second at most
    // (every few seconds on software graphics, where each re-light costs about a frame).
    const now = performance.now();
    const k = this.envKey;
    const moved = Math.abs(elDeg - k[0]) > 0.7 || Math.abs(((azDeg - k[1] + 540) % 360) - 180) > 3 || Math.abs(storm - k[2]) > 0.05;
    if (forceEnv || (moved && now - this.envAt > (this.software ? 5000 : 250))) {
      const rt = this.pmrem.fromScene(this.envScene);
      this.scene.environment = rt.texture;
      this.scene.environmentIntensity = 0.25 + 0.75 * day;
      this.envRT?.dispose();
      this.envRT = rt;
      this.envKey = [elDeg, azDeg, storm];
      this.envAt = now;
    }
  }

  /**
   * Turn the sky to a real moment and place: stars, the moon and its phase.
   * (The sun goes in through set(), from sunPosition(), for the same moment.)
   */
  setCelestial(ms: number, latDeg: number, lonDeg: number): void {
    // The sky sphere's three axes, seen from here now: x = RA 0h, y = RA 6h on the equator, z = the pole.
    const ax = (ra: number, dec: number) => {
      const h = toHorizon(ra, dec, ms, latDeg, lonDeg);
      return compassToScene(h.el, h.az);
    };
    const k = this.horizon / HORIZON;
    this.stars.matrix.makeBasis(ax(0, 0), ax(90, 0), ax(0, 90)).scale(new THREE.Vector3(k, k, k));
    this.stars.matrixWorldNeedsUpdate = true;
    for (const st of BRIGHT_STARS) {
      const h = toHorizon(st.ra * 15, st.dec, ms, latDeg, lonDeg);
      const v = this.starDirs.get(st.name) ?? new THREE.Vector3();
      this.starDirs.set(st.name, compassToScene(h.el, h.az, v));
    }
    const m = moonEquatorial(ms);
    const mh = toHorizon(m.ra, m.dec, ms, latDeg, lonDeg);
    this.moonEl = mh.el;
    compassToScene(mh.el, mh.az, this.moonDir);
    this.moon.position.copy(this.moonDir).multiplyScalar(100);
    const ph = moonPhase(ms);
    this.moonLit = ph.lit;
    this.moonPhaseName = ph.name;
  }

  /** Keep the moon's disc in its place in the sky as the camera moves, lit from the sun's side. */
  /** How far the view reaches (m): the haze, the sky and the moon go with it. */
  get horizon(): number {
    return this.reach;
  }

  /**
   * Reach further (or less far) than the page's own HORIZON, as when real land comes
   * into view on the helm page. Cheap: only scales and the haze change.
   */
  setHorizon(h: number): void {
    this.reach = h;
    this.sky.scale.setScalar(h * 3);
    this.overcast.scale.setScalar(h / HORIZON);
    this.fog.far = h * (0.9 - 0.77 * this.storm);
  }

  private placeMoon(): void {
    const cam = this.camera.position;
    const D = this.horizon * 2.2;
    const disc = this.moonDisc;
    disc.position.copy(cam).addScaledVector(this.moonDir, D);
    disc.lookAt(cam);
    // Drawn about three times its real size (half a degree) so it reads on a screen.
    disc.scale.setScalar(D * Math.tan(THREE.MathUtils.degToRad(1.5)));
    disc.updateMatrixWorld();
    // The sun's direction in the disc's own frame (x right, y up, z towards the viewer).
    const q = disc.quaternion.clone().invert();
    disc.material.uniforms.uSun.value.copy(this.sunDir).applyQuaternion(q);
  }

  /** True when the browser draws without a graphics card (software GL, as on
   *  CI or some office PCs): the glow is skipped there, it costs too much. */
  readonly software: boolean;

  /** Glow around the sun and bright glints (high quality, real graphics card only). */
  setBloom(on: boolean): void {
    this.wantBloom = on;
    this.rebuild();
  }

  /** Ultra on or off (needs the glow on and a graphics card). */
  setUltra(on: boolean): void {
    this.ultra = on && !this.software;
    this.renderer.shadowMap.enabled = this.ultra;
    this.sun.castShadow = this.ultra;
    this.rebuild();
  }

  /** Centre the sun's shadow box on a point (the boat). */
  shadowAround(p: THREE.Vector3, radius = 4): void {
    const sc = this.sun.shadow.camera;
    if (sc.right !== radius) {
      sc.left = sc.bottom = -radius;
      sc.right = sc.top = radius;
      sc.updateProjectionMatrix();
    }
    this.sun.target.position.copy(p);
    this.sun.position.copy(this.sunDir).multiplyScalar(100).add(p);
  }

  /** Lens focus distance in metres (Ultra), usually the boat. */
  setFocus(m: number): void {
    if (this.bokeh) (this.bokeh.uniforms as Record<string, THREE.IUniform>).focus.value = m;
  }

  private rebuild(): void {
    this.composer?.dispose();
    this.composer = null;
    this.bloom = this.bokeh = this.grade = this.film = null;
    if (!this.wantBloom || this.software) return;
    const size = this.renderer.getSize(new THREE.Vector2());
    const pr = this.renderer.getPixelRatio();
    // Multisampled, so edges stay as smooth as without the glow.
    const rt = new THREE.WebGLRenderTarget(size.x * pr, size.y * pr, { type: THREE.HalfFloatType, samples: 4 });
    const composer = new EffectComposer(this.renderer, rt);
    composer.addPass(new RenderPass(this.scene, this.camera));
    // The sky shader can overflow right at the sun's disc; keep that from
    // smearing across the picture through the glow.
    composer.addPass(
      new ShaderPass({
        uniforms: { tDiffuse: { value: null } },
        vertexShader: VERT,
        fragmentShader:
          "uniform sampler2D tDiffuse; varying vec2 vUv; void main() { vec4 c = texture2D(tDiffuse, vUv); " +
          "c.rgb = clamp(c.rgb, 0.0, 40.0); if (any(isnan(c.rgb))) c.rgb = vec3(0.0); gl_FragColor = vec4(c.rgb, 1.0); }",
      }),
    );
    if (this.ultra) {
      // A real lens: the boat sharp, the far sea and sky gently soft.
      this.bokeh = new BokehPass(this.scene, this.camera, { focus: 6, aperture: 0.00035, maxblur: 0.0035 });
      composer.addPass(this.bokeh);
    }
    this.bloom = new UnrealBloomPass(size, 0.25, 0.55, 2.2);
    composer.addPass(this.bloom);
    if (this.ultra) {
      this.grade = new ShaderPass(GRADE);
      composer.addPass(this.grade);
    }
    composer.addPass(new OutputPass());
    if (this.ultra) {
      this.film = new ShaderPass(FILM);
      composer.addPass(this.film);
    }
    this.composer = composer;
  }

  setSize(w: number, h: number): void {
    this.composer?.setSize(w, h);
  }

  setPixelRatio(r: number): void {
    this.composer?.setPixelRatio(r);
  }

  render(): void {
    this.placeMoon();
    if (this.grade) {
      const u = this.grade.uniforms;
      u.storm.value = this.storm;
      u.warm.value = this.dusk;
    }
    if (this.film) {
      this.film.uniforms.time.value = (performance.now() / 1000) % 1000;
      this.film.uniforms.res.value.set(this.renderer.domElement.width, this.renderer.domElement.height);
    }
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
