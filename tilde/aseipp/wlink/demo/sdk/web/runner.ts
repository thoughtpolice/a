// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * One run of a linked console package: instantiation, the frame loop's single
 * step, and the trace and summary lines the SDK's runners print.
 *
 * The clock advances a frame period per frame in every mode, so a run is a
 * function of its inputs. A guest that traps is never called again; its
 * partially unwound stack is not something to resume.
 */

import { discoverExports, Exports, GuestExit, GuestTrap } from "./abi.ts";
import { AudioSink, NoAudioSink } from "./audio.ts";
import { Fnv1a } from "./hash.ts";
import { HostState, Identity, makeImports, Sinks } from "./hal.ts";
import { Recorder, ScriptEvent } from "./input.ts";

export type Outcome = "continue" | "stopped" | "exit" | "trap";

export interface RunnerOptions {
  framesPerSecond: number;
  identity: Identity;
  sinks: Sinks;
  audioSink?: AudioSink;
}

/** The bytes or response a module is compiled from. */
export type ModuleSource = Response | Promise<Response> | BufferSource | WebAssembly.Module;

function isResponseLike(source: ModuleSource): source is Response | Promise<Response> {
  return source instanceof Response ||
    (typeof (source as Promise<Response>).then === "function");
}

export class Runner {
  readonly state: HostState;
  private readonly exports: Exports;
  private readonly audioSink: AudioSink;
  private script: readonly ScriptEvent[] = [];
  private cursor = 0;
  private recorder: Recorder | null = null;
  private dead = false;
  /** What a guest trap said, for the message a host prints and shows. */
  trapMessage: string | null = null;

  private constructor(instance: WebAssembly.Instance, state: HostState, options: RunnerOptions) {
    this.state = state;
    this.exports = discoverExports(instance.exports);
    this.audioSink = options.audioSink ?? NoAudioSink;
  }

  /** Compiles and instantiates a package, streaming when handed a response. */
  static async instantiate(source: ModuleSource, options: RunnerOptions): Promise<Runner> {
    const state = new HostState(options.framesPerSecond);
    let resolved: Exports | null = null;
    const imports = makeImports(
      state,
      () => {
        if (!resolved) throw new GuestTrap("the HAL was called before instantiation finished");
        return resolved;
      },
      options.identity,
      options.sinks,
    );

    let instance: WebAssembly.Instance;
    if (source instanceof WebAssembly.Module) {
      instance = await WebAssembly.instantiate(source, imports);
    } else if (isResponseLike(source)) {
      instance = (await WebAssembly.instantiateStreaming(source, imports)).instance;
    } else {
      instance = (await WebAssembly.instantiate(source, imports)).instance;
    }
    const runner = new Runner(instance, state, options);
    resolved = runner.exports;
    return runner;
  }

  /** The events a run replays, delivered frame by frame as they come due. */
  setScript(script: readonly ScriptEvent[]): void {
    this.script = script;
    this.cursor = 0;
  }

  setRecorder(recorder: Recorder | null): void {
    this.recorder = recorder;
  }

  /** Delivers the events scripted before the first frame and runs `init`. */
  start(): Outcome {
    this.queueInput(0);
    return this.guard(() => {
      this.exports.init();
      return "continue" as Outcome;
    });
  }

  private queueInput(frames: number): void {
    this.state.input.beginFrame();
    this.cursor = this.state.input.deliverScript(this.script, this.cursor, frames);
    this.recorder?.frame(frames, this.state.input);
  }

  /** Runs one frame, as the native runner's loop body does. */
  step(): Outcome {
    if (this.dead) return this.state.exitRequested ? "exit" : "trap";
    // The rate the host reports may have been set during init.
    const fps = this.state.framesPerSecond;
    const frames = this.state.frames;
    const nextMs = Math.floor(((frames + 1) * 1000 + fps - 1) / fps);
    const dt = nextMs - Number(this.state.nowMs);
    this.state.nowMs = BigInt(nextMs);
    this.state.frames = frames + 1;
    this.queueInput(frames + 1);
    return this.guard(() => {
      const more = this.exports.frame(dt) !== 0;
      this.exports.endFrame();
      this.state.playAudio(this.audioSink);
      return more ? "continue" : "stopped";
    });
  }

  private guard(body: () => Outcome): Outcome {
    try {
      return body();
    } catch (error) {
      this.dead = true;
      if (error instanceof GuestExit) return "exit";
      this.trapMessage = error instanceof Error ? error.message : String(error);
      return "trap";
    }
  }

  gameMemoryBytes(): number {
    return this.exports.gameMemory.buffer.byteLength;
  }

  platformMemoryBytes(): number {
    return this.exports.platformMemory.buffer.byteLength;
  }

  /** The FNV-1a of the last presented frame, as every SDK host reports it. */
  frameHash(): string {
    const hash = new Fnv1a();
    if (this.state.pixels) hash.update(this.state.pixels);
    return hash.hex();
  }

  /** The line `--trace` prints after every frame that continues. */
  traceLine(): string {
    const state = this.state;
    return `frame=${state.frames} hash=${this.frameHash()} ` +
      `game-memory=${this.gameMemoryBytes()} platform-memory=${this.platformMemoryBytes()} ` +
      `audio=${state.audio.hash.hex()} played=${state.audio.played}`;
  }

  /** The line a headless run prints when it is over. */
  summaryLine(exit: number): string {
    const state = this.state;
    return `summary frames=${state.frames} presents=${state.presentations} ` +
      `width=${state.width} height=${state.height} hash=${this.frameHash()} ` +
      `game-memory=${this.gameMemoryBytes()} platform-memory=${this.platformMemoryBytes()} ` +
      `audio=${state.audio.hash.hex()} played=${state.audio.played} exit=${exit}`;
  }
}
