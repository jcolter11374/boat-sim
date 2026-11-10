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

const rad = THREE.MathUtils.degToRad;
const deg = THREE.MathUtils.radToDeg;
const smooth = THREE.MathUtils.smoothstep;

/** Where the sun is (degrees) for a UTC time and place. Low-precision
 *  almanac formulas, good to about half a degree: plenty for pictures.
 *  Azimuth is the compass bearing, clockwise from north. */
export function sunPosition(ms: number, lat: number, lon: number): { el: number; az: number } {
  const d = ms / 86400e3 - 10957.5; // days since 2000-01-01 12:00 UTC
  const g = rad(357.529 + 0.98560028 * d);
  const L = rad(280.459 + 0.98564736 * d + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g));
  const e = rad(23.439 - 0.00000036 * d);
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (((18.697374558 + 24.06570982441908 * d) % 24) + 24) % 24; // hours
  const ha = rad(gmst * 15 + lon) - ra;
  const phi = rad(lat);
  const el = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(ha));
  return { el: deg(el), az: (deg(az) + 360) % 360 };
}

/** Compass bearing and elevation -> unit vector in the scene (x east, y up, z south). */
export function compassToScene(elDeg: number, azDeg: number, out = new THREE.Vector3()): THREE.Vector3 {
  const el = rad(elDeg);
  const az = rad(azDeg);
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

const DAY_HAZE = new THREE.Color(0xc9dbe6);
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

export class Atmosphere {
  readonly sky = new Sky();
  readonly sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
  readonly moon = new THREE.DirectionalLight(MOON, 0);
  readonly hemi = new THREE.HemisphereLight(0xcfe6ff, 0x0b2a3f, 0.5);
  readonly fog = new THREE.Fog(DAY_HAZE.getHex(), 150, HORIZON * 0.9);
  readonly stars: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
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
    const su = this.sky.material.uniforms;
    su.rayleigh.value = 1.4;
    su.mieCoefficient.value = 0.004;
    su.mieDirectionalG.value = 0.85;
    this.envScene.add(this.sky.clone()); // shares the sky's material, so it follows it
    this.pmrem = new THREE.PMREMGenerator(renderer);

    // Stars: a fixed sprinkle on a big dome, brighter ones rarer.
    const n = 2600;
    const p = new Float32Array(n * 3);
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const y = Math.random() * 1.05 - 0.05;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - y * y);
      const R = HORIZON * 2.5;
      p.set([Math.cos(a) * r * R, y * R, Math.sin(a) * r * R], i * 3);
      const b = 0.25 + 0.75 * Math.random() ** 4;
      const warm = Math.random();
      c.set([b * (0.85 + 0.15 * warm), b * 0.9, b * (1 - 0.15 * warm)], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(p, 3));
    g.setAttribute("color", new THREE.BufferAttribute(c, 3));
    this.stars = new THREE.Points(
      g,
      new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, fog: false, depthWrite: false }),
    );
    this.stars.renderOrder = -1;
    this.moon.position.copy(compassToScene(35, 150)).multiplyScalar(100);
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
    scene.add(this.sky, this.overcast, this.stars, this.sun, this.moon, this.hemi);
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
    this.moon.intensity = 0.9 * night * (1 - 0.8 * storm);
    this.hemi.intensity = 0.12 + 0.38 * day;
    this.hemi.color.set(0xcfe6ff).lerp(MOON, 1 - day);
    this.stars.material.opacity = night * (1 - storm);
    this.overcast.material.opacity = 0.88 * smooth(storm, 0.15, 0.9);
    this.ambient = 0.18 + 0.82 * day * (1 - 0.4 * storm);

    this.fog.color.copy(DAY_HAZE).lerp(DUSK_HAZE, dusk).lerp(NIGHT_HAZE, 1 - day);
    this.fog.color.lerp(STORM_HAZE.clone().multiplyScalar(0.25 + 0.75 * day), storm);
    this.fog.near = 150 * (1 - 0.8 * storm);
    this.fog.far = HORIZON * (0.9 - 0.77 * storm);
    this.exposure = (0.55 - 0.17 * storm) * (1 + 0.5 * (1 - day));
    this.renderer.toneMappingExposure = this.exposure;
    this.overcast.material.color.copy(this.fog.color);

    // The moon makes the glints at night.
    if (day > 0.15) {
      this.glintDir.copy(this.sunDir);
      this.glintLight = this.sunLight;
    } else {
      this.glintDir.copy(this.moon.position).normalize();
      this.glintLight = this.moon.intensity * 0.6;
    }
    if (this.bloom) this.bloom.strength = 0.22 + 0.25 * dusk + 0.15 * night;
    this.storm = storm;
    this.dusk = dusk;

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
