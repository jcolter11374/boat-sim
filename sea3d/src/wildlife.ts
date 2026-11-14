// Wildlife at sea: pods of dolphins leaping alongside, a whale's blow and back, seabirds
// wheeling low over the waves. How often depends on where you are (public/wildlife.json:
// OBIS sighting records for the shape, NOAA's AMAPPS shipboard survey for the scale; see
// scripts/wildlife.py), so they're common over the shelf and near coasts and rare in mid-
// ocean. Display only.
//
// Placed like the other ships (traffic.ts): from small fixed cells, a couple of chances
// a cell, each a new group every ten minutes, so the same time and place shows the same
// animals; new ones turn up only out of sight, and ones in sight carry on till they're
// out of it.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { metresPerDegree } from "./land/shader";
import { hash4, metresTo } from "./traffic";

export type Animal = "dolphins" | "whales" | "birds";
export const ANIMALS: Animal[] = ["dolphins", "whales", "birds"];

export interface WildlifeMap {
  lat0: number;
  lon0: number;
  res: number;
  nlat: number;
  nlon: number;
  groups: Record<Animal, number[]>;
}

/** Each chance is a new group this often (s). */
export const SPELL = 600;
/** Spawn cells (degrees): small, as the animals are only seen close to. */
export const CELL = 0.02;
const SLOTS = 2;
/** The most groups of one kind kept at once (the nearest): a flock-rich shelf can hold dozens. */
export const MAX_GROUPS = 8;

/**
 * How each kind is seen: how far off you'd notice it (m; a whale's blow carries,
 * a dolphin's fin doesn't; GUESS), its speed (m/s) and how many to a group.
 */
export const LOOK: Record<Animal, { seen: number; speed: [number, number]; size: [number, number] }> = {
  dolphins: { seen: 1200, speed: [3, 6], size: [3, 14] },
  whales: { seen: 4000, speed: [0.8, 2], size: [1, 3] },
  birds: { seen: 900, speed: [1, 4], size: [2, 10] },
};

/** Groups per km² at any moment, from the map (0 off it). */
export function rateAt(m: WildlifeMap, kind: Animal, lat: number, lon: number): number {
  const i = Math.floor((lat - m.lat0) / m.res);
  const j = Math.floor((lon - m.lon0) / m.res);
  if (i < 0 || j < 0 || i >= m.nlat || j >= m.nlon) return 0;
  return m.groups[kind][i * m.nlon + j] ?? 0;
}

export interface Encounter {
  id: string;
  kind: Animal;
  lat: number;
  lon: number;
  heading: number;
  speed: number;
  count: number;
  tMid: number;
  seed: number;
}

export function animalAt(e: Encounter, t: number): { lat: number; lon: number } {
  const m = e.speed * (t - e.tMid);
  const { mx, my } = metresPerDegree(e.lat);
  const h = THREE.MathUtils.degToRad(e.heading);
  return { lat: e.lat + (Math.cos(h) * m) / my, lon: e.lon + (Math.sin(h) * m) / mx };
}

const KIND_N: Record<Animal, number> = { dolphins: 1, whales: 2, birds: 3 };

/** Every group within its sighting distance (times `reach`) of (lat, lon) at time t (s), nearest first. */
export function animalsNear(m: WildlifeMap, lat: number, lon: number, t: number, reach = 1.2, wet: (lat: number, lon: number) => boolean = () => true): Encounter[] {
  const out: { e: Encounter; d: number }[] = [];
  const { mx, my } = metresPerDegree(lat);
  for (const kind of ANIMALS) {
    const L = LOOK[kind];
    const radius = L.seen * reach;
    const span = radius + L.speed[1] * (SPELL / 2);
    const i0 = Math.floor((lat - span / my) / CELL);
    const i1 = Math.floor((lat + span / my) / CELL);
    const j0 = Math.floor((lon - span / mx) / CELL);
    const j1 = Math.floor((lon + span / mx) / CELL);
    for (let i = i0; i <= i1; i++) {
      const cLat = (i + 0.5) * CELL;
      const c = metresPerDegree(cLat);
      const km2 = (CELL * c.mx * CELL * c.my) / 1e6;
      for (let j = j0; j <= j1; j++) {
        const rho = rateAt(m, kind, cLat, (j + 0.5) * CELL);
        if (!(rho > 0)) continue;
        const p = Math.min(1, (rho * km2) / SLOTS);
        for (let k = 0; k < SLOTS; k++) {
          const phase = hash4(i, j, k * 3 + KIND_N[kind], 11) * SPELL;
          const n = Math.floor((t - phase) / SPELL);
          let q = 0;
          const r = () => hash4(i * 16 + k * 4 + KIND_N[kind], j, n, ++q);
          if (r() >= p) continue;
          const e: Encounter = {
            id: `${kind}:${i}:${j}:${k}:${n}`,
            kind,
            lat: (i + r()) * CELL,
            lon: (j + r()) * CELL,
            heading: r() * 360,
            speed: L.speed[0] + (L.speed[1] - L.speed[0]) * r(),
            count: L.size[0] + Math.floor((L.size[1] - L.size[0] + 1) * r()),
            tMid: phase + (n + 0.5) * SPELL,
            seed: r(),
          };
          const at = animalAt(e, t);
          if (!wet(at.lat, at.lon)) continue;
          const d = metresTo(lat, lon, at);
          if (d < radius) out.push({ e, d });
        }
      }
    }
  }
  return out.sort((a, b) => a.d - b.d).map((x) => x.e);
}

// ---- The animals themselves (local frame: +x forward, y up, +z to port). ----

function paint(g: THREE.BufferGeometry, colour: THREE.ColorRepresentation): THREE.BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g;
  n.deleteAttribute("uv");
  const c = new THREE.Color(colour);
  const a = new Float32Array(n.attributes.position.count * 3);
  for (let i = 0; i < a.length; i += 3) a.set([c.r, c.g, c.b], i);
  n.setAttribute("color", new THREE.BufferAttribute(a, 3));
  return n;
}

/** A streamlined body, `len` long, `fat` across, darker above. */
function body(len: number, fat: number, back: string, belly: string): THREE.BufferGeometry[] {
  const top = new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  top.scale(len / 2, fat / 2, fat / 2);
  const bottom = new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  bottom.scale(len / 2, fat / 2.4, fat / 2);
  return [paint(top, back), paint(bottom, belly)];
}

/** A flat triangle fin standing up at (x, y), raked aft. */
function fin(x: number, y: number, h: number, base: number, colour: string, flat = false): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.lineTo(-base, 0);
  s.quadraticCurveTo(-base * 0.9, h * 0.6, -base * 1.1, h);
  s.quadraticCurveTo(-base * 0.3, h * 0.5, 0, 0);
  const g = new THREE.ExtrudeGeometry(s, { depth: Math.max(0.02, h * 0.08), bevelEnabled: false, curveSegments: 4 });
  g.translate(base / 2, 0, -Math.max(0.02, h * 0.08) / 2);
  if (flat) g.rotateX(Math.PI / 2);
  g.translate(x, y, 0);
  return paint(g, colour);
}

const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0 });
const birdMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide });

let dolphinGeo: THREE.BufferGeometry | null = null;
let whaleGeo: THREE.BufferGeometry | null = null;
let birdBody: THREE.BufferGeometry | null = null;
let birdWing: THREE.BufferGeometry | null = null;

function dolphinGeometry(): THREE.BufferGeometry {
  return (dolphinGeo ??= mergeGeometries([
    ...body(2.3, 0.45, "#4f5964", "#c9ccd0"),
    fin(0.05, 0.15, 0.35, 0.3, "#47505a"), // dorsal fin
    fin(-1.05, 0, 0.3, 0.2, "#47505a", true), // flukes, flat
  ])!);
}

function whaleGeometry(): THREE.BufferGeometry {
  return (whaleGeo ??= mergeGeometries([
    ...body(14, 2.6, "#2c3237", "#5b6168"),
    fin(-3.2, 1.0, 0.6, 0.9, "#262b30"), // small dorsal fin, far back
    fin(-6.6, 0, 1.6, 0.9, "#262b30", true), // flukes
  ])!);
}

function birdParts(): { body: THREE.BufferGeometry; wing: THREE.BufferGeometry } {
  // A shearwater or a gull: dusky above, pale below, about a metre and a half across.
  birdBody ??= mergeGeometries(body(0.5, 0.12, "#5e5b55", "#ecebe6"))!;
  if (!birdWing) {
    // One wing, from the shoulder (origin) out along +z, swept back, dark at the tip.
    const s = new THREE.Shape();
    s.moveTo(0.07, 0);
    s.lineTo(0.0, 0.72);
    s.lineTo(-0.14, 0.8);
    s.lineTo(-0.12, 0);
    const g = new THREE.ShapeGeometry(s);
    g.rotateX(Math.PI / 2); // into the horizontal plane, the span out along +z
    birdWing = paint(g, "#6a675f");
  }
  return { body: birdBody, wing: birdWing };
}

/** A blow: a puff of spray, white, seen against the sea. */
let blowTex: THREE.Texture | null = null;
function blowMaterial(): THREE.SpriteMaterial {
  if (!blowTex && typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, "rgba(255,255,255,0.9)");
    r.addColorStop(0.5, "rgba(255,255,255,0.35)");
    r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r;
    g.fillRect(0, 0, 64, 64);
    blowTex = new THREE.CanvasTexture(c);
  }
  return new THREE.SpriteMaterial({ map: blowTex, transparent: true, depthWrite: false, opacity: 0 });
}

interface Member {
  obj: THREE.Object3D;
  /** Its place in the group (m, along and across the way it's going). */
  ax: number;
  az: number;
  phase: number;
  wings?: [THREE.Object3D, THREE.Object3D];
  blow?: THREE.Sprite;
}

interface Shown {
  e: Encounter;
  root: THREE.Group;
  members: Member[];
}

function build(e: Encounter): Shown {
  const root = new THREE.Group();
  root.name = `wildlife_${e.kind}`;
  const members: Member[] = [];
  let s = Math.floor(e.seed * 1e6) + 1;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < e.count; k++) {
    const m: Member = { obj: new THREE.Group(), ax: 0, az: 0, phase: rnd() };
    if (e.kind === "dolphins") {
      m.obj.add(new THREE.Mesh(dolphinGeometry(), material));
      m.ax = (rnd() - 0.5) * 30;
      m.az = (rnd() - 0.5) * 16;
    } else if (e.kind === "whales") {
      m.obj.add(new THREE.Mesh(whaleGeometry(), material));
      m.ax = (rnd() - 0.5) * 60;
      m.az = (rnd() - 0.5) * 40;
      m.blow = new THREE.Sprite(blowMaterial());
      m.blow.position.set(5.5, 0, 0); // the blowhole, near the head
      m.obj.add(m.blow);
    } else {
      const p = birdParts();
      m.obj.add(new THREE.Mesh(p.body, birdMaterial));
      const l = new THREE.Mesh(p.wing, birdMaterial);
      const r = new THREE.Mesh(p.wing, birdMaterial);
      r.scale.z = -1;
      m.obj.add(l, r);
      m.wings = [l, r];
      m.obj.rotation.order = "YXZ"; // heading, then bank
      m.ax = 20 + rnd() * 60; // wheeling radius
      m.az = 2 + rnd() * 7; // height
    }
    root.add(m.obj);
    members.push(m);
  }
  return { e, root, members };
}

/** Put each animal where it is at time t, relative to the group's centre. */
function animate(sh: Shown, t: number, hs: number): void {
  const { e } = sh;
  for (const m of sh.members) {
    const o = m.obj;
    if (e.kind === "dolphins") {
      // Porpoising: a leap clear of the water every few seconds, under between.
      const period = 2.2 + 1.2 * m.phase;
      const u = ((t / period + m.phase) % 1 + 1) % 1;
      const air = 0.4;
      const k = u / air;
      const y = u < air ? 1.1 * Math.sin(Math.PI * k) : -1.2;
      o.position.set(m.ax, y, m.az);
      o.rotation.set(0, 0, u < air ? 1.2 * Math.cos(Math.PI * k) * 0.6 : 0); // nose up, then down
    } else if (e.kind === "whales") {
      // Up to breathe a minute or so apart: the back rolls through the surface, and it blows.
      const period = 50 + 30 * m.phase;
      const u = ((t / period + m.phase) % 1 + 1) % 1;
      const up = u < 0.2 ? Math.sin((Math.PI * u) / 0.2) : 0;
      o.position.set(m.ax, -2.2 + 2.3 * up + 0.15 * hs * Math.sin(t + m.phase * 9), m.az);
      o.rotation.set(0, 0, u < 0.2 ? 0.12 * Math.cos((Math.PI * u) / 0.2) : 0);
      const b = m.blow!;
      const bu = u / 0.06; // the first few seconds of the rise
      const on = u < 0.06 ? Math.sin(Math.PI * Math.min(1, bu)) : 0;
      b.material.opacity = 0.85 * on;
      b.scale.set(1.5 + 2.5 * bu, 3 + 5 * bu, 1);
      b.position.y = 1.2 + 3 * Math.min(1, bu);
    } else {
      // Wheeling round over the group's patch of sea, rising and falling, flapping now and then.
      const w = 0.12 + 0.1 * m.phase;
      const a = t * w * (m.phase < 0.5 ? 1 : -1) + m.phase * 20;
      o.position.set(Math.cos(a) * m.ax, Math.max(1.5, m.az + 2 * Math.sin(t * 0.3 + m.phase * 7)), Math.sin(a) * m.ax);
      const turn = m.phase < 0.5 ? 1 : -1;
      o.rotation.set(0.35 * turn, -a - (turn * Math.PI) / 2, 0); // along the circle, banked into the turn
      const flapping = Math.sin(t * 0.7 + m.phase * 30) > 0.4;
      const f = flapping ? 0.6 * Math.sin(t * 22 + m.phase * 10) : 0.08;
      m.wings![0].rotation.x = f;
      m.wings![1].rotation.x = -f;
    }
  }
}

export class Wildlife {
  readonly root = new THREE.Group();
  readonly shown = { dolphins: 0, whales: 0, birds: 0, nearest: Infinity, bearing: 0, known: false };
  private live = new Map<string, Shown>();
  private last: { t: number; lat: number; lon: number } | null = null;

  private constructor(private readonly map: WildlifeMap | null) {
    this.root.name = "wildlife";
    this.shown.known = map !== null;
  }

  static async load(base = "."): Promise<Wildlife> {
    try {
      const r = await fetch(`${base}/wildlife.json`);
      if (!r.ok || (r.headers.get("content-type") ?? "").includes("text/html")) return new Wildlife(null);
      return new Wildlife((await r.json()) as WildlifeMap);
    } catch {
      return new Wildlife(null);
    }
  }

  static from(map: WildlifeMap): Wildlife {
    return new Wildlife(map);
  }

  /**
   * Each frame, our boat at the origin at (lat, lon), time t (s, UTC); `seeing` the
   * fog's far edge (m); `wet` says whether a place is sea (so nothing swims ashore);
   * `clock` the page's running time (s), which keeps them leaping and flapping even
   * when the voyage's own time stands still.
   */
  update(lat: number, lon: number, t: number, seeing: number, hs: number, wet?: (lat: number, lon: number) => boolean, clock = t): void {
    const m = this.map;
    if (!m || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(t)) return;
    const hidden = (k: Animal) => Math.min(LOOK[k].seen, seeing);
    const last = this.last;
    const jumped = !last || Math.abs(t - last.t) > SPELL / 2 || metresTo(lat, lon, last) > 5000;
    if (jumped || Math.abs(t - last!.t) > 5 || metresTo(lat, lon, last!) > 100) {
      this.last = { t, lat, lon };
      const per = { dolphins: 0, whales: 0, birds: 0 };
      const near = animalsNear(m, lat, lon, t, 1.2, wet).filter((e) => ++per[e.kind] <= MAX_GROUPS);
      const want = new Set(near.map((e) => e.id));
      for (const [id, l] of this.live) {
        const d = metresTo(lat, lon, animalAt(l.e, t));
        const keep = want.has(id) || (!jumped && d <= hidden(l.e.kind));
        if (!keep || d > LOOK[l.e.kind].seen * 1.3) this.remove(id);
      }
      for (const e of near) if (!this.live.has(e.id) && (jumped || metresTo(lat, lon, animalAt(e, t)) > hidden(e.kind))) this.add(e);
    }
    const { mx, my } = metresPerDegree(lat);
    const c = { dolphins: 0, whales: 0, birds: 0 };
    let nearest = Infinity;
    let bearing = 0;
    for (const sh of this.live.values()) {
      const p = animalAt(sh.e, t);
      const x = (p.lon - lon) * mx;
      const z = -(p.lat - lat) * my;
      const d = Math.hypot(x, z);
      if (d < nearest) {
        nearest = d;
        bearing = (THREE.MathUtils.radToDeg(Math.atan2(x, -z)) + 360) % 360;
      }
      if (d < hidden(sh.e.kind)) c[sh.e.kind]++;
      sh.root.position.set(x, 0, z);
      sh.root.rotation.y = THREE.MathUtils.degToRad(90 - sh.e.heading); // +x forward to the heading
      animate(sh, clock, hs);
    }
    Object.assign(this.shown, c, { nearest, bearing });
  }

  private add(e: Encounter): void {
    const sh = build(e);
    this.root.add(sh.root);
    this.live.set(e.id, sh);
  }

  private remove(id: string): void {
    const sh = this.live.get(id);
    if (!sh) return;
    this.root.remove(sh.root);
    sh.root.traverse((o) => {
      if (o instanceof THREE.Sprite) o.material.dispose(); // each blow has its own; the rest is shared
    });
    this.live.delete(id);
  }
}
