// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Transition-by-transition contracts for the journal's decision core.
 *
 * These are the rules a reader of the service has to trust: who may write, what
 * a term means, when a retry is safe, and when bytes may be deleted. They run
 * without celld because `core.ts` never touches the platform.
 *
 * @module
 */

import * as core from "@journal/core";
import { type Meta } from "@journal/core";
import { LIMITS } from "@journal/types";
import { assert, assertCode, assertEquals, assertOk } from "@celld/assert";

const TTL = 60_000;
const T0 = 1_700_000_000_000;

function payload(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

/** A journal held by `leader` since `nowMs`, at term 1. */
function leased(leader = "alpha", nowMs = T0): Meta {
  return core.acquireLease(
    core.INITIAL_META,
    { candidate: leader, ttlMs: TTL },
    nowMs,
  ).meta;
}

/** A journal holding `count` single-byte records appended by `leader`. */
function filled(count: number, leader = "alpha"): Meta {
  const held = leased(leader);
  const records = Array.from(
    { length: count },
    (_value, index) => payload(index),
  );
  return core.append(held, { leader, records }, T0).meta;
}

Deno.test("a fresh journal reports an empty, unowned stream", () => {
  assertEquals(core.status(core.INITIAL_META, T0, 4096), {
    ok: true,
    head: 1,
    term: 0,
    leader: null,
    deadlineMs: 0,
    nowMs: T0,
    trimmedThrough: 0,
    snapshot: null,
    databaseSize: 4096,
  });
});

Deno.test("acquiring a free journal grants term 1 and a relative deadline", () => {
  const outcome = core.acquireLease(core.INITIAL_META, {
    candidate: "alpha",
    ttlMs: TTL,
  }, T0);
  assertEquals(outcome.result, {
    ok: true,
    term: 1,
    deadlineMs: T0 + TTL,
    nowMs: T0,
  });
  assertEquals(outcome.meta.leader, "alpha");
  assertEquals(outcome.meta.leaseDeadlineMs, T0 + TTL);
  assert(outcome.insert === undefined, "a lease writes no records");
});

Deno.test("a live lease is held against every other candidate", () => {
  const held = leased();
  const outcome = core.acquireLease(
    held,
    { candidate: "beta", ttlMs: TTL },
    T0 + 1,
  );
  assertEquals(outcome.result, {
    ok: false,
    code: "LEASE_HELD",
    term: 1,
    deadlineMs: T0 + TTL,
    nowMs: T0 + 1,
  });
  assert(outcome.meta === held, "a held lease changes nothing");
});

Deno.test("the holder re-acquiring is a renewal, not a new term", () => {
  const held = leased();
  const outcome = core.acquireLease(
    held,
    { candidate: "alpha", ttlMs: TTL },
    T0 + 5_000,
  );
  assertEquals(outcome.result, {
    ok: true,
    term: 1,
    deadlineMs: T0 + 5_000 + TTL,
    nowMs: T0 + 5_000,
  });
});

Deno.test("an expired lease is taken over, and the term advances", () => {
  const held = leased();
  const after = T0 + TTL;
  const outcome = core.acquireLease(
    held,
    { candidate: "beta", ttlMs: TTL },
    after,
  );
  assertEquals(outcome.result, {
    ok: true,
    term: 2,
    deadlineMs: after + TTL,
    nowMs: after,
  });
  assertEquals(outcome.meta.leader, "beta");
});

Deno.test("renewal is decided by the token, not by the deadline", () => {
  const held = leased();
  const late = T0 + TTL * 3;
  const renewed = core.renewLease(held, { leader: "alpha", ttlMs: TTL }, late);
  assertEquals(renewed.result, {
    ok: true,
    term: 1,
    deadlineMs: late + TTL,
    nowMs: late,
  });

  const stranger = core.renewLease(
    held,
    { leader: "beta", ttlMs: TTL },
    T0 + 1,
  );
  assertEquals(stranger.result, { ok: false, code: "NOT_LEADER", term: 1 });
  assert(stranger.meta === held, "a rejected renewal changes nothing");
});

Deno.test("release frees the journal for the next candidate", () => {
  const held = leased();
  const stranger = core.releaseLease(held, { leader: "beta" });
  assertEquals(stranger.result, { ok: false, code: "NOT_LEADER", term: 1 });
  assert(stranger.meta === held, "a rejected release changes nothing");

  const released = core.releaseLease(held, { leader: "alpha" });
  assertEquals(released.result, { ok: true, term: 1 });
  assertEquals(released.meta.leader, null);
  assertEquals(released.meta.leaseDeadlineMs, 0);

  const next = core.acquireLease(released.meta, {
    candidate: "beta",
    ttlMs: TTL,
  }, T0 + 1);
  assertEquals(assertOk(next.result).term, 2);
});

Deno.test("releasing an unowned journal is not leadership", () => {
  const outcome = core.releaseLease(core.INITIAL_META, { leader: "alpha" });
  assertEquals(outcome.result, { ok: false, code: "NOT_LEADER", term: 0 });
});

Deno.test("appends take contiguous sequences and carry the term", () => {
  const held = leased();
  const first = core.append(held, {
    leader: "alpha",
    records: [payload(1), payload(2)],
  }, T0);
  assertEquals(first.result, { ok: true, firstSeq: 1, lastSeq: 2, term: 1 });
  assertEquals(first.meta.head, 3);
  assertEquals(first.insert, [
    { seq: 1, term: 1, payload: payload(1), appendedMs: T0 },
    { seq: 2, term: 1, payload: payload(2), appendedMs: T0 },
  ]);

  const second = core.append(first.meta, {
    leader: "alpha",
    records: [payload(3)],
  }, T0 + 1);
  assertEquals(second.result, { ok: true, firstSeq: 3, lastSeq: 3, term: 1 });
  assertEquals(second.meta.head, 4);
});

Deno.test("a sole leader whose lease lapsed may still append", () => {
  const held = leased();
  const outcome = core.append(
    held,
    { leader: "alpha", records: [payload(1)] },
    T0 + TTL * 10,
  );
  assertEquals(assertOk(outcome.result).firstSeq, 1);
});

Deno.test("a superseded leader is fenced out the instant someone takes over", () => {
  const held = leased();
  const takeover =
    core.acquireLease(held, { candidate: "beta", ttlMs: TTL }, T0 + TTL).meta;
  const outcome = core.append(takeover, {
    leader: "alpha",
    records: [payload(1)],
  }, T0 + TTL);
  assertEquals(outcome.result, { ok: false, code: "NOT_LEADER", term: 2 });
  assert(outcome.meta === takeover, "a fenced append changes nothing");
  assert(outcome.insert === undefined, "a fenced append writes no records");
});

Deno.test("an unowned journal accepts no append at all", () => {
  const outcome = core.append(core.INITIAL_META, {
    leader: "alpha",
    records: [payload(1)],
  }, T0);
  assertEquals(outcome.result, { ok: false, code: "NOT_LEADER", term: 0 });
});

Deno.test("expectedNextSeq is the conditional write, and the retry contract", () => {
  const held = leased();
  const landed = core.append(held, {
    leader: "alpha",
    records: [payload(1), payload(2)],
    expectedNextSeq: 1,
  }, T0);
  assertEquals(assertOk(landed.result).lastSeq, 2);

  // Replaying the same batch answers with the head that proves it landed:
  // head === expectedNextSeq + records.length under an unchanged term.
  const replay = core.append(landed.meta, {
    leader: "alpha",
    records: [payload(1), payload(2)],
    expectedNextSeq: 1,
  }, T0);
  assertEquals(replay.result, {
    ok: false,
    code: "SEQ_MISMATCH",
    head: 3,
    term: 1,
  });
  assert(replay.insert === undefined, "a conditional miss writes no records");
});

Deno.test("fencing is decided before the sequence condition", () => {
  const held = leased();
  const takeover =
    core.acquireLease(held, { candidate: "beta", ttlMs: TTL }, T0 + TTL).meta;
  const outcome = core.append(takeover, {
    leader: "alpha",
    records: [payload(1)],
    expectedNextSeq: 99,
  }, T0);
  assertCode(outcome.result, "NOT_LEADER");
});

Deno.test("append requests are validated before they are fenced", () => {
  const held = leased();
  const cases: [string, Parameters<typeof core.append>[1]][] = [
    ["INVALID", { leader: "", records: [payload(1)] }],
    ["INVALID", {
      leader: "x".repeat(LIMITS.tokenChars + 1),
      records: [payload(1)],
    }],
    ["INVALID", { leader: "alpha", records: [] }],
    ["INVALID", {
      leader: "alpha",
      records: ["text"] as unknown as Uint8Array[],
    }],
    ["INVALID", {
      leader: "alpha",
      records: [payload(1)],
      expectedNextSeq: 1.5,
    }],
    ["INVALID", { leader: "alpha", records: [payload(1)], expectedNextSeq: 0 }],
    ["TOO_LARGE", {
      leader: "alpha",
      records: Array.from(
        { length: LIMITS.batchRecords + 1 },
        () => payload(1),
      ),
    }],
    ["TOO_LARGE", {
      leader: "alpha",
      records: [new Uint8Array(LIMITS.recordBytes + 1)],
    }],
    ["TOO_LARGE", {
      leader: "alpha",
      records: Array.from(
        { length: 5 },
        () => new Uint8Array(LIMITS.recordBytes),
      ),
    }],
  ];
  for (const [code, request] of cases) {
    const outcome = core.append(held, request, T0);
    assertCode(outcome.result, code);
    assert(outcome.meta === held, `${code} for ${request.leader} changed meta`);
  }
});

Deno.test("lease requests are validated against the ttl bounds", () => {
  const ttls = [LIMITS.minTtlMs - 1, LIMITS.maxTtlMs + 1, 1_000.5, Number.NaN];
  for (const ttlMs of ttls) {
    assertCode(
      core.acquireLease(core.INITIAL_META, { candidate: "alpha", ttlMs }, T0)
        .result,
      "INVALID",
    );
    assertCode(
      core.renewLease(leased(), { leader: "alpha", ttlMs }, T0).result,
      "INVALID",
    );
  }
  assertCode(
    core.acquireLease(core.INITIAL_META, { candidate: "", ttlMs: TTL }, T0)
      .result,
    "INVALID",
  );
  assertCode(
    core.acquireLease(
      core.INITIAL_META,
      { candidate: 7 as unknown as string, ttlMs: TTL },
      T0,
    ).result,
    "INVALID",
  );
});

Deno.test("planRead rejects positions outside the live window", () => {
  const meta = filled(3);
  for (const from of [0, -1, 1.5, "1" as unknown as number]) {
    const plan = core.planRead(meta, { from });
    assert(plan.kind === "reply", "an invalid position never scans");
    assertCode(plan.result, "INVALID");
  }
  const past = core.planRead(meta, { from: meta.head + 1 });
  assert(past.kind === "reply", "a position past head never scans");
  assertCode(past.result, "INVALID");

  const atHead = core.planRead(meta, { from: meta.head });
  assert(atHead.kind === "scan", "head itself is a legal, empty position");
});

Deno.test("planRead rejects out-of-range paging arguments", () => {
  const meta = filled(1);
  for (const limit of [0, LIMITS.readLimit + 1, 2.5]) {
    const plan = core.planRead(meta, { from: 1, limit });
    assert(plan.kind === "reply", "an invalid limit never scans");
    assertCode(plan.result, "INVALID");
  }
  for (const maxBytes of [0, LIMITS.readBytes + 1]) {
    const plan = core.planRead(meta, { from: 1, maxBytes });
    assert(plan.kind === "reply", "an invalid budget never scans");
    assertCode(plan.result, "INVALID");
  }
});

Deno.test("planRead defaults the paging arguments", () => {
  const plan = core.planRead(filled(1), { from: 1 });
  assertEquals(plan, {
    kind: "scan",
    from: 1,
    limit: LIMITS.defaultReadLimit,
    maxBytes: LIMITS.defaultReadBytes,
  });
});

Deno.test("planRead sends a reader below the trim point to the snapshot", () => {
  const filledMeta = filled(4);
  const marked =
    core.recordSnapshot(filledMeta, { throughSeq: 2, ref: "s3://snap/2" }).meta;
  const trimmed = core.trim(marked, { throughSeq: 2 }).meta;
  for (const from of [1, 2]) {
    const plan = core.planRead(trimmed, { from });
    assert(plan.kind === "reply", "a trimmed position never scans");
    assertEquals(plan.result, {
      ok: false,
      code: "TRIMMED",
      trimmedThrough: 2,
      snapshot: { throughSeq: 2, ref: "s3://snap/2" },
    });
  }
  const live = core.planRead(trimmed, { from: 3 });
  assert(live.kind === "scan", "the first surviving record is readable");
});

Deno.test("finishRead applies the byte budget but never starves a reader", () => {
  const meta = filled(3);
  const rows = [
    { seq: 1, term: 1, payload: new Uint8Array(10) },
    { seq: 2, term: 1, payload: new Uint8Array(10) },
    { seq: 3, term: 1, payload: new Uint8Array(10) },
  ];
  assertEquals(assertOk(core.finishRead(meta, rows, 25)).records.length, 2);
  assertEquals(assertOk(core.finishRead(meta, rows, 30)).records.length, 3);

  const single = assertOk(core.finishRead(meta, rows, 1)).records;
  assertEquals(
    single.length,
    1,
    "a budget smaller than one record still returns it",
  );
  assertEquals(single[0].seq, 1);

  const envelope = assertOk(core.finishRead(meta, [], 100));
  assertEquals(envelope.records, []);
  assertEquals(envelope.head, meta.head);
  assertEquals(envelope.snapshot, null);
});

Deno.test("snapshots mark an immutable prefix and move only forward", () => {
  const meta = filled(4);
  assertCode(
    core.recordSnapshot(meta, { throughSeq: 0, ref: "r" }).result,
    "INVALID",
  );
  assertCode(
    core.recordSnapshot(meta, { throughSeq: meta.head, ref: "r" }).result,
    "INVALID",
  );
  assertCode(
    core.recordSnapshot(meta, { throughSeq: 1, ref: "" }).result,
    "INVALID",
  );

  const first = core.recordSnapshot(meta, {
    throughSeq: 2,
    ref: "s3://snap/2",
  });
  assertEquals(first.result, {
    ok: true,
    snapshot: { throughSeq: 2, ref: "s3://snap/2" },
  });

  const repeated = core.recordSnapshot(first.meta, {
    throughSeq: 2,
    ref: "s3://snap/2",
  });
  assertEquals(repeated.result, first.result);
  assert(
    repeated.meta === first.meta,
    "re-recording the same mark persists nothing",
  );

  const rewritten = core.recordSnapshot(first.meta, {
    throughSeq: 2,
    ref: "s3://snap/2b",
  });
  assertEquals(rewritten.meta.snapshotRef, "s3://snap/2b");

  const stale = core.recordSnapshot(first.meta, {
    throughSeq: 1,
    ref: "s3://snap/1",
  });
  assertEquals(stale.result, {
    ok: false,
    code: "SNAPSHOT_STALE",
    snapshot: { throughSeq: 2, ref: "s3://snap/2" },
  });
  assert(stale.meta === first.meta, "a stale snapshot changes nothing");
});

Deno.test("trim deletes only what a snapshot already covers", () => {
  const meta = filled(4);
  assertCode(core.trim(meta, { throughSeq: 0 }).result, "INVALID");

  const unsnapshotted = core.trim(meta, { throughSeq: 1 });
  assertEquals(unsnapshotted.result, {
    ok: false,
    code: "SNAPSHOT_STALE",
    snapshot: null,
  });
  assert(unsnapshotted.meta === meta, "an unbacked trim changes nothing");

  const marked =
    core.recordSnapshot(meta, { throughSeq: 3, ref: "s3://snap/3" }).meta;
  const beyond = core.trim(marked, { throughSeq: 4 });
  assertCode(beyond.result, "SNAPSHOT_STALE");

  const trimmed = core.trim(marked, { throughSeq: 3 });
  assertEquals(trimmed.result, { ok: true, trimmedThrough: 3 });
  assertEquals(trimmed.deleteThrough, 3);
  assertEquals(trimmed.meta.trimmedThrough, 3);

  const repeated = core.trim(trimmed.meta, { throughSeq: 3 });
  assertEquals(repeated.result, { ok: true, trimmedThrough: 3 });
  assert(
    repeated.meta === trimmed.meta,
    "a repeated trim deletes nothing again",
  );
  assert(
    repeated.deleteThrough === undefined,
    "a repeated trim emits no deletion",
  );

  const backwards = core.trim(trimmed.meta, { throughSeq: 1 });
  assertEquals(backwards.result, { ok: true, trimmedThrough: 3 });
  assert(backwards.meta === trimmed.meta, "trim never moves backwards");
});

Deno.test("transitions never mutate their inputs", () => {
  const meta = Object.freeze(filled(2));
  const records = Object.freeze([payload(1)]) as unknown as Uint8Array[];
  const appendRequest = Object.freeze({
    leader: "alpha",
    records,
    expectedNextSeq: 3,
  });
  const outcome = core.append(meta, appendRequest, T0);
  assertEquals(assertOk(outcome.result).firstSeq, 3);
  assertEquals(meta.head, 3, "the input meta is untouched");
  assertEquals(
    appendRequest.records.length,
    1,
    "the input request is untouched",
  );

  const leaseRequest = Object.freeze({ candidate: "beta", ttlMs: TTL });
  core.acquireLease(meta, leaseRequest, T0 + TTL * 2);
  assertEquals(meta.leader, "alpha");
  assertEquals(leaseRequest.ttlMs, TTL);

  core.trim(Object.freeze(core.INITIAL_META), { throughSeq: 1 });
  assertEquals(core.INITIAL_META.trimmedThrough, 0);
});
