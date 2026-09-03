// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The jitter buffer between the frame loop and a real audio device.
 *
 * The host queue is played on the frame clock, in bursts of a frame period; an
 * audio device asks for a fixed block whenever it likes, at a rate that is
 * often not 44100 Hz. This ring absorbs the difference. It holds no DOM types,
 * so the behaviour that matters is testable without an audio device.
 */

import { AUDIO_CHANNELS, AUDIO_RATE } from "./audio.ts";

export const DEFAULT_CAPACITY = 16384;

export class SinkBuffer {
  private readonly ring: Int16Array;
  private readonly capacity: number;
  private start = 0;
  private count = 0;
  /** Frames to collect before output starts, and again after an underrun. */
  private prime = 0;
  private priming = true;
  /** The fractional read position inside the frame at the head, when resampling. */
  private phase = 0;

  underruns = 0;
  dropped = 0;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity = capacity;
    this.ring = new Int16Array(capacity * AUDIO_CHANNELS);
  }

  /** How many frames to buffer before starting; a couple of game frames is enough. */
  configure(prime: number): void {
    this.prime = Math.max(0, Math.min(prime, this.capacity));
  }

  get queued(): number {
    return this.count;
  }

  clear(): void {
    this.start = 0;
    this.count = 0;
    this.phase = 0;
    this.priming = true;
  }

  /**
   * Adds one drained chunk. A chunk that does not fit whole is dropped whole,
   * as the native host's pipe drops what the player cannot take.
   */
  push(samples: Int16Array): boolean {
    const frames = Math.floor(samples.length / AUDIO_CHANNELS);
    if (frames === 0) return true;
    if (frames > this.capacity - this.count) {
      this.dropped += frames;
      return false;
    }
    const total = this.capacity * AUDIO_CHANNELS;
    const base = (this.start + this.count) * AUDIO_CHANNELS;
    for (let i = 0; i < frames * AUDIO_CHANNELS; i++) {
      this.ring[(base + i) % total] = samples[i];
    }
    this.count += frames;
    return true;
  }

  private frame(index: number): [number, number] {
    const total = this.capacity * AUDIO_CHANNELS;
    const at = ((this.start + index) * AUDIO_CHANNELS) % total;
    return [this.ring[at], this.ring[(at + 1) % total]];
  }

  private advance(frames: number): void {
    this.start = (this.start + frames) % this.capacity;
    this.count -= frames;
  }

  /**
   * Fills one device block. `rate` is the device's sample rate; the queue is
   * always 44100 Hz, so anything else is resampled linearly.
   */
  render(left: Float32Array, right: Float32Array, rate: number): void {
    const step = AUDIO_RATE / rate;
    if (this.priming) {
      if (this.count < this.prime || this.count === 0) {
        left.fill(0);
        right.fill(0);
        return;
      }
      this.priming = false;
    }
    for (let i = 0; i < left.length; i++) {
      // One source frame is needed for a whole-rate device, two to interpolate
      // between; an empty queue is silence and starts priming again.
      const needed = step === 1 ? 1 : 2;
      if (this.count < needed) {
        for (let j = i; j < left.length; j++) {
          left[j] = 0;
          right[j] = 0;
        }
        this.underruns++;
        this.priming = true;
        this.phase = 0;
        return;
      }
      if (step === 1) {
        const [l, r] = this.frame(0);
        left[i] = l / 32768;
        right[i] = r / 32768;
        this.advance(1);
        continue;
      }
      const [l0, r0] = this.frame(0);
      const [l1, r1] = this.frame(1);
      left[i] = (l0 + (l1 - l0) * this.phase) / 32768;
      right[i] = (r0 + (r1 - r0) * this.phase) / 32768;
      this.phase += step;
      const whole = Math.floor(this.phase);
      if (whole > 0) {
        const take = Math.min(whole, this.count - 1);
        this.advance(take);
        this.phase -= take;
      }
    }
  }
}
