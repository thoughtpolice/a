// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "../assert.ts";
import { AUDIO_CAPACITY, AudioQueue, AudioSink } from "../audio.ts";

function samples(count: number, value: (index: number) => number): Uint8Array {
  const bytes = new Uint8Array(count * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < count; i++) view.setInt16(i * 2, value(i), true);
  return bytes;
}

class Collector implements AudioSink {
  readonly played: number[] = [];
  silent = 0;

  chunk(values: Int16Array): void {
    for (const value of values) this.played.push(value);
  }

  silence(frames: number): void {
    this.silent += frames;
  }
}

function reference(values: number[]): string {
  let hash = 0xcbf29ce484222325n;
  const mask = 0xffffffffffffffffn;
  for (const value of values) {
    for (const byte of [value & 0xff, (value >> 8) & 0xff]) {
      hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & mask;
    }
  }
  return hash.toString(16).padStart(16, "0");
}

Deno.test("the queue takes whole frames and no more than fits", () => {
  const queue = new AudioQueue();
  assertEquals(queue.write(samples(200, () => 1), 200), 100);
  // An odd sample count offers a trailing half-frame, which is dropped.
  assertEquals(queue.write(samples(201, () => 1), 201), 100);
  assertEquals(queue.queued(), 200);
  assertEquals(queue.write(samples(88200, () => 1), 88200), AUDIO_CAPACITY - 200);
  assertEquals(queue.queued(), AUDIO_CAPACITY);
  assertEquals(queue.write(samples(2, () => 1), 2), 0);
});

Deno.test("a frame period's worth plays after every frame", () => {
  for (const fps of [35, 60, 70, 7, 13]) {
    const queue = new AudioQueue();
    const sink = new Collector();
    let total = 0;
    for (let frame = 1; frame <= 20; frame++) {
      queue.write(samples(4000, (i) => i), 4000);
      queue.play(frame, fps, sink);
      total = Math.floor((frame * 44100) / fps);
      assertEquals(queue.played + sink.silent, total, `${fps} Hz at frame ${frame}`);
    }
    assertEquals(queue.played + sink.silent, total, `${fps} Hz total`);
  }
});

Deno.test("only what played is hashed, and silence never is", () => {
  const queue = new AudioQueue();
  const sink = new Collector();
  queue.write(samples(1000, (i) => i - 400), 1000);
  queue.play(1, 60, sink);
  assertEquals(queue.played, 500);
  assertEquals(sink.silent, 735 - 500);
  assertEquals(queue.hash.hex(), reference(sink.played));

  const before = queue.hash.hex();
  queue.play(2, 60, sink);
  assertEquals(queue.played, 500);
  assertEquals(queue.hash.hex(), before, "a period of pure silence changes nothing");
});

Deno.test("the ring wraps without losing a sample", () => {
  const queue = new AudioQueue();
  const sink = new Collector();
  let next = 0;
  for (let round = 0; round < 4; round++) {
    const count = 30000;
    queue.write(samples(count * 2, () => (next++ % 1000) - 500), count * 2);
    queue.play(round + 1, 1, sink);
  }
  assertEquals(queue.played, 30000 * 4);
  assertEquals(sink.played.length, 30000 * 8);
  assertEquals(queue.hash.hex(), reference(sink.played));
});
