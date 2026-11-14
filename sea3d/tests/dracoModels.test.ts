import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error a plain script with no types of its own
import { BITS, compressGlb } from "../scripts/draco_models.mjs";

/** A .glb with one mesh: a flat grid of n x n squares, with normals and picture coordinates. */
function gridGlb(n: number): Buffer {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) {
      pos.push((3 * i) / n, 0.2 * Math.sin(i / 3) * Math.cos(j / 4), (0.9 * j) / n);
      nor.push(0, 1, 0);
      uv.push(i / n, j / n);
    }
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      idx.push(a, a + 1, a + n + 1, a + 1, a + n + 2, a + n + 1);
    }
  const parts = [Buffer.from(new Float32Array(pos).buffer), Buffer.from(new Float32Array(nor).buffer), Buffer.from(new Float32Array(uv).buffer), Buffer.from(new Uint16Array(idx).buffer)];
  const views = [];
  let at = 0;
  for (const p of parts) {
    views.push({ buffer: 0, byteOffset: at, byteLength: p.length });
    at += p.length;
  }
  const count = (n + 1) * (n + 1);
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "hull" }],
    meshes: [{ name: "hull", primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ name: "paint" }],
    accessors: [
      { bufferView: 0, componentType: 5126, count, type: "VEC3", min: [0, -0.2, 0], max: [3, 0.2, 0.9] },
      { bufferView: 1, componentType: 5126, count, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count, type: "VEC2" },
      { bufferView: 3, componentType: 5123, count: idx.length, type: "SCALAR" },
    ],
    bufferViews: views,
    buffers: [{ byteLength: at }],
  };
  let j = Buffer.from(JSON.stringify(json));
  j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat(parts);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(28 + j.length + bin.length, 8);
  head.writeUInt32LE(j.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, j, bh, bin]);
}

const jsonOf = (glb: Buffer) => JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString("utf8"));

test("a model's geometry is compressed, and its names, materials and triangle count are kept", async () => {
  const before = gridGlb(60);
  const after: Buffer = await compressGlb(before);
  assert.ok(after.length < before.length / 4, `${before.length} bytes became ${after.length}`);
  const j = jsonOf(after);
  assert.deepEqual(j.extensionsRequired, ["KHR_draco_mesh_compression"]);
  const p = j.meshes[0].primitives[0];
  assert.equal(j.nodes[0].name, "hull");
  assert.equal(p.material, 0);
  assert.equal(j.accessors[p.indices].count, 60 * 60 * 2 * 3);
  assert.deepEqual(j.accessors[p.attributes.POSITION].max, [3, 0.2, 0.9]); // the box three.js culls with
  assert.deepEqual(Object.keys(p.extensions.KHR_draco_mesh_compression.attributes).sort(), ["NORMAL", "POSITION", "TEXCOORD_0"]);
  assert.equal(j.buffers[0].byteLength, after.length - 28 - after.readUInt32LE(12));
});

test("a model already compressed is left alone", async () => {
  const once: Buffer = await compressGlb(gridGlb(8));
  assert.equal(await compressGlb(once), null);
});

test("positions keep at least 14 bits: 0.2 mm on a 3 m hull", () => {
  assert.ok(BITS.POSITION >= 14);
  assert.ok(3 / (2 ** BITS.POSITION - 1) < 0.0002);
});
