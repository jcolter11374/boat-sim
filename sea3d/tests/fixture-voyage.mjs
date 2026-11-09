// A made-up replay in the simulator's schema-1 format, for testing the voyage
// page without simulator output. NOT a simulation: smooth fake track and fake
// weather. Real replays come from boatsim.runner.replay (PR #132).
import { mkdirSync, writeFileSync } from "node:fs";

export function fixtureReplay(days = 40) {
  const n = Math.round(days * 24) + 1;
  const drop = [36.65, -74.94];
  const target = [39.5, -13.5];
  const cols = { h: [], lat: [], lon: [], heading: [], stw: [], soc: [], wind_u: [], wind_v: [], hs: [], tp: [], wave_dir: [], current_u: [], current_v: [], ghi: [] };
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    const lat = drop[0] + (target[0] - drop[0]) * f + 4.5 * Math.sin(Math.PI * f);
    const lon = drop[1] + (target[1] - drop[1]) * f;
    const hour = i % 24;
    cols.h.push(i);
    cols.lat.push(+lat.toFixed(4));
    cols.lon.push(+lon.toFixed(4));
    cols.heading.push(Math.round(80 - 25 * Math.cos(Math.PI * f) + 15 * Math.sin(i / 9)));
    cols.stw.push(+(0.85 + 0.1 * Math.sin(i / 7)).toFixed(2));
    cols.soc.push(+(0.75 + 0.2 * Math.sin(((hour - 8) / 24) * 2 * Math.PI)).toFixed(3));
    cols.wind_u.push(+(6 + 5 * Math.sin(i / 50)).toFixed(1));
    cols.wind_v.push(+(3 * Math.cos(i / 31)).toFixed(1));
    cols.hs.push(+(1.6 + 1.3 * Math.sin(i / 60) + (i > 24 * 30 && i < 24 * 33 ? 2.5 : 0)).toFixed(2));
    cols.tp.push(+(7 + 2 * Math.sin(i / 60)).toFixed(1));
    cols.wave_dir.push(Math.round(250 + 30 * Math.sin(i / 40)));
    cols.current_u.push(i % 50 === 7 ? null : 0.2);
    cols.current_v.push(0.05);
    cols.ghi.push(Math.max(0, Math.round(800 * Math.sin(((hour - 6) / 12) * Math.PI))));
  }
  const H = n - 1;
  return {
    schema: 1,
    boat: "TEST FIXTURE (not a simulation)",
    start: "2020-05-01T12:00",
    end: "2020-06-10T12:00",
    seed: 0,
    outcome: "arrived",
    days,
    t_start_line: "2020-05-07T12:00",
    t_finish_line: "2020-06-10T12:00",
    course: {
      drop,
      west_line: [[48, -47], [45.5, -47], [40, -65], [30, -77], [20, -59], [10, -56]],
      east_line: [[55, -16], [51, -16], [46, -11], [44.5, -13.5], [37, -13.5], [35, -20.5], [25, -22]],
      target,
      target_radius_m: 25000,
    },
    units: {},
    ...cols,
    events: [
      { h: 6 * 24, kind: "start_line", detail: "" },
      { h: 12 * 24, kind: "message_received", detail: "routine" },
      { h: 20 * 24 + 3, kind: "part_failed", detail: "rudder servo (fixture)" },
      { h: 31 * 24, kind: "capsize", detail: "knocked down in a breaking sea (fixture)" },
      { h: H, kind: "finish_line", detail: "" },
      { h: H, kind: "arrived", detail: "" },
    ],
  };
}

export function writeFixture(dir) {
  mkdirSync(dir, { recursive: true });
  const rep = fixtureReplay();
  const name = "voyage_2020-05-01.json";
  writeFileSync(`${dir}/${name}`, JSON.stringify(rep));
  writeFileSync(`${dir}/index.json`, JSON.stringify({ schema: 1, voyages: [{ file: name, boat: rep.boat, start: rep.start, outcome: rep.outcome, days: rep.days }] }));
  return rep;
}

/** A made-up race: our kayak (40 days, finished) and a "Randolph" fixture
 *  (30 days, lost) launched the same day, file names as boatsim.runner.replay
 *  writes them (#140). NOT simulations. */
export function writeRaceFixture(dir) {
  mkdirSync(dir, { recursive: true });
  const ours = fixtureReplay(40);
  const theirs = fixtureReplay(30);
  theirs.boat = "Randolph TEST FIXTURE (not a simulation)";
  theirs.outcome = "lost";
  theirs.lat = theirs.lat.map((v, i) => +(v - 1.5 * Math.sin((Math.PI * i) / theirs.lat.length)).toFixed(4));
  theirs.events = [{ h: 6 * 24, kind: "start_line", detail: "" }, { h: theirs.h.at(-1), kind: "lost", detail: "fixture" }];
  const files = [
    ["voyage_2020-05-01.json", ours],
    ["voyage_randolph-test-fixture_2020-05-01.json", theirs],
  ];
  for (const [f, r] of files) writeFileSync(`${dir}/${f}`, JSON.stringify(r));
  const voyages = files.map(([file, r]) => ({ file, boat: r.boat, start: r.start, outcome: r.outcome, days: r.days }));
  writeFileSync(`${dir}/index.json`, JSON.stringify({ schema: 1, voyages }));
  return { ours, theirs };
}
