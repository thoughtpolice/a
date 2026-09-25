// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import { type StandardResult, type StandardSchemaV1, v } from "@celld/sieve";

/** A consumer that knows only Standard Schema, like a form or RPC library. */
async function validate<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): Promise<StandardResult<NonNullable<S["~standard"]["types"]>["output"]>> {
  return await schema["~standard"].validate(value);
}

Deno.test("every schema is a Standard Schema", async () => {
  const User = v.object({ name: v.string(), age: v.int().default(0) });
  const props = User["~standard"];
  assertEquals([props.version, props.vendor], [1, "sieve"]);
  assertEquals(await validate(User, { name: "ada" }), {
    value: { name: "ada", age: 0 },
  });
  assertEquals(await validate(User, { name: 1 }), {
    issues: [{
      code: "invalid_type",
      expected: "string",
      received: "number",
      path: ["name"],
      message: "expected string, received number",
    }],
  });
});

Deno.test("validate is sync unless the schema is async", async () => {
  const sync = v.int()["~standard"].validate(1);
  assert(!(sync instanceof Promise), "sync");
  assertEquals(sync, { value: 1 });
  const slow = v.int().refine((n) => Promise.resolve(n > 0), "positive");
  const pending = slow["~standard"].validate(0);
  assert(pending instanceof Promise, "async");
  assertEquals(await pending, {
    issues: [{ code: "custom", path: [], message: "positive" }],
  });
});
