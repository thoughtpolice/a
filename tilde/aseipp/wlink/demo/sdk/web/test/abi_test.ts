// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "../assert.ts";
import {
  Binding,
  discoverExports,
  GuestTrap,
  HAL_MODULE,
  Mem,
  MEMORY_IMPORTS,
  REALLOC_IMPORTS,
} from "../abi.ts";
import { fakeExports, fixtureModule } from "../fixtures.ts";

function instantiate(): WebAssembly.Instance {
  const module = new WebAssembly.Module(fixtureModule({ growOnAlloc: true }));
  return new WebAssembly.Instance(module, {
    [HAL_MODULE]: { "exit": () => {}, "set-frame-rate": (hz: number) => hz },
  });
}

Deno.test("the module's export surface resolves to bindings", () => {
  const exports = discoverExports(instantiate().exports);
  assertEquals(exports.platformMemory === exports.gameMemory, false);
  for (const name of MEMORY_IMPORTS) {
    assertEquals(
      exports.binding(name).mem.memory,
      exports.platformMemory,
      name,
    );
  }
  // Each memory is wrapped once, so the seventeen aliases share their views.
  const mems = new Set(MEMORY_IMPORTS.map((name) => exports.binding(name).mem));
  assertEquals(mems.size, 1);
  assertThrows(() => exports.binding("now-ms"), "does not bind a memory");
});

Deno.test("a missing memory or allocator is a startup failure", () => {
  for (
    const name of [
      `wlink:import:${HAL_MODULE}#read-text:memory`,
      "platform:memory",
      "frame",
    ]
  ) {
    const broken = fakeExports();
    delete (broken as Record<string, unknown>)[name];
    assertThrows(() => discoverExports(broken), "does not export");
  }
  const wrongKind = fakeExports({
    "game:memory": (() => 0) as WebAssembly.ExportValue,
  });
  assertThrows(() => discoverExports(wrongKind), "does not export a memory");
});

Deno.test("a game without linear memory exports no game memory", () => {
  const heapOnly = fakeExports();
  delete (heapOnly as Record<string, unknown>)["game:memory"];
  assertEquals(discoverExports(heapOnly).gameMemory, null);
});

Deno.test("a range outside the memory traps the way a native host does", () => {
  const mem = new Mem(new WebAssembly.Memory({ initial: 1 }));
  assertEquals(mem.byteLength(), 65536);
  assertEquals(mem.range(65532, 4).length, 4);
  assertThrows(() => mem.range(65533, 4), "out of bounds memory access");
  assertThrows(() => mem.range(-1, 1), "out of bounds memory access");
  assertThrows(() => mem.span(0, 65537), "out of bounds memory access");
  assertThrows(() => mem.store32(65533, 1), "out of bounds memory access");
  assertThrows(() => mem.store64(65529, 1n), "out of bounds memory access");
  assertThrows(() => mem.storeU8(65536, 1), "out of bounds memory access");
  // A guest pointer arrives as a signed word; the high half of the address
  // space is still an address.
  assertThrows(() => mem.range(-4, 4), "out of bounds memory access");
});

Deno.test("values are stored little-endian", () => {
  const mem = new Mem(new WebAssembly.Memory({ initial: 1 }));
  mem.store32(0, 0x01020304);
  assertEquals([...mem.range(0, 4)], [4, 3, 2, 1]);
  mem.store32(4, -1);
  assertEquals([...mem.range(4, 4)], [255, 255, 255, 255]);
  mem.store64(8, 0x0102030405060708n);
  assertEquals([...mem.range(8, 8)], [8, 7, 6, 5, 4, 3, 2, 1]);
  mem.store64(16, -1n);
  assertEquals([...mem.range(16, 8)], [255, 255, 255, 255, 255, 255, 255, 255]);
  mem.storeU8(24, 0x1ff);
  assertEquals(mem.range(24, 1)[0], 0xff);
  mem.fill0(0, 25);
  assertEquals(mem.range(0, 25).every((byte) => byte === 0), true);
});

Deno.test("an empty result is the aligned dangling pointer, allocated from nothing", () => {
  let calls = 0;
  const mem = new Mem(new WebAssembly.Memory({ initial: 1 }));
  const binding = new Binding("read-text", mem, () => {
    calls++;
    return 64;
  });
  assertEquals(binding.alloc(1, 0), 1);
  assertEquals(binding.alloc(4, 0), 4);
  assertEquals(binding.alloc(8, 0), 8);
  assertEquals(calls, 0);
  assertEquals(binding.alloc(1, 3), 64);
  assertEquals(calls, 1);
});

Deno.test("an allocator that cannot allocate traps", () => {
  const mem = new Mem(new WebAssembly.Memory({ initial: 1 }));
  assertThrows(
    () => new Binding("arg", mem, undefined).alloc(1, 4),
    "has no realloc",
  );
  assertEquals(new Binding("arg", mem, undefined).alloc(1, 0), 1);
  assertThrows(
    () => new Binding("arg", mem, () => 0).alloc(1, 4),
    "allocation failed",
  );
});

Deno.test("views taken before an allocation are never reused after it", () => {
  const exports = discoverExports(instantiate().exports);
  const binding = exports.binding("read-text");
  const before = binding.mem.byteLength();
  const stale = binding.mem.view();
  const ptr = binding.alloc(1, 8);
  assert(
    binding.mem.byteLength() > before,
    "the fixture grows on every allocation",
  );
  assertEquals(stale.byteLength, 0, "growth detached the earlier buffer");
  binding.mem.write(ptr, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  assertEquals([...binding.mem.range(ptr, 8)], [1, 2, 3, 4, 5, 6, 7, 8]);
});

Deno.test("the HAL's shape is the one wlink exports", () => {
  assertEquals(MEMORY_IMPORTS.length, 17);
  assertEquals(REALLOC_IMPORTS.length, 6);
  for (const name of REALLOC_IMPORTS) {
    assert(
      MEMORY_IMPORTS.includes(name),
      `${name} returns a buffer but names no memory`,
    );
  }
  assertEquals(new GuestTrap("x").name, "GuestTrap");
});
