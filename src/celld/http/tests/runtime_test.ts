// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  defaultRuntime,
  type FetchLike,
  globalFetch,
  rejectOnAbort,
} from "@celld/http";

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

Deno.test("defaultRuntime sleeps, and stops sleeping on abort", async () => {
  const before = defaultRuntime.now();
  await defaultRuntime.sleep(5);
  assert(defaultRuntime.now() >= before, "clock moves forward");
  const random = defaultRuntime.random();
  assert(random >= 0 && random < 1, "random in [0, 1)");

  const controller = new AbortController();
  const sleeping = defaultRuntime.sleep(60_000, controller.signal);
  controller.abort(new Error("stop"));
  assertEquals(((await rejection(sleeping)) as Error).message, "stop");

  const reason = await rejection(
    defaultRuntime.sleep(1, AbortSignal.abort("already")),
  );
  assertEquals(reason, "already");
});

Deno.test("defaultRuntime timers fire and cancel", async () => {
  let fired = 0;
  const cancel = defaultRuntime.setTimer(1, () => fired++);
  const cancelled = defaultRuntime.setTimer(1, () => fired += 10);
  cancelled();
  await defaultRuntime.sleep(20);
  cancel();
  assertEquals(fired, 1);
});

Deno.test("rejectOnAbort settles like the promise until the signal aborts", async () => {
  const signal = new AbortController().signal;
  assertEquals(await rejectOnAbort(Promise.resolve(7), signal), 7);
  assertEquals(
    ((await rejection(
      rejectOnAbort(Promise.reject(new Error("x")), signal),
    )) as Error)
      .message,
    "x",
  );

  const controller = new AbortController();
  const never = new Promise<never>(() => {});
  const racing = rejectOnAbort(never, controller.signal);
  controller.abort("timed out");
  assertEquals(await rejection(racing), "timed out");

  assertEquals(
    await rejection(rejectOnAbort(Promise.resolve(1), AbortSignal.abort("no"))),
    "no",
  );
});

Deno.test("globalFetch looks up fetch at call time", async () => {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = ((input: string) => {
    seen.push(input);
    return Promise.resolve(new Response("ok"));
  }) as typeof fetch;
  try {
    const response = await globalFetch("https://example.test/", {});
    assertEquals([await response.text(), seen], ["ok", [
      "https://example.test/",
    ]]);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FetchLike takes what fetch takes", async () => {
  const seen: string[] = [];
  const recording: FetchLike = (input, init) => {
    seen.push(`${init?.method ?? "GET"} ${String(input)}`);
    return Promise.resolve(new Response("ok"));
  };
  // The global fetch is one too.
  const _global: FetchLike = fetch;
  await recording("https://example.test/a");
  await recording(new URL("https://example.test/b"), { method: "POST" });
  assertEquals(seen, [
    "GET https://example.test/a",
    "POST https://example.test/b",
  ]);
  const original = globalThis.fetch;
  globalThis.fetch =
    ((input: Request) =>
      Promise.resolve(new Response(input.url))) as typeof fetch;
  try {
    const response = await globalFetch(new Request("https://example.test/c"));
    assertEquals(await response.text(), "https://example.test/c");
  } finally {
    globalThis.fetch = original;
  }
});
