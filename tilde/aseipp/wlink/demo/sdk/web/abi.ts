// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The raw core ABI of a package linked by wlink against the console SDK.
 *
 * The linked module imports the thirty flat functions of
 * `console:hal/raw@0.1.0` and exports, besides the game's entry points, the
 * memory and allocator each import must use for its canonical buffers. This
 * module resolves those exports and gives the HAL implementation bounds-checked
 * access to them.
 */

export const HAL_MODULE = "console:hal/raw@0.1.0";

/** The imports that take or return a pointer, and so name a memory. */
export const MEMORY_IMPORTS: readonly string[] = [
  "arg",
  "audio-write",
  "file-create-directory",
  "file-list-directory",
  "file-open",
  "file-read-at",
  "file-remove",
  "file-rename",
  "file-write-at",
  "host-name",
  "present",
  "present-indexed",
  "read-events",
  "read-mouse",
  "read-text",
  "set-title",
  "write-log",
];

/** The imports that return a buffer, and so name an allocator. */
export const REALLOC_IMPORTS: readonly string[] = [
  "arg",
  "file-list-directory",
  "file-read-at",
  "host-name",
  "read-events",
  "read-text",
];

/** What the guest's own traps become: the run is over for that instance. */
export class GuestTrap extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuestTrap";
  }
}

/** Thrown out of the `exit` import, which must not return to the guest. */
export class GuestExit extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`exit ${code}`);
    this.name = "GuestExit";
    this.code = code;
  }
}

const OUT_OF_BOUNDS = "out of bounds memory access";

/**
 * A guest memory with views that survive growth. Growing a memory detaches the
 * previous `ArrayBuffer`, so every view is rebuilt whenever the buffer's
 * identity changes; a view taken before an allocation is never reused after it.
 */
export class Mem {
  readonly memory: WebAssembly.Memory;
  private buffer: ArrayBuffer;
  private bytes: Uint8Array;
  private words: DataView;

  constructor(memory: WebAssembly.Memory) {
    this.memory = memory;
    this.buffer = memory.buffer;
    this.bytes = new Uint8Array(this.buffer);
    this.words = new DataView(this.buffer);
  }

  private refresh(): void {
    if (this.buffer !== this.memory.buffer) {
      this.buffer = this.memory.buffer;
      this.bytes = new Uint8Array(this.buffer);
      this.words = new DataView(this.buffer);
    }
  }

  view(): Uint8Array {
    this.refresh();
    return this.bytes;
  }

  data(): DataView {
    this.refresh();
    return this.words;
  }

  byteLength(): number {
    this.refresh();
    return this.bytes.length;
  }

  /** The `len` bytes at `ptr`, or the trap a native host raises for a range outside the memory. */
  range(ptr: number, len: number): Uint8Array {
    const start = ptr >>> 0;
    const length = len >>> 0;
    const bytes = this.view();
    if (start + length > bytes.length) throw new GuestTrap(OUT_OF_BOUNDS);
    return bytes.subarray(start, start + length);
  }

  /**
   * Like {@link range}, for a length computed from a guest argument rather
   * than passed as one: it must not wrap to a smaller span.
   */
  span(ptr: number, byteLength: number): Uint8Array {
    const start = ptr >>> 0;
    const bytes = this.view();
    if (byteLength < 0 || start + byteLength > bytes.length) throw new GuestTrap(OUT_OF_BOUNDS);
    return bytes.subarray(start, start + byteLength);
  }

  store32(ptr: number, value: number): void {
    const at = ptr >>> 0;
    if (at + 4 > this.byteLength()) throw new GuestTrap(OUT_OF_BOUNDS);
    this.data().setUint32(at, value >>> 0, true);
  }

  store64(ptr: number, value: bigint): void {
    const at = ptr >>> 0;
    if (at + 8 > this.byteLength()) throw new GuestTrap(OUT_OF_BOUNDS);
    this.data().setBigUint64(at, BigInt.asUintN(64, value), true);
  }

  storeU8(ptr: number, value: number): void {
    const at = ptr >>> 0;
    const bytes = this.view();
    if (at + 1 > bytes.length) throw new GuestTrap(OUT_OF_BOUNDS);
    bytes[at] = value & 0xff;
  }

  fill0(ptr: number, len: number): void {
    this.range(ptr, len).fill(0);
  }

  write(ptr: number, source: Uint8Array): void {
    this.range(ptr, source.length).set(source);
  }
}

type Realloc = (old: number, oldLen: number, align: number, len: number) => number;

/** One import's canonical memory and allocator. */
export class Binding {
  readonly name: string;
  readonly mem: Mem;
  private readonly realloc: Realloc | undefined;

  constructor(name: string, mem: Mem, realloc: Realloc | undefined) {
    this.name = name;
    this.mem = mem;
    this.realloc = realloc;
  }

  /**
   * A fresh allocation through the guest's own allocator. An empty result is
   * the aligned dangling pointer the generated bindings expect, allocated from
   * nothing; any view taken before this call is stale afterwards.
   */
  alloc(align: number, len: number): number {
    if (len === 0) return align;
    if (!this.realloc) {
      throw new GuestTrap(`${this.name} has no realloc to allocate its result with`);
    }
    const ptr = this.realloc(0, 0, align, len) >>> 0;
    if (ptr === 0) throw new GuestTrap("allocation failed");
    return ptr;
  }
}

export interface Exports {
  init(): void;
  frame(dtMs: number): number;
  endFrame(): void;
  readonly platformMemory: WebAssembly.Memory;
  readonly gameMemory: WebAssembly.Memory;
  binding(name: string): Binding;
}

function fail(message: string): never {
  throw new Error(message);
}

/** Resolves the linked module's entry points and every import's binding. */
export function discoverExports(exports: WebAssembly.Exports): Exports {
  const fn = (name: string): (...args: number[]) => number | void => {
    const value = exports[name];
    if (typeof value !== "function") fail(`the module does not export a function ${name}`);
    return value as (...args: number[]) => number | void;
  };
  const memory = (name: string): WebAssembly.Memory => {
    const value = exports[name];
    if (!(value instanceof WebAssembly.Memory)) {
      fail(`the module does not export a memory ${name}`);
    }
    return value;
  };

  const init = fn("init");
  const frame = fn("frame");
  const endFrame = fn("end-frame");
  const platformMemory = memory("platform:memory");
  const gameMemory = memory("game:memory");

  // One Mem per distinct memory: the seventeen buffer-taking imports all name
  // the platform's, and sharing the object keeps their views in step.
  const memories = new Map<WebAssembly.Memory, Mem>();
  const wrap = (value: WebAssembly.Memory): Mem => {
    let mem = memories.get(value);
    if (!mem) {
      mem = new Mem(value);
      memories.set(value, mem);
    }
    return mem;
  };

  const bindings = new Map<string, Binding>();
  for (const name of MEMORY_IMPORTS) {
    const prefix = `wlink:import:${HAL_MODULE}#${name}`;
    const mem = wrap(memory(`${prefix}:memory`));
    let realloc: Realloc | undefined;
    if (REALLOC_IMPORTS.includes(name)) {
      realloc = fn(`${prefix}:realloc`) as Realloc;
    }
    bindings.set(name, new Binding(name, mem, realloc));
  }

  return {
    init: init as () => void,
    frame: frame as (dtMs: number) => number,
    endFrame: endFrame as () => void,
    platformMemory,
    gameMemory,
    binding(name: string): Binding {
      const binding = bindings.get(name);
      if (!binding) fail(`the module does not bind a memory for ${name}`);
      return binding;
    },
  };
}
