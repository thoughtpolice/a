// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The guest's audio queue and the frame-paced playback every SDK host does.
 *
 * The queue holds a second of 44100 Hz stereo frames. After every frame the
 * host plays the frame period's worth that has come due: what is queued goes
 * through the hash and on to the sink, and the rest of the period is silence.
 * Playing on the frame clock rather than the wall clock is what makes a run a
 * function of its inputs.
 */

import { Fnv1a } from "./hash.ts";

export const AUDIO_RATE = 44100;
export const AUDIO_CHANNELS = 2;
export const AUDIO_CAPACITY = AUDIO_RATE;

/** Where played frames go besides the hash. */
export interface AudioSink {
  /** Interleaved frames drained from the queue; the callee may take ownership. */
  chunk(samples: Int16Array): void;
  /** The rest of the frame period, which no host ever hashes. */
  silence(frames: number): void;
}

export const NoAudioSink: AudioSink = {
  chunk(): void {},
  silence(): void {},
};

export class AudioQueue {
  private readonly ring = new Int16Array(AUDIO_CAPACITY * AUDIO_CHANNELS);
  private start = 0;
  private count = 0;
  private head = 0;
  readonly hash = new Fnv1a();
  played = 0;

  /**
   * Appends interleaved samples, taking whole frames only and no more than the
   * room left; returns the frames accepted.
   */
  write(bytes: Uint8Array, samples: number): number {
    const room = AUDIO_CAPACITY - this.count;
    const frames = Math.min(Math.floor(samples / AUDIO_CHANNELS), room);
    const base = (this.start + this.count) * AUDIO_CHANNELS;
    const total = AUDIO_CAPACITY * AUDIO_CHANNELS;
    for (let i = 0; i < frames * AUDIO_CHANNELS; i++) {
      this.ring[(base + i) % total] =
        (bytes[2 * i] | (bytes[2 * i + 1] << 8)) << 16 >> 16;
    }
    this.count += frames;
    return frames;
  }

  queued(): number {
    return this.count;
  }

  /** Plays what the frame period since the last call covers. */
  play(frames: number, framesPerSecond: number, sink: AudioSink): void {
    const target = Math.floor((frames * AUDIO_RATE) / framesPerSecond);
    const due = target - this.head;
    this.head = target;
    const played = Math.min(due, this.count);
    const samples = new Int16Array(played * AUDIO_CHANNELS);
    const total = AUDIO_CAPACITY * AUDIO_CHANNELS;
    const base = this.start * AUDIO_CHANNELS;
    for (let i = 0; i < samples.length; i++) {
      const sample = this.ring[(base + i) % total];
      samples[i] = sample;
      this.hash.byte(sample & 0xff);
      this.hash.byte((sample >> 8) & 0xff);
    }
    this.start = (this.start + played) % AUDIO_CAPACITY;
    this.count -= played;
    this.played += played;
    sink.chunk(samples);
    sink.silence(due - played);
  }
}
