// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/**
 * Terminal-publication recovery through the real ledger, broker, and Workflow.
 * Faults live at fake storage/R2/D1/RPC boundaries; no test manually releases a repository
 * or restarts a failed Workflow to repair the terminal publication obligation.
 * These fakes omit runtime retry delays, so outages remain injected until the
 * engine has exhausted its modeled attempts and terminal recovery is independent.
 * @module
 */
import { EpochLedger } from "./epoch_ledger.ts";
import type { EpochIdentity, EpochState } from "./model.ts";
import { epochCellName } from "./util/identifiers.ts";
import { getArtifact } from "./util/artifacts.ts";
import { epochStub } from "./util/objects.ts";
import { unwrapRpc } from "./util/rpc.ts";
import { FINALIZATION_BATCH_SIZE } from "./util/finalization.ts";
import {
  assert,
  assertEquals,
  assertRejects,
  claim,
  complete,
  epochView,
  type FakeEnvironment,
  fakeEnvironment,
  plannedTest,
  seed,
  settle,
  testManifest,
} from "./util/testing.ts";
import { advanceEpoch, failEpoch } from "./util/workflow.ts";

/** Install immutable terminal test evidence without starting a fake Workflow. */
async function terminalFixture(
  env: FakeEnvironment,
  id: EpochIdentity,
): Promise<EpochState> {
  const ledger = epochStub(env, id);
  const epoch = (await ledger.getState())!;
  const test = plannedTest();
  epoch.state = "complete";
  epoch.completed_at = Date.now();
  epoch.tests[test.id] = {
    ...test,
    state: "completed",
    baseline: null,
    observations: [],
    result: {
      outcome: "pass",
      duration_ms: 1,
      attempt: 1,
      agent_id: "agent",
      completed_at: epoch.completed_at,
    },
  };
  epoch.test_order = [test.id];
  epoch.counts = {
    expected: 1,
    completed: 1,
    pass: 1,
    fail: 0,
    infra_failure: 0,
  };
  unwrapRpc(await ledger.save(epoch));
  return epoch;
}

Deno.test("terminal alarm releases a stranded successor after D1 recovery without restarting the engine", async () => {
  const env = fakeEnvironment();
  const first = await seed(env, "one");
  const second = await seed(env, "two");
  await settle(env);
  const repository = env.REPOSITORY.getByName("repo");
  await repository.alarm();
  assertEquals((await repository.getState()).outbox, null);
  const job = await claim(env);
  assert(job && job.kind === "plan_epoch");
  const accepted = await complete(env, job, {
    kind: "plan_epoch",
    manifest: testManifest(job, []),
  });
  assert(accepted.response.ok);
  const execute = env.HISTORY.execute.bind(env.HISTORY);
  env.HISTORY.execute = () => Promise.reject(new Error("D1 unavailable"));
  env.EPOCH_RUNS.timeout();
  await settle(env);
  assertEquals((await epochView(env, first)).state, "complete");
  assertEquals(env.EPOCH_RUNS.runs.get(first.workflow_id)!.status, "errored");
  assertEquals((await repository.getState()).active, first.epoch_id);
  assertEquals((await epochView(env, second)).state, "queued");
  const name = epochCellName(first.repo, first.epoch_id);
  const old = env.EPOCH.instances.get(name)!;
  assert(await old.state.storage.getAlarm() !== null);
  env.HISTORY.execute = execute;
  // Model a cell restart: only durable storage carries the recovery obligation.
  const restored = new EpochLedger(old.state, env);
  env.EPOCH.instances.set(name, restored);
  await restored.alarm();
  assertEquals((await repository.getState()).active, second.epoch_id);
  assertEquals(
    (await repository.getState()).epochs[first.epoch_id].state,
    "complete",
  );
  assertEquals(await restored.state.storage.getAlarm(), null);
  await restored.alarm();
  assertEquals((await repository.getState()).active, second.epoch_id);
  assertEquals(env.EPOCH_RUNS.runs.get(first.workflow_id)!.status, "errored");
  assertEquals(env.EPOCH_RUNS.creations, 1);
});

Deno.test("terminal publication checkpoints bounded batches and resumes only unfinished projection", async () => {
  const env = fakeEnvironment();
  const id = await seed(env, "many");
  const ledger = epochStub(env, id);
  const epoch = (await ledger.getState())!;
  epoch.state = "complete";
  epoch.completed_at = Date.now();
  const count = FINALIZATION_BATCH_SIZE + 1;
  for (let i = 0; i < count; i++) {
    const test = plannedTest("test" + i);
    epoch.tests[test.id] = {
      ...test,
      state: "completed",
      baseline: null,
      observations: [],
      result: {
        outcome: "pass",
        duration_ms: 1,
        attempt: 1,
        agent_id: "agent",
        completed_at: epoch.completed_at,
      },
    };
    epoch.test_order.push(test.id);
  }
  epoch.counts = {
    expected: count,
    completed: count,
    pass: count,
    fail: 0,
    infra_failure: 0,
  };
  unwrapRpc(await ledger.save(epoch));
  assertEquals(await ledger.finalize(), false);
  assertEquals(env.HISTORY.resultCount, FINALIZATION_BATCH_SIZE);
  assertEquals(
    (await env.REPOSITORY.getByName("repo").getState()).active,
    id.epoch_id,
  );
  const batch = env.HISTORY.batch.bind(env.HISTORY);
  env.HISTORY.batch = () => Promise.reject(new Error("projection interrupted"));
  await assertRejects(() => ledger.finalize(), "projection interrupted");
  const object = env.EPOCH.instances.get(epochCellName(id.repo, id.epoch_id))!;
  assert(await object.state.storage.getAlarm() !== null);
  let writes = 0;
  env.HISTORY.batch = (statements) => {
    writes++;
    return batch(statements);
  };
  await object.alarm();
  assertEquals(writes, 1);
  assertEquals(env.HISTORY.resultCount, count);
  assertEquals(
    (await env.REPOSITORY.getByName("repo").getState()).active,
    null,
  );
  assertEquals(await ledger.finalize(), true);
  assertEquals(writes, 1);
  const terminal = (await ledger.getState())!;
  terminal.state = "running";
  assertEquals(await ledger.save(terminal), {
    ok: false,
    status: 409,
    error: "terminal epoch cannot be replaced",
  });
});

Deno.test("failed epoch fences pending work before unavailable D1 can delay successor release", async () => {
  const env = fakeEnvironment();
  const id = await seed(env, "bad");
  await advanceEpoch(env, id);
  env.HISTORY.execute = () => Promise.reject(new Error("D1 unavailable"));
  await assertRejects(
    () => failEpoch(env, id, "deadline exceeded"),
    "D1 unavailable",
  );
  assertEquals((await epochView(env, id)).state, "failed");
  assertEquals(await claim(env), null);
  const object = env.EPOCH.instances.get(epochCellName(id.repo, id.epoch_id))!;
  assert(await object.state.storage.getAlarm() !== null);
});

Deno.test("terminal alarm is armed before the snapshot and survives a pre-write crash harmlessly", async () => {
  const env = fakeEnvironment();
  const id = await seed(env, "crash");
  const ledger = epochStub(env, id);
  const object = env.EPOCH.instances.get(epochCellName(id.repo, id.epoch_id))!;
  const storage = object.state.storage;
  const put = storage.put.bind(storage);
  const terminal = (await ledger.getState())!;
  terminal.state = "failed";
  terminal.completed_at = Date.now();
  storage.put = async () => {
    assert(await storage.getAlarm() !== null);
    throw new Error("crash before terminal write");
  };
  await assertRejects(
    () => ledger.save(terminal),
    "crash before terminal write",
  );
  storage.put = put;
  await object.alarm();
  assertEquals((await ledger.getState())!.state, "queued");
  assertEquals(
    (await env.REPOSITORY.getByName("repo").getState()).active,
    id.epoch_id,
  );
  unwrapRpc(await ledger.save(terminal));
  await object.alarm();
  assertEquals(
    (await env.REPOSITORY.getByName("repo").getState()).active,
    null,
  );
});

Deno.test("finalization replays a projected batch after a failed cursor checkpoint and cell restart", async () => {
  const env = fakeEnvironment();
  const id = await seed(env, "checkpoint");
  const next = await seed(env, "successor");
  await terminalFixture(env, id);
  const ledger = epochStub(env, id);
  const name = epochCellName(id.repo, id.epoch_id);
  const original = env.EPOCH.instances.get(name)!;
  const storage = original.state.storage;
  const put = storage.put.bind(storage);
  let writes = 0;
  const batch = env.HISTORY.batch.bind(env.HISTORY);
  env.HISTORY.batch = (statements) => {
    writes++;
    return batch(statements);
  };
  storage.put = async (
    key: string | Record<string, unknown> | Map<string, unknown>,
    value?: unknown,
  ) => {
    if (key === "finalization") throw new Error("cursor write unavailable");
    if (typeof key === "string") await put(key, value);
    else await put(key);
  };
  await assertRejects(() => ledger.finalize(), "cursor write unavailable");
  assertEquals(env.HISTORY.resultCount, 1);
  assertEquals(writes, 1);
  assertEquals(await storage.get("finalization"), {
    indexed: false,
    next_test: 0,
    done: false,
  });
  assertEquals(
    (await env.REPOSITORY.getByName("repo").getState()).active,
    id.epoch_id,
  );
  assert(await storage.getAlarm() !== null);
  storage.put = put;
  const restored = new EpochLedger(original.state, env);
  env.EPOCH.instances.set(name, restored);
  await restored.alarm();
  assertEquals(writes, 2);
  assertEquals(env.HISTORY.resultCount, 1);
  assertEquals(
    (await env.REPOSITORY.getByName("repo").getState()).active,
    next.epoch_id,
  );
  assertEquals(await storage.get("finalization"), {
    indexed: true,
    next_test: 1,
    done: true,
  });
  assertEquals(await storage.getAlarm(), null);
});

Deno.test("finalization recovers a lost repository release reply without reprojecting evidence", async () => {
  const env = fakeEnvironment();
  const id = await seed(env, "lost-reply");
  const next = await seed(env, "successor");
  await terminalFixture(env, id);
  const ledger = epochStub(env, id);
  const repository = env.REPOSITORY.instances.get("repo")!;
  const finish = repository.finish.bind(repository);
  let releases = 0;
  repository.finish = async (epochId) => {
    const reply = await finish(epochId);
    releases++;
    if (releases === 1) throw new Error("release reply lost");
    return reply;
  };
  let writes = 0;
  const batch = env.HISTORY.batch.bind(env.HISTORY);
  env.HISTORY.batch = (statements) => {
    writes++;
    return batch(statements);
  };
  await assertRejects(() => ledger.finalize(), "release reply lost");
  assertEquals((await repository.getState()).active, next.epoch_id);
  const object = env.EPOCH.instances.get(epochCellName(id.repo, id.epoch_id))!;
  assertEquals(await object.state.storage.get("finalization"), {
    indexed: true,
    next_test: 1,
    done: false,
  });
  assert(await object.state.storage.getAlarm() !== null);
  await object.alarm();
  assertEquals(releases, 2);
  assertEquals(writes, 1);
  assertEquals((await repository.getState()).active, next.epoch_id);
  assertEquals(await object.state.storage.getAlarm(), null);
  assertEquals(await ledger.finalize(), true);
  assertEquals(releases, 2);
});

Deno.test("failed cancellation blocks projection and release until the terminal alarm fences its lease", async () => {
  const env = fakeEnvironment();
  const id = await seed(env, "cancel-outage");
  const next = await seed(env, "successor");
  await advanceEpoch(env, id);
  const leased = await claim(env);
  assert(leased);
  const broker = env.JOB_QUEUE.getByName("default");
  const storage = env.JOB_QUEUE.instances.get("default")!.state.storage;
  const put = storage.put.bind(storage);
  storage.put = () => Promise.reject(new Error("cancellation unavailable"));
  const prepare = env.HISTORY.prepare.bind(env.HISTORY);
  let projections = 0;
  env.HISTORY.prepare = () => {
    projections++;
    throw new Error("projection must follow cancellation");
  };
  await assertRejects(
    () => failEpoch(env, id, "epoch deadline exceeded"),
    "object RPC: 503 broker temporarily unavailable",
  );
  assertEquals(projections, 0);
  assertEquals((await epochView(env, id)).state, "failed");
  assertEquals((await broker.getJob(leased.id))!.state, "leased");
  assertEquals(
    (await env.REPOSITORY.getByName("repo").getState()).active,
    id.epoch_id,
  );
  const object = env.EPOCH.instances.get(epochCellName(id.repo, id.epoch_id))!;
  assert(await object.state.storage.getAlarm() !== null);
  storage.put = put;
  env.HISTORY.prepare = prepare;
  await object.alarm();
  assertEquals((await broker.getJob(leased.id))!.state, "canceled");
  const renewed = await broker.renew({
    job_id: leased.id,
    agent_id: leased.agent_id,
    lease_token: leased.lease_token,
    lease_ms: 30_000,
  });
  assert(!renewed.ok);
  assertEquals(renewed.status, 409);
  assertEquals(
    (await env.REPOSITORY.getByName("repo").getState()).active,
    next.epoch_id,
  );
});

Deno.test("stalled finalization permits ledger reads and retains concurrent notification accounting", async () => {
  const env = fakeEnvironment();
  const id = await seed(env, "interleaved");
  await terminalFixture(env, id);
  const ledger = epochStub(env, id);
  const before = (await ledger.getState())!;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const batch = env.HISTORY.batch.bind(env.HISTORY);
  env.HISTORY.batch = async (statements) => {
    entered.resolve();
    await release.promise;
    return batch(statements);
  };
  const publication = ledger.finalize();
  await entered.promise;
  let timeout: number | undefined;
  try {
    const snapshot = await Promise.race([
      (async () => {
        unwrapRpc(await ledger.recordNotification());
        return (await ledger.getState())!;
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("D1 publication blocked ledger RPC")),
          1000,
        );
      }),
    ]);
    assertEquals(
      snapshot.notifications_received,
      before.notifications_received + 1,
    );
    assertEquals(snapshot.generation, before.generation);
    assertEquals(snapshot.state, "complete");
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    release.resolve();
    await publication;
  }
  const final = (await ledger.getState())!;
  assertEquals(final.notifications_received, before.notifications_received + 1);
  assertEquals(final.generation, before.generation);
  assertEquals(await ledger.finalize(), true);
});

Deno.test("late nonterminal projection cannot regress a finalized epoch after its Workflow times out", async () => {
  const env = fakeEnvironment();
  const id = await seed(env, "late-projection");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const execute = env.HISTORY.execute.bind(env.HISTORY);
  env.HISTORY.execute = async <Row extends D1Row>(
    sql: string,
    values: D1Bindable[],
  ): Promise<D1Result<Row>> => {
    if (sql.includes("INSERT INTO epochs") && values[6] === "planning") {
      entered.resolve();
      await release.promise;
    }
    return execute<Row>(sql, values);
  };
  const olderActivity = advanceEpoch(env, id);
  await entered.promise;
  try {
    // celld's attempt timeout discards the callback result without canceling
    // the callback; terminal recovery can overtake its delayed D1 request.
    assertEquals(
      await failEpoch(env, id, "activity retries exhausted"),
      "failed",
    );
    assertEquals(await epochStub(env, id).finalize(), true);
  } finally {
    release.resolve();
    await olderActivity;
  }
  const history = await env.HISTORY.prepare<{
    state: string;
    completed_at: number | null;
  }>(`
    SELECT repo, state, completed_at FROM epochs
    WHERE repo = ? ORDER BY sequence DESC LIMIT ?
  `).bind(id.repo, 1).all();
  assertEquals(history.results.length, 1);
  assertEquals(history.results[0].state, "failed");
  assert(history.results[0].completed_at !== null);
  assertEquals((await epochView(env, id)).state, "failed");
  assertEquals(
    (await env.REPOSITORY.getByName("repo").getState()).active,
    null,
  );
});

Deno.test("R2 outage cannot prevent durable failure cancellation and alarm-backed report recovery", async () => {
  const env = fakeEnvironment();
  const id = await seed(env, "report-outage");
  const successor = await seed(env, "successor");
  await advanceEpoch(env, id);
  const put = env.ARTIFACTS.put.bind(env.ARTIFACTS);
  env.ARTIFACTS.put = (): Promise<never> =>
    Promise.reject(new Error("R2 unavailable"));
  await assertRejects(
    () => failEpoch(env, id, "epoch deadline exceeded"),
    "R2 unavailable",
  );
  const failed = await epochView(env, id);
  assertEquals(failed.state, "failed");
  assertEquals(failed.report_ref, null);
  assertEquals(await claim(env), null);
  assertEquals(
    (await env.REPOSITORY.getByName("repo").getState()).active,
    id.epoch_id,
  );
  const object = env.EPOCH.instances.get(epochCellName(id.repo, id.epoch_id))!;
  assert(await object.state.storage.getAlarm() !== null);
  env.ARTIFACTS.put = put;
  await object.alarm();
  const recovered = await epochView(env, id);
  assertEquals(recovered.state, "failed");
  assertEquals(recovered.generation, failed.generation);
  assert(recovered.report_ref);
  assertEquals(await getArtifact(env.ARTIFACTS, recovered.report_ref), {
    repo: id.repo,
    epoch_id: id.epoch_id,
    error: "epoch deadline exceeded",
  });
  assertEquals(
    (await env.REPOSITORY.getByName("repo").getState()).active,
    successor.epoch_id,
  );
  assertEquals(await object.state.storage.getAlarm(), null);
});
