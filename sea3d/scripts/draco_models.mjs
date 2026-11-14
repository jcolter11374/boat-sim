// Compress the boat and landmark models' geometry (Omar's speed baseline, 14 Nov: the models
// were three quarters of what a 3D page fetched before its first frame). Each .glb's triangle
// meshes are re-encoded with Draco (KHR_draco_mesh_compression), using the encoder that ships
// inside three.js, so there is nothing new to install. Pictures, materials, names and the node
// tree are untouched; the page decodes with three's DRACOLoader (src/gltf.ts).
//
//   node scripts/draco_models.mjs dist/models [more folders or files ...]
//
// The build runs it on dist/models (vite.config.ts). Safe to run twice: a model already
// compressed is left alone. Positions keep 14 bits over each part's own box (0.2 mm on a 3 m
// hull, under 1 mm on a 14 m mast), normals 10 bits, picture coordinates 12 bits.
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const EXT = "KHR_draco_mesh_compression";
export const BITS = { POSITION: 14, NORMAL: 10, TEXCOORD_0: 12 };
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/** One of three.js's Draco scripts, started. three.js is an ES-module package and these files
 *  inside it are old-style scripts: each is read and run as one, with a `module` of its own to
 *  export into. (The module object has a `then` of its own that answers with itself, so
 *  awaiting it never ends: it is handed over inside a plain object.) */
function start(name, key) {
  const file = require.resolve(`three/examples/jsm/libs/draco/gltf/${name}`);
  const mod = { exports: {} };
  new Function("module", "exports", "require", "__dirname", "__filename", readFileSync(file, "utf8"))(mod, mod.exports, require, dirname(file), file);
  const make = typeof mod.exports === "function" ? mod.exports : mod.exports[key];
  return new Promise((resolve) => make({ onModuleLoaded: (m) => resolve({ draco: m }) }));
}
let dracoP = null;
const encoderModule = () => (dracoP ??= Promise.all([start("draco_encoder.js", "DracoEncoderModule"), start("draco_decoder.js", "DracoDecoderModule")]).then(([e, d]) => ({ draco: e.draco, undraco: d.draco })));

/** The summed area of a mesh's triangles and its box, from its corner positions. */
function measure(pos, tri) {
  let area = 0;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < tri.length; k += 3) {
    const [a, b, c] = [tri[k] * 3, tri[k + 1] * 3, tri[k + 2] * 3];
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    for (const i of [a, b, c]) for (let d = 0; d < 3; d++) (lo[d] = Math.min(lo[d], pos[i + d])), (hi[d] = Math.max(hi[d], pos[i + d]));
  }
  return { area, lo, hi };
}

/** What a Draco mesh decodes to: how many points and faces (the encoder merges points and
 *  drops triangles with no area), and its area and box, to hold against what went in. */
function decoded(undraco, bytes) {
  const dec = new undraco.Decoder();
  const buf = new undraco.DecoderBuffer();
  const mesh = new undraco.Mesh();
  const vals = new undraco.DracoFloat32Array();
  const face = new undraco.DracoInt32Array();
  try {
    buf.Init(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length), bytes.length);
    const st = dec.DecodeBufferToMesh(buf, mesh);
    if (!st.ok()) throw new Error(`a compressed mesh didn't decode: ${st.error_msg()}`);
    const points = mesh.num_points();
    const faces = mesh.num_faces();
    dec.GetAttributeFloatForAllPoints(mesh, dec.GetAttribute(mesh, dec.GetAttributeId(mesh, undraco.POSITION)), vals);
    const pos = new Float32Array(points * 3);
    for (let k = 0; k < pos.length; k++) pos[k] = vals.GetValue(k);
    const tri = new Uint32Array(faces * 3);
    for (let f = 0; f < faces; f++) {
      dec.GetFaceFromMesh(mesh, f, face);
      for (let c = 0; c < 3; c++) tri[f * 3 + c] = face.GetValue(c);
    }
    return { points, faces, ...measure(pos, tri) };
  } finally {
    undraco.destroy(face);
    undraco.destroy(vals);
    undraco.destroy(mesh);
    undraco.destroy(buf);
    undraco.destroy(dec);
  }
}

function parseGlb(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error("not a .glb file");
  let at = 12;
  let json = null;
  let bin = Buffer.alloc(0);
  while (at < buf.length) {
    const len = buf.readUInt32LE(at);
    const type = buf.readUInt32LE(at + 4);
    const body = buf.subarray(at + 8, at + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(body.toString("utf8"));
    else if (type === 0x004e4942) bin = body;
    at += 8 + len;
  }
  if (!json) throw new Error("no JSON chunk");
  return { json, bin };
}

function writeGlb(json, bin) {
  let j = Buffer.from(JSON.stringify(json), "utf8");
  j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const b = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + j.length + 8 + b.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(j.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(b.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, jh, j, bh, b]);
}

/** An accessor's numbers as a typed array (float or unsigned integer, tightly packed or strided). */
function read(json, bin, i) {
  const a = json.accessors[i];
  const v = json.bufferViews[a.bufferView];
  const n = COMPONENTS[a.type];
  const [T, size] = { 5126: [Float32Array, 4], 5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5121: [Uint8Array, 1] }[a.componentType] ?? [];
  if (!T) throw new Error(`component type ${a.componentType}`);
  const start = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const stride = v.byteStride ?? n * size;
  const out = new T(a.count * n);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const get = { 5126: (o) => dv.getFloat32(o, true), 5123: (o) => dv.getUint16(o, true), 5125: (o) => dv.getUint32(o, true), 5121: (o) => dv.getUint8(o) }[a.componentType];
  for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = get(start + k * stride + c * size);
  return out;
}

/** One model's bytes, compressed; null if there is nothing to do (already compressed, or no plain triangle meshes). */
export async function compressGlb(buf) {
  const { json, bin } = parseGlb(buf);
  if ((json.extensionsUsed ?? []).includes(EXT)) return null;
  if ((json.buffers ?? []).length !== 1 || json.buffers[0].uri) return null;
  const { draco, undraco } = await encoderModule();
  const kinds = { POSITION: draco.POSITION, NORMAL: draco.NORMAL, TEXCOORD_0: draco.TEX_COORD };
  const chunks = []; // the new binary chunk, piece by piece
  const views = []; // the new bufferViews
  let size = 0;
  const addView = (bytes) => {
    const pad = (4 - (size % 4)) % 4;
    if (pad) chunks.push(Buffer.alloc(pad)), (size += pad);
    views.push({ buffer: 0, byteOffset: size, byteLength: bytes.length });
    chunks.push(bytes);
    size += bytes.length;
    return views.length - 1;
  };
  const accessors = [];
  const plain = new Map(); // old accessor -> new index, for anything left as it was
  const keepAccessor = (i) => {
    if (plain.has(i)) return plain.get(i);
    const a = { ...json.accessors[i] };
    if (a.sparse) throw new Error("sparse accessor");
    const v = json.bufferViews[a.bufferView];
    const nv = addView(bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength));
    if (v.byteStride) views[nv].byteStride = v.byteStride;
    if (v.target) views[nv].target = v.target;
    a.bufferView = nv;
    accessors.push(a);
    plain.set(i, accessors.length - 1);
    return accessors.length - 1;
  };
  let done = 0;
  for (const mesh of json.meshes ?? []) {
    for (const p of mesh.primitives) {
      const names = Object.keys(p.attributes);
      const simple = (p.mode ?? 4) === 4 && p.indices !== undefined && !p.targets && names.includes("POSITION") && names.every((n) => n in kinds && json.accessors[p.attributes[n]].componentType === 5126);
      if (!simple) {
        for (const n of names) p.attributes[n] = keepAccessor(p.attributes[n]);
        if (p.indices !== undefined) p.indices = keepAccessor(p.indices);
        continue;
      }
      const idx = Uint32Array.from(read(json, bin, p.indices));
      const builder = new draco.MeshBuilder();
      const m = new draco.Mesh();
      const enc = new draco.Encoder();
      const out = new draco.DracoInt8Array();
      try {
        builder.AddFacesToMesh(m, idx.length / 3, idx);
        const ids = {};
        const data = {};
        const width = {};
        for (const n of names) {
          const a = json.accessors[p.attributes[n]];
          data[n] = read(json, bin, p.attributes[n]);
          width[n] = COMPONENTS[a.type];
          ids[n] = builder.AddFloatAttribute(m, kinds[n], a.count, width[n], data[n]);
          enc.SetAttributeQuantization(kinds[n], BITS[n]);
        }
        enc.SetSpeedOptions(0, 0); // smallest
        enc.SetEncodingMethod(draco.MESH_EDGEBREAKER_ENCODING);
        const len = enc.EncodeMeshToDracoBuffer(m, out);
        if (len <= 0) throw new Error(`Draco could not encode a part of mesh "${mesh.name ?? "?"}"`);
        const bytes = Buffer.alloc(len);
        for (let k = 0; k < len; k++) bytes[k] = out.GetValue(k);
        // The proof that nothing a player can see changed: every triangle that went in comes out,
        // but for ones with no area (a cone's tip, a collapsed edge: Draco drops those), and the
        // part keeps its area and its box to within the 14-bit grid.
        const was = measure(data.POSITION, idx);
        const now = decoded(undraco, bytes);
        const { points, faces } = now;
        const span = Math.max(...was.hi.map((h, d) => h - was.lo[d]), 1e-9);
        const step = span / (2 ** BITS.POSITION - 1);
        let flat = 0;
        for (let k = 0; k < idx.length; k += 3) {
          const [a, b, c] = [idx[k] * 3, idx[k + 1] * 3, idx[k + 2] * 3];
          const P = data.POSITION;
          const near = (i, j) => Math.abs(P[i] - P[j]) <= step && Math.abs(P[i + 1] - P[j + 1]) <= step && Math.abs(P[i + 2] - P[j + 2]) <= step;
          if (near(a, b) || near(b, c) || near(a, c)) flat++;
        }
        const what = `mesh "${mesh.name ?? "?"}"`;
        if (faces > idx.length / 3 || faces < idx.length / 3 - flat) throw new Error(`${what}: ${idx.length / 3} triangles went in (${flat} with no area) and ${faces} came out`);
        // (Each corner may move half a grid step: a triangle's area changes by at most about its perimeter times that.)
        if (Math.abs(now.area - was.area) > 0.002 * was.area + 4 * step * Math.sqrt(was.area) * Math.sqrt(idx.length / 3)) throw new Error(`${what}: its area went from ${was.area} to ${now.area} m2`);
        for (let d = 0; d < 3; d++) if (Math.abs(now.lo[d] - was.lo[d]) > step || Math.abs(now.hi[d] - was.hi[d]) > step) throw new Error(`${what}: its box moved by more than the grid step (${step} m)`);
        const view = addView(bytes);
        for (const n of names) {
          const a = json.accessors[p.attributes[n]];
          const na = { componentType: 5126, count: points, type: a.type };
          if (a.min) (na.min = a.min), (na.max = a.max);
          if (a.name) na.name = a.name;
          accessors.push(na);
          p.attributes[n] = accessors.length - 1;
        }
        accessors.push({ componentType: 5125, count: faces * 3, type: "SCALAR" });
        p.indices = accessors.length - 1;
        p.extensions = { ...(p.extensions ?? {}), [EXT]: { bufferView: view, attributes: ids } };
        done++;
      } finally {
        draco.destroy(out);
        draco.destroy(enc);
        draco.destroy(m);
        draco.destroy(builder);
      }
    }
  }
  if (!done) return null;
  // Everything else that pointed into the old binary chunk: pictures, and accessors used by
  // anything but meshes (none in our models; an animation or a skin would land here).
  for (const img of json.images ?? []) {
    if (img.bufferView === undefined) continue;
    const v = json.bufferViews[img.bufferView];
    img.bufferView = addView(bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength));
  }
  if ((json.animations ?? []).length || (json.skins ?? []).length) throw new Error("animations and skins aren't handled");
  json.accessors = accessors;
  json.bufferViews = views;
  json.buffers = [{ byteLength: size }];
  json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), EXT])];
  json.extensionsRequired = [...new Set([...(json.extensionsRequired ?? []), EXT])];
  return writeGlb(json, Buffer.concat(chunks));
}

/** Compress every .glb under the given folders or files, in place. Returns [name, before, after] rows. */
export async function compressModels(paths) {
  const rows = [];
  for (const p of paths) {
    let files;
    try {
      files = statSync(p).isDirectory() ? readdirSync(p).filter((f) => f.endsWith(".glb")).sort().map((f) => join(p, f)) : [p];
    } catch {
      continue; // a build without models
    }
    for (const f of files) {
      const before = readFileSync(f);
      let after = null;
      try {
        after = await compressGlb(before);
      } catch (e) {
        // A model this can't compress faithfully ships as it was built: bigger, never wrong.
        console.warn(`${f}: left uncompressed (${e instanceof Error ? e.message : e})`);
      }
      if (!after) continue;
      writeFileSync(f, after);
      rows.push([f, before.length, after.length]);
    }
  }
  return rows;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && basename(process.argv[1]) === "draco_models.mjs") {
  const rows = await compressModels(process.argv.slice(2));
  for (const [f, a, b] of rows) console.log(`${f}: ${(a / 1024).toFixed(0)} kB -> ${(b / 1024).toFixed(0)} kB`);
  const sum = (i) => rows.reduce((s, r) => s + r[i], 0);
  console.log(rows.length ? `${rows.length} models: ${(sum(1) / 1048576).toFixed(1)} MB -> ${(sum(2) / 1048576).toFixed(1)} MB` : "no models to compress");
}
