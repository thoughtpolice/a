// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "@celld/core/assert";
import {
  endpointOrigin,
  isTransientConflict,
  NeonClient,
  NeonError,
  OID,
  sql,
  SQLSTATE,
} from "@celld/api/neon";
import { FakeNeon, FakePgError, resultOf } from "@celld/api/neon/testing";
import type { Runtime } from "@celld/http";

/** Time that never waits. */
const instant: Runtime = {
  now: () => 0,
  random: () => 0,
  sleep: () => Promise.resolve(),
  setTimer: () => () => {},
};

Deno.test("endpoints: the integration by default, Neon's api host for a connection string", () => {
  assertEquals(endpointOrigin({}), "https://neon-serverless.int.exe.xyz");
  assertEquals(endpointOrigin({ integration: "db" }), "https://db.int.exe.xyz");
  assertEquals(
    endpointOrigin({
      connectionString:
        "postgresql://u:p@ep-raspy-block-b479aa0d-pooler.c-6.us-east-2.aws.neon.tech/neondb",
    }),
    "https://api.c-6.us-east-2.aws.neon.tech",
  );
  assertThrows(
    () => endpointOrigin({ baseUrl: "http://db.example.com" }),
    TypeError,
    "https",
  );
  assertThrows(
    () => endpointOrigin({ baseUrl: "https://u:p@db.example.com" }),
    TypeError,
    "credentials",
  );
  assertThrows(
    () => endpointOrigin({ baseUrl: "https://db.example.com/sql" }),
    TypeError,
    "path",
  );
  assertEquals(
    endpointOrigin({
      baseUrl: "http://127.0.0.1:8080",
      allowLoopbackForDevelopment: true,
    }),
    "http://127.0.0.1:8080",
  );
  assertThrows(() => endpointOrigin({ integration: "../x" }), TypeError);
});

Deno.test("a query sends raw text, array mode and encoded parameters, and parses rows", async () => {
  const fake = new FakeNeon(() =>
    resultOf([["id", OID.int8], ["tags", OID._text], ["n", OID.int4]], [[
      "9007199254740993",
      '{"a\\"b",NULL}',
      null,
    ]])
  );
  const db = new NeonClient({ fetch: fake.fetch });
  const result = await db.query(
    sql`SELECT ${[1n, 2n]}::int8[] AS x WHERE y = ${"z"}`,
  );
  assertEquals(result.rows, [{
    id: 9007199254740993n,
    tags: ['a"b', null],
    n: null,
  }]);
  assertEquals(result.command, "SELECT");
  const call = fake.calls[0];
  assertEquals(call.query, "SELECT $1::int8[] AS x WHERE y = $2");
  assertEquals(call.params, ['{"1","2"}', "z"]);
  assertEquals(call.headers["neon-raw-text-output"], "true");
  assertEquals(call.headers["neon-array-mode"], "true");
  assertEquals(call.headers["neon-connection-string"], undefined);
});

Deno.test("a connection string travels as the header, and only then", async () => {
  const fake = new FakeNeon(() => resultOf([], []));
  const connectionString =
    "postgresql://u:secret@ep-x.c-6.us-east-2.aws.neon.tech/db";
  await new NeonClient({ fetch: fake.fetch, connectionString }).execute({
    text: "SELECT 1",
  });
  assertEquals(
    fake.calls[0].headers["neon-connection-string"],
    connectionString,
  );
});

Deno.test("Postgres errors keep their fields; nothing is retried for a write", async () => {
  const fake = new FakeNeon(() => {
    throw new FakePgError(SQLSTATE.uniqueViolation, "duplicate key", {
      constraint: "t_pk",
      position: "3",
    });
  });
  const db = new NeonClient({ fetch: fake.fetch, runtime: instant });
  const error = await assertRejects(
    () => db.query(sql`INSERT INTO t VALUES (1)`),
    NeonError,
    "duplicate key",
  );
  assertEquals([
    error.kind,
    error.code,
    error.constraint,
    error.position,
    error.status,
  ], ["postgres", "23505", "t_pk", 3, 400]);
  assertEquals(fake.calls.length, 1);
});

Deno.test("a lost connection is retried only when the request is idempotent", async () => {
  let attempts = 0;
  const flaky = (input: string | URL | Request, init?: RequestInit) => {
    attempts++;
    if (attempts < 3) return Promise.reject(new TypeError("connection reset"));
    return new FakeNeon(() => resultOf([["one", OID.int4]], [["1"]])).fetch(
      input,
      init,
    );
  };
  const db = new NeonClient({ fetch: flaky, runtime: instant });
  const write = await assertRejects(
    () => db.execute(sql`UPDATE t SET x = 1`),
    NeonError,
    "may have run",
  );
  assertEquals([write.kind, attempts], ["network", 1]);
  attempts = 0;
  assertEquals(await db.one(sql`SELECT 1 AS one`, { readOnly: true }), {
    one: 1,
  });
  assertEquals(attempts, 3);
  attempts = 0;
  assertEquals(
    (await db.query(sql`SELECT 1 AS one`, { idempotent: true })).rows,
    [{ one: 1 }],
  );
  assertEquals(attempts, 3);
});

Deno.test("read-only queries go as a read-only transaction", async () => {
  const fake = new FakeNeon(() => resultOf([["one", OID.int4]], [["1"]]));
  await new NeonClient({ fetch: fake.fetch }).rows(sql`SELECT 1 AS one`, {
    readOnly: true,
  });
  assertEquals(fake.calls[0].batchIndex, 0);
  assertEquals(fake.calls[0].headers["neon-batch-read-only"], "true");
});

Deno.test("transactions: headers, results in order, and conflict retries", async () => {
  let failures = 1;
  const fake = new FakeNeon((call) => {
    if (call.batchIndex === 1 && failures-- > 0) {
      throw new FakePgError(
        SQLSTATE.serializationFailure,
        "could not serialize",
      );
    }
    return resultOf([["i", OID.int4]], [[String(call.batchIndex)]]);
  });
  const db = new NeonClient({ fetch: fake.fetch, runtime: instant });
  const results = await db.transaction([sql`SELECT 0`, sql`SELECT 1`], {
    isolation: "Serializable",
    deferrable: true,
    retryConflicts: 2,
  });
  assertEquals(results.map((r) => r.rows[0].i), [0, 1]);
  assertEquals(
    fake.calls[0].headers["neon-batch-isolation-level"],
    "Serializable",
  );
  assertEquals(fake.calls[0].headers["neon-batch-deferrable"], "true");
  assertEquals(fake.calls.length, 4);
  const conflict = await assertRejects(() =>
    new NeonClient({
      fetch: new FakeNeon(() => {
        throw new FakePgError(SQLSTATE.serializationFailure, "no");
      }).fetch,
    }).transaction([sql`SELECT 1`])
  );
  assert(isTransientConflict(conflict), String(conflict));
  await assertRejects(
    () => db.transaction([sql`SELECT 1`], { isolation: "Chaos" as never }),
    TypeError,
  );
  assertEquals(await db.transaction([]), []);
});

Deno.test("responses past the limit, non-JSON bodies and HTTP errors", async () => {
  const big = () => Promise.resolve(new Response("x".repeat(2048)));
  await assertRejects(
    () =>
      new NeonClient({ fetch: big, maxResponseBytes: 1024 }).query({
        text: "SELECT 1",
      }),
    NeonError,
    "larger than 1024",
  );
  const garbage = () => Promise.resolve(new Response("<html>"));
  const notJson = await assertRejects(
    () => new NeonClient({ fetch: garbage }).query({ text: "SELECT 1" }),
    NeonError,
  );
  assertEquals(notJson.kind, "response");
  const gateway = () =>
    Promise.resolve(
      new Response("bad gateway", {
        status: 502,
        headers: { "neon-request-id": "r1" },
      }),
    );
  const http = await assertRejects(
    () =>
      new NeonClient({ fetch: gateway, runtime: instant }).query({
        text: "SELECT 1",
      }, { idempotent: true }),
    NeonError,
  );
  assertEquals([http.kind, http.status, http.requestId], ["http", 502, "r1"]);
  const tooLarge = () =>
    Promise.resolve(
      Response.json({
        message: "response is too large (max is 10485760 bytes)",
      }, { status: 507 }),
    );
  assertEquals(
    (await assertRejects(
      () => new NeonClient({ fetch: tooLarge }).query({ text: "SELECT 1" }),
      NeonError,
    )).kind,
    "too-large",
  );
});

Deno.test("a timeout aborts the attempt and says the statement may have run", async () => {
  let fire = () => {};
  const runtime: Runtime = {
    ...instant,
    setTimer: (_ms, callback) => (fire = callback, () => {}),
  };
  const hang = (_: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init!.signal!.addEventListener(
        "abort",
        () => reject(init!.signal!.reason),
      );
      queueMicrotask(() => fire());
    });
  const error = await assertRejects(
    () =>
      new NeonClient({ fetch: hang, runtime }).execute(sql`UPDATE t SET x = 1`),
    NeonError,
  );
  assertEquals(error.kind, "timeout");
});

Deno.test("one and maybeOne check the row count", async () => {
  const two = new FakeNeon(() => resultOf([["x", OID.int4]], [["1"], ["2"]]));
  const db = new NeonClient({ fetch: two.fetch });
  await assertRejects(() => db.one(sql`SELECT x`), NeonError, "one row");
  await assertRejects(
    () => db.maybeOne(sql`SELECT x`),
    NeonError,
    "at most one",
  );
  const none = new NeonClient({
    fetch: new FakeNeon(() => resultOf([["x", OID.int4]], [])).fetch,
  });
  assertEquals(await none.maybeOne(sql`SELECT x`), null);
});
