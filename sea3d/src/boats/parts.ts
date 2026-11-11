// Geometry helpers shared by both boat models (ported from Iris's boats-3d
// viewer). Boat-building frame inside these helpers: x aft from the bow,
// y up from the hull bottom, z to the side. boats/model.ts turns that into
// the sea3d boat frame (origin on the waterline amidships, bow towards +x).

import * as THREE from "three";

export type Quality = "low" | "high";

/** Mesh resolution per quality setting. Low keeps older laptops smooth. */
export interface Detail {
  hullStations: number;
  hullSide: number;
  hullDeck: number;
  foil: number;
  lathe: number;
  round: number;
  panel: [number, number];
}

export const DETAIL: Record<Quality, Detail> = {
  low: { hullStations: 40, hullSide: 12, hullDeck: 6, foil: 16, lathe: 14, round: 10, panel: [10, 5] },
  high: { hullStations: 90, hullSide: 22, hullDeck: 10, foil: 40, lathe: 32, round: 24, panel: [30, 14] },
};

/** Hull shape: half-breadth, keel line and deck line as functions of s = x / L. */
export interface HullForm {
  L: number;
  n: number; // section fullness
  crown: number; // deck camber, m
  wl: number; // waterline above the hull bottom, m
  hb: (s: number) => number;
  kz: (s: number) => number;
  dz: (s: number) => number;
}

export interface HullColours {
  top: number;
  deck: number;
  bottom: number;
  boot?: number;
}

/** Everything a boat builder needs, with materials tracked for disposal. */
export class Kit {
  readonly detail: Detail;
  private readonly owned: { dispose(): void }[] = [];

  constructor(readonly quality: Quality) {
    this.detail = DETAIL[quality];
  }

  keep<T extends { dispose(): void }>(x: T): T {
    this.owned.push(x);
    return x;
  }

  dispose(): void {
    this.owned.forEach((x) => x.dispose());
    this.owned.length = 0;
  }

  std(hex: number, o: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
    return this.keep(
      new THREE.MeshStandardMaterial({ color: hex, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide, ...o }),
    );
  }

  mesh(geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D): THREE.Mesh {
    this.keep(geo);
    const m = new THREE.Mesh(geo, mat);
    parent.add(m);
    return m;
  }

  box(parent: THREE.Object3D, mat: THREE.Material, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) {
    const m = this.mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), mat, parent);
    m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    return m;
  }

  cyl(parent: THREE.Object3D, mat: THREE.Material, r: number, x: number, y0: number, y1: number, z = 0) {
    const m = this.mesh(new THREE.CylinderGeometry(r, r, y1 - y0, this.detail.round), mat, parent);
    m.position.set(x, (y0 + y1) / 2, z);
    return m;
  }

  /** Cylinder between two points. */
  rod(parent: THREE.Object3D, mat: THREE.Material, r: number, a: number[], b: number[]) {
    const va = new THREE.Vector3(a[0], a[1], a[2]);
    const vb = new THREE.Vector3(b[0], b[1], b[2]);
    const m = this.mesh(new THREE.CylinderGeometry(r, r, va.distanceTo(vb), Math.max(6, this.detail.round / 2)), mat, parent);
    m.position.copy(va).add(vb).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
    return m;
  }

  /** Hull from station sections, coloured by vertex (bottom paint, boot top, topsides, deck). */
  hull(f: HullForm, colors: HullColours): THREE.BufferGeometry {
    const { hullStations: nx, hullSide: nt, hullDeck: nd } = this.detail;
    const L = f.L;
    type P = [number, number, number, "side" | "deck"];
    const rings: P[][] = [];
    for (let i = 0; i <= nx; i++) {
      const s = i / nx;
      const x = s * L;
      const b = Math.max(f.hb(s), 0.0005);
      const zk = f.kz(s);
      const zd = f.dz(s);
      const ring: P[] = [];
      for (let j = 0; j <= nt; j++) {
        const t = Math.pow(j / nt, 1.6);
        const y = b * Math.pow(1 - Math.pow(1 - t, f.n), 1 / f.n);
        ring.push([x, zk + t * (zd - zk), y, "side"]);
      }
      for (let j = 1; j < nd; j++) {
        const zz = b * (1 - (2 * j) / nd);
        ring.push([x, zd + f.crown * (1 - (zz / b) ** 2), zz, "deck"]);
      }
      for (let j = nt; j >= 0; j--) {
        const p = ring[j];
        ring.push([p[0], p[1], -p[2], "side"]);
      }
      rings.push(ring);
    }
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const n = rings[0].length;
    const cTop = new THREE.Color(colors.top);
    const cBot = new THREE.Color(colors.bottom);
    const cDeck = new THREE.Color(colors.deck);
    const cBoot = new THREE.Color(colors.boot ?? colors.bottom);
    for (const r of rings) {
      for (const p of r) {
        pos.push(p[0], p[1], p[2]);
        let c = cTop;
        if (p[3] === "deck") c = cDeck;
        else if (p[1] < f.wl - 0.004) c = cBot;
        else if (p[1] < f.wl + 0.022) c = cBoot;
        col.push(c.r, c.g, c.b);
      }
    }
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < n - 1; j++) {
        const a = i * n + j;
        const b = (i + 1) * n + j;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    // stern cap
    const last = rings[nx];
    const base = pos.length / 3;
    const cy = last.reduce((s, p) => s + p[1], 0) / last.length;
    pos.push(f.L, cy, 0);
    col.push(cTop.r, cTop.g, cTop.b);
    for (let j = 0; j < n - 1; j++) idx.push(nx * n + j, base, nx * n + j + 1);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  /** Tapered symmetric NACA 00xx foil between two horizontal sections (fins, rudders, wings). */
  foil(rootC: number, tipC: number, rootLE: number, tipLE: number, y0: number, y1: number, t: number): THREE.BufferGeometry {
    const prof = naca(t, this.detail.foil);
    const m = prof.length;
    const pos: number[] = [];
    const idx: number[] = [];
    const secs: [number, number, number][] = [
      [rootC, rootLE, y0],
      [tipC, tipLE, y1],
    ];
    for (const [c, le, y] of secs) for (const p of prof) pos.push(le + p[0] * c, y, p[1] * c);
    for (let k = 0; k < m; k++) {
      const k2 = (k + 1) % m;
      idx.push(k, k2, m + k, k2, m + k2, m + k);
    }
    secs.forEach(([cc, le, y], si) => {
      const c = pos.length / 3;
      pos.push(le + 0.4 * cc, y, 0);
      for (let k = 0; k < m; k++) {
        const a = si * m + k;
        const b = si * m + ((k + 1) % m);
        if (si) idx.push(a, c, b);
        else idx.push(a, b, c);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  /** Streamlined lead bulb, nose at x0, axis along +x. */
  bulb(parent: THREE.Object3D, mat: THREE.Material, len: number, dia: number, maxAt: number, x0: number, y: number, z: number) {
    const R = dia / 2;
    const pts: THREE.Vector2[] = [];
    for (let k = 0; k <= 40; k++) {
      const u = k / 40;
      const r =
        u <= maxAt
          ? R * Math.sqrt(Math.max(1 - ((maxAt - u) / maxAt) ** 2, 0))
          : R * Math.pow(Math.max(1 - ((u - maxAt) / (1 - maxAt)) ** 2, 0), 0.75);
      pts.push(new THREE.Vector2(Math.max(r, 0.0005), u * len));
    }
    const g = new THREE.LatheGeometry(pts, this.detail.lathe);
    g.rotateZ(-Math.PI / 2);
    const m = this.mesh(g, mat, parent);
    m.position.set(x0, y, z);
    return m;
  }

  /** Solar panel draped over a surface height function top(x, z). */
  panel(parent: THREE.Object3D, x0: number, x1: number, w: number, top: (x: number, z: number) => number, cols: number, rows: number) {
    const [nx, nz] = this.detail.panel;
    // Each corner sits on the highest point of the surface within one cell of it,
    // so the flat facets clear a steep-sided surface (the kayak's dome shoulders)
    // instead of letting it poke through the cells.
    const dx = (x1 - x0) / nx;
    const dz = w / nz;
    const env = (x: number, z: number) => {
      let y = -Infinity;
      for (let a = -4; a <= 4; a++) for (let b = -4; b <= 4; b++) y = Math.max(y, top(x + (dx * a) / 4, z + (dz * b) / 4));
      return y;
    };
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= nx; i++) {
      for (let j = 0; j <= nz; j++) {
        const x = x0 + ((x1 - x0) * i) / nx;
        const z = -w / 2 + (w * j) / nz;
        pos.push(x, env(x, z) + 0.014, z);
        uv.push(i / nx, j / nz);
      }
    }
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        const a = i * (nz + 1) + j;
        const b = a + nz + 1;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const map = this.keep(cellTexture(cols, rows));
    const m = this.mesh(g, this.std(0xffffff, { map, roughness: 0.3, metalness: 0.3 }), parent);
    m.name = "panel"; // the gear finds panels by name
    return m;
  }
}

/** Closed symmetric NACA 00xx outline, chord along +x (0..1), thickness along z. */
export function naca(t: number, n = 40): [number, number][] {
  const pts: [number, number][] = [];
  for (let k = 0; k <= n; k++) {
    const xc = (1 - Math.cos((Math.PI * k) / n)) / 2;
    const yt = 5 * t * (0.2969 * Math.sqrt(xc) - 0.126 * xc - 0.3516 * xc * xc + 0.2843 * xc ** 3 - 0.1036 * xc ** 4);
    pts.push([xc, yt]);
  }
  const out = pts.slice().reverse();
  for (let k = 1; k < pts.length - 1; k++) out.push([pts[k][0], -pts[k][1]]);
  return out;
}

/** Solar panel texture: dark cells with silver lines. */
function cellTexture(cols: number, rows: number): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = 256;
  cv.height = 256;
  const g = cv.getContext("2d")!;
  g.fillStyle = "#16233d";
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = "#7f93b3";
  g.lineWidth = 2;
  for (let i = 0; i <= cols; i++) {
    g.beginPath();
    g.moveTo((i * 256) / cols, 0);
    g.lineTo((i * 256) / cols, 256);
    g.stroke();
  }
  for (let i = 0; i <= rows; i++) {
    g.beginPath();
    g.moveTo(0, (i * 256) / rows);
    g.lineTo(256, (i * 256) / rows);
    g.stroke();
  }
  g.strokeStyle = "#c9d3e2";
  g.lineWidth = 6;
  g.strokeRect(0, 0, 256, 256);
  const tx = new THREE.CanvasTexture(cv);
  tx.colorSpace = THREE.SRGBColorSpace;
  tx.anisotropy = 4;
  return tx;
}
