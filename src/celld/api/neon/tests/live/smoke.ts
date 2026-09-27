// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A live smoke test against a real Neon database behind an exe.dev HTTP
 * proxy integration. It only works on an exe.dev VM with the integration
 * attached, so no test target runs it: `buck2 run :live-smoke-run -- <vm>
 * [--integration name]` bundles it, copies it to the VM and runs it there
 * with Deno (`tests/live_smoke.py`).
 *
 * It writes only to tables it creates, named `smoke_<random>_...`, and
 * drops them at the end, even when a check fails.
 *
 * @module
 */

import {
  json,
  NeonClient,
  NeonError,
  raw,
  sql,
  SQLSTATE,
} from "@celld/api/neon";

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail?: unknown;
}

const args = Deno.args;
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const db = new NeonClient({
  integration: flag("integration") ?? "neon-serverless",
});
const checks: Check[] = [];
const prefix = `smoke_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}_`;

function same(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => {
    if (typeof v === "bigint") return `${v}n`;
    if (v instanceof Uint8Array) return `bytes:${[...v].join(",")}`;
    if (
      v !== null && typeof v === "object" && "toString" in v &&
      Object.getPrototypeOf(v)?.constructor?.name?.startsWith("Plain")
    ) return String(v);
    if (v instanceof Temporal.Instant) return `instant:${v.epochNanoseconds}`;
    if (Array.isArray(v)) return v.map(norm);
    if (typeof v === "number" && Number.isNaN(v)) return "NaN";
    if (typeof v === "number" && !Number.isFinite(v)) return String(v);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, norm(x)]),
      );
    }
    return v;
  };
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

async function check(name: string, fn: () => Promise<unknown>): Promise<void> {
  const started = performance.now();
  try {
    const detail = await fn();
    checks.push({
      name,
      ok: true,
      ms: Math.round(performance.now() - started),
      ...(detail === undefined ? {} : { detail }),
    });
  } catch (error) {
    const detail = error instanceof NeonError
      ? { ...error, message: error.message }
      : String(error instanceof Error ? error.stack : error);
    checks.push({
      name,
      ok: false,
      ms: Math.round(performance.now() - started),
      detail,
    });
  }
  const last = checks[checks.length - 1];
  console.error(`${last.ok ? "ok" : "FAIL"} ${name} (${last.ms} ms)`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await check("connects", async () => {
  const row = await db.one<{ one: number; version: string }>(
    sql`SELECT 1 AS one, version() AS version`,
  );
  assert(row.one === 1, "one");
  return row.version;
});

const ROUND_TRIPS: [string, unknown, string?][] = [
  ["int2", 32767],
  ["int4", -2147483648],
  ["int8", 9223372036854775807n],
  ["int8", -9223372036854775808n],
  ["numeric", "123456789012345678901234567890.123456789"],
  ["float8", 1.5],
  ["float8", Number.NaN],
  ["float8", Number.POSITIVE_INFINITY],
  ["bool", true],
  ["bool", false],
  ["text", 'Zoë 🦀 "quoted" \\ back\nslash\ttab'],
  ["text", ""],
  ["bytea", Uint8Array.from({ length: 256 }, (_, i) => i)],
  ["jsonb", json({ a: [1, "two", null, { b: true }], "é": "ü" })],
  ["json", json([1, 2, 3])],
  ["date", Temporal.PlainDate.from("2026-09-27")],
  ["timestamp", Temporal.PlainDateTime.from("2026-09-27T01:02:03.456789")],
  ["timestamptz", Temporal.Instant.from("2026-09-27T01:02:03.456789Z")],
  ["time", Temporal.PlainTime.from("23:59:58.123456")],
  ["uuid", "0b4c6a84-5c2a-4c5f-9d2e-1f0a3e6b7c8d"],
  [
    "interval",
    Temporal.Duration.from({ days: 1, hours: 2, minutes: 3 }),
    "1 day 02:03:00",
  ],
  ["text[]", ["a\nb", 'c"d', "e\\f", "g,h", "{i}", "", null, "NULL", "🦀"]],
  ["int8[]", [[1n, 2n], [3n, null]]],
  ["bool[]", [true, false, null]],
  ["jsonb[]", ['{"k":1}', "[2]"]],
  ["timestamptz[]", [Temporal.Instant.from("2020-01-01T00:00:00Z"), null]],
  ["numeric[]", ["1.10", "-2"]],
];

for (const [type, value, expected] of ROUND_TRIPS) {
  await check(
    `round trip ${type} ${
      JSON.stringify(value, (_, v) => typeof v === "bigint" ? `${v}n` : v)
        ?.slice(0, 40)
    }`,
    async () => {
      const row = await db.one<{ v: unknown }>(
        sql`SELECT ${value}::${raw(type)} AS v`,
      );
      const want = expected ??
        (value instanceof Object && "value" in value && type.startsWith("json")
          ? (value as { value: unknown }).value
          : value);
      const wantParsed = type === "jsonb[]"
        ? (value as string[]).map((s) => JSON.parse(s))
        : want;
      assert(same(row.v, wantParsed), `got ${String(row.v)} (${typeof row.v})`);
    },
  );
}

await check("NULL parameters and results", async () => {
  const row = await db.one(
    sql`SELECT ${null}::text AS a, ${undefined}::int AS b`,
  );
  assert(row.a === null && row.b === null, JSON.stringify(row));
});

await check(
  "duplicate column names: last wins by name, arrays keep both",
  async () => {
    const row = await db.one(sql`SELECT 1 AS a, 2 AS a`);
    const arrays = await db.arrays(sql`SELECT 1 AS a, 2 AS a`);
    assert(
      row.a === 2 && same(arrays.rows[0], [1, 2]),
      JSON.stringify(arrays.rows),
    );
  },
);

await check("syntax errors carry SQLSTATE and position", async () => {
  try {
    await db.query({ text: "SELEC 1" });
  } catch (error) {
    assert(
      error instanceof NeonError && error.kind === "postgres" &&
        error.code === SQLSTATE.syntaxError && error.position === 1,
      JSON.stringify(error),
    );
    return {
      code: error.code,
      position: error.position,
      requestId: error.requestId,
    };
  }
  throw new Error("no error");
});

await check("constraint violations name the constraint", async () => {
  try {
    await db.transaction([
      sql`CREATE TEMP TABLE t (id int CONSTRAINT t_pk PRIMARY KEY, v text NOT NULL)`,
      sql`INSERT INTO t VALUES (1, 'x'), (1, 'y')`,
    ]);
  } catch (error) {
    assert(
      error instanceof NeonError && error.code === SQLSTATE.uniqueViolation &&
        error.constraint === "t_pk",
      JSON.stringify(error),
    );
    return { constraint: error.constraint, detail: error.detail };
  }
  throw new Error("no error");
});

await check("read-only transactions refuse writes", async () => {
  try {
    await db.query(sql`CREATE TEMP TABLE r (x int)`, { readOnly: true });
  } catch (error) {
    assert(
      error instanceof NeonError && error.code === SQLSTATE.readOnlyTransaction,
      JSON.stringify(error),
    );
    return;
  }
  throw new Error("no error");
});

const table = raw(`${prefix}ledger`);
try {
  await check(
    "transactions commit together and roll back together",
    async () => {
      const results = await db.transaction([
        sql`CREATE TABLE ${table} (id int PRIMARY KEY, amount bigint NOT NULL)`,
        sql`INSERT INTO ${table} VALUES (1, 100), (2, 50)`,
        sql`SELECT count(*) AS n FROM ${table}`,
      ], { isolation: "Serializable" });
      assert(
        results[1].command === "INSERT" && results[1].rowCount === 2,
        JSON.stringify(results[1]),
      );
      assert(
        results[2].rows[0].n === 2n,
        `count ${String(results[2].rows[0].n)}`,
      );
      try {
        await db.transaction([
          sql`UPDATE ${table} SET amount = amount - ${75} WHERE id = ${2}`,
          sql`INSERT INTO ${table} VALUES (3, 1 / 0)`,
        ]);
        throw new Error("no error");
      } catch (error) {
        assert(
          error instanceof NeonError && error.code === SQLSTATE.divisionByZero,
          String(error),
        );
      }
      const after = await db.one(
        sql`SELECT amount FROM ${table} WHERE id = ${2}`,
        { readOnly: true },
      );
      assert(
        after.amount === 50n,
        `the failed transaction's update stuck: ${String(after.amount)}`,
      );
    },
  );

  await check("affected rows", async () => {
    const n = await db.execute(
      sql`UPDATE ${table} SET amount = amount + 1 WHERE id = ANY(${[
        1,
        2,
        99,
      ]}::int[])`,
    );
    assert(n === 2, `updated ${n}`);
  });
} finally {
  await db.execute(sql`DROP TABLE IF EXISTS ${table}`).catch(() => {});
}

const failed = checks.filter((c) => !c.ok).length;
console.log(
  JSON.stringify(
    { passed: checks.length - failed, failed, checks },
    (_, v) => typeof v === "bigint" ? `${v}n` : v,
    2,
  ),
);
Deno.exit(failed === 0 ? 0 : 1);
