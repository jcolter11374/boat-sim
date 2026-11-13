/**
 * "Specs and history" for each ready-made (stock) boat, shown in the boat picker (John, 13 Nov:
 * "include specs and history to all the stock boats ... the specs are what they should be based on
 * the manufacturer's spec").
 *
 * The numbers are the builder's or class's published ones, the same as each config's spec_card
 * (configs/stock_*.yaml; tests/about.test.ts checks they agree). Where a maker doesn't publish a
 * number we say whose it is. Our boats are generic models "based on published specs of" the real
 * one: no logos, no brand styling, nothing that says it is the real thing. Plain words for John,
 * who isn't a sailor: "keel depth", not "draft".
 *
 * Text only: everything here is set with textContent.
 */
import type { StockKey } from "./specs";

export interface BoatAbout {
  /** "Based on published specs of the ...". */
  basedOn: string;
  /** [what, value] rows, metric first, the builder's own units after. */
  specs: [string, string][];
  /** Two or three sentences on the real boat. */
  history: string;
  /** How ours differs from the real one, when it matters (who sails it). */
  ours?: string;
  sources: { name: string; url: string }[];
}

export const ABOUT: Record<StockKey, BoatAbout> = {
  stock_pearson31_2: {
    basedOn: "Pearson Yachts' published specs of the Pearson 31-2 (deep keel)",
    specs: [
      ["Length", "9.39 m (30.8 ft)"],
      ["Length at the waterline", "7.74 m (25.4 ft)"],
      ["Width (beam)", "3.29 m (10.8 ft)"],
      ["Keel depth (draft)", "1.71 m (5.6 ft)"],
      ["Weight", "4,536 kg (10,000 lb)"],
      ["Lead in the keel (ballast)", "1,724 kg (3,800 lb)"],
      ["Sail area", "45.9 m² (494 sq ft)"],
      ["Mast top above the water", "14.1 m (46.3 ft)"],
      ["Engine", "18 hp diesel"],
    ],
    history:
      "Designed by Bill Shaw and built by Pearson Yachts from 1987 until its Portsmouth factory closed in 1991. Randolph and Becky sail one: it's the boat that carries their drone out to sea.",
    ours: "Our model is built from Pearson's published numbers, not measured from their boat. One person and an autopilot sail it.",
    sources: [
      { name: "Pearson Yachts spec sheet (pearsonyachts.org)", url: "https://pearsonyachts.org/models/pearson-31-2.html" },
      { name: "Good Old Boat sail data", url: "https://goodoldboat.com/saildata/boat/pearson-312/" },
      { name: "sailboat.guide (engine)", url: "https://sailboat.guide/zjgohs" },
    ],
  },
  stock_cruiser31: {
    basedOn: "published specs of the Beneteau First 31.7",
    specs: [
      ["Length", "9.61 m (31.5 ft)"],
      ["Length at the waterline", "8.80 m (28.9 ft)"],
      ["Width (beam)", "3.23 m (10.6 ft)"],
      ["Keel depth (draft)", "1.90 m (6.2 ft)"],
      ["Weight", "3,750 kg (8,270 lb)"],
      ["Lead in the keel (ballast)", "1,025 kg (2,260 lb)"],
      ["Mainsail", "23.6 m² (254 sq ft)"],
      ["Front sail (genoa)", "28.9 m² (311 sq ft)"],
      ["Mast top above the water", "13.9 m (45.6 ft)"],
      ["Engine", "21 hp diesel"],
    ],
    history:
      "Designed by Groupe Finot (now Finot-Conq) and built by Beneteau in France from 1997 to 2010; more than 1,500 were built. A fast family cruiser that still races in clubs around the world.",
    ours: "Its speed in our game is fitted to a real one's measured racing certificate (ORC 038800017LU). One person and an autopilot sail it.",
    sources: [
      { name: "Beneteau (First 31.7 page)", url: "https://beneteau.com/first-1992-2004/first-317" },
      { name: "boat-specs.com (deep keel)", url: "https://boat-specs.com/sailing/sailboats/beneteau/first-31-7-deep-draft" },
      { name: "Good Old Boat sail data", url: "https://goodoldboat.com/saildata/boat/beneteau-first-317/" },
      { name: "ORC certificate 038800017LU", url: "https://data.orc.org/public/WPub.dll/CC/038800017LU.pdf" },
    ],
  },
  stock_dinghy14: {
    basedOn: "published class specs of the Sunfish",
    specs: [
      ["Length", "4.19 m (13 ft 9 in)"],
      ["Width (beam)", "1.24 m (4 ft 1 in)"],
      ["Hull weight", "54 kg (120 lb)"],
      ["Sail", "7.0 m² (75 sq ft), one sail on two spars (a lateen rig)"],
      ["Depth with the board down (daggerboard)", "0.89 m (2 ft 11 in)"],
      ["Crew", "1 or 2 (none in our game)"],
    ],
    history:
      "Alexander Bryan and Cortlandt Heyniger (Alcort) made it in 1951 in Waterbury, Connecticut, by widening their plywood Sailfish and giving it a footwell. Fibreglass hulls from 1959 made it cheap, and more than 300,000 had been built by 2001. It is in the American Sailboat Hall of Fame.",
    ours: "Ours has nobody aboard: an autopilot steers. A real one stays upright because its sailor leans out on the high side, so with nobody there the first squall knocks it flat, and with nobody to right it, it stays over. That's real, and part of the fun.",
    sources: [
      { name: "International Sunfish Class history", url: "https://sunfishclass.org/history" },
      { name: "Wikipedia: Sunfish", url: "https://en.wikipedia.org/wiki/Sunfish_(sailboat)" },
      { name: "LaserPerformance Sunfish specs (iboats)", url: "https://boats.iboats.com/research/2020-laser-performance-sunfish/2151610.html" },
    ],
  },
  stock_beachcat16: {
    basedOn: "published specs of the Hobie 16",
    specs: [
      ["Length", "5.04 m (16 ft 7 in)"],
      ["Width (beam)", "2.41 m (7 ft 11 in)"],
      ["Weight", "145 kg (320 lb)"],
      ["Mast", "8.07 m (26 ft 6 in)"],
      ["Sail area", "20 m² (218 sq ft): mainsail and jib"],
      ["Depth with the rudders up", "0.25 m (10 in)"],
      ["Crew", "1 to 4 (none in our game)"],
    ],
    history:
      "Designed by Hobie Alter with Phil Edwards in California and launched in 1970. Its curved hulls grip the water without boards underneath, so it can be sailed straight up a beach. More than 135,000 have been built, and it is raced worldwide as an international class.",
    ours: "Ours has nobody aboard. A real one is held down by its crew hanging out on wires (trapezes); with nobody there, its autopilot sails gently, but a squall can still flip it, and a catamaran stays upside down.",
    sources: [
      { name: "Hobie (Hobie 16 page)", url: "https://hobie.com/sail/hobie-16/" },
      { name: "Wikipedia: Hobie 16", url: "https://en.wikipedia.org/wiki/Hobie_16" },
      { name: "Hobie Class Association", url: "https://hobieclass.com/hobie-classes/hobie-16/" },
    ],
  },
  stock_sail_drone7: {
    basedOn: "published specs of the Saildrone Explorer",
    specs: [
      ["Length", "7 m (23 ft)"],
      ["Wing sail height", "5 m (15 ft)"],
      ["Keel depth (draft)", "2 m (6.6 ft)"],
      ["Weight", "about 750 kg (a published estimate, not the maker's)"],
      ["Average speed", "1 to 3 knots (2 to 5.6 km/h)"],
      ["Time at sea", "12 months and more"],
      ["Power", "wind to sail, sun for the electronics"],
    ],
    history:
      "Saildrone was founded in 2012 by engineer Richard Jenkins. In 2019 one of its drones became the first robot boat to sail all the way round Antarctica (196 days), and another sailed the Atlantic both ways. In 2021 one sailed into Hurricane Sam, a category 4 storm, and sent back video from inside it.",
    ours: "Ours is a generic 7 m drone built from those numbers; its rigid wing turns itself to the wind the way Randolph's Rev B does.",
    sources: [
      { name: "Saildrone (Explorer page)", url: "https://www.saildrone.com/platform/explorer" },
      { name: "Wikipedia: Saildrone", url: "https://en.wikipedia.org/wiki/Saildrone_(company)" },
      { name: "Wevolver tech specs (weight)", url: "https://www.wevolver.com/specs/saildrone" },
    ],
  },
  stock_ocean_rower45: {
    basedOn: "published specs of the Rannoch R45",
    specs: [
      ["Length", "8.64 m (28 ft 4 in)"],
      ["Width (beam)", "1.74 m (5 ft 9 in)"],
      ["Crew", "3 to 5 rowers (4 in our game, two rowing at a time)"],
      ["Solar panels", "230 W"],
      ["Batteries", "2 × 100 Ah lithium"],
      ["Weight loaded for the crossing", "about 1,500 kg (our estimate: not published)"],
      ["Cabins", "2, one at each end"],
    ],
    history:
      "Built by Rannoch Adventure and sold as the most popular ocean rowing boat in the world, the R45 is raced across the Atlantic from La Gomera in the Canary Islands to Antigua, about 3,000 miles (now called the World's Toughest Row). A crew of four, the Four Oarsmen, set the fours' record in one in 2017: 29 days, 13 hours and 34 minutes.",
    ours: "Our crew of four row in shifts, two on and two off, day and night. They get tired over the weeks, and in head winds and gales they put out a parachute anchor and wait.",
    sources: [
      { name: "World's Toughest Row: boats and records", url: "https://www.worldstoughestrow.com/boat-details/" },
      { name: "R45 listing (length, beam, crews)", url: "https://theyachtmarket.com/en/boats-for-sale/2776382" },
      { name: "R45 Elite listing (solar, batteries)", url: "https://info.oceanrowing.com/boatsforsale/for-sale-row-west-2025-rannoch-r45-elite-ocean-rowing-boat" },
    ],
  },
};
