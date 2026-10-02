// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/core/assert";
import type { ClientFailure } from "@celld/web/router/client";
import {
  type ActionResult,
  type ActionState,
  createAction,
} from "@celld/web/kit/actions";

Deno.test("validation failure transitions through pending before successful resubmission", async () => {
  const states: ActionState<string>[] = [];
  const failure: ClientFailure = {
    ok: false,
    kind: "validation",
    status: 400,
    response: new Response(null, { status: 400 }),
    error: {
      error: "validation_failed",
      message: "invalid body",
      requestId: "r1",
      location: "body",
      formErrors: [],
      fieldErrors: { title: ["required"] },
      issues: [{ path: ["title"], code: "too_small", message: "required" }],
    },
  };
  const action = createAction<string, string>({
    submit: (title) =>
      Promise.resolve(title ? { ok: true, data: title } : failure),
    onState: (state) => {
      states.push(state);
    },
  });
  await action.submit("");
  assert(
    action.state.status === "error" && action.state.error.kind === "validation",
    "invalid input must preserve the server validation failure",
  );
  await action.submit("Saved");
  assertEquals(states.map((state) => state.status), [
    "pending",
    "error",
    "pending",
    "success",
  ]);
  assertEquals(action.state, { status: "success", data: "Saved" });
});

Deno.test("new submissions win even when an aborted caller ignores the signal", async () => {
  const jobs: {
    signal: AbortSignal;
    finish: (value: ActionResult<string>) => void;
  }[] = [];
  const states: ActionState<string>[] = [];
  const action = createAction<string, string>({
    submit: (_input, signal) => {
      const { promise, resolve } = Promise.withResolvers<
        ActionResult<string>
      >();
      jobs.push({ signal, finish: resolve });
      return promise;
    },
    onState: (state) => {
      states.push(state);
    },
  });
  const first = action.submit("one");
  const second = action.submit("two");
  assert(jobs[0].signal.aborted, "new submission must abort the old action");
  jobs[1].finish({ ok: true, data: "two" });
  await second;
  jobs[0].finish({
    ok: false,
    kind: "transport",
    cause: new Error("late failure"),
  });
  assertEquals(await first, undefined);
  assertEquals(action.state, { status: "success", data: "two" });
  assertEquals(states.map((state) => state.status), [
    "pending",
    "pending",
    "success",
  ]);
});

Deno.test("update and destroy suppress all obsolete results and abort their signals", async () => {
  const jobs: {
    signal: AbortSignal;
    finish: (value: ActionResult<string>) => void;
  }[] = [];
  const states: ActionState<string>[] = [];
  const options = {
    submit: (_input: string, signal: AbortSignal) => {
      const { promise, resolve } = Promise.withResolvers<
        ActionResult<string>
      >();
      jobs.push({ signal, finish: resolve });
      return promise;
    },
    onState: (state: ActionState<string>) => {
      states.push(state);
    },
  };
  const action = createAction(options);
  const first = action.submit("old");
  action.update(options);
  assert(jobs[0].signal.aborted, "updating the action must abort pending work");
  jobs[0].finish({ ok: true, data: "obsolete" });
  assertEquals(await first, undefined);
  assertEquals(action.state.status, "idle");
  const second = action.submit("new");
  action.destroy();
  assert(
    jobs[1].signal.aborted,
    "destroying the action must abort pending work",
  );
  jobs[1].finish({ ok: true, data: "disposed" });
  assertEquals(await second, undefined);
  assertEquals(states.map((state) => state.status), [
    "pending",
    "idle",
    "pending",
  ]);
  assertEquals(await action.submit("after destroy"), undefined);
});
