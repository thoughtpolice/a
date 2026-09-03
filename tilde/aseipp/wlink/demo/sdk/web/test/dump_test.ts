// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "../assert.ts";
import { ppm, SeekableOutput, WavWriter } from "../dump.ts";

/** A file in memory that the writer can seek back into. */
class Buffer implements SeekableOutput {
  bytes = new Uint8Array(0);
  private at = 0;
  closed = false;

  writeSync(chunk: Uint8Array): void {
    if (this.at + chunk.length > this.bytes.length) {
      const grown = new Uint8Array(this.at + chunk.length);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes.set(chunk, this.at);
    this.at += chunk.length;
  }

  seekSync(offset: number): void {
    this.at = offset;
  }

  close(): void {
    this.closed = true;
  }
}

Deno.test("the frame the SDK contract presents, as a PPM", () => {
  const rgba = new Uint8Array([
    255,
    0,
    0,
    255,
    0,
    255,
    0,
    255,
    0,
    0,
    255,
    255,
    255,
    255,
    255,
    255,
  ]);
  const expected = new Uint8Array([
    ...new TextEncoder().encode("P6\n2 2\n255\n"),
    255,
    0,
    0,
    0,
    255,
    0,
    0,
    0,
    255,
    255,
    255,
    255,
  ]);
  assertEquals(ppm(2, 2, rgba), expected);
});

Deno.test("a WAV file of what played, silence included", () => {
  const out = new Buffer();
  const wav = new WavWriter(out);
  wav.samples(new Int16Array([1, -1, 2, -2]));
  wav.silence(3);
  wav.close();

  const data = out.bytes;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ascii = (at: number, length: number) =>
    new TextDecoder().decode(data.subarray(at, at + length));
  assertEquals(ascii(0, 4), "RIFF");
  assertEquals(ascii(8, 8), "WAVEfmt ");
  assertEquals(ascii(36, 4), "data");
  assertEquals(view.getUint32(16, true), 16);
  assertEquals(view.getUint16(20, true), 1);
  assertEquals(view.getUint16(22, true), 2);
  assertEquals(view.getUint32(24, true), 44100);
  assertEquals(view.getUint32(28, true), 44100 * 4);
  assertEquals(view.getUint16(32, true), 4);
  assertEquals(view.getUint16(34, true), 16);

  const frames = 2 + 3;
  assertEquals(view.getUint32(40, true), frames * 4);
  assertEquals(view.getUint32(4, true), 36 + frames * 4);
  assertEquals(data.length, 44 + frames * 4);
  assertEquals(view.getInt16(44, true), 1);
  assertEquals(view.getInt16(46, true), -1);
  assertEquals(data.subarray(52).every((byte) => byte === 0), true);
  assertEquals(out.closed, true);
});

Deno.test("an empty track is a header with zero sizes", () => {
  const out = new Buffer();
  new WavWriter(out).close();
  const view = new DataView(out.bytes.buffer);
  assertEquals(out.bytes.length, 44);
  assertEquals(view.getUint32(40, true), 0);
  assertEquals(view.getUint32(4, true), 36);
});
