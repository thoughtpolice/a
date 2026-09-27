<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/api/neon

[Neon](https://neon.tech)'s serverless Postgres from celld, over its
SQL-over-HTTPS endpoint (`POST /sql`): through an exe.dev HTTP proxy
integration that holds the connection string, or straight to Neon with one.

```python
celld.library(
    name = "app",
    srcs = glob(["src/*.ts"]),
    import_name = "@example/app",
    deps = ["root//src/celld/api/neon:neon"],
)
```

| Import                       | Target          | What it has                                                                 |
| ---------------------------- | --------------- | --------------------------------------------------------------------------- |
| `@celld/api/neon`            | `:neon`         | `NeonClient`, `sql`, `ident`, `raw`, `json`, `NeonError`, `SQLSTATE`, `OID` |
| `@celld/api/neon/testing`    | `:neon`         | `FakeNeon`, `FakePgError`, `resultOf`                                       |
| `@celld/api/neon/reflection` | `:reflection`   | `neonFromReflection`, `chooseNeonIntegration`                               |

## The integration

The VM (and celld Workers on it) never hold the password. An exe.dev HTTP
proxy integration injects Neon's `Neon-Connection-String` header:

```
exe.dev ▶ integrations add http-proxy --name neon-serverless \
  --target https://api.c-6.us-east-2.aws.neon.tech \
  --header 'Neon-Connection-String:postgresql://neondb_owner:<password>@ep-....c-6.us-east-2.aws.neon.tech/neondb?sslmode=require' \
  --attach tag:neon
```

The target is `https://api.<the endpoint host after its first label>` (what
Neon's own driver calls; the endpoint's own host answers too), and the
connection string's host picks the database. `new NeonClient()` then talks
to `https://neon-serverless.int.exe.xyz/sql`; `integration` names another,
and `neonFromReflection()` finds it through exe.dev's reflection service.
Outside exe.dev, `new NeonClient({ connectionString })` sends the header
itself to Neon's `api.` host.

Neon's other serverless protocol, Postgres over WebSockets, cannot go
through a header-injecting proxy: the password travels inside the Postgres
stream. exe.dev's `wire` database integrations (`db:neon`) broker that
protocol on `<name>.int.exe.xyz:5432`; this library does not speak it.

## Queries

```typescript
import { NeonClient, sql } from "@celld/api/neon";

const db = new NeonClient();
const docs = await db.rows(sql`SELECT id, title FROM docs WHERE owner = ${owner} AND tags && ${tags} LIMIT ${50}`);
const doc = await db.maybeOne(sql`SELECT * FROM docs WHERE id = ${id}`, { readOnly: true });
const changed = await db.execute(sql`UPDATE docs SET title = ${title} WHERE id = ${id}`);
```

- **Interpolations are parameters** (`$1`, `$2`, ...), never text. A `sql`
  query interpolated into another is spliced in and renumbered; `ident`
  quotes a name and `raw` inserts trusted text.
- **One statement per request.** Neon runs each as a prepared statement,
  so `SELECT 1; SELECT 2` is a syntax error; send several as a transaction.
- **No sessions.** Nothing outlives a request: not temporary tables, not
  `SET`, not prepared statements.

`query` answers `{ rows, fields, command, rowCount }` with rows by column
name (with two columns of one name, the last wins); `arrays` keeps rows as
arrays in column order. `rows`, `one`, `maybeOne` and `execute` are the
usual shortcuts.

### Values

The client asks for raw text output and array rows, then parses each value
by its column's type OID, so nothing is lost to JSON:

| Postgres                                  | JavaScript (default)                                        |
| ----------------------------------------- | ----------------------------------------------------------- |
| `int2`, `int4`, `oid`, `float4`, `float8` | `number` (`NaN`, `±Infinity` included)                      |
| `int8`                                    | `bigint` (`types.int8`: `"string"` or `"number"`)           |
| `numeric`                                 | exact `string` (`types.numeric: "number"` to round)         |
| `bool`, `json`, `jsonb`, `bytea`          | `boolean`, parsed JSON, `Uint8Array`                        |
| `date`, `timestamp`, `timestamptz`, `time` | `Temporal.PlainDate`, `PlainDateTime`, `Instant`, `PlainTime` |
| arrays of those, and of text types        | nested arrays, `null` for `NULL`                            |
| anything else (`interval`, `uuid`, ...)   | the text Postgres printed                                   |

`infinity`, `-infinity` and BC dates stay strings. `types.parsers` adds
parsers by OID (an enum's, a domain's).

Parameters are encoded to text here: `bigint`, `Date` and `Temporal`
values, `Uint8Array` (as `bytea` hex), plain objects (as JSON) and arrays
(as Postgres array literals). Neon's own conversion of JSON arrays escapes
strings the JSON way, which Postgres reads differently (an element
`"a\nb"` arrives as `anb`), so arrays never reach it as JSON. Wrap an array
meant for a `json`/`jsonb` parameter in `json(...)`.

### Transactions

```typescript
await db.transaction([
  sql`UPDATE accounts SET balance = balance - ${amount} WHERE id = ${from}`,
  sql`UPDATE accounts SET balance = balance + ${amount} WHERE id = ${to}`,
], { isolation: "Serializable", retryConflicts: 3 });
```

A transaction is sent whole and committed after its last statement; any
error rolls all of it back. It cannot wait on JavaScript between
statements, so a read-then-decide-then-write belongs in SQL (a conditional
`UPDATE ... WHERE version = $n`, a `WITH` chain) or in a Durable Object.
`isolation`, `readOnly` and `deferrable` set the transaction's mode.
`retryConflicts` runs it again after a serialization failure or deadlock,
which is safe: Postgres rolled it back.

### Errors and retries

A Postgres error is a `NeonError` of kind `postgres` with every field
Postgres reports (`code` is the SQLSTATE, plus `constraint`, `table`,
`column`, `detail`, `hint`, 1-based `position`, ...); `hasSqlState(error,
SQLSTATE.uniqueViolation)` tests for one. Other kinds are `http`,
`too-large` (past `maxResponseBytes`, 16 MiB by default, or Neon's own
10 MB limit), `timeout`, `network` and `response`; each carries Neon's
`requestId` when there was a response.

A request is retried (lost connection, timeout, 502/503/504) only when it
is idempotent: `readOnly` (sent as a read-only transaction, which Postgres
enforces) or declared `idempotent`. A write whose answer was lost may have
run, so it is not sent again. Neon's `neon:retryable` flag is kept as
`neonRetryable` but not acted on: Neon sets it on a malformed request
header too.

## Live smoke test

Nothing in the build graph runs Postgres, so the client is checked against
`FakeNeon` by the tests and against a real database by hand:

```
buck2 run root//src/celld/api/neon:live-smoke-run -- pegasus-how.exe.xyz --integration neon-serverless
```

It bundles `tests/live/smoke.ts`, copies it to the VM with a pinned Deno,
and runs it there. It round-trips every type above
(arrays with quotes, backslashes, commas, braces, newlines and `NULL`s;
`int8` at both ends; 256 bytes of `bytea`), checks error fields, commit and
rollback, read-only transactions and affected rows. It creates only a
`smoke_<random>_ledger` table and drops it at the end. Verified 2026-09-27
against Neon (Postgres 18.6) through pegasus-how: 35 of 35.

## Tests

| Target | What it checks |
| --- | --- |
| `:codec-test` | parameter encoding (array literals, bytea, JSON, Temporal), array and value parsing by OID, timestamptz offsets, the `sql` tag |
| `:client-test` | endpoints and their checks, headers, row parsing, Postgres error fields, retries only for idempotent requests, read-only as a transaction, transactions and conflict retries, size limits, timeouts |
| `:reflection-test` | reflection discovery: choosing the integration, trusting a help line's host only when it names it |
