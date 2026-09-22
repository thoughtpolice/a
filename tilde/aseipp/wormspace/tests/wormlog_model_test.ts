// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A randomized model check of WormLog under faults.
 *
 * Each seed runs several appenders concurrently against one log over the
 * fake segments and an in-memory sequencer, while a filler closes random
 * issued slots, an operator steals whole segments from the sequencer, and a
 * reader keeps reading. Faults are drawn per call: segment and sequencer
 * calls throw without effect or take effect and lose their reply, and some
 * writes are refused as `CAPTURE_STALE` without reaching the segment.
 * Now and then an outage makes a run of consecutive segment calls throw, as
 * while an owner is failed over. Interleaving comes from the seeded generator
 * yielding at random points, so a failing seed reproduces exactly.
 *
 * Checked, during the run and once it has quiesced and every pending slot
 * is filled:
 *
 *   - every acknowledged append reads back at its slot with identical bytes,
 *     and no two acknowledgements share a slot;
 *   - every record in the log was sent by an appender, appears once, and is
 *     either acknowledged at that slot or belongs to an append that threw
 *     (whose outcome the appender could not know);
 *   - a fill that reports a hole never lands on an acknowledged slot;
 *   - once a reader has seen a slot hold a record or a hole, it always does;
 *   - after the final fills, every slot below `next` is a record or a hole.
 *
 * @module
 */

import { SequencerCore } from "@wormspace/layers/sequencer_core";
import { isTransient } from "@wormspace/segment/serial";
import { type LogEntry, WormLog } from "@wormspace/layers/wormlog";
import { assert, assertEquals, assertOk, show } from "@celld/assert";
import { FakeSegments } from "@wormspace/testing/fake_segment";
import { FaultySequencer, MemorySequencerStore } from "./memory_stores.ts";
import { Random } from "@wormspace/testing/random";

const SEEDS = 100;
const FAST = { attempts: 4, pauseMs: 0 };
const text = new TextEncoder();
const utf8 = new TextDecoder();

type Outcome = "acked" | "threw" | "refused";

interface Sent {
  outcome: Outcome;
  slot?: number;
}

function payload(appender: number, index: number): Uint8Array {
  return text.encode(`a${appender}-${index}`);
}

async function readAll(wormlog: WormLog): Promise<LogEntry[]> {
  const entries: LogEntry[] = [];
  let from = assertOk(await wormlog.tail()).trimmedThrough + 1;
  for (;;) {
    const page = assertOk(await wormlog.read({ from, count: 1000 }));
    entries.push(...page.entries);
    if (page.entries.length === 0) return entries;
    from = page.entries[page.entries.length - 1].slot + 1;
    if (from >= page.next) return entries;
  }
}

async function run(seed: number, seen: Set<string>): Promise<void> {
  const where = `seed ${seed}`;
  const random = new Random(seed);
  const size = random.pick([2, 3, 5, 8]);
  const segments = new FakeSegments();
  const store = new MemorySequencerStore();
  const sequencer = new FaultySequencer(
    new SequencerCore(store, segments.resolve, FAST),
  );
  const wormlog = new WormLog(sequencer, segments.resolve, "log", FAST);
  assertOk(await wormlog.init(size));

  let chaos = true;
  // Calls left in the current outage: an owner being failed over refuses
  // several calls in a row, which is what exhausts an append's retries.
  let outage = 0;
  segments.faults = (method, request, name) => {
    if (!chaos) return undefined;
    if (outage > 0) {
      outage -= 1;
      return "throw";
    }
    if (random.chance(0.01)) {
      outage = 3 + random.int(6);
      seen.add("outage");
      return "throw";
    }
    const draw = random.next();
    if (method === "write") {
      if (draw < 0.05) {
        seen.add("write-throw");
        return "throw";
      }
      if (draw < 0.10) {
        seen.add("write-lost");
        return "lost";
      }
      const { start, captureId } = request as {
        start: number;
        captureId: number;
      };
      // A segment checks for a written register before the round, so a
      // stale refusal is only faithful where nothing landed yet.
      if (draw < 0.12 && !segments.get(name).registers.has(start)) {
        seen.add("stale-injected");
        return {
          ok: false,
          code: "CAPTURE_STALE",
          message: "injected",
          offset: start,
          round: captureId + 1,
          captureId,
        };
      }
      return undefined;
    }
    if (draw < 0.04) return "throw";
    if (method === "capture" && draw < 0.07) {
      seen.add("capture-lost");
      return "lost";
    }
    return undefined;
  };
  sequencer.faults = (method) => {
    if (!chaos) return undefined;
    const draw = random.next();
    if (method === "next" && draw < 0.05) {
      seen.add("token-lost");
      return "lost";
    }
    if (draw < 0.04) return "throw";
    if (draw < 0.06) return "lost";
    return undefined;
  };

  const sent = new Map<string, Sent>();
  const acks = new Map<number, string>();
  const fills: { slot: number; hole: boolean }[] = [];
  const observed = new Map<number, string>();
  const appenders = 2 + random.int(3);
  const perAppender = 10 + random.int(15);

  const expectTransient = (error: unknown, what: string) => {
    if (!isTransient(error)) {
      throw new Error(`${where}: ${what} threw ${show(String(error))}`);
    }
  };

  const appender = async (id: number) => {
    for (let index = 0; index < perAppender; index += 1) {
      await random.yield();
      const value = payload(id, index);
      const key = utf8.decode(value);
      try {
        const result = await wormlog.append(value);
        if (result.ok) {
          assert(
            !acks.has(result.slot),
            `${where}: slot ${result.slot} acknowledged to ${
              acks.get(result.slot)
            } and ${key}`,
          );
          acks.set(result.slot, key);
          sent.set(key, { outcome: "acked", slot: result.slot });
          if (result.attempts > 1) seen.add("retook-slot");
        } else {
          assertEquals(result.code, "CONTENDED", `${where}: append ${key}`);
          sent.set(key, { outcome: "refused" });
          seen.add("contended");
        }
      } catch (error) {
        expectTransient(error, `append ${key}`);
        sent.set(key, { outcome: "threw" });
        seen.add("append-threw");
      }
    }
  };

  const filler = async () => {
    for (let turn = 0; turn < perAppender; turn += 1) {
      await random.yield(6);
      const next = store.state?.next ?? 0;
      if (next === 0) continue;
      const slot = random.int(next);
      try {
        const result = await wormlog.fill(slot);
        if (result.ok) {
          fills.push({ slot, hole: result.hole });
          seen.add(result.hole ? "fill-hole" : "fill-value");
        }
      } catch (error) {
        expectTransient(error, `fill ${slot}`);
      }
    }
  };

  const operator = async () => {
    for (let turn = 0; turn < 3; turn += 1) {
      await random.yield(40);
      const next = store.state?.next ?? 0;
      if (next === 0) continue;
      const index = Math.floor(random.int(next) / size);
      try {
        const stolen = await segments.get(`log.${index}`).capture({
          start: 0,
          end: size,
          owner: "operator",
        });
        if (stolen.ok) seen.add("operator-steal");
      } catch (error) {
        expectTransient(error, "operator capture");
      }
    }
  };

  const reader = async () => {
    for (let turn = 0; turn < perAppender; turn += 1) {
      await random.yield(6);
      const next = store.state?.next ?? 0;
      if (next === 0) continue;
      try {
        const page = await wormlog.read({
          from: random.int(next),
          count: 1 + random.int(2 * size),
        });
        if (!page.ok) continue;
        for (const entry of page.entries) {
          if (entry.state === "pending") {
            seen.add("read-pending");
            assert(
              !observed.has(entry.slot),
              `${where}: slot ${entry.slot} went back to pending after ` +
                `${observed.get(entry.slot)}`,
            );
            continue;
          }
          const now = entry.state === "value"
            ? `value:${utf8.decode(entry.value)}`
            : entry.state;
          const before = observed.get(entry.slot);
          assert(
            before === undefined || before === now,
            `${where}: slot ${entry.slot} read ${before} then ${now}`,
          );
          observed.set(entry.slot, now);
        }
      } catch (error) {
        expectTransient(error, "read");
      }
    }
  };

  await Promise.all([
    ...Array.from({ length: appenders }, (_, id) => appender(id)),
    filler(),
    operator(),
    reader(),
  ]);

  // Quiesce, then close every slot nobody will ever write.
  chaos = false;
  const next = assertOk(await wormlog.tail()).next;
  if (next > size) seen.add("boundary");
  for (const entry of await readAll(wormlog)) {
    if (entry.state === "pending") {
      const filled = assertOk(await wormlog.fill(entry.slot));
      fills.push({ slot: entry.slot, hole: filled.hole });
    }
  }
  const entries = await readAll(wormlog);
  assertEquals(
    entries.map((entry) => entry.slot),
    [...Array(next).keys()],
    `${where}: the log is dense below next`,
  );

  const holder = new Map<string, number>();
  for (const entry of entries) {
    assert(
      entry.state === "value" || entry.state === "hole",
      `${where}: slot ${entry.slot} is ${entry.state} after the final fills`,
    );
    const earlier = observed.get(entry.slot);
    const now = entry.state === "value"
      ? `value:${utf8.decode(entry.value)}`
      : entry.state;
    assert(
      earlier === undefined || earlier === now,
      `${where}: slot ${entry.slot} read ${earlier}, finally ${now}`,
    );
    if (entry.state !== "value") continue;
    const key = utf8.decode(entry.value);
    const origin = sent.get(key);
    assert(
      origin !== undefined,
      `${where}: ${key} at ${entry.slot} was never sent`,
    );
    assert(
      !holder.has(key),
      `${where}: ${key} at ${holder.get(key)} and ${entry.slot}`,
    );
    holder.set(key, entry.slot);
    if (origin.outcome === "acked") {
      assertEquals(origin.slot, entry.slot, `${where}: ${key}'s slot`);
    } else {
      assertEquals(origin.outcome, "threw", `${where}: ${key} landed unacked`);
      seen.add("unacked-landed");
    }
  }
  for (const [slot, key] of acks) {
    assertEquals(holder.get(key), slot, `${where}: acknowledged ${key}`);
  }
  for (const fill of fills) {
    if (fill.hole) {
      assert(
        !acks.has(fill.slot),
        `${where}: a fill closed acked slot ${fill.slot}`,
      );
    } else {
      assert(
        entries[fill.slot].state === "value",
        `${where}: fill of ${fill.slot} saw a value that is not there`,
      );
    }
  }
}

Deno.test("randomized appenders under faults keep every WormLog invariant", async () => {
  const seen = new Set<string>();
  for (let seed = 1; seed <= SEEDS; seed += 1) await run(seed, seen);
  // A model test that never loses a token, never races a fill, or never
  // leaves an append's outcome unknown would pass vacuously.
  for (
    const state of [
      "outage",
      "write-throw",
      "write-lost",
      "stale-injected",
      "capture-lost",
      "token-lost",
      "retook-slot",
      "append-threw",
      "fill-hole",
      "fill-value",
      "operator-steal",
      "read-pending",
      "boundary",
    ]
  ) {
    assert(seen.has(state), `the generator never produced ${state}`);
  }
});
