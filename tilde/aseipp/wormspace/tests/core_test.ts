// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Transition-by-transition contracts for the segment's decision core.
 *
 * These are the rules a user of the service has to trust: who wins an
 * allocation, what a round means, when a write lands, what a replay learns,
 * and when bytes may be deleted. They run without celld because `core.ts`
 * never touches the platform. `Store` below is the whole of storage for these
 * tests: it applies an outcome's write set and builds each view the way the
 * Durable Object's queries do.
 *
 * @module
 */

import * as core from "@wormspace/segment/core";
import {
  type CaptureRow,
  type Meta,
  type Outcome,
  type Range,
  type RegisterRow,
} from "@wormspace/segment/core";
import {
  type CaptureRequest,
  LIMITS,
  type ListenRequest,
  type ReadRequest,
  type TrimRequest,
  type WriteRequest,
} from "@wormspace/segment/types";
import { assert, assertCode, assertEquals, assertOk } from "@celld/assert";

const T0 = 1_700_000_000_000;

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

/** Storage as the Durable Object's tables hold it. */
class Store {
  meta: Meta = core.INITIAL_META;
  captures: CaptureRow[] = [];
  registers = new Map<number, RegisterRow>();
  syncs = 0;

  apply<R>(outcome: Outcome<R>): R {
    if (outcome.meta === this.meta) return outcome.result;
    const prune = outcome.pruneCaptures;
    if (prune !== undefined) {
      this.captures = this.captures.filter((row) =>
        !(row.start >= prune.start && row.end <= prune.end)
      );
    }
    const captured = outcome.insertCapture;
    if (captured !== undefined) {
      this.captures.push({
        round: captured.round,
        start: captured.start,
        end: captured.end,
      });
    }
    for (const row of outcome.insertRegisters ?? []) {
      assert(!this.registers.has(row.offset), "a register was written twice");
      this.registers.set(row.offset, {
        offset: row.offset,
        round: row.round,
        value: row.value,
      });
    }
    const through = outcome.deleteThrough;
    if (through !== undefined) {
      for (const offset of [...this.registers.keys()]) {
        if (offset <= through) this.registers.delete(offset);
      }
      this.captures = this.captures.filter((row) => row.end > through + 1);
    }
    this.meta = outcome.meta;
    this.syncs += 1;
    return outcome.result;
  }

  written(range: Range): RegisterRow[] {
    return [...this.registers.values()]
      .filter((row) => row.offset >= range.start && row.offset < range.end)
      .sort((left, right) => left.offset - right.offset);
  }

  overlapping(range: Range): CaptureRow[] {
    return this.captures.filter((row) =>
      row.start < range.end && row.end > range.start
    );
  }

  alloc(size: number, allocator = "alpha", metadata = bytes(1, 2, 3)) {
    return this.apply(core.alloc(this.meta, { size, metadata, allocator }, T0));
  }

  captureOutcome(request: CaptureRequest) {
    const range = core.captureScope(this.meta, request);
    const view = range === null ? core.EMPTY_CAPTURE_VIEW : {
      writtenInRange: this.written(range).length,
      liveCaptures: this.captures.length,
      dominated:
        this.captures.filter((row) =>
          row.start >= range.start && row.end <= range.end
        ).length,
    };
    return core.capture(this.meta, request, view, T0);
  }

  capture(request: CaptureRequest) {
    return this.apply(this.captureOutcome(request));
  }

  writeOutcome(request: WriteRequest) {
    const range = core.writeScope(this.meta, request);
    const view = range === null ? core.EMPTY_WRITE_VIEW : {
      existing: new Map(
        this.written(range).map((row) => [row.offset, row.value]),
      ),
      captures: this.overlapping(range),
    };
    return core.write(this.meta, request, view, T0);
  }

  write(request: WriteRequest) {
    return this.apply(this.writeOutcome(request));
  }

  read(request: ReadRequest) {
    const plan = core.planRead(this.meta, request);
    if (plan.kind === "reply") return plan.result;
    const sizes = this.written(plan).map((row) => ({
      offset: row.offset,
      bytes: row.value.byteLength,
    }));
    const window = { start: plan.start, end: core.readWindow(plan, sizes) };
    return core.finishRead(
      this.meta,
      window,
      this.written(window),
      this.overlapping(window),
    );
  }

  trimOutcome(request: TrimRequest) {
    const through = core.trimScope(this.meta, request);
    const view = through === null ? core.EMPTY_TRIM_VIEW : {
      writtenThrough:
        [...this.registers.keys()].filter((offset) => offset <= through).length,
    };
    return core.trim(this.meta, request, view);
  }

  trim(request: TrimRequest) {
    return this.apply(this.trimOutcome(request));
  }
}

function allocated(size = 16): Store {
  const store = new Store();
  assertOk(store.alloc(size));
  return store;
}

Deno.test("a fresh segment reports nothing allocated", () => {
  assertEquals(core.status(core.INITIAL_META, 0, 4096), {
    ok: true,
    allocated: false,
    size: 0,
    metadata: null,
    allocator: null,
    allocatedMs: 0,
    nextRound: 1,
    writtenCount: 0,
    writes: 0,
    captures: 0,
    trimmedThrough: -1,
    databaseSize: 4096,
  });
});

Deno.test("the first allocation wins and every later one learns it", () => {
  const store = new Store();
  const first = core.alloc(
    store.meta,
    { size: 8, metadata: bytes(7), allocator: "alpha" },
    T0,
  );
  assertEquals(first.result, { ok: true, size: 8, allocatedMs: T0 });
  store.apply(first);

  const second = core.alloc(
    store.meta,
    { size: 32, metadata: bytes(9, 9), allocator: "beta" },
    T0 + 5,
  );
  assertEquals(second.result, {
    ok: false,
    code: "ALREADY_ALLOCATED",
    message: "the segment is already allocated",
    size: 8,
    metadata: bytes(7),
    allocator: "alpha",
    allocatedMs: T0,
  });
  assert(second.meta === store.meta, "a losing alloc changes nothing");

  // The winner's own replay is the paper's `check`: it sees itself.
  const replay = core.alloc(
    store.meta,
    { size: 8, metadata: bytes(7), allocator: "alpha" },
    T0 + 9,
  );
  assertCode(replay.result, "ALREADY_ALLOCATED");
  assert(replay.meta === store.meta, "a replayed alloc changes nothing");

  const anonymous = new Store();
  anonymous.apply(
    core.alloc(anonymous.meta, { size: 1, metadata: bytes() }, T0),
  );
  assertEquals(anonymous.meta.allocator, null);
  assertEquals(anonymous.meta.metadata, bytes());
});

Deno.test("alloc requests are validated", () => {
  const cases: [string, unknown][] = [
    ["INVALID", { size: 0, metadata: bytes() }],
    ["INVALID", { size: LIMITS.maxSize + 1, metadata: bytes() }],
    ["INVALID", { size: 1.5, metadata: bytes() }],
    ["INVALID", { size: "8", metadata: bytes() }],
    ["INVALID", { size: 8 }],
    ["INVALID", { size: 8, metadata: "abc" }],
    ["INVALID", { size: 8, metadata: bytes(), allocator: "" }],
    ["INVALID", {
      size: 8,
      metadata: bytes(),
      allocator: "x".repeat(LIMITS.nameChars + 1),
    }],
    ["TOO_LARGE", {
      size: 8,
      metadata: new Uint8Array(LIMITS.metadataBytes + 1),
    }],
    ["INVALID", null],
  ];
  for (const [code, request] of cases) {
    const outcome = core.alloc(
      core.INITIAL_META,
      request as Parameters<typeof core.alloc>[1],
      T0,
    );
    assertCode(outcome.result, code);
    assert(outcome.meta === core.INITIAL_META, `${code} changed meta`);
  }
  const edge = core.alloc(core.INITIAL_META, {
    size: LIMITS.maxSize,
    metadata: new Uint8Array(LIMITS.metadataBytes),
    allocator: "x".repeat(LIMITS.nameChars),
  }, T0);
  assertOk(edge.result);
});

Deno.test("every operation on an unallocated segment is UNALLOCATED", () => {
  const store = new Store();
  assertCode(store.capture({ start: 0 }), "UNALLOCATED");
  assertCode(
    store.write({ start: 0, values: [bytes(1)], captureId: 0 }),
    "UNALLOCATED",
  );
  assertCode(store.read({ start: 0 }), "UNALLOCATED");
  assertCode(store.trim({ through: 0 }), "UNALLOCATED");
  assertEquals(store.syncs, 0, "nothing was persisted");
});

Deno.test("captures take strictly increasing rounds", () => {
  const store = allocated();
  const rounds: number[] = [];
  for (const request of [{ start: 0 }, { start: 0, end: 16 }, { start: 3 }]) {
    const result = assertOk(store.capture({ ...request, owner: "alpha" }));
    rounds.push(result.captureId);
  }
  assertEquals(rounds, [1, 2, 3]);
  assertEquals(store.meta.nextRound, 4);

  const single = assertOk(allocated().capture({ start: 5 }));
  assertEquals(
    [single.start, single.end, single.alreadyWritten],
    [5, 6, 0],
    "end defaults to start + 1",
  );
});

Deno.test("a batch capture is one row, and dominated rows are pruned", () => {
  const store = allocated();
  store.capture({ start: 2 });
  store.capture({ start: 4, end: 8 });
  store.capture({ start: 10, end: 16 });
  assertEquals(store.captures.length, 3);
  const batch = store.captureOutcome({ start: 0, end: 16, owner: "leader" });
  assertEquals(batch.pruneCaptures, { start: 0, end: 16 });
  assertEquals(batch.insertCapture, {
    round: 4,
    start: 0,
    end: 16,
    owner: "leader",
    capturedMs: T0,
  });
  store.apply(batch);
  assertEquals(store.captures, [{ round: 4, start: 0, end: 16 }]);

  // A partial overlap is not dominated and stays.
  store.capture({ start: 6, end: 10 });
  const wide = store.captureOutcome({ start: 0, end: 8 });
  assert(wide.pruneCaptures === undefined, "no row lies inside [0, 8)");
});

Deno.test("capture reports how much of its range is already immutable", () => {
  const store = allocated();
  assertOk(
    store.write({ start: 1, values: [bytes(1), bytes(2)], captureId: 0 }),
  );
  const result = assertOk(store.capture({ start: 0, end: 4 }));
  assertEquals(result.alreadyWritten, 2);
});

Deno.test("capture requests are validated against the segment", () => {
  const store = allocated(8);
  const cases: [string, unknown][] = [
    ["INVALID", { start: -1 }],
    ["INVALID", { start: 1.5 }],
    ["INVALID", { start: "0" }],
    ["INVALID", {}],
    ["INVALID", { start: 3, end: 3 }],
    ["INVALID", { start: 3, end: 2 }],
    ["INVALID", { start: 3, end: 4.5 }],
    ["INVALID", { start: 0, owner: "" }],
    ["INVALID", { start: 0, owner: 7 }],
    ["INVALID", { start: 0, owner: "x".repeat(LIMITS.nameChars + 1) }],
    ["OUT_OF_RANGE", { start: 8 }],
    ["OUT_OF_RANGE", { start: 0, end: 9 }],
  ];
  for (const [code, request] of cases) {
    const outcome = store.captureOutcome(request as CaptureRequest);
    assertCode(outcome.result, code);
    assert(outcome.meta === store.meta, `${code} changed meta`);
  }
  assertOk(store.capture({ start: 0, end: 8 }));
});

Deno.test("the live capture rows are capped, counting what a capture prunes", () => {
  const store = allocated(LIMITS.liveCaptures + 8);
  for (let offset = 0; offset < LIMITS.liveCaptures; offset += 1) {
    store.captures.push({ round: offset + 1, start: offset, end: offset + 1 });
  }
  store.meta = { ...store.meta, nextRound: LIMITS.liveCaptures + 1 };
  const over = store.captureOutcome({ start: LIMITS.liveCaptures });
  assertCode(over.result, "TOO_LARGE");
  assert(over.meta === store.meta, "a refused capture changes nothing");

  // A capture that swallows rows frees room for itself.
  const merged = assertOk(store.capture({ start: 0, end: 2 }));
  assertEquals(merged.captureId, LIMITS.liveCaptures + 1);
  assertEquals(store.captures.length, LIMITS.liveCaptures - 1);
});

Deno.test("an unsafe write lands only on a register nobody ever captured", () => {
  const store = allocated();
  assertEquals(
    store.write({ start: 0, values: [bytes(1)], captureId: 0 }),
    { ok: true, start: 0, end: 1 },
  );
  const round = assertOk(store.capture({ start: 1 })).captureId;
  const refused = store.writeOutcome({
    start: 1,
    values: [bytes(2)],
    captureId: 0,
  });
  assertEquals(refused.result, {
    ok: false,
    code: "CAPTURE_STALE",
    message: `register 1 is held by round ${round}, not 0`,
    offset: 1,
    round,
    captureId: 0,
  });
  assert(refused.meta === store.meta, "a refused write changes nothing");
});

Deno.test("a write with the current capture lands, with its round stamped", () => {
  const store = allocated();
  const round = assertOk(store.capture({ start: 0, end: 16 })).captureId;
  const outcome = store.writeOutcome({
    start: 2,
    values: [bytes(1), bytes(), bytes(0, 255)],
    captureId: round,
  });
  assertEquals(outcome.result, { ok: true, start: 2, end: 5 });
  assertEquals(outcome.insertRegisters, [
    { offset: 2, round, value: bytes(1), writtenMs: T0 },
    { offset: 3, round, value: bytes(), writtenMs: T0 },
    { offset: 4, round, value: bytes(0, 255), writtenMs: T0 },
  ]);
  store.apply(outcome);
  assertEquals(store.meta.writtenCount, 3);
});

Deno.test("a stolen capture is stale and names the round that took it", () => {
  const store = allocated();
  const mine = assertOk(store.capture({ start: 0, end: 16, owner: "a" }));
  const theirs = assertOk(store.capture({ start: 4, end: 6, owner: "b" }));
  assertOk(
    store.write({ start: 0, values: [bytes(1)], captureId: mine.captureId }),
  );
  const stale = store.writeOutcome({
    start: 4,
    values: [bytes(2)],
    captureId: mine.captureId,
  });
  assertEquals(stale.result, {
    ok: false,
    code: "CAPTURE_STALE",
    message:
      `register 4 is held by round ${theirs.captureId}, not ${mine.captureId}`,
    offset: 4,
    round: theirs.captureId,
    captureId: mine.captureId,
  });
  // The stealer's round is effective only where it reached.
  assertCode(
    store.write({ start: 3, values: [bytes(3)], captureId: theirs.captureId }),
    "CAPTURE_STALE",
  );
  assertOk(
    store.write({ start: 4, values: [bytes(4)], captureId: theirs.captureId }),
  );
  assertOk(
    store.write({ start: 6, values: [bytes(6)], captureId: mine.captureId }),
  );
});

Deno.test("a written register refuses every write and reports whether it matched", () => {
  const store = allocated();
  const round = assertOk(store.capture({ start: 0, end: 4 })).captureId;
  assertOk(store.write({ start: 1, values: [bytes(9, 9)], captureId: round }));

  const replay = store.writeOutcome({
    start: 1,
    values: [bytes(9, 9)],
    captureId: round,
  });
  assertEquals(replay.result, {
    ok: false,
    code: "ALREADY_WRITTEN",
    message: "register 1 is already written",
    offset: 1,
    sameValue: true,
  });
  assert(replay.meta === store.meta, "a replay persists nothing");

  for (const value of [bytes(9), bytes(9, 8), bytes(9, 9, 9), bytes()]) {
    assertEquals(
      store.write({ start: 1, values: [value], captureId: round }),
      {
        ok: false,
        code: "ALREADY_WRITTEN",
        message: "register 1 is already written",
        offset: 1,
        sameValue: false,
      },
    );
  }

  // A written register is immune to later captures: a newer round cannot
  // overwrite it, and it still reads back with the round that wrote it.
  const later = assertOk(store.capture({ start: 0, end: 4 })).captureId;
  assertEquals(
    assertOk(store.capture({ start: 1 })).alreadyWritten,
    1,
  );
  assertCode(
    store.write({ start: 1, values: [bytes(1)], captureId: later }),
    "ALREADY_WRITTEN",
  );
  const register = assertOk(store.read({ start: 1, count: 1 })).registers[0];
  assertEquals(register, {
    offset: 1,
    state: "written",
    round,
    value: bytes(9, 9),
  });
});

Deno.test("a batch write is all or nothing", () => {
  const store = allocated();
  const round = assertOk(store.capture({ start: 0, end: 8 })).captureId;
  store.capture({ start: 5 });
  const before = store.meta;
  const stale = store.writeOutcome({
    start: 2,
    values: [bytes(2), bytes(3), bytes(4), bytes(5), bytes(6)],
    captureId: round,
  });
  assertCode(stale.result, "CAPTURE_STALE");
  assertEquals((stale.result as { offset: number }).offset, 5);
  assert(stale.meta === before, "the batch persisted nothing");
  assert(stale.insertRegisters === undefined, "no register is inserted");
  store.apply(stale);
  assertEquals(store.registers.size, 0);

  assertOk(store.write({ start: 3, values: [bytes(3)], captureId: round }));
  const written = store.writeOutcome({
    start: 2,
    values: [bytes(2), bytes(3), bytes(4)],
    captureId: round,
  });
  assertEquals(written.result, {
    ok: false,
    code: "ALREADY_WRITTEN",
    message: "register 3 is already written",
    offset: 3,
    sameValue: true,
  });
  assert(written.meta === store.meta, "the batch persisted nothing");
  assertEquals(store.meta.writtenCount, 1);
});

Deno.test("write requests are validated before any register is examined", () => {
  const store = allocated(8);
  const round = assertOk(store.capture({ start: 0, end: 8 })).captureId;
  const cases: [string, unknown][] = [
    ["INVALID", { start: -1, values: [bytes(1)], captureId: round }],
    ["INVALID", { start: 0.5, values: [bytes(1)], captureId: round }],
    ["INVALID", { start: 0, values: [], captureId: round }],
    ["INVALID", { start: 0, values: "x", captureId: round }],
    ["INVALID", { start: 0, values: ["text"], captureId: round }],
    ["INVALID", { start: 0, values: [bytes(1)] }],
    ["INVALID", { start: 0, values: [bytes(1)], captureId: -1 }],
    ["INVALID", { start: 0, values: [bytes(1)], captureId: 1.5 }],
    ["INVALID", { start: 0, values: [bytes(1)], captureId: round + 1 }],
    ["TOO_LARGE", {
      start: 0,
      values: Array.from({ length: LIMITS.batchValues + 1 }, () => bytes(1)),
      captureId: round,
    }],
    ["TOO_LARGE", {
      start: 0,
      values: [new Uint8Array(LIMITS.valueBytes + 1)],
      captureId: round,
    }],
    ["TOO_LARGE", {
      start: 0,
      values: Array.from(
        { length: 5 },
        () => new Uint8Array(LIMITS.valueBytes),
      ),
      captureId: round,
    }],
    ["OUT_OF_RANGE", { start: 8, values: [bytes(1)], captureId: round }],
    ["OUT_OF_RANGE", {
      start: 7,
      values: [bytes(1), bytes(2)],
      captureId: round,
    }],
  ];
  for (const [code, request] of cases) {
    const outcome = store.writeOutcome(request as WriteRequest);
    assertCode(outcome.result, code);
    assert(outcome.meta === store.meta, `${code} changed meta`);
  }
  assertEquals(
    core.writeScope(store.meta, { start: 7, values: [bytes()], captureId: 0 }),
    { start: 7, end: 8 },
  );
});

Deno.test("reads report every register in the window, holes included", () => {
  const store = allocated(8);
  assertOk(store.write({ start: 0, values: [bytes(0)], captureId: 0 }));
  const round = assertOk(store.capture({ start: 2, end: 5 })).captureId;
  assertOk(store.write({ start: 3, values: [bytes(3, 3)], captureId: round }));
  const later = assertOk(store.capture({ start: 4 })).captureId;
  assertEquals(store.read({ start: 0, count: 6 }), {
    ok: true,
    registers: [
      { offset: 0, state: "written", round: 0, value: bytes(0) },
      { offset: 1, state: "unwritten", round: 0 },
      { offset: 2, state: "captured", round },
      { offset: 3, state: "written", round, value: bytes(3, 3) },
      { offset: 4, state: "captured", round: later },
      { offset: 5, state: "unwritten", round: 0 },
    ],
    size: 8,
    trimmedThrough: -1,
  });
  const tail = assertOk(store.read({ start: 6, count: 100 }));
  assertEquals(
    tail.registers.map((register) => register.offset),
    [6, 7],
    "a read stops at the end of the segment",
  );
});

Deno.test("planRead validates and defaults its arguments", () => {
  const store = allocated(500);
  assertEquals(core.planRead(store.meta, { start: 10 }), {
    kind: "scan",
    start: 10,
    end: 10 + LIMITS.defaultReadCount,
    maxBytes: LIMITS.defaultReadBytes,
  });
  const cases: [string, unknown][] = [
    ["INVALID", { start: -1 }],
    ["INVALID", { start: "0" }],
    ["INVALID", { start: 0, count: 0 }],
    ["INVALID", { start: 0, count: LIMITS.readCount + 1 }],
    ["INVALID", { start: 0, count: 2.5 }],
    ["INVALID", { start: 0, maxBytes: 0 }],
    ["INVALID", { start: 0, maxBytes: LIMITS.readBytes + 1 }],
    ["OUT_OF_RANGE", { start: 500 }],
  ];
  for (const [code, request] of cases) {
    const plan = core.planRead(store.meta, request as ReadRequest);
    assert(plan.kind === "reply", `${code} never scans`);
    assertCode(plan.result, code);
  }
});

Deno.test("the read budget counts values, never starves, and never splits a hole", () => {
  const store = allocated(8);
  const values = [bytes(), new Uint8Array(10), new Uint8Array(10), bytes(1)];
  assertOk(store.write({ start: 0, values, captureId: 0 }));
  const window = (maxBytes: number, start = 0) =>
    assertOk(store.read({ start, count: 8, maxBytes })).registers.map((r) =>
      r.offset
    );
  assertEquals(window(25), [0, 1, 2, 3, 4, 5, 6, 7]);
  assertEquals(window(15), [0, 1]);
  assertEquals(window(1), [0], "an empty value fits, the next one does not");
  assertEquals(window(1, 1), [1], "the first register always comes back");
  assertEquals(window(9, 3), [3, 4, 5, 6, 7], "holes cost nothing");
  assertEquals(
    core.readWindow({ start: 0, end: 8, maxBytes: 5 }, [
      { offset: 4, bytes: 10 },
    ]),
    4,
    "a hole before an oversized value is returned without it",
  );
});

Deno.test("trim is monotone, idempotent, and deletes everything below its mark", () => {
  const store = allocated(10);
  const round = assertOk(store.capture({ start: 0, end: 3 })).captureId;
  assertOk(
    store.write({ start: 0, values: [bytes(0), bytes(1)], captureId: round }),
  );
  store.capture({ start: 2, end: 6 });
  assertOk(store.write({ start: 7, values: [bytes(7)], captureId: 0 }));
  assertEquals(store.meta.writtenCount, 3);

  const first = store.trimOutcome({ through: 2 });
  assertEquals(first.result, { ok: true, trimmedThrough: 2, deleted: 2 });
  assertEquals(first.deleteThrough, 2);
  store.apply(first);
  assertEquals(store.meta.writtenCount, 1);
  assertEquals(
    store.captures.map((row) => row.round),
    [2],
    "only the straddling capture survives",
  );

  for (const through of [2, 1, 0]) {
    const again = store.trimOutcome({ through });
    assertEquals(again.result, { ok: true, trimmedThrough: 2, deleted: 0 });
    assert(again.meta === store.meta, "a trim never moves backwards");
    assert(again.deleteThrough === undefined, "nothing is deleted again");
  }

  assertCode(store.trim({ through: 10 }), "OUT_OF_RANGE");
  assertCode(store.trim({ through: -1 }), "INVALID");
  assertCode(store.trim({ through: 1.5 }), "INVALID");
  assertEquals(store.trim({ through: 9 }), {
    ok: true,
    trimmedThrough: 9,
    deleted: 1,
  });
  assertEquals(store.meta.writtenCount, 0);
  assertEquals(store.captures, []);
});

Deno.test("trimmed positions are refused, and a straddling capture is clipped", () => {
  const store = allocated(10);
  store.trim({ through: 3 });
  for (const start of [0, 3]) {
    assertEquals(store.read({ start }), {
      ok: false,
      code: "TRIMMED",
      message: `offset ${start} is trimmed`,
      trimmedThrough: 3,
    });
    assertCode(
      store.write({ start, values: [bytes(1)], captureId: 0 }),
      "TRIMMED",
    );
  }
  assertCode(store.capture({ start: 0, end: 4 }), "TRIMMED");
  assertCode(store.capture({ start: 3 }), "TRIMMED");
  const clipped = assertOk(store.capture({ start: 1, end: 6 }));
  assertEquals([clipped.start, clipped.end], [4, 6]);
  assertEquals(store.captures, [
    { round: clipped.captureId, start: 4, end: 6 },
  ]);
  assertOk(
    store.write({ start: 4, values: [bytes(4)], captureId: clipped.captureId }),
  );
  assertEquals(
    assertOk(store.read({ start: 4, count: 1 })).registers[0].state,
    "written",
  );
});

Deno.test("transitions never mutate their inputs", () => {
  const store = allocated(8);
  const round = assertOk(store.capture({ start: 0, end: 8 })).captureId;
  const meta = Object.freeze({ ...store.meta });
  const values = Object.freeze([bytes(1), bytes(2)]) as unknown as Uint8Array[];
  const writeRequest = Object.freeze({ start: 0, values, captureId: round });
  const captures = Object.freeze([
    Object.freeze({ round, start: 0, end: 8 }),
  ]);
  const existing = new Map<number, Uint8Array>();
  const writeView = Object.freeze({ existing, captures });
  const outcome = core.write(meta, writeRequest, writeView, T0);
  assertEquals(assertOk(outcome.result).end, 2);
  assertEquals(meta.writtenCount, 0, "the input meta is untouched");
  assertEquals(existing.size, 0, "the view is untouched");

  const captureView = Object.freeze({
    writtenInRange: 0,
    liveCaptures: 1,
    dominated: 1,
  });
  core.capture(meta, Object.freeze({ start: 0, end: 8 }), captureView, T0);
  assertEquals(meta.nextRound, round + 1);

  core.alloc(
    Object.freeze({ ...core.INITIAL_META }),
    Object.freeze({ size: 4, metadata: bytes() }),
    T0,
  );
  core.trim(
    meta,
    Object.freeze({ through: 3 }),
    Object.freeze({
      writtenThrough: 0,
    }),
  );
  assertEquals(meta.trimmedThrough, -1);
  assertEquals(core.INITIAL_META.allocated, false);
  core.finishRead(meta, { start: 0, end: 8 }, Object.freeze([]), captures);
});

Deno.test("writes counts every register written, and nothing else moves it", () => {
  const store = allocated(8);
  assertEquals(store.meta.writes, 0);
  const round = assertOk(store.capture({ start: 0, end: 8 })).captureId;
  assertEquals(store.meta.writes, 0, "a capture writes nothing");
  assertOk(
    store.write({ start: 0, values: [bytes(1), bytes(2)], captureId: round }),
  );
  assertEquals(store.meta.writes, 2);
  assertCode(
    store.write({ start: 1, values: [bytes(2)], captureId: round }),
    "ALREADY_WRITTEN",
  );
  assertCode(
    store.write({ start: 2, values: [bytes(3)], captureId: round + 5 }),
    "INVALID",
  );
  assertEquals(store.meta.writes, 2, "a refused write counts nothing");
  assertOk(store.trim({ through: 1 }));
  assertEquals(store.meta.writtenCount, 0);
  assertEquals(store.meta.writes, 2, "a trim leaves the counter alone");
  assertOk(store.write({ start: 2, values: [bytes(3)], captureId: round }));
  assertEquals(store.meta.writes, 3);
  assertEquals(core.status(store.meta, 1, 0).writes, 3);
});

Deno.test("planListen validates, answers a passed counter, and parks otherwise", () => {
  const store = new Store();
  assertCode(
    assertListenReply(core.planListen(store.meta, { since: 0 })),
    "UNALLOCATED",
  );
  assertOk(store.alloc(4));
  for (
    const request of [
      {},
      { since: -1 },
      { since: 1.5 },
      { since: "0" },
      { since: 0, timeoutMs: -1 },
      { since: 0, timeoutMs: 0.5 },
      { since: 0, timeoutMs: LIMITS.listenTimeoutMs + 1 },
      { since: 0, timeoutMs: null },
    ]
  ) {
    assertCode(
      assertListenReply(
        core.planListen(store.meta, request as unknown as ListenRequest),
      ),
      "INVALID",
    );
  }
  assertEquals(core.planListen(store.meta, { since: 0 }), {
    kind: "wait",
    since: 0,
    timeoutMs: LIMITS.defaultListenTimeoutMs,
  });
  assertEquals(
    core.planListen(store.meta, {
      since: 0,
      timeoutMs: LIMITS.listenTimeoutMs,
    }),
    { kind: "wait", since: 0, timeoutMs: LIMITS.listenTimeoutMs },
  );
  assertEquals(core.planListen(store.meta, { since: 0, timeoutMs: 0 }), {
    kind: "wait",
    since: 0,
    timeoutMs: 0,
  });
  assertOk(store.write({ start: 0, values: [bytes(1)], captureId: 0 }));
  assertEquals(core.planListen(store.meta, { since: 0 }), {
    kind: "reply",
    result: { ok: true, writes: 1, changed: true },
  });
  // A caller ahead of the counter (a write it saw was never proven durable)
  // waits for the next one rather than being refused.
  assertEquals(core.planListen(store.meta, { since: 9 }).kind, "wait");
  assertEquals(core.listenReply(store.meta, 1), {
    ok: true,
    writes: 1,
    changed: false,
  });
  assertEquals(core.listenReply(store.meta, 0), {
    ok: true,
    writes: 1,
    changed: true,
  });
});

function assertListenReply(plan: core.ListenPlan) {
  assert(plan.kind === "reply", `expected a reply, got ${plan.kind}`);
  return plan.result;
}
