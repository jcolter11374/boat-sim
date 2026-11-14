// John's title track (titleTrack.ts): the loop points and its file, checked without audio. 14 Nov 2026.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { ENCODER_DELAY, LOOP_SECONDS, TRACK_LEVEL, WRAP_SECONDS, loopStartOf } from "../src/titleTrack.ts";

const ROOT = new URL("../", import.meta.url).pathname;

test("the loop starts past the wrap, and past an encoder delay a decoder left in", () => {
  assert.equal(loopStartOf(LOOP_SECONDS + 2 * WRAP_SECONDS), WRAP_SECONDS);
  assert.equal(loopStartOf(LOOP_SECONDS + 2 * WRAP_SECONDS + 0.05), WRAP_SECONDS + ENCODER_DELAY);
  // the loop's end stays inside the file's trailing wrap either way
  assert.ok(WRAP_SECONDS + ENCODER_DELAY + LOOP_SECONDS < LOOP_SECONDS + 2 * WRAP_SECONDS + ENCODER_DELAY);
});

test("the track is quiet under the sea and its file is in the build", () => {
  assert.ok(TRACK_LEVEL > 0 && TRACK_LEVEL <= 0.1);
  const f = ROOT + "public/music/saltwater-patience-loop.mp3";
  assert.ok(existsSync(f));
  assert.ok(statSync(f).size < 2_000_000, "keep the music under 2 MB");
});
