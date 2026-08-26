// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/**
 * Internal RPC contract regressions. Uncalled function bodies check caller and
 * object agreement at compile time; runtime scenarios exercise clone isolation,
 * error transport, and public HTTP adaptation using the production objects.
 * Buck's celld runtime/E2E tests independently cover the native transport.
 * @module
 */
import type { EpochState, OrchestraEnvironment, QueueJob } from "./model.ts";
import type { Notifications } from "./notifications.ts";
import { AgentBroker } from "./agent_broker.ts";
import { EpochLedger } from "./epoch_ledger.ts";
import { Repository } from "./repository.ts";
import { routeRequest } from "./router.ts";
import { epochStub } from "./util/objects.ts";
import { rpcResponse } from "./util/http.ts";
import { RpcFault, rpcGuard, rpcOk, unwrapRpc } from "./util/rpc.ts";
import {
  api,
  assert,
  assertEquals,
  assertRejects,
  fakeEnvironment,
  seed,
} from "./util/testing.ts";

/** Type-only assertion: runtime values are checked by separate scenarios below. */
function expectType<T>(_value: T): void {}

/** Compile but never execute invalid calls; unused expect-error directives fail Deno check. */
export async function checkObjectContracts(
  env: OrchestraEnvironment,
  epoch: EpochState,
  notifications: ServiceBinding<Notifications>,
): Promise<void> {
  const ledger = env.EPOCH.getByName("repo:epoch");
  expectType<Promise<EpochState | null>>(ledger.getState());
  // @ts-expect-error Missing ledgers must be handled explicitly.
  expectType<EpochState>(await ledger.getState());
  // @ts-expect-error Method spelling comes from EpochLedger itself.
  ledger.getSttae();
  // @ts-expect-error save requires the complete versioned epoch snapshot.
  ledger.save({ generation: 1 });
  // @ts-expect-error Object results cannot be reinterpreted as arbitrary caller types.
  ledger.getState<string>();
  // @ts-expect-error Implementation helpers are JavaScript-private, not RPC methods.
  ledger.read();
  const saved = await ledger.save(epoch);
  if (saved.ok) expectType<number>(saved.value.generation);
  else expectType<number>(saved.status);
  const broker = env.JOB_QUEUE.getByName("default");
  expectType<QueueJob | null>(await broker.getJob("job"));
  // @ts-expect-error A lease token is a numeric fencing generation.
  broker.renew({ job_id: "job", agent_id: "agent", lease_token: "1" });
  // @ts-expect-error Unsupported capabilities are not a typed claim.
  broker.claim({ agent_id: "agent", platforms: ["linux"], kinds: ["unknown"] });
  // @ts-expect-error finish accepts an epoch ID, not the old HTTP request body.
  env.REPOSITORY.getByName("repo").finish({ epoch_id: "epoch" });
  expectType<Promise<void>>(notifications.deliver({ kind: "result", epoch }));
  // @ts-expect-error Queue notification types are inferred from the entrypoint.
  notifications.deliver({ kind: "complete", epoch });
}

Deno.test("native ledger RPC clones arguments and replies without aliasing caller state", async () => {
  const env = fakeEnvironment();
  const id = await seed(env, "one");
  const ledger = epochStub(env, id);
  const snapshot = await ledger.getState();
  assert(snapshot);
  const generation = snapshot.generation;
  const pending = ledger.save(snapshot);
  snapshot.revision = "changed-after-invocation";
  const saved = unwrapRpc(await pending);
  assertEquals(snapshot.generation, generation);
  assertEquals(saved.generation, generation + 1);
  const stored = await ledger.getState();
  assert(stored);
  assertEquals(stored.revision, "one");
  stored.policy.max_tests = 0;
  assert((await ledger.getState())!.policy.max_tests !== 0);
  const stale = await ledger.save(snapshot);
  assert(!stale.ok);
  assertEquals(stale.status, 409);
  assertEquals(structuredClone(stale), stale);
});

Deno.test("object implementations expose no TypeScript-private helper methods", () => {
  for (
    const [constructor, expected] of [
      [EpochLedger, [
        "getState",
        "initialize",
        "save",
        "recordNotification",
        "finalize",
        "alarm",
      ]],
      [Repository, ["getState", "submitEpoch", "finish", "alarm"]],
      [AgentBroker, [
        "enqueue",
        "getJob",
        "getState",
        "claim",
        "renew",
        "complete",
        "cancelEpoch",
        "alarm",
      ]],
    ] as const
  ) {
    assertEquals(
      Object.getOwnPropertyNames(constructor.prototype).filter((key) =>
        key !== "constructor"
      ).sort(),
      [...expected].sort(),
    );
  }
});

Deno.test("RPC expected errors are data while unclassified storage failures reject", async () => {
  const result = await rpcGuard(() => {
    throw new RpcFault(409, "conflict");
  });
  assertEquals(structuredClone(result), {
    ok: false,
    status: 409,
    error: "conflict",
  });
  assertEquals(await rpcResponse(result).json(), { error: "conflict" });
  await assertRejects(
    () =>
      rpcGuard(() => {
        throw new Error("disk unavailable");
      }),
    "disk unavailable",
  );
  const retry = await rpcGuard(() => {
    throw new Error("disk unavailable");
  }, "broker temporarily unavailable");
  assertEquals(rpcResponse(retry).status, 503);
  assertEquals(await rpcResponse(retry).json(), {
    error: "broker temporarily unavailable",
    details: "disk unavailable",
  });
  assertEquals(await rpcResponse(rpcOk({ created: true }), 201).json(), {
    created: true,
  });
});

Deno.test("public HTTP preserves validation, duplicate status, and private RPC isolation", async () => {
  const env = fakeEnvironment();
  for (
    const [body, status] of [
      [{ revision: "one" }, 201],
      [{ revision: "one" }, 200],
      [{ revision: "one", queue: null }, 200],
      [{ revision: "one", queue: "other" }, 409],
      [{ revision: 1 }, 400],
      [{ revision: "two", policy: { max_tests: -1 } }, 400],
    ] as const
  ) {
    const reply = await routeRequest(
      api("/v1/repos/repo/epochs", "POST", body),
      env,
    );
    assertEquals(reply.status, status);
    const value = await reply.json();
    assert(
      !("value" in value),
      "internal RPC wrapper leaked into public protocol",
    );
  }
  assertEquals(
    (await routeRequest(
      api("/v1/queues/default/claim", "POST", {
        agent_id: "agent",
        platforms: ["linux"],
        kinds: ["unknown"],
      }),
      env,
    )).status,
    400,
  );
  assertEquals(
    (await routeRequest(
      api("/v1/queues/default/claim", "POST", {
        agent_id: "agent",
        platforms: ["linux"],
        kinds: ["run_tests"],
      }),
      env,
    )).status,
    204,
  );
  for (
    const path of [
      "/v1/queues/default/enqueue",
      "/v1/queues/default/alarm",
      "/v1/repos/repo/finish",
      "/v1/repos/repo/epochs/e000001/save",
    ]
  ) assertEquals((await routeRequest(api(path, "POST", {}), env)).status, 404);
});

Deno.test("fake native RPC rejects asynchronously with cloned exception envelopes", async () => {
  /** Application subclasses must not retain their implementation across RPC. */
  class ApplicationFailure extends Error {
    details = { attempt: 1 };

    /** Prototype methods are not part of celld's exception envelope. */
    diagnostic(): string {
      return "server implementation";
    }
  }
  const env = fakeEnvironment();
  const stub = env.REPOSITORY.getByName("rpc-errors");
  const instance = env.REPOSITORY.instances.get("rpc-errors")!;
  const original = new ApplicationFailure("storage unavailable");
  let invoked = false;
  instance.getState = () => {
    invoked = true;
    throw original;
  };
  const pending = stub.getState();
  assertEquals(
    invoked,
    false,
    "native calls dispatch after invocation returns",
  );
  const received: unknown = await pending.then(
    () => {
      throw new Error("expected RPC rejection");
    },
    (error: unknown) => error,
  );
  assert(invoked);
  assert(received instanceof Error);
  assert(received !== original);
  assert(!(received instanceof ApplicationFailure));
  assertEquals(received.message, original.message);
  assertEquals(Reflect.get(received, "diagnostic"), undefined);
  assertEquals(Reflect.get(received, "remote"), true);
  assertEquals(Reflect.get(received, "details"), { attempt: 1 });
  assert(Reflect.get(received, "details") !== original.details);

  const invalid = new TypeError("invalid RPC input");
  instance.getState = () => {
    throw invalid;
  };
  const typed: unknown = await stub.getState().catch((error: unknown) => error);
  assert(typed instanceof TypeError, "standard Error subclasses survive RPC");
  assert(typed !== invalid);
  assertEquals(Reflect.get(typed, "remote"), true);

  const uncloneable = Object.assign(new TypeError("uncloneable diagnostic"), {
    callback: () => {},
  });
  instance.getState = () => {
    throw uncloneable;
  };
  const fallback: unknown = await stub.getState().catch((error: unknown) =>
    error
  );
  assert(fallback instanceof Error);
  assert(!(fallback instanceof TypeError));
  assertEquals(fallback.name, "TypeError");
  assertEquals(fallback.message, "uncloneable diagnostic");
  assertEquals(Reflect.get(fallback, "callback"), undefined);
  assertEquals(Reflect.get(fallback, "remote"), true);
});
