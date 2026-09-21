// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A randomized model check of the coordinator over faulty fake segments.
 *
 * Several candidates take, renew, and release the lease; the holder appends
 * batches (most with `expectedNextSeq`) while segment calls throw, lose their
 * replies after performing, and an operator steals the current link's
 * capture; snapshots and trims move the marks; the cell restarts. A client
 * whose append throws follows the README's retry contract: it replays with
 * the same `expectedNextSeq` until it gets an answer.
 *
 * After every step, with faults off, the whole live stream is read back and
 * checked against what the clients were told, the invariants the fleet
 * tests' `verify` checks and more:
 *
 *   - sequences are contiguous from `trimmedThrough + 1` to `head - 1`, and
 *     head, the term, and the marks never move backwards;
 *   - every acknowledged record is present at its sequence with its bytes
 *     and the term its writer held, including the ones acknowledged by a
 *     `SEQ_MISMATCH` proof, which is therefore exact;
 *   - every record was sent, appears once, carries its sender's term, and
 *     nothing a definitive refusal answered ever appears;
 *   - terms never decrease along the stream.
 *
 * Seeds are fixed, so a failure reproduces exactly; its seed and step are in
 * the message.
 *
 * @module
 */

import type { SegmentAPI } from "@wormspace/segment/types";
import { Random } from "@wormspace/testing/random";
import type { AppendRequest, JournalRecord } from "@journal/types";
import { assert, equals, show } from "@celld/assert";
import { Harness } from "./memory_store.ts";

const SEEDS = 60;
const STEPS = 160;
const CANDIDATES = ["alpha", "beta", "gamma"];
const TTLS = [1_000, 60_000];
const LINK_SIZES = [8, 9, 16];
/** Replays a client makes after a throw before it turns faults off. */
const REPLAYS = 12;

const OPERATIONS = [
  ["acquire", 8],
  ["renew", 4],
  ["release", 2],
  ["append", 40],
  ["read", 12],
  ["snapshot", 6],
  ["trim", 6],
  ["tick", 5],
  ["restart", 4],
  ["steal", 3],
] as const;

type Operation = typeof OPERATIONS[number][0];

const TOTAL = OPERATIONS.reduce((sum, [, weight]) => sum + weight, 0);

function operation(random: Random): Operation {
  let point = random.next() * TOTAL;
  for (const [name, weight] of OPERATIONS) {
    point -= weight;
    if (point < 0) return name;
  }
  return "tick";
}

/** What was sent, by payload: who sent it and under which term. */
interface Sent {
  leader: string;
  term: number;
}

/** Counts of the interesting outcomes, across every seed. */
const seen = new Map<string, number>();

function note(what: string): void {
  seen.set(what, (seen.get(what) ?? 0) + 1);
}

function key(payload: Uint8Array): string {
  return Array.from(payload).join(",");
}

async function run(seed: number): Promise<void> {
  const random = new Random(seed);
  const harness = new Harness("model");
  const linkSize = random.pick(LINK_SIZES);
  let armed = false;
  // Single faults the journal's own bounded retry absorbs, and outages: a run
  // of failing calls long enough to exhaust it, so the client sees a throw.
  let outage = 0;
  harness.segments.faults = () => {
    if (!armed) return undefined;
    if (outage > 0) {
      outage -= 1;
      return random.chance(0.5) ? "throw" : "lost";
    }
    const roll = random.next();
    if (roll < 0.05) return "throw";
    if (roll < 0.1) return "lost";
    if (roll < 0.12) outage = random.int(10);
    return undefined;
  };

  /** The term each candidate last acquired, as that client believes it. */
  const terms = new Map<string, number>();
  const sent = new Map<string, Sent>();
  const refused = new Set<string>();
  const acked = new Map<number, { payload: Uint8Array; term: number }>();
  let issued = 0;
  let lastHead = 1;
  let lastTerm = 0;
  let lastTrim = 0;

  const fail = (step: number, message: string): never => {
    throw new Error(`seed ${seed} step ${step}: ${message}`);
  };

  /** Calls with faults armed, repeating a thrown call up to REPLAYS times. */
  const call = async <T>(body: () => Promise<T>): Promise<T | null> => {
    armed = true;
    try {
      return await body();
    } catch (error) {
      const message = (error as Error).message;
      if (!message.startsWith("journal unavailable: ")) throw error;
      note("thrown");
      return null;
    } finally {
      armed = false;
    }
  };

  const appendOnce = async (step: number): Promise<void> => {
    const status = await harness.core.status();
    const holder = status.leader;
    const leader = holder !== null && random.chance(0.9)
      ? holder
      : random.pick(CANDIDATES);
    const term = terms.get(leader) ?? 0;
    const records = Array.from({ length: 1 + random.int(4) }, () => {
      issued += 1;
      const payload = new Uint8Array(4 + random.int(6));
      new DataView(payload.buffer).setUint32(0, issued);
      for (let index = 4; index < payload.length; index += 1) {
        payload[index] = random.int(256);
      }
      sent.set(key(payload), { leader, term });
      return payload;
    });
    const conditional = random.chance(0.8);
    const expected = conditional ? status.head : undefined;
    const request: AppendRequest = {
      leader,
      records,
      expectedNextSeq: expected,
    };
    let result = await call(() => harness.core.append(request));
    if (result === null && !conditional) {
      // Unconditional and unknown: the records may or may not be there.
      note("unknown");
      return;
    }
    for (let replay = 0; result === null; replay += 1) {
      note("replayed");
      if (replay >= REPLAYS) {
        result = await harness.core.append(request);
      } else {
        result = await call(() => harness.core.append(request));
      }
    }
    if (result.ok) {
      if (result.term !== term) fail(step, `acked under ${result.term}`);
      for (const [index, payload] of records.entries()) {
        acked.set(result.firstSeq + index, { payload, term });
      }
      return;
    }
    switch (result.code) {
      case "SEQ_MISMATCH":
        if (!conditional) fail(step, "an unconditional SEQ_MISMATCH");
        if (result.term === term && holder === leader) {
          // The proof: the original attempt landed.
          if (result.head !== (expected as number) + records.length) {
            fail(step, `an unexplained SEQ_MISMATCH ${show(result)}`);
          }
          note("proved");
          for (const [index, payload] of records.entries()) {
            acked.set((expected as number) + index, { payload, term });
          }
        } else {
          for (const payload of records) refused.add(key(payload));
        }
        return;
      case "NOT_LEADER":
        if (holder === leader) {
          // Leadership moved between status and append only if a replay
          // straddled a takeover, which this sequential client never does.
          fail(step, `the holder was refused: ${show(result)}`);
        }
        for (const payload of records) refused.add(key(payload));
        return;
      default:
        fail(step, `unexpected append result ${show(result)}`);
    }
  };

  const verify = async (step: number): Promise<void> => {
    const status = await harness.core.status();
    if (status.head < lastHead) fail(step, "head went backwards");
    if (status.term < lastTerm) fail(step, "the term went backwards");
    if (status.trimmedThrough < lastTrim) fail(step, "the trim went backwards");
    lastHead = status.head;
    lastTerm = status.term;
    lastTrim = status.trimmedThrough;
    const snapshot = status.snapshot?.throughSeq ?? 0;
    if (status.trimmedThrough > snapshot || snapshot > status.head - 1) {
      fail(step, `the marks are out of order: ${show(status)}`);
    }
    const records: JournalRecord[] = [];
    let from = status.trimmedThrough + 1;
    while (from < status.head) {
      const window = await harness.core.read({
        from,
        limit: 1 + random.int(20),
        maxBytes: 1 + random.int(64),
      });
      if (!window.ok) fail(step, `read from ${from}: ${show(window)}`);
      else {
        if (window.records.length === 0) fail(step, `empty read at ${from}`);
        records.push(...window.records);
        from = records[records.length - 1].seq + 1;
      }
    }
    const payloads = new Set<string>();
    let previousTerm = 0;
    for (const [index, record] of records.entries()) {
      if (record.seq !== status.trimmedThrough + 1 + index) {
        fail(step, `the stream is not contiguous at ${record.seq}`);
      }
      const id = key(record.payload);
      const origin = sent.get(id);
      if (origin === undefined) {
        fail(step, `record ${record.seq} was never sent`);
      } else if (origin.term !== record.term) {
        fail(
          step,
          `record ${record.seq} has term ${record.term}, sent ${origin.term}`,
        );
      }
      if (refused.has(id)) fail(step, `refused record at ${record.seq}`);
      if (payloads.has(id)) fail(step, `record ${record.seq} appears twice`);
      payloads.add(id);
      if (record.term < previousTerm) fail(step, "terms decrease");
      previousTerm = record.term;
    }
    for (const [seq, ack] of acked) {
      if (seq <= status.trimmedThrough) continue;
      if (seq >= status.head) fail(step, `acknowledged ${seq} is past head`);
      const record = records[seq - status.trimmedThrough - 1];
      if (!equals(record.payload, ack.payload) || record.term !== ack.term) {
        fail(step, `acknowledged ${seq} reads back as ${show(record)}`);
      }
    }
  };

  for (let step = 0; step < STEPS; step += 1) {
    harness.nowMs += 1;
    switch (operation(random)) {
      case "acquire": {
        // Repeated until it is answered, as a client must: a repeat by the
        // same candidate is a renewal, so it reports the term either way.
        const candidate = random.pick(CANDIDATES);
        const request = { candidate, ttlMs: random.pick(TTLS), linkSize };
        let result = await call(() => harness.core.acquireLease(request));
        for (let replay = 0; result === null; replay += 1) {
          result = replay >= REPLAYS
            ? await harness.core.acquireLease(request)
            : await call(() => harness.core.acquireLease(request));
        }
        if (result.ok) terms.set(candidate, result.term);
        break;
      }
      case "renew": {
        const leader = random.pick(CANDIDATES);
        await call(() =>
          harness.core.renewLease({ leader, ttlMs: random.pick(TTLS) })
        );
        break;
      }
      case "release":
        await call(() =>
          harness.core.releaseLease({ leader: random.pick(CANDIDATES) })
        );
        break;
      case "append":
        await appendOnce(step);
        break;
      case "read": {
        const status = await harness.core.status();
        const from = status.trimmedThrough + 1 +
          random.int(Math.max(1, status.head - status.trimmedThrough));
        const window = await call(() =>
          harness.core.read({ from, limit: 1 + random.int(12) })
        );
        if (window !== null && !window.ok) {
          fail(step, `read from ${from}: ${show(window)}`);
        }
        break;
      }
      case "snapshot": {
        const status = await harness.core.status();
        if (status.head <= 1) break;
        const through = 1 + random.int(status.head - 1);
        await call(() =>
          harness.core.recordSnapshot({
            throughSeq: through,
            ref: `s/${through}`,
          })
        );
        break;
      }
      case "trim": {
        const status = await harness.core.status();
        const through = status.snapshot?.throughSeq ?? 0;
        if (through === 0) break;
        const links = harness.store.all().length;
        const result = await call(() =>
          harness.core.trim({ throughSeq: 1 + random.int(through) })
        );
        if (result?.ok && harness.store.all().length < links) {
          note("dropped");
        }
        break;
      }
      case "tick":
        harness.nowMs += random.int(2 * TTLS[TTLS.length - 1]);
        break;
      case "restart":
        harness.restart();
        note("restart");
        break;
      case "steal": {
        const last = harness.store.last();
        if (last === null) break;
        const segment: SegmentAPI = harness.link(last.link);
        const stolen = await segment.capture({
          start: 0,
          end: linkSize,
          owner: "operator",
        });
        if (stolen.ok) note("steal");
        break;
      }
    }
    await verify(step);
  }
  const links = harness.store.all();
  if (links.some((link) => link.sealedAt !== null)) note("sealed");
  if (links.length >= 3) note("chain");
  note(`size-${linkSize}`);
  assert(harness.store.all().length >= 1 || lastHead === 1, "links kept");
}

Deno.test("randomized histories keep every acknowledged record, once", async () => {
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    await run(seed);
  }
  for (
    const what of [
      "thrown",
      "replayed",
      "proved",
      "unknown",
      "restart",
      "steal",
      "sealed",
      "chain",
      "dropped",
      "size-8",
      "size-9",
      "size-16",
    ]
  ) {
    assert(
      (seen.get(what) ?? 0) > 0,
      `no history reached ${what}: ${show([...seen])}`,
    );
  }
});
