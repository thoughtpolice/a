// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A hand-assembled stand-in for a linked console package.
 *
 * The unit tests need a module that presents the SDK's export surface -- two
 * memories, the seventeen aliases, the six allocators and the three entry
 * points -- without building a real game. Assembling the bytes here keeps the
 * tests on the same instantiation path a real package takes, `discoverExports`
 * included, and lets a test choose what `init` and `frame` do.
 */

import { HAL_MODULE, MEMORY_IMPORTS, REALLOC_IMPORTS } from "./abi.ts";

export type FrameBody = "more" | "stop" | "trap" | "exit7";
export type InitBody = "none" | "set-rate-70";

export interface FixtureSpec {
  init?: InitBody;
  frame?: FrameBody;
  /** Grow the platform memory on every allocation, so stale views are caught. */
  growOnAlloc?: boolean;
  /** Where the bump allocator starts handing out memory. */
  heap?: number;
}

function uleb(value: number): number[] {
  const out: number[] = [];
  let rest = value >>> 0;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest !== 0) byte |= 0x80;
    out.push(byte);
  } while (rest !== 0);
  return out;
}

function sleb(value: number): number[] {
  const out: number[] = [];
  let more = true;
  let rest = value | 0;
  while (more) {
    const byte = rest & 0x7f;
    rest >>= 7;
    if (
      (rest === 0 && (byte & 0x40) === 0) ||
      (rest === -1 && (byte & 0x40) !== 0)
    ) more = false;
    out.push(more ? byte | 0x80 : byte);
  }
  return out;
}

function name(text: string): number[] {
  const bytes = [...new TextEncoder().encode(text)];
  return [...uleb(bytes.length), ...bytes];
}

function vec(items: number[][]): number[] {
  return [...uleb(items.length), ...items.flat()];
}

function section(id: number, body: number[]): number[] {
  return [id, ...uleb(body.length), ...body];
}

const I32 = 0x7f;
const END = 0x0b;

/** The bytes of a module with the export surface `wlink` gives a linked package. */
export function fixtureModule(spec: FixtureSpec = {}): Uint8Array<ArrayBuffer> {
  const heap = spec.heap ?? 1024;
  const types = [
    [0x60, 0x00, 0x00], // () -> ()
    [0x60, 0x01, I32, 0x01, I32], // (i32) -> i32
    [0x60, 0x04, I32, I32, I32, I32, 0x01, I32], // realloc
    [0x60, 0x01, I32, 0x00], // (i32) -> ()
  ];

  // Import 0 is `exit` and import 1 is `set-frame-rate`, so a body that calls
  // either names a function index below the defined ones.
  const imports = [
    [...name(HAL_MODULE), ...name("exit"), 0x00, 3],
    [...name(HAL_MODULE), ...name("set-frame-rate"), 0x00, 1],
  ];

  const realloc: number[] = [
    ...(spec.growOnAlloc ? [0x41, ...sleb(1), 0x40, 0x00, 0x1a] : []),
    0x23,
    0x00, // global.get 0
    0x20,
    0x02, // local.get align
    0x6a, // i32.add
    0x41,
    ...sleb(1),
    0x6b, // i32.sub
    0x20,
    0x02,
    0x41,
    ...sleb(1),
    0x6b,
    0x41,
    ...sleb(-1),
    0x73, // i32.xor: ~(align - 1)
    0x71, // i32.and
    0x22,
    0x04, // local.tee 4
    0x20,
    0x03, // local.get len
    0x6a,
    0x24,
    0x00, // global.set 0
    0x20,
    0x04,
    END,
  ];
  const reallocCode = [0x01, 0x01, I32, ...realloc];

  const initBody = spec.init === "set-rate-70"
    ? [0x41, ...sleb(70), 0x10, 0x01, 0x1a, END]
    : [END];
  const frameBody = {
    more: [0x41, ...sleb(1), END],
    stop: [0x41, ...sleb(0), END],
    trap: [0x00, END],
    exit7: [0x41, ...sleb(7), 0x10, 0x00, 0x41, ...sleb(1), END],
  }[spec.frame ?? "more"];

  const bodies = [reallocCode, [0x00, ...initBody], [0x00, ...frameBody], [
    0x00,
    END,
  ]];

  const exports: number[][] = [
    [...name("init"), 0x00, ...uleb(3)],
    [...name("frame"), 0x00, ...uleb(4)],
    [...name("end-frame"), 0x00, ...uleb(5)],
    [...name("platform:memory"), 0x02, ...uleb(0)],
    [...name("game:memory"), 0x02, ...uleb(1)],
  ];
  for (const fn of MEMORY_IMPORTS) {
    exports.push([
      ...name(`wlink:import:${HAL_MODULE}#${fn}:memory`),
      0x02,
      ...uleb(0),
    ]);
  }
  for (const fn of REALLOC_IMPORTS) {
    exports.push([
      ...name(`wlink:import:${HAL_MODULE}#${fn}:realloc`),
      0x00,
      ...uleb(2),
    ]);
  }

  return new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...section(1, vec(types)),
    ...section(2, vec(imports)),
    ...section(3, vec([[2], [0], [1], [0]])),
    // Two memories of one page: the platform's, which every alias names, and
    // the game's.
    ...section(5, vec([[0x00, 0x01], [0x00, 0x01]])),
    ...section(6, vec([[I32, 0x01, 0x41, ...sleb(heap), END]])),
    ...section(7, vec(exports)),
    ...section(10, vec(bodies.map((body) => [...uleb(body.length), ...body]))),
  ]);
}

/** A record shaped like a linked package's exports, without any wasm at all. */
export function fakeExports(
  overrides: Record<string, WebAssembly.ExportValue> = {},
): WebAssembly.Exports {
  const platform = new WebAssembly.Memory({ initial: 1 });
  const game = new WebAssembly.Memory({ initial: 1 });
  const noop = () => {};
  const exports: Record<string, WebAssembly.ExportValue> = {
    "init": noop,
    "frame": () => 1,
    "end-frame": noop,
    "platform:memory": platform,
    "game:memory": game,
  };
  for (const fn of MEMORY_IMPORTS) {
    exports[`wlink:import:${HAL_MODULE}#${fn}:memory`] = platform;
  }
  for (const fn of REALLOC_IMPORTS) {
    exports[`wlink:import:${HAL_MODULE}#${fn}:realloc`] = () => 0;
  }
  return { ...exports, ...overrides };
}
