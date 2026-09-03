// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/** The capture formats the SDK's runners write: a PPM frame and a WAV track. */

import { AUDIO_CHANNELS, AUDIO_RATE } from "./audio.ts";

/** A binary PPM of an RGBA frame, alpha dropped, as `--dump-frame` writes it. */
export function ppm(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const header = new TextEncoder().encode(`P6\n${width} ${height}\n255\n`);
  const out = new Uint8Array(header.length + (rgba.length / 4) * 3);
  out.set(header);
  let at = header.length;
  for (let i = 0; i < rgba.length; i += 4) {
    out[at++] = rgba[i];
    out[at++] = rgba[i + 1];
    out[at++] = rgba[i + 2];
  }
  return out;
}

/** A file the writer can go back to, so the RIFF sizes can be filled in at the end. */
export interface SeekableOutput {
  writeSync(bytes: Uint8Array): void;
  seekSync(offset: number): void;
  close(): void;
}

const SILENCE = new Uint8Array(4096);

/** A 44100 Hz stereo 16-bit RIFF/WAVE file whose sizes are patched at close. */
export class WavWriter {
  private readonly out: SeekableOutput;
  private frames = 0;

  constructor(out: SeekableOutput) {
    this.out = out;
    const header = new Uint8Array(44);
    const view = new DataView(header.buffer);
    const ascii = (at: number, text: string) => {
      for (let i = 0; i < text.length; i++) header[at + i] = text.charCodeAt(i);
    };
    ascii(0, "RIFF");
    ascii(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, AUDIO_CHANNELS, true);
    view.setUint32(24, AUDIO_RATE, true);
    view.setUint32(28, AUDIO_RATE * AUDIO_CHANNELS * 2, true);
    view.setUint16(32, AUDIO_CHANNELS * 2, true);
    view.setUint16(34, 16, true);
    ascii(36, "data");
    this.out.writeSync(header);
  }

  samples(values: Int16Array): void {
    if (values.length === 0) return;
    const bytes = new Uint8Array(values.length * 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < values.length; i++) view.setInt16(i * 2, values[i], true);
    this.out.writeSync(bytes);
    this.frames += values.length / AUDIO_CHANNELS;
  }

  silence(frames: number): void {
    let left = frames * AUDIO_CHANNELS * 2;
    while (left > 0) {
      const chunk = Math.min(left, SILENCE.length);
      this.out.writeSync(SILENCE.subarray(0, chunk));
      left -= chunk;
    }
    this.frames += frames;
  }

  close(): void {
    const data = this.frames * AUDIO_CHANNELS * 2;
    const size = new Uint8Array(4);
    const view = new DataView(size.buffer);
    this.out.seekSync(4);
    view.setUint32(0, 36 + data, true);
    this.out.writeSync(size);
    this.out.seekSync(40);
    view.setUint32(0, data, true);
    this.out.writeSync(size);
    this.out.close();
  }
}
