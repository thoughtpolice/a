// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * WormPaxos over the fake segments: replicas sharing one chain, their
 * leadership, hole filling, rollover, and the faults between them.
 *
 * @module
 */

import { encodeValue } from "@wormspace/layers/entry";
import {
  checkCommand,
  type Command,
  decodeCommand,
  encodeCommand,
  ReplicaCore,
} from "@wormspace/layers/replica_core";
import { assert, assertCode, assertEquals, assertOk } from "@celld/assert";
import { FakeSegments } from "@wormspace/testing/fake_segment";
import { MemoryReplicaStore } from "./memory_stores.ts";

const FAST = { attempts: 4, pauseMs: 0 };

interface Member {
  name: string;
  store: MemoryReplicaStore;
  core: ReplicaCore;
  id: { smr: string; replica: string };
}

function member(segments: FakeSegments, name: string, smr = "g"): Member {
  const store = new MemoryReplicaStore();
  return {
    name,
    store,
    core: new ReplicaCore(store, segments.resolve, FAST),
    id: { smr, replica: name },
  };
}

async function group(names: string[], size = 8) {
  const segments = new FakeSegments();
  const members = names.map((name) => member(segments, name));
  for (const replica of members) {
    assertOk(await replica.core.init({ ...replica.id, size }));
  }
  return { segments, members };
}

function set(key: string, value: string): Command {
  return { op: "set", key, value };
}

function propose(replica: Member, command: Command) {
  return replica.core.propose({ ...replica.id, command });
}

async function learnAll(replica: Member) {
  return assertOk(await replica.core.learn({ ...replica.id }));
}

function noop(): Uint8Array {
  return assertOk(encodeCommand({ op: "noop" })).bytes;
}

function bytesOf(command: Command): Uint8Array {
  return assertOk(encodeCommand(command)).bytes;
}

/** The commands at addresses 0.. of the chain, read straight from segments. */
async function chainLog(segments: FakeSegments, size: number, smr = "g") {
  const log: (Command | "pending" | null)[] = [];
  for (let index = 0;; index += 1) {
    const segment = segments.get(`${smr}.${index}`);
    const window = await segment.read({ start: 0, count: size });
    if (!window.ok) return log;
    for (const register of window.registers) {
      log.push(
        register.state === "written"
          ? decodeCommand(register.value as Uint8Array)
          : "pending",
      );
    }
  }
}

Deno.test("commands are canonical JSON value entries, and only these decode", () => {
  assertEquals(
    new TextDecoder().decode(bytesOf(set("k", "v")).subarray(1)),
    '{"op":"set","key":"k","value":"v"}',
  );
  for (
    const command of [set("k", ""), { op: "del", key: "k" }, { op: "noop" }]
  ) {
    assertEquals(decodeCommand(bytesOf(command as Command)), command);
  }
  for (
    const bad of [
      null,
      [],
      { op: "set", key: "k" },
      { op: "set", key: "", value: "v" },
      { op: "set", key: "k", value: 1 },
      { op: "set", key: "k", value: "v", extra: 1 },
      { op: "del", key: "k", value: "v" },
      { op: "noop", key: "k" },
      { op: "put", key: "k", value: "v" },
      { op: "set", key: "k".repeat(1025), value: "v" },
    ]
  ) {
    assertCode(checkCommand(bad), "INVALID");
  }
  const garbage = [
    new Uint8Array([1]),
    new Uint8Array([9]),
    assertOk(encodeValue(new TextEncoder().encode("not json"))).bytes,
    assertOk(encodeValue(new TextEncoder().encode('{"op":"put"}'))).bytes,
    assertOk(encodeValue(new Uint8Array([0xff]))).bytes,
  ];
  for (const bytes of garbage) assertEquals(decodeCommand(bytes), null);
});

Deno.test("the first proposal creates the chain, takes leadership, and applies", async () => {
  const { segments, members: [a] } = await group(["a"]);
  assertEquals(await propose(a, set("x", "1")), {
    ok: true,
    address: 0,
    term: 1,
    applied: 1,
  });
  assertEquals(assertOk(await a.core.lookup({ ...a.id, key: "x" })), {
    ok: true,
    key: "x",
    value: "1",
    applied: 1,
  });
  assertEquals(assertOk(await a.core.state(a.id)), {
    ok: true,
    smr: "g",
    replica: "a",
    applied: 1,
    leader: { index: 0, captureId: 1, tail: 1 },
    size: 8,
    preferredSize: 8,
  });
  const status = assertOk(await segments.get("g.0").status());
  assertEquals([status.size, status.allocator], [8, "replica:a"]);
});

Deno.test("a sticky leader's proposal is one write", async () => {
  const { segments, members: [a] } = await group(["a"]);
  assertOk(await propose(a, set("x", "1")));
  const before = segments.calls.length;
  assertEquals(assertOk(await propose(a, set("x", "2"))).address, 1);
  assertEquals(
    segments.calls.slice(before).map((call) => call.method),
    ["write"],
  );
});

Deno.test("alternating proposers steal leadership and converge", async () => {
  const { segments, members: [a, b] } = await group(["a", "b"]);
  const terms: number[] = [];
  for (let round = 0; round < 6; round += 1) {
    const proposer = round % 2 === 0 ? a : b;
    const result = assertOk(
      await propose(proposer, set(`k${round}`, `${round}`)),
    );
    assertEquals(result.address, round);
    terms.push(result.term);
  }
  assertEquals(terms, [1, 2, 3, 4, 5, 6], "every steal is a new round");
  await learnAll(a);
  await learnAll(b);
  assertEquals(a.store.entries(), b.store.entries());
  assertEquals(a.store.entries().length, 6);
  assertEquals(a.store.state?.applied, 6);
  assertEquals(b.store.state?.applied, 6);
  // Every takeover's capture pruned the one before it.
  assertEquals(assertOk(await segments.get("g.0").status()).captures, 1);
  // The loser of the last steal no longer leads; the winner does.
  assertEquals(a.store.state?.leader, null);
  assertEquals(b.store.state?.leader, { index: 0, captureId: 6, tail: 6 });
});

Deno.test("a deposed leader's next write is refused and it takes over again", async () => {
  const { segments, members: [a, b] } = await group(["a", "b"]);
  assertOk(await propose(a, set("x", "a")));
  assertOk(await propose(b, set("x", "b")));
  const before = segments.calls.length;
  assertEquals(assertOk(await propose(a, set("x", "a2"))).address, 2);
  const methods = segments.calls.slice(before).map((call) => call.method);
  assertEquals(methods[0], "write", "it tried its old round first");
  assert(methods.includes("capture"), "then took over");
  await learnAll(b);
  assertEquals(
    assertOk(await b.core.lookup({ ...b.id, key: "x" })).value,
    "a2",
  );
});

Deno.test("learn applies in order, skips noops, and reports where it is blocked", async () => {
  const { segments, members: [a, b] } = await group(["a", "b"]);
  assertOk(await propose(a, set("x", "1")));
  assertOk(await propose(a, { op: "noop" }));
  assertOk(await propose(a, { op: "del", key: "x" }));
  assertOk(await propose(a, set("y", "2")));
  assertEquals(await b.core.learn({ ...b.id, maxCommands: 2 }), {
    ok: true,
    applied: 2,
    learned: 2,
    blocked: null,
  });
  assertEquals(assertOk(await b.core.lookup({ ...b.id, key: "x" })).value, "1");
  assertEquals(await b.core.learn(b.id), {
    ok: true,
    applied: 4,
    learned: 2,
    blocked: 4,
  });
  assertEquals(b.store.entries(), [["y", "2"]]);
  // Every window with a written register passed its segment's barrier.
  const listens = segments.calls.filter((call) => call.method === "listen");
  assert(listens.length >= 2, "learn listened after reading");
  for (const call of listens) {
    assertEquals(call.request, { since: 0, timeoutMs: 0 });
  }
  assertCode(
    await b.core.learn({ ...b.id, maxCommands: 0 }),
    "INVALID",
  );
});

Deno.test("a learner with no chain yet has nothing to learn", async () => {
  const segments = new FakeSegments();
  const a = member(segments, "a");
  assertEquals(await a.core.learn(a.id), {
    ok: true,
    applied: 0,
    learned: 0,
    blocked: null,
  });
  assertEquals(assertOk(await a.core.state(a.id)).size, null);
});

Deno.test("a proposer that crashed after capturing leaves nothing to fill", async () => {
  const { segments, members: [a, b] } = await group(["a", "b"]);
  assertOk(await propose(a, set("x", "1")));
  // `a` takes over again (as after a restart that forgot it led), then every
  // write it attempts dies before reaching the segment.
  assertOk(await segments.get("g.0").capture({ start: 1, end: 8 }));
  segments.faults = (method, request) =>
    method === "write" && (request as { captureId: number }).captureId !== 2
      ? "throw"
      : undefined;
  let error: unknown;
  try {
    await propose(a, set("x", "lost"));
  } catch (caught) {
    error = caught;
  }
  assertEquals((error as { code?: string }).code, "owner_unreachable");
  segments.faults = undefined;
  assertEquals(assertOk(await propose(b, set("x", "b"))).address, 1);
  assertEquals(await chainLog(segments, 8), [
    set("x", "1"),
    set("x", "b"),
    ...Array(6).fill("pending"),
  ]);
});

Deno.test("holes a deposed pipelining leader left are filled with noop", async () => {
  const { segments, members: [a, b] } = await group(["a", "b"]);
  assertOk(await propose(a, set("x", "1")));
  assertOk(await propose(a, set("x", "2")));
  // Another leader captured, wrote 3 and 5 of a pipelined batch, and died.
  const segment = segments.get("g.0");
  const round = assertOk(await segment.capture({ start: 2, end: 8 })).captureId;
  assertOk(
    await segment.write({
      start: 3,
      values: [bytesOf(set("y", "3"))],
      captureId: round,
    }),
  );
  assertOk(
    await segment.write({
      start: 5,
      values: [bytesOf(set("z", "5"))],
      captureId: round,
    }),
  );
  assertEquals(await b.core.learn(b.id), {
    ok: true,
    applied: 2,
    learned: 2,
    blocked: 2,
  });
  const result = assertOk(await propose(b, set("w", "6")));
  assertEquals(result.address, 6);
  assertEquals(await chainLog(segments, 8), [
    set("x", "1"),
    set("x", "2"),
    { op: "noop" },
    set("y", "3"),
    { op: "noop" },
    set("z", "5"),
    set("w", "6"),
    "pending",
  ]);
  const filled = assertOk(await segment.read({ start: 2, count: 3 })).registers;
  assertEquals(filled[0].round, result.term, "the noop is the new round's");
  assertEquals(filled[0].value, noop());
  // The old leader's in-flight writes now fail, and it learns everything.
  assertCode(
    await segment.write({
      start: 7,
      values: [bytesOf(set("late", "!"))],
      captureId: round,
    }),
    "CAPTURE_STALE",
  );
  await learnAll(a);
  assertEquals(a.store.entries(), b.store.entries());
  assertEquals(
    b.store.entries(),
    [["w", "6"], ["x", "2"], ["y", "3"], ["z", "5"]],
  );
});

Deno.test("a lost reply to the proposal is settled by the replay", async () => {
  const { segments, members: [a, b] } = await group(["a", "b"]);
  assertOk(await propose(a, set("x", "1")));
  let lost = false;
  segments.faults = (method) => {
    if (method === "write" && !lost) {
      lost = true;
      return "lost";
    }
    return undefined;
  };
  assertEquals(assertOk(await propose(a, set("x", "2"))).address, 1);
  segments.faults = undefined;
  assertEquals(await learnAll(b), {
    ok: true,
    applied: 2,
    learned: 2,
    blocked: 2,
  });
  assertEquals(assertOk(await segments.get("g.0").status()).writes, 2);
});

Deno.test("a proposal whose outcome was unknown is learned, and leadership kept", async () => {
  const { segments, members: [a] } = await group(["a"]);
  assertOk(await propose(a, set("x", "1")));
  segments.faults = (method) => method === "write" ? "lost" : undefined;
  let error: unknown;
  try {
    // The write lands, and every replay's reply is lost too.
    await propose(a, set("x", "2"));
  } catch (caught) {
    error = caught;
  }
  assert(String(error).includes("DurabilityUnproven"), String(error));
  segments.faults = undefined;
  const captures = segments.count("capture");
  const next = assertOk(await propose(a, set("x", "3")));
  assertEquals([next.address, next.term], [2, 1]);
  assertEquals(segments.count("capture"), captures, "no new capture");
  assertEquals(assertOk(await a.core.lookup({ ...a.id, key: "x" })).value, "3");
  assertEquals(await chainLog(segments, 8), [
    set("x", "1"),
    set("x", "2"),
    set("x", "3"),
    ...Array(5).fill("pending"),
  ]);
});

Deno.test("proposals roll over into new links, and learners follow", async () => {
  const { segments, members: [a, b] } = await group(["a", "b"], 4);
  for (let index = 0; index < 10; index += 1) {
    assertEquals(
      assertOk(await propose(a, set(`k${index}`, `${index}`))).address,
      index,
    );
  }
  assertEquals(segments.names(), ["g.0", "g.1", "g.2"]);
  assertEquals(await learnAll(b), {
    ok: true,
    applied: 10,
    learned: 10,
    blocked: 10,
  });
  assertEquals(a.store.entries(), b.store.entries());
  // A steal right at a boundary takes the next link.
  for (let index = 10; index < 12; index += 1) {
    assertOk(await propose(a, set(`k${index}`, `${index}`)));
  }
  const stolen = assertOk(await propose(b, set("k12", "12")));
  assertEquals(stolen.address, 12);
  assertEquals(b.store.state?.leader?.index, 3);
  await learnAll(a);
  assertEquals(a.store.entries(), b.store.entries());
  assertEquals(a.store.state?.applied, 13);
});

Deno.test("one replica's concurrent proposals are serialised onto distinct addresses", async () => {
  const { members: [a, b] } = await group(["a", "b"], 4);
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, index) => propose(a, set(`k${index}`, "v"))),
  );
  assertEquals(
    results.map((result) => assertOk(result).address),
    [...Array(20).keys()],
  );
  await learnAll(b);
  assertEquals(a.store.entries(), b.store.entries());
});

Deno.test("size is the chain's: init sets a preference, link 0 decides", async () => {
  const segments = new FakeSegments();
  const a = member(segments, "a");
  const b = member(segments, "b");
  assertOk(await a.core.init({ ...a.id, size: 4 }));
  assertOk(await b.core.init({ ...b.id, size: 16 }));
  assertOk(await propose(a, set("x", "1")));
  assertCode(await a.core.init({ ...a.id, size: 5 }), "CONFLICT");
  // `b` prefers 16, but the chain is 4, and it adopts that.
  assertOk(await propose(b, set("y", "2")));
  assertEquals(assertOk(await b.core.state(b.id)).size, 4);
  const conflict = await b.core.init({ ...b.id, size: 16 });
  assertCode(conflict, "CONFLICT");
  assertEquals((conflict as { size: number }).size, 4);
  assertEquals(assertOk(await b.core.init({ ...b.id, size: 4 })).size, 4);
  assertCode(await a.core.init({ ...a.id, size: 0 }), "INVALID");
});

Deno.test("names, commands, and sizes are checked", async () => {
  const { members: [a] } = await group(["a"]);
  assertOk(await propose(a, set("x", "1")));
  assertCode(await a.core.state({ smr: "g", replica: "b" }), "INVALID");
  assertCode(await a.core.state({ smr: "h", replica: "a" }), "INVALID");
  assertCode(await a.core.state({ smr: "g", replica: "A" }), "INVALID");
  assertCode(await a.core.lookup({ ...a.id, key: "" }), "INVALID");
  assertCode(
    await a.core.propose({ ...a.id, command: { op: "put" } as never }),
    "INVALID",
  );
  assertCode(
    await propose(a, set("big", "x".repeat(1024 * 1024))),
    "TOO_LARGE",
  );
  assertEquals(assertOk(await a.core.state(a.id)).applied, 1);
});

Deno.test("registers that are not commands are skipped by every replica alike", async () => {
  const { segments, members: [a, b] } = await group(["a", "b"]);
  assertOk(await propose(a, set("x", "1")));
  const segment = segments.get("g.0");
  const round = assertOk(await segment.capture({ start: 1, end: 8 })).captureId;
  assertOk(
    await segment.write({
      start: 1,
      values: [new Uint8Array([7]), new Uint8Array([1])],
      captureId: round,
    }),
  );
  assertOk(await propose(b, set("y", "2")));
  await learnAll(a);
  assertEquals(a.store.state?.applied, 4);
  assertEquals(a.store.entries(), b.store.entries());
  assertEquals(a.store.entries(), [["x", "1"], ["y", "2"]]);
});

Deno.test("a restarted replica keeps its state and its leadership", async () => {
  const { segments, members: [a] } = await group(["a"]);
  assertOk(await propose(a, set("x", "1")));
  const restarted = new ReplicaCore(a.store, segments.resolve, FAST);
  const before = segments.calls.length;
  assertEquals(
    assertOk(await restarted.propose({ ...a.id, command: set("x", "2") }))
      .address,
    1,
  );
  assertEquals(
    segments.calls.slice(before).map((call) => call.method),
    ["write"],
  );
  assertEquals(
    assertOk(await restarted.lookup({ ...a.id, key: "x" })).value,
    "2",
  );
});
