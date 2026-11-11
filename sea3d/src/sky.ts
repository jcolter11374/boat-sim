// Where the sun, moon and stars really are, for a UTC time and a place on the
// ocean, so John can tell direction from the sky as a navigator would.
//
// Low-precision almanac formulas: the sun to about half a degree, the moon to
// a degree or two (no parallax), the stars from their J2000 catalogue places
// (precession since 2000 is a third of a degree). Plenty for steering by eye.

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const wrap360 = (a: number) => ((a % 360) + 360) % 360;

/** Days since 2000-01-01 12:00 UTC. */
export const daysJ2000 = (ms: number) => ms / 86400e3 - 10957.5;

/** Local sidereal time, degrees: which right ascension is due south (north of the tropics) right now. */
export function siderealDeg(ms: number, lonDeg: number): number {
  const d = daysJ2000(ms);
  return wrap360(280.46061837 + 360.98564736629 * d + lonDeg);
}

const obliquity = (d: number) => rad(23.439 - 0.00000036 * d);

/** Ecliptic longitude/latitude (radians) -> right ascension and declination (degrees). */
function eclipticToEquatorial(lam: number, beta: number, d: number): { ra: number; dec: number } {
  const e = obliquity(d);
  const ra = Math.atan2(Math.sin(lam) * Math.cos(e) - Math.tan(beta) * Math.sin(e), Math.cos(lam));
  const dec = Math.asin(Math.sin(beta) * Math.cos(e) + Math.cos(beta) * Math.sin(e) * Math.sin(lam));
  return { ra: wrap360(deg(ra)), dec: deg(dec) };
}

/** The sun's right ascension and declination, degrees. */
export function sunEquatorial(ms: number): { ra: number; dec: number } {
  const d = daysJ2000(ms);
  const g = rad(357.529 + 0.98560028 * d);
  const L = rad(280.459 + 0.98564736 * d + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g));
  return eclipticToEquatorial(L, 0, d);
}

/** The moon's right ascension and declination, degrees (main terms only: about 1 to 2 degrees). */
export function moonEquatorial(ms: number): { ra: number; dec: number } {
  const d = daysJ2000(ms);
  const L = 218.316 + 13.176396 * d; // mean longitude
  const M = rad(134.963 + 13.064993 * d); // mean anomaly
  const F = rad(93.272 + 13.22935 * d); // distance from the ascending node
  const D = rad(297.85 + 12.190749 * d); // elongation from the sun
  const Ms = rad(357.529 + 0.98560028 * d); // the sun's mean anomaly
  const lam = rad(L + 6.289 * Math.sin(M) + 1.274 * Math.sin(2 * D - M) + 0.658 * Math.sin(2 * D) - 0.186 * Math.sin(Ms));
  const beta = rad(5.128 * Math.sin(F));
  return eclipticToEquatorial(lam, beta, d);
}

/** Right ascension/declination (degrees) -> elevation and compass bearing (degrees, clockwise from north). */
export function toHorizon(raDeg: number, decDeg: number, ms: number, latDeg: number, lonDeg: number): { el: number; az: number } {
  const ha = rad(siderealDeg(ms, lonDeg) - raDeg);
  const dec = rad(decDeg);
  const phi = rad(latDeg);
  const el = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(ha));
  return { el: deg(el), az: wrap360(deg(az)) };
}

/** How much of the moon's face is lit, 0 (new) .. 1 (full), and whether it's waxing. */
export function moonPhase(ms: number): { lit: number; waxing: boolean; name: string } {
  const s = sunEquatorial(ms);
  const m = moonEquatorial(ms);
  const v = (ra: number, dec: number) => [Math.cos(rad(dec)) * Math.cos(rad(ra)), Math.cos(rad(dec)) * Math.sin(rad(ra)), Math.sin(rad(dec))];
  const a = v(s.ra, s.dec);
  const b = v(m.ra, m.dec);
  const cosE = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const lit = (1 - cosE) / 2;
  const waxing = wrap360(m.ra - s.ra) < 180;
  const name =
    lit < 0.03 ? "new moon" : lit > 0.97 ? "full moon" : lit < 0.4 ? (waxing ? "waxing crescent" : "waning crescent")
      : lit < 0.6 ? (waxing ? "first quarter" : "last quarter") : waxing ? "waxing gibbous" : "waning gibbous";
  return { lit, waxing, name };
}

export interface Star {
  name: string;
  ra: number; // hours
  dec: number; // degrees
  mag: number;
}

/** The brightest stars and the patterns people steer by (J2000). The North Star
 *  sits within a degree of true north at an elevation equal to the latitude;
 *  the two end stars of the Big Dipper's bowl point at it. */
export const BRIGHT_STARS: Star[] = [
  { name: "North Star (Polaris)", ra: 2.530, dec: 89.264, mag: 2.0 },
  { name: "Kochab", ra: 14.845, dec: 74.155, mag: 2.1 },
  { name: "Sirius", ra: 6.752, dec: -16.716, mag: -1.46 },
  { name: "Canopus", ra: 6.399, dec: -52.696, mag: -0.74 },
  { name: "Arcturus", ra: 14.261, dec: 19.182, mag: -0.05 },
  { name: "Vega", ra: 18.616, dec: 38.784, mag: 0.03 },
  { name: "Capella", ra: 5.278, dec: 45.998, mag: 0.08 },
  { name: "Rigel", ra: 5.242, dec: -8.202, mag: 0.13 },
  { name: "Procyon", ra: 7.655, dec: 5.225, mag: 0.34 },
  { name: "Betelgeuse", ra: 5.919, dec: 7.407, mag: 0.5 },
  { name: "Altair", ra: 19.846, dec: 8.868, mag: 0.77 },
  { name: "Aldebaran", ra: 4.599, dec: 16.509, mag: 0.85 },
  { name: "Spica", ra: 13.420, dec: -11.161, mag: 0.97 },
  { name: "Antares", ra: 16.490, dec: -26.432, mag: 1.0 },
  { name: "Pollux", ra: 7.755, dec: 28.026, mag: 1.14 },
  { name: "Fomalhaut", ra: 22.961, dec: -29.622, mag: 1.16 },
  { name: "Deneb", ra: 20.690, dec: 45.280, mag: 1.25 },
  { name: "Regulus", ra: 10.139, dec: 11.967, mag: 1.35 },
  { name: "Castor", ra: 7.577, dec: 31.888, mag: 1.58 },
  // Big Dipper (Dubhe and Merak point to the North Star)
  { name: "Dubhe", ra: 11.062, dec: 61.751, mag: 1.8 },
  { name: "Merak", ra: 11.031, dec: 56.382, mag: 2.37 },
  { name: "Phecda", ra: 11.897, dec: 53.695, mag: 2.44 },
  { name: "Megrez", ra: 12.257, dec: 57.033, mag: 3.3 },
  { name: "Alioth", ra: 12.900, dec: 55.960, mag: 1.77 },
  { name: "Mizar", ra: 13.399, dec: 54.925, mag: 2.27 },
  { name: "Alkaid", ra: 13.792, dec: 49.313, mag: 1.86 },
  // Orion
  { name: "Alnitak", ra: 5.679, dec: -1.943, mag: 1.77 },
  { name: "Alnilam", ra: 5.604, dec: -1.202, mag: 1.69 },
  { name: "Mintaka", ra: 5.533, dec: -0.299, mag: 2.23 },
  { name: "Bellatrix", ra: 5.419, dec: 6.35, mag: 1.64 },
  { name: "Saiph", ra: 5.796, dec: -9.67, mag: 2.06 },
  // Cassiopeia (the W, across the North Star from the Big Dipper)
  { name: "Schedar", ra: 0.675, dec: 56.537, mag: 2.24 },
  { name: "Caph", ra: 0.153, dec: 59.15, mag: 2.28 },
  { name: "Gamma Cassiopeiae", ra: 0.945, dec: 60.717, mag: 2.15 },
  { name: "Ruchbah", ra: 1.43, dec: 60.235, mag: 2.68 },
  { name: "Segin", ra: 1.907, dec: 63.67, mag: 3.37 },
];

/** Unit vector in the sky's own frame: x towards RA 0h on the equator, y towards RA 6h, z to the north celestial pole. */
export function equatorialVector(raDeg: number, decDeg: number): [number, number, number] {
  const r = rad(raDeg);
  const d = rad(decDeg);
  return [Math.cos(d) * Math.cos(r), Math.cos(d) * Math.sin(r), Math.sin(d)];
}

/** One catalogue star: J2000 place (degrees), visual magnitude, colour temperature (K, 0 unknown). */
export interface CatalogueStar {
  ra: number;
  dec: number;
  mag: number;
  k: number;
}

/** Read public/stars.bin (scripts/stars.py: the Yale Bright Star Catalogue), brightest first. */
export function decodeStars(buf: ArrayBuffer): CatalogueStar[] {
  const v = new DataView(buf);
  const n = v.getUint32(0, true);
  if (buf.byteLength !== 4 + n * 8) throw new Error("stars.bin: wrong length");
  const out: CatalogueStar[] = [];
  for (let i = 0; i < n; i++) {
    const o = 4 + i * 8;
    out.push({
      ra: (v.getUint16(o, true) / 65536) * 360,
      dec: (v.getInt16(o + 2, true) / 32767) * 90,
      mag: v.getInt16(o + 4, true) / 100,
      k: v.getUint16(o + 6, true),
    });
  }
  return out;
}

/**
 * A star's colour as the eye sees it, from its temperature: red-orange for cool
 * stars (3,000 K, Betelgeuse), white for the sun's kind (6,000 K), blue-white for
 * hot ones (10,000 K and up, Rigel). An approximation of the black-body colour,
 * pale because the eye sees star colours only faintly. Unknown: white.
 */
export function starColour(k: number): [number, number, number] {
  if (!(k > 0)) return [1, 1, 1];
  const t = k / 100;
  const r = t <= 66 ? 1 : Math.min(1, 1.2929 * (t - 60) ** -0.1332);
  const g = t <= 66 ? Math.min(1, Math.max(0, 0.39 * Math.log(t) - 0.6318)) : Math.min(1, 1.1299 * (t - 60) ** -0.0755);
  const b = t >= 66 ? 1 : t <= 19 ? 0 : Math.min(1, Math.max(0, 0.5432 * Math.log(t - 10) - 1.1963));
  // Wash towards white: the eye barely sees star colours.
  const pale = 0.55;
  return [pale + (1 - pale) * r, pale + (1 - pale) * g, pale + (1 - pale) * b];
}

/**
 * The faintest star you can see now (magnitude): about 6.5 on a dark, moonless night
 * at sea, two magnitudes less under a full moon, and the stars fade out in twilight.
 */
export function nakedEyeLimit(sunElDeg: number, moonlight: number): number {
  const dusk = Math.min(Math.max((sunElDeg + 18) / 12, 0), 1); // astronomical to civil twilight
  return 6.5 - 2.2 * moonlight - 5.5 * dusk;
}
