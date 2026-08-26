// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/**
 * Workflow engine history is disposable; Orchestra's epoch and evidence are not.
 * These integration contracts exercise public status, notification delivery, and
 * repository recovery through real application modules with a controllable fake
 * retention clock. Both polling and event modes must preserve terminal decisions
 * after celld expires/deletes its ledger, without creating another test run.
 * The separate toolchain runtime contracts validate these fake boundary semantics.
 * @module
 */
import { Notifications } from "./notifications.ts";
import { routeRequest } from "./router.ts";
import { epochStub } from "./util/objects.ts";
import {
  api,
  assert,
  assertEquals,
  assertRejects,
  claim,
  epochView,
  fakeEnvironment,
  finishEpoch,
  seed,
  settle,
  testManifest,
  WORKFLOW_RETENTION_MS,
} from "./util/testing.ts";

for (const wakeMode of ["poll", "events"] as const) {
  for (const cleanup of ["expiry", "deletion"] as const) {
    Deno.test(`${wakeMode}: ${cleanup} preserves terminal history and rejects kickoff replays`, async () => {
      const env = fakeEnvironment({ wakeMode, now: () => 0 });
      const id = await seed(env, "one");
      const done = await finishEpoch(
        env,
        id,
        (job) =>
          job.kind === "plan_epoch"
            ? { kind: "plan_epoch", manifest: testManifest(job) }
            : job.kind === "run_tests"
            ? {
              kind: "run_tests",
              tests: job.tests.map((test) => ({
                test_id: test.id,
                outcome: "pass",
                duration_ms: 1,
              })),
            }
            : { kind: "job_error", message: "unexpected diagnosis" },
      );
      await settle(env);
      assertEquals(done.state, "complete");
      assert(done.report_ref);
      const path = `/v1/repos/${id.repo}/epochs/${id.epoch_id}/workflow`;
      const retained = await routeRequest(api(path), env);
      assertEquals(retained.status, 200);
      const status = await retained.json();
      assertEquals(status.status, "complete");
      assertEquals(status.epoch_status, "complete");
      assertEquals(status.engine_history, "available");
      assertEquals(status.workflow_id, id.workflow_id);
      assertEquals(status.output.state, "complete");
      // A terminal domain decision does not excuse real engine storage outages,
      // whether get() itself fails or the following status() transaction does.
      for (const operation of ["failNextGet", "failNextStatus"] as const) {
        env.EPOCH_RUNS[operation] = new Error(
          "storage.transaction: database is locked",
        );
        assertEquals((await routeRequest(api(path), env)).status, 503);
      }
      const history =
        await (await routeRequest(api("/v1/repos/repo/history"), env)).json();
      const artifact = await (await routeRequest(
        api("/v1/artifacts/" + done.report_ref.key),
        env,
      )).json();
      const queue = await (await routeRequest(api("/v1/queues/default"), env))
        .json();
      const artifactCount = env.ARTIFACTS.values.size;
      const handle = await env.EPOCH_RUNS.get(id.workflow_id);
      if (cleanup === "expiry") {
        env.EPOCH_RUNS.advanceTime(WORKFLOW_RETENTION_MS - 1);
        assertEquals((await handle.status()).status, "complete");
        env.EPOCH_RUNS.advanceTime(1);
      } else await handle.delete();
      for (
        const operation of [
          () => env.EPOCH_RUNS.get(id.workflow_id),
          () => handle.status(),
          () => handle.sendEvent({ type: "result" }),
          () => handle.delete(),
        ]
      ) {
        await assertRejects(
          operation,
          "WORKFLOW_ERROR: instance does not exist",
        );
      }
      const expired = await routeRequest(api(path), env);
      assertEquals(expired.status, 200);
      assertEquals(await expired.json(), {
        workflow_id: id.workflow_id,
        epoch_status: "complete",
        engine_history: "unavailable",
        status: null,
        output: null,
      });
      const calls = env.EPOCH_RUNS.calls;
      calls.get =
        calls.status =
        calls.createBatch =
        calls.sendEvent =
          0;
      const notifications = new Notifications({} as ExecutionContext, env);
      for (const kind of ["kickoff", "result"] as const) {
        await notifications.deliver({ kind, epoch: id });
      }
      await seed(env, "one");
      await settle(env);
      assertEquals(env.EPOCH_RUNS.creations, 1);
      assertEquals([
        calls.get,
        calls.status,
        calls.createBatch,
        calls.sendEvent,
      ], [0, 0, 0, 0]);
      const after = await epochView(env, id);
      assertEquals(after.counts, done.counts);
      assertEquals(after.report_ref, done.report_ref);
      assertEquals(
        after.notifications_received,
        done.notifications_received + 2,
      );
      assertEquals(env.HISTORY.resultCount, 1);
      assertEquals(env.ARTIFACTS.values.size, artifactCount);
      assertEquals(
        await (await routeRequest(api("/v1/repos/repo/history"), env)).json(),
        history,
      );
      assertEquals(
        await (await routeRequest(
          api("/v1/artifacts/" + done.report_ref.key),
          env,
        )).json(),
        artifact,
      );
      assertEquals(
        await (await routeRequest(api("/v1/queues/default"), env)).json(),
        queue,
      );
      assertEquals(await claim(env), null);
    });
  }

  Deno.test(`${wakeMode}: failed epochs remain final after engine expiry`, async () => {
    const env = fakeEnvironment({ wakeMode, now: () => 0 });
    const id = await seed(env, "one");
    const failed = await finishEpoch(env, id, () => ({
      kind: "job_error",
      message: "source unavailable",
    }));
    await settle(env);
    assertEquals(failed.state, "failed");
    env.EPOCH_RUNS.advanceTime(WORKFLOW_RETENTION_MS);
    const status = await routeRequest(
      api(`/v1/repos/repo/epochs/${id.epoch_id}/workflow`),
      env,
    );
    assertEquals(status.status, 200);
    assertEquals((await status.json()).epoch_status, "failed");
    const notifications = new Notifications({} as ExecutionContext, env);
    await notifications.deliver({ kind: "kickoff", epoch: id });
    await settle(env);
    assertEquals(env.EPOCH_RUNS.creations, 1);
    assertEquals((await epochView(env, id)).error, failed.error);
    assertEquals(await claim(env), null);
  });

  Deno.test(`${wakeMode}: notification lookups are limited to event delivery`, async () => {
    const env = fakeEnvironment({ wakeMode });
    const id = await seed(env, "one");
    env.EVENTS.messages.splice(0);
    const calls = env.EPOCH_RUNS.calls;
    calls.get =
      calls.status =
      calls.createBatch =
      calls.sendEvent =
        0;
    const notifications = new Notifications({} as ExecutionContext, env);
    await notifications.deliver({ kind: "kickoff", epoch: id });
    assertEquals(calls.createBatch, 1);
    assertEquals(calls.get, wakeMode === "events" ? 1 : 0);
    assertEquals(calls.status, wakeMode === "events" ? 1 : 0);
    await settle(env);
    const before = (await epochView(env, id)).notifications_received;
    calls.get =
      calls.status =
      calls.createBatch =
      calls.sendEvent =
        0;
    await notifications.deliver({ kind: "result", epoch: id });
    assertEquals(calls.createBatch, 0);
    assertEquals(calls.get, wakeMode === "events" ? 1 : 0);
    assertEquals(calls.status, wakeMode === "events" ? 1 : 0);
    assertEquals(calls.sendEvent, wakeMode === "events" ? 1 : 0);
    assertEquals((await epochView(env, id)).notifications_received, before + 1);
    calls.get = calls.status = 0;
    await env.REPOSITORY.instances.get("repo")!.alarm();
    assertEquals(calls.get, 1);
    assertEquals(calls.status, 0);
    assertEquals(
      await env.REPOSITORY.instances.get("repo")!.state.storage.getAlarm(),
      null,
    );
  });

  Deno.test(`${wakeMode}: missing queued history differs from active loss and storage failures`, async () => {
    const env = fakeEnvironment({ wakeMode });
    const active = await seed(env, "one");
    const queued = await seed(env, "two");
    const queuedPath = `/v1/repos/repo/epochs/${queued.epoch_id}/workflow`;
    const absent = await routeRequest(api(queuedPath), env);
    assertEquals(absent.status, 200);
    const status = await absent.json();
    assertEquals(status.status, "queued");
    assertEquals(status.epoch_status, "queued");
    assertEquals(status.engine_history, "not_created");
    for (
      const message of [
        "storage.transaction: database is locked",
        "WORKFLOW_ERROR: instance does not exist (storage failure)",
        "instance does not exist",
      ]
    ) {
      env.EPOCH_RUNS.failNextGet = new Error(message);
      assertEquals((await routeRequest(api(queuedPath), env)).status, 503);
    }
    await settle(env);
    const handle = await env.EPOCH_RUNS.get(active.workflow_id);
    await handle.delete();
    assertEquals((await epochView(env, active)).state, "planning");
    assertEquals(
      (await routeRequest(
        api(`/v1/repos/repo/epochs/${active.epoch_id}/workflow`),
        env,
      )).status,
      503,
    );
  });
}

Deno.test("engine expiry/deletion permits ID reuse, and stale handles resolve the current generation", async () => {
  const env = fakeEnvironment({ now: () => 0 });
  const id = await seed(env, "one");
  const done = await finishEpoch(env, id, (job) => {
    assert(job.kind === "plan_epoch");
    return { kind: "plan_epoch", manifest: testManifest(job, []) };
  });
  assertEquals(done.state, "complete");
  await settle(env);
  const original = await env.EPOCH_RUNS.get(id.workflow_id);
  await assertRejects(
    () => env.EPOCH_RUNS.create({ id: id.workflow_id, params: id }),
    `WORKFLOW_ERROR: instance ${
      JSON.stringify(id.workflow_id)
    } already exists with status "complete"`,
  );
  assertEquals(
    await env.EPOCH_RUNS.createBatch([{ id: id.workflow_id, params: id }]),
    [],
  );
  env.EPOCH_RUNS.advanceTime(WORKFLOW_RETENTION_MS);
  const [replacement] = await env.EPOCH_RUNS.createBatch([{
    id: id.workflow_id,
    params: id,
    retention: { successRetention: "1 second" },
  }]);
  await settle(env);
  assertEquals((await original.status()).status, "complete");
  assertEquals(env.EPOCH_RUNS.creations, 2);
  env.EPOCH_RUNS.advanceTime(999);
  assertEquals((await replacement.status()).status, "complete");
  env.EPOCH_RUNS.advanceTime(1);
  await assertRejects(
    () => original.status(),
    "WORKFLOW_ERROR: instance does not exist",
  );
  await env.EPOCH_RUNS.createBatch([{ id: id.workflow_id, params: id }]);
  await settle(env);
  await original.delete();
  await assertRejects(
    () => replacement.status(),
    "WORKFLOW_ERROR: instance does not exist",
  );
  await env.EPOCH_RUNS.createBatch([{ id: id.workflow_id, params: id }]);
  assertEquals(env.EPOCH_RUNS.creations, 4);
  await settle(env);
});

Deno.test("fake error retention preserves native status errors and expires only terminal instances", async () => {
  const env = fakeEnvironment({ now: () => 0 });
  const id = await seed(env, "one");
  env.EVENTS.messages.splice(0);
  const getByName = env.EPOCH.getByName.bind(env.EPOCH);
  env.EPOCH.getByName = () => {
    throw new Error("injected ledger failure");
  };
  try {
    const [handle] = await env.EPOCH_RUNS.createBatch([{
      id: id.workflow_id,
      params: id,
      retention: { errorRetention: "1 second" },
    }]);
    await settle(env);
    assertEquals(await handle.status(), {
      status: "errored",
      rollback: null,
      error: { name: "Error", message: "injected ledger failure" },
    });
    env.EPOCH_RUNS.advanceTime(999);
    assertEquals((await handle.status()).status, "errored");
    env.EPOCH_RUNS.advanceTime(1);
    await assertRejects(
      () => handle.status(),
      "WORKFLOW_ERROR: instance does not exist",
    );
  } finally {
    env.EPOCH.getByName = getByName;
  }
  const [live] = await env.EPOCH_RUNS.createBatch([{
    id: id.workflow_id,
    params: id,
  }]);
  await settle(env);
  env.EPOCH_RUNS.advanceTime(WORKFLOW_RETENTION_MS * 2);
  assertEquals((await live.status()).status, "waiting");
});

Deno.test("ledger storage failures are not replaced with stale repository reservations", async () => {
  const env = fakeEnvironment();
  const id = await seed(env, "one");
  const ledger = epochStub(env, id);
  const getByName = env.EPOCH.getByName.bind(env.EPOCH);
  env.EPOCH.getByName = () => ({
    ...ledger,
    getState: () => Promise.reject(new Error("database is locked")),
  });
  try {
    assertEquals(
      (await routeRequest(
        api(`/v1/repos/repo/epochs/${id.epoch_id}/workflow`),
        env,
      )).status,
      503,
    );
    assertEquals(
      (await routeRequest(api(`/v1/repos/repo/epochs/${id.epoch_id}`), env))
        .status,
      503,
    );
  } finally {
    env.EPOCH.getByName = getByName;
  }
});
