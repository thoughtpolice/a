// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A randomized model check of the decision core against its invariants.
 *
 * Records are never read by a transition, only produced or deleted, so the
 * whole of storage is a list the reducer below maintains from each `Outcome`.
 * That makes it cheap to assert, after every single step, the properties the
 * service's safety argument rests on: contiguity of the live window, the
 * ordering of the trim and snapshot marks, monotone terms, one writer per
 * term, and that nothing a rejection touches is ever persisted.
 *
 * Seeds are fixed, so a failure reproduces exactly; its seed and step number
 * are in the message.
 *
 * @module
 */

import * as core from "@journal/core";
import { type Meta, type Outcome } from "@journal/core";
import { type JournalRecord } from "@journal/types";
import { assert, equals } from "@celld/assert";

const SEEDS = 100;
const STEPS = 300;
const CANDIDATES = ["alpha", "beta", "gamma", "delta"];
const TTLS = [1_000, 5_000, 60_000];
const T0 = 1_700_000_000_000;

/** mulberry32: small, fast, and identical on every run of every platform. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** The whole of the journal's persistent state, as a test can hold it. */
interface Model {
  meta: Meta;
  records: JournalRecord[];
}

/** Every write the Durable Object would perform for one outcome. */
function apply(model: Model, outcome: Outcome<unknown>): boolean {
  if (outcome.meta === model.meta) return false;
  model.meta = outcome.meta;
  for (const row of outcome.insert ?? []) {
    model.records.push({ seq: row.seq, term: row.term, payload: row.payload });
  }
  const deleteThrough = outcome.deleteThrough;
  if (deleteThrough !== undefined) {
    model.records = model.records.filter((row) => row.seq > deleteThrough);
  }
  return true;
}

const OPERATIONS = [
  ["acquire", 10],
  ["renew", 10],
  ["release", 4],
  ["append", 34],
  ["read", 20],
  ["snapshot", 8],
  ["trim", 7],
  ["tick", 7],
] as const;

const TOTAL_WEIGHT = OPERATIONS.reduce((sum, [, weight]) => sum + weight, 0);

function pickOperation(random: () => number): string {
  let point = random() * TOTAL_WEIGHT;
  for (const [name, weight] of OPERATIONS) {
    point -= weight;
    if (point < 0) return name;
  }
  return "tick";
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)];
}

function randomInt(random: () => number, bound: number): number {
  return Math.floor(random() * bound);
}

/** Runs one seed to completion, throwing with enough context to replay it. */
function run(seed: number): void {
  const random = mulberry32(seed);
  const model: Model = { meta: core.INITIAL_META, records: [] };
  const leaderOfTerm = new Map<number, string>();
  let nowMs = T0;

  const fail = (step: number, message: string): never => {
    throw new Error(`seed ${seed} step ${step}: ${message}`);
  };

  for (let step = 0; step < STEPS; step += 1) {
    const before = model.meta;
    nowMs += 1;

    const claim = (term: number, leader: string) => {
      const known = leaderOfTerm.get(term);
      if (known === undefined) leaderOfTerm.set(term, leader);
      else if (known !== leader) {
        fail(step, `term ${term} claimed by ${known} and ${leader}`);
      }
    };

    switch (pickOperation(random)) {
      case "tick": {
        nowMs += randomInt(random, 2 * TTLS[TTLS.length - 1]);
        break;
      }
      case "acquire": {
        const candidate = pick(random, CANDIDATES);
        const outcome = core.acquireLease(
          before,
          { candidate, ttlMs: pick(random, TTLS) },
          nowMs,
        );
        if (outcome.result.ok) {
          claim(outcome.result.term, candidate);
          if (outcome.meta.leader !== candidate) {
            fail(step, "an acquire did not install its candidate");
          }
        } else if (outcome.result.code === "LEASE_HELD") {
          if (before.leader === null || before.leader === candidate) {
            fail(step, "LEASE_HELD against a free journal or its own holder");
          }
          if (before.leaseDeadlineMs <= nowMs) {
            fail(step, "LEASE_HELD for an expired lease");
          }
          if ("leader" in outcome.result) {
            fail(step, "a conflict disclosed the leader token");
          }
        } else {
          fail(step, `unexpected acquire result ${outcome.result.code}`);
        }
        apply(model, outcome);
        break;
      }
      case "renew": {
        const leader = pick(random, CANDIDATES);
        const outcome = core.renewLease(before, {
          leader,
          ttlMs: pick(random, TTLS),
        }, nowMs);
        if (outcome.result.ok) {
          if (before.leader !== leader) {
            fail(step, "a renewal was granted to a non-holder");
          }
          claim(outcome.result.term, leader);
        } else if (outcome.result.code === "NOT_LEADER") {
          if (before.leader === leader) {
            fail(step, "the holder was refused a renewal");
          }
        } else {
          fail(step, `unexpected renew result ${outcome.result.code}`);
        }
        apply(model, outcome);
        break;
      }
      case "release": {
        const leader = pick(random, CANDIDATES);
        const outcome = core.releaseLease(before, { leader });
        if (outcome.result.ok) {
          if (before.leader !== leader) {
            fail(step, "a release was granted to a non-holder");
          }
          if (outcome.meta.leader !== null) {
            fail(step, "a release kept the leader");
          }
        } else if (before.leader === leader) {
          fail(step, "the holder was refused a release");
        }
        apply(model, outcome);
        break;
      }
      case "append": {
        // A tenth of the traffic is a stale writer; a tenth replays a stale
        // position. Both must be refused without persisting anything.
        const leader = random() < 0.1 || before.leader === null
          ? pick(random, CANDIDATES)
          : before.leader;
        const count = 1 + randomInt(random, 5);
        const records = Array.from({ length: count }, () => {
          const bytes = new Uint8Array(randomInt(random, 9));
          for (let index = 0; index < bytes.length; index += 1) {
            bytes[index] = randomInt(random, 256);
          }
          return bytes;
        });
        const wrongSeq = random() < 0.1;
        const expectedNextSeq = wrongSeq
          ? Math.max(1, before.head + (random() < 0.5 ? 1 : -1))
          : undefined;
        const request = { leader, records, expectedNextSeq };
        const outcome = core.append(before, request, nowMs);
        if (outcome.result.ok) {
          if (before.leader !== leader) {
            fail(step, "an append bypassed the fence");
          }
          claim(outcome.result.term, leader);
          if (outcome.result.firstSeq !== before.head) {
            fail(step, "an append skipped a sequence");
          }
          if (outcome.result.lastSeq !== before.head + count - 1) {
            fail(step, "an append reported the wrong range");
          }
          const inserted = outcome.insert ?? [];
          if (inserted.length !== count) fail(step, "an append lost a record");
          for (const [index, row] of inserted.entries()) {
            if (row.term !== before.term) {
              fail(step, "a record carried the wrong term");
            }
            if (!equals(row.payload, records[index])) {
              fail(step, "a record carried the wrong bytes");
            }
          }
        } else if (outcome.result.code === "NOT_LEADER") {
          if (before.leader !== null && before.leader === leader) {
            fail(step, "the leader was refused an append");
          }
        } else if (outcome.result.code === "SEQ_MISMATCH") {
          if (!wrongSeq) fail(step, "an unconditional append hit SEQ_MISMATCH");
          if (outcome.result.head !== before.head) {
            fail(step, "SEQ_MISMATCH reported the wrong head");
          }
          if (outcome.result.term !== before.term) {
            fail(step, "SEQ_MISMATCH reported the wrong term");
          }
        } else {
          fail(step, `unexpected append result ${outcome.result.code}`);
        }
        apply(model, outcome);
        break;
      }
      case "read": {
        const from = 1 + randomInt(random, model.meta.head + 1);
        const limit = 1 + randomInt(random, 8);
        const maxBytes = 1 + randomInt(random, 24);
        const plan = core.planRead(model.meta, { from, limit, maxBytes });
        if (plan.kind === "reply") {
          if (plan.result.ok) fail(step, "a read replied without scanning");
          else if (plan.result.code === "TRIMMED") {
            if (from > model.meta.trimmedThrough) {
              fail(step, "TRIMMED for a live position");
            }
          } else if (from >= 1 && from <= model.meta.head) {
            fail(step, "a legal position was rejected");
          }
          break;
        }
        const rows = model.records
          .filter((row) => row.seq >= plan.from)
          .sort((left, right) => left.seq - right.seq)
          .slice(0, plan.limit);
        const result = core.finishRead(model.meta, rows, plan.maxBytes);
        if (!result.ok) fail(step, "a scan did not produce a window");
        else {
          const { records } = result;
          if (records.length > limit) fail(step, "a read exceeded its limit");
          if (rows.length > 0 && records.length === 0) {
            fail(step, "a read starved on a byte budget");
          }
          if (records.length > 0 && records[0].seq !== from) {
            fail(step, "a read did not start at the requested position");
          }
          let total = 0;
          for (const [index, record] of records.entries()) {
            if (record.seq !== from + index) {
              fail(step, "a read returned a gap");
            }
            const expected = model.records.find((row) =>
              row.seq === record.seq
            );
            if (expected === undefined) fail(step, "a read invented a record");
            else if (
              !equals(record.payload, expected.payload) ||
              record.term !== expected.term
            ) {
              fail(step, "a read returned the wrong record");
            }
            total += record.payload.byteLength;
          }
          if (
            records.length > 1 &&
            total - records[records.length - 1].payload.byteLength > maxBytes
          ) {
            fail(step, "a read overshot its byte budget");
          }
        }
        break;
      }
      case "snapshot": {
        const throughSeq = randomInt(random, model.meta.head + 2);
        const outcome = core.recordSnapshot(before, {
          throughSeq,
          ref: `s3://snap/${throughSeq}`,
        });
        if (outcome.result.ok) {
          if (throughSeq < before.snapshotThrough) {
            fail(step, "a snapshot moved backwards");
          }
          if (throughSeq > before.head - 1) {
            fail(step, "a snapshot covered an unwritten sequence");
          }
        } else if (
          outcome.result.code === "SNAPSHOT_STALE" &&
          throughSeq >= before.snapshotThrough
        ) {
          fail(step, "a forward snapshot was refused");
        }
        apply(model, outcome);
        break;
      }
      case "trim": {
        const throughSeq = randomInt(random, model.meta.head + 2);
        const outcome = core.trim(before, { throughSeq });
        if (outcome.result.ok) {
          if (throughSeq > before.snapshotThrough) {
            fail(step, "a trim outran the snapshot mark");
          }
          if (outcome.result.trimmedThrough < before.trimmedThrough) {
            fail(step, "a trim moved backwards");
          }
        } else if (
          outcome.result.code === "SNAPSHOT_STALE" &&
          throughSeq <= before.snapshotThrough
        ) {
          fail(step, "a backed trim was refused");
        }
        apply(model, outcome);
        break;
      }
    }

    const meta = model.meta;
    if (meta.term < before.term) fail(step, "the term went backwards");
    if (meta.head < before.head) fail(step, "head went backwards");
    if ((meta.leader === null) !== (meta.leaseDeadlineMs === 0)) {
      fail(step, "the leader and the deadline disagree about ownership");
    }
    if (meta.trimmedThrough < 0 || meta.trimmedThrough > meta.snapshotThrough) {
      fail(step, "the trim mark passed the snapshot mark");
    }
    if (meta.snapshotThrough > meta.head - 1) {
      fail(step, "the snapshot mark passed head");
    }
    if ((meta.snapshotThrough === 0) !== (meta.snapshotRef === null)) {
      fail(step, "the snapshot mark and its reference disagree");
    }
    const live = model.records.map((row) => row.seq).sort((left, right) =>
      left - right
    );
    if (live.length !== meta.head - 1 - meta.trimmedThrough) {
      fail(
        step,
        `expected ${
          meta.head - 1 - meta.trimmedThrough
        } records, have ${live.length}`,
      );
    }
    for (const [index, seq] of live.entries()) {
      if (seq !== meta.trimmedThrough + 1 + index) {
        fail(step, "the live window is not contiguous");
      }
    }
  }
}

Deno.test("randomized operation sequences preserve every journal invariant", () => {
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    run(seed);
  }
});

Deno.test("the generator actually reaches the interesting states", () => {
  // A model test that never trims or never takes over a lease would pass
  // vacuously, so one seed is replayed with the outcomes counted.
  const random = mulberry32(7);
  const model: Model = { meta: core.INITIAL_META, records: [] };
  const seen = new Set<string>();
  let nowMs = T0;
  for (let step = 0; step < 4_000; step += 1) {
    nowMs += 1;
    const before = model.meta;
    switch (pickOperation(random)) {
      case "tick":
        nowMs += randomInt(random, 120_000);
        break;
      case "acquire": {
        const outcome = core.acquireLease(
          before,
          { candidate: pick(random, CANDIDATES), ttlMs: pick(random, TTLS) },
          nowMs,
        );
        if (outcome.result.ok && outcome.result.term > before.term) {
          seen.add("takeover");
        }
        if (!outcome.result.ok) seen.add("lease-held");
        apply(model, outcome);
        break;
      }
      case "append": {
        const leader = random() < 0.2 || before.leader === null
          ? pick(random, CANDIDATES)
          : before.leader;
        const outcome = core.append(before, {
          leader,
          records: [new Uint8Array(4)],
        }, nowMs);
        seen.add(outcome.result.ok ? "append" : "append-refused");
        apply(model, outcome);
        break;
      }
      case "snapshot": {
        const outcome = core.recordSnapshot(before, {
          throughSeq: randomInt(random, before.head + 1),
          ref: "s3://snap",
        });
        if (outcome.result.ok) seen.add("snapshot");
        apply(model, outcome);
        break;
      }
      case "trim": {
        const outcome = core.trim(before, {
          throughSeq: randomInt(random, before.head + 1),
        });
        if (outcome.result.ok && outcome.deleteThrough !== undefined) {
          seen.add("trim");
        }
        apply(model, outcome);
        break;
      }
      default:
        break;
    }
  }
  for (
    const state of [
      "takeover",
      "lease-held",
      "append",
      "append-refused",
      "snapshot",
      "trim",
    ]
  ) {
    assert(seen.has(state), `the generator never produced ${state}`);
  }
});
