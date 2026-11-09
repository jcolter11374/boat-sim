// Foam wake behind a boat: soft white particles shed at the stern that ride
// the waves and fade. Cosmetic. The boats hold station side by side for the
// comparison, so the wake shows the water going past at each boat's cruising
// speed rather than the boat travelling across the picture.

import * as THREE from "three";
import type { Quality } from "./boats/parts";
import { toWorld, type Placement } from "./standin";
import { displace, heightAt, type WaveComponent } from "./waves";

const COUNT: Record<Quality, number> = { low: 90, high: 320 };
const LIFE = 9; // s a particle lives

const vertexShader = /* glsl */ `
  attribute float aAlpha;
  attribute float aSize;
  varying float vAlpha;
  void main() {
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (320.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
const fragmentShader = /* glsl */ `
  varying float vAlpha;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = dot(d, d) * 4.0;
    if (r > 1.0) discard;
    gl_FragColor = vec4(0.96, 0.98, 1.0, vAlpha * (1.0 - r) * (1.0 - r));
  }
`;

export class Wake {
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly n: number;
  private readonly born: Float32Array; // birth time, -1 = unused
  private readonly side: Float32Array; // lateral offset at birth, m
  private readonly spread: Float32Array; // lateral drift, m/s
  private next = 0;
  private lastSpawn = 0;

  /**
   * speed: water going past, m/s (the boat's cruising speed).
   * beam: hull width, m; sternX: stern position in the boat frame (negative).
   */
  constructor(
    quality: Quality,
    private readonly speed: number,
    private readonly beam: number,
    private readonly sternX: number,
    private readonly exact: boolean = quality === "high",
  ) {
    this.n = COUNT[quality];
    this.born = new Float32Array(this.n).fill(-1);
    this.side = new Float32Array(this.n);
    this.spread = new Float32Array(this.n);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.n * 3), 3));
    geo.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(this.n), 1));
    geo.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(this.n), 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 11; // on top of the sea
  }

  reset(): void {
    this.born.fill(-1);
  }

  update(comps: WaveComponent[], t: number, place: Placement): void {
    const rate = this.n / LIFE; // particles per second, keeps the pool full
    if (t < this.lastSpawn) this.lastSpawn = t; // clock restarted
    while (this.lastSpawn + 1 / rate <= t) {
      this.lastSpawn += 1 / rate;
      const i = this.next;
      this.next = (this.next + 1) % this.n;
      this.born[i] = this.lastSpawn;
      this.side[i] = (Math.random() - 0.5) * this.beam * 0.9;
      this.spread[i] = (this.side[i] >= 0 ? 1 : -1) * (0.05 + Math.random() * 0.12);
    }
    const pos = this.points.geometry.attributes.position.array as Float32Array;
    const alpha = this.points.geometry.attributes.aAlpha.array as Float32Array;
    const size = this.points.geometry.attributes.aSize.array as Float32Array;
    for (let i = 0; i < this.n; i++) {
      const age = t - this.born[i];
      if (this.born[i] < 0 || age > LIFE || age < 0) {
        alpha[i] = 0;
        continue;
      }
      const bx = this.sternX - this.speed * age;
      const bz = this.side[i] + this.spread[i] * age;
      const [x, z] = toWorld(bx, bz, place);
      const y = this.exact ? heightAt(comps, x, z, t) : displace(comps, x, z, t)[1];
      pos[i * 3] = x;
      pos[i * 3 + 1] = y + 0.02;
      pos[i * 3 + 2] = z;
      const life = age / LIFE;
      alpha[i] = 0.75 * Math.min(age * 4, 1) * (1 - life) ** 1.5;
      size[i] = 0.18 + 0.5 * life;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.aAlpha.needsUpdate = true;
    this.points.geometry.attributes.aSize.needsUpdate = true;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}
