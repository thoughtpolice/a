// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/**
 * Lease-broker contract and fault-injection scenarios. The real AgentBroker
 * runs against the shared celld fakes; these tests deliberately stop at the
 * Queue producer boundary, so no Workflow or Epoch can conceal a broken lease,
 * artifact check, or durable completion outbox. Expiry is injected into stored
 * lease records; a scoped clock advance tests long-running renewal without sleeps.
 * @module
 */
import type {
  ArtifactRef,
  Job,
  JobResult,
  QueueJob,
  RunTestsJob,
} from "./model.ts";
import {
  AgentBroker,
  type ClaimRequest,
  type EnqueueReceipt,
} from "./agent_broker.ts";
import { routeRequest } from "./router.ts";
import { putArtifact } from "./util/artifacts.ts";
import { STATE_VERSION } from "./util/constants.ts";
import type { RpcResult } from "./util/rpc.ts";
import {
  api,
  assert,
  assertEquals,
  type FakeEnvironment,
  fakeEnvironment,
  type MemoryQueue,
  type MemoryStorage,
} from "./util/testing.ts";

/** The public claim returns the immutable assignment plus its numeric fence. */
type Lease = RunTestsJob & {
  agent_id: string;
  lease_token: number;
  lease_until: number;
  attempts: number;
};

/** Valid two-test assignment used to make membership mistakes observable. */
function assignment(
  suffix = "batch-1",
  platform = "linux-x86_64",
): RunTestsJob {
  return {
    version: STATE_VERSION,
    id: `demo:e000001:${suffix}`,
    queue: "default",
    repo: "demo",
    epoch_id: "e000001",
    workflow_id: "demo-e000001",
    revision: "fake-head",
    kind: "run_tests",
    manifest_digest: "sha256:test-manifest",
    batch_id: suffix,
    platform,
    shard: 0,
    purpose: "initial",
    round: 0,
    tests: [
      { id: "t1", test_key: "key-1", label: "root//pkg:first_test" },
      { id: "t2", test_key: "key-2", label: "root//pkg:second_test" },
    ],
  };
}

/** Submit through the typed Workflow-to-broker seam, without an HTTP wrapper. */
function enqueue(
  env: FakeEnvironment,
  job: Job,
): Promise<RpcResult<EnqueueReceipt>> {
  return env.JOB_QUEUE.getByName("default").enqueue(job);
}

/** Claim through the production public forwarding route with explicit capabilities. */
function claimResponse(
  env: FakeEnvironment,
  agent = "agent-a",
  platforms = ["linux-x86_64"],
  kinds = ["run_tests"],
): Promise<Response> {
  return Promise.resolve(routeRequest(
    api("/v1/queues/default/claim", "POST", {
      agent_id: agent,
      lease_ms: 30_000,
      platforms,
      kinds,
    }),
    env,
  ));
}

/** Require a successful test lease before a completion/fencing scenario. */
async function claim(env: FakeEnvironment, agent = "agent-a"): Promise<Lease> {
  const response = await claimResponse(env, agent);
  const text = await response.text();
  assertEquals(response.status, 200, text);
  return JSON.parse(text) as Lease;
}

/** Renew through the public route without changing the assignment's fence. */
function renew(
  env: FakeEnvironment,
  lease: Lease,
  leaseMs?: number,
  agent = lease.agent_id,
): Promise<Response> {
  return routeRequest(
    api("/v1/queues/default/renew", "POST", {
      job_id: lease.id,
      agent_id: agent,
      lease_token: lease.lease_token,
      ...(leaseMs === undefined ? {} : { lease_ms: leaseMs }),
    }),
    env,
  );
}

/** Test-only access to the persisted source of truth used by Workflow polling. */
async function ledger(env: FakeEnvironment, id: string): Promise<QueueJob> {
  const value = await env.JOB_QUEUE.getByName("default").getJob(id);
  assert(value, "missing broker ledger");
  return value;
}

/** Locate storage for deterministic expiry/crash injection without policy timers. */
function storage(env: FakeEnvironment): MemoryStorage {
  const broker = env.JOB_QUEUE.instances.get("default");
  assert(broker, "broker was not instantiated");
  return broker.state.storage as unknown as MemoryStorage;
}

/** Advance one stored lease past expiry without affecting other tests' clocks. */
async function expire(env: FakeEnvironment, id: string): Promise<void> {
  const value = await ledger(env, id);
  value.lease_until = Date.now() - 1;
  await storage(env).put(`job:${id}`, value);
}

/** Store genuine-looking complete membership, retaining the R2 integrity boundary. */
function resultArtifact(
  env: FakeEnvironment,
  job: RunTestsJob,
  outcome = "pass",
): Promise<ArtifactRef> {
  return putArtifact(env.ARTIFACTS, {
    kind: "run_tests",
    tests: job.tests.map((test) => ({
      test_id: test.id,
      outcome,
      duration_ms: 5,
    })),
  });
}

/** Complete through the public API; only the immutable artifact address is sent. */
function complete(
  env: FakeEnvironment,
  lease: Lease,
  ref: ArtifactRef,
  agent = "agent-a",
): Promise<Response> {
  return Promise.resolve(
    routeRequest(
      api("/v1/queues/default/complete", "POST", {
        job_id: lease.id,
        agent_id: agent,
        lease_token: lease.lease_token,
        result_ref: ref,
      }),
      env,
    ),
  );
}

/** Fail promptly if a ledger operation is incorrectly blocked by remote I/O. */
async function whileBlocked<T>(operation: Promise<T>): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("lease ledger is blocked")),
          1_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

Deno.test("broker native RPC returns plain receipts and isolates argument/result mutations", async () => {
  const env = fakeEnvironment();
  const broker = env.JOB_QUEUE.getByName("default");
  const job = assignment();
  const original = structuredClone(job);
  assertEquals(await broker.getJob("missing"), null);
  const submitted = broker.enqueue(job);
  // RPC clones arguments at invocation, before the serialized method runs.
  job.tests[0].label = "caller changed its assignment";
  assertEquals(await submitted, {
    ok: true,
    value: { created: true, job_id: job.id },
  });
  const pending = await broker.getJob(job.id);
  assert(pending);
  assertEquals(pending.job, original);
  pending.job.revision = "caller changed its read result";
  assertEquals((await ledger(env, job.id)).job, original);

  const input: ClaimRequest = {
    agent_id: "native-agent",
    platforms: ["linux-x86_64"],
    kinds: ["run_tests"],
    lease_ms: 30_000,
  };
  const claimed = await broker.claim(input);
  assert(claimed.ok && claimed.value !== null);
  const lease = claimed.value;
  assertEquals(lease.id, original.id);
  assertEquals(await broker.claim(input), { ok: true, value: null });
  const holder = {
    job_id: lease.id,
    agent_id: lease.agent_id,
    lease_token: lease.lease_token,
  };
  const renewed = await broker.renew({ ...holder, lease_ms: 60_000 });
  assert(renewed.ok);
  assertEquals(renewed.value.lease_token, lease.lease_token);
  assert(renewed.value.lease_until >= lease.lease_until);
  const ref = await resultArtifact(env, original);
  assertEquals(await broker.complete({ ...holder, result_ref: ref }), {
    ok: true,
    value: { accepted: true, duplicate: false, job_id: job.id },
  });
  const summary = await broker.getState();
  assert(summary.ok);
  assertEquals(summary.value.counts, {
    pending: 0,
    leased: 0,
    complete: 1,
    canceled: 0,
  });
  assertEquals(summary.value.jobs[0].result_ref, ref);
});

Deno.test("broker native RPC keeps validation and outage failures serializable", async () => {
  const env = fakeEnvironment();
  const broker = env.JOB_QUEUE.getByName("default");
  const job = assignment();
  await broker.enqueue(job);
  const invalid = await broker.claim({
    agent_id: "agent-a",
    platforms: [],
    kinds: ["run_tests"],
  });
  assertEquals(invalid, {
    ok: false,
    status: 400,
    error: "platforms must contain 1 to 64 capabilities",
  });
  storage(env).get = () => Promise.reject(new Error("injected read outage"));
  assertEquals(await broker.getState(), {
    ok: false,
    status: 503,
    error: "broker temporarily unavailable",
    details: "injected read outage",
  });
});

Deno.test("broker RPC prototype exposes no implementation helpers or HTTP dispatcher", () => {
  assertEquals(Object.getOwnPropertyNames(AgentBroker.prototype).sort(), [
    "alarm",
    "cancelEpoch",
    "claim",
    "complete",
    "constructor",
    "enqueue",
    "getJob",
    "getState",
    "renew",
  ]);
});

Deno.test("broker expiry fences stale tokens and foreign agents", async () => {
  const env = fakeEnvironment();
  const job = assignment();
  assertEquals(await enqueue(env, job), {
    ok: true,
    value: { created: true, job_id: job.id },
  });
  const first = await claim(env);
  const ref = await resultArtifact(env, job);
  assertEquals((await complete(env, first, ref, "foreign-agent")).status, 409);
  await expire(env, job.id);
  assertEquals((await complete(env, first, ref)).status, 409);

  const second = await claim(env, "agent-b");
  assertEquals(second.id, first.id);
  assertEquals(second.lease_token, first.lease_token + 1);
  assertEquals(second.attempts, 2);
  assertEquals((await complete(env, first, ref)).status, 409);
  assertEquals((await complete(env, second, ref, "agent-b")).status, 200);
  const accepted = await ledger(env, job.id);
  assertEquals(accepted.agent_id, "agent-b");
  assertEquals(accepted.attempts, 2);
  assertEquals(env.EVENTS.messages.length, 1);
});

Deno.test("broker renewals durably extend one fence and never shorten its lease", async () => {
  const env = fakeEnvironment();
  const job = assignment();
  await enqueue(env, job);
  const lease = await claim(env);
  let until = lease.lease_until;
  for (const duration of [60_000, 120_000, 300_000]) {
    const before = Date.now();
    const response = await renew(env, lease, duration);
    assertEquals(response.status, 200);
    const renewed = await response.json();
    assert(renewed.lease_until >= before + duration);
    assert(renewed.lease_until > until);
    until = renewed.lease_until;
    assertEquals(renewed, {
      job_id: lease.id,
      agent_id: lease.agent_id,
      lease_token: lease.lease_token,
      lease_until: until,
    });
    const persisted = await ledger(env, lease.id);
    assertEquals(persisted.lease_until, until);
    assertEquals(persisted.lease_token, lease.lease_token);
    assertEquals(persisted.attempts, 1);
    assertEquals(persisted.state, "leased");
  }
  for (const duration of [1_000, undefined]) {
    const response = await renew(env, lease, duration);
    assertEquals(response.status, 200);
    assertEquals((await response.json()).lease_until, until);
  }
  assertEquals((await claimResponse(env, "agent-b")).status, 204);
  const ref = await resultArtifact(env, job);
  assertEquals((await complete(env, lease, ref)).status, 200);
});

Deno.test("broker default renewals sustain work beyond the maximum single lease", async () => {
  const wallClock = Date.now;
  let now = wallClock();
  Date.now = () => now;
  try {
    const env = fakeEnvironment();
    const job = assignment();
    await enqueue(env, job);
    const lease = await claim(env);
    for (let renewal = 0; renewal < 20; renewal++) {
      now += 20_000;
      const response = await renew(env, lease);
      assertEquals(response.status, 200);
      assertEquals((await response.json()).lease_until, now + 30_000);
      assertEquals((await claimResponse(env, "agent-b")).status, 204);
    }
    assert(now > lease.lease_until + 300_000);
    assertEquals((await ledger(env, job.id)).attempts, 1);
    const ref = await resultArtifact(env, job);
    assertEquals((await complete(env, lease, ref)).status, 200);
  } finally {
    Date.now = wallClock;
  }
});

Deno.test("broker renewal cannot revive missing, pending, expired, or completed jobs", async () => {
  const env = fakeEnvironment();
  const job = assignment();
  await enqueue(env, job);
  const pending = {
    ...job,
    agent_id: "agent-a",
    lease_token: 1,
    lease_until: 0,
    attempts: 0,
  };
  assertEquals((await renew(env, { ...pending, id: "missing" })).status, 409);
  assertEquals((await renew(env, pending)).status, 409);
  const lease = await claim(env);
  assertEquals((await renew(env, lease, 30_000, "foreign-agent")).status, 409);
  assertEquals(
    (await renew(env, { ...lease, lease_token: lease.lease_token + 1 })).status,
    409,
  );
  await expire(env, job.id);
  assertEquals((await renew(env, lease)).status, 409);
  const replacement = await claim(env, "agent-b");
  assertEquals((await renew(env, lease)).status, 409);
  const ref = await resultArtifact(env, job);
  assertEquals((await complete(env, lease, ref)).status, 409);
  assertEquals((await renew(env, replacement)).status, 200);
  assertEquals((await complete(env, replacement, ref, "agent-b")).status, 200);
  assertEquals((await renew(env, replacement)).status, 409);
  // Exact completion retries remain valid; renewal does not reopen that state.
  assertEquals((await complete(env, replacement, ref, "agent-b")).status, 200);
  const accepted = await ledger(env, job.id);
  assertEquals(accepted.state, "complete");
  assertEquals(accepted.attempts, 2);
  assertEquals(accepted.agent_id, "agent-b");
});

Deno.test("broker renewal validates every field and shares claim duration limits", async () => {
  const env = fakeEnvironment();
  const job = assignment();
  await enqueue(env, job);
  const lease = await claim(env);
  const valid = {
    job_id: job.id,
    agent_id: lease.agent_id,
    lease_token: lease.lease_token,
  };
  for (
    const fields of [
      { job_id: null },
      { job_id: "" },
      { agent_id: null },
      { agent_id: "contains spaces" },
      { lease_token: undefined },
      { lease_token: 0 },
      { lease_token: 1.5 },
      { lease_token: "1" },
      { lease_token: Number.MAX_SAFE_INTEGER + 1 },
      { lease_ms: null },
      { lease_ms: 999 },
      { lease_ms: 1_000.5 },
      { lease_ms: 300_001 },
      { lease_ms: "30000" },
    ]
  ) {
    const response = await routeRequest(
      api("/v1/queues/default/renew", "POST", { ...valid, ...fields }),
      env,
    );
    assertEquals(response.status, 400, JSON.stringify(fields));
  }
  assertEquals((await ledger(env, job.id)).lease_until, lease.lease_until);
  assertEquals(
    (await routeRequest(api("/v1/queues/default/renew"), env)).status,
    404,
  );
});

Deno.test("broker renewal waits for sync before acknowledgement or another claim", async () => {
  const env = fakeEnvironment();
  const job = assignment();
  await enqueue(env, job);
  const lease = await claim(env);
  const entered = Promise.withResolvers<void>();
  const flushed = Promise.withResolvers<void>();
  storage(env).sync = () => {
    entered.resolve();
    return flushed.promise;
  };
  let acknowledged = false;
  const response = renew(env, lease, 60_000).then((value) => {
    acknowledged = true;
    return value;
  });
  await entered.promise;
  assertEquals(acknowledged, false);
  let claimFinished = false;
  const contender = claimResponse(env, "agent-b").then((value) => {
    claimFinished = true;
    return value;
  });
  await Promise.resolve();
  assertEquals(claimFinished, false);
  flushed.resolve();
  assertEquals((await response).status, 200);
  assertEquals((await contender).status, 204);
});

Deno.test("broker renewal durability failures are retryable without changing the fence", async () => {
  for (const boundary of ["put", "sync"] as const) {
    const env = fakeEnvironment();
    const job = assignment();
    await enqueue(env, job);
    const lease = await claim(env);
    const savedPut = storage(env).put;
    const savedSync = storage(env).sync;
    storage(env)[boundary] = () => Promise.reject(new Error("injected outage"));
    assertEquals((await renew(env, lease, 60_000)).status, 503, boundary);
    storage(env).put = savedPut;
    storage(env).sync = savedSync;
    const persisted = await ledger(env, job.id);
    assertEquals(persisted.lease_token, lease.lease_token);
    assertEquals(persisted.attempts, 1);
    if (boundary === "put") {
      assertEquals(persisted.lease_until, lease.lease_until);
    }
    // A failed sync leaves durability ambiguous, so only a successful retry can
    // acknowledge the extension. Either outcome retains exactly the same fence.
    assertEquals((await renew(env, lease, 60_000)).status, 200);
    assertEquals((await ledger(env, job.id)).attempts, 1);
  }
});

Deno.test("broker serializes expired renewal against reclaim and rejects late completion", async () => {
  for (const renewalFirst of [true, false]) {
    const env = fakeEnvironment();
    const job = assignment();
    await enqueue(env, job);
    const lease = await claim(env);
    await expire(env, job.id);
    const attempts = renewalFirst
      ? [renew(env, lease), claimResponse(env, "agent-b")]
      : [claimResponse(env, "agent-b"), renew(env, lease)];
    const responses = await Promise.all(attempts);
    assertEquals(responses[renewalFirst ? 0 : 1].status, 409);
    const reclaimed = responses[renewalFirst ? 1 : 0];
    assertEquals(reclaimed.status, 200);
    const replacement = await reclaimed.json() as Lease;
    assertEquals(replacement.lease_token, lease.lease_token + 1);
    const ref = await resultArtifact(env, job);
    assertEquals((await complete(env, lease, ref)).status, 409);
    assertEquals(
      (await complete(env, replacement, ref, "agent-b")).status,
      200,
    );
    assertEquals((await ledger(env, job.id)).agent_id, "agent-b");
  }
});

Deno.test("broker renews during evidence validation but never reopens accepted work", async () => {
  for (const renewalFirst of [true, false]) {
    const env = fakeEnvironment();
    const job = assignment();
    await enqueue(env, job);
    const lease = await claim(env);
    const ref = await resultArtifact(env, job);
    const attempts = renewalFirst
      ? [renew(env, lease, 60_000), complete(env, lease, ref)]
      : [complete(env, lease, ref), renew(env, lease, 60_000)];
    const responses = await Promise.all(attempts);
    assertEquals(
      responses[renewalFirst ? 0 : 1].status,
      200,
    );
    assertEquals(responses[renewalFirst ? 1 : 0].status, 200);
    const accepted = await ledger(env, job.id);
    assertEquals(accepted.state, "complete");
    assertEquals(accepted.attempts, 1);
    assertEquals(accepted.result_ref, ref);
    assertEquals(env.EVENTS.messages.length, 1);
    assertEquals((await renew(env, lease)).status, 409);
  }
});

Deno.test("broker stalled artifact reads do not block this or another job's renewals", async () => {
  const env = fakeEnvironment();
  const job = assignment();
  const other = assignment("other");
  await enqueue(env, job);
  await enqueue(env, other);
  const lease = await claim(env);
  const otherLease = await claim(env, "agent-b");
  const ref = await resultArtifact(env, job);
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const get = env.ARTIFACTS.get.bind(env.ARTIFACTS);
  env.ARTIFACTS.get = async (key) => {
    entered.resolve();
    await released.promise;
    return get(key);
  };
  const accepted = complete(env, lease, ref);
  await entered.promise;
  try {
    // The old queue-wide lock held both timely heartbeats behind this R2 read.
    // Use a timeout so a regression fails instead of leaving an unresolved test.
    const responses = await whileBlocked(Promise.all([
      renew(env, lease, 60_000),
      renew(env, otherLease, 60_000),
    ]));
    assertEquals(responses.map((response) => response.status), [200, 200]);
  } finally {
    released.resolve();
  }
  assertEquals((await accepted).status, 200);
  assertEquals((await ledger(env, job.id)).state, "complete");
  assertEquals((await ledger(env, other.id)).state, "leased");
});

Deno.test("broker exact completion retries survive expiry but reject changed evidence", async () => {
  const env = fakeEnvironment();
  const job = assignment();
  await enqueue(env, job);
  const lease = await claim(env);
  const ref = await resultArtifact(env, job);
  assertEquals((await complete(env, lease, ref)).status, 200);
  const acceptedAt = (await ledger(env, job.id)).completed_at;
  await expire(env, job.id);

  const retry = await complete(env, lease, ref);
  assertEquals(retry.status, 200);
  assertEquals((await retry.json()).duplicate, true);
  assertEquals((await ledger(env, job.id)).completed_at, acceptedAt);
  assertEquals(
    env.EVENTS.messages.length,
    1,
    "retry should not publish another acknowledged notification",
  );

  const different = await resultArtifact(env, job, "fail");
  assertEquals((await complete(env, lease, different)).status, 409);
  assertEquals((await complete(env, lease, ref, "foreign-agent")).status, 409);
  assertEquals(
    (await complete(env, { ...lease, lease_token: lease.lease_token + 1 }, ref))
      .status,
    409,
  );
  assertEquals((await ledger(env, job.id)).result_ref, ref);
});

Deno.test("broker rechecks cancellation and reclaimed fences after stalled R2 reads", async () => {
  for (const action of ["cancel", "reclaim"] as const) {
    const env = fakeEnvironment();
    const job = assignment();
    await enqueue(env, job);
    const lease = await claim(env);
    const ref = await resultArtifact(env, job);
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const get = env.ARTIFACTS.get.bind(env.ARTIFACTS);
    env.ARTIFACTS.get = async (key) => {
      entered.resolve();
      await released.promise;
      return get(key);
    };
    const accepted = complete(env, lease, ref);
    await entered.promise;
    try {
      if (action === "cancel") {
        assertEquals(
          await whileBlocked(
            env.JOB_QUEUE.getByName("default").cancelEpoch(job),
          ),
          { ok: true, value: { canceled: true } },
        );
      } else {
        await whileBlocked(expire(env, job.id));
        const replacement = await whileBlocked(claim(env, "agent-b"));
        assertEquals(replacement.lease_token, lease.lease_token + 1);
      }
    } finally {
      released.resolve();
    }
    assertEquals((await accepted).status, 409, action);
    assertEquals((await ledger(env, job.id)).result_ref, null);
    assertEquals(env.EVENTS.messages.length, 0);
  }
});

Deno.test("broker acceptance uses the renewed deadline after a slow artifact read", async () => {
  const wallClock = Date.now;
  let now = wallClock();
  const released = Promise.withResolvers<void>();
  Date.now = () => now;
  try {
    const env = fakeEnvironment();
    const job = assignment();
    await enqueue(env, job);
    const lease = await claim(env);
    const ref = await resultArtifact(env, job);
    const entered = Promise.withResolvers<void>();
    const get = env.ARTIFACTS.get.bind(env.ARTIFACTS);
    env.ARTIFACTS.get = async (key) => {
      entered.resolve();
      await released.promise;
      return get(key);
    };
    const accepted = complete(env, lease, ref);
    await entered.promise;
    now += 20_000;
    assertEquals((await whileBlocked(renew(env, lease, 60_000))).status, 200);
    now += 20_000;
    assert(now > lease.lease_until, "the pre-read snapshot must now be stale");
    released.resolve();
    assertEquals((await accepted).status, 200);
  } finally {
    released.resolve();
    Date.now = wallClock;
  }
});

Deno.test("broker concurrent evidence verification accepts only one immutable result", async () => {
  for (const sameEvidence of [true, false]) {
    const env = fakeEnvironment();
    const job = assignment();
    await enqueue(env, job);
    const lease = await claim(env);
    const first = await resultArtifact(env, job);
    const second = sameEvidence
      ? first
      : await resultArtifact(env, job, "fail");
    const responses = await Promise.all([
      complete(env, lease, first),
      complete(env, lease, second),
    ]);
    assertEquals(responses.map((response) => response.status).sort(), [
      200,
      sameEvidence ? 200 : 409,
    ]);
    if (sameEvidence) {
      assertEquals(
        (await Promise.all(responses.map((response) => response.json())))
          .map((receipt) => receipt.duplicate).sort(),
        [false, true],
      );
    }
    assertEquals(
      (await ledger(env, job.id)).result_ref,
      responses[0].status === 200 ? first : second,
    );
    assertEquals(env.EVENTS.messages.length, 1);
  }
});

Deno.test("broker stalled Queue sends do not block renewals or epoch cancellation", async () => {
  const env = fakeEnvironment();
  const first = assignment("first");
  const second = assignment("second");
  await enqueue(env, first);
  await enqueue(env, second);
  const lease = await claim(env);
  const other = await claim(env, "agent-b");
  const ref = await resultArtifact(env, first);
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const queue: MemoryQueue = env.EVENTS;
  const send = queue.send.bind(queue);
  queue.send = async (message) => {
    entered.resolve();
    await released.promise;
    return await send(message);
  };
  const accepted = complete(env, lease, ref);
  await entered.promise;
  try {
    assertEquals((await whileBlocked(renew(env, other, 60_000))).status, 200);
    assertEquals(
      await whileBlocked(env.JOB_QUEUE.getByName("default").cancelEpoch(first)),
      { ok: true, value: { canceled: true } },
    );
    assertEquals((await whileBlocked(renew(env, other))).status, 409);
  } finally {
    released.resolve();
  }
  assertEquals((await accepted).status, 200);
  assertEquals((await ledger(env, first.id)).state, "complete");
  assertEquals((await ledger(env, second.id)).state, "canceled");
  assertEquals(storage(env).alarmAt, null);
});

Deno.test("broker cancellation durably fences pending, leased and future assignments", async () => {
  const env = fakeEnvironment();
  const leasedJob = assignment("leased");
  const pendingJob = assignment("pending");
  await enqueue(env, leasedJob);
  await enqueue(env, pendingJob);
  const lease = await claim(env);
  const ref = await resultArtifact(env, leasedJob);
  const broker = env.JOB_QUEUE.getByName("default");
  assertEquals(await broker.cancelEpoch(leasedJob), {
    ok: true,
    value: { canceled: true },
  });
  assertEquals(await broker.cancelEpoch(leasedJob), {
    ok: true,
    value: { canceled: true },
  });
  assertEquals((await claimResponse(env)).status, 204);
  assertEquals((await renew(env, lease)).status, 409);
  assertEquals((await complete(env, lease, ref)).status, 409);
  for (const job of [leasedJob, pendingJob, assignment("not-enqueued-yet")]) {
    assertEquals(await enqueue(env, job), {
      ok: false,
      status: 409,
      error: "job epoch is canceled",
    });
  }
  const summary = await broker.getState();
  assert(summary.ok);
  assertEquals(summary.value.counts, {
    pending: 0,
    leased: 0,
    complete: 0,
    canceled: 2,
  });
  assertEquals((await ledger(env, leasedJob.id)).lease_until, null);
  assertEquals((await ledger(env, leasedJob.id)).attempts, 1);
  assertEquals((await ledger(env, pendingJob.id)).attempts, 0);
});

Deno.test("broker cancellation survives restart before enqueue and is repository scoped", async () => {
  const env = fakeEnvironment();
  const job = assignment();
  const broker = env.JOB_QUEUE.getByName("default");
  assertEquals(await broker.cancelEpoch(job), {
    ok: true,
    value: { canceled: true },
  });
  const restarted = new AgentBroker(
    env.JOB_QUEUE.instances.get("default")!.state,
    env,
  );
  env.JOB_QUEUE.instances.set("default", restarted);
  assertEquals(await restarted.enqueue(job), {
    ok: false,
    status: 409,
    error: "job epoch is canceled",
  });
  const unrelated = {
    ...job,
    repo: "other",
    workflow_id: "other-e000001",
    id: "other:e000001:batch-1",
  };
  assertEquals(await restarted.enqueue(unrelated), {
    ok: true,
    value: { created: true, job_id: unrelated.id },
  });
  const claimed = await restarted.claim({
    agent_id: "agent",
    platforms: ["linux-x86_64"],
    kinds: ["run_tests"],
  });
  assert(claimed.ok && claimed.value);
  assertEquals(claimed.value.id, unrelated.id);
});

Deno.test("broker cancellation retries re-prove ambiguous durability", async () => {
  const env = fakeEnvironment();
  const job = assignment();
  await enqueue(env, job);
  const broker = env.JOB_QUEUE.getByName("default");
  const savedSync = storage(env).sync;
  let syncs = 0;
  storage(env).sync = () => {
    syncs++;
    return Promise.reject(new Error("injected sync outage"));
  };
  const failed = await broker.cancelEpoch(job);
  assert(!failed.ok);
  assertEquals(failed.status, 503);
  storage(env).sync = () => {
    syncs++;
    return savedSync.call(storage(env));
  };
  assertEquals(await broker.cancelEpoch(job), {
    ok: true,
    value: { canceled: true },
  });
  assertEquals(syncs, 2);
  assertEquals((await claimResponse(env)).status, 204);
});

Deno.test("broker cancellation is linearized with concurrent enqueues", async () => {
  for (const cancellationFirst of [true, false]) {
    const env = fakeEnvironment();
    const broker = env.JOB_QUEUE.getByName("default");
    const job = assignment();
    const operations = cancellationFirst
      ? [broker.cancelEpoch(job), broker.enqueue(job)]
      : [broker.enqueue(job), broker.cancelEpoch(job)];
    const responses = await Promise.all(operations);
    assertEquals(responses[cancellationFirst ? 0 : 1], {
      ok: true,
      value: { canceled: true },
    });
    assertEquals(responses[cancellationFirst ? 1 : 0].ok, !cancellationFirst);
    assertEquals((await claimResponse(env)).status, 204);
    assertEquals(
      (await broker.getJob(job.id))?.state ?? null,
      cancellationFirst ? null : "canceled",
    );
  }
});

Deno.test("broker cancellation preserves immutable accepted completion retries", async () => {
  const env = fakeEnvironment();
  const job = assignment();
  await enqueue(env, job);
  const lease = await claim(env);
  const ref = await resultArtifact(env, job);
  env.EVENTS.failNext = true;
  assertEquals((await complete(env, lease, ref)).status, 503);
  assertEquals(await env.JOB_QUEUE.getByName("default").cancelEpoch(job), {
    ok: true,
    value: { canceled: true },
  });
  const retried = await complete(env, lease, ref);
  assertEquals(retried.status, 200);
  assertEquals((await retried.json()).duplicate, true);
  assertEquals((await ledger(env, job.id)).state, "complete");
  assertEquals((await ledger(env, job.id)).notified, true);
  assertEquals(env.EVENTS.messages.length, 1);
});

Deno.test("broker platform and kind capabilities leave incompatible jobs unleased", async () => {
  const env = fakeEnvironment();
  const mac = assignment("mac", "darwin-arm64");
  const linux = assignment("linux");
  const plan: Job = {
    version: STATE_VERSION,
    id: "demo:e000001:plan",
    queue: "default",
    repo: "demo",
    epoch_id: "e000001",
    workflow_id: "demo-e000001",
    revision: "fake-head",
    kind: "plan_epoch",
    base_revision: null,
  };
  await enqueue(env, mac);
  await enqueue(env, plan);
  await enqueue(env, linux);
  const linuxLease = await claim(env);
  assertEquals(
    linuxLease.id,
    linux.id,
    "an incompatible earlier assignment must not steal the lease",
  );
  assertEquals((await ledger(env, mac.id)).attempts, 0);
  assertEquals((await ledger(env, plan.id)).attempts, 0);
  assertEquals((await claimResponse(env)).status, 204);

  const planResponse = await claimResponse(env, "planner", ["other-platform"], [
    "plan_epoch",
  ]);
  assertEquals(planResponse.status, 200);
  assertEquals(
    (await planResponse.json()).id,
    plan.id,
    "epoch planning is not an execution-platform job",
  );
  const macResponse = await claimResponse(env, "mac-agent", ["darwin-arm64"], [
    "run_tests",
  ]);
  assertEquals(macResponse.status, 200);
  assertEquals((await macResponse.json()).id, mac.id);
});

Deno.test("broker rejects absent, duplicate, and unknown capabilities", async () => {
  const env = fakeEnvironment();
  for (
    const capabilities of [
      {},
      { platforms: [], kinds: ["run_tests"] },
      { platforms: ["linux-x86_64"], kinds: [] },
      { platforms: ["linux-x86_64", "linux-x86_64"], kinds: ["run_tests"] },
      { platforms: ["linux-x86_64"], kinds: ["run_tests", "run_tests"] },
      { platforms: ["linux-x86_64"], kinds: ["shell"] },
    ]
  ) {
    const response = await routeRequest(
      api("/v1/queues/default/claim", "POST", {
        agent_id: "agent-a",
        ...capabilities,
      }),
      env,
    );
    assertEquals(response.status, 400);
  }
});

Deno.test("broker verifies R2 evidence before consuming the lease", async () => {
  for (const fault of ["missing", "size", "digest"] as const) {
    const env = fakeEnvironment();
    const job = assignment();
    await enqueue(env, job);
    const lease = await claim(env);
    const ref = await resultArtifact(env, job);
    const original = env.ARTIFACTS.values.get(ref.key)!.slice();
    if (fault === "missing") env.ARTIFACTS.values.delete(ref.key);
    else if (fault === "size") {
      env.ARTIFACTS.values.set(ref.key, original.subarray(1));
    } else {
      const corrupt = original.slice();
      corrupt[0] ^= 1;
      env.ARTIFACTS.values.set(ref.key, corrupt);
    }
    const response = await complete(env, lease, ref);
    assertEquals(response.status, fault === "missing" ? 503 : 400, fault);
    assertEquals((await ledger(env, job.id)).state, "leased");
    assertEquals((await ledger(env, job.id)).result_ref, null);
    assertEquals(env.EVENTS.messages.length, 0);
    assertEquals(storage(env).alarmAt, null);
    env.ARTIFACTS.values.set(ref.key, original);
    assertEquals(
      (await complete(env, lease, ref)).status,
      200,
      "restored evidence can complete the same live lease",
    );
  }
});

Deno.test("broker rejects malformed or mismatched test result membership", async () => {
  const good = [
    { test_id: "t1", outcome: "pass", duration_ms: 1 },
    { test_id: "t2", outcome: "fail", duration_ms: 2 },
  ];
  const invalid = [
    { kind: "plan_epoch", manifest: {} },
    { kind: "run_tests", tests: null },
    { kind: "run_tests", tests: good.slice(0, 1) },
    { kind: "run_tests", tests: [...good, good[0]] },
    { kind: "run_tests", tests: [good[0], good[0]] },
    {
      kind: "run_tests",
      tests: [good[0], { ...good[1], test_id: "foreign-test" }],
    },
    { kind: "run_tests", tests: [good[0], { ...good[1], outcome: "skip" }] },
    { kind: "run_tests", tests: [good[0], { ...good[1], duration_ms: -1 }] },
    { kind: "run_tests", tests: [good[0], { ...good[1], duration_ms: 0.5 }] },
    {
      kind: "run_tests",
      tests: [good[0], {
        ...good[1],
        duration_ms: Number.MAX_SAFE_INTEGER + 1,
      }],
    },
  ];
  for (const result of invalid) {
    const env = fakeEnvironment();
    const job = assignment();
    await enqueue(env, job);
    const lease = await claim(env);
    const ref = await putArtifact(env.ARTIFACTS, result);
    assertEquals(
      (await complete(env, lease, ref)).status,
      400,
      JSON.stringify(result),
    );
    assertEquals((await ledger(env, job.id)).state, "leased");
    assertEquals(env.EVENTS.messages.length, 0);
  }
});

Deno.test("broker persists completion through a Queue outage and alarm recovery", async () => {
  const env = fakeEnvironment();
  const job = assignment();
  await enqueue(env, job);
  const lease = await claim(env);
  const ref = await resultArtifact(env, job);
  env.EVENTS.failNext = true;
  assertEquals((await complete(env, lease, ref)).status, 503);
  const accepted = await ledger(env, job.id);
  assertEquals(accepted.state, "complete");
  assertEquals(accepted.result_ref, ref);
  assertEquals(accepted.notified, false);
  assert(accepted.completed_at !== null);
  assert(
    storage(env).alarmAt !== null,
    "accepted evidence needs a durable notification retry",
  );
  assertEquals(env.EVENTS.messages.length, 0);
  assertEquals(
    (await claimResponse(env)).status,
    204,
    "notification failure must not execute accepted evidence again",
  );

  // Recreate the object over the same persisted cell to ensure replay does not
  // depend on the failed request's instance-local memory.
  const restarted = new AgentBroker(
    env.JOB_QUEUE.instances.get("default")!.state,
    env,
  );
  env.JOB_QUEUE.instances.set("default", restarted);
  await restarted.alarm();
  assertEquals((await ledger(env, job.id)).notified, true);
  assertEquals((await ledger(env, job.id)).completed_at, accepted.completed_at);
  assertEquals(storage(env).alarmAt, null);
  assertEquals(env.EVENTS.messages, [{
    kind: "result",
    epoch: {
      repo: job.repo,
      epoch_id: job.epoch_id,
      workflow_id: job.workflow_id,
    },
  }]);
  await env.JOB_QUEUE.instances.get("default")!.alarm();
  assertEquals(
    env.EVENTS.messages.length,
    1,
    "a redundant alarm does not duplicate an acknowledged send",
  );
});

Deno.test("broker duplicate completion recovers an unnotified outbox after expiry", async () => {
  const env = fakeEnvironment();
  const job = assignment();
  await enqueue(env, job);
  const lease = await claim(env);
  const ref = await resultArtifact(env, job);
  env.EVENTS.failNext = true;
  assertEquals((await complete(env, lease, ref)).status, 503);
  await expire(env, job.id);
  assertEquals((await complete(env, lease, ref)).status, 200);
  assertEquals(env.EVENTS.messages.length, 1);
  assertEquals((await ledger(env, job.id)).notified, true);
  assertEquals(storage(env).alarmAt, null);
});

Deno.test("broker serializes concurrent claims without overlapping assignments", async () => {
  const env = fakeEnvironment();
  const jobs = [assignment("one"), assignment("two"), assignment("three")];
  await Promise.all(jobs.map((job) => enqueue(env, job)));
  const responses = await Promise.all(
    Array.from(
      { length: 12 },
      (_, index) => claimResponse(env, `agent-${index}`),
    ),
  );
  const claimed = await Promise.all(
    responses.filter((response) => response.status === 200)
      .map((response) => response.json() as Promise<Lease>),
  );
  assertEquals(claimed.length, 3);
  assertEquals(new Set(claimed.map((lease) => lease.id)).size, 3);
  assertEquals(
    responses.filter((response) => response.status === 204).length,
    9,
  );
  for (const job of jobs) {
    assertEquals((await ledger(env, job.id)).attempts, 1);
    assertEquals((await ledger(env, job.id)).state, "leased");
  }
});

Deno.test("broker enqueue retries preserve immutable assignments and summaries omit evidence", async () => {
  const env = fakeEnvironment();
  const job = assignment();
  assertEquals(await enqueue(env, job), {
    ok: true,
    value: { created: true, job_id: job.id },
  });
  assertEquals(await enqueue(env, structuredClone(job)), {
    ok: true,
    value: { created: false, job_id: job.id },
  });
  assertEquals(await enqueue(env, { ...job, revision: "changed-head" }), {
    ok: false,
    status: 409,
    error: "job id already has a different assignment",
  });
  const lease = await claim(env);
  const result: JobResult = {
    kind: "job_error",
    message: "Buck could not start",
  };
  const ref = await putArtifact(env.ARTIFACTS, result);
  assertEquals((await complete(env, lease, ref)).status, 200);
  const response = await routeRequest(api("/v1/queues/default"), env);
  const summary = await response.json();
  assertEquals(summary.name, "default");
  assertEquals(summary.counts, {
    pending: 0,
    leased: 0,
    complete: 1,
    canceled: 0,
  });
  assertEquals(summary.jobs.length, 1);
  assertEquals(summary.jobs[0].result_ref, ref);
  assertEquals(summary.jobs[0].tests, undefined);
  assertEquals(summary.jobs[0].result, undefined);
  assertEquals(
    env.EPOCH_RUNS.creations,
    0,
    "broker must not call Workflow or Epoch services directly",
  );
});
