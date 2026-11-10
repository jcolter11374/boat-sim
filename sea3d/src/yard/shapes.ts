// The Boatyard's hull shapes: the sizes agreed with Theo (10 Nov 2026), so the
// 3D models (blender/build_shapes.py) and his physics (boatsim.sandbox.catalog
// SHAPES) describe the same boat. Metres and kilograms; draft is how deep it floats.

export interface ShapeSpec {
  name: string;
  length: number;
  beam: number;
  massKg: number;
  draft: number;
  /** Centre of gravity, metres aft of the bow (the model turns about it). */
  cgX: number;
}

export const HULL_SHAPES: Record<string, ShapeSpec> = {
  cat: { name: "Small catamaran", length: 3.0, beam: 1.6, massKg: 140, draft: 0.16, cgX: 1.5 },
  semisub: { name: "Low semi-submerged hull", length: 3.2, beam: 0.5, massKg: 175, draft: 0.18, cgX: 1.6 },
  board: { name: "Surfboard", length: 3.0, beam: 0.85, massKg: 105, draft: 0.06, cgX: 1.45 },
};
