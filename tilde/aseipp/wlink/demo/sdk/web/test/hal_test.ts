// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "../assert.ts";
import { discoverExports, Exports, GuestExit, HAL_MODULE } from "../abi.ts";
import { fixtureModule } from "../fixtures.ts";
import { HostState, Identity, makeImports, Sinks } from "../hal.ts";

type Raw = Record<string, (...args: never[]) => unknown>;

const IDENTITY: Identity = {
  name: "headless",
  unixSeconds: () => 1234567n,
  randomSeed: () => 42n,
  features: () => 1,
  capabilities: () => 7,
};

interface Harness {
  state: HostState;
  exports: Exports;
  raw: Raw;
  log: string[];
  titles: string[];
  captures: boolean[];
}

function harness(): Harness {
  const module = new WebAssembly.Module(fixtureModule());
  const state = new HostState(60);
  const log: string[] = [];
  const titles: string[] = [];
  const captures: boolean[] = [];
  const sinks: Sinks = {
    log: (level, text) => log.push(`${level}: ${text}`),
    setTitle: (text) => titles.push(text),
    capturePointer: (captured) => {
      captures.push(captured);
      return captured ? 1 : 0;
    },
  };
  let exports: Exports | null = null;
  const imports = makeImports(
    state,
    () => {
      assert(exports !== null, "exports resolved before instantiation");
      return exports;
    },
    IDENTITY,
    sinks,
  );
  const instance = new WebAssembly.Instance(module, {
    ...imports,
    [HAL_MODULE]: {
      ...(imports[HAL_MODULE] as WebAssembly.ModuleImports),
      "exit": () => {},
      "set-frame-rate": (hz: number) => hz,
    },
  });
  exports = discoverExports(instance.exports);
  return {
    state,
    exports,
    raw: (imports[HAL_MODULE] as unknown) as Raw,
    log,
    titles,
    captures,
  };
}

function mem(h: Harness, name: string) {
  return h.exports.binding(name).mem;
}

function load32(h: Harness, name: string, ptr: number): number {
  return mem(h, name).data().getUint32(ptr, true);
}

const RESULT = 64;

Deno.test("a returned string is written through the import's own allocator", () => {
  const h = harness();
  (h.raw["host-name"] as (result: number) => void)(RESULT);
  const ptr = load32(h, "host-name", RESULT);
  const len = load32(h, "host-name", RESULT + 4);
  assertEquals(len, 8);
  assertEquals(
    new TextDecoder().decode(mem(h, "host-name").range(ptr, len)),
    "headless",
  );
});

Deno.test("an empty result is the dangling pointer the bindings expect", () => {
  const h = harness();
  (h.raw["read-text"] as (result: number) => void)(RESULT);
  assertEquals(load32(h, "read-text", RESULT), 1);
  assertEquals(load32(h, "read-text", RESULT + 4), 0);

  (h.raw["read-events"] as (result: number) => void)(RESULT);
  assertEquals(load32(h, "read-events", RESULT), 4);
  assertEquals(load32(h, "read-events", RESULT + 4), 0);

  (h.raw["file-list-directory"] as (p: number, l: number, r: number) => void)(
    0,
    0,
    RESULT,
  );
  assertEquals(load32(h, "file-list-directory", RESULT), 0);
  assertEquals(load32(h, "file-list-directory", RESULT + 4), 8);
  assertEquals(load32(h, "file-list-directory", RESULT + 8), 0);

  (h.raw["arg"] as (i: number, r: number) => void)(0, RESULT);
  assertEquals(load32(h, "arg", RESULT), 1);
  assertEquals(load32(h, "arg", RESULT + 4), 0);
});

Deno.test("key events cross as an eight-byte record with zero padding", () => {
  const h = harness();
  h.state.input.pushKey(24, true);
  h.state.input.pushKey(3, false);
  (h.raw["read-events"] as (result: number) => void)(RESULT);
  const ptr = load32(h, "read-events", RESULT);
  assertEquals(load32(h, "read-events", RESULT + 4), 2);
  assertEquals(ptr % 4, 0);
  const bytes = [...mem(h, "read-events").range(ptr, 16)];
  assertEquals(bytes, [24, 0, 0, 0, 1, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0]);
  // The queue is drained by the read.
  (h.raw["read-events"] as (result: number) => void)(RESULT);
  assertEquals(load32(h, "read-events", RESULT + 4), 0);
});

Deno.test("the mouse reports its position and what changed since the last read", () => {
  const h = harness();
  h.state.input.moveMouse(3, 4, 5, -2);
  h.state.input.moveMouse(9, 4, 5, 1);
  (h.raw["read-mouse"] as (result: number) => void)(RESULT);
  const view = mem(h, "read-mouse").data();
  const fields = [0, 1, 2, 3, 4, 5].map((i) =>
    view.getInt32(RESULT + 4 * i, true)
  );
  assertEquals(fields, [9, 4, 6, 0, 5, -1]);
  (h.raw["read-mouse"] as (result: number) => void)(RESULT);
  const again = [0, 1, 2, 3, 4, 5].map((i) =>
    view.getInt32(RESULT + 4 * i, true)
  );
  assertEquals(again, [9, 4, 0, 0, 5, 0]);
});

Deno.test("a directory listing is a 24-byte 8-aligned record per entry", () => {
  const h = harness();
  assert(h.state.vfs.mountReadonly("a.bin", new Uint8Array(300)), "mount");
  assertEquals(h.state.vfs.createDirectory(new TextEncoder().encode("sub")), 0);
  (h.raw["file-list-directory"] as (p: number, l: number, r: number) => void)(
    0,
    0,
    RESULT,
  );
  const status = load32(h, "file-list-directory", RESULT);
  const list = load32(h, "file-list-directory", RESULT + 4);
  const count = load32(h, "file-list-directory", RESULT + 8);
  assertEquals([status, count], [0, 2]);
  assertEquals(list % 8, 0);
  const view = mem(h, "file-list-directory").data();
  const entry = (index: number) => {
    const at = list + 24 * index;
    const namePtr = view.getUint32(at, true);
    const nameLen = view.getUint32(at + 4, true);
    return {
      name: new TextDecoder().decode(
        mem(h, "file-list-directory").range(namePtr, nameLen),
      ),
      size: view.getBigUint64(at + 8, true),
      directory: view.getUint8(at + 16),
      padding: [17, 18, 19, 20, 21, 22, 23].map((o) => view.getUint8(at + o)),
    };
  };
  assertEquals(entry(0), {
    name: "a.bin",
    size: 300n,
    directory: 0,
    padding: [0, 0, 0, 0, 0, 0, 0],
  });
  assertEquals(entry(1), {
    name: "sub",
    size: 0n,
    directory: 1,
    padding: [0, 0, 0, 0, 0, 0, 0],
  });
});

Deno.test("a read result carries its status beside its buffer", () => {
  const h = harness();
  assert(
    h.state.vfs.mountReadonly("a.bin", new TextEncoder().encode("hello")),
    "mount",
  );
  const path = new TextEncoder().encode("a.bin");
  mem(h, "file-open").write(16, path);
  const fd =
    (h.raw["file-open"] as (p: number, l: number, w: number) => number)(
      16,
      5,
      0,
    );
  assertEquals(fd, 0);
  (h.raw["file-read-at"] as (
    f: number,
    o: bigint,
    l: number,
    r: number,
  ) => void)(
    fd,
    1n,
    3,
    RESULT,
  );
  assertEquals(load32(h, "file-read-at", RESULT), 0);
  const ptr = load32(h, "file-read-at", RESULT + 4);
  assertEquals(load32(h, "file-read-at", RESULT + 8), 3);
  assertEquals(
    new TextDecoder().decode(mem(h, "file-read-at").range(ptr, 3)),
    "ell",
  );

  (h.raw["file-read-at"] as (
    f: number,
    o: bigint,
    l: number,
    r: number,
  ) => void)(
    99,
    0n,
    3,
    RESULT,
  );
  assertEquals(load32(h, "file-read-at", RESULT) | 0, -1);
  assertEquals(load32(h, "file-read-at", RESULT + 4), 1);
  assertEquals(
    (h.raw["file-size"] as (f: number) => bigint)(99),
    0xffffffffffffffffn,
  );
  assertEquals((h.raw["file-size"] as (f: number) => bigint)(fd), 5n);
});

Deno.test("arguments outside the count are empty strings", () => {
  const h = harness();
  h.state.args = ["doom", "-warp"];
  assertEquals((h.raw["arg-count"] as () => number)(), 2);
  for (
    const [index, expected] of [[0, "doom"], [1, "-warp"], [2, ""], [
      -1,
      "",
    ]] as const
  ) {
    (h.raw["arg"] as (i: number, r: number) => void)(index, RESULT);
    const ptr = load32(h, "arg", RESULT);
    const len = load32(h, "arg", RESULT + 4);
    assertEquals(
      new TextDecoder().decode(mem(h, "arg").range(ptr, len)),
      expected,
    );
  }
});

Deno.test("the frame rate may be chosen only before the first frame", () => {
  const h = harness();
  const set = h.raw["set-frame-rate"] as (hz: number) => number;
  assertEquals((h.raw["frames-per-second"] as () => number)(), 60);
  assertEquals(set(0), 60);
  assertEquals(set(1001), 60);
  assertEquals(set(35), 35);
  assertEquals(set(1000), 1000);
  h.state.frames = 1;
  assertEquals(set(70), 1000);
});

Deno.test("an invalid framebuffer is a trap, and a valid one is kept as RGBA", () => {
  const h = harness();
  const present = h.raw["present"] as (
    w: number,
    h: number,
    p: number,
    l: number,
  ) => void;
  assertThrows(() => present(0, 1, 0, 0), "out of bounds");
  assertThrows(() => present(2, 2, 0, 15), "out of bounds");
  mem(h, "present").write(16, new Uint8Array(16).fill(7));
  present(2, 2, 16, 16);
  assertEquals(h.state.width, 2);
  assertEquals(h.state.height, 2);
  assertEquals(h.state.presentations, 1);
  assertEquals(h.state.pixels?.every((byte) => byte === 7), true);

  const indexed = h.raw["present-indexed"] as (
    w: number,
    h: number,
    p: number,
    l: number,
    pp: number,
    pl: number,
  ) => void;
  assertThrows(() => indexed(2, 2, 0, 4, 0, 255), "out of bounds");
  assertThrows(() => indexed(2, 2, 0, 3, 0, 256), "out of bounds");
  const palette = new Uint8Array(1024);
  palette.set([1, 2, 3, 4], 4 * 9);
  mem(h, "present-indexed").write(2048, palette);
  mem(h, "present-indexed").write(1024, new Uint8Array([9, 9, 9, 9]));
  indexed(2, 2, 1024, 4, 2048, 256);
  assertEquals([...(h.state.pixels ?? [])], [
    1,
    2,
    3,
    4,
    1,
    2,
    3,
    4,
    1,
    2,
    3,
    4,
    1,
    2,
    3,
    4,
  ]);
});

Deno.test("audio takes whole frames and reports what the queue holds", () => {
  const h = harness();
  const write = h.raw["audio-write"] as (p: number, l: number) => number;
  mem(h, "audio-write").write(16, new Uint8Array(400));
  assertEquals(write(16, 200), 100);
  assertEquals((h.raw["audio-queued"] as () => number)(), 100);
  assertThrows(() => write(16, 0x7fffffff), "out of bounds");
});

Deno.test("the host's own answers come from its identity", () => {
  const h = harness();
  assertEquals((h.raw["unix-seconds"] as () => bigint)(), 1234567n);
  assertEquals((h.raw["random-seed"] as () => bigint)(), 42n);
  assertEquals((h.raw["host-features"] as () => number)(), 1);
  assertEquals((h.raw["input-capabilities"] as () => number)(), 7);
  h.state.nowMs = 2n ** 40n;
  assertEquals((h.raw["now-ms"] as () => bigint)(), 2n ** 40n);

  const title = new TextEncoder().encode("Doom");
  mem(h, "set-title").write(16, title);
  (h.raw["set-title"] as (p: number, l: number) => void)(16, 4);
  assertEquals(h.titles, ["Doom"]);
  mem(h, "write-log").write(16, new TextEncoder().encode("hello"));
  (h.raw["write-log"] as (l: number, p: number, n: number) => void)(1, 16, 5);
  assertEquals(h.log, ["1: hello"]);
  assertEquals((h.raw["capture-pointer"] as (c: number) => number)(1), 1);
  assertEquals((h.raw["capture-pointer"] as (c: number) => number)(0), 0);
  assertEquals(h.captures, [true, false]);
});

Deno.test("exit does not return to the guest", () => {
  const h = harness();
  const error = assertThrows(() => (h.raw["exit"] as (c: number) => void)(7));
  assert(error instanceof GuestExit, "exit throws GuestExit");
  assertEquals((error as GuestExit).code, 7);
  assertEquals(h.state.exitRequested, true);
  assertEquals(h.state.exitCode, 7);
  assertThrows(() => (h.raw["exit"] as (c: number) => void)(-1));
  assertEquals(h.state.exitCode, -1);
});
