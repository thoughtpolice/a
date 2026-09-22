// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The segment chain convention and its helper, over in-memory segments.
 *
 * @module
 */

import {
  Chain,
  CHAIN_NAME_PATTERN,
  chainAddress,
  type ChainMetadata,
  chainPosition,
  decodeChainMetadata,
  encodeChainMetadata,
  MAX_CHAIN_INDEX,
  segmentName,
} from "@wormspace/layers/chain";
import { LIMITS, NAME_PATTERN } from "@wormspace/segment/types";
import { assert, assertCode, assertEquals, assertOk } from "@celld/assert";
import { FakeSegments, lostReply } from "@wormspace/testing/fake_segment";

const text = new TextEncoder();

function chainOf(segments: FakeSegments, name = "log", size = 4): Chain {
  return assertOk(Chain.create(segments.resolve, name, size)).chain;
}

Deno.test("link names are <chain>.<index>, and every one is a segment name", () => {
  assertEquals(assertOk(segmentName("log", 0)).name, "log.0");
  assertEquals(assertOk(segmentName("a.b-c_1", 12)).name, "a.b-c_1.12");
  const longest = "x".repeat(117);
  const name = assertOk(segmentName(longest, MAX_CHAIN_INDEX)).name;
  assertEquals(name.length, 128);
  assert(NAME_PATTERN.test(name), "the longest link name is a segment name");
  assert(CHAIN_NAME_PATTERN.test(longest), "117 characters is legal");
  for (const chain of ["", "x".repeat(118), "Log", "-log", "l/og", "l og"]) {
    assertCode(segmentName(chain, 0), "INVALID");
  }
  for (const index of [-1, 1.5, MAX_CHAIN_INDEX + 1, NaN, Infinity]) {
    assertCode(segmentName("log", index), "INVALID");
  }
  assertCode(segmentName("log", "1" as unknown as number), "INVALID");
});

Deno.test("global addresses are index * size + offset, both ways", () => {
  assertEquals(assertOk(chainAddress(0, 0, 4)).address, 0);
  assertEquals(assertOk(chainAddress(2, 3, 4)).address, 11);
  assertEquals(assertOk(chainPosition(11, 4)), {
    ok: true,
    index: 2,
    offset: 3,
  });
  assertEquals(assertOk(chainPosition(0, 1)), {
    ok: true,
    index: 0,
    offset: 0,
  });
  for (const size of [1, 7, 4096, LIMITS.maxSize]) {
    for (
      const index of [0, 1, 2, 1000, MAX_CHAIN_INDEX - 1, MAX_CHAIN_INDEX]
    ) {
      for (const offset of [0, 1, size - 1]) {
        if (offset >= size) continue;
        const address = assertOk(chainAddress(index, offset, size)).address;
        assert(Number.isSafeInteger(address), `${address} is not safe`);
        assertEquals(
          assertOk(chainPosition(address, size)),
          { ok: true, index, offset },
          `${index}/${offset}/${size}`,
        );
      }
    }
  }
  // The very last address of the biggest chain is 2^48 - 1.
  const last = assertOk(
    chainAddress(MAX_CHAIN_INDEX, LIMITS.maxSize - 1, LIMITS.maxSize),
  ).address;
  assertEquals(last, 2 ** 48 - 1);
  assertCode(chainPosition(last + 1, LIMITS.maxSize), "INVALID");
  assertCode(chainPosition(4 * (MAX_CHAIN_INDEX + 1), 4), "INVALID");

  for (
    const [index, offset, size] of [
      [0, 4, 4],
      [0, -1, 4],
      [-1, 0, 4],
      [MAX_CHAIN_INDEX + 1, 0, 4],
      [0, 0, 0],
      [0, 0, LIMITS.maxSize + 1],
      [0.5, 0, 4],
      [0, 0.5, 4],
      [0, 0, 1.5],
    ]
  ) {
    assertCode(chainAddress(index, offset, size), "INVALID");
  }
  for (
    const [address, size] of [[-1, 4], [0.5, 4], [0, 0], [NaN, 4], [3, 1.5]]
  ) {
    assertCode(chainPosition(address, size), "INVALID");
  }
});

Deno.test("chain metadata round-trips and is canonical JSON", () => {
  const metadata: ChainMetadata = { chain: "log", index: 7, size: 64 };
  const bytes = assertOk(encodeChainMetadata(metadata)).metadata;
  assertEquals(
    new TextDecoder().decode(bytes),
    '{"chain":"log","index":7,"size":64}',
  );
  assertEquals(assertOk(decodeChainMetadata(bytes)).metadata, metadata);
  // Key order is not part of the convention; the fields are.
  assertEquals(
    assertOk(
      decodeChainMetadata(text.encode('{"size":64,"index":7,"chain":"log"}')),
    ).metadata,
    metadata,
  );
  for (
    const bad of [
      { chain: "Log", index: 0, size: 4 },
      { chain: "log", index: -1, size: 4 },
      { chain: "log", index: 0, size: 0 },
      { chain: "log", index: 0, size: LIMITS.maxSize + 1 },
    ]
  ) {
    assertCode(encodeChainMetadata(bad), "INVALID");
  }
});

Deno.test("anything but exact chain metadata is not a chain segment", () => {
  const rejected = [
    new Uint8Array(0),
    new Uint8Array([0xff, 0xfe]),
    text.encode("meta"),
    text.encode("[]"),
    text.encode("null"),
    text.encode('"log"'),
    text.encode('{"chain":"log","index":0}'),
    text.encode('{"chain":"log","index":0,"size":4,"next":"log.1"}'),
    text.encode('{"chain":"log","index":"0","size":4}'),
    text.encode('{"chain":"log","index":0.5,"size":4}'),
    text.encode('{"chain":"log","index":0,"size":0}'),
    text.encode('{"chain":"LOG","index":0,"size":4}'),
    text.encode(`{"chain":"log","index":${MAX_CHAIN_INDEX + 1},"size":4}`),
  ];
  for (const bytes of rejected) {
    assertCode(decodeChainMetadata(bytes), "INVALID");
  }
});

Deno.test("Chain.create validates its name and size", () => {
  const segments = new FakeSegments();
  assertCode(Chain.create(segments.resolve, "Log", 4), "INVALID");
  assertCode(Chain.create(segments.resolve, "x".repeat(118), 4), "INVALID");
  assertCode(Chain.create(segments.resolve, "log", 0), "INVALID");
  const chain = chainOf(segments, "log", 4);
  assertEquals([chain.name, chain.size], ["log", 4]);
  assertEquals(assertOk(chain.address(3, 1)).address, 13);
  assertEquals(assertOk(chain.position(13)), { ok: true, index: 3, offset: 1 });
  assertEquals(assertOk(chain.segmentName(3)).name, "log.3");
  assertEquals(segments.calls, [], "nothing is called until asked");
});

Deno.test("allocate writes the convention's metadata and size", async () => {
  const segments = new FakeSegments();
  const chain = chainOf(segments, "log", 16);
  const first = assertOk(await chain.allocate(0, "alpha"));
  assertEquals([first.index, first.name, first.created], [0, "log.0", true]);
  assertEquals(
    [first.status.allocated, first.status.size, first.status.allocator],
    [true, 16, "alpha"],
  );
  assertEquals(
    assertOk(decodeChainMetadata(first.status.metadata!)).metadata,
    { chain: "log", index: 0, size: 16 },
  );
  const second = assertOk(await chain.allocate(1));
  assertEquals([second.name, second.created], ["log.1", true]);
  assertEquals(second.status.allocator, null);
  assertCode(await chain.allocate(-1), "INVALID");
  // The segment decides what a legal allocator is, and says so.
  assertCode(await chain.allocate(2, "x".repeat(129)), "INVALID");
  assertEquals(segments.get("log.2").meta.allocated, false);
});

Deno.test("allocation is first-writer-wins per link across allocators", async () => {
  const segments = new FakeSegments();
  const alpha = chainOf(segments);
  const beta = chainOf(segments);
  // Both race for every link at once; each link has exactly one creator.
  for (let index = 0; index < 5; index += 1) {
    const [a, b] = await Promise.all([
      alpha.allocate(index, "alpha"),
      beta.allocate(index, "beta"),
    ]);
    const won = [assertOk(a), assertOk(b)];
    assertEquals(
      won.filter((link) => link.created).length,
      1,
      `link ${index}`,
    );
    const winner = won.find((link) => link.created)!.status.allocator;
    for (const link of won) {
      assertEquals(link.status.allocator, winner, "both see the same winner");
      assertEquals(link.name, `log.${index}`);
    }
  }
  assertEquals(segments.count("alloc"), 10);
  // A replay by the creator finds its own link.
  const replay = assertOk(await alpha.allocate(4, "alpha"));
  assertEquals(replay.created, false);
});

Deno.test("a lost alloc reply is settled by allocating again", async () => {
  const segments = new FakeSegments();
  const chain = chainOf(segments);
  segments.faults = (method) => method === "alloc" ? "lost" : undefined;
  let thrown: unknown;
  try {
    await chain.allocate(0, "alpha");
  } catch (error) {
    thrown = error;
  }
  assertEquals((thrown as Error).message, lostReply().message);
  segments.faults = undefined;
  const again = assertOk(await chain.allocate(0, "alpha"));
  assertEquals([again.created, again.status.allocator], [false, "alpha"]);
});

Deno.test("links are allocated in order", async () => {
  const segments = new FakeSegments();
  const chain = chainOf(segments);
  assertCode(await chain.allocate(1), "UNALLOCATED");
  assertEquals(segments.count("alloc"), 0, "nothing was allocated");
  assertOk(await chain.allocate(0));
  assertCode(await chain.allocate(2), "UNALLOCATED");
  assertOk(await chain.allocate(1));
  assertOk(await chain.allocate(2));
  assertEquals(segments.names(), ["log.0", "log.1", "log.2"]);
});

Deno.test("a segment that is not the expected link is CHAIN_MISMATCH", async () => {
  const segments = new FakeSegments();
  const squat = async (name: string, size: number, metadata: Uint8Array) =>
    assertOk(await segments.get(name).alloc({ size, metadata }));
  await squat("log.0", 4, text.encode("not a chain"));
  await squat(
    "other.0",
    4,
    assertOk(encodeChainMetadata({ chain: "log", index: 0, size: 4 }))
      .metadata,
  );
  await squat(
    "wrongindex.0",
    4,
    assertOk(encodeChainMetadata({ chain: "wrongindex", index: 1, size: 4 }))
      .metadata,
  );
  await squat(
    "wrongsize.0",
    8,
    assertOk(encodeChainMetadata({ chain: "wrongsize", index: 0, size: 4 }))
      .metadata,
  );
  await squat(
    "bigger.0",
    4,
    assertOk(encodeChainMetadata({ chain: "bigger", index: 0, size: 4 }))
      .metadata,
  );

  const garbage = await chainOf(segments, "log").allocate(0);
  assertCode(garbage, "CHAIN_MISMATCH");
  assert(!garbage.ok && garbage.code === "CHAIN_MISMATCH", "narrowed");
  assertEquals(garbage.found, null);
  assertEquals(garbage.expected, { chain: "log", index: 0, size: 4 });

  const other = await chainOf(segments, "other").allocate(0);
  assert(!other.ok && other.code === "CHAIN_MISMATCH", "another chain's link");
  assertEquals(other.found, { chain: "log", index: 0, size: 4 });

  assertCode(
    await chainOf(segments, "wrongindex").allocate(0),
    "CHAIN_MISMATCH",
  );
  // Metadata that claims the right size on a segment of another size.
  assertCode(
    await chainOf(segments, "wrongsize").allocate(0),
    "CHAIN_MISMATCH",
  );
  // The same chain opened with another size than link 0 has.
  assertCode(
    await chainOf(segments, "bigger", 8).allocate(0),
    "CHAIN_MISMATCH",
  );
  // A bad predecessor refuses the next link before anything is allocated.
  assertCode(await chainOf(segments, "log").allocate(1), "CHAIN_MISMATCH");
  assertEquals(segments.get("log.1").meta.allocated, false);
});

Deno.test("Chain.open takes the size from link 0", async () => {
  const segments = new FakeSegments();
  assertCode(await Chain.open(segments.resolve, "log"), "UNALLOCATED");
  assertCode(await Chain.open(segments.resolve, "Log"), "INVALID");
  assertOk(await chainOf(segments, "log", 32).allocate(0));
  const opened = assertOk(await Chain.open(segments.resolve, "log")).chain;
  assertEquals([opened.name, opened.size], ["log", 32]);
  assertEquals(assertOk(await opened.allocate(1)).status.size, 32);
  await segments.get("junk.0").alloc({ size: 4, metadata: text.encode("{}") });
  assertCode(await Chain.open(segments.resolve, "junk"), "CHAIN_MISMATCH");
});

Deno.test("tail walks to the first unallocated link", async () => {
  const segments = new FakeSegments();
  const chain = chainOf(segments);
  assertEquals(await chain.tail(), { ok: true, tail: null });
  assertEquals(segments.count("status"), 1, "one status for an empty chain");
  for (let index = 0; index < 6; index += 1) {
    assertOk(await chain.allocate(index));
  }
  const round = assertOk(await segments.get("log.5").capture({ start: 0 }));
  assertOk(
    await segments.get("log.5").write({
      start: 0,
      values: [text.encode("x")],
      captureId: round.captureId,
    }),
  );

  const statusCalls = async (run: () => Promise<unknown>) => {
    const before = segments.count("status");
    await run();
    return segments.count("status") - before;
  };

  let found = assertOk(await chain.tail()).tail!;
  assertEquals([found.index, found.name], [5, "log.5"]);
  assertEquals([found.status.writtenCount, found.status.writes], [1, 1]);
  assertEquals(await statusCalls(() => chain.tail()), 7, "no hint walks all");
  assertEquals(
    await statusCalls(() => chain.tail({ fromIndex: 5 })),
    2,
    "the exact hint costs the tail and the gap after it",
  );
  found = assertOk(await chain.tail({ fromIndex: 3 })).tail!;
  assertEquals(found.index, 5);

  // A hint past the end walks back to the tail.
  found = assertOk(await chain.tail({ fromIndex: 9 })).tail!;
  assertEquals(found.index, 5);
  assertEquals(
    await statusCalls(() => chain.tail({ fromIndex: 9 })),
    5,
    "9, then 8, 7, 6, and 5 walking back",
  );
  assertCode(await chain.tail({ fromIndex: -1 }), "INVALID");

  // Growth is visible to the next walk from the old tail.
  assertOk(await chain.allocate(6));
  assertEquals(assertOk(await chain.tail({ fromIndex: 5 })).tail!.index, 6);
});

Deno.test("tail refuses a segment squatting on a link name", async () => {
  const segments = new FakeSegments();
  const chain = chainOf(segments);
  assertOk(await chain.allocate(0));
  await segments.get("log.1").alloc({ size: 4, metadata: text.encode("x") });
  const result = await chain.tail();
  assert(!result.ok && result.code === "CHAIN_MISMATCH", "a squatter");
  assertEquals(result.name, "log.1");
});

Deno.test("transport failures propagate, and a retry settles", async () => {
  const segments = new FakeSegments();
  const chain = chainOf(segments);
  assertOk(await chain.allocate(0));
  let failures = 1;
  segments.faults = (method) => {
    if (method === "status" && failures > 0) {
      failures -= 1;
      return "throw";
    }
    return undefined;
  };
  let thrown: unknown;
  try {
    await chain.tail();
  } catch (error) {
    thrown = error;
  }
  assertEquals((thrown as { code?: string }).code, "owner_unreachable");
  assertEquals(assertOk(await chain.tail()).tail!.index, 0);
});
