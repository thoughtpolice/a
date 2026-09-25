// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// What one parse of hostile input may cost: WP-12 sweep regressions.

import { assert, assertEquals } from "@celld/core/assert";
import { MAX_ISSUES, MAX_PARSE_DEPTH, v } from "@celld/sieve";

function nested(depth: number): unknown {
  let value: unknown = [];
  for (let i = 0; i < depth; i++) value = [value];
  return value;
}

// DB-SWP-F8-3: an array's max length was checked after every element had
// been parsed, so a declared cap did not bound the work.
Deno.test("an array over its max is refused before its elements are parsed", () => {
  let calls = 0;
  const counted = v.number().refine(() => {
    calls++;
    return true;
  });
  const result = v.array(counted).max(3).safeParse(
    Array.from({ length: 100_000 }, () => 1),
  );
  assert(!result.success, "refused");
  assertEquals(result.error.issues.map((issue) => issue.code), ["too_big"]);
  assertEquals(calls, 0);
  const exact = v.array(counted).length(2).safeParse([1, 2, 3, 4]);
  assert(!exact.success, "refused");
  assertEquals(calls, 0);
  assert(v.array(counted).max(3).safeParse([1, 2]).success, "within the cap");
  assertEquals(calls, 2);
});

// DB-SWP-F8-4: every element's issue was kept, so a large body of wrong
// values produced issues a hundred times its size.
Deno.test("one container reports at most MAX_ISSUES problems", () => {
  const many = Array.from({ length: 100_000 }, () => 1);
  const cases: [string, v.Schema<unknown, unknown>, unknown][] = [
    ["array", v.array(v.string()), many],
    ["tuple rest", v.tuple([], v.string()), many],
    ["set", v.set(v.string()), new Set(many.map((_, i) => i))],
    [
      "record",
      v.record(v.string(), v.string()),
      Object.fromEntries(many.map((_, i) => [`k${i}`, i])),
    ],
    [
      "map",
      v.map(v.string(), v.string()),
      new Map(many.map((_, i) => [`k${i}`, i])),
    ],
    [
      "catchall",
      v.object({}).catchall(v.string()),
      Object.fromEntries(many.map((_, i) => [`k${i}`, i])),
    ],
  ];
  for (const [name, schema, input] of cases) {
    const result = schema.safeParse(input);
    assert(!result.success, name);
    const issues = result.error.issues;
    assert(issues.length <= MAX_ISSUES + 1, `${name}: ${issues.length}`);
    const last = issues.at(-1)!;
    assertEquals(last.code, "custom", name);
    assertEquals(
      (last as { params?: Record<string, unknown> }).params?.reason,
      "too_many_issues",
      name,
    );
  }
  const json = v.json().safeParse(
    Array.from({ length: 100_000 }, () => undefined),
  );
  assert(!json.success && json.error.issues.length <= MAX_ISSUES + 1, "json");
});

// DB-SWP-F7-12: parsing recursed once per level of the input, so a deep
// enough value threw a stack overflow out of safeParse.
Deno.test("deep input is an issue, not a stack overflow", () => {
  interface Tree {
    readonly children: Tree[];
  }
  const Tree: v.Schema<Tree, unknown> = v.object({
    children: v.array(v.lazy(() => Tree)),
  });
  let tree: unknown = { children: [] };
  for (let i = 0; i < 100_000; i++) tree = { children: [tree] };
  for (
    const [name, run] of [
      ["lazy", () => Tree.safeParse(tree)],
      ["json", () => v.json().safeParse(nested(100_000))],
      ["array of unknown", () => v.array(v.unknown()).safeParse(nested(5))],
    ] as const
  ) {
    const result = run();
    if (name === "array of unknown") {
      assert(result.success, name);
      continue;
    }
    assert(!result.success, name);
    assert(
      result.error.issues.some((issue) =>
        (issue as { params?: Record<string, unknown> }).params?.reason ===
          "too_deep"
      ),
      `${name}: ${JSON.stringify(result.error.issues.slice(0, 2))}`,
    );
  }
  assert(MAX_PARSE_DEPTH >= 64, "room for real documents");
  assert(v.json().safeParse(nested(MAX_PARSE_DEPTH - 1)).success, "at the cap");
});
