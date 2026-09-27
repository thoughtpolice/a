// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "@celld/core/assert";
import {
  durableObjectSql,
  raw,
  render,
  sql,
  SqlConflictError,
} from "@celld/sec/cedar/sql";
import { storeTables } from "@celld/sec/cedar/store";

Deno.test("fragments keep values out of the text", () => {
  const evil = "x'); DROP TABLE t; --";
  const f = sql`SELECT * FROM ${
    raw("t")
  } WHERE a = ${evil} AND b IN (${1}, ${true}) AND c IS ${null}`;
  assertEquals(render(f), {
    text: "SELECT * FROM t WHERE a = ? AND b IN (?, ?) AND c IS ?",
    params: [evil, 1, 1, null],
  });
  assertThrows(() => sql`${NaN}`, TypeError);
  assertThrows(() => sql`${{} as never}`, TypeError);
});

Deno.test("the store tables honour a prefix, and only a safe one", () => {
  const texts = storeTables().map((f) => render(f).text);
  assert(
    texts.some((t) => t.includes("attrs TEXT NOT NULL")),
    texts.join("\n"),
  );
  assert(
    storeTables("acme_").every((f) => !render(f).text.includes("cedar_")),
    "prefix",
  );
  assertThrows(() => storeTables("bad; drop"), TypeError);
});

/** A Durable Object storage that records statements and answers from a script. */
function fakeStorage(rowsWritten: number[]) {
  const log: string[] = [];
  const storage = {
    sql: {
      exec(text: string, ...params: unknown[]) {
        log.push(params.length ? `${text} ${JSON.stringify(params)}` : text);
        const written = rowsWritten.shift() ?? 1;
        return { toArray: () => [], rowsWritten: written };
      },
    },
    transactionSync<T>(fn: () => T): T {
      log.push("BEGIN");
      try {
        const result = fn();
        log.push("COMMIT");
        return result;
      } catch (error) {
        log.push("ROLLBACK");
        throw error;
      }
    },
    sync() {
      log.push("SYNC");
      return Promise.resolve();
    },
  };
  return { storage: storage as unknown as DurableObjectStorage, log };
}

Deno.test("a batch is one transaction, synced once it commits", async () => {
  const { storage, log } = fakeStorage([1, 3]);
  const driver = durableObjectSql(storage);
  assertEquals(
    await driver.batch([{ sql: sql`UPDATE a SET x = ${true}`, expect: 1 }, {
      sql: sql`DELETE FROM b`,
    }]),
    [1, 3],
  );
  assertEquals(log, [
    "BEGIN",
    "UPDATE a SET x = ? [1]",
    "DELETE FROM b",
    "COMMIT",
    "SYNC",
  ]);
});

Deno.test("a failed guard rolls the batch back and names the statement", async () => {
  const { storage, log } = fakeStorage([1, 0]);
  const driver = durableObjectSql(storage);
  const error = await assertRejects(
    () =>
      driver.batch([{ sql: sql`INSERT INTO a VALUES (1)` }, {
        sql: sql`UPDATE v SET n = n + 1 WHERE n = ${3}`,
        expect: "some",
      }]),
    SqlConflictError,
  );
  assertEquals([error.statement, error.rows], [1, 0]);
  assertEquals(log.at(-1), "ROLLBACK");
  assert(!log.includes("SYNC"), "nothing to sync");
});

Deno.test("sync can be turned off, and an empty batch does nothing", async () => {
  const { storage, log } = fakeStorage([]);
  const driver = durableObjectSql(storage, { sync: false });
  await driver.batch([{ sql: sql`DELETE FROM a` }]);
  assertEquals(await driver.batch([]), []);
  assertEquals(log, ["BEGIN", "DELETE FROM a", "COMMIT", "BEGIN", "COMMIT"]);
});
