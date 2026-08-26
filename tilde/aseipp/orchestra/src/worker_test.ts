// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/**
 * Public-platform integration tests against actual Workers, Workflow activities,
 * Queue consumer, Repository, EpochLedger, and Broker. Fake primitives provide
 * deterministic failures/timeouts; Buck's separate E2E exercises real celld.
 * @module
 */
import type { JobResult, Notification } from "./model.ts";
import { routeRequest } from "./router.ts";
import { getArtifact } from "./util/artifacts.ts";
import {
  api,
  assert,
  assertEquals,
  claim,
  complete,
  epochView,
  fakeEnvironment,
  finishEpoch,
  plannedTest,
  seed,
  settle,
  testManifest,
} from "./util/testing.ts";

Deno.test("Workflow/Queue/R2 flow completes, reports evidence, and never restarts terminal IDs", async () => {
  const env = fakeEnvironment({ wakeMode: "events" });
  const id = await seed(env, "one");
  const result = await finishEpoch(
    env,
    id,
    (job): JobResult =>
      job.kind === "plan_epoch"
        ? {
          kind: "plan_epoch",
          manifest: testManifest(job, [
            plannedTest(),
            plannedTest("beta", "darwin-arm64"),
          ]),
        }
        : job.kind === "run_tests"
        ? {
          kind: "run_tests",
          tests: job.tests.map((test) => ({
            test_id: test.id,
            outcome: "pass",
            duration_ms: 4,
          })),
        }
        : { kind: "job_error", message: "unexpected diagnosis" },
  );
  assertEquals(result.state, "complete");
  assertEquals(result.counts, {
    expected: 2,
    completed: 2,
    pass: 2,
    fail: 0,
    infra_failure: 0,
  });
  assert(result.manifest_ref && result.report_ref);
  const report = await getArtifact<{ counts: unknown }>(
    env.ARTIFACTS,
    result.report_ref,
  );
  assertEquals(report.counts, result.counts);
  assertEquals(env.HISTORY.resultCount, 2);
  const instance = await env.EPOCH_RUNS.get(id.workflow_id);
  await settle(env);
  assertEquals((await instance.status()).status, "complete");
  await seed(env, "one");
  // Simulate a redelivered kickoff after completion: createBatch must skip.
  env.EVENTS.messages.push({ kind: "kickoff", epoch: id });
  await settle(env);
  assertEquals(env.EPOCH_RUNS.creations, 1);
  assertEquals((await epochView(env, id)).report_ref, result.report_ref);
});

Deno.test("polling compatibility mode completes without enqueuing Workflow events", async () => {
  const env = fakeEnvironment();
  assertEquals(env.WORKFLOW_WAKE_MODE, "poll");
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
  assertEquals(done.state, "complete");
  assertEquals(env.EPOCH_RUNS.runs.get(id.workflow_id)!.events.length, 0);
  assert(done.notifications_received > 0);
});

Deno.test("concurrent ingress reserves one revision once and orders different milestones", async () => {
  const env = fakeEnvironment();
  const ids = await Promise.all([
    seed(env, "one"),
    seed(env, "one"),
    seed(env, "two"),
  ]);
  assertEquals(ids[0].epoch_id, ids[1].epoch_id);
  assert(ids[2].epoch_id !== ids[0].epoch_id);
  await settle(env);
  assertEquals(env.EPOCH_RUNS.creations, 1);
  assertEquals((await epochView(env, ids[2])).state, "queued");
  const repo = await env.REPOSITORY.getByName("repo").getState();
  assertEquals(repo.next_sequence, 3);
  const conflict = await routeRequest(
    api("/v1/repos/repo/epochs", "POST", { revision: "one", queue: "other" }),
    env,
  );
  assertEquals(conflict.status, 409);
});

Deno.test("kickoff producer outage leaves a durable reservation and alarm recovery", async () => {
  const env = fakeEnvironment();
  env.EVENTS.failNext = true;
  const id = await seed(env, "one");
  assertEquals(env.EVENTS.messages.length, 0);
  const repository = env.REPOSITORY.instances.get("repo")!;
  assert(await repository.state.storage.getAlarm() !== null);
  await repository.alarm();
  await settle(env);
  assertEquals(env.EPOCH_RUNS.creations, 1);
  assertEquals((await epochView(env, id)).state, "planning");
});

Deno.test("lost result notifications do not lose accepted planner evidence", async () => {
  const env = fakeEnvironment();
  const id = await seed(env, "one");
  await settle(env);
  const planner = await claim(env);
  assert(planner?.kind === "plan_epoch");
  const result = await complete(env, planner, {
    kind: "plan_epoch",
    manifest: testManifest(planner),
  });
  assertEquals(result.response.status, 200);
  env.EVENTS.messages.splice(0);
  await settle(env, 2);
  assertEquals((await epochView(env, id)).state, "planning");
  env.EPOCH_RUNS.timeout();
  await settle(env);
  assertEquals((await epochView(env, id)).state, "running");
  const work = await claim(env);
  assert(work?.kind === "run_tests");
});

Deno.test("a lost kickoff is recovered by the repository alarm until the Workflow exists", async () => {
  const env = fakeEnvironment();
  const id = await seed(env, "one");
  env.EVENTS.messages.splice(0);
  const repository = env.REPOSITORY.instances.get("repo")!;
  assert(await repository.state.storage.getAlarm() !== null);
  await repository.alarm();
  await settle(env);
  assertEquals(env.EPOCH_RUNS.creations, 1);
  await repository.alarm();
  assertEquals(await repository.state.storage.getAlarm(), null);
  assertEquals((await epochView(env, id)).state, "planning");
});

Deno.test("reserved dictionary keys are rejected at protocol boundaries", async () => {
  const env = fakeEnvironment();
  for (const revision of ["__proto__", "constructor", "prototype"]) {
    const response = await routeRequest(
      api("/v1/repos/repo/epochs", "POST", { revision }),
      env,
    );
    assertEquals(response.status, 400);
  }
});

Deno.test("queue delivery duplicates do not multiply execution observations", async () => {
  const env = fakeEnvironment({ wakeMode: "events" });
  const id = await seed(env, "one");
  await settle(env);
  const planner = await claim(env);
  assert(planner?.kind === "plan_epoch");
  await complete(env, planner, {
    kind: "plan_epoch",
    manifest: testManifest(planner),
  });
  await settle(env);
  const work = await claim(env);
  assert(work?.kind === "run_tests");
  const accepted = await complete(env, work, {
    kind: "run_tests",
    tests: [{ test_id: work.tests[0].id, outcome: "fail", duration_ms: 1 }],
  });
  assertEquals(accepted.response.status, 200);
  const notification: Notification = { kind: "result", epoch: id };
  env.EVENTS.messages.push(notification, notification, notification);
  await settle(env);
  const current = await epochView(env, id);
  assertEquals(current.tests.alpha.observations.length, 1);
  const replay = await routeRequest(
    api("/v1/queues/default/complete", "POST", {
      job_id: work.id,
      agent_id: work.agent_id,
      lease_token: work.lease_token,
      result_ref: accepted.ref,
    }),
    env,
  );
  assertEquals(replay.status, 200);
  const done = await finishEpoch(
    env,
    id,
    (job) =>
      job.kind === "run_tests"
        ? {
          kind: "run_tests",
          tests: job.tests.map((test) => ({
            test_id: test.id,
            outcome: "pass",
            duration_ms: 1,
          })),
        }
        : { kind: "job_error", message: "unexpected job" },
  );
  assertEquals(done.tests.alpha.classification, "flaky");
  assertEquals(done.tests.alpha.observations.length, 2);
});

Deno.test("throttled affected tests remain pending and carry into the next graph interval", async () => {
  const env = fakeEnvironment();
  const first = await seed(env, "one", { max_tests: 1 });
  const result = await finishEpoch(
    env,
    first,
    (job) =>
      job.kind === "plan_epoch"
        ? {
          kind: "plan_epoch",
          manifest: testManifest(job, [
            plannedTest("alpha"),
            plannedTest("beta"),
          ]),
        }
        : job.kind === "run_tests"
        ? {
          kind: "run_tests",
          tests: job.tests.map((test) => ({
            test_id: test.id,
            outcome: "pass",
            duration_ms: 1,
          })),
        }
        : { kind: "job_error", message: "unexpected job" },
  );
  assertEquals(result.deferred, ["linux-x86_64:beta"]);
  assertEquals(result.coverage["linux-x86_64:beta"].pending, true);
  const second = await seed(env, "two");
  const finished = await finishEpoch(env, second, (job) => {
    if (job.kind === "plan_epoch") {
      assertEquals(job.base_revision, "one");
      return { kind: "plan_epoch", manifest: testManifest(job, []) };
    }
    assert(job.kind === "run_tests");
    assertEquals(job.tests.map((test) => test.id), ["beta"]);
    return {
      kind: "run_tests",
      tests: [{ test_id: "beta", outcome: "pass", duration_ms: 1 }],
    };
  });
  assertEquals(finished.inherited, ["linux-x86_64:alpha"]);
  assertEquals(finished.counts.expected, 1);
  assertEquals(finished.coverage["linux-x86_64:beta"].last_pass, "two");
});

Deno.test("empty affected plans preserve prior evidence without inferring target deletion", async () => {
  const env = fakeEnvironment();
  const first = await seed(env, "one");
  const before = await finishEpoch(env, first, (job) => {
    if (job.kind === "plan_epoch") {
      return {
        kind: "plan_epoch",
        manifest: testManifest(job, [plannedTest("alpha")]),
      };
    }
    assert(job.kind === "run_tests");
    return {
      kind: "run_tests",
      tests: job.tests.map((test) => ({
        test_id: test.id,
        outcome: "pass",
        duration_ms: 1,
      })),
    };
  });
  assertEquals(
    before.coverage["linux-x86_64:alpha"].last_pass,
    "one",
  );
  const second = await seed(env, "two");
  const after = await finishEpoch(env, second, (job) => {
    assert(
      job.kind === "plan_epoch",
      "unchanged passing tests need no new execution",
    );
    return {
      kind: "plan_epoch",
      manifest: testManifest(job, []),
    };
  });
  assertEquals(after.state, "complete");
  assertEquals(after.counts.expected, 0);
  assertEquals(after.coverage, before.coverage);
  assertEquals(after.catalog, before.catalog);
  assertEquals(after.inherited, ["linux-x86_64:alpha"]);
  assertEquals(after.deferred, []);
  const retained = await epochView(env, first);
  assertEquals(retained.coverage, before.coverage);
  assert(retained.report_ref);
  const report = await getArtifact<{ tests: unknown }>(
    env.ARTIFACTS,
    retained.report_ref,
  );
  assertEquals(report.tests, before.tests);
});

Deno.test("a failed planner does not advance the next epoch's target-determination baseline", async () => {
  const env = fakeEnvironment();
  const first = await seed(env, "one");
  const second = await seed(env, "two");
  const failed = await finishEpoch(
    env,
    first,
    () => ({ kind: "job_error", message: "source unavailable" }),
  );
  assertEquals(failed.state, "failed");
  const done = await finishEpoch(env, second, (job) => {
    assert(job.kind === "plan_epoch");
    assertEquals(job.base_revision, null);
    return { kind: "plan_epoch", manifest: testManifest(job, []) };
  });
  assertEquals(done.state, "complete");
  assertEquals(done.counts.expected, 0);
});

Deno.test("artifact addresses cover exact bytes and malformed uploads/paths fail closed", async () => {
  const env = fakeEnvironment();
  const one = await routeRequest(api("/v1/artifacts", "POST", { a: 1 }), env);
  const ref = await one.json();
  const two = await routeRequest(api("/v1/artifacts", "POST", { a: 1 }), env);
  assertEquals(await two.json(), ref);
  const download = await routeRequest(api("/v1/artifacts/" + ref.key), env);
  assertEquals(await download.json(), { a: 1 });
  const bad = await routeRequest(
    new Request("http://orchestra.test/v1/artifacts", {
      method: "POST",
      body: "not-json",
    }),
    env,
  );
  assertEquals(bad.status, 400);
  assertEquals(
    (await routeRequest(api("/v1/artifacts/sha256/nope.json"), env)).status,
    404,
  );
  assertEquals((await routeRequest(api("/v1/repos/%GG"), env)).status, 400);
  assertEquals(
    (await routeRequest(api("/v1/repos/repo/epochs/bad%2Fname"), env)).status,
    400,
  );
  assertEquals(
    (await routeRequest(
      api("/v1/repos/repo/epochs", "POST", {
        revision: "one",
        policy: { max_tests: -1 },
      }),
      env,
    )).status,
    400,
  );
});

Deno.test("stale epoch snapshots cannot overwrite Workflow progress", async () => {
  const env = fakeEnvironment();
  const id = await seed(env, "one");
  const stub = env.EPOCH.getByName(id.repo + ":" + id.epoch_id);
  // Use the public read because object names use the shared identifier helper.
  const first = await epochView(env, id);
  await settle(env);
  const stale = await stub.save(first);
  assert(!stale.ok);
  assertEquals(stale.status, 409);
});
