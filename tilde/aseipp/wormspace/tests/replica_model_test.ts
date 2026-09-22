// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A randomized model check of WormPaxos under faults.
 *
 * Each seed runs two or three replicas of one group concurrently over the
 * fake segments. Each replica's task proposes, learns, sometimes fires two
 * proposals at once, and sometimes restarts (a new core over the same
 * store). Every proposal by a replica that does not lead is a steal, so the
 * replicas take leadership from each other constantly. A pipeliner plays a
 * leader that crashed mid-batch: it captures the segment at the chain's tail
 * and writes one register beyond it, leaving a hole the next takeover must
 * fill. Faults are drawn per segment call: throw without effect, or take
 * effect and lose the reply; now and then an outage makes a run of
 * consecutive calls throw, as while an owner is failed over.
 *
 * The truth is the segments' registers themselves, read straight from the
 * fakes. Checked after every replica operation and at the end:
 *
 *   - a replica's `applied` prefix is written, all of it, and its table is
 *     exactly the replay of that prefix (so replicas at equal `applied` have
 *     equal state, and every replica's sequence is the one global sequence);
 *   - no command is in the chain twice (every `set` carries a value no
 *     other proposal uses), and every acknowledged proposal is at the
 *     address it was acknowledged at, with no address acknowledged twice
 *     (each address has one winner);
 *   - a proposal refused with `CONTENDED` is nowhere in the chain;
 *   - after a final quiet round of learning, every replica has applied the
 *     whole written prefix and all tables are equal.
 *
 * @module
 */

import {
  type Command,
  decodeCommand,
  ReplicaCore,
} from "@wormspace/layers/replica_core";
import { encodeCommand } from "@wormspace/layers/replica_core";
import { isTransient } from "@wormspace/segment/serial";
import { assert, assertEquals, assertOk, show } from "@celld/assert";
import { FakeSegments } from "@wormspace/testing/fake_segment";
import { MemoryReplicaStore } from "./memory_stores.ts";
import { Random } from "@wormspace/testing/random";

const SEEDS = 60;
const FAST = { attempts: 4, pauseMs: 0 };

type Slot = Command | null | "pending";

interface Member {
  name: string;
  store: MemoryReplicaStore;
  core: ReplicaCore;
  id: { smr: string; replica: string };
}

/** Every register of the chain, straight from the fakes, in address order. */
function truth(segments: FakeSegments, size: number): Slot[] {
  const log: Slot[] = [];
  for (let index = 0;; index += 1) {
    const segment = segments.get(`g.${index}`);
    if (!segment.meta.allocated) return log;
    for (let offset = 0; offset < size; offset += 1) {
      const row = segment.registers.get(offset);
      log.push(row === undefined ? "pending" : decodeCommand(row.value));
    }
  }
}

function replay(log: readonly Slot[], applied: number): [string, string][] {
  const table = new Map<string, string>();
  for (const slot of log.slice(0, applied)) {
    if (slot === null || slot === "pending") continue;
    if (slot.op === "set") table.set(slot.key, slot.value);
    if (slot.op === "del") table.delete(slot.key);
  }
  return [...table.entries()].sort(([a], [b]) => a < b ? -1 : 1);
}

/** A `set` carries a value no other proposal uses, so it names itself. */
function identity(slot: Slot): string | null {
  if (slot === null || slot === "pending" || slot.op !== "set") return null;
  return `${slot.key}=${slot.value}`;
}

async function run(seed: number, seen: Set<string>): Promise<void> {
  const where = `seed ${seed}`;
  const random = new Random(seed);
  const size = random.pick([2, 3, 5, 8]);
  const segments = new FakeSegments();
  const names = random.chance(0.5) ? ["a", "b"] : ["a", "b", "c"];
  const members: Member[] = names.map((name) => {
    const store = new MemoryReplicaStore();
    return {
      name,
      store,
      core: new ReplicaCore(store, segments.resolve, FAST),
      id: { smr: "g", replica: name },
    };
  });
  for (const member of members) {
    assertOk(await member.core.init({ ...member.id, size }));
  }

  let chaos = true;
  // Calls left in the current outage: an owner being failed over refuses
  // several calls in a row, which is what exhausts a proposal's retries.
  let outage = 0;
  segments.faults = (method) => {
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
    if (draw < 0.04) return "throw";
    if (method !== "read" && method !== "status" && draw < 0.08) {
      if (method === "write") seen.add("write-lost");
      return "lost";
    }
    return undefined;
  };

  const acks = new Map<number, Command>();
  const refused = new Set<string>();
  const terms = new Set<number>();
  const expectTransient = (error: unknown, what: string) => {
    if (!isTransient(error)) {
      throw new Error(`${where}: ${what} threw ${show(String(error))}`);
    }
  };

  const check = (member: Member, what: string) => {
    const state = member.store.state;
    if (state === null) return;
    const log = truth(segments, size);
    const prefix = log.slice(0, state.applied);
    assert(
      prefix.length === state.applied && !prefix.includes("pending"),
      `${where}: ${member.name} applied ${state.applied} past the written ` +
        `prefix after ${what}: ${show(log)}`,
    );
    assertEquals(
      member.store.entries(),
      replay(log, state.applied),
      `${where}: ${member.name}'s table at ${state.applied} after ${what}`,
    );
  };

  let counter = 0;
  const proposal = (member: Member): Command => {
    counter += 1;
    const key = `k${random.int(4)}`;
    return random.chance(0.15)
      ? { op: "del", key }
      : { op: "set", key, value: `${member.name}${counter}` };
  };

  const propose = async (member: Member) => {
    const command = proposal(member);
    const label = show(command);
    try {
      const result = await member.core.propose({ ...member.id, command });
      if (result.ok) {
        assert(
          !acks.has(result.address),
          `${where}: address ${result.address} acknowledged to ` +
            `${show(acks.get(result.address))} and ${label}`,
        );
        acks.set(result.address, command);
        terms.add(result.term);
        if (result.address >= size) seen.add("rollover");
      } else {
        assertEquals(result.code, "CONTENDED", `${where}: propose ${label}`);
        const refusedLabel = identity(command);
        if (refusedLabel !== null) refused.add(refusedLabel);
        seen.add("contended");
      }
    } catch (error) {
      expectTransient(error, `propose ${label}`);
      seen.add("propose-threw");
    }
  };

  const replicaTask = async (index: number) => {
    let member = members[index];
    for (let turn = 0; turn < 14; turn += 1) {
      await random.yield(4);
      const draw = random.next();
      if (draw < 0.55) {
        await propose(member);
      } else if (draw < 0.7) {
        seen.add("concurrent-propose");
        await Promise.all([propose(member), propose(member)]);
      } else if (draw < 0.9) {
        try {
          await member.core.learn({
            ...member.id,
            maxCommands: 1 + random.int(2 * size),
          });
        } catch (error) {
          expectTransient(error, "learn");
        }
      } else {
        // A restart: a new instance over what was committed.
        seen.add("restart");
        member = {
          ...member,
          core: new ReplicaCore(member.store, segments.resolve, FAST),
        };
        members[index] = member;
      }
      check(member, `turn ${turn}`);
    }
  };

  const pipeliner = async () => {
    for (let turn = 0; turn < 3; turn += 1) {
      await random.yield(60);
      const log = truth(segments, size);
      const tail = log.indexOf("pending");
      if (tail < 0 || (tail + 1) % size === 0) continue;
      const segment = segments.get(`g.${Math.floor(tail / size)}`);
      try {
        const captured = await segment.capture({ start: 0, end: size });
        if (!captured.ok) continue;
        counter += 1;
        const bytes = assertOk(
          encodeCommand({ op: "set", key: "p", value: `p${counter}` }),
        ).bytes;
        await segment.write({
          start: (tail % size) + 1,
          values: [bytes],
          captureId: captured.captureId,
        });
      } catch (error) {
        expectTransient(error, "pipeliner");
      }
    }
  };

  await Promise.all([
    ...members.map((_, index) => replicaTask(index)),
    pipeliner(),
  ]);

  chaos = false;
  for (const member of members) {
    const learned = assertOk(await member.core.learn({ ...member.id }));
    check(member, "the final learn");
    const log = truth(segments, size);
    const written = log.indexOf("pending") < 0
      ? log.length
      : log.indexOf("pending");
    assertEquals(
      learned.applied,
      written,
      `${where}: ${member.name} caught up`,
    );
  }
  for (const member of members.slice(1)) {
    assertEquals(
      member.store.entries(),
      members[0].store.entries(),
      `${where}: ${member.name} and ${members[0].name}`,
    );
  }

  const log = truth(segments, size);
  const where_ = new Map<string, number>();
  for (const [address, slot] of log.entries()) {
    if (slot !== "pending" && slot !== null && slot.op === "noop") {
      seen.add("hole-filled");
    }
    const label = identity(slot);
    if (label === null) continue;
    assert(
      !where_.has(label),
      `${where}: ${label} at ${where_.get(label)} and ${address}`,
    );
    where_.set(label, address);
  }
  for (const [address, command] of acks) {
    assertEquals(log[address], command, `${where}: acknowledged at ${address}`);
  }
  for (const label of refused) {
    assert(!where_.has(label), `${where}: refused ${label} is in the chain`);
  }
  if (terms.size > 1) seen.add("steal");
}

Deno.test("randomized replicas under steals and faults keep every WormPaxos invariant", async () => {
  const seen = new Set<string>();
  for (let seed = 1; seed <= SEEDS; seed += 1) await run(seed, seen);
  for (
    const state of [
      "outage",
      "write-lost",
      "steal",
      "rollover",
      "propose-threw",
      "concurrent-propose",
      "restart",
      "hole-filled",
    ]
  ) {
    assert(seen.has(state), `the generator never produced ${state}`);
  }
});
