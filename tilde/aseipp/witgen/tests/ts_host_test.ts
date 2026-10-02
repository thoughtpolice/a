// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The TypeScript host bindings of tests/host.wit, type-checked and run
// against a guest memory of the test's own. The bindings are generated
// beside this file in the test's inputs.

import {
  bindHostTest,
  bindThings,
  Color,
  type Guest,
  type GuestBinding,
  type HostTest,
  type Listing,
  Perms,
  type Point,
  type Things,
  THINGS_MEMORY,
  THINGS_MODULE,
  THINGS_REALLOC,
} from "./host.ts";

class Trap extends Error {}

function equal(actual: unknown, expected: unknown): void {
  const a = JSON.stringify(
    actual,
    (_, v) => typeof v === "bigint" ? `${v}n` : v,
  );
  const e = JSON.stringify(
    expected,
    (_, v) => typeof v === "bigint" ? `${v}n` : v,
  );
  if (a !== e) throw new Error(`expected ${e}, got ${a}`);
}

function throws(run: () => unknown, message: string): void {
  try {
    run();
  } catch (error) {
    if (error instanceof Trap && error.message === message) return;
    throw error;
  }
  throw new Error(`expected a trap: ${message}`);
}

/** A guest's linear memory, with a bump allocator that records its calls. */
class Memory implements GuestBinding {
  readonly buffer = new ArrayBuffer(4096);
  readonly bytes = new Uint8Array(this.buffer).fill(0xaa);
  next = 1024;
  readonly allocations: number[][] = [];
  readonly mem = {
    range: (ptr: number, len: number): Uint8Array => {
      if (ptr + len > this.bytes.length) {
        throw new Trap("out of bounds memory access");
      }
      return this.bytes.subarray(ptr, ptr + len);
    },
    data: (): DataView => new DataView(this.buffer),
  };

  alloc(align: number, len: number): number {
    if (len === 0) return align;
    const ptr = Math.ceil(this.next / align) * align;
    this.next = ptr + len;
    this.allocations.push([ptr, align, len]);
    return ptr;
  }

  put(at: number, bytes: ArrayLike<number>): void {
    this.bytes.set(bytes, at);
  }

  word(at: number): number {
    return new DataView(this.buffer).getUint32(at, true);
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function setup() {
  const memory = new Memory();
  const calls: string[] = [];
  const guest: Guest = {
    binding: () => memory,
    trap: (message) => new Trap(message),
  };
  const host: Things & HostTest = {
    scalars(a, b, c, d, e, f, g, h, i, j, k, l) {
      calls.push([a, b, c, d, e, f, g, h, i, j, k, l].join(" "));
      return 2n ** 64n - 2n;
    },
    negate: (value) => -value,
    halve: (value) => value / 2,
    enums: (c, p) => {
      equal(p, Perms.read | Perms.exec);
      return (c + 1) % 3;
    },
    letter: (c) => String.fromCodePoint(c).toUpperCase().codePointAt(0)!,
    text: (message) => decoder.decode(message).toUpperCase(),
    bytes: (data) => data.slice().reverse(),
    numbers(values, wide, floats) {
      calls.push(`${[...values]} ${[...wide]} ${[...floats]}`);
      return [values.length, wide.length, 0xdeadbeef];
    },
    points: (points) => points.map((p) => ({ x: p.y, y: p.x })),
    recordParam: (p: Point, name) => ({ x: p.x + name.length, y: p.y }),
    tuples: (t) => [t[0] + t[2], t[1]],
    listItems(path): Listing {
      equal(decoder.decode(path), "/");
      return {
        status: -2,
        items: [
          {
            name: "one",
            tag: new Uint8Array([1]),
            color: Color.blue,
            weight: 1.5,
            at: { x: 1, y: -1 },
          },
          {
            name: new Uint8Array(),
            tag: new Uint8Array([2, 3]),
            color: Color.red,
            weight: -0.25,
            at: { x: 2, y: -2 },
          },
        ],
        codes: [7, 65535],
      };
    },
    spilled(a, b, c, d, e, f, g, h, i, j, k, l, m, n) {
      equal(decoder.decode(new Uint8Array([...i, ...j, ...k, ...l])), "wxyz");
      equal(m, 1n << 40n);
      return a + b + c + d + e + f + g + h + n.x + n.y;
    },
    nothing: () => {
      calls.push("nothing");
    },
    shout: (word) => decoder.decode(word).endsWith("!"),
  };
  const things = bindThings(host, guest) as Record<
    string,
    (...args: (number | bigint)[]) => number | bigint | void
  >;
  const root = bindHostTest(host, guest) as Record<
    string,
    (...args: (number | bigint)[]) => number | bigint | void
  >;
  return { memory, calls, things, root };
}

Deno.test("scalars are narrowed and widened", () => {
  const { calls, things } = setup();
  const result = things.scalars(
    7,
    0x1ff,
    -16,
    0x10002,
    0x8000,
    -1,
    -1,
    -1n,
    -1n,
    0.5,
    -2,
    0xe9,
  );
  equal(result, 2n ** 64n - 2n);
  equal(calls, [
    `true 255 -16 2 -32768 4294967295 -1 ${2n ** 64n - 1n} -1 0.5 -2 233`,
  ]);
  equal(things.negate(5), -5);
  equal(things.halve(3), 1.5);
  equal(things.letter(0x71), 0x51);
});

Deno.test("enums and characters out of range trap", () => {
  const { things } = setup();
  equal(things.enums(2, Perms.read | Perms.exec), 0);
  throws(() => things.enums(3, 0), "invalid enum discriminant");
  throws(() => things.letter(0xd800), "invalid char");
});

Deno.test("strings go out through the allocator", () => {
  const { memory, things } = setup();
  memory.put(16, encoder.encode("hello"));
  things.text(16, 5, 64);
  equal(memory.allocations, [[1024, 1, 5]]);
  equal([memory.word(64), memory.word(68)], [1024, 5]);
  equal(decoder.decode(memory.bytes.subarray(1024, 1029)), "HELLO");
  things.bytes(16, 0, 64);
  equal(memory.allocations.length, 1);
  equal([memory.word(64), memory.word(68)], [1, 0]);
});

Deno.test("lists of numbers are typed arrays of the memory", () => {
  const { memory, calls, things } = setup();
  memory.put(16, [0xff, 0xff, 2, 0]);
  new DataView(memory.buffer).setBigUint64(32, 1n << 33n, true);
  new DataView(memory.buffer).setFloat32(48, 1.5, true);
  things.numbers(16, 2, 32, 1, 48, 1, 128);
  equal(calls, ["-1,2 8589934592 1.5"]);
  equal(memory.allocations, [[1024, 4, 12]]);
  equal([memory.word(128), memory.word(132)], [1024, 3]);
  equal(memory.word(1032), 0xdeadbeef);
  throws(() => things.numbers(16, 2, 33, 1, 48, 1, 128), "misaligned pointer");
  throws(
    () => things.numbers(16, 2, 4088, 2, 48, 1, 128),
    "out of bounds memory access",
  );
});

Deno.test("records cross both ways", () => {
  const { memory, things } = setup();
  memory.put(16, [1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 0xfc, 0xff, 0xff, 0xff]);
  things.points(16, 2, 64);
  equal(memory.allocations, [[1024, 4, 16]]);
  equal(
    [...memory.bytes.subarray(1024, 1040)],
    [2, 0, 0, 0, 1, 0, 0, 0, 0xfc, 0xff, 0xff, 0xff, 3, 0, 0, 0],
  );
  memory.put(200, encoder.encode("abc"));
  things["record-param"](10, 20, 200, 3, 96);
  equal([memory.word(96), memory.word(100)], [13, 20]);
  throws(
    () => things["record-param"](10, 20, 200, 3, 98),
    "misaligned pointer",
  );
});

Deno.test("tuples cross both ways", () => {
  const { memory, things } = setup();
  memory.put(16, encoder.encode("tuple"));
  things.tuples(3, 16, 5, 4, 64);
  equal(memory.word(64), 7);
  const [ptr, len] = [memory.word(68), memory.word(72)];
  equal(decoder.decode(memory.bytes.subarray(ptr, ptr + len)), "tuple");
});

Deno.test("nested results allocate outside in", () => {
  const { memory, things } = setup();
  memory.put(16, encoder.encode("/"));
  things["list-items"](16, 1, 64);
  equal(memory.allocations, [
    [1024, 8, 80],
    [1104, 1, 3],
    [1107, 1, 1],
    [1108, 1, 2],
    [1110, 2, 4],
  ]);
  equal(memory.word(64), 2 ** 32 - 2);
  equal([memory.word(68), memory.word(72)], [1024, 2]);
  equal([memory.word(76), memory.word(80)], [1110, 2]);
  equal(
    [...memory.bytes.subarray(1024, 1064)],
    [
      80,
      4,
      0,
      0,
      3,
      0,
      0,
      0,
      83,
      4,
      0,
      0,
      1,
      0,
      0,
      0,
      2,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      ...new Uint8Array(new Float64Array([1.5]).buffer),
      1,
      0,
      0,
      0,
      0xff,
      0xff,
      0xff,
      0xff,
    ],
  );
  equal([...memory.bytes.subarray(1064, 1072)], [1, 0, 0, 0, 0, 0, 0, 0]);
  equal(decoder.decode(memory.bytes.subarray(1104, 1107)), "one");
  equal([...memory.bytes.subarray(1107, 1114)], [1, 2, 3, 7, 0, 0xff, 0xff]);
});

Deno.test("spilled parameters are read from memory", () => {
  const { memory, things } = setup();
  const view = new DataView(memory.buffer);
  for (let index = 0; index < 8; index++) {
    view.setUint32(512 + index * 4, index + 1, true);
  }
  memory.put(400, encoder.encode("wxyz"));
  [32, 40, 48, 56].forEach((at, index) => {
    view.setUint32(512 + at, 400 + index, true);
    view.setUint32(512 + at + 4, 1, true);
  });
  view.setBigUint64(512 + 64, 1n << 40n, true);
  view.setInt32(512 + 72, 100, true);
  view.setInt32(512 + 76, -10, true);
  equal(things.spilled(512), 126);
  throws(() => things.spilled(516), "misaligned pointer");
});

Deno.test("module constants and world functions", () => {
  const { memory, calls, things, root } = setup();
  things.nothing();
  equal(calls, ["nothing"]);
  memory.put(16, encoder.encode("hey!"));
  equal(root.shout(16, 4), 1);
  equal(THINGS_MODULE, "test:host/things@0.1.0");
  equal(THINGS_REALLOC.includes("list-items"), true);
  equal(THINGS_MEMORY.includes("scalars"), false);
});
