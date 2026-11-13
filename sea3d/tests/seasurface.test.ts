// The shared sea surface (src/seaSurface.ts): the JS surface is waves.ts exactly,
// and the GLSL seaHeight() (two fixed-point steps) agrees with it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SEA_STATES, components, displace, heightAt, type WaveComponent } from "../src/waves";
import { SEA_SURFACE_PARS, gerstnerSurface, seaUniforms, writeSeaUniforms } from "../src/seaSurface";

/** The GLSL seaHeight(), line for line, on the packed uniforms. */
function glslHeight(x: number, z: number): number {
  const u = seaUniforms;
  const disp = (px: number, pz: number): [number, number, number] => {
    let dx = 0, y = 0, dz = 0;
    for (let i = 0; i < u.uSeaN.value; i++) {
      const a = u.uSeaWa.value[i];
      const d = u.uSeaWd.value[i];
      const th = a.y * (d.x * px + d.y * pz) - a.z * u.uSeaTime.value + a.w;
      const qa = u.uSeaQ.value * a.x;
      dx += -qa * d.x * Math.sin(th);
      y += a.x * Math.cos(th);
      dz += -qa * d.y * Math.sin(th);
    }
    return [dx, y, dz];
  };
  let px = x, pz = z;
  for (let j = 0; j < 2; j++) {
    const d = disp(px, pz);
    px = x - d[0];
    pz = z - d[2];
  }
  return disp(px, pz)[1];
}

for (const key of ["calm", "moderate", "gale"]) {
  test(`surface = waves.ts heightAt, and the shader's agrees (${key})`, () => {
    const comps: WaveComponent[] = components(SEA_STATES[key], 24, 1);
    const t = 37.5;
    const s = gerstnerSurface(comps);
    writeSeaUniforms(comps, t);
    for (const [x, z] of [[0, 0], [3.2, -7.1], [-41, 18], [120, 95]]) {
      assert.equal(s.heightAt(x, z, t), heightAt(comps, x, z, t));
      // Two steps in the shader against four in JS: within 2 cm even in a gale.
      assert.ok(Math.abs(glslHeight(x, z) - heightAt(comps, x, z, t)) < 0.02, `${key} at ${x},${z}`);
      const n = s.normalAt(x, z, t);
      assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-9 && n[1] > 0.5);
    }
  });
}

test("the normal tilts down the slope", () => {
  const comps: WaveComponent[] = [{ amplitude: 1, wavelength: 50, direction: 0, phase: 0 }];
  const s = gerstnerSurface(comps, 0); // plain sine: y = cos(k x)
  const k = (2 * Math.PI) / 50;
  const x = 50 / 4; // falling slope: dy/dx = -k
  const n = s.normalAt(x, 0, 0);
  assert.ok(Math.abs(n[0] / n[1] - k * Math.sin(k * x)) < 1e-3);
  assert.equal(displace(comps, 0, 0, 0, 0)[1], 1);
});

test("the GLSL chunk declares what it reads", () => {
  for (const name of Object.keys(seaUniforms)) assert.match(SEA_SURFACE_PARS, new RegExp(`uniform \\w+ ${name}\\b`));
  assert.match(SEA_SURFACE_PARS, /float seaHeight\(vec2 xz\)/);
});
