// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import { fakeStep, virtualRuntime } from "@celld/http/testing";

Deno.test("virtualRuntime sleeps instantly on a virtual clock", async () => {
  const runtime = virtualRuntime({ start: 1000, random: 0.25 });
  assertEquals([runtime.now(), runtime.random()], [1000, 0.25]);
  await runtime.sleep(500);
  runtime.advance(20);
  assertEquals([runtime.now(), runtime.sleeps], [1520, [500]]);
  let reason: unknown;
  try {
    await runtime.sleep(9, AbortSignal.abort("stop"));
  } catch (error) {
    reason = error;
  }
  assertEquals([reason, runtime.sleeps, runtime.now()], ["stop", [500], 1520]);
  const defaults = virtualRuntime();
  assertEquals([defaults.now(), defaults.random()], [1_750_000_000_000, 0.5]);
});

Deno.test("fakeStep replays stored results and retries throwing steps", async () => {
  const step = fakeStep();
  let runs = 0;
  const flaky = () =>
    step.do("s", { retries: { limit: 2, delay: "1 second" } }, () => {
      runs++;
      if (runs < 2) throw new Error("transient");
      return { value: runs };
    });
  assertEquals(await flaky(), { value: 2 });
  assertEquals(await flaky(), { value: 2 });
  assertEquals(step.log, [
    "run s #1",
    "threw Error: transient",
    "run s #2",
    "replay s",
  ]);
  assertEquals(step.stored.get("s"), { value: 2 });

  let tries = 0;
  let caught: unknown;
  try {
    await step.do("always", { retries: { limit: 1, delay: 0 } }, () => {
      tries++;
      throw new TypeError("permanent");
    });
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof TypeError, "the last error is rethrown");
  assertEquals(tries, 2);
  assert(!step.stored.has("always"), "failures are not stored");
});

Deno.test("fakeStep uses celld's defaults and passes a step context", async () => {
  const step = fakeStep();
  const contexts: WorkflowStepContext[] = [];
  try {
    await step.do("d", (ctx) => {
      contexts.push(ctx);
      throw new Error("no");
    });
  } catch {
    // Five retries, then the error.
  }
  assertEquals(contexts.map((ctx) => ctx.attempt), [1, 2, 3, 4, 5, 6]);
  assertEquals(contexts[0], {
    step: { name: "d", count: 1 },
    attempt: 1,
    config: {
      retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
      timeout: "10 minutes",
    },
  });
  let config: WorkflowStepContext["config"] | undefined;
  await step.do("c", {
    retries: { limit: 0, delay: () => 5 },
    timeout: "1 minute",
  }, (ctx) => {
    config = ctx.config;
  });
  assertEquals(config, {
    retries: { limit: 0, backoff: "constant" },
    timeout: "1 minute",
  });
});

Deno.test("fakeStep results are structured clones", async () => {
  const step = fakeStep();
  const original = { list: [1] };
  const first = await step.do("x", () => original);
  first.list.push(2);
  assertEquals((await step.do("x", () => original)).list, [1]);
  assert(first !== original, "even the first run returns a clone");
  let error: unknown;
  try {
    await step.do("fn", () => () => 1);
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof DOMException, "functions cannot be stored");
});

Deno.test("fakeStep records sleeps once per name and has no events", async () => {
  const step = fakeStep();
  await step.sleep("nap", "5 seconds");
  await step.sleep("nap", "5 seconds");
  await step.sleepUntil("wake", 2_000_000_000_005);
  await step.sleepUntil("wake", new Date(2_000_000_000_005));
  await step.sleepUntil("date", new Date(1_000));
  assertEquals(step.log, [
    "sleep nap 5 seconds",
    "sleepUntil wake 2000000000005",
    "sleepUntil date 1000",
  ]);
  assertEquals(step.stored.size, 0);
  let message = "";
  try {
    await step.waitForEvent("approve", { type: "approval" });
  } catch (error) {
    message = (error as Error).message;
  }
  assertEquals(message, "fakeStep has no events (waitForEvent approve)");
});
