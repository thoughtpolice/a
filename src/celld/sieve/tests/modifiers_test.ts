// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "@celld/assert";
import { v } from "@celld/sieve";
import { issues, issuesAsync } from "./fixture.ts";

Deno.test("optional, nullable and nullish", () => {
  assertEquals(v.string().optional().parse(undefined), undefined);
  assertEquals(
    issues(v.string().optional(), null)[0].message,
    "expected string, received null",
  );
  assertEquals(v.string().nullable().parse(null), null);
  assertEquals(
    issues(v.string().nullable(), undefined)[0].code,
    "invalid_type",
  );
  assertEquals(v.string().nullish().parse(null), null);
  assertEquals(v.string().nullish().parse(undefined), undefined);
  assertEquals(v.optional(v.int()).unwrap().parse(1), 1);
  assertEquals(v.nullable(v.int()).parse(null), null);
});

Deno.test("defaults fill undefined only, and are not parsed", () => {
  const port = v.int().default(8080);
  assertEquals(port.parse(undefined), 8080);
  assertEquals(port.parse(1), 1);
  assertEquals(issues(port, null)[0].code, "invalid_type");
  let calls = 0;
  const fresh = v.array(v.int()).default(() => {
    calls++;
    return [];
  });
  const a = fresh.parse(undefined);
  const b = fresh.parse(undefined);
  assert(a !== b && calls === 2, "the factory runs per parse");
  assertEquals(v.int().min(10).default(1).parse(undefined), 1);
});

Deno.test("catch replaces any failure", () => {
  assertEquals(v.int().catch(0).parse("x"), 0);
  assertEquals(v.int().catch(0).parse(5), 5);
  const seen: unknown[] = [];
  const logged = v.int().catch(({ input, issues }) => {
    seen.push(input, issues.length);
    return -1;
  });
  assertEquals(logged.parse("y"), -1);
  assertEquals(seen, ["y", 1]);
  assertEquals(v.object({ n: v.int().catch(0) }).parse({}), { n: 0 });
});

Deno.test("transform and pipe", () => {
  const length = v.string().transform((text) => text.length);
  assertEquals(length.parse("abc"), 3);
  assertEquals(issues(length, 1)[0].code, "invalid_type");
  const parsed = v.string().transform((text, context) => {
    const n = Number(text);
    if (Number.isNaN(n)) context.addIssue("not a number");
    return n;
  });
  assertEquals(issues(parsed, "x"), [{
    code: "custom",
    path: [],
    message: "not a number",
  }]);
  const port = v.string().pipe(v.coerce.number().int().min(1));
  assertEquals(port.parse("80"), 80);
  assertEquals(issues(port, "0")[0].code, "too_small");
  assertEquals(port.in.parse("x"), "x");
  const chained = v.string().trim().transform((text) => text.split(",")).pipe(
    v.array(v.string().min(1)),
  );
  assertEquals(chained.parse(" a,b "), ["a", "b"]);
  assertEquals(issues(chained, "a,,b")[0].path, [1]);
});

Deno.test("preprocess runs before the schema", () => {
  const list = v.preprocess(
    (input) => typeof input === "string" ? input.split(",") : input,
    v.array(v.string()),
  );
  assertEquals(list.parse("a,b"), ["a", "b"]);
  assertEquals(list.parse(["c"]), ["c"]);
  assertEquals(issues(list, 1)[0].code, "invalid_type");
});

Deno.test("refine runs only on otherwise valid values", () => {
  let calls = 0;
  const even = v.int().min(0).refine((n) => {
    calls++;
    return n % 2 === 0;
  }, "must be even");
  assertEquals(even.parse(4), 4);
  assertEquals(issues(even, 3), [{
    code: "custom",
    path: [],
    message: "must be even",
  }]);
  assertEquals(issues(even, -1).map((issue) => issue.code), ["too_small"]);
  assertEquals(calls, 2);
  const params = v.string().refine(() => false, { params: { rule: "x" } });
  assertEquals(issues(params, "a"), [{
    code: "custom",
    params: { rule: "x" },
    path: [],
    message: "invalid input",
  }]);
  const after = v.string().refine((text) => text !== "a").max(0);
  assertEquals(issues(after, "b").map((issue) => issue.code), ["too_big"]);
});

Deno.test("check adds any number of issues", () => {
  const range = v.object({ low: v.int(), high: v.int() }).check((context) => {
    if (context.value.low > context.value.high) {
      context.addIssue({ message: "low is above high", path: ["low"] });
      context.addIssue({
        message: "high is below low",
        path: ["high"],
        params: { low: context.value.low },
      });
    }
  });
  assertEquals(range.parse({ low: 1, high: 2 }), { low: 1, high: 2 });
  assertEquals(issues(range, { low: 3, high: 2 }), [
    { code: "custom", path: ["low"], message: "low is above high" },
    {
      code: "custom",
      path: ["high"],
      params: { low: 3 },
      message: "high is below low",
    },
  ]);
  assertEquals(
    issues(range, { low: "x", high: 2 }).map((issue) => issue.code),
    ["invalid_type"],
  );
});

Deno.test("async refinements and transforms need the async parses", async () => {
  const taken = new Set(["ada"]);
  const username = v.string().refine(async (name) => {
    await Promise.resolve();
    return !taken.has(name);
  }, "taken");
  assertEquals(await username.parseAsync("bob"), "bob");
  assertEquals(await issuesAsync(username, "ada"), [{
    code: "custom",
    path: [],
    message: "taken",
  }]);
  assertThrows(() => username.parse("bob"), Error, "parseAsync");
  assertThrows(() => username.safeParse("bob"), Error, "parseAsync");

  const form = v.object({
    user: username,
    id: v.string().transform((text) => Promise.resolve(Number(text))),
    tags: v.array(
      v.string().refine((tag) => Promise.resolve(tag.length > 1), "short"),
    ),
    plain: v.int(),
  });
  assertEquals(
    await form.parseAsync({ user: "bob", id: "7", tags: ["ab"], plain: 1 }),
    { user: "bob", id: 7, tags: ["ab"], plain: 1 },
  );
  assertEquals(
    (await issuesAsync(form, {
      user: "ada",
      id: "7",
      tags: ["ab", "c"],
      plain: "x",
    }))
      .map((issue) => [issue.path, issue.message]),
    [
      [["user"], "taken"],
      [["tags", 1], "short"],
      [["plain"], "expected number, received string"],
    ],
  );
  const union = v.union([
    v.int(),
    v.string().refine((text) => Promise.resolve(text === "ok")),
  ]);
  assertEquals(await union.parseAsync("ok"), "ok");
  assertEquals((await issuesAsync(union, "no"))[0].code, "custom");
  const checked = v.int().check(async (context) => {
    await Promise.resolve();
    if (context.value > 1) context.addIssue("too high");
  }).refine((n) => n !== 0, "zero");
  assertEquals((await issuesAsync(checked, 5))[0].message, "too high");
  assertEquals((await issuesAsync(checked, 0))[0].message, "zero");
  await assertRejects(() => username.parseAsync("ada"), Error, "taken");
});

Deno.test("brand is type-only and readonly freezes", () => {
  const Id = v.string().brand<"Id">();
  assertEquals(Id.parse("a"), "a");
  const frozen = v.object({ list: v.array(v.int()) }).readonly().parse({
    list: [1],
  });
  assert(Object.isFrozen(frozen), "frozen");
  assert(!Object.isFrozen(frozen.list), "shallow");
});

Deno.test("describe and meta are metadata; ids are not inherited", () => {
  const Name = v.string().describe("a name");
  assertEquals(Name.description, "a name");
  assertEquals(Name.def.meta, { description: "a name" });
  const named = v.string().meta({
    id: "Name",
    title: "Name",
    examples: ["ada"],
  });
  assertEquals(named.def.meta, {
    id: "Name",
    title: "Name",
    examples: ["ada"],
  });
  assertEquals(named.min(1).def.meta, { title: "Name", examples: ["ada"] });
  assertEquals(named.describe("x").def.meta, {
    title: "Name",
    examples: ["ada"],
    description: "x",
  });
  assertEquals(v.string().meta({ id: "A" }).min(1).def.meta, undefined);
});

Deno.test("schemas are immutable", () => {
  const base = v.string();
  const longer = base.min(3);
  assertEquals(base.def.checks.length, 0);
  assertEquals(longer.def.checks.length, 1);
  assert(Object.isFrozen(base) && Object.isFrozen(longer.def), "frozen");
  assertEquals(base.parse("a"), "a");
});

Deno.test("is narrows", () => {
  const value: unknown = "x";
  assert(v.string().is(value), "string");
  assert(!v.int().is(value), "not an int");
});

Deno.test("a transform sees the input of the schema it was called on", () => {
  const seen: unknown[] = [];
  const Entry = v.looseObject({ n: v.coerce.number() })
    .transform((entry, context) => {
      seen.push(context.input);
      return { n: entry.n, raw: context.input };
    })
    .transform((entry, context) => {
      seen.push(context.input);
      return entry;
    });
  const input = { n: "7", extra: true };
  const parsed = Entry.parse(input);
  assertEquals(parsed.n, 7);
  assert(parsed.raw === input, "the original object, not the parsed copy");
  assert(seen[0] === input && seen[1] === input, "the chain's input");
  // Inside another schema, the input is that value's.
  const inner = v.object({ at: Entry });
  assert(inner.parse({ at: input }).at.raw === input, "nested");
  const trimmed = v.string().trim().transform((text, { input }) => [
    text,
    input,
  ]);
  assertEquals(trimmed.parse(" y "), ["y", " y "]);
});

Deno.test("when lets a refinement run alongside other issues", () => {
  const Range = v.object({ from: v.int(), to: v.int(), label: v.string() });
  const ordered = (range: { from: unknown; to: unknown }) =>
    typeof range.from !== "number" || typeof range.to !== "number" ||
    range.from <= range.to;
  // By default the cross-field check waits for a clean value.
  const plain = Range.refine(ordered, {
    message: "from must not be after to",
    path: ["to"],
  });
  assertEquals(
    issues(plain, { from: 5, to: 1, label: 3 }).map((issue) => issue.message),
    ["expected string, received number"],
  );
  // With `when`, it runs once the fields it reads are clean.
  const eager = Range.refine(ordered, {
    message: "from must not be after to",
    path: ["to"],
    when: ({ issues }) =>
      issues.every((issue) =>
        issue.path[0] !== "from" && issue.path[0] !== "to"
      ),
  });
  assertEquals(
    issues(eager, { from: 5, to: 1, label: 3 }).map((issue) => [
      issue.path,
      issue.message,
    ]),
    [
      [["label"], "expected string, received number"],
      [["to"], "from must not be after to"],
    ],
  );
  assertEquals(
    issues(eager, { from: "5", to: 1, label: 3 }).length,
    2,
    "not when from is bad",
  );
  // `.check` takes the same options; `when` is never asked about a value of
  // the wrong type.
  let asked = 0;
  const checked = Range.check((ctx) => {
    if (!ordered(ctx.value)) ctx.addIssue("out of order");
  }, {
    when: () => {
      asked++;
      return true;
    },
  });
  assertEquals(
    issues(checked, { from: 2, to: 1, label: 0 }).map((issue) => issue.message),
    ["expected string, received number", "out of order"],
  );
  assertEquals(issues(checked, "nope").length, 1);
  assertEquals(asked, 1);
});

Deno.test("abort skips the checks after a failed refinement", () => {
  const code = v.string()
    .refine((text) => /^[a-z]+$/.test(text), {
      message: "letters only",
      abort: true,
    })
    .refine((text) => text.length === 3, "three letters");
  assertEquals(issues(code, "a1").map((issue) => issue.message), [
    "letters only",
  ]);
  assertEquals(issues(code, "abcd").map((issue) => issue.message), [
    "three letters",
  ]);
  const all = v.string()
    .check((ctx) => ctx.addIssue("first"), { abort: false })
    .check((ctx) => ctx.addIssue("second"), { when: () => true });
  assertEquals(issues(all, "x").map((issue) => issue.message), [
    "first",
    "second",
  ]);
});

Deno.test("abort also stops after an async refinement", async () => {
  const code = v.string()
    .refine((text) => Promise.resolve(text !== "x"), {
      message: "not x",
      abort: true,
    })
    .refine(() => false, "never reached for x");
  assertEquals(
    (await issuesAsync(code, "x")).map((issue) => issue.message),
    ["not x"],
  );
});
