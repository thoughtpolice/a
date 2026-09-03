// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "../assert.ts";
import { AUDIO_RATE } from "../audio.ts";
import { SinkBuffer } from "../sink_buffer.ts";

function ramp(frames: number, from = 0): Int16Array {
  const samples = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    samples[i * 2] = from + i;
    samples[i * 2 + 1] = -(from + i);
  }
  return samples;
}

function block(size: number): [Float32Array, Float32Array] {
  return [new Float32Array(size), new Float32Array(size)];
}

Deno.test("nothing plays until the buffer has primed", () => {
  const sink = new SinkBuffer(1024);
  sink.configure(256);
  const [left, right] = block(128);
  sink.push(ramp(100));
  sink.render(left, right, AUDIO_RATE);
  assertEquals(left.every((value) => value === 0), true);
  assertEquals(sink.queued, 100);

  sink.push(ramp(200, 100));
  sink.render(left, right, AUDIO_RATE);
  assertEquals(left[0], 0);
  assertEquals(right[0], -0);
  assertEquals(left[1], 1 / 32768);
  assertEquals(sink.queued, 300 - 128);
});

Deno.test("int16 frames arrive as floats in both channels", () => {
  const sink = new SinkBuffer(1024);
  sink.push(new Int16Array([32767, -32768, 16384, -16384]));
  const [left, right] = block(2);
  sink.render(left, right, AUDIO_RATE);
  assertEquals(left[0], 32767 / 32768);
  assertEquals(right[0], -1);
  assertEquals(left[1], 0.5);
  assertEquals(right[1], -0.5);
});

Deno.test("an empty buffer is silence, and the next block primes again", () => {
  const sink = new SinkBuffer(1024);
  sink.configure(4);
  sink.push(ramp(8));
  const [left, right] = block(16);
  sink.render(left, right, AUDIO_RATE);
  assertEquals(sink.underruns, 1);
  assertEquals(left[7], 7 / 32768);
  assertEquals(left[8], 0);
  assertEquals(left[15], 0);

  sink.push(ramp(2, 100));
  sink.render(left, right, AUDIO_RATE);
  assertEquals(left[0], 0, "two frames is below the priming mark");
  sink.push(ramp(20, 200));
  sink.render(left, right, AUDIO_RATE);
  assertEquals(left[0], 100 / 32768);
});

Deno.test("a chunk that does not fit is dropped whole", () => {
  const sink = new SinkBuffer(64);
  assertEquals(sink.push(ramp(40)), true);
  assertEquals(sink.push(ramp(40, 1000)), false);
  assertEquals(sink.dropped, 40);
  assertEquals(sink.queued, 40);
  assertEquals(sink.push(ramp(24, 500)), true);
  assertEquals(sink.queued, 64);
});

Deno.test("a device that is not 44100 Hz consumes proportionally", () => {
  const sink = new SinkBuffer(8192);
  sink.push(ramp(4000));
  const [left, right] = block(480);
  sink.render(left, right, 48000);
  const consumed = 4000 - sink.queued;
  assert(Math.abs(consumed - 441) <= 2, `consumed ${consumed} for 480 device frames`);
  assertEquals(sink.underruns, 0);
  // Linear interpolation stays inside the ramp it is reading.
  assert(left[0] >= 0 && left[479] <= 441 / 32768, "the resampled block follows the ramp");
  assert(left[240] > left[0], "and rises with it");
});

Deno.test("clearing forgets everything and primes again", () => {
  const sink = new SinkBuffer(1024);
  sink.configure(8);
  sink.push(ramp(64));
  const [left, right] = block(8);
  sink.render(left, right, AUDIO_RATE);
  assertEquals(left[0], 0);
  sink.clear();
  assertEquals(sink.queued, 0);
  sink.push(ramp(4, 900));
  sink.render(left, right, AUDIO_RATE);
  assertEquals(left.every((value) => value === 0), true, "below the priming mark after a clear");
});
