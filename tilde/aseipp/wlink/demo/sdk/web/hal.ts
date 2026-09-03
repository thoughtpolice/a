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
import { Binding, Exports, GuestExit, GuestTrap, HAL_MODULE } from "./abi.ts";
import { InputState } from "./input.ts";
import { Vfs } from "./files.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

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

type Imports = Record<string, WebAssembly.ImportValue>;

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
  const bind = (name: string): Binding => exports().binding(name);

  const raw: Imports = {
    "write-log": (level: number, ptr: number, len: number): void => {
      const mem = bind("write-log").mem;
      sinks.log(level >>> 0, decoder.decode(mem.range(ptr, len)));
    },

    "present": (
      width: number,
      height: number,
      ptr: number,
      len: number,
    ): void => {
      const w = width >>> 0;
      const h = height >>> 0;
      const size = len >>> 0;
      if (w === 0 || h === 0 || w * h * 4 !== size) {
        throw new GuestTrap("out of bounds memory access");
      }
      const pixels = bind("present").mem.span(ptr, size);
      state.pixels = pixels.slice();
      state.width = w;
      state.height = h;
      state.presentations++;
      state.frameDirty = true;
    },

    "present-indexed": (
      width: number,
      height: number,
      ptr: number,
      len: number,
      palettePtr: number,
      paletteLen: number,
    ): void => {
      const w = width >>> 0;
      const h = height >>> 0;
      const size = len >>> 0;
      if (w === 0 || h === 0 || w * h !== size || (paletteLen >>> 0) !== 256) {
        throw new GuestTrap("out of bounds memory access");
      }
      const mem = bind("present-indexed").mem;
      const indexed = mem.span(ptr, size);
      const paletteBytes = mem.span(palettePtr, 256 * 4);
      // The palette entries hold the bytes of an RGBA8 pixel in memory order,
      // so expanding through 32-bit words moves each pixel in one store.
      const palette = new Uint32Array(256);
      const words = new DataView(
        paletteBytes.buffer,
        paletteBytes.byteOffset,
        paletteBytes.byteLength,
      );
      for (let i = 0; i < 256; i++) palette[i] = words.getUint32(i * 4, true);
      const rgba = new Uint8Array(size * 4);
      const out = new Uint32Array(rgba.buffer);
      for (let i = 0; i < size; i++) out[i] = palette[indexed[i]];
      state.pixels = rgba;
      state.width = w;
      state.height = h;
      state.presentations++;
      state.frameDirty = true;
    },

    "frames-per-second": (): number => state.framesPerSecond,

    "set-frame-rate": (hz: number): number => {
      const rate = hz >>> 0;
      if (state.frames === 0 && rate >= 1 && rate <= 1000) {
        state.framesPerSecond = rate;
      }
      return state.framesPerSecond;
    },

    "unix-seconds": (): bigint => BigInt.asIntN(64, identity.unixSeconds()),
    "random-seed": (): bigint => BigInt.asUintN(64, identity.randomSeed()),

    "host-name": (result: number): void => {
      const binding = bind("host-name");
      const name = encoder.encode(identity.name);
      const ptr = binding.alloc(1, name.length);
      binding.mem.write(ptr, name);
      binding.mem.store32(result, ptr);
      binding.mem.store32(result + 4, name.length);
    },

    "host-features": (): number => identity.features(),

    "set-title": (ptr: number, len: number): void => {
      sinks.setTitle(decoder.decode(bind("set-title").mem.range(ptr, len)));
    },

    "read-events": (result: number): void => {
      const binding = bind("read-events");
      const events = state.input.takeEvents();
      const stride = 8;
      const ptr = binding.alloc(4, events.length * stride);
      const mem = binding.mem;
      if (events.length > 0) mem.fill0(ptr, events.length * stride);
      for (let i = 0; i < events.length; i++) {
        mem.store32(ptr + stride * i, events[i].key);
        mem.storeU8(ptr + stride * i + 4, events[i].pressed ? 1 : 0);
      }
      mem.store32(result, ptr);
      mem.store32(result + 4, events.length);
    },

    "input-capabilities": (): number => identity.capabilities(),

    "read-mouse": (result: number): void => {
      const mem = bind("read-mouse").mem;
      const mouse = state.input.readMouse();
      const fields = [
        mouse.x,
        mouse.y,
        mouse.dx,
        mouse.dy,
        mouse.buttons,
        mouse.wheel,
      ];
      for (let i = 0; i < fields.length; i++) {
        mem.store32(result + 4 * i, fields[i]);
      }
    },

    "capture-pointer": (captured: number): number =>
      sinks.capturePointer((captured >>> 0) !== 0),

    "read-text": (result: number): void => {
      const binding = bind("read-text");
      const text = state.input.takeText();
      const ptr = binding.alloc(1, text.length);
      binding.mem.write(ptr, text);
      binding.mem.store32(result, ptr);
      binding.mem.store32(result + 4, text.length);
    },

    "now-ms": (): bigint => BigInt.asUintN(64, state.nowMs),

    "audio-write": (ptr: number, len: number): number => {
      const samples = len >>> 0;
      const bytes = bind("audio-write").mem.span(ptr, samples * 2);
      return state.audio.write(bytes, samples);
    },

    "audio-queued": (): number => state.audio.queued(),

    "file-open": (ptr: number, len: number, write: number): number => {
      const path = bind("file-open").mem.range(ptr, len);
      return state.vfs.open(path, (write >>> 0) !== 0);
    },

    "file-size": (fd: number): bigint => {
      const size = state.vfs.size(fd >>> 0);
      return size < 0 ? 0xffffffffffffffffn : BigInt(size);
    },

    "file-read-at": (
      fd: number,
      offset: bigint,
      length: number,
      result: number,
    ): void => {
      const binding = bind("file-read-at");
      const read = state.vfs.readAt(
        fd >>> 0,
        BigInt.asUintN(64, offset),
        length >>> 0,
      );
      const data = read.data.slice();
      const ptr = binding.alloc(1, data.length);
      const mem = binding.mem;
      mem.write(ptr, data);
      mem.store32(result, read.status);
      mem.store32(result + 4, ptr);
      mem.store32(result + 8, data.length);
    },

    "file-write-at": (
      fd: number,
      offset: bigint,
      ptr: number,
      len: number,
    ): number => {
      const data = bind("file-write-at").mem.range(ptr, len);
      return state.vfs.writeAt(fd >>> 0, BigInt.asUintN(64, offset), data);
    },

    "file-close": (fd: number): void => {
      state.vfs.close(fd >>> 0);
    },

    "file-list-directory": (ptr: number, len: number, result: number): void => {
      const binding = bind("file-list-directory");
      const path = binding.mem.range(ptr, len).slice();
      const entries = state.vfs.listDirectory(path);
      const listing = entries ?? [];
      const stride = 24;
      const list = binding.alloc(8, listing.length * stride);
      const mem = binding.mem;
      if (listing.length > 0) mem.fill0(list, listing.length * stride);
      for (let i = 0; i < listing.length; i++) {
        const name = encoder.encode(listing[i].name);
        const text = binding.alloc(1, name.length);
        mem.write(text, name);
        const at = list + i * stride;
        mem.store32(at, text);
        mem.store32(at + 4, name.length);
        mem.store64(at + 8, BigInt(listing[i].size));
        mem.storeU8(at + 16, listing[i].directory ? 1 : 0);
      }
      mem.store32(result, entries === null ? -1 : 0);
      mem.store32(result + 4, list);
      mem.store32(result + 8, listing.length);
    },

    "file-remove": (ptr: number, len: number): number =>
      state.vfs.remove(bind("file-remove").mem.range(ptr, len)),

    "file-rename": (
      ptr: number,
      len: number,
      toPtr: number,
      toLen: number,
    ): number => {
      const mem = bind("file-rename").mem;
      const from = mem.range(ptr, len).slice();
      const to = mem.range(toPtr, toLen);
      return state.vfs.rename(from, to);
    },

    "file-create-directory": (ptr: number, len: number): number =>
      state.vfs.createDirectory(
        bind("file-create-directory").mem.range(ptr, len),
      ),

    "arg-count": (): number => state.args.length,

    "arg": (index: number, result: number): void => {
      const binding = bind("arg");
      const value = state.args[index >>> 0] ?? "";
      const bytes = encoder.encode(value);
      const ptr = binding.alloc(1, bytes.length);
      binding.mem.write(ptr, bytes);
      binding.mem.store32(result, ptr);
      binding.mem.store32(result + 4, bytes.length);
    },

    "exit": (code: number): void => {
      state.exitRequested = true;
      state.exitCode = code | 0;
      throw new GuestExit(code | 0);
    },
  };

  return { [HAL_MODULE]: raw };
}
