import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { TITLE_LOOP_S, titleHeading, titleShot } from "../src/framing";
import { FINAL, OPENING, SEQUENCES, SHOTS, camHeight, finalShot, openingShot, chooseSequence, compose, fitting, mixLook, shotsFor, sweepFor, type Moment, type ShotKind } from "../src/cinema";

const calm: Moment = { storm: 0, knockdownAgo: Infinity, land: null, ship: null };

/** Film a shot and say where things land on the screen. */
function film(kind: ShotKind, len: number, yawDeg: number, side: number, u: number) {
  const def = SHOTS[kind];
  const yaw = (yawDeg * Math.PI) / 180;
  const bow = new THREE.Vector2(Math.cos(yaw), -Math.sin(yaw));
  const look = mixLook(def.from, def.to, u);
  const target = new THREE.Vector3(0, 0, 0);
  const c = compose(target, bow, bow, side, len, 16 / 9, look);
  const cam = new THREE.PerspectiveCamera(c.fov, 16 / 9, 0.1, 1e6);
  cam.position.copy(c.pos);
  cam.quaternion.copy(c.quat);
  cam.updateMatrixWorld();
  const [along, up] = look.aim ?? [0, 0];
  const aim = new THREE.Vector3(bow.x * along * len, up, bow.y * along * len);
  const ndc = (p: THREE.Vector3) => p.clone().project(cam);
  const boat = ndc(aim);
  const bowP = ndc(new THREE.Vector3(bow.x * len * 0.5, 0, bow.y * len * 0.5));
  const sternP = ndc(new THREE.Vector3(-bow.x * len * 0.5, 0, -bow.y * len * 0.5));
  // The horizon: a far point straight ahead at the camera's height.
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(c.quat);
  fwd.y = 0;
  fwd.normalize();
  const horizon = ndc(c.pos.clone().add(fwd.multiplyScalar(1e5)));
  return { look, c, boat, bowP, sternP, horizon, height: c.pos.y };
}

test("every shot is composed as planned, for the kayak and the Pearson, on either side (Elena's hard rejects)", () => {
  for (const kind of Object.keys(SHOTS) as ShotKind[]) {
    for (const len of [3.05, 9.39]) {
      for (const side of [-1, 1]) {
        for (const u of [0, 0.5, 1]) {
          const f = film(kind, len, 37, side, u);
          const tag = `${kind} L${len} side${side} u${u}`;
          assert.ok(Math.abs(f.horizon.y - f.look.H) < 0.03, `${tag}: horizon at ${f.horizon.y.toFixed(3)}, want ${f.look.H}`);
          assert.ok(Math.abs(f.look.H) >= 0.25, `${tag}: horizon through the middle`);
          if (f.look.h != null) {
            assert.ok(Math.abs(f.height - camHeight(f.look.h, len)) < 0.05, `${tag}: camera ${f.height.toFixed(2)} m up, want ${camHeight(f.look.h, len)}`);
            assert.ok(f.boat.y < f.horizon.y, `${tag}: boat above the horizon`);
            assert.ok(f.boat.y > -0.85 && f.boat.y < 0.85, `${tag}: boat off the frame (${f.boat.y})`);
          } else assert.ok(Math.abs(f.boat.y - f.look.B) < 0.06, `${tag}: boat at ${f.boat.y.toFixed(3)}, want ${f.look.B}`);
          assert.ok(Math.abs(f.boat.x) <= 0.45, `${tag}: boat off screen sideways (${f.boat.x})`);
          // Neither end of the boat cropped by the frame's edge.
          for (const e of [f.bowP, f.sternP]) if (!["panels", "sterndetail", "bowdetail"].includes(kind)) assert.ok(Math.abs(e.x) < 0.98 && Math.abs(e.y) < 0.98, `${tag}: boat cropped`);
          assert.ok(f.boat.z < 1, `${tag}: boat behind the camera`);
          assert.ok(f.height > 0, `${tag}: camera under the water`);
          assert.ok(f.c.pos.distanceTo(new THREE.Vector3()) > 0.5 * len, `${tag}: camera in the hull`);
          assert.ok(f.look.fov <= 50, `${tag}: wider than 50 degrees`);
        }
      }
    }
  }
});

test("long lenses and a low camera for the chase-boat shots (Elena)", () => {
  for (const k of ["establish", "alongside", "sunset"] as ShotKind[]) {
    assert.ok(SHOTS[k].from.fov >= 15 && SHOTS[k].from.fov <= 28, k);
    // From a chase boat 40 to 300 m off for the wide ones, kayak to Pearson.
    if (k === "establish") for (const len of [3.05, 9.39]) {
      const d = film(k, len, 0, 1, 0).c.pos.length();
      assert.ok(d > 40 && d < 300, `${k} L${len}: ${d.toFixed(0)} m off`);
    }
  }
  const low = (Object.keys(SHOTS) as ShotKind[]).filter((k) => SHOTS[k].from.h != null);
  assert.ok(low.length >= 9, "most shots are low");
  for (const k of low) assert.ok(SHOTS[k].from.h! >= 0.8 && SHOTS[k].from.h! <= 4, k);
});

test("the boat is sized on purpose: the establishing shot isn't a dot, the drone ends small", () => {
  for (const len of [3.05, 9.39]) {
    const e = film("establish", len, 0, 1, 0);
    const span = Math.hypot((e.bowP.x - e.sternP.x) * (16 / 9), e.bowP.y - e.sternP.y) / 2;
    assert.ok(span > 0.03 && span < 0.4, `establish L${len}: boat spans ${span.toFixed(3)} of the frame height`);
    const d0 = film("drone", len, 0, 1, 0).c.pos.length();
    const d1 = film("drone", len, 0, 1, 1).c.pos.length();
    assert.ok(d1 > 2 * d0, `the drone pulls back (${d0.toFixed(1)} to ${d1.toFixed(1)} m)`);
  }
  // The same share of the frame for a bigger boat: the camera stands back in proportion.
  const k = film("alongside", 3.05, 0, 1, 0).c.pos.length();
  const p = film("alongside", 9.39, 0, 1, 0).c.pos.length();
  assert.ok(Math.abs(p / k - 9.39 / 3.05) < 0.05);
});

test("room ahead of the bow: the boat sits on the third behind where it's heading", () => {
  for (const side of [-1, 1]) {
    const f = film("alongside", 3.05, 0, side, 0);
    const bowToRight = f.bowP.x > f.sternP.x;
    assert.equal(bowToRight, f.boat.x < 0, `side ${side}: bow ${bowToRight ? "right" : "left"}, boat at ${f.boat.x}`);
    assert.ok(Math.abs(f.boat.x) > 0.2, "on a third, not the centre");
  }
});

test("sequences follow the plan's order, vary, and never repeat a shot twice running", () => {
  let last: ShotKind | null = null;
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const s = shotsFor("passage", last);
    assert.equal(s.length, SEQUENCES.passage.length);
    assert.ok(s.includes("establish") && s.includes("drone"));
    assert.notEqual(s[0], last);
    for (let j = 1; j < s.length; j++) assert.notEqual(s[j], s[j - 1]);
    seen.add(s.join(","));
    last = s[s.length - 1];
  }
  assert.ok(seen.size > 5, "passage varies");
});

test("the sequence fits the moment: five for launch", () => {
  assert.deepEqual(Object.keys(SEQUENCES).sort(), ["golden", "knockdown", "night", "passage", "storm"]);
  assert.deepEqual(fitting(calm, 40), ["passage"]);
  assert.deepEqual(fitting({ ...calm, storm: 0.8 }, 40), ["storm", "passage"]);
  assert.ok(fitting(calm, 4).includes("golden"));
  assert.deepEqual(fitting(calm, -30), ["night"]);
  // Night is short and close, carried by the boat's own light.
  assert.deepEqual(shotsFor("night", null, () => 0), ["light", "alongside", "sternlight"]);
  // The helm's clock stops while filming: a knockdown in the last hours still gets its sequence.
  assert.equal(fitting({ ...calm, recentKnockdown: true }, 40)[0], "knockdown");
  // Not the same sequence over and over: the best one not played in the last two.
  assert.equal(chooseSequence(["golden", "passage"], ["golden"]), "passage");
  assert.equal(chooseSequence(["golden", "passage"], ["golden", "passage"]), "passage");
  assert.equal(chooseSequence(["passage"], ["passage", "passage"]), "passage");
  assert.equal(chooseSequence(["storm"], ["knockdown"], true), "knockdown");
});

test("moves slow down for a slow boat", () => {
  assert.equal(sweepFor(6), 1);
  assert.ok(sweepFor(1.5) < 0.4);
  const fast = mixLook(SHOTS.skim.from, SHOTS.skim.to, 1, sweepFor(6)).az - SHOTS.skim.from.az;
  const slow = mixLook(SHOTS.skim.from, SHOTS.skim.to, 1, sweepFor(1.5)).az - SHOTS.skim.from.az;
  assert.ok(slow < fast / 2.5);
});

test("the boat is big enough on screen: measured in the frame's width, as the pictures show it (Elena, Ines)", () => {
  // Least share of the frame's width the boat's length spans, by shot (the drone's release may end small).
  // End-on shots (bow-on, stern, into the sun) are narrower across the screen but closer.
  const least: Partial<Record<ShotKind, number>> = { establish: 0.1, alongside: 0.3, bowon: 0.15, stern: 0.18, skim: 0.25, stormlow: 0.25, heel: 0.3, sunset: 0.18, light: 0.3 };
  for (const [kind, want] of Object.entries(least) as [ShotKind, number][]) {
    for (const len of [3.05, 9.39]) {
      for (const u of [0, 1]) {
        const f = film(kind, len, 37, 1, u);
        const span = Math.abs(f.bowP.x - f.sternP.x) / 2;
        assert.ok(span >= want, `${kind} L${len} u${u}: boat spans ${(100 * span).toFixed(1)}% of the width, want ${100 * want}%`);
      }
    }
  }
});

test("never a dot: every shot keeps the boat at 6% of the frame's width or more, start to end", () => {
  for (const kind of Object.keys(SHOTS) as ShotKind[]) {
    for (const len of [3.05, 9.39]) {
      for (const u of [0, 0.5, 1]) {
        const f = film(kind, len, 37, 1, u);
        const span = Math.abs(f.bowP.x - f.sternP.x) / 2;
        assert.ok(span >= 0.06, `${kind} L${len} u${u}: boat spans ${(100 * span).toFixed(1)}% of the width`);
      }
    }
  }
});

test("the camera stays low: only the drone's release looks down from high", () => {
  for (const kind of Object.keys(SHOTS) as ShotKind[]) {
    if (kind === "drone") continue;
    for (const len of [3.05, 9.39]) {
      const f = film(kind, len, 37, 1, 0.5);
      const down = Math.atan2(f.height - (f.look.aim?.[1] ?? 0), Math.hypot(f.c.pos.x, f.c.pos.z)) / D2R;
      assert.ok(down < 25, `${kind} L${len}: looking down ${down.toFixed(0)} degrees`);
    }
  }
});
const D2R = Math.PI / 180;

test("the opening shot under the goal card: boat lower left heading right, card's corner clear", () => {
  for (const len of [3.05, 9.39]) {
    for (const yawDeg of [0, 37, 140, 250]) {
      const yaw = (yawDeg * Math.PI) / 180;
      const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 1e6);
      const host = { camera, controls: { target: new THREE.Vector3() } as never, yaw: () => yaw, length: () => len, water: () => 0 };
      const o = openingShot(host);
      assert.equal(o.fov, OPENING.fov);
      camera.position.copy(o.pos);
      camera.quaternion.copy(o.quat);
      camera.fov = o.fov;
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      const bow = new THREE.Vector3(Math.cos(yaw) * len * 0.5, 0, -Math.sin(yaw) * len * 0.5).project(camera);
      const stern = new THREE.Vector3(-Math.cos(yaw) * len * 0.5, 0, Math.sin(yaw) * len * 0.5).project(camera);
      const tag = `L${len} yaw${yawDeg}`;
      assert.ok(bow.x > stern.x, `${tag}: bow heads right`);
      assert.ok((bow.x + stern.x) / 2 < -0.15, `${tag}: boat on the left third`);
      // The card's box (top 45%, left 60%) holds no boat: NDC y above 0.1, x below 0.2.
      for (const e of [bow, stern]) assert.ok(!(e.y > 0.1 && e.x < 0.2) && Math.abs(e.x) < 0.98 && Math.abs(e.y) < 0.98, `${tag}: boat in the card's corner or cropped`);
    }
  }
});

test("the results card's still: the boat in a corner outside the card (x 25-75%), never a dot", () => {
  for (const outcome of Object.keys(FINAL) as (keyof typeof FINAL)[]) {
    for (const len of [3.05, 9.39]) {
      for (const yawDeg of [0, 90, 200]) {
        const yaw = (yawDeg * Math.PI) / 180;
        const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 1e6);
        const o = finalShot({ camera, controls: { target: new THREE.Vector3() } as never, yaw: () => yaw, length: () => len, water: () => 0 }, outcome);
        camera.position.copy(o.pos);
        camera.quaternion.copy(o.quat);
        camera.fov = o.fov;
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld();
        const bow = new THREE.Vector3(Math.cos(yaw) * len * 0.5, 0, -Math.sin(yaw) * len * 0.5).project(camera);
        const stern = new THREE.Vector3(-Math.cos(yaw) * len * 0.5, 0, Math.sin(yaw) * len * 0.5).project(camera);
        const tag = `${outcome} L${len} yaw${yawDeg}`;
        for (const e of [bow, stern]) assert.ok(e.x < -0.5 && e.x > -0.98 && Math.abs(e.y) < 0.95, `${tag}: boat at ${e.x.toFixed(2)},${e.y.toFixed(2)}`);
        assert.ok(Math.abs(bow.x - stern.x) / 2 >= 0.05, `${tag}: a dot`);
      }
    }
  }
});

test("whichever way the boat heads against the shot's reference (the sun), its near end stays in frame", () => {
  for (const kind of ["sunset", "bowon", "stern", "light", "alongside", "sternlight"] as ShotKind[]) {
    for (const len of [3.05, 9.39]) {
      for (const refDeg of [0, 60, 120, 180, 240, 300]) {
        const bow = new THREE.Vector2(1, 0);
        const r = (refDeg * Math.PI) / 180;
        const ref = new THREE.Vector2(Math.cos(r), Math.sin(r));
        const look = mixLook(SHOTS[kind].from, SHOTS[kind].to, 1);
        const c = compose(new THREE.Vector3(), bow, ref, 1, len, 16 / 9, look);
        const cam = new THREE.PerspectiveCamera(c.fov, 16 / 9, 0.1, 1e6);
        cam.position.copy(c.pos);
        cam.quaternion.copy(c.quat);
        cam.updateMatrixWorld();
        for (const e of [len / 2, -len / 2]) {
          const p = new THREE.Vector3(e, 0, 0).project(cam);
          if (p.z < 1 && Math.abs(p.x) < 1) assert.ok(p.y > -0.95, `${kind} L${len} ref${refDeg}: an end at y ${p.y.toFixed(2)}`);
        }
      }
    }
  }
});

test("the title hero: backlit, the boat on the right third, bow toward the card with open sea between, loops", () => {
  for (const len of [3.05, 9.39]) {
    for (const sunAz of [0, 100, 230]) {
      const a = (sunAz * Math.PI) / 180;
      const sunDir = new THREE.Vector3(Math.cos(a), 0.05, -Math.sin(a)).normalize();
      const yaw = titleHeading(sunDir);
      const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 1e6);
      const host = { camera, controls: { target: new THREE.Vector3() } as never, yaw: () => yaw, length: () => len, water: () => 0, sunDir: () => sunDir };
      for (const t of [0, 7, 13]) {
        const o = titleShot(host, t);
        camera.position.copy(o.pos);
        camera.quaternion.copy(o.quat);
        camera.fov = o.fov;
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld();
        const bow = new THREE.Vector3(Math.cos(yaw) * len * 0.5, 0, -Math.sin(yaw) * len * 0.5).project(camera);
        const stern = new THREE.Vector3(-Math.cos(yaw) * len * 0.5, 0, Math.sin(yaw) * len * 0.5).project(camera);
        const sun = camera.position.clone().add(sunDir.clone().multiplyScalar(1e4)).project(camera);
        const tag = `L${len} sun${sunAz} t${t}`;
        assert.ok(bow.x < stern.x, `${tag}: bow toward the card (left)`);
        assert.ok((bow.x + stern.x) / 2 > 0.15, `${tag}: boat on the right third (${((bow.x + stern.x) / 2).toFixed(2)})`);
        // Jonas's card ends at 33% of the width (NDC -0.34): 15% of open sea beyond it.
        assert.ok(bow.x >= -0.04 - 1e-6, `${tag}: bow nosing into the card (${bow.x.toFixed(2)})`);
        assert.ok(stern.x < 0.98, `${tag}: stern cropped`);
        assert.ok(sun.z < 1, `${tag}: looking away from the sun`);
        // Backlit: the sun just above her, the glitter running from it through the boat to the lens.
        const mid = (bow.x + stern.x) / 2;
        assert.ok(Math.abs(sun.x - mid) < 0.08 && sun.y > bow.y && sun.y < 0.9, `${tag}: sun at ${sun.x.toFixed(2)},${sun.y.toFixed(2)}, boat at ${mid.toFixed(2)}`);
        // About a fifth of the width, on the two-thirds line (on a wide screen).
        const span = Math.abs(stern.x - bow.x) / 2;
        assert.ok(span > 0.15 && span < 0.25, `${tag}: spans ${(100 * span).toFixed(0)}%`);
        assert.ok(Math.abs(mid - 1 / 3) < 0.06, `${tag}: at ${mid.toFixed(2)}, not on the two-thirds line`);
      }
      const a0 = titleShot(host, 0).pos;
      const a1 = titleShot(host, TITLE_LOOP_S).pos;
      assert.ok(a0.distanceTo(a1) < 1e-6, "loops");
    }
  }
});

test("the title hero on a narrow screen: the boat smaller, in the sea right of a wide card", () => {
  for (const [aspect, cardRight] of [[700 / 900, 0.56], [16 / 9, 0.33], [1280 / 1024, 0.4]] as [number, number][]) {
    for (const len of [3.05, 9.39]) {
      const a = 0.7;
      const sunDir = new THREE.Vector3(Math.cos(a), 0.1, -Math.sin(a)).normalize();
      const yaw = titleHeading(sunDir);
      const camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 1e6);
      const host = { camera, controls: { target: new THREE.Vector3() } as never, yaw: () => yaw, length: () => len, water: () => 0, sunDir: () => sunDir };
      for (const t of [0, 5, 10, 15]) {
        const o = titleShot(host, t, cardRight);
        camera.position.copy(o.pos);
        camera.quaternion.copy(o.quat);
        camera.fov = o.fov;
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld();
        const bow = new THREE.Vector3(Math.cos(yaw) * len * 0.5, 0, -Math.sin(yaw) * len * 0.5).project(camera);
        const stern = new THREE.Vector3(-Math.cos(yaw) * len * 0.5, 0, Math.sin(yaw) * len * 0.5).project(camera);
        const tag = `aspect ${aspect.toFixed(2)} card ${cardRight} L${len} t${t}`;
        assert.ok(bow.x > 2 * cardRight - 1, `${tag}: bow under the card (${bow.x.toFixed(2)})`);
        assert.ok(stern.x < 0.92, `${tag}: stern at the edge (${stern.x.toFixed(2)})`);
        assert.ok(Math.abs(stern.x - bow.x) / 2 > 0.08, `${tag}: a dot`);
      }
    }
  }
});

test("never centred, not even end-on; a tall boat's masthead stays inside the letterbox (Ines)", () => {
  for (const kind of Object.keys(SHOTS) as ShotKind[]) {
    for (const len of [3.05, 9.39]) {
      for (const refDeg of [0, 90, 180, 270]) {
        const bow = new THREE.Vector2(1, 0);
        const r = (refDeg * Math.PI) / 180;
        const ref = new THREE.Vector2(Math.cos(r), Math.sin(r));
        const look = mixLook(SHOTS[kind].from, SHOTS[kind].to, 0.5);
        const tall = len > 5 ? 13.5 : 0;
        const c = compose(new THREE.Vector3(), bow, SHOTS[kind].ref === "bow" ? bow : ref, 1, len, 16 / 9, look, 0, tall);
        const cam = new THREE.PerspectiveCamera(c.fov, 16 / 9, 0.1, 1e6);
        cam.position.copy(c.pos);
        cam.quaternion.copy(c.quat);
        cam.updateMatrixWorld();
        const tag = `${kind} L${len} ref${refDeg}`;
        const mid = c.aim.clone().project(cam);
        if (!["panels", "sterndetail", "bowdetail"].includes(kind)) assert.ok(Math.abs(mid.x) > 0.2, `${tag}: centred (${mid.x.toFixed(2)})`);
        if (tall) {
          const top = new THREE.Vector3(0, tall, 0).project(cam);
          if (!["panels", "sterndetail", "bowdetail"].includes(kind)) assert.ok(top.y < 0.8, `${tag}: masthead at ${top.y.toFixed(2)}`);
          // And she isn't shrunk to fit it: a yacht framed by her mast fills half the frame's
          // height in every shot but the wide establishing one and the drone's pull-away (round 3: a fifth).
          const foot = new THREE.Vector3(0, 0, 0).project(cam);
          if (!["establish", "drone", "panels", "sterndetail", "bowdetail"].includes(kind)) assert.ok((top.y - foot.y) / 2 > 0.45, `${tag}: yacht ${(50 * (top.y - foot.y)).toFixed(0)}% tall`);
        }
      }
    }
  }
});

test("a yacht never gets the kayak's solar-panel close-up", () => {
  for (let i = 0; i < 50; i++) assert.ok(!shotsFor("passage", null, Math.random, ["panels"]).includes("panels"));
});

test("night's opening shot keeps both ends of the boat in the frame, from either side (Elena, 13 Nov)", () => {
  for (const len of [3.05, 9.39]) {
    for (const side of [1, -1]) {
      for (const u of [0, 1]) {
        const f = film("light", len, 37, side, u);
        for (const [name, p] of [["bow", f.bowP], ["stern", f.sternP]] as const) {
          assert.ok(Math.abs(p.x) < 0.9, `light L${len} side ${side} u${u}: the ${name} is at ${p.x.toFixed(2)} of the half-width`);
        }
      }
    }
  }
});

test("the astern night shot is framed by the hull: the horizon on the upper third, a third closer", () => {
  assert.ok(SHOTS.sternlight.hull);
  for (const u of [0, 1]) {
    const f = film("sternlight", 3.05, 37, 1, u);
    assert.ok(Math.abs(f.horizon.y - 0.25) < 0.03, `horizon at ${f.horizon.y.toFixed(2)}`);
    // About a third closer than when the aerial set the distance (9.7 m then).
    const d = f.c.pos.distanceTo(f.c.aim);
    assert.ok(d > 5.5 && d < 7, `camera ${d.toFixed(1)} m off`);
  }
});
