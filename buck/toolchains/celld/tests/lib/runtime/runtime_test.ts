// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { env, RpcStub, RpcTarget, waitUntil } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { TOTAL } from "@fixture/data";
import { GENERATED } from "@fixture/generated";

Deno.test("the fake runtime's env takes the test's bindings", () => {
  Object.assign(env, { TOTAL });
  if (env.TOTAL !== GENERATED) throw new Error(`env.TOTAL is ${env.TOTAL}`);
});

Deno.test("a NonRetryableError keeps its message and name", () => {
  const error = new NonRetryableError("stop", "Stop");
  if (!(error instanceof Error)) throw new Error("not an Error");
  if (error.message !== "stop" || error.name !== "Stop") {
    throw new Error(`${error.name}: ${error.message}`);
  }
  if (new NonRetryableError("x").name !== "NonRetryableError") {
    throw new Error("default name");
  }
});

Deno.test("an RpcStub makes its target's members asynchronous", async () => {
  class Counter extends RpcTarget {
    count = 1;
    add(n: number): number {
      return this.count += n;
    }
  }
  const stub = new RpcStub(new Counter());
  if (await stub.add(2) !== 3) throw new Error("add");
  if (await stub.count !== 3) throw new Error("count");
  waitUntil(Promise.resolve());
});
