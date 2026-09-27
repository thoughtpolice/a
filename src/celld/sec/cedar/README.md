<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/sec/cedar

[Cedar](https://www.cedarpolicy.com) policies for celld: authorization
decisions, policy and entity stores in a Durable Object's SQLite,
and SQL filters compiled from the policies for listing what a principal may
see.

```python
celld.library(
    name = "app",
    srcs = glob(["src/*.ts"]),
    import_name = "@example/app",
    deps = ["root//src/celld/sec/cedar:cedar"],
)
```

| Import                     | What it has                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@celld/sec/cedar`         | `Authorizer`, `PolicySet`, `Schema`, `validatePolicies`, entities (`EntitySet`, `MemoryEntities`), values (`uid`, `ref`, `ip`, ...), diagnostics |
| `@celld/sec/cedar/query`   | `planQuery`, `queryFilter`, `compileResiduals`, `toSql`, `evaluate`, `QueryUnsupported`                                                          |
| `@celld/sec/cedar/sql`     | `sql` fragments, `render`, `durableObjectSql`, `SqlDriver`                                                                                       |
| `@celld/sec/cedar/store`   | `PolicyStore`, `EntityStore`, `migrate`, `storeTables`                                                                                           |
| `@celld/sec/cedar/router`  | `cedarAuthorize`, `decisionOf` for `@celld/web/router` routes                                                                                    |
| `@celld/sec/cedar/testing` | `assertCases`, `checkCases`: table-driven policy tests                                                                                           |
| `@celld/sec/cedar/wasm`    | the compiled cedar-wasm module (`WebAssembly.Module`)                                                                                            |

## The engine

The engine is [cedar-wasm](https://www.npmjs.com/package/@cedar-policy/cedar-wasm)
4.13 (Cedar language 4.5), Cedar's Rust `ffi` module compiled to
WebAssembly. [`third-party//by-name/ce/cedar-wasm`](../../../../buck/third-party/by-name/ce/cedar-wasm)
downloads the npm tarball by checksum (OSV tracks it as
`pkg:npm/@cedar-policy/cedar-wasm`) and exposes the `.wasm` file; the
library declares it with the toolchain's
[wasm modules](../../../../buck/toolchains/celld/README.md#wasm-modules), so a
Worker gets it as a sibling module that celld compiles once per node, and
Deno tests get it through a source-phase import.

None of the package's JavaScript is used. Its three flavours load the
module for a bundler, Node or a browser, and none fits a Worker; the
binding in [`src/wasm.ts`](src/wasm.ts) is written here instead. The
wasm-bindgen ABI it speaks is small: arguments and answers are JSON-shaped
values passed as externrefs, which Rust reads with an imported
`JSON.stringify` and answers with `JSON.parse`; strings travel through
linear memory. Imports are matched by name without wasm-bindgen's hash
suffix, and anything unknown fails the load, so a new cedar-wasm build binds
or says why.

`CedarEngine` owns one instance. Rust panics abort, and the FFI's own
errors throw through Rust frames, so after any exception the instance is
retired and the next call starts a fresh one from the compiled module;
`CedarEngineError.code` says which (`load`, `rejected` for input the FFI
could not deserialize, `trap`). Linear memory only grows, so an instance
whose memory passes `maxMemoryBytes` (256 MiB) is retired after the call.
`sharedEngine()` is the isolate's engine over the bundled module; every
API takes an `engine` option for another.

## Deciding requests

```typescript
import { Authorizer, ip, MemoryEntities, ref, uid } from "@celld/sec/cedar";

const authorizer = new Authorizer({
  schema: `
    entity User in [Team] { level: Long };
    entity Team;
    entity Doc { owner: User, public: Bool };
    action read, edit appliesTo { principal: User, resource: Doc, context: { ip: ipaddr } };
  `,
  policies: `
    @id("owners")
    permit (principal, action, resource) when { resource.owner == principal };

    @id("public-read")
    permit (principal, action == Action::"read", resource) when { resource.public };

    @id("office-only")
    forbid (principal, action == Action::"edit", resource)
    unless { context.ip.isInRange(ip("10.0.0.0/8")) };
  `,
  entities: new MemoryEntities([
    { uid: uid("User", "alice"), attrs: { level: 3 }, parents: [uid("Team", "eng")] },
    { uid: uid("Doc", "plan"), attrs: { owner: ref("User", "alice"), public: false } },
  ]),
});

const decision = await authorizer.authorize({
  principal: uid("User", "alice"),
  action: "edit",
  resource: uid("Doc", "plan"),
  context: { ip: ip("10.1.2.3") },
});
// { allowed: true, decision: "allow", reasons: ["owners"], errors: [], warnings: [] }
```

- **Policies are named by `@id`.** Cedar names the policies of a text by
  position, which moves when a policy is added above another; `reasons`,
  validation errors and stores all use ids, so they come from an annotation
  (`idAnnotation`, default `id`), with positional ids only as a fallback.
- **A schema validates policies once, at construction** (strict mode; a
  `CedarError` lists what does not validate) **and every request**. It also
  supplies action groups (`action delete in [manage]`).
- **Preparsed.** An authorizer parses its policies and schema into the
  engine once; a request costs Cedar its entities and context only. An
  engine keeps 32 preparsed sets (least recently used first); an authorizer
  that lost its place parses again on its next request.
- **Fail closed.** A request Cedar cannot evaluate (a context the schema
  refuses, a malformed entity, a value that cannot be a Cedar value) is a
  deny with the reason in `invalid`. A policy that errors while evaluating
  (an attribute an entity lacks) does not apply, as Cedar specifies, and is
  listed in `errors`. An engine that trapped throws.
- `check(request)` is synchronous and uses exactly the entities given;
  `authorize(request)` first asks the `entities` loader for the principal,
  the resource and all their ancestors. `permittedActions` answers several
  actions from one load (what a UI enables); `filter` checks a fetched list
  with one load for all of it.

### Values and entities

Cedar's JSON overloads plain objects: `{"__entity": {...}}` is an entity
reference and `{"__extn": {...}}` an extension value, so a context built
from request data could smuggle in a reference to an admin role.
`toCedarJson` (which every request goes through) refuses those keys in
records; references come from `ref(type, id)` and extension values from
`ip`, `decimal`, `datetime` and `duration`, which it recognizes by class.
`Temporal.Instant`, `ZonedDateTime` and `Duration` convert to datetimes and
durations. Numbers must be safe integers: Cedar's `Long` is 64-bit and
values reach Rust through `JSON.stringify`, which cannot carry more.
`null` is refused (Cedar has none; leave the attribute out), `undefined`
record fields are left out, nesting stops at 32.

`uid(type, id)` checks type names against Cedar's grammar; `formatUid`
and `parseUid` convert to and from `User::"alice"`, escapes included.
`EntitySet.add` takes entities as code writes them and checks every value;
`addJson` takes Cedar JSON from a store and must never see request data.

## Policies people edit

`PolicyStore` keeps a tenant's policies, templates, links and schema in
SQL (`store` separates tenants in shared tables). Every write is checked
before it is stored:

```typescript
import { durableObjectSql } from "@celld/sec/cedar/sql";
import { EntityStore, migrate, PolicyStore } from "@celld/sec/cedar/store";

const driver = durableObjectSql(ctx.storage);
await migrate(driver);
const policies = new PolicyStore({ driver, store: "acme" });

const result = await policies.putPolicy("titles", text);
if (!result.ok) {
  // Cedar's diagnostics, with lines and columns in the policy's text.
  return Response.json({ errors: result.errors.map((d) => formatDiagnostic(d, result.sourceOf?.(d.policyId))) }, { status: 422 });
}
```

- **Validate on write.** A policy (or a schema change) that does not
  validate against the stored schema is refused. So are validation
  *warnings* on a policy, unless `allowWarnings`: Cedar only warns when a
  policy can never apply under the schema ("impossible policy") or uses
  confusable identifiers, and a rule that silently does nothing is what
  validation is for.
- **Versions.** Each write moves the store's version by one in the same
  transaction as the change, through a guarded upsert. A writer that raced
  another retries; one that passed `expectVersion` (the version the person
  editing saw) gets `conflict: true` instead.
- **`authorizer(options)`** returns an `Authorizer` over the current
  version, cached until the version moves, so a Durable Object answers
  from memory and a new policy applies to the next request.
- **Links are grants.** Sharing "give Bob `viewer` on this document" is
  `link({ id, template: "viewer", principal, resource })`;
  `links({ principal })` and `links({ resource })` read the index ("what has
  Bob been given", "who can see this").
- **Policy as code.** `replacePolicies(text)` swaps every static policy and
  template for those of a text (ids from `@id`) in one write, keeping links
  whose templates remain.

## Entities

`EntityStore` keeps entities (attributes and tags as JSON) and their parent
edges, and implements `EntityLoader`: `load(uids)` fetches the entities and
every ancestor with one recursive query (`WITH RECURSIVE`, safe on
cycles). An ancestor that has parents but no
row of its own comes back with no attributes, so `in` still sees through
it. `MemoryEntities` is the loader for entities that live in code.

## Listing what a principal may see

`Authorizer.filter` checks a list that was already fetched. For lists too
long to fetch, `@celld/sec/cedar/query` turns the policies into a `WHERE`
clause: partial evaluation with the resource left open, compiled to SQL
for the table the resources live in.

```typescript
import { planQuery } from "@celld/sec/cedar/query";
import { render, sql } from "@celld/sec/cedar/sql";

const plan = await planQuery(authorizer, { principal: alice, action: "read", context }, {
  type: "Doc",
  id: "docs.id",
  attributes: {
    owner: { type: "entity", column: "docs.owner", entityType: "User" },
    public: { type: "bool", column: "docs.public" },
    classification: { type: "long", column: "docs.classification" },
    tags: { type: "set", column: "docs.tags", element: "string" },
  },
  in: (folder) => folder.type === "Folder"
    ? sql`docs.id IN (SELECT doc FROM doc_folders WHERE folder = ${folder.id})`
    : false,
});
const { text, params } = render(sql`SELECT * FROM docs WHERE ${plan.where} ORDER BY id LIMIT ${50}`);
```

`planQuery` loads the principal and its ancestors through the
authorizer's entity loader first, as `authorize` does; `queryFilter` is the
synchronous form that uses exactly the entities in the request, so pass the
principal's (without them, `principal in Team::"eng"` never holds and those
rows are silently left out).

For entities in an `EntityStore`, `entities.query(authorizer, request,
"Doc", { owner: { entity: "User" }, public: "bool" }, { limit, after })`
does the same over the store's JSON (with `json_extract`) and pages by id.
A dotted path (`profile.admin`) is read from the resource's own JSON, so
each attribute on the way must be declared a `"record"`; one through an
entity (`owner.dept`) is `QueryUnsupported`.

The filter is exact, errors included, not an approximation to recheck:

- Cedar skips a policy whose condition errors (reading an attribute a
  resource lacks). The SQL is NULL exactly where Cedar's condition would
  error, `&&`, `||` and `if` short-circuit as Cedar's do (`CASE a WHEN TRUE
  ...`, which also keeps each operand once in the text), and each policy
  is `COALESCE(condition, FALSE)`: a forbid that errors does not apply
  either. The result is `(any permit) AND NOT (any forbid)`.
- Types fold statically: `resource is Folder` is false for a `Doc` table,
  and comparing an attribute with a value of another type is false (or
  NULL when the attribute is missing), as in Cedar.
- Operands are still read when their value cannot matter:
  `resource.x in []` and `[].contains(resource.x)` are false only when
  `resource.x` can be read (and, for `in`, is an entity). `resource.a has
  b` is NULL when `a` is missing, so it needs a column for `a` too, of
  type `record` or `entity`; `resource has a.b` (Cedar's `resource has a
  && resource.a has b`) is false there instead.
- `like` is case-sensitive, as Cedar's is: `GLOB` (SQLite's `LIKE`
  ignores case), with every wildcard character in the literal escaped.

The mapping is the application's promise about its table: a column is NULL
exactly when the resource lacks the attribute, holds a value of its declared
type otherwise, an entity column holds ids of one type, and `in` answers
Cedar's `in` (the resource's ancestors, not the resource itself, which the
filter adds). Column names given as strings are trusted SQL text.

What does not compile throws `QueryUnsupported` naming the policy:
arithmetic, extension functions on attributes (`isInRange`, `decimal`
comparisons), one attribute compared with another, attributes without a
column (an entity attribute's own attributes need a column for the dotted
path, `owner.dept`), tags, unlinked slots. Fall back to fetching and
`Authorizer.filter` then. `evaluate(filter, resource)` runs a compiled
filter in JavaScript, for stores without SQL; it sees only the resource's
own attributes, so a filter that reads through an entity-valued attribute
throws `QueryUnsupported` there.

## Durable Objects

Stores take a `SqlDriver`; `durableObjectSql(ctx.storage)` is the one for
a Durable Object's SQLite. Statements run synchronously (`sql.exec`); a
write batch is one `transactionSync` with each statement's row count
checked inside it (a failed guard rolls back), followed by `await
storage.sync()` (`{ sync: false }` to skip). `querySync` reads without a
promise. Durable Object SQLite binds at most 100 parameters per statement;
loads split their uids to fit.

`migrate(driver)` creates the tables (`storeTables(prefix)` gives the DDL).
Statements are `sql` fragments whose interpolations are always `?`
parameters. The stores run for real in `:runtime-test`.

## Routes

```typescript
import { cedarAuthorize, decisionOf } from "@celld/sec/cedar/router";

app.get("/docs/:id", {
  authorize: cedarAuthorize({
    authorizer: (c) => c.env.POLICIES.authorizer(), // or a fixed Authorizer
    principal: (p) => uid("User", p.key),
    action: "read",
    resource: (c) => uid("Doc", c.params.id),
    context: (p) => ({ mfa: p.claims.amr === "mfa" }),
    entities: (p) => [{ uid: uid("User", p.key), parents: p.roles.map((r) => uid("Role", r)) }],
    onDecision: (decision, c) => audit(c.requestId, decision),
  }),
}, (c) => c.json({ reasons: decisionOf(c)?.reasons }));
```

The route answers 403 unless Cedar allows; a callback that throws is a deny
reported to `onDecision`. The router authorizes before it validates path
parameters, so a malformed id reaches `resource` (and is denied). Always map
authenticated owners to entity ids with the router's `principal.key`:
`subject` alone may repeat across schemes, issuers, tenants, and clients.

## Testing policies

```typescript
import { assertCases } from "@celld/sec/cedar/testing";

const report = assertCases(authorizer, [
  { name: "owners edit", principal: alice, action: "edit", resource: plan, entities, expect: "allow", reasons: ["owners"] },
  { name: "strangers do not", principal: bob, action: "edit", resource: plan, entities, expect: "deny" },
]);
report.unused; // policies no case exercised
```

A case fails when the decision differs, when `reasons` differ, when a
policy errored, or when the request was invalid (even for an expected deny,
unless `valid: false`).

## Authoring feedback

`PolicySet.parse`, `Schema.parse`, `validatePolicies` and the stores answer
`Diagnostic`s: Cedar's message, help and code with spans in lines and
columns (Cedar counts UTF-8 bytes; these count characters) and the policy
they are in. `formatDiagnostic(d, source)` renders one against its source
the way a compiler does. `formatPolicies` is Cedar's formatter,
`requestEnvs` says which principal, action and resource types a policy can
apply to, and `Schema` converts between Cedar and JSON syntax.

## Tests

| Target | What it checks |
| --- | --- |
| `:engine-test` | the binding: UTF-8 both ways, rejected input and recursion limits retiring the instance, memory recycling, preparsed sets per instance, a module that is not cedar-wasm |
| `:values-test` | uid syntax and escapes, safe integers, escape keys refused, extension values and Temporal |
| `:policies-test`, `:schema-test` | ids, templates and links, positions in characters, validation with policy ids, `requestEnvs` |
| `:authorizer-test` | decisions, action groups, forbids, invalid requests, erroring policies, links, loaders, preparse eviction and engine resets, partial evaluation |
| `:query-test` | compiled filters against Cedar on every document of a generated set (differential), exact error semantics, the SQL of each filter node, `planQuery` loading the principal |
| `:router-test`, `:testing-test`, `:sql-test` | route decisions, case tables, fragments, the Durable Object driver's transactions and guards against a recording storage |
| `:runtime-test` | under `celld dev`: the policy store (validate on write, links, schema changes, version conflicts), the entity store (closures, cycles), `EntityStore.query` and a hand-mapped table against Cedar row by row on real SQLite, durability across a restart |

Examples: [`examples/`](examples).
