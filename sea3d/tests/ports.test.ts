// The helm's port picker data (helm/ports.ts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadPorts, portLabel, type Port } from "../src/helm/ports";

const json = (body: string) => async () => new Response(body, { headers: { "content-type": "application/json" } });

test("only ports west of the start line and inside the weather, by name", async () => {
  const P = (id: string, name: string, in_corridor: boolean, crosses_start: boolean): Port =>
    ({ id, name, lat: 40, lon: -70, launch_lat: 40, launch_lon: -70, launch_km: 30, in_corridor, crosses_start });
  const list = await loadPorts("x", json(JSON.stringify({ ports: [P("n", "Norfolk", true, true), P("l", "Lisboa", true, false), P("c", "Charleston", false, true), P("b", "Boston", true, true)] })));
  assert.deepEqual(list.map((p) => p.id), ["b", "n"]);
  assert.deepEqual(await loadPorts("x", async () => new Response("", { status: 404 })), []);
});

test("the published list offers the Bay ports, labels twins by position", async () => {
  const list = await loadPorts("x", json(readFileSync(new URL("../public/ports.json", import.meta.url), "utf8")));
  const ids = list.map((p) => p.id);
  assert.ok(ids.includes("baltimore") && ids.includes("norfolk") && !ids.includes("lisboa"));
  const ports = list.filter((p) => p.name === "Portsmouth");
  assert.equal(ports.length, 2);
  assert.match(portLabel(ports[0], list), /^Portsmouth \(\d+°N \d+°W\), launched \d+ km out by water at \d+\.\d°N \d+\.\d°W/);
  assert.match(portLabel(list.find((p) => p.id === "baltimore")!, list), /^Baltimore, launched \d+ km out by water at 3\d\.\d°N 7\d\.\d°W/);
});

test("ports dropped at the same point say so", () => {
  const P = (id: string, name: string, launch_lon: number): Port =>
    ({ id, name, lat: 46, lon: -62, launch_lat: 46.27, launch_lon, launch_km: 250, in_corridor: true, crosses_start: true });
  const all = [P("c", "Charlottetown", -59.59), P("p", "Pictou", -59.59), P("y", "Yarmouth", -65.87)];
  assert.equal(portLabel(all[0], all), "Charlottetown, launched 250 km out by water at 46.3°N 59.6°W, same start as Pictou");
  assert.equal(portLabel(all[2], all), "Yarmouth, launched 250 km out by water at 46.3°N 65.9°W");
});
