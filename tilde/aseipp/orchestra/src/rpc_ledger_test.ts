// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/**
 * Typed Repository/EpochLedger boundary regressions. These scenarios exercise
 * clone-isolated RPC, reservation replay, compare-and-swap races, independent
 * notification counters, durable acknowledgements, and schema rejection. They
 * call production object methods through the fake namespace; the real celld
 * E2E separately verifies the same transport during Workflow/restart recovery.
 * @module
 */
import { EpochLedger } from "./epoch_ledger.ts";
import type { EpochState } from "./model.ts";
import { Repository } from "./repository.ts";
import { epochCellName } from "./util/identifiers.ts";
import { epochStub } from "./util/objects.ts";
import { unwrapRpc } from "./util/rpc.ts";
import {
  assert,
  assertEquals,
  assertRejects,
  fakeEnvironment,
} from "./util/testing.ts";

Deno.test("ledger prototypes expose only architectural RPC entrypoints", () => {
  assertEquals(Object.getOwnPropertyNames(EpochLedger.prototype).sort(), [
    "alarm",
    "constructor",
    "finalize",
    "getState",
    "initialize",
    "recordNotification",
    "save",
  ]);
  assertEquals(Object.getOwnPropertyNames(Repository.prototype).sort(), [
    "alarm",
    "constructor",
    "finish",
    "getState",
    "submitEpoch",
  ]);
});

Deno.test("ledger RPC clones snapshots and merges notifications across CAS races", async () => {
  const env = fakeEnvironment();
  const repo = env.REPOSITORY.getByName("repo");
  const receipt = unwrapRpc(
    await repo.submitEpoch({ repo: "repo", revision: "one" }),
  );
  const ledger = epochStub(env, receipt);
  const original = await ledger.getState();
  assert(original);
  original.revision = "caller-only";
  assertEquals((await ledger.getState())!.revision, "one");

  const first = await ledger.getState();
  const second = await ledger.getState();
  assert(first && second);
  unwrapRpc(await ledger.recordNotification());
  const results = await Promise.all([ledger.save(first), ledger.save(second)]);
  assertEquals(results.filter((result) => result.ok).length, 1);
  assertEquals(results.find((result) => !result.ok), {
    ok: false,
    status: 409,
    error: "stale epoch generation",
  });
  // The receiver increments its cloned argument, not the caller's snapshot.
  assertEquals(first.generation, 0);
  assertEquals(second.generation, 0);
  const current = await ledger.getState();
  assert(current);
  assertEquals(current.generation, 1);
  assertEquals(current.notifications_received, 1);

  // Replayed reservation initialization cannot rewind generation/notifications.
  const replayed = await ledger.initialize(original);
  assertEquals(replayed, current);
  replayed.revision = "response-only";
  assertEquals((await ledger.getState())!.revision, "one");
  const wrongWriter = { ...current, workflow_id: "foreign_workflow" };
  assertEquals(await ledger.save(wrongWriter), {
    ok: false,
    status: 409,
    error: "stale epoch generation",
  });
  assertEquals(await ledger.getState(), current);
});

Deno.test("ledger initialization save and notification acknowledge only after sync", async () => {
  const env = fakeEnvironment();
  const receipt = unwrapRpc(
    await env.REPOSITORY.getByName("repo").submitEpoch({
      repo: "repo",
      revision: "one",
    }),
  );
  const snapshot = await epochStub(env, receipt).getState();
  assert(snapshot);
  const ledger = env.EPOCH.getByName("isolated");
  const storage = env.EPOCH.instances.get("isolated")!.state.storage;
  const operations: (() => Promise<unknown>)[] = [
    () => ledger.initialize(snapshot),
    () => ledger.save(snapshot),
    () => ledger.recordNotification(),
  ];
  for (const operation of operations) {
    const entered = Promise.withResolvers<void>();
    const durable = Promise.withResolvers<void>();
    storage.sync = () => {
      entered.resolve();
      return durable.promise;
    };
    let acknowledged = false;
    const result = operation().then((value) => {
      acknowledged = true;
      return value;
    });
    await entered.promise;
    assertEquals(acknowledged, false);
    durable.resolve();
    await result;
    assertEquals(acknowledged, true);
  }
  assertEquals((await ledger.getState())!.generation, 1);
  assertEquals((await ledger.getState())!.notifications_received, 1);
});

Deno.test("ledger sync failures reject instead of becoming successful RPC receipts", async () => {
  const env = fakeEnvironment();
  const receipt = unwrapRpc(
    await env.REPOSITORY.getByName("repo").submitEpoch({
      repo: "repo",
      revision: "one",
    }),
  );
  const snapshot = await epochStub(env, receipt).getState();
  assert(snapshot);
  for (const operation of ["initialize", "save", "notification"] as const) {
    const ledger = env.EPOCH.getByName(operation);
    if (operation !== "initialize") await ledger.initialize(snapshot);
    const storage = env.EPOCH.instances.get(operation)!.state.storage;
    storage.sync = () => Promise.reject(new Error("durability unavailable"));
    await assertRejects(
      () =>
        operation === "initialize"
          ? ledger.initialize(snapshot)
          : operation === "save"
          ? ledger.save(snapshot)
          : ledger.recordNotification(),
      "durability unavailable",
    );
  }
});

Deno.test("ledger absent and incompatible state preserve explicit protocol failures", async () => {
  const env = fakeEnvironment();
  const ledger = env.EPOCH.getByName("missing");
  assertEquals(await ledger.getState(), null);
  assertEquals(await ledger.recordNotification(), {
    ok: false,
    status: 404,
    error: "epoch not found",
  });
  const receipt = unwrapRpc(
    await env.REPOSITORY.getByName("repo").submitEpoch({
      repo: "repo",
      revision: "one",
    }),
  );
  const snapshot = await epochStub(env, receipt).getState();
  assert(snapshot);
  assertEquals(await ledger.save(snapshot), {
    ok: false,
    status: 404,
    error: "ledger route not found",
  });
  await env.EPOCH.instances.get("missing")!.state.storage.put("epoch", {
    ...snapshot,
    version: -1,
  });
  await assertRejects(
    () => ledger.getState(),
    "old state; use a fresh celld state directory",
  );
  await assertRejects(
    () => ledger.initialize(snapshot),
    "old state; use a fresh celld state directory",
  );
  for (
    const result of [
      await ledger.save(snapshot),
      await ledger.recordNotification(),
    ]
  ) {
    assertEquals(result, {
      ok: false,
      status: 409,
      error: "old state; use a fresh celld state directory",
    });
  }
});

Deno.test("Repository RPC replay and finalization preserve the successful frontier", async () => {
  const env = fakeEnvironment();
  const repo = env.REPOSITORY.getByName("repo");
  const first = unwrapRpc(
    await repo.submitEpoch({ repo: "repo", revision: "one" }),
  );
  const second = unwrapRpc(
    await repo.submitEpoch({ repo: "repo", revision: "two" }),
  );
  const third = unwrapRpc(
    await repo.submitEpoch({ repo: "repo", revision: "three" }),
  );
  const replay = unwrapRpc(
    await repo.submitEpoch({ repo: "repo", revision: "one" }),
  );
  assertEquals(replay, { ...first, created: false });
  assertEquals((await repo.getState()).next_sequence, 4);
  assertEquals(await repo.finish("missing"), {
    ok: false,
    status: 404,
    error: "unknown epoch",
  });
  assertEquals(await repo.finish(first.epoch_id), {
    ok: false,
    status: 409,
    error: "epoch not terminal",
  });

  const firstLedger = epochStub(env, first);
  const successful = await firstLedger.getState();
  assert(successful);
  successful.state = "complete";
  successful.completed_at = Date.now();
  unwrapRpc(await firstLedger.save(successful));
  assertEquals(unwrapRpc(await repo.finish(first.epoch_id)), { ok: true });
  const secondLedger = epochStub(env, second);
  const failed = await secondLedger.getState();
  assert(failed);
  assertEquals(failed.previous_revision, "one");
  failed.state = "failed";
  failed.completed_at = Date.now();
  failed.error = "planner unavailable";
  unwrapRpc(await secondLedger.save(failed));
  assertEquals(unwrapRpc(await repo.finish(second.epoch_id)), { ok: true });
  assertEquals(
    (await epochStub(env, third).getState())!.previous_revision,
    "one",
  );
  assertEquals(unwrapRpc(await repo.finish(first.epoch_id)), {
    duplicate: true,
  });
  const current = await repo.getState();
  assertEquals(current.active, third.epoch_id);
  assertEquals(current.pending, []);
  current.epochs[first.epoch_id].revision = "caller-only";
  assertEquals((await repo.getState()).epochs[first.epoch_id].revision, "one");
});

Deno.test("Repository persists a reservation before kickoff and rejects failed sync", async () => {
  const env = fakeEnvironment();
  const repo = env.REPOSITORY.getByName("repo");
  const storage = env.REPOSITORY.instances.get("repo")!.state.storage;
  const entered = Promise.withResolvers<void>();
  const durable = Promise.withResolvers<void>();
  storage.sync = () => {
    entered.resolve();
    return durable.promise;
  };
  let acknowledged = false;
  const submission = repo.submitEpoch({ repo: "repo", revision: "one" }).then(
    (result) => {
      acknowledged = true;
      return result;
    },
  );
  await entered.promise;
  assertEquals(acknowledged, false);
  assertEquals(env.EVENTS.messages.length, 0);
  durable.resolve();
  const receipt = unwrapRpc(await submission);
  assertEquals(env.EVENTS.messages.length, 1);
  const epoch = await env.EPOCH.instances.get(
    epochCellName(receipt.repo, receipt.epoch_id),
  )!.state.storage.get<EpochState>("epoch");
  assert(epoch);
  storage.sync = () =>
    Promise.reject(new Error("reservation durability unavailable"));
  await assertRejects(
    () => repo.submitEpoch({ repo: "repo", revision: "two" }),
    "reservation durability unavailable",
  );
  assertEquals(env.EVENTS.messages.length, 1);
});
