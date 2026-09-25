<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/sieve

Typed schemas and validation for celld, in the style of
[zod 4](https://zod.dev): declare a schema once and get the TypeScript
type, a runtime parser that reports every problem with its path, a
[Standard Schema](https://standardschema.dev), and JSON Schema.

```python
celld.library(
    name = "api",
    srcs = glob(["src/*.ts"]),
    import_name = "@example/api",
    deps = ["root//src/celld/sieve:sieve"],
)
```

| Import                     | What it has                                                       |
| -------------------------- | ----------------------------------------------------------------- |
| `@celld/sieve`             | `v` (the builders), the schema classes, `SieveError`, issue types |
| `@celld/sieve/json-schema` | `toJSONSchema`, `toJSONSchemaBundle`                              |
| `@celld/sieve/introspect`  | `defOf`, `childrenOf`, `walk`, `idOf`, the definition types       |

The core never imports the two subpaths, so a Worker that only parses does
not carry them.

## Why it exists

celld runs Workers-style isolates, where `eval` and `new Function` are not
available. zod 4 gets much of its speed from compiling object schemas into
code at runtime; on an isolate that path is off and zod falls back to its
slower interpreter anyway, while the bundle still carries the compiler.
celld code also has no npm or JSR dependencies: every import is a first
party library built by Buck. So sieve is a small, interpreter-only
validator that depends only on other `@celld` libraries: good types, readable issues, JSON Schema
export, Standard Schema interop, and definitions a build-time tool can
read.

## A quick tour

```typescript
import { type Infer, type Input, v } from "@celld/sieve";

const Finding = v.object({
  title: v.string().trim().min(3),
  severity: v.enum(["low", "medium", "high"]),
  line: v.int().positive().optional(),
  tags: v.array(v.string()).max(5).default([]),
  seen: v.datetime({ offset: true }).nullable(),
});

type Finding = Infer<typeof Finding>;
// {
//   title: string;
//   severity: "low" | "medium" | "high";
//   line?: number | undefined;
//   tags: string[];
//   seen: string | null;
// }
type FindingInput = Input<typeof Finding>; // `tags` is optional here

const finding = Finding.parse(JSON.parse(body)); // throws a SieveError
const result = Finding.safeParse(value);
if (!result.success) {
  console.log(result.error.format());
  // title: must have at least 3 characters
  // line: expected int, received number
}
```

Schemas are immutable: every method returns a new schema. The builders are
the namespace `v`; `v.Infer`, `v.Input`, `v.Output` and `v.Schema` are
there too.

- **Primitives**: `string`, `number` (finite), `int` (safe integer),
  `bigint`, `boolean`, `null`, `undefined`, `unknown`, `never`,
  `literal(value | values)`, `enum([...])` (`.options`, `.enum`,
  `.exclude`, `.extract`), `date` (a valid `Date`), `instanceof(Class)`,
  `bytes` (a `Uint8Array`, with `min`/`max`/`length` in bytes),
  `json` (any plain JSON value, typed `JsonValue`; see below).
- **Strings**: `min`, `max`, `length`, `nonempty`, `regex`, `startsWith`,
  `endsWith`, `includes`; formats `email`, `url`, `uuid`, `datetime`,
  `isoDate`, `isoTime`, `isoDuration`, `base64`, `base64url`, `hex`,
  `ipv4`, `ipv6`, `cidrv4`, `cidrv6`, `ulid`, `jwt({ alg? })` (also
  top-level: `v.email()`, `v.cidrv4()`, ...); rewrites `trim`,
  `toLowerCase`, `toUpperCase`, which run in order with the checks.
- **ISO formats**, as zod 4's `z.iso`: `v.iso.date()`,
  `v.iso.time({ precision })`, `v.iso.datetime({ offset, local, precision })`
  and `v.iso.duration()`. `precision` is `-1` for minutes only, `0` for
  whole seconds, or the exact number of fractional digits.
- **Temporal**: `v.instant()`, `v.zonedDateTime()`, `v.plainDate()`,
  `v.plainTime()`, `v.plainDateTime()` and `v.duration()` accept an
  instance of that `Temporal` type. A string schema converts to one with
  `.toInstant()`, `.toPlainDate()`, `.toPlainTime()`,
  `.toPlainDateTime()` or `.toDuration()`, after its own checks:

  ```typescript
  const Reminder = v.object({
    at: v.iso.datetime({ offset: true }).toInstant(),
    every: v.iso.duration().toDuration().optional(),
  });
  Reminder.parse({ at: "2026-09-25T10:15:30+02:00", every: "P1W" });
  // { at: Temporal.Instant 2026-09-25T08:15:30Z, every: Temporal.Duration P1W }
  // Input<typeof Reminder> is { at: string; every?: string | undefined }
  ```

  The conversion parses with `@celld/isotime`'s strict parsers, not
  `Temporal`'s lenient ones, so `v.string().toInstant()` alone still
  refuses `2026-09-25 10:15+0200` and `...Z[Europe/Paris]`. `toInstant`
  needs `Z` or an offset, `toPlainDateTime` no zone at all (it refuses
  `Z` rather than drop it), and `toPlainTime` a time with no zone. Text
  it refuses is an `invalid_format` issue with the string format's name.
  A `ZonedDateTime` has no RFC 3339 form, so there is no conversion to
  one; convert to an instant and call `toZonedDateTimeISO(zone)`.

The date, time, address, ULID and JWT formats come from
[`@celld/isotime`](../isotime), [`@celld/ip`](../ip),
[`@celld/ulid`](../ulid) and [`@celld/jwt`](../jwt), so a string passes
exactly when that library parses it. `jwt` checks the shape only (three
base64url parts, a JSON header with `alg`, a JSON payload), as zod does.
Verifying the signature takes a key and `verify` from `@celld/jwt`.
- **Numbers**: `min`/`gte`, `max`/`lte`, `gt`, `lt`, `positive`,
  `nonnegative`, `negative`, `nonpositive`, `multipleOf` (exact for
  decimal steps), `int`. Bigints have the bounds.
- **Composites**: `object` (`.strict()`, `.loose()`, `.catchall()`,
  `.extend`, `.merge`, `.pick`, `.omit`, `.partial`, `.required`,
  `.keyof`, `.shape`), `strictObject`, `looseObject`, `array`
  (`min`/`max`/`length`/`nonempty`, `.element`), `tuple(items, rest?)`,
  `record(key, value)`, `map`, `set`, `union`, `discriminatedUnion`,
  `intersection`, `lazy`.
- **Modifiers**: `.optional()`, `.nullable()`, `.nullish()`,
  `.default(value | fn)`, `.catch(value | fn)`, `.transform(fn)`,
  `.refine(pred, message)`, `.check(ctx => ...)`, `.pipe(schema)`,
  `v.preprocess(fn, schema)`, `.brand<"Tag">()`, `.readonly()`,
  `.describe(text)`, `.meta({...})`, and `v.coerce.{string, number,
  boolean, bigint, date}`.

Every check and constructor takes a custom message, as a string or
`{ message }`: `v.string("need text").min(1, "required")`.

### Issues

A failed parse collects every issue it can find: objects and arrays keep
going after a bad key or element, and all built-in checks run once the type
is right. Refinements (`.refine`, `.check`) run only when the value has no
issues yet, so they can trust it. As in zod 4, both take `when` and `abort`
options: `when({ value, issues })` decides whether the refinement runs
(it is never asked about a value of the wrong type), so a cross-field check
can run alongside the fields' own issues, and `abort: true` skips the checks
after a refinement that raised an issue.

```typescript
const Range = v.object({ from: v.int(), to: v.int(), label: v.string() })
  .refine((r) => r.from <= r.to, {
    message: "from must not be after to",
    path: ["to"],
    when: ({ issues }) => issues.every((i) => i.path[0] !== "from" && i.path[0] !== "to"),
  });
Range.safeParse({ from: 5, to: 1, label: 3 });
// label: expected string, received number
// to: from must not be after to
```

A required object key (or a record's enum key) that is absent is reported
as its schema's issue (`invalid_type` with `received: "undefined"`, say)
with the message `missing required key`, exported as `MISSING_KEY_MESSAGE`,
unless the schema has a message of its own. An explicit `undefined` is a
value of the wrong type. Array holes are elements that are `undefined`.

```typescript
{ code: "too_small", origin: "string", minimum: 3, inclusive: true,
  path: ["title"], message: "must have at least 3 characters" }
```

| Code                   | Extra fields                                          |
| ---------------------- | ----------------------------------------------------- |
| `invalid_type`         | `expected`, `received`                                |
| `too_small`, `too_big` | `origin`, `minimum`/`maximum`, `inclusive`, `exact?`  |
| `invalid_format`       | `format`, and `pattern`, `prefix`, `suffix` or `includes` |
| `not_multiple_of`      | `divisor`                                             |
| `unrecognized_keys`    | `keys`                                                |
| `invalid_union`        | `errors` (each option's issues); `discriminator`, `options` for an unknown tag |
| `invalid_value`        | `values`                                              |
| `invalid_key`          | `origin` (`record` or `map`), `issues`                |
| `invalid_intersection` | none                                                  |
| `custom`               | `params?`                                             |

`SieveError` has `issues`, `flatten()` (`formErrors` and `fieldErrors` by
first path segment) and `format()`, which is also its `message` and what
`v.prettifyError(error)` returns: one `path: message` line per issue.

When no union option matches and exactly one option had the right type (a
string that failed its `email` check, say), that option's issues are
reported as they are. Failing that, when exactly one option is a
discriminated union that failed only on an unknown tag, its issue is
reported: `v.union([Event, v.array(Event)])` answers an object with an
unknown `type` with `unknown type; expected ...`, not "no union option
matched". Otherwise one `invalid_union` issue holds them all.

### JSON values

`v.json()` accepts what `JSON.stringify` writes as it is: strings, finite
numbers, booleans, `null`, and arrays and plain objects of these. Its type
is `JsonValue` (exported with `JsonObject` and `JsonPrimitive`), and the
output is the input, unchanged. Each thing `JSON.stringify` would drop,
convert or throw on is an `invalid_type` issue with `expected: "JSON"` at
its own path: `undefined`, functions, symbols, bigints, `NaN` and
`Infinity`, array holes, symbol keys, non-plain objects (a `Date`, a
`Map`, a class instance) and cycles. Shared references that are not cycles
are fine. In JSON Schema it is `{}`.

```typescript
v.object({ data: v.json() }).safeParse({ data: { at: new Date(), n: NaN } });
// data.at: a Date is not a plain JSON object
// data.n: NaN is not a JSON number
```

### Transforms

A transform gets the value and a context with `path`, `addIssue` and
`input`: what the schema it was called on received, before parsing. In
`v.looseObject({...}).transform((object, { input }) => ...)`, `input` is
the original object, so a decoder can keep it as `raw` next to the fields
it read. Every transform in a chain sees the chain's input.

### Async

Parsing is synchronous unless a refinement or transform returns a Promise.
Then `parse`, `safeParse` and `is` throw an error saying to use
`parseAsync` or `safeParseAsync`, which await it. The Standard Schema
`validate` is async only when the parse is.

### Objects and optional keys

Unknown keys are stripped by default; `.strict()` reports them and
`.loose()` keeps them. `.strict()` reports all of them in one
`unrecognized_keys` issue on the object, as zod does;
`.strict({ perKey: true })` (or `v.strictObject(shape, { perKey: true })`)
reports one per key at the key's own path, so `questions.typo.critera`
points at the typo. An `.optional()` key becomes `key?:` in the type; a
missing optional key stays missing in the output (an explicit `undefined`
stays too). `.default()` makes the key optional in the input type and
required in the output. `.extend`, `.pick`, `.omit`, `.partial` and
`.required` build a new shape, so they drop the object's refinements and
metadata; `.strict()`, `.loose()` and `.catchall()` keep them.

### Recursive types

TypeScript cannot infer a type that refers to itself, so write the type and
annotate the schema. `v.Schema<Output, Input>`: leave the input `unknown`
when it differs from the output (a default somewhere, say).

```typescript
type Tree = { value: number; children: Tree[] };
const Tree: v.Schema<Tree> = v.object({
  value: v.number(),
  children: v.array(v.lazy(() => Tree)),
});
```

### Standard Schema

Every schema has a `"~standard"` property (`version: 1`, `vendor:
"sieve"`), so it works with anything that accepts a Standard Schema v1.
The interface is declared in `src/standard.ts`; nothing is fetched.

## JSON Schema

```typescript
import { toJSONSchema } from "@celld/sieve/json-schema";

toJSONSchema(Finding); // draft 2020-12, with "$schema"
toJSONSchema(Finding, { io: "input" }); // what parse accepts
```

- `io: "output"` (the default) describes what `parse` returns: a default's
  key is required, a stripping object has `additionalProperties: false`,
  and a pipe is its last schema. `io: "input"` describes what `parse`
  accepts: defaults are optional, stripping objects are open, and a pipe
  is its first schema.
- Formats map to `email`, `uri`, `uuid`, `date-time`, `date`, `time`,
  `duration`, `ipv4` and `ipv6`; `base64` to `contentEncoding`; `hex`,
  `base64url`, `cidrv4`, `cidrv6`, `ulid`, `jwt`, `regex` and the affix
  checks to `pattern` (more than one pattern goes into `allOf`). The
  `cidr` and `ulid` patterns accept exactly what the libraries parse;
  `jwt`'s is the three-part shape only. JSON Schema's `time` is RFC 3339's
  `full-time`, which needs a zone, while `v.iso.time()` takes none; zod
  emits the same `format`, and this follows it.
  Lengths, bounds and `multipleOf` map to their keywords; `int` makes
  `type: "integer"`.
- Literals are `const` or `enum`, enums `enum`; `nullable` is `type: [t,
  "null"]` when that is exact, else `anyOf` with `null`. Unions are
  `anyOf`, discriminated unions `oneOf`, intersections `allOf`, tuples
  `prefixItems` with `items` for the rest (or `false`).
- Objects list `required` keys (and leave `required` out when there are
  none, except for `openai-strict`, which writes `required: []`); strict
  objects (and stripping ones on output) have
  `additionalProperties: false`, and a catchall is its schema.
- `description`, `title`, `examples` and any other `meta` keys (but `id`)
  are copied as they are; `default` values and `readonly` (`readOnly`)
  too.
- Named schemas (`.meta({ id: "Finding" })`) are `$defs` entries used by
  `$ref`. So are lazy targets (as `schema0`, ... unless named); a lazy
  reference back to the root is `{ "$ref": "#" }`. Two different schemas
  with one name are an error. An `id` is not inherited: `.describe()`,
  `.min()` and friends on a named schema make an unnamed one.
- A string converted to a `Temporal` value (`.toInstant()`, ...) is, on
  input, that string with its format (`date-time`, `date`, `time` or
  `duration`), even when no string check set one.
- Refinements, string rewrites and coercion are not represented: a
  refinement is code, so describe what it adds with `.meta()`, whose keys
  are copied onto the schema (`v.json().refine(nonBlank).meta({ type:
  "string", pattern: "\\S" })`). `v.json()` itself is `{}`, which is
  exact: every JSON document is a JSON value.
  Transforms, `bigint`, `date`, `Temporal` values (on output, or as
  instances), `undefined`, `bytes`, `instanceof`, `map` and `set` (and
  literals of those) throw, naming the JSON pointer, unless
  `unrepresentable: "any"`, which makes them `{}`.
- `toJSONSchemaBundle(module)` takes a module's exports (or a list) and
  returns `{ $schema, $defs }` with every named schema, sorted by name.
- `$schema: false` leaves out the `$schema` URI, for APIs that want a bare
  schema (MCP tool schemas, OpenAI's non-strict tools).

### OpenAI strict mode

`target: "openai-strict"` writes a schema OpenAI's strict structured
outputs and strict function tools accept, and throws on one they would
refuse, with the JSON pointer and what to change:

```typescript
toJSONSchema(v.object({ line: v.int().optional() }), {
  target: "openai-strict",
});
// Error: sieve: openai-strict: key "line" may be absent, but every key
// must be required (at #/properties/line); use .nullable() instead of
// .optional() in strict mode; the model sends null
```

- It describes what `parse` accepts (`io` defaults to `"input"`), since
  the model writes the input.
- The root must be an object (not nullable, not a union).
- Every object has `additionalProperties: false`, stripping objects
  included. Loose objects, catchalls and records throw.
- Every key is required. An `.optional()`, `.nullish()` or `.default()`
  key throws: use `.nullable()`, and the model sends `null`. A `.catch()`
  key is written as required; the parse still falls back on a bad value.
- Discriminated unions are `anyOf`, not `oneOf`.
- What would need `allOf` throws: intersections (use `.extend()` or
  `.merge()`) and strings with more than one pattern (write one `.regex()`).
- `$schema`, `default` and `contentEncoding` are left out; `$defs` and
  `$ref` stay, recursion included. Pass `$schema: true` to keep the URI.

## Code generation

sieve schemas are meant to be read by tools as well as run: a build step can
turn the schemas of an API (exedev, openai, mcp, jev, ...) into JSON Schema
today, and into types or clients for other languages later.

### The definition format

Every schema's `def` is a frozen, plain descriptor. The types live in
`src/def.ts` and are exported from `@celld/sieve/introspect`.

```typescript
defOf(v.string().min(1, "required").email().trim());
// {
//   kind: "string",
//   coerce: false,
//   checks: [
//     { check: "min_length", value: 1, message: "required" },
//     { check: "format", format: "email" },
//     { check: "trim" },
//   ],
// }
```

- `kind` is one of `string`, `number`, `bigint`, `boolean`, `date`,
  `temporal` (with `type`: `instant`, `zoned_date_time`, `plain_date`,
  `plain_time`, `plain_date_time` or `duration`, and `coerce`, set for a
  string conversion, which is the `out` of a `pipe`), `null`,
  `undefined`, `unknown`, `never`, `bytes`, `json`, `literal`, `enum`,
  `instanceof`, `object`, `array`, `tuple`, `record`, `map`, `set`,
  `union`, `discriminated_union`, `intersection`, `lazy`, `optional`,
  `nullable`, `readonly`, `default`, `catch`, `pipe` and `transform`.
- `checks` are data: `min_length`, `max_length`, `length`, `regex`,
  `starts_with`, `ends_with`, `includes`, `format` (with `datetime`'s
  `offset`, `local` and `precision`, `time`'s `precision`, and `jwt`'s
  `alg`), `trim`, `to_lower_case`,
  `to_upper_case`, `min`/`max` (with `inclusive`), `multiple_of`, `int`,
  and the user-code checks `refine` and `custom`.
- Children are fields: `shape` and `catchall`, `element`, `items` and
  `rest`, `key` and `value`, `options` and `discriminator`, `left` and
  `right`, `inner`, `in` and `out`, and `getter` for `lazy`.
- `meta` holds `id`, `title`, `description`, `examples` and anything else
  given to `.meta()`.

The interpreter reads nothing else, so a tool sees everything a parse does.
The only functions are the user's own, each in a node or check of its own
kind: `refine` and `custom` checks, `transform` nodes, `default` and
`catch` `factory`, the `lazy` getter and the `instanceof` class. A tool
cannot see inside them, but it always knows where they are
(`transforms(schema)` answers whether parsing can change a value).

**Stability.** `DEF_VERSION` (now 1) versions this format. Within a
version, new kinds, check names, optional fields and meta keys may be
added, but no field changes meaning or goes away; a generator should
reject a kind or check it does not know rather than guess. Anything else
bumps the version.

### Introspection

```typescript
import { childrenOf, idOf, walk } from "@celld/sieve/introspect";

walk(Api, (schema, trail) => {
  const id = idOf(schema);
  if (id !== undefined) emitType(id, schema.def, trail);
});
```

`childrenOf(schema)` lists a schema's children as edges with a `role`
(`shape`, `element`, `option`, `inner`, ...) and a `key` for object keys
and positions. `walk` visits a tree depth first, each schema once, and
follows lazy getters, so recursive types end; return `false` to skip a
subtree. `json-schema` is written on these.

### The Buck flow

`sieve_json_schema` in [`defs.bzl`](defs.bzl) writes a module's named
schemas as one JSON Schema bundle at build time:

```python
load("@root//src/celld/sieve:defs.bzl", "sieve_json_schema")

sieve_json_schema(
    name = "api-schema",            # writes api-schema.json
    module = "@example/api/schemas", # a specifier one of deps exports
    deps = [":api"],
    io = "output",                  # optional: toJSONSchema's options
    unrepresentable = "throw",
)
```

It needs nothing new from the celld toolchain. The macro declares a
`celld.worker` whose main is [`tools/emit.ts`](tools/emit.ts) and whose
deps are sieve plus `deps`. That unit's `[config]` is the import map for
the whole closure and its `[check]` stamp type-checks the emitter; the rule
then runs the toolchain's Deno (`CelldToolchain.deno`) as `deno run` with
that config, read access and write access, after every dependency's own
check stamp. The emitter imports the module by its specifier and writes
`toJSONSchemaBundle(exports)`. The worker's bundle is never built.

`:fixture-api-schema` does this for [`tests/fixture_api.ts`](tests/fixture_api.ts),
and `:emit-test` compares the result with
[`tests/golden/fixture-api.schema.json`](tests/golden/fixture-api.schema.json).
After an intended change, copy the built file
(`buck2 build :fixture-api-schema --show-output`) over the golden one.

## Differences from zod 4

The API follows zod 4 where it exists; this is what is different or left
out.

- **No JIT, by design.** Everything is interpreted.
- **Left out**: `any`, `void`, `symbol`, `nan`, `function`, `promise`,
  `file`, `custom`, `stringbool`, `templateLiteral`, TypeScript
  `enum` objects, `partialRecord`/`looseRecord`, numeric record keys,
  `.prefault`, `.nonoptional`, `.superRefine` (use `.check`), `.and`/`.or`,
  `.array()` shorthands, codecs (`encode`/`decode`), emoji,
  nanoid/cuid/cuid2/xid/ksuid/e164 formats, string
  `normalize` and case checks (only the rewrites), date, set and map size
  bounds, `.finite()`/`.safe()`, `.step()`.
- **Errors**: messages are strings, not functions; there is no error map,
  locale or `z.config`, and checks have no `abort` or `when`. Issues keep a
  `received` field (zod 4 dropped it) and have no `input`. `format()`
  returns the readable string, not zod's deprecated tree, and there is no
  `treeifyError`. `flatten` groups by the first path segment only.
- **Metadata** lives on the def, not in registries; there is no
  `z.globalRegistry`. A `meta.id` is not inherited by derived schemas.
- **Objects**: `.required()` removes a top-level `.optional()` only.
  Reshaping (`extend`, `pick`, ...) drops refinements instead of refusing.
  A catchall's index signature includes the declared keys' types so the
  declared keys stay valid.
- **Tuples**: optional items are typed `T | undefined`, not `T?`, and the
  output always has every item.
- **Intersections** report conflicting outputs as an
  `invalid_intersection` issue; zod throws.
- **Discriminated unions** take object options only (no nested unions);
  the tag schema must be a literal or an enum.
- **JSON Schema**: draft 2020-12 and the `openai-strict` profile only; no
  `override`, `cycles`, `reused` or `uri` options, and no `fromJSONSchema`.
- `is(value)` is a type guard that is only sound for schemas that do not
  change the value (see `transforms` in `@celld/sieve/introspect`).

## Examples

[`examples/`](examples) has standalone Workers using this library, each
tested under `celld dev`
(`buck2 test root//src/celld/sieve/examples/...`) and runnable with
`buck2 run root//src/celld/sieve/examples:<name>-dev`.

## Tests

```sh
buck2 test root//src/celld/sieve/...
```

One suite per concern under `tests/`: primitives, strings, the
library-backed formats, objects,
composites, modifiers (including async), errors, Standard Schema, JSON
Schema, introspection, and `types_test.ts`, whose assertions are types
(`const _: Equal<A, B> = true`), so `deno check` fails when inference
regresses. `emit_test.ts` checks the Buck flow's output against its golden
file.
