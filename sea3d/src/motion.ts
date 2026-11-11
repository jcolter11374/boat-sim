// Wave motion for the 3D view: heave, pitch and roll of a boat on the sea from
// waves.ts. DISPLAY PHYSICS ONLY: nothing here feeds the Python simulator or the
// odds. The simulator in src/boatsim/ stays the referee.
//
// Model (3 degrees of freedom, each a damped oscillator driven by the sea under
// the hull):
//   * Every substep, sample the wave height at a grid of points over the
//     waterplane and fit a plane: mean height, slope along the boat, slope
//     across it. Averaging over the hull filters out waves much shorter than
//     the boat, as a real hull does.
//   * Heave:  (m + a33) z''  = -rho g Awp (z - eta)        - c33 (z' - eta')
//   * Pitch:  (Iyy + a55) th'' = -Disp g GM_L (th - slope_x) - c55 th'
//   * Roll:   (Ixx + a44) ph'' = -Disp g GZ(ph - slope_z)   - c44 ph'
//     GZ is the boat's full righting-arm curve (0 to 180 deg), so a knockdown
//     or a capsize rights itself the way the stability numbers say it should.
//   * Damping is set as a fraction of critical (zeta) for each motion, plus
//     quadratic roll damping from the keel fin and bulb dragged sideways,
//     which dominates in big rolls.
//   * Semi-implicit Euler at a fixed 5 ms substep: stable for the stiffest
//     motion here (kayak pitch, ~0.7 s natural period).
//
// Simplifications, all fine for a picture: no coupling between the motions,
// no yaw or surge (the heading comes from the simulator), wave heights are
// sampled without the Gerstner sideways shift, and the boat sits at a fixed
// point in plan.
//
// Axes: three.js world, x = east, y = up, z = south. Boat local axes: bow +x,
// up +y, starboard +z. Pitch + = bow up, roll + = heel to starboard. Apply as
//   obj.position.set(x, heave, z); obj.rotation.set(roll, yaw, pitch, "YZX")
// with the mesh origin at the centre of gravity (cgBelowWaterline below the
// static waterline).

import { G, type WaveComponent } from "./waves";

export const RHO = 1025; // kg/m^3, sea water

/** A point mass: [kg, height above the static waterline (m), note]. */
export type MassItem = [number, number, string];

export interface HullParams {
  name: string;
  mass: number; // kg, all-up
  waterlineLength: number; // m
  waterlineBeam: number; // m
  waterplaneCoeff: number; // waterplane area / (L B)
  /** Righting arm GZ (m) at heel angles (deg), 0..180. Linear in between. */
  gzTable: [number, number][];
  /** Roll inertia about the centre of gravity, dry, kg m^2. */
  rollInertia: number;
  /** Pitch inertia about the centre of gravity, dry, kg m^2. */
  pitchInertia: number;
  cgBelowWaterline: number; // m
  cgX: number; // m aft of the bow
  // Added mass (water moving with the hull) as a fraction of the dry value.
  addedHeave: number;
  addedPitch: number;
  addedRoll: number;
  // Damping, fraction of critical.
  zetaHeave: number;
  zetaPitch: number;
  zetaRoll: number;
  /** Quadratic roll damping from the keel fin and bulb being dragged sideways,
   *  N m s^2: moment = -k |phi'| phi'. 0.5 rho Cd sum(A r^3), Cd 1.2 (GUESS). */
  rollQuadDamping: number;
  source: string;
}

/** Centre of gravity height and roll inertia about it, from point masses.
 *  spread[i] adds the item's own inertia m * s^2 / 12 (a bar of width s). */
export function massProperties(
  items: MassItem[],
  spread: number[] = [],
): { mass: number; cg: number; rollInertia: number } {
  const mass = items.reduce((s, [m]) => s + m, 0);
  const cg = items.reduce((s, [m, z]) => s + m * z, 0) / mass;
  const rollInertia = items.reduce(
    (s, [m, z], i) => s + m * (z - cg) ** 2 + (m * (spread[i] ?? 0) ** 2) / 12,
    0,
  );
  return { mass, cg, rollInertia };
}

/** Integral of chord * |r|^3 dr for a fin from r0 to r1 below the CG (m^4). */
function finR3(chord: number, r0: number, r1: number): number {
  const f = (r: number) => (Math.sign(r) * r ** 4) / 4;
  return chord * Math.abs(f(r1) - f(r0));
}

/** GZ for angles below `upTo` from the small-angle form GM sin(phi). */
function gmPoints(gm: number, upTo: number, step = 5): [number, number][] {
  const out: [number, number][] = [];
  for (let a = 0; a < upTo; a += step) out.push([a, gm * Math.sin((a * Math.PI) / 180)]);
  return out;
}

// --- v4 kayak (configs/v4_kayak.yaml, design doc "Self-righting") ------------
// Mass budget from the design doc: kg, height from the waterline. It gives
// 123 kg with the centre of gravity 0.38 m below the waterline (doc: -0.38).
export const KAYAK_MASS_ITEMS: MassItem[] = [
  [32, 0.02, "kayak hull and foam fill"],
  [5, 0.27, "dome"],
  [6, 0.23, "solar panels"],
  [7, -0.5, "keel fin"],
  [50, -0.9, "lead bulb"],
  [11, -0.08, "batteries"],
  [12, -0.07, "thrusters, rudder, electronics, payload"],
];
// Own width or height of the spread-out items, for their self-inertia (GUESS:
// hull 0.79 m beam and ~0.35 m deep, dome 0.46 m wide, panels across the
// deck, fin 0.65 m span).
const KAYAK_SPREAD = [Math.hypot(0.79, 0.35), 0.46, 0.79, 0.65, 0.07, 0.3, 0.3];
const kayakMass = massProperties(KAYAK_MASS_ITEMS, KAYAK_SPREAD);
// Design doc GZ table (2D section, 2.6 m effective length): 30..170 deg, positive
// to 180 deg (self-righting). Below 30 deg: GM sin(phi) with GM = 0.70 m, the
// value that meets the 30 deg point (GUESS until the heel test measures GM).
export const KAYAK_GM = 0.7;

export const KAYAK_V4: HullParams = {
  name: "v4 kayak",
  mass: kayakMass.mass,
  waterlineLength: 2.9, // design doc speed model
  waterlineBeam: 0.7, // GUESS: 0.79 m at the gunwale, a little less at the waterline
  waterplaneCoeff: 0.7, // GUESS: typical kayak waterplane
  gzTable: [
    ...gmPoints(KAYAK_GM, 30),
    [30, 0.35],
    [60, 0.44],
    [90, 0.43],
    [120, 0.3],
    [150, 0.19],
    [170, 0.09],
    [180, 0],
  ],
  rollInertia: kayakMass.rollInertia,
  // GUESS: radius of gyration 0.25 L for the hull, plus the bulb hanging 0.5 m
  // below the centre of gravity.
  pitchInertia: kayakMass.mass * (0.25 * 3.05) ** 2,
  cgBelowWaterline: -kayakMass.cg,
  cgX: 3.05 / 2, // GUESS: floats level, so the CG sits over mid-length
  addedHeave: 1.0, // GUESS: shallow wide sections carry about their own mass of water
  addedPitch: 0.5, // GUESS
  addedRoll: 0.15, // GUESS: fin and bulb push water sideways (~2-4 kg m^2 of ~28)
  zetaHeave: 0.25, // GUESS: wave-making damping of a light, wide hull
  zetaPitch: 0.25, // GUESS
  zetaRoll: 0.12, // GUESS: deep fin keel boats ~0.1-0.2; plain hulls ~0.05
  // fin 0.25 x 0.65 m from 0.15 to 0.80 m down; bulb ~0.30 x 0.15 m side-on,
  // 0.52 m below the CG (0.38 m below the waterline)
  rollQuadDamping: 0.5 * RHO * 1.2 * (finR3(0.25, 0.15 - 0.38, 0.8 - 0.38) + 0.045 * 0.52 ** 3),
  source: "design doc v4 (mass budget, GZ table), configs/v4_kayak.yaml",
};

// --- Randolph team Rev B (drone-boat simulator/drone_sim/design.py, MIT) -----
// Published numbers (docs/Simulation_RevB.md): 20.8 kg, GM 0.201 m, max GZ
// 0.434 m, self-righting from 180 deg. The GZ curve and inertias are theirs:
// docs/data/revB_gz_curve.csv (geometry.py gz_curve, free trim, full load),
// shared on our #50, 9 Nov 2026. Point masses (for the CG) estimated from
// design.py (heights above the hull bottom, x aft of the bow).
export const REVB_MASS_ITEMS: MassItem[] = [
  [7.9, -0.434, "lead bulb, 0.32 m x 68 mm"],
  [0.9, -0.2, "keel fin and rod"],
  [0.45, -0.07, "rudder and stock"],
  [2.4, 0.12, "hull and deck laminate, ~1.5 m^2 at 1.6 kg/m^2"],
  [2.24, 0.65, "wing rig with counterweight (balanced on the pivot)"],
  [2.0, 0.1, "battery"],
  [1.2, 0.1, "electronics box"],
  [1.0, 0.235, "solar panels"],
  [0.45, 0.13, "mast tube and housing"],
  [0.25, 0.14, "rudder servo and tube"],
  [0.9, 0.42, "stern stub, vane, antenna, reflector"],
  [0.5, 0.02, "keel box and backing"],
  [0.6, 0.12, "misc fittings"],
];
// x of each item, m aft of the bow (design.py; bulb and fin centres ~0.74 m).
const REVB_X = [0.74, 0.74, 1.4, 0.72, 0.6, 0.87, 1.1, 1.06, 0.6, 1.36, 1.53, 0.745, 0.8];
// Their waterline: 0.09 m above the hull bottom (design.py frame).
const REVB_WATERLINE = 0.09;
const REVB_SPREAD = [0.07, 0.43, 0.23, 0.45, 1.0, 0, 0, 0.4, 0, 0, 0, 0, 0];
const revbMass = massProperties(REVB_MASS_ITEMS, REVB_SPREAD);
export const REVB_GM = 0.201;
// Righting arm (deg, m) every 5 deg. The jump between 90 and 100 deg is the
// buoyant wing going under; max 0.434 m at 105 deg; no negative range.
const revbGz: [number, number][] = [
  [0, 0.0], [5, 0.0175], [10, 0.0349], [15, 0.0521], [20, 0.0689], [25, 0.0852], [30, 0.101], [35, 0.1161],
  [40, 0.1305], [45, 0.1439], [50, 0.1552], [55, 0.1639], [60, 0.1706], [65, 0.1753], [70, 0.1788], [75, 0.1818],
  [80, 0.1872], [85, 0.2054], [90, 0.2005], [95, 0.2935], [100, 0.4129], [105, 0.4341], [110, 0.4312], [115, 0.4178],
  [120, 0.398], [125, 0.3737], [130, 0.3456], [135, 0.3142], [140, 0.2798], [145, 0.2432], [150, 0.2052], [155, 0.1663],
  [160, 0.1273], [165, 0.0894], [170, 0.0545], [175, 0.0246], [180, 0.0],
];

export const RANDOLPH_REVB: HullParams = {
  name: "Randolph Rev B",
  mass: 20.8,
  waterlineLength: 1.4, // GUESS: 1.5 m hull, rockered ends
  waterlineBeam: 0.36, // GUESS: 0.40 m max beam
  waterplaneCoeff: 0.68, // GUESS
  gzTable: revbGz,
  rollInertia: 2.487, // their Ixx about the CG: hull, wing and rig
  pitchInertia: 4.117, // their Iyy about the CG
  cgBelowWaterline: REVB_WATERLINE - revbMass.cg,
  cgX: REVB_X.reduce((s, x, i) => s + x * REVB_MASS_ITEMS[i][0], 0) / revbMass.mass,
  addedHeave: 1.0,
  addedPitch: 0.5,
  addedRoll: 0.15,
  zetaHeave: 0.25,
  zetaPitch: 0.25,
  zetaRoll: 0.12,
  // fin 0.16 m chord from the hull bottom to 0.43 m below it; bulb 0.32 x 0.068 m
  // side-on at the fin tip. CG ~0.04 m above the bottom.
  rollQuadDamping: 0.5 * RHO * 1.2 * (finR3(0.16, -0.04, 0.43 - 0.04) + 0.022 * 0.47 ** 3),
  source: "drone-boat docs/Simulation_RevB.md (mass, GM), docs/data/revB_gz_curve.csv (GZ, inertias), design.py (masses)",
};

// --- Randolph team Rev C (drone-boat simulator/drone_sim/design.py, MIT) -----
// The Randolph team's Rev C (10 Nov 2026): foam-filled hull behind two
// bulkheads, sealed battery box, twin rudders, D72 bulb, YB3 tracker and light
// on the stern stub; 25.2 kg all up, waterline 0.098 m above the bottom. The GZ
// curve is theirs (docs/data/revC_gz_curve.csv, free trim). Point masses are
// their design.py equipment list plus Rev B's structure items above; they sum
// to 25.26 kg. Inertias and the centre of gravity are their measured values
// (designs/revC_geometry.json, 11 Nov 2026), about the CG with x aft, y port,
// z up: Ixx 2.90, Iyy 5.00, Izz 2.15, Ixz -0.70 kg m^2; CG 0.853 m aft of the
// bow and 0.034 m below the hull-bottom datum. Our roll-pitch model uses Ixx
// and Iyy; Izz and Ixz (yaw, and the roll-yaw coupling) wait for a yaw model.
// Our earlier point-mass estimates were within 3 % (2.86, 5.07, 0.847 m).
export const REVC_MASS_ITEMS: MassItem[] = [
  [9.0, -0.436, "lead bulb, 0.32 m x 72 mm"],
  [0.9, -0.2, "keel fin and rod"],
  [0.9, -0.07, "two rudders and stocks"],
  [2.4, 0.12, "hull and deck laminate, ~1.5 m^2 at 1.6 kg/m^2"],
  [2.35, 0.65, "wing rig with counterweight, 30 x 26 mm spar"],
  [2.0, 0.1, "battery"],
  [1.1, 0.1, "electronics box"],
  [1.0, 0.235, "solar panels"],
  [0.45, 0.13, "mast tube and housing"],
  [0.5, 0.14, "two rudder servos and trunks"],
  [0.9, 0.42, "stern stub, vane, antenna, reflector"],
  [0.5, 0.02, "keel box and backing"],
  [0.6, 0.12, "misc fittings"],
  [1.65, 0.13, "XPS foam fill, ~59 L"],
  [0.2, 0.12, "two bulkheads"],
  [0.35, 0.1, "sealed battery box"],
  [0.4, 0.48, "YB3 tracker and platform"],
  [0.06, 0.6, "all-round light"],
];
const REVC_X = [0.74, 0.74, 1.4, 0.72, 0.6, 0.87, 1.1, 1.06, 0.6, 1.36, 1.53, 0.745, 0.8, 0.8, 0.78, 0.87, 1.53, 1.53];
const REVC_WATERLINE = 0.098;
const REVC_SPREAD = [0.072, 0.43, 0.23, 0.45, 1.0, 0, 0, 0.4, 0, 0, 0, 0, 0, 0.23, 0.2, 0, 0, 0];
const revcMass = massProperties(REVC_MASS_ITEMS, REVC_SPREAD);
// GM from the curve's first step: 0.0163 m / sin 5 deg.
export const REVC_GM = 0.187;
const revcGz: [number, number][] = [
  [0, 0.0], [5, 0.0163], [10, 0.0325], [15, 0.0486], [20, 0.0644], [25, 0.0798], [30, 0.0948], [35, 0.1092],
  [40, 0.1231], [45, 0.1352], [50, 0.145], [55, 0.1524], [60, 0.1579], [65, 0.1609], [70, 0.1624], [75, 0.1629],
  [80, 0.1639], [85, 0.1802], [90, 0.1791], [95, 0.2898], [100, 0.3672], [105, 0.3782], [110, 0.3722], [115, 0.3586],
  [120, 0.3402], [125, 0.318], [130, 0.2927], [135, 0.2646], [140, 0.2347], [145, 0.2033], [150, 0.171], [155, 0.1383],
  [160, 0.1061], [165, 0.0753], [170, 0.0471], [175, 0.0225], [180, 0.0],
];
// Their measured values (designs/revC_geometry.json).
export const REVC_IXX = 2.9;
export const REVC_IYY = 5.0;
export const REVC_IZZ = 2.15; // not used yet (no yaw model)
export const REVC_IXZ = -0.7; // not used yet (no yaw model)
const REVC_CG_X = 0.853; // m aft of the bow
const REVC_CG_BELOW_BOTTOM = 0.034; // m below the hull-bottom datum
/** Our point-mass estimate of the CG and roll inertia, kept to check theirs. */
export const REVC_POINT_MASS = {
  ...revcMass,
  cgX: REVC_X.reduce((s, x, i) => s + x * REVC_MASS_ITEMS[i][0], 0) / revcMass.mass,
};

export const RANDOLPH_REVC: HullParams = {
  name: "Randolph Rev C",
  mass: 25.2,
  waterlineLength: 1.43, // their simulator at the 98 mm waterline
  waterlineBeam: 0.34, // their randolph_rev_c.yaml
  waterplaneCoeff: 0.68, // GUESS: as Rev B
  gzTable: revcGz,
  rollInertia: REVC_IXX, // their measured Ixx about the CG
  pitchInertia: REVC_IYY, // their measured Iyy about the CG
  cgBelowWaterline: REVC_WATERLINE + REVC_CG_BELOW_BOTTOM,
  cgX: REVC_CG_X,
  addedHeave: 1.0,
  addedPitch: 0.5,
  addedRoll: 0.15,
  zetaHeave: 0.25,
  zetaPitch: 0.25,
  zetaRoll: 0.12,
  // as Rev B, with the CG ~0.07 m above the bottom and the D72 bulb (0.32 x 0.072 m)
  rollQuadDamping: 0.5 * RHO * 1.2 * (finR3(0.16, -0.07, 0.43 - 0.07) + 0.023 * 0.5 ** 3),
  source:
    "drone-boat designs/boat-sim/randolph_rev_c.yaml (mass), docs/data/revC_gz_curve.csv (GZ), simulator/drone_sim/design.py (masses), designs/revC_geometry.json (measured inertias and CG)",
};

/** Righting arm (m) at heel phi (rad), any angle; odd and 360-periodic. */
export function gz(p: HullParams, phi: number): number {
  let a = (((phi * 180) / Math.PI + 180) % 360 + 360) % 360 - 180; // -180..180
  const sign = a < 0 ? -1 : 1;
  a = Math.abs(a);
  const tab = p.gzTable;
  for (let i = 1; i < tab.length; i++) {
    if (a <= tab[i][0]) {
      const [a0, g0] = tab[i - 1];
      const [a1, g1] = tab[i];
      return sign * (g0 + ((g1 - g0) * (a - a0)) / (a1 - a0));
    }
  }
  return 0;
}

/** Initial stability GM (m): slope of the GZ curve at zero heel. */
export function gmOf(p: HullParams): number {
  const [a1, g1] = p.gzTable[1];
  return g1 / Math.sin((a1 * Math.PI) / 180);
}

export interface Derived {
  displacementN: number; // weight, N
  waterplaneArea: number; // m^2
  gmLong: number; // longitudinal metacentric height, m
  heaveStiffness: number; // N/m
  heaveMass: number;
  pitchInertia: number; // with added
  rollInertia: number; // with added
  periodHeave: number; // s, undamped
  periodPitch: number;
  periodRoll: number;
}

export function derive(p: HullParams): Derived {
  const W = p.mass * G;
  const Awp = p.waterplaneCoeff * p.waterlineLength * p.waterlineBeam;
  // Longitudinal waterplane inertia, about 0.7 of the rectangle's (GUESS shape).
  const IL = 0.7 * p.waterplaneCoeff * (p.waterlineBeam * p.waterlineLength ** 3) / 12;
  const gmLong = IL / (p.mass / RHO); // BM_L dominates; KB - KG is small beside it
  const heaveStiffness = RHO * G * Awp;
  const heaveMass = p.mass * (1 + p.addedHeave);
  const pitchInertia = p.pitchInertia * (1 + p.addedPitch);
  const rollInertia = p.rollInertia * (1 + p.addedRoll);
  const tw = (m: number, k: number) => 2 * Math.PI * Math.sqrt(m / k);
  return {
    displacementN: W,
    waterplaneArea: Awp,
    gmLong,
    heaveStiffness,
    heaveMass,
    pitchInertia,
    rollInertia,
    periodHeave: tw(heaveMass, heaveStiffness),
    periodPitch: tw(pitchInertia, W * gmLong),
    periodRoll: tw(rollInertia, W * gmOf(p)),
  };
}

/** Mean height and slopes of the sea under the hull (local axes). */
export interface SeaUnderHull {
  eta: number; // m
  slopeX: number; // rise per metre toward the bow
  slopeZ: number; // rise per metre toward starboard
}

export function waveHeight(comps: WaveComponent[], x: number, z: number, t: number): number {
  let y = 0;
  for (const c of comps) {
    const k = (2 * Math.PI) / c.wavelength;
    const w = Math.sqrt(G * k);
    y += c.amplitude * Math.cos(k * (Math.cos(c.direction) * x + Math.sin(c.direction) * z) - w * t + c.phase);
  }
  return y;
}

const GRID_X = [-0.5, -0.375, -0.25, -0.125, 0, 0.125, 0.25, 0.375, 0.5]; // fractions of waterline length
const GRID_Z = [-0.5, 0, 0.5]; // fractions of waterline beam

export function seaUnderHull(
  p: HullParams,
  comps: WaveComponent[],
  x: number,
  z: number,
  yaw: number,
  t: number,
): SeaUnderHull {
  // yaw rotates the boat about +y: local +x (bow) -> world (cos yaw, 0, -sin yaw)
  const cx = Math.cos(yaw);
  const sx = Math.sin(yaw);
  let n = 0;
  let se = 0;
  let sxe = 0;
  let sze = 0;
  let sxx = 0;
  let szz = 0;
  for (const fx of GRID_X) {
    for (const fz of GRID_Z) {
      const lx = fx * p.waterlineLength;
      const lz = fz * p.waterlineBeam;
      const wx = x + lx * cx + lz * sx;
      const wz = z - lx * sx + lz * cx;
      const e = waveHeight(comps, wx, wz, t);
      n++;
      se += e;
      sxe += lx * e;
      sze += lz * e;
      sxx += lx * lx;
      szz += lz * lz;
    }
  }
  // Symmetric grid: the least-squares plane separates into three sums.
  return { eta: se / n, slopeX: sxe / sxx, slopeZ: sze / szz };
}

export interface Pose {
  x: number;
  z: number;
  yaw: number; // rad about +y
}

export class BoatMotion {
  static readonly DT = 0.005; // s, substep
  readonly p: HullParams;
  readonly d: Derived;
  pose: Pose;
  heave = 0;
  pitch = 0;
  roll = 0;
  heaveRate = 0;
  pitchRate = 0;
  rollRate = 0;
  t = 0;
  private prevEta: number | null = null;

  constructor(p: HullParams, pose: Pose = { x: 0, z: 0, yaw: 0 }) {
    this.p = p;
    this.d = derive(p);
    this.pose = { ...pose };
  }

  /** Advance to time `t` (s) in substeps of DT. */
  advance(comps: WaveComponent[], t: number): void {
    if (t <= this.t) return;
    const steps = Math.min(Math.ceil((t - this.t) / BoatMotion.DT), 2000); // cap a long pause
    const dt = (t - this.t) / steps;
    for (let i = 0; i < steps; i++) this.step(comps, dt);
  }

  step(comps: WaveComponent[], dt: number): void {
    const { p, d } = this;
    const s = seaUnderHull(p, comps, this.pose.x, this.pose.z, this.pose.yaw, this.t + dt);
    const etaRate = this.prevEta === null ? 0 : (s.eta - this.prevEta) / dt;
    this.prevEta = s.eta;
    const W = d.displacementN;
    const crit = (m: number, k: number) => 2 * Math.sqrt(m * k);

    const fz =
      -d.heaveStiffness * (this.heave - s.eta) -
      p.zetaHeave * crit(d.heaveMass, d.heaveStiffness) * (this.heaveRate - etaRate);
    const kp = W * d.gmLong;
    const mp =
      -kp * (this.pitch - Math.atan(s.slopeX)) - p.zetaPitch * crit(d.pitchInertia, kp) * this.pitchRate;
    // Sea rising to starboard tilts the deck to port: roll target -atan(slopeZ).
    const kr = W * gmOf(p);
    const mr =
      -W * gz(p, this.roll + Math.atan(s.slopeZ)) - p.zetaRoll * crit(d.rollInertia, kr) * this.rollRate -
      p.rollQuadDamping * Math.abs(this.rollRate) * this.rollRate;

    this.heaveRate += (fz / d.heaveMass) * dt;
    this.pitchRate += (mp / d.pitchInertia) * dt;
    this.rollRate += (mr / d.rollInertia) * dt;
    this.heave += this.heaveRate * dt;
    this.pitch += this.pitchRate * dt;
    this.roll += this.rollRate * dt;
    // keep roll in -pi..pi so a full roll-over doesn't wind up
    if (this.roll > Math.PI) this.roll -= 2 * Math.PI;
    if (this.roll < -Math.PI) this.roll += 2 * Math.PI;
    this.t += dt;
  }
}
