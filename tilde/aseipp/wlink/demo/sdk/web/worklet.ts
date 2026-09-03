// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The audio device's end of the queue.
 *
 * The frame loop drains the guest's queue in bursts of a frame period; the
 * device asks for a small block on its own thread at its own rate. All this
 * does is move frames between the two through {@link SinkBuffer}. It never
 * reports back into the guest's queue, so what the game sees queued is what
 * the native runner would have shown it.
 */

import { SinkBuffer } from "./sink_buffer.ts";

// The AudioWorklet globals are in no TypeScript lib.
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(
  name: string,
  processor: typeof AudioWorkletProcessor,
): void;
declare const sampleRate: number;

const STATS_EVERY = 64;

class ConsoleSink extends AudioWorkletProcessor {
  private readonly buffer = new SinkBuffer();
  private blocks = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data;
      if (data instanceof ArrayBuffer) {
        this.buffer.push(new Int16Array(data));
        return;
      }
      if (data && data.type === "config") this.buffer.configure(data.prime ?? 0);
      else if (data && data.type === "clear") this.buffer.clear();
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const left = output[0];
    const right = output.length > 1 ? output[1] : output[0];
    this.buffer.render(left, right, sampleRate);
    if (output.length > 2) {
      for (let channel = 2; channel < output.length; channel++) output[channel].fill(0);
    }
    if (++this.blocks % STATS_EVERY === 0) {
      this.port.postMessage({
        type: "stats",
        queued: this.buffer.queued,
        underruns: this.buffer.underruns,
        dropped: this.buffer.dropped,
      });
    }
    return true;
  }
}

registerProcessor("console-sink", ConsoleSink);
