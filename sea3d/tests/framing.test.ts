import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { TITLE_LOOP_S, heightOf, titleHeading, titleShot } from "../src/framing";

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


test("a yacht on the title keeps her masthead inside the frame", () => {
  const sunDir = new THREE.Vector3(Math.cos(1), 0.08, -Math.sin(1)).normalize();
  const yaw = titleHeading(sunDir);
  const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 1e6);
  const host = { camera, controls: { target: new THREE.Vector3() } as never, yaw: () => yaw, length: () => 9.39, height: () => 13.5, water: () => 0, sunDir: () => sunDir };
  for (const t of [0, 5, 10, 15]) {
    const o = titleShot(host, t);
    camera.position.copy(o.pos);
    camera.quaternion.copy(o.quat);
    camera.fov = o.fov;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    const top = new THREE.Vector3(0, 13.5, 0).project(camera);
    assert.ok(top.y < 0.8, `t${t}: masthead at ${top.y.toFixed(2)}`);
  }
});

test("a boat's height above the water is measured once", () => {
  const root = new THREE.Mesh(new THREE.BoxGeometry(1, 4, 1));
  root.position.y = 1;
  root.updateMatrixWorld();
  assert.equal(heightOf(root, 0), 3);
  root.position.y = 5;
  root.updateMatrixWorld();
  assert.equal(heightOf(root, 0), 3);
});

test("the title hero on a phone held upright, menu across the bottom: the boat in the upper half, near the middle", () => {
  for (const len of [3.05, 9.39]) {
    for (const sunAz of [0, 230]) {
      const a = (sunAz * Math.PI) / 180;
      const sunDir = new THREE.Vector3(Math.cos(a), 0.05, -Math.sin(a)).normalize();
      const yaw = titleHeading(sunDir);
      const camera = new THREE.PerspectiveCamera(45, 390 / 844, 0.1, 1e6);
      const host = { camera, controls: { target: new THREE.Vector3() } as never, yaw: () => yaw, length: () => len, water: () => 0, sunDir: () => sunDir, height: () => (len > 5 ? 13 : 0) };
      for (const t of [0, 7, 13]) {
        const o = titleShot(host, t, 0.95, true);
        camera.position.copy(o.pos);
        camera.quaternion.copy(o.quat);
        camera.fov = o.fov;
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld();
        const bow = new THREE.Vector3(Math.cos(yaw) * len * 0.5, 0, -Math.sin(yaw) * len * 0.5).project(camera);
        const stern = new THREE.Vector3(-Math.cos(yaw) * len * 0.5, 0, Math.sin(yaw) * len * 0.5).project(camera);
        const tag = `L${len} sun${sunAz} t${t}`;
        const mid = (bow.x + stern.x) / 2;
        const y = (1 - (bow.y + stern.y) / 2) / 2; // share of the height from the top
        assert.ok(Math.abs(mid) < 0.4, `${tag}: near the middle across (${mid.toFixed(2)})`);
        assert.ok(bow.x > -0.98 && stern.x < 0.98, `${tag}: cropped (${bow.x.toFixed(2)}, ${stern.x.toFixed(2)})`);
        assert.ok(y > 0.2 && y < 0.5, `${tag}: in the upper half, above the menu (${y.toFixed(2)} down)`);
        assert.ok(Math.abs(stern.x - bow.x) / 2 > 0.2, `${tag}: big enough to read (${(Math.abs(stern.x - bow.x) / 2).toFixed(2)})`);
      }
    }
  }
});

test("the sailing view slides the boat to a third on a wide window and keeps her near the middle on a phone", async () => {
  const { slideRoom } = await import("../src/framing");
  // The share of the frame's width the hull spans: our 3 m kayak from the default camera.
  const across = (aspect: number, dist = 10.5) => 3.05 / (2 * dist * Math.tan((45 * Math.PI) / 360) * aspect);
  assert.equal(slideRoom(across(1280 / 720)), 1, "a desktop window: the full slide");
  assert.equal(slideRoom(across(1920 / 1080)), 1);
  assert.equal(slideRoom(across(390 / 844)), 0, "a phone held upright: none");
  assert.equal(slideRoom(across(360 / 740)), 0);
  const mid = slideRoom(0.4);
  assert.ok(mid > 0 && mid < 1, "in between it eases, never jumps");
  assert.equal(slideRoom(NaN), 0);
});
