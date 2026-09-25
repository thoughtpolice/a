// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Prototype names in parsed input: WP-12b sweep regressions.

import { assert, assertEquals } from "@celld/core/assert";
import { v } from "@celld/sieve";

/**
 * Runs `body` with `Object.prototype.__proto__` as V8 (and so workerd)
 * defines it. Deno removes the accessor by default, which hides assignments
 * that would change an object's prototype in a Worker.
 */
function withProtoAccessor(body: () => void): void {
  const had = Object.getOwnPropertyDescriptor(Object.prototype, "__proto__");
  Object.defineProperty(Object.prototype, "__proto__", {
    configurable: true,
    enumerable: false,
    get(this: object) {
      return Object.getPrototypeOf(this);
    },
    set(this: object, proto: unknown) {
      if (typeof proto === "object" || typeof proto === "function") {
        Object.setPrototypeOf(this, proto as object | null);
      }
    },
  });
  try {
    body();
  } finally {
    if (had === undefined) {
      delete (Object.prototype as { __proto__?: unknown }).__proto__;
    } else {
      Object.defineProperty(Object.prototype, "__proto__", had);
    }
  }
}

// DB-SWP-F9-201: an intersection merged its two outputs with plain
// assignment, so an own `__proto__` key kept by a loose side set the
// prototype of the validated output.
Deno.test("an intersection keeps __proto__ as data", () =>
  withProtoAccessor(() => {
    const schema = v.intersection(
      v.object({ role: v.literal("user").optional() }),
      v.looseObject({}),
    );
    const out = schema.parse(
      JSON.parse('{"__proto__":{"role":"admin"}}'),
    ) as Record<string, unknown>;
    assertEquals(Object.getPrototypeOf(out), Object.prototype);
    assertEquals(out.role, undefined);
    assert(Object.hasOwn(out, "__proto__"), "kept as an own key");
    assertEquals(Object.keys(out), ["__proto__"]);

    const nulled = schema.parse(JSON.parse('{"__proto__":null}'));
    assertEquals(Object.getPrototypeOf(nulled), Object.prototype);

    // The nested merge: both sides own `inner`, only the right keeps
    // `__proto__` inside it.
    const nested = v.intersection(
      v.object({ inner: v.object({ role: v.literal("user").optional() }) }),
      v.object({ inner: v.record(v.string(), v.unknown()) }),
    );
    const deep = nested.parse(
      JSON.parse('{"inner":{"__proto__":{"role":"admin"}}}'),
    ) as { inner: Record<string, unknown> };
    assertEquals(Object.getPrototypeOf(deep.inner), Object.prototype);
    assertEquals(deep.inner.role, undefined);
    assert(Object.hasOwn(deep.inner, "__proto__"), "kept as an own key");
  }));

// DB-SWP-F9-202 / DB-SWP-F9-01: a shape key was present when `key in
// input` held, so Object.prototype's members counted as sent.
Deno.test("inherited Object.prototype members are not shape keys", () => {
  assertEquals(v.object({ constructor: v.unknown() }).parse({}), {});
  assertEquals(
    v.object({ constructor: v.string().default("x") }).parse({}),
    { constructor: "x" },
  );
  const missing = v.object({ toString: v.string() }).safeParse({});
  assert(!missing.success, "a required key that was not sent");
  assertEquals(missing.error.issues[0].path, ["toString"]);
  assertEquals(
    v.object({ valueOf: v.number() }).parse({ valueOf: 3 }),
    { valueOf: 3 },
  );
});

Deno.test("class instances still expose their getters", () => {
  class Point {
    get x(): number {
      return 1;
    }
  }
  assertEquals(v.object({ x: v.number() }).parse(new Point()), { x: 1 });
  const bare = Object.create(null) as Record<string, unknown>;
  bare.name = "n";
  assertEquals(v.object({ name: v.string() }).parse(bare), { name: "n" });
});
