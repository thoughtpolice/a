// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@celld/assert";
import { formatPath, SieveError, v } from "@celld/sieve";

const Form = v.object({
  email: v.email(),
  password: v.string().min(8),
  items: v.array(v.object({ "odd key": v.int() })),
}).refine((form) => form.password !== form.email, "password must differ");

Deno.test("parse throws a SieveError with every issue", () => {
  const error = assertThrows(() =>
    Form.parse({ email: "x", password: "short", items: [{ "odd key": 1.5 }] })
  );
  assert(error instanceof SieveError, "a SieveError");
  assertEquals(error.name, "SieveError");
  assertEquals(error.issues.length, 3);
  assertEquals(
    error.message,
    [
      "email: invalid email address",
      "password: must have at least 8 characters",
      'items[0]["odd key"]: expected int, received number',
    ].join("\n"),
  );
  assertEquals(error.format(), error.message);
  assertEquals(v.prettifyError(error), error.message);
});

Deno.test("flatten groups by the first path segment", () => {
  const result = Form.safeParse({
    email: "x",
    password: "short",
    items: [{}, {}],
  });
  assert(!result.success, "fails");
  assertEquals(result.error.flatten(), {
    formErrors: [],
    fieldErrors: {
      email: ["invalid email address"],
      password: ["must have at least 8 characters"],
      items: ["missing required key", "missing required key"],
    },
  });
  const root = Form.safeParse({
    email: "ab@cd.co.uk",
    password: "ab@cd.co.uk",
    items: [],
  });
  assert(!root.success, "fails");
  assertEquals(root.error.flatten().formErrors, ["password must differ"]);
  assertEquals(root.error.format(), "password must differ");
});

Deno.test("safeParse results use zod's field names", () => {
  const ok = v.int().safeParse(1);
  assertEquals([ok.success, ok.data, ok.error], [true, 1, undefined]);
  const bad = v.int().safeParse("1");
  assertEquals([bad.success, bad.data], [false, undefined]);
  assert(bad.error instanceof SieveError, "error");
});

Deno.test("paths render like property access", () => {
  assertEquals(formatPath([]), "");
  assertEquals(formatPath(["a", 0, "b_c", "$d"]), "a[0].b_c.$d");
  assertEquals(formatPath([0, "x y", "__proto__"]), '[0]["x y"].__proto__');
});

Deno.test("messages for sizes are singular and plural", () => {
  const one = v.string().min(1).safeParse("");
  const many = v.array(v.int()).min(2).safeParse([]);
  assertEquals(
    [one.error?.issues[0].message, many.error?.issues[0].message],
    ["must have at least 1 character", "must have at least 2 items"],
  );
});
