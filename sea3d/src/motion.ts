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
//   * Roll:   (Ixx + a44) ph'' = Disp g (GZ(heel) - GZ(ph - slope_z)) - c44 ph'
//     where heel is the steady lean the sails hold (0 for a motor boat), so
//     the sail's heeling moment is the righting moment at that angle.
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

// --- Randolph team Rev C (drone-boat designs/revC_geometry.json, MIT) ----------
// The Randolph team's Rev C3 (11 Nov 2026): foam-filled hull behind two
// bulkheads, sealed battery box, twin rudders with servo-savers, hardwood-cored
// keel fin (C2), D72 bulb, YB3 in a foredeck well, fibreglass stern post and
// counterweight arm, 30 x 22 mm spar (C3); 26.9 kg all up, waterline 0.102 m
// above the bottom. The GZ curve is theirs (docs/data/revC_gz_curve.csv, C3,
// free trim). Point masses are their mass_items list (revC_geometry.json); they
// sum to 26.93 kg. Inertias and the centre of gravity are their values from the
// same file, about the CG with x aft, y port, z up: Ixx 3.10, Iyy 5.26,
// Izz 2.21, Ixz -0.45 kg m^2; CG 0.824 m aft of the bow and 0.028 m below the
// hull-bottom datum. Our roll-pitch model uses Ixx and Iyy; Izz and Ixz (yaw,
// and the roll-yaw coupling) wait for a yaw model.
export const REVC_MASS_ITEMS: MassItem[] = [
  [2.316, 0.149, "hull + deck shell"],
  [1.723, -0.196, "keel fin"],
  [8.983, -0.424, "lead bulb"],
  [0.992, -0.043, "rudders"],
  [0.561, 0.8, "wing"],
  [0.8, 0.75, "wing spar"],
  [0.37, 0.35, "tail + servo housing"],
  [0.066, 0.276, "tail boom"],
  [0.018, 0.286, "counterweight arm tube"],
  [0.11, 0.286, "counterweight pod shell"],
  [0.798, 0.286, "rig counterweight (lead)"],
  [2, 0.1, "battery"],
  [1.1, 0.163, "electronics box"],
  [0.08, 0.115, "electronics shelf"],
  [1, 0.235, "solar panels"],
  [0.52, 0.13, "mast tube and housing"],
  [0.53, 0.14, "rudder servos and trunks"],
  [1.65, 0.13, "foam fill xps"],
  [0.2, 0.12, "bulkheads"],
  [0.35, 0.1, "battery box"],
  [0.45, 0.225, "yb3 tracker and platform"],
  [0.06, 0.6, "nav light"],
  [0.9, 0.42, "stern stub vane antenna reflector"],
  [0.75, 0.02, "keel box and backing"],
  [0.6, 0.12, "misc fittings"],
];
const REVC_X = [0.809, 0.73, 0.723, 1.428, 0.66, 0.6, 1.2, 0.9, 0.45, 0.3, 0.3, 0.87, 1.1, 1.1, 1.06, 0.6, 1.36, 0.8, 0.78, 0.87, 0.18, 1.53, 1.53, 0.745, 0.8];
const REVC_WATERLINE = 0.102;
const REVC_SPREAD = [0.45, 0.43, 0.072, 0.23, 1, 1.195, 0, 0, 0, 0, 0, 0, 0, 0, 0.4, 0, 0, 0.23, 0.2, 0, 0, 0, 0, 0, 0]; // GUESS: item lengths for their own inertia
const revcMass = massProperties(REVC_MASS_ITEMS, REVC_SPREAD);
// GM: the Rev C5 curve's first step, 0.0164 m / sin 5 deg = 0.188 (their revC_geometry.json stability.gm_m 0.188).
export const REVC_GM = 0.188;
const revcGz: [number, number][] = [
  [0, 0.0], [5, 0.0164], [10, 0.0327], [15, 0.0488], [20, 0.0647], [25, 0.0803], [30, 0.0954], [35, 0.11],
  [40, 0.1239], [45, 0.1358], [50, 0.1453], [55, 0.1527], [60, 0.158], [65, 0.1609], [70, 0.1624], [75, 0.1626],
  [80, 0.1629], [85, 0.1771], [90, 0.1781], [95, 0.2681], [100, 0.3554], [105, 0.3717], [110, 0.3687], [115, 0.3569],
  [120, 0.3397], [125, 0.3182], [130, 0.2933], [135, 0.2655], [140, 0.2357], [145, 0.2046], [150, 0.1723],
  [155, 0.1396], [160, 0.1072], [165, 0.0762], [170, 0.0477], [175, 0.023], [180, 0.0],
];
// Their values (designs/revC_geometry.json, C3).
export const REVC_IXX = 3.1;
export const REVC_IYY = 5.256;
export const REVC_IZZ = 2.206; // not used yet (no yaw model)
export const REVC_IXZ = -0.449; // not used yet (no yaw model)
const REVC_CG_X = 0.824; // m aft of the bow
const REVC_CG_BELOW_BOTTOM = 0.028; // m below the hull-bottom datum
/** Our point-mass estimate of the CG and roll inertia, kept to check theirs. */
export const REVC_POINT_MASS = {
  ...revcMass,
  cgX: REVC_X.reduce((s, x, i) => s + x * REVC_MASS_ITEMS[i][0], 0) / revcMass.mass,
};

export const RANDOLPH_REVC: HullParams = {
  name: "Randolph Rev C",
  mass: 26.9,
  waterlineLength: 1.43, // their simulator (length change under 1 cm at the C3 waterline)
  waterlineBeam: 0.34, // their randolph_rev_c.yaml
  waterplaneCoeff: 0.68, // GUESS: as Rev B
  gzTable: revcGz,
  rollInertia: REVC_IXX, // their Ixx about the CG
  pitchInertia: REVC_IYY, // their Iyy about the CG
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
    "drone-boat designs/boat-sim/randolph_rev_c.yaml (mass), docs/data/revC_gz_curve.csv (GZ), designs/revC_geometry.json (masses, inertias and CG)",
};

// --- Stock vessels (Theo, configs/stock_*.yaml) ---------------------------------
// The GZ curves are the configs' own (vpp.gz, as the simulator uses them), so the
// boat leans and rights itself in the picture the way it does in the simulator.
// Inertias and damping are GUESSES sized to typical roll periods.
const deg = (d: number[], m: number[]): [number, number][] => d.map((a, i) => [a, m[i]]);

// 31 ft cruiser: GM 1.15 m (ORC righting moment). Roll period about 3.5 s, a typical
// figure for a 30 ft fin-keel yacht with its mast (radius of gyration ~1.75 m).
export const CRUISER31: HullParams = {
  name: "31 ft cruiser",
  mass: 3887,
  waterlineLength: 8.8,
  waterlineBeam: 2.9, // GUESS: 3.21 m beam, a little less at the waterline
  waterplaneCoeff: 0.7, // GUESS
  gzTable: deg(
    [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 180],
    [0, 0.19, 0.36, 0.5, 0.6, 0.65, 0.66, 0.62, 0.54, 0.43, 0.3, 0.16, 0.02, -0.12, 0],
  ),
  rollInertia: 11800, // GUESS: 3887 kg x (1.75 m)^2
  pitchInertia: 3887 * (0.25 * 9.45) ** 2, // GUESS
  cgBelowWaterline: 0.15, // GUESS: a 1025 kg keel bulb 1.75 m down against the hull and rig
  cgX: 4.5, // GUESS: over the keel
  addedHeave: 0.8, // GUESS
  addedPitch: 0.5, // GUESS
  addedRoll: 0.15, // GUESS
  zetaHeave: 0.2, // GUESS
  zetaPitch: 0.2, // GUESS
  zetaRoll: 0.1, // GUESS: fin keel yachts ~0.1
  // keel 0.9 m chord from 0.4 to 1.75 m below the CG, bulb 1.6 x 0.34 m at 1.6 m
  rollQuadDamping: 0.5 * RHO * 1.2 * (finR3(0.9, 0.4, 1.75) + 0.54 * 1.6 ** 3),
  source: "configs/stock_cruiser31.yaml (GZ, mass); inertia and damping GUESS",
};

// 14 ft dinghy, nobody aboard: form stability only, and it turtles past ~75 deg.
export const DINGHY14: HullParams = {
  name: "14 ft dinghy",
  mass: 75,
  waterlineLength: 3.9,
  waterlineBeam: 1.1, // GUESS
  waterplaneCoeff: 0.72, // GUESS: a flat, full board boat
  gzTable: deg(
    [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 120, 150, 180],
    [0, 0.18, 0.27, 0.27, 0.22, 0.16, 0.1, 0.04, -0.02, -0.06, -0.1, -0.06, 0],
  ),
  rollInertia: 25, // GUESS: hull 75 kg x (0.45 m)^2 plus the spars
  pitchInertia: 75 * (0.25 * 4.2) ** 2, // GUESS
  cgBelowWaterline: -0.12, // GUESS: no crew or ballast, so it sits above the water
  cgX: 2.0, // GUESS
  addedHeave: 1.0, // GUESS
  addedPitch: 0.5, // GUESS
  addedRoll: 0.3, // GUESS: the daggerboard and the flat bottom push water
  zetaHeave: 0.25, // GUESS
  zetaPitch: 0.25, // GUESS
  zetaRoll: 0.12, // GUESS
  rollQuadDamping: 0.5 * RHO * 1.2 * finR3(0.3, 0.2, 0.95), // daggerboard
  source: "configs/stock_dinghy14.yaml (GZ, mass); inertia and damping GUESS",
};

// 16 ft beach cat: very stiff (GM ~13 m) until a hull lifts, then over at ~30 deg.
export const BEACHCAT16: HullParams = {
  name: "16 ft beach cat",
  mass: 170,
  waterlineLength: 4.9,
  waterlineBeam: 0.6, // two slim hulls, 0.3 m each at the waterline
  waterplaneCoeff: 0.7, // GUESS
  gzTable: deg(
    [0, 2, 4, 6, 10, 20, 30, 40, 50, 60, 70, 90, 120, 150, 180],
    [0, 0.45, 0.85, 0.98, 0.97, 0.84, 0.67, 0.49, 0.3, 0.08, -0.13, -0.5, -0.6, -0.4, 0],
  ),
  rollInertia: 400, // GUESS: hulls 1.05 m out, a tall mast
  pitchInertia: 170 * (0.28 * 4.9) ** 2, // GUESS
  cgBelowWaterline: -0.5, // GUESS: trampoline and rig well above the water
  cgX: 2.5, // GUESS
  addedHeave: 0.6, // GUESS
  addedPitch: 0.4, // GUESS
  addedRoll: 0.3, // GUESS
  zetaHeave: 0.25, // GUESS
  zetaPitch: 0.25, // GUESS
  zetaRoll: 0.25, // GUESS: a hull pressed down and the other lifted is heavily damped
  rollQuadDamping: 0.5 * RHO * 1.2 * 2 * 4.9 * 0.3 * 1.05 ** 3, // GUESS: hulls moving up and down
  source: "configs/stock_beachcat16.yaml (GZ, mass); inertia and damping GUESS",
};

// 7 m wind-powered ocean drone: narrow and deep-ballasted, so it rights itself from
// any angle (the config: no stable upside-down position). GZ 0.35 m at 25 deg from its
// max heel moment (2600 N m over 750 kg); the rest of the curve is a GUESS of that shape.
export const SAIL_DRONE7: HullParams = {
  name: "wind-powered ocean drone",
  mass: 750,
  waterlineLength: 6.4,
  waterlineBeam: 0.75, // GUESS: 0.9 m beam, a little less at the waterline
  waterplaneCoeff: 0.65, // GUESS
  gzTable: deg(
    [0, 10, 20, 30, 40, 60, 90, 120, 150, 180],
    [0, 0.15, 0.29, 0.4, 0.47, 0.53, 0.47, 0.32, 0.14, 0],
  ),
  rollInertia: 750 * 0.75 ** 2, // GUESS: the bulb 1.6 m down and the wing 3 m up about the CG
  pitchInertia: 750 * (0.25 * 7) ** 2, // GUESS
  cgBelowWaterline: 0.25, // GUESS: a 250 kg bulb 1.6 m down against the hull and the wing
  cgX: 3.2, // GUESS: between the keel and the wing
  addedHeave: 0.8, // GUESS
  addedPitch: 0.5, // GUESS
  addedRoll: 0.15, // GUESS
  zetaHeave: 0.2, // GUESS
  zetaPitch: 0.2, // GUESS
  zetaRoll: 0.1, // GUESS: like a fin-keel yacht
  // keel 0.85 m chord from 0.3 to 1.5 m below the CG, bulb 1.5 x 0.3 m at 1.45 m
  rollQuadDamping: 0.5 * RHO * 1.2 * (finR3(0.85, 0.3, 1.5) + 0.45 * 1.45 ** 3),
  source: "configs/stock_sail_drone7.yaml (mass, max heel moment); curve, inertia and damping GUESS",
};

// 8.64 m ocean rowing boat for four (configs/stock_ocean_rower45.yaml; Theo's stats card).
// Sealed cabins at both ends make it self-righting: GZ stays positive all the way round,
// balanced upside down only at exactly 180 deg. Curve, inertia and damping GUESS.
export const OCEAN_ROWER45: HullParams = {
  name: "ocean rowing boat",
  mass: 1500, // loaded: boat about 700, crew 340, food, water and kit
  waterlineLength: 7.6,
  waterlineBeam: 1.45, // GUESS
  waterplaneCoeff: 0.72, // the config's 8.0 m2 waterplane over 7.6 x 1.45
  gzTable: deg([0, 10, 20, 30, 45, 60, 90, 120, 150, 180], [0, 0.07, 0.13, 0.17, 0.18, 0.15, 0.08, 0.03, 0.01, 0]),
  rollInertia: 1500 * 0.6 ** 2, // GUESS
  pitchInertia: 1500 * (0.25 * 8.64) ** 2, // GUESS
  cgBelowWaterline: 0.05, // GUESS: water and food stowed low, the cabins high
  cgX: 4.3, // GUESS: a little aft of mid-length (the bigger stern cabin, the batteries)
  addedHeave: 0.9, // GUESS
  addedPitch: 0.6, // GUESS
  addedRoll: 0.2, // GUESS
  zetaHeave: 0.2, // GUESS
  zetaPitch: 0.2, // GUESS
  zetaRoll: 0.08, // GUESS: a round, shallow hull with a small daggerboard
  // daggerboard 0.3 m chord from 0.35 to 0.9 m below the CG, and the long flat bilge
  rollQuadDamping: 0.5 * RHO * 1.2 * (finR3(0.3, 0.35, 0.9) + 7.6 * 0.15 * 0.7 ** 3),
  source: "configs/stock_ocean_rower45.yaml (mass, waterplane); Theo's stats card (GZ curve); inertia and damping GUESS",
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
  /** Steady heel (rad, + = to starboard) the wind holds the boat at in flat water:
   * a sailing boat leans on its sails, and the waves rock it about that angle. */
  heel = 0;
  /** Turned over for good (+1 rolled to starboard, -1 to port, 0 upright): it goes on
   * over and floats upside down, rocking about 180 deg (a boat with nobody to right it). */
  capsized = 0;
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
    const restore = this.capsized
      ? // GUESS: as stiff upside down as its best righting arm (at least 0.3 m).
        -W * Math.max(0.3, ...p.gzTable.map(([, g]) => g)) * Math.sin(this.roll - this.capsized * Math.PI + Math.atan(s.slopeZ))
      : W * (gz(p, this.heel) - gz(p, this.roll + Math.atan(s.slopeZ)));
    const mr =
      restore - p.zetaRoll * crit(d.rollInertia, kr) * this.rollRate -
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
