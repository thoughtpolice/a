// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * WormLog over the fake segments: the sequencer core, the client library,
 * and the faults between them.
 *
 * @module
 */

import { decodeEntry } from "@wormspace/layers/entry";
import {
  DEFAULT_SEGMENT_SIZE,
  SequencerCore,
} from "@wormspace/layers/sequencer_core";
import { WormLog } from "@wormspace/layers/wormlog";
import { assert, assertCode, assertEquals, assertOk } from "@celld/assert";
import { FakeSegments } from "@wormspace/testing/fake_segment";
import { FaultySequencer, MemorySequencerStore } from "./memory_stores.ts";

const FAST = { attempts: 5, pauseMs: 0 };
const text = new TextEncoder();

function bytes(value: string): Uint8Array {
  return text.encode(value);
}

function setup(options: { log?: string; size?: number } = {}) {
  const log = options.log ?? "log";
  const segments = new FakeSegments();
  const store = new MemorySequencerStore();
  const core = new SequencerCore(store, segments.resolve, FAST);
  const sequencer = new FaultySequencer(core);
  const wormlog = new WormLog(sequencer, segments.resolve, log, FAST);
  return { log, segments, store, core, sequencer, wormlog };
}

async function sized(size: number) {
  const world = setup();
  assertOk(await world.wormlog.init(size));
  return world;
}

/** Every issued slot, read in pages. */
async function readAll(wormlog: WormLog, from = 0) {
  const entries = [];
  for (;;) {
    const page = assertOk(await wormlog.read({ from, count: 1000 }));
    entries.push(...page.entries);
    if (page.entries.length === 0) return entries;
    from = page.entries[page.entries.length - 1].slot + 1;
    if (from >= page.next) return entries;
  }
}

function valueAt(
  entries: { slot: number; state: string; value?: Uint8Array }[],
  slot: number,
) {
  return entries.find((entry) => entry.slot === slot);
}

Deno.test("sequential appends land at increasing slots and read back", async () => {
  const { wormlog, segments } = setup();
  for (let index = 0; index < 5; index += 1) {
    assertEquals(
      await wormlog.append(bytes(`record-${index}`)),
      { ok: true, slot: index, attempts: 1 },
    );
  }
  const read = assertOk(await wormlog.read({ from: 0 }));
  assertEquals(read.size, DEFAULT_SEGMENT_SIZE, "the default size");
  assertEquals(read.next, 5);
  assertEquals(
    read.entries.map((entry) => [entry.slot, entry.state, entry.value]),
    [0, 1, 2, 3, 4].map((slot) => [slot, "value", bytes(`record-${slot}`)]),
  );
  // One allocation and one whole-segment capture, then one write per append.
  assertEquals(segments.count("alloc"), 1);
  assertEquals(segments.count("capture"), 1);
  assertEquals(segments.count("write"), 5);
  const status = assertOk(await segments.get("log.0").status());
  assertEquals(status.allocator, "sequencer:log");
  assertEquals(status.captures, 1);
});

Deno.test("an append is one sequencer call and one write once the segment is open", async () => {
  const { wormlog, segments, sequencer } = await sized(8);
  assertOk(await wormlog.append(bytes("first")));
  const before = segments.calls.length;
  sequencer.calls.length = 0;
  assertOk(await wormlog.append(bytes("second")));
  assertEquals(sequencer.calls, ["next"]);
  assertEquals(
    segments.calls.slice(before).map((call) => call.method),
    ["write"],
  );
});

Deno.test("init fixes the size before the first slot and refuses a change after", async () => {
  const { wormlog, segments, log } = setup();
  assertEquals(assertOk(await wormlog.init(4)).size, 4);
  assertEquals(assertOk(await wormlog.init(4)).size, 4, "idempotent");
  assertEquals(assertOk(await wormlog.init(6)).size, 6, "still unused");
  assertOk(await wormlog.append(bytes("x")));
  const refused = await wormlog.init(4);
  assertCode(refused, "CONFLICT");
  assertEquals((refused as { size: number }).size, 6);
  assertEquals(assertOk(await wormlog.init(6)).next, 1);
  assertCode(await wormlog.init(0), "INVALID");
  assertCode(await wormlog.init(65_537), "INVALID");

  // A fresh sequencer defers to a link 0 somebody else allocated.
  const other = new SequencerCore(
    new MemorySequencerStore(),
    segments.resolve,
    FAST,
  );
  const refusedByChain = await other.init({ log, size: 5 });
  assertCode(refusedByChain, "CONFLICT");
  assertEquals((refusedByChain as { size: number }).size, 6);
});

Deno.test("the sequencer serves one log and checks every name", async () => {
  const { core, wormlog } = setup();
  assertOk(await wormlog.append(bytes("x")));
  assertCode(await core.next({ log: "other" }), "INVALID");
  assertCode(await core.tail({ log: "Bad" }), "INVALID");
  assertCode(await core.next({} as never), "INVALID");
  assertCode(
    await core.recapture({ log: "log", index: 7, captureId: 1 }),
    "INVALID",
  );
  assertCode(
    await core.recapture({ log: "log", index: -1, captureId: 1 }),
    "INVALID",
  );
});

Deno.test("concurrent appenders never share a slot, across segment boundaries", async () => {
  const { wormlog, segments } = await sized(3);
  const results = await Promise.all(
    Array.from(
      { length: 40 },
      (_, index) => wormlog.append(bytes(`a${index}`)),
    ),
  );
  const slots = results.map((result) => assertOk(result).slot);
  assertEquals(new Set(slots).size, 40, "40 distinct slots");
  assertEquals([...slots].sort((a, b) => a - b), [...Array(40).keys()]);
  const entries = await readAll(wormlog);
  for (const [index, slot] of slots.entries()) {
    assertEquals(valueAt(entries, slot)?.value, bytes(`a${index}`));
  }
  // Each of the 14 links was allocated and captured exactly once.
  assertEquals(segments.count("alloc"), 14);
  assertEquals(segments.count("capture"), 14);
});

Deno.test("a lost token leaves a pending slot that fill closes", async () => {
  const { wormlog, sequencer } = await sized(4);
  let lost = false;
  sequencer.faults = (method) => {
    if (method === "next" && !lost) {
      lost = true;
      return "lost";
    }
    return undefined;
  };
  assertEquals(await wormlog.append(bytes("mine")), {
    ok: true,
    slot: 1,
    attempts: 1,
  });
  let entries = await readAll(wormlog);
  assertEquals(entries.map((entry) => entry.state), ["pending", "value"]);
  assertEquals(await wormlog.fill(0), { ok: true, slot: 0, hole: true });
  assertEquals(await wormlog.fill(0), { ok: true, slot: 0, hole: true });
  assertEquals(await wormlog.fill(1), { ok: true, slot: 1, hole: false });
  entries = await readAll(wormlog);
  assertEquals(entries.map((entry) => entry.state), ["hole", "value"]);
  assertEquals(entries[1].value, bytes("mine"));
});

Deno.test("a write whose reply is lost is replayed and lands once", async () => {
  const { wormlog, segments } = await sized(4);
  let lost = 0;
  segments.faults = (method) => {
    if (method === "write" && lost < 1) {
      lost += 1;
      return "lost";
    }
    return undefined;
  };
  assertEquals(await wormlog.append(bytes("once")), {
    ok: true,
    slot: 0,
    attempts: 1,
  });
  assertEquals(segments.count("write"), 2, "the write and its replay");
  assertEquals(assertOk(await segments.get("log.0").status()).writes, 1);
  assertEquals(
    (await readAll(wormlog)).map((entry) => entry.state),
    ["value"],
  );
});

Deno.test("a write that never reached the segment is simply repeated", async () => {
  const { wormlog, segments } = await sized(4);
  let thrown = 0;
  segments.faults = (method) => {
    if (method === "write" && thrown < 2) {
      thrown += 1;
      return "throw";
    }
    return undefined;
  };
  assertEquals(assertOk(await wormlog.append(bytes("x"))).slot, 0);
  // Past the budget, the error reaches the caller.
  segments.faults = (method) => method === "write" ? "throw" : undefined;
  let error: unknown;
  try {
    await wormlog.append(bytes("y"));
  } catch (caught) {
    error = caught;
  }
  assertEquals((error as { code?: string }).code, "owner_unreachable");
});

Deno.test("a stale capture is recaptured once and the append moves on", async () => {
  const { wormlog, segments, sequencer, store } = await sized(4);
  assertOk(await wormlog.append(bytes("before")));
  const round = store.captureOf(0) as number;
  let injected = false;
  segments.faults = (method) => {
    if (method === "write" && !injected) {
      injected = true;
      return {
        ok: false,
        code: "CAPTURE_STALE",
        message: "injected",
        offset: 1,
        round: round + 1,
        captureId: round,
      };
    }
    return undefined;
  };
  sequencer.calls.length = 0;
  assertEquals(await wormlog.append(bytes("after")), {
    ok: true,
    slot: 2,
    attempts: 2,
  });
  assertEquals(sequencer.calls, ["next", "recapture", "next"]);
  assert((store.captureOf(0) as number) > round, "a new round is held");
  // The refused slot never landed; fill closes it under the new round.
  assertEquals(await wormlog.fill(1), { ok: true, slot: 1, hole: true });
  assertEquals(
    (await readAll(wormlog)).map((entry) => entry.state),
    ["value", "hole", "value"],
  );
});

Deno.test("an operator's steal is survived: appends and fills recapture", async () => {
  const { wormlog, segments, core, store } = await sized(4);
  assertOk(await wormlog.append(bytes("a")));
  const token = assertOk(await core.next({ log: "log" }));
  assertOk(
    await segments.get("log.0").capture({ start: 0, end: 4, owner: "op" }),
  );
  assertOk(await wormlog.append(bytes("b")));
  const held = store.captureOf(0) as number;
  assert(held > token.captureId + 1, "recaptured past the operator's round");
  // The slot handed out before the steal is filled under the new round.
  assertEquals(await wormlog.fill(token.slot), {
    ok: true,
    slot: token.slot,
    hole: true,
  });
  // A second recapture report for the old round is answered, not repeated.
  assertEquals(
    await core.recapture({ log: "log", index: 0, captureId: token.captureId }),
    { ok: true, index: 0, captureId: held },
  );
  assertEquals(store.captureOf(0), held);
});

Deno.test("a slot filled under a slow appender costs it a new slot", async () => {
  const { wormlog, core, segments } = await sized(4);
  const token = assertOk(await core.next({ log: "log" }));
  assertEquals(await wormlog.fill(token.slot), {
    ok: true,
    slot: 0,
    hole: true,
  });
  const late = await segments.get(token.segment).write({
    start: token.offset,
    values: [bytes("\u0000late")],
    captureId: token.captureId,
  });
  assertCode(late, "ALREADY_WRITTEN");
  // Through the library, the same race costs one more token.
  let injected = false;
  segments.faults = (method) => {
    if (method === "write" && !injected) {
      injected = true;
      return {
        ok: false,
        code: "ALREADY_WRITTEN",
        message: "injected",
        offset: 1,
        sameValue: false,
      };
    }
    return undefined;
  };
  assertEquals(await wormlog.append(bytes("x")), {
    ok: true,
    slot: 2,
    attempts: 2,
  });
});

Deno.test("fill refuses unissued and trimmed slots and survives a lost reply", async () => {
  const { wormlog, core, sequencer } = await sized(4);
  assertCode(await wormlog.fill(0), "INVALID");
  assertOk(await core.next({ log: "log" }));
  let lost = false;
  sequencer.faults = (method) => {
    if (method === "fill" && !lost) {
      lost = true;
      return "lost";
    }
    return undefined;
  };
  assertEquals(await wormlog.fill(0), { ok: true, slot: 0, hole: true });
  assertCode(await wormlog.fill(1), "INVALID");
  assertCode(await wormlog.fill(-1), "INVALID");
});

Deno.test("reads cross segment boundaries and report pending slots", async () => {
  const { wormlog, core } = await sized(4);
  for (let index = 0; index < 6; index += 1) {
    assertOk(await wormlog.append(bytes(`r${index}`)));
  }
  const issued = assertOk(await core.next({ log: "log" }));
  assertOk(await wormlog.append(bytes("r7")));
  const window = assertOk(await wormlog.read({ from: 2, count: 5 }));
  assertEquals(
    window.entries.map((entry) => [entry.slot, entry.state]),
    [[2, "value"], [3, "value"], [4, "value"], [5, "value"], [
      issued.slot,
      "pending",
    ]],
  );
  // A read never reports slots past `next`.
  const end = assertOk(await wormlog.read({ from: 7, count: 100 }));
  assertEquals(end.entries.map((entry) => entry.slot), [7]);
  assertEquals(assertOk(await wormlog.read({ from: 50 })).entries, []);
  assertCode(await wormlog.read({ from: -1 }), "INVALID");
  assertCode(await wormlog.read({ from: 0, count: 0 }), "INVALID");
  assertCode(await wormlog.read({ from: 0, count: 1001 }), "INVALID");
});

Deno.test("a read passes each segment's barrier before reporting what it wrote", async () => {
  const { wormlog, segments } = await sized(4);
  for (let index = 0; index < 6; index += 1) {
    assertOk(await wormlog.append(bytes(`r${index}`)));
  }
  const before = segments.calls.length;
  assertOk(await wormlog.read({ from: 0, count: 6 }));
  assertEquals(
    segments.calls.slice(before).map((call) => [call.name, call.method]),
    [
      ["log.0", "read"],
      ["log.0", "listen"],
      ["log.1", "read"],
      ["log.1", "listen"],
    ],
  );
  assertEquals(
    segments.calls.slice(before).filter((call) => call.method === "listen")
      .map((call) => call.request),
    [{ since: 0, timeoutMs: 0 }, { since: 0, timeoutMs: 0 }],
  );
});

Deno.test("a register that is not an entry reads as corrupt", async () => {
  const { wormlog, core, segments } = await sized(4);
  const token = assertOk(await core.next({ log: "log" }));
  assertOk(
    await segments.get(token.segment).write({
      start: token.offset,
      values: [new Uint8Array([9, 9])],
      captureId: token.captureId,
    }),
  );
  assertCode(decodeEntry(new Uint8Array([9, 9])), "INVALID");
  assertEquals(
    assertOk(await wormlog.read({ from: 0 })).entries,
    [{ slot: 0, state: "corrupt" }],
  );
});

Deno.test("trim removes whole segments below and part of the boundary one", async () => {
  const { wormlog, segments } = await sized(4);
  for (let index = 0; index < 10; index += 1) {
    assertOk(await wormlog.append(bytes(`r${index}`)));
  }
  assertCode(await wormlog.trim(10), "INVALID");
  const trimmed = assertOk(await wormlog.trim(5));
  assertEquals(trimmed.trimmedThrough, 5);
  assertEquals(
    assertOk(await segments.get("log.0").status()).trimmedThrough,
    3,
  );
  assertEquals(
    assertOk(await segments.get("log.1").status()).trimmedThrough,
    1,
  );
  assertEquals(
    assertOk(await segments.get("log.2").status()).trimmedThrough,
    -1,
  );
  const gone = await wormlog.read({ from: 5 });
  assertCode(gone, "TRIMMED");
  assertEquals((gone as { trimmedThrough: number }).trimmedThrough, 5);
  assertEquals(
    assertOk(await wormlog.read({ from: 6 })).entries.map((entry) =>
      entry.value
    ),
    [6, 7, 8, 9].map((slot) => bytes(`r${slot}`)),
  );
  assertCode(await wormlog.fill(5), "TRIMMED");
  // Monotone and idempotent.
  assertEquals(assertOk(await wormlog.trim(2)).trimmedThrough, 5);
  assertEquals(assertOk(await wormlog.trim(9)).trimmedThrough, 9);
  assertEquals(
    assertOk(await segments.get("log.2").status()).trimmedThrough,
    1,
  );
  assertEquals(assertOk(await wormlog.append(bytes("after"))).slot, 10);
  assertEquals(
    assertOk(await wormlog.read({ from: 10 })).entries[0].value,
    bytes("after"),
  );
});

Deno.test("a trim that failed before recording its mark is redone whole", async () => {
  const { wormlog, segments, sequencer } = await sized(4);
  for (let index = 0; index < 8; index += 1) {
    assertOk(await wormlog.append(bytes(`r${index}`)));
  }
  sequencer.faults = (method) => method === "trimmed" ? "throw" : undefined;
  let error: unknown;
  try {
    await wormlog.trim(6);
  } catch (caught) {
    error = caught;
  }
  assert(error !== undefined, "the trim failed");
  assertEquals(assertOk(await wormlog.tail()).trimmedThrough, -1);
  sequencer.faults = undefined;
  assertEquals(assertOk(await wormlog.trim(6)).trimmedThrough, 6);
  assertEquals(
    assertOk(await segments.get("log.1").status()).trimmedThrough,
    2,
  );
});

Deno.test("listen parks on the segment holding a slot until it is written", async () => {
  const { wormlog } = await sized(4);
  assertOk(await wormlog.append(bytes("a")));
  const since = assertOk(
    await wormlog.listen({ from: 1, since: 0, timeoutMs: 0 }),
  );
  assertEquals(since, { ok: true, index: 0, writes: 1, changed: true });
  const parked = wormlog.listen({ from: 1, since: 1, timeoutMs: 5_000 });
  assertOk(await wormlog.append(bytes("b")));
  assertEquals(await parked, { ok: true, index: 0, writes: 2, changed: true });
  assertCode(
    await wormlog.listen({ from: 4, since: 0, timeoutMs: 0 }),
    "UNALLOCATED",
  );
  assertCode(
    await wormlog.listen({ from: 0, since: -1, timeoutMs: 0 }),
    "INVALID",
  );
});

Deno.test("a restarted sequencer continues from its store", async () => {
  const { wormlog, segments, store } = await sized(4);
  for (let index = 0; index < 3; index += 1) {
    assertOk(await wormlog.append(bytes(`r${index}`)));
  }
  const restarted = new WormLog(
    new SequencerCore(store, segments.resolve, FAST),
    segments.resolve,
    "log",
    FAST,
  );
  assertEquals(assertOk(await restarted.append(bytes("r3"))).slot, 3);
  assertEquals(segments.count("capture"), 1, "its round is still held");
  assertEquals(assertOk(await restarted.append(bytes("r4"))).slot, 4);
  assertEquals(segments.count("capture"), 2, "the next link, once");
  assert(store.barriers >= 5, "every issued slot passed a barrier");
});

Deno.test("oversized records are refused before any slot is taken", async () => {
  const { wormlog, sequencer } = await sized(4);
  assertCode(await wormlog.append(new Uint8Array(1024 * 1024)), "TOO_LARGE");
  assertEquals(sequencer.calls, ["init"]);
});
