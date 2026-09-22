// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The fake segment against the model, and its `listen`.
 *
 * The differential test runs the model test's generator, which decides every
 * operation from the model's own state, records each request and the model's
 * result, and replays the sequence against a `FakeSegment`. Every result must
 * be identical, and after every step the fake's status, its tables, and a
 * read of every live register must match the model's storage. Identical
 * results at every step mean the two saw the same states, so the replay
 * exercises exactly the paths the generator reached.
 *
 * @module
 */

import * as core from "@wormspace/segment/core";
import {
  type AnyResult,
  LIMITS,
  type ReadRequest,
  type StatusOk,
} from "@wormspace/segment/types";
import { assert, assertCode, assertEquals, assertOk } from "@celld/assert";
import { FakeSegment, FakeSegments } from "@wormspace/testing/fake_segment";
import {
  modelRead,
  run,
  SEEDS,
  type Step,
  STEPS,
  type Storage,
} from "./model.ts";

/** What the model's storage looked like right after one step. */
interface Snapshot {
  step: Step;
  status: StatusOk;
  captures: core.CaptureRow[];
  registers: core.RegisterRow[];
  readBack: { request: ReadRequest; result: AnyResult } | null;
}

/** Every register above the trim mark, in one window. */
function liveWindow(storage: Storage): ReadRequest | null {
  const meta = storage.meta;
  const start = meta.trimmedThrough + 1;
  if (!meta.allocated || start >= meta.size) return null;
  return { start, count: LIMITS.readCount, maxBytes: LIMITS.readBytes };
}

function snapshot(step: Step, storage: Storage): Snapshot {
  const request = liveWindow(storage);
  return {
    step,
    status: core.status(storage.meta, storage.captures.length, 0),
    captures: storage.captures.map(({ round, start, end }) => ({
      round,
      start,
      end,
    })),
    registers: [...storage.registers.values()]
      .sort((left, right) => left.offset - right.offset)
      .map(({ offset, round, value }) => ({ offset, round, value })),
    readBack: request === null
      ? null
      : { request, result: modelRead(storage, request) },
  };
}

function perform(fake: FakeSegment, step: Step): Promise<AnyResult> {
  switch (step.op) {
    case "alloc":
      return fake.alloc(step.request);
    case "capture":
      return fake.capture(step.request);
    case "write":
      return fake.write(step.request);
    case "read":
      return fake.read(step.request);
    case "trim":
      return fake.trim(step.request);
  }
}

async function replay(seed: number): Promise<number> {
  const snapshots: Snapshot[] = [];
  run(seed, STEPS, new Set(), (step, storage) => {
    snapshots.push(snapshot(step, storage));
  });
  let nowMs = 0;
  const fake = new FakeSegments({ now: () => nowMs }).get("differential");
  for (const [index, expected] of snapshots.entries()) {
    const where = `seed ${seed} step ${index} (${expected.step.op})`;
    nowMs = expected.step.nowMs;
    assertEquals(
      await perform(fake, expected.step),
      expected.step.result,
      where,
    );
    const status = assertOk(await fake.status());
    assertEquals(
      { ...status, databaseSize: 0 },
      expected.status,
      `${where}: status`,
    );
    assertEquals(
      fake.captures.map(({ round, start, end }) => ({ round, start, end })),
      expected.captures,
      `${where}: capture rows`,
    );
    assertEquals(
      [...fake.registers.values()]
        .sort((left, right) => left.offset - right.offset)
        .map(({ offset, round, value }) => ({ offset, round, value })),
      expected.registers,
      `${where}: register rows`,
    );
    if (expected.readBack !== null) {
      assertEquals(
        await fake.read(expected.readBack.request),
        expected.readBack.result,
        `${where}: read-back`,
      );
    }
  }
  return snapshots.length;
}

Deno.test("the fake segment answers every model sequence exactly as the model", async () => {
  let steps = 0;
  for (let seed = 1; seed <= SEEDS; seed += 1) steps += await replay(seed);
  assertEquals(steps, SEEDS * STEPS, "every step was replayed");
});

Deno.test("the fake's edges copy bytes in and out, like RPC", async () => {
  const fake = new FakeSegment();
  const metadata = new Uint8Array([1, 2]);
  assertOk(await fake.alloc({ size: 4, metadata }));
  metadata[0] = 9;
  const value = new Uint8Array([7]);
  assertOk(await fake.write({ start: 0, values: [value], captureId: 0 }));
  value[0] = 8;
  const read = assertOk(await fake.read({ start: 0, count: 1 }));
  assertEquals(read.registers[0].value, new Uint8Array([7]));
  read.registers[0].value![0] = 6;
  assertEquals(
    assertOk(await fake.read({ start: 0, count: 1 })).registers[0].value,
    new Uint8Array([7]),
  );
  assertEquals(
    assertOk(await fake.status()).metadata,
    new Uint8Array([1, 2]),
  );
});

Deno.test("faults answer in the segment's place, throw, or lose a reply", async () => {
  const segments = new FakeSegments();
  const fake = segments.get("faulty");
  assertOk(await fake.alloc({ size: 4, metadata: new Uint8Array(0) }));
  const round = assertOk(await fake.capture({ start: 0, end: 4 })).captureId;

  segments.faults = (method) =>
    method === "write"
      ? {
        ok: false,
        code: "CAPTURE_STALE",
        message: "injected",
        offset: 0,
        round: round + 1,
        captureId: round,
      }
      : undefined;
  assertCode(
    await fake.write({
      start: 0,
      values: [new Uint8Array([1])],
      captureId: round,
    }),
    "CAPTURE_STALE",
  );
  assertEquals(fake.meta.writes, 0, "an injected answer performs nothing");

  segments.faults = () => "throw";
  let thrown: unknown;
  try {
    await fake.write({
      start: 0,
      values: [new Uint8Array([1])],
      captureId: round,
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals((thrown as { code?: string }).code, "owner_unreachable");
  assertEquals(fake.meta.writes, 0, "a thrown call performs nothing");

  segments.faults = (method) => method === "write" ? "lost" : undefined;
  thrown = undefined;
  try {
    await fake.write({
      start: 0,
      values: [new Uint8Array([1])],
      captureId: round,
    });
  } catch (error) {
    thrown = error;
  }
  assert(
    (thrown as Error).message.includes("DurabilityUnproven"),
    "a lost reply throws what celld throws",
  );
  assertEquals(fake.meta.writes, 1, "a lost reply's write happened");
  // The replay the README prescribes settles it.
  segments.faults = undefined;
  const replay = await fake.write({
    start: 0,
    values: [new Uint8Array([1])],
    captureId: round,
  });
  assert(
    !replay.ok && replay.code === "ALREADY_WRITTEN" && replay.sameValue,
    "the replay finds its own bytes",
  );
  assertEquals(
    segments.calls.map((call) => call.method),
    ["alloc", "capture", "write", "write", "write", "write"],
  );
});

function elapsed(since: number): number {
  return performance.now() - since;
}

Deno.test("listen answers at once, parks, times out, and wakes on a write", async () => {
  const fake = new FakeSegment();
  assertCode(await fake.listen({ since: 0 }), "UNALLOCATED");
  assertOk(await fake.alloc({ size: 8, metadata: new Uint8Array(0) }));
  assertCode(await fake.listen({ since: -1 }), "INVALID");
  assertCode(
    await fake.listen({ since: 0, timeoutMs: LIMITS.listenTimeoutMs + 1 }),
    "INVALID",
  );

  let started = performance.now();
  assertEquals(await fake.listen({ since: 0, timeoutMs: 50 }), {
    ok: true,
    writes: 0,
    changed: false,
  });
  assert(elapsed(started) >= 45, "the timeout was honoured");
  assertEquals(fake.waiting, 0);

  started = performance.now();
  const parked = fake.listen({ since: 0, timeoutMs: 5_000 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assertEquals(fake.waiting, 1);
  const round = assertOk(await fake.capture({ start: 0, end: 8 })).captureId;
  assertOk(await fake.trim({ through: 0 }));
  assertCode(
    await fake.write({ start: 1, values: [new Uint8Array(1)], captureId: 99 }),
    "INVALID",
  );
  assertEquals(fake.waiting, 1, "capture, trim, and refusals wake nobody");
  assertOk(
    await fake.write({
      start: 1,
      values: [new Uint8Array([1]), new Uint8Array([2])],
      captureId: round,
    }),
  );
  assertEquals(await parked, { ok: true, writes: 2, changed: true });
  assert(elapsed(started) < 1_000, "the write released the listener");
  assertEquals(fake.waiting, 0);

  // A counter already past `since` answers without parking.
  assertEquals(await fake.listen({ since: 1, timeoutMs: 5_000 }), {
    ok: true,
    writes: 2,
    changed: true,
  });
  assertEquals(fake.waiting, 0);
});

Deno.test("each listener wakes only once the counter passes its own since", async () => {
  const fake = new FakeSegment();
  assertOk(await fake.alloc({ size: 8, metadata: new Uint8Array(0) }));
  const round = assertOk(await fake.capture({ start: 0, end: 8 })).captureId;
  const write = (start: number) =>
    fake.write({ start, values: [new Uint8Array([start])], captureId: round });
  assertOk(await write(0));
  const near = fake.listen({ since: 1, timeoutMs: 5_000 });
  const far = fake.listen({ since: 2, timeoutMs: 5_000 });
  // Ahead of the counter: waits for whatever comes next.
  const ahead = fake.listen({ since: 7, timeoutMs: 100 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals(fake.waiting, 3);
  assertOk(await write(1));
  assertEquals(await near, { ok: true, writes: 2, changed: true });
  assertEquals(fake.waiting, 2, "far and ahead are still parked");
  assertOk(await write(2));
  assertEquals(await far, { ok: true, writes: 3, changed: true });
  assertEquals(await ahead, { ok: true, writes: 3, changed: false });
  assertEquals(fake.waiting, 0);
});

Deno.test("a write whose reply is lost still wakes its listeners", async () => {
  const segments = new FakeSegments();
  const fake = segments.get("lost");
  assertOk(await fake.alloc({ size: 4, metadata: new Uint8Array(0) }));
  const parked = fake.listen({ since: 0, timeoutMs: 5_000 });
  segments.faults = (method) => method === "write" ? "lost" : undefined;
  let thrown = false;
  try {
    await fake.write({ start: 0, values: [new Uint8Array(1)], captureId: 0 });
  } catch {
    thrown = true;
  }
  assert(thrown, "the writer lost its reply");
  assertEquals(await parked, { ok: true, writes: 1, changed: true });
});
