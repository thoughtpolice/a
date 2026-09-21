// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The coordinator over wormspace's fake segments: appends, sealing and
 * rollover, reads across links, trims, lost replies and the retry contract,
 * stolen captures, and recovering the cached head.
 *
 * The fakes run the segment's real decision core, so every register rule the
 * journal leans on (write-once, all-or-none batches, rounds, `sameValue`) is
 * the one the Durable Object enforces.
 *
 * @module
 */

import type { WriteRequest } from "@wormspace/segment/types";
import { UNAVAILABLE_PREFIX } from "@journal/http";
import type { LogCore } from "@journal/log";
import type { AppendResult, JournalRecord } from "@journal/types";
import { assert, assertCode, assertEquals, assertOk } from "@celld/assert";
import { Harness } from "./memory_store.ts";

const TTL = 60_000;

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function batch(count: number, from = 0): Uint8Array[] {
  return Array.from({ length: count }, (_, index) => bytes(from + index));
}

/** A harness whose journal `alpha` holds, with links of `linkSize`. */
async function leased(linkSize = 8, log = "orders"): Promise<Harness> {
  const harness = new Harness(log);
  assertOk(
    await harness.core.acquireLease({
      candidate: "alpha",
      ttlMs: TTL,
      linkSize,
    }),
  );
  return harness;
}

function append(
  core: LogCore,
  records: Uint8Array[],
  expectedNextSeq?: number,
  leader = "alpha",
): Promise<AppendResult> {
  return core.append({ leader, records, expectedNextSeq });
}

/** The whole live stream, paged the way a client pages it. */
async function readAll(core: LogCore): Promise<JournalRecord[]> {
  const status = await core.status();
  const records: JournalRecord[] = [];
  let from = status.trimmedThrough + 1;
  while (from < status.head) {
    const window = assertOk(await core.read({ from, limit: 3 }));
    assert(window.records.length > 0, `nothing read from ${from}`);
    records.push(...window.records);
    from = window.records[window.records.length - 1].seq + 1;
  }
  return records;
}

async function rejects(call: () => Promise<unknown>): Promise<Error> {
  try {
    await call();
  } catch (error) {
    return error as Error;
  }
  throw new Error("the call did not throw");
}

Deno.test("appends land in link 0 and read back with bytes and terms", async () => {
  const harness = await leased();
  const { core, store } = harness;
  const first = assertOk(await append(core, [bytes(1), bytes(), bytes(2, 3)]));
  assertEquals(first, { ok: true, firstSeq: 1, lastSeq: 3, term: 1 });
  assertOk(await append(core, [bytes(4)], 4));

  assertEquals(await readAll(core), [
    { seq: 1, term: 1, payload: bytes(1) },
    { seq: 2, term: 1, payload: bytes() },
    { seq: 3, term: 1, payload: bytes(2, 3) },
    { seq: 4, term: 1, payload: bytes(4) },
  ]);
  assertEquals(store.all(), [
    { link: 0, firstSeq: 1, captureId: 1, sealedAt: null, term: 1 },
  ]);
  // Registers hold the payload itself; the term lives in the link.
  const metadata = new TextDecoder().decode(harness.link(0).meta.metadata!);
  assertEquals(JSON.parse(metadata), {
    log: "orders",
    index: 0,
    firstSeq: 1,
    term: 1,
  });
  assertEquals(harness.link(0).registers.get(2)?.value, bytes(2, 3));
});

Deno.test("an append inside its link is one segment write and no store commit", async () => {
  const harness = await leased(64);
  const { core, store, segments } = harness;
  assertOk(await append(core, [bytes(0)]));
  const commits = store.commits;
  const barriers = store.barriers;
  const calls = segments.calls.length;
  for (let index = 1; index <= 10; index += 1) {
    assertOk(await append(core, [bytes(index)], index + 1));
  }
  assertEquals(store.commits, commits, "the append path committed");
  assertEquals(store.barriers, barriers, "the append path paid a barrier");
  assertEquals(
    segments.calls.slice(calls).map((call) => call.method),
    Array(10).fill("write"),
  );
});

Deno.test("a batch that does not fit seals the link and opens the next", async () => {
  const { core, store } = await leased();
  assertOk(await append(core, batch(5)));
  const second = assertOk(await append(core, batch(5, 5), 6));
  assertEquals([second.firstSeq, second.lastSeq], [6, 10]);
  assertEquals(store.all(), [
    { link: 0, firstSeq: 1, captureId: 1, sealedAt: 5, term: 1 },
    { link: 1, firstSeq: 6, captureId: 1, sealedAt: null, term: 1 },
  ]);
  const records = await readAll(core);
  assertEquals(records.map((record) => record.seq), [
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    9,
    10,
  ]);
  assertEquals(records.map((record) => record.payload[0]), [
    0,
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    9,
  ]);

  // A link filled exactly is sealed at its own end by the next batch.
  assertOk(await append(core, batch(3, 10)));
  assertOk(await append(core, batch(1, 13)));
  assertEquals(
    store.all().map((link) => [link.link, link.firstSeq, link.sealedAt]),
    [
      [0, 1, 5],
      [1, 6, 8],
      [2, 14, null],
    ],
  );
  assertEquals((await readAll(core)).length, 14);
});

Deno.test("reads cross links under the limit and the byte budget", async () => {
  const { core } = await leased();
  for (let index = 0; index < 6; index += 1) {
    assertOk(
      await append(core, [new Uint8Array(10).fill(index), new Uint8Array(10)]),
    );
  }
  // Batches of two in links of eight: [1..8] fills exactly, then [9..12].
  const all = assertOk(await core.read({ from: 1, limit: 1000 }));
  assertEquals(all.records.map((record) => record.seq), [
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    9,
    10,
    11,
    12,
  ]);
  assertEquals(all.head, 13);

  const paged = assertOk(await core.read({ from: 7, limit: 4 }));
  assertEquals(paged.records.map((record) => record.seq), [7, 8, 9, 10]);

  const budget = assertOk(await core.read({ from: 6, maxBytes: 35 }));
  assertEquals(budget.records.map((record) => record.seq), [6, 7, 8]);

  const single = assertOk(await core.read({ from: 8, maxBytes: 1 }));
  assertEquals(
    single.records.map((record) => record.seq),
    [8],
    "one record at least",
  );

  assertEquals(assertOk(await core.read({ from: 13 })).records, []);
  assertCode(await core.read({ from: 14 }), "INVALID");
});

Deno.test("a new term seals the link and stamps its records", async () => {
  const harness = await leased();
  const { core, store } = harness;
  assertOk(await core.acquireLease({ candidate: "alpha", ttlMs: 1_000 }));
  assertOk(await append(core, batch(2)));
  harness.nowMs += 2_000;
  const taken = assertOk(
    await core.acquireLease({ candidate: "beta", ttlMs: TTL }),
  );
  assertEquals(taken.term, 2);
  assertCode(await append(core, batch(1)), "NOT_LEADER");
  assertEquals(
    assertOk(await append(core, batch(1, 7), 3, "beta")),
    { ok: true, firstSeq: 3, lastSeq: 3, term: 2 },
  );
  assertEquals(
    store.all().map((
      link,
    ) => [link.link, link.firstSeq, link.sealedAt, link.term]),
    [
      [0, 1, 2, 1],
      [1, 3, null, 2],
    ],
  );
  assertEquals((await readAll(core)).map((record) => record.term), [1, 1, 2]);

  // Released and re-acquired by the same candidate is a new term too, so it
  // gets a new link.
  assertOk(await core.releaseLease({ leader: "beta" }));
  assertEquals(
    assertOk(await core.acquireLease({ candidate: "beta", ttlMs: TTL })).term,
    3,
  );
  assertOk(await append(core, batch(1), 4, "beta"));
  assertEquals((await readAll(core)).map((record) => record.term), [
    1,
    1,
    2,
    3,
  ]);
  assertEquals(store.all().map((link) => link.term), [1, 2, 3]);
});

Deno.test("an empty sealed link shares its firstSeq with the next", async () => {
  const harness = await leased();
  const { core, store, segments } = harness;
  assertOk(await append(core, batch(2)));
  // The next link is opened, and the write that should follow never lands.
  segments.faults = (method) => method === "write" ? "throw" : undefined;
  const failed = await rejects(() => append(core, batch(7), 3));
  assert(failed.message.startsWith(UNAVAILABLE_PREFIX), failed.message);
  segments.faults = undefined;
  assertEquals(
    store.all().map((link) => [link.link, link.firstSeq, link.sealedAt]),
    [
      [0, 1, 2],
      [1, 3, null],
    ],
  );
  harness.nowMs += TTL + 1;
  assertOk(await core.acquireLease({ candidate: "beta", ttlMs: TTL }));
  assertOk(await append(core, batch(1, 9), 3, "beta"));
  assertEquals(
    store.all().map((
      link,
    ) => [link.link, link.firstSeq, link.sealedAt, link.term]),
    [
      [0, 1, 2, 1],
      [1, 3, 0, 1],
      [2, 3, null, 2],
    ],
  );
  const records = await readAll(core);
  assertEquals(
    records.map((record) => [record.seq, record.term, record.payload[0]]),
    [
      [1, 1, 0],
      [2, 1, 1],
      [3, 2, 9],
    ],
  );
});

Deno.test("linkSize is fixed at first use, and a batch must fit a link", async () => {
  const harness = new Harness();
  const { core, store } = harness;
  assertCode(
    await core.acquireLease({ candidate: "alpha", ttlMs: TTL, linkSize: 7 }),
    "INVALID",
  );
  assertEquals(
    store.load().leader,
    null,
    "an invalid linkSize acquires nothing",
  );
  assertOk(
    await core.acquireLease({ candidate: "alpha", ttlMs: TTL, linkSize: 16 }),
  );
  assertEquals(store.load().linkSize, 16);
  // Before the first link, a later acquire can still change it.
  assertOk(
    await core.acquireLease({ candidate: "alpha", ttlMs: TTL, linkSize: 8 }),
  );
  assertEquals(store.load().linkSize, 8);
  assertCode(await append(core, batch(9)), "TOO_LARGE");
  assertOk(await append(core, batch(8)));
  assertOk(
    await core.acquireLease({ candidate: "alpha", ttlMs: TTL, linkSize: 32 }),
  );
  assertEquals(
    store.load().linkSize,
    8,
    "linkSize changed after the first link",
  );
  assertEquals(harness.link(0).meta.size, 8);

  const fresh = new Harness();
  assertOk(await fresh.core.acquireLease({ candidate: "alpha", ttlMs: TTL }));
  assertOk(await append(fresh.core, batch(1)));
  assertEquals(fresh.link(0).meta.size, 4096, "the default link size");
});

Deno.test("trims cut segments below the mark and drop whole links", async () => {
  const harness = await leased();
  const { core, store } = harness;
  for (let index = 0; index < 5; index += 1) {
    assertOk(await append(core, batch(3, 3 * index)));
  }
  // Links of 8 with batches of 3: [1..6] sealed at 6, [7..12], [13..15].
  assertEquals(store.all().map((link) => [link.firstSeq, link.sealedAt]), [
    [1, 6],
    [7, 6],
    [13, null],
  ]);
  assertCode(await core.trim({ throughSeq: 8 }), "SNAPSHOT_STALE");
  assertOk(await core.recordSnapshot({ throughSeq: 14, ref: "s3://snap/14" }));

  assertEquals(assertOk(await core.trim({ throughSeq: 8 })).trimmedThrough, 8);
  assertEquals(store.all().map((link) => link.link), [1, 2]);
  assertEquals(harness.link(0).meta.trimmedThrough, 7, "link 0 wholly trimmed");
  assertEquals(harness.link(0).registers.size, 0);
  assertEquals(harness.link(1).meta.trimmedThrough, 1, "seqs 7 and 8");
  assertEquals([...harness.link(1).registers.keys()], [2, 3, 4, 5]);

  assertCode(await core.read({ from: 8 }), "TRIMMED");
  assertEquals((await readAll(core)).map((record) => record.seq), [
    9,
    10,
    11,
    12,
    13,
    14,
    15,
  ]);
  const again = assertOk(await core.trim({ throughSeq: 8 }));
  assertEquals(again.trimmedThrough, 8, "a repeated trim is idempotent");

  // Trimming through the last link keeps its row: it is where head is.
  assertOk(await core.recordSnapshot({ throughSeq: 15, ref: "s3://snap/15" }));
  assertOk(await append(core, batch(1, 20)));
  assertOk(await core.recordSnapshot({ throughSeq: 16, ref: "s3://snap/16" }));
  assertOk(await core.trim({ throughSeq: 16 }));
  assertEquals(store.all().map((link) => link.link), [2]);
  assertEquals(assertOk(await core.read({ from: 17 })).records, []);

  const restarted = harness.restart();
  assertEquals((await restarted.status()).head, 17, "head after a whole trim");
  assertEquals(assertOk(await append(restarted, batch(1), 17)).firstSeq, 17);
});

Deno.test("a trim interrupted after its mark is finished by the next trim", async () => {
  const harness = await leased();
  const { core, store, segments } = harness;
  for (let index = 0; index < 5; index += 1) {
    assertOk(await append(core, batch(4, 4 * index)));
  }
  // Links of 8 with batches of 4: [1..8], [9..16], [17..20].
  assertOk(await core.recordSnapshot({ throughSeq: 16, ref: "s3://snap/16" }));
  segments.faults = (method) => method === "trim" ? "throw" : undefined;
  const failed = await rejects(() => core.trim({ throughSeq: 16 }));
  assert(failed.message.startsWith(UNAVAILABLE_PREFIX), failed.message);
  segments.faults = undefined;
  // The mark is durable, so no reader can see what the segments still hold.
  assertEquals(store.load().trimmedThrough, 16);
  assertCode(await core.read({ from: 16 }), "TRIMMED");
  assertEquals(store.all().map((link) => link.link), [0, 1, 2]);
  assertEquals(harness.link(0).registers.size, 8, "not trimmed yet");
  // The retry is idempotent in the decision and finishes the segments.
  assertEquals(
    assertOk(await core.trim({ throughSeq: 16 })).trimmedThrough,
    16,
  );
  assertEquals(store.all().map((link) => link.link), [2]);
  assertEquals(harness.link(0).meta.trimmedThrough, 7);
  assertEquals(harness.link(1).meta.trimmedThrough, 7);
  assertEquals(harness.link(2).meta.trimmedThrough, -1);
  assertEquals((await readAll(core)).map((record) => record.seq), [
    17,
    18,
    19,
    20,
  ]);
});

Deno.test("a lost write reply is replayed inside the call and proves itself", async () => {
  const { core, segments } = await leased();
  assertOk(await append(core, batch(2)));
  let lost = 1;
  segments.faults = (method) =>
    method === "write" && lost-- > 0 ? "lost" : undefined;
  const landed = assertOk(await append(core, batch(2, 2), 3));
  assertEquals([landed.firstSeq, landed.lastSeq], [3, 4]);
  assertEquals(segments.count("write"), 3, "one write, one replay");
  assertEquals((await readAll(core)).map((record) => record.payload[0]), [
    0,
    1,
    2,
    3,
  ]);
});

Deno.test("a reply lost for good is proved by the client's replay", async () => {
  for (const restart of [false, true]) {
    const harness = await leased();
    const { segments } = harness;
    assertOk(await append(harness.core, batch(2)));
    // Every attempt lands (the first) or finds it (the replays), and every
    // reply is lost: the call throws, and the outcome is unknown to it.
    segments.faults = (method) => method === "write" ? "lost" : undefined;
    const failed = await rejects(() => append(harness.core, batch(3, 2), 3));
    assert(failed.message.startsWith(UNAVAILABLE_PREFIX), failed.message);
    assertEquals(
      harness.core.cachedHead,
      null,
      "a throw drops the cached head",
    );
    segments.faults = undefined;
    const core = restart ? harness.restart() : harness.core;

    // The README's proof: same term, head === expectedNextSeq + length.
    assertEquals(await append(core, batch(3, 2), 3), {
      ok: false,
      code: "SEQ_MISMATCH",
      head: 6,
      term: 1,
    });
    const records = await readAll(core);
    assertEquals(records.map((record) => record.payload[0]), [0, 1, 2, 3, 4]);
    // An unconditional append after it goes after it, once.
    assertEquals(assertOk(await append(core, batch(1, 9))).firstSeq, 6);
  }
});

Deno.test("registers written behind the cache are adopted and decided again", async () => {
  const harness = await leased();
  const { core, store } = harness;
  assertOk(await append(core, batch(2)));
  // A previous owner of this cell landed a batch this instance never saw.
  const link = store.last()!;
  assertOk(
    await harness.link(0).write({
      start: 2,
      values: [bytes(7), bytes(8)],
      captureId: link.captureId,
    }),
  );
  assertEquals(await append(core, batch(1), 3), {
    ok: false,
    code: "SEQ_MISMATCH",
    head: 5,
    term: 1,
  });
  assertEquals(assertOk(await append(core, [bytes(9)])).firstSeq, 5);
  assertEquals((await readAll(core)).map((record) => record.payload[0]), [
    0,
    1,
    7,
    8,
    9,
  ]);
});

Deno.test("a stolen capture is taken back once, and twice is unavailable", async () => {
  const harness = await leased();
  const { core, store, segments } = harness;
  assertOk(await append(core, batch(2)));
  // An operator captures the link over the journal.
  const stolen = assertOk(
    await harness.link(0).capture({ start: 0, end: 8, owner: "op" }),
  );
  assertOk(await append(core, batch(1, 2), 3));
  const round = store.last()!.captureId;
  assert(round > stolen.captureId, `the journal holds round ${round} again`);

  // Stolen again before each of two writes in one call: the journal gives up.
  segments.faults = (method, request) => {
    if (method !== "write") return undefined;
    const { captureId, start } = request as WriteRequest;
    return {
      ok: false,
      code: "CAPTURE_STALE",
      message: "stolen",
      offset: start,
      round: captureId + 100,
      captureId,
    };
  };
  const failed = await rejects(() => append(core, batch(1, 3), 4));
  assert(failed.message.startsWith(UNAVAILABLE_PREFIX), failed.message);
  segments.faults = undefined;
  assertEquals(assertOk(await append(core, batch(1, 3), 4)).firstSeq, 4);
  assertEquals((await readAll(core)).map((record) => record.payload[0]), [
    0,
    1,
    2,
    3,
  ]);
});

Deno.test("activation recovers head from the chain and fences the old instance", async () => {
  const harness = await leased();
  for (let index = 0; index < 7; index += 1) {
    assertOk(await append(harness.core, batch(3, 3 * index)));
  }
  const before = await harness.core.status();
  assertEquals(before.head, 22);
  const oldRound = harness.store.last()!.captureId;

  const core = harness.restart();
  assertEquals(core.cachedHead, null, "construction does no I/O");
  const status = await core.status();
  assertEquals(status.head, 22);
  assertEquals(core.cachedHead, 22);
  const round = harness.store.last()!.captureId;
  assert(round > oldRound, "activation recaptured the last link");
  // A write the previous instance still had in flight cannot land now.
  assertCode(
    await harness.link(harness.store.last()!.link).write({
      start: 21 - harness.store.last()!.firstSeq + 1,
      values: [bytes(1)],
      captureId: oldRound,
    }),
    "CAPTURE_STALE",
  );
  assertEquals(assertOk(await append(core, batch(1, 99), 22)).firstSeq, 22);
  assertEquals((await readAll(core)).length, 22);
});

Deno.test("an empty journal recovers head 1 without touching a segment", async () => {
  const harness = new Harness();
  assertEquals((await harness.core.status()).head, 1);
  assertEquals(harness.segments.calls.length, 0);
});

Deno.test("an open interrupted after allocation is continued, a foreign one skipped", async () => {
  const harness = await leased();
  const { core, store, segments } = harness;
  assertOk(await append(core, batch(6)));
  // The capture of the new link fails after its allocation landed.
  let throws = 5;
  segments.faults = (method, _request, name) =>
    method === "capture" && name === "orders.1" && throws-- > 0
      ? "throw"
      : undefined;
  await rejects(() => append(core, batch(4, 6), 7));
  segments.faults = undefined;
  assertEquals(harness.link(1).meta.allocated, true);
  assertEquals(
    store.all().length,
    1,
    "no row for a link that was never captured",
  );
  assertOk(await append(core, batch(4, 6), 7));
  assertEquals(store.all().map((link) => [link.link, link.firstSeq]), [[0, 1], [
    1,
    7,
  ]]);

  // Link 2 was allocated for some other head (an open that was abandoned
  // and then overtaken): the journal leaves it alone and uses link 3.
  assertOk(
    await harness.link(2).alloc({
      size: 8,
      metadata: new TextEncoder().encode(
        JSON.stringify({ log: "orders", index: 2, firstSeq: 99, term: 1 }),
      ),
    }),
  );
  assertOk(await append(core, batch(7, 10), 11));
  assertEquals(
    store.all().map((link) => [link.link, link.firstSeq, link.sealedAt]),
    [
      [0, 1, 6],
      [1, 7, 4],
      [3, 11, null],
    ],
  );
  assertEquals(
    (await readAll(core)).map((record) => record.seq),
    Array.from({ length: 17 }, (_, i) => i + 1),
  );
});

Deno.test("transient segment failures are repeated, and past that unavailable", async () => {
  const { core, segments } = await leased();
  assertOk(await append(core, batch(2)));
  let throws = 2;
  segments.faults = () => throws-- > 0 ? "throw" : undefined;
  assertOk(await core.read({ from: 1 }));
  segments.faults = () => "throw";
  const failed = await rejects(() => core.read({ from: 1 }));
  assert(failed.message.startsWith(UNAVAILABLE_PREFIX), failed.message);
  segments.faults = undefined;
  assertEquals((await readAll(core)).length, 2);
});

Deno.test("concurrent calls on one instance never interleave", async () => {
  const { core } = await leased();
  const results = await Promise.all(
    Array.from(
      { length: 12 },
      (_, index) => append(core, batch(1 + (index % 3), 10 * index)),
    ),
  );
  const ranges = results.map((result) => {
    const ok = assertOk(result);
    return [ok.firstSeq, ok.lastSeq];
  }).sort((left, right) => left[0] - right[0]);
  let next = 1;
  for (const [first, last] of ranges) {
    assertEquals(first, next, "contiguous ranges");
    next = last + 1;
  }
  const records = await readAll(core);
  assertEquals(
    records.map((record) => record.seq),
    Array.from({ length: next - 1 }, (_, i) => i + 1),
  );
});
