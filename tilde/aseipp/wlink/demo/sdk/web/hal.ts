// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `console:hal/raw@0.1.0`, the thirty flat functions a linked console package
 * imports, implemented the way the SDK's native runner implements them.
 *
 * Every returned buffer is allocated with the importing function's own
 * allocator and written to its own memory; an allocation may grow that memory,
 * so no view survives one. Guest arguments are normalised to unsigned before
 * use and a range outside the memory raises the trap a native host raises.
 */

import { AudioQueue, AudioSink } from "./audio.ts";
import { Exports, GuestExit, GuestTrap } from "./abi.ts";
import { bindRaw, type Guest, type Raw, RAW_MODULE } from "./hal_bindings.ts";
import { InputState } from "./input.ts";
import { Vfs } from "./files.ts";

const decoder = new TextDecoder();

/** What a host says about itself: the browser and the CLI differ only here. */
export interface Identity {
  /** What `system.info` reports: `headless`, `web`, ... */
  readonly name: string;
  unixSeconds(): bigint;
  randomSeed(): bigint;
  /** The bits of `console:sdk/system.features`. */
  features(): number;
  /** The bits of `console:sdk/input.capability`. */
  capabilities(): number;
}

/** Where the HAL's side effects go, which is all the host has to supply. */
export interface Sinks {
  log(level: number, text: string): void;
  setTitle(text: string): void;
  /** Returns whether the pointer is captured now, as the guest reads it. */
  capturePointer(captured: boolean): number;
}

export const SILENT_SINKS: Sinks = {
  log(): void {},
  setTitle(): void {},
  capturePointer(): number {
    return 0;
  },
};

/** The console's hardware, as the HAL reads and writes it. */
export class HostState {
  framesPerSecond: number;
  frames = 0;
  nowMs = 0n;
  readonly vfs = new Vfs();
  readonly input = new InputState();
  readonly audio = new AudioQueue();
  args: string[] = [];

  /** The last presented frame, expanded to RGBA. */
  pixels: Uint8Array | null = null;
  width = 0;
  height = 0;
  presentations = 0;
  /** Set on every present, cleared by a renderer that has taken the frame. */
  frameDirty = false;

  exitRequested = false;
  exitCode = 0;

  constructor(framesPerSecond: number) {
    this.framesPerSecond = framesPerSecond;
  }

  /** Plays the frame period that has come due, as every SDK host does. */
  playAudio(sink: AudioSink): void {
    this.audio.play(this.frames, this.framesPerSecond, sink);
  }
}

/**
 * The import object a linked console package instantiates against. The exports
 * are resolved lazily because an import may be called before the instance that
 * provides its memory and allocator exists.
 */
export function makeImports(
  state: HostState,
  exports: () => Exports,
  identity: Identity,
  sinks: Sinks,
): WebAssembly.Imports {
  const guest: Guest = {
    binding: (_module, name) => exports().binding(name),
    trap: (message) => new GuestTrap(message),
  };

  const raw: Raw = {
    writeLog(level, message) {
      sinks.log(level, decoder.decode(message));
    },

    present(width, height, rgba) {
      if (width === 0 || height === 0 || width * height * 4 !== rgba.length) {
        throw new GuestTrap("out of bounds memory access");
      }
      state.pixels = rgba.slice();
      state.width = width;
      state.height = height;
      state.presentations++;
      state.frameDirty = true;
    },

    presentIndexed(width, height, indexed, palette) {
      const size = indexed.length;
      if (
        width === 0 || height === 0 || width * height !== size ||
        palette.length !== 256
      ) {
        throw new GuestTrap("out of bounds memory access");
      }
      // The palette entries hold the bytes of an RGBA8 pixel in memory order,
      // so expanding through 32-bit words moves each pixel in one store.
      const rgba = new Uint8Array(size * 4);
      const out = new Uint32Array(rgba.buffer);
      for (let i = 0; i < size; i++) out[i] = palette[indexed[i]];
      state.pixels = rgba;
      state.width = width;
      state.height = height;
      state.presentations++;
      state.frameDirty = true;
    },

    framesPerSecond: () => state.framesPerSecond,

    setFrameRate(hz) {
      if (state.frames === 0 && hz >= 1 && hz <= 1000) {
        state.framesPerSecond = hz;
      }
      return state.framesPerSecond;
    },

    unixSeconds: () => identity.unixSeconds(),
    randomSeed: () => identity.randomSeed(),
    hostName: () => identity.name,
    hostFeatures: () => identity.features(),

    setTitle(title) {
      sinks.setTitle(decoder.decode(title));
    },

    readEvents: () => state.input.takeEvents(),
    inputCapabilities: () => identity.capabilities(),
    readMouse: () => state.input.readMouse(),
    capturePointer: (captured) => sinks.capturePointer(captured !== 0),
    readText: () => state.input.takeText(),
    nowMs: () => state.nowMs,

    audioWrite(samples) {
      const bytes = new Uint8Array(
        samples.buffer,
        samples.byteOffset,
        samples.byteLength,
      );
      return state.audio.write(bytes, samples.length);
    },

    audioQueued: () => state.audio.queued(),
    fileOpen: (path, write) => state.vfs.open(path, write),

    fileSize(fd) {
      const size = state.vfs.size(fd);
      return size < 0 ? -1n : BigInt(size);
    },

    fileReadAt(fd, offset, length) {
      const read = state.vfs.readAt(fd, offset, length);
      return { status: read.status, data: read.data };
    },

    fileWriteAt: (fd, offset, data) => state.vfs.writeAt(fd, offset, data),

    fileClose(fd) {
      state.vfs.close(fd);
    },

    fileListDirectory(path) {
      const entries = state.vfs.listDirectory(path);
      return {
        status: entries === null ? -1 : 0,
        entries: (entries ?? []).map((entry) => ({
          name: entry.name,
          size: BigInt(entry.size),
          directory: entry.directory,
        })),
      };
    },

    fileRemove: (path) => state.vfs.remove(path),
    fileRename: (path, to) => state.vfs.rename(path.slice(), to),
    fileCreateDirectory: (path) => state.vfs.createDirectory(path),
    argCount: () => state.args.length,
    arg: (index) => state.args[index] ?? "",

    exit(code) {
      state.exitRequested = true;
      state.exitCode = code;
      throw new GuestExit(code);
    },
  };

  return { [RAW_MODULE]: bindRaw(raw, guest) };
}
