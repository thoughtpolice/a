// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// DB-CALL-004: concurrent copies of one delivery. The store below answers
// both as a KV namespace (an awaited `get`, then an awaited `put`) and as
// the `Delivery` Durable Object (one `claim` that checks and records in a
// single step, as its SQL statements do). A receiver that reads then
// writes lets both copies through; one that claims lets exactly one.
//
// DB-SWP-F10-112: a claim is `claimed` until its work finishes. A copy
// arriving meanwhile is not told `duplicate` (the work may still fail),
// and a claim whose run died (its lease ran out) is run again.

import { assertEquals } from "@celld/core/assert";
import worker, { Delivery } from "./webhook.ts";

const KEY = "whk_SHRO661LOs3XSd9Fz1fEhOTO2O2AmL4jhHg_8yMLGLM";
const WEBHOOK_KEYS = JSON.stringify({
  "b0fce7bf204b297bd8d0b569b3b648f8fefaf84625afc2746ab7aa34e602c887": {
    subject: "billing",
    scopes: ["hooks:deliver"],
  },
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

interface Row {
  record: string;
  state: "claimed" | "done";
  leaseUntil: number;
  lease: string;
}

/**
 * One store, with a KV view and a Durable Object view. The first
 * `together` claims wait for each other before any is decided, so copies
 * sent at once really do race at the claim, however the runtime schedules
 * the work before it (under load, one copy could otherwise finish before
 * another reaches its claim, and be a duplicate instead of a race).
 */
function store(together = 1) {
  const records = new Map<string, Row>();
  const kv = new Map<string, string>();
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => open = resolve);
  const meet = async () => {
    if (++arrived >= together) open();
    if (arrived <= together) await gate;
  };
  return {
    records,
    async get(key: string) {
      await tick();
      return kv.get(key) ?? null;
    },
    async put(key: string, value: string) {
      await tick();
      kv.set(key, value);
    },
    getByName(_name: string) {
      return {
        async claim(id: string, record: string, lease: string) {
          await meet();
          await tick();
          const now = Date.now();
          const row = records.get(id);
          if (
            row === undefined ||
            (row.state === "claimed" && row.leaseUntil <= now)
          ) {
            records.set(id, {
              record,
              state: "claimed",
              leaseUntil: now + 300_000,
              lease,
            });
            return "run";
          }
          return row.state === "done" ? "done" : "running";
        },
        async finish(id: string, lease: string) {
          await tick();
          const row = records.get(id);
          if (row?.state !== "claimed" || row.lease !== lease) return false;
          row.state = "done";
          return true;
        },
        async release(id: string, lease: string) {
          await tick();
          const row = records.get(id);
          if (row?.state === "claimed" && row.lease === lease) {
            records.delete(id);
          }
        },
        async record(id: string) {
          await tick();
          return records.get(id)?.record ?? null;
        },
      };
    },
  };
}

function sender(deliveries: ReturnType<typeof store>) {
  const env = {
    IDENTITY_SECRET: "example-only-identity-secret-0123456789abcdef",
    WEBHOOK_KEYS,
    SENDER_CIDRS: "192.0.2.0/24",
    TRUSTED_PROXIES: "10.0.0.0/8",
    DELIVERIES: deliveries,
  };
  return () =>
    worker.fetch(
      new Request("http://127.0.0.1/deliveries", {
        method: "POST",
        headers: {
          "x-webhook-key": KEY,
          "cf-connecting-ip": "192.0.2.10",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id: "evt_race",
          event: "invoice.paid",
          data: { amount: 1 },
        }),
      }),
      env as never,
      {
        waitUntil: () => {},
        passThroughOnException: () => {},
      } as unknown as ExecutionContext,
    );
}

Deno.test("of concurrent copies of one delivery, exactly one is accepted", async () => {
  const deliveries = store(3);
  const send = sender(deliveries);
  const answers = await Promise.all([send(), send(), send()]);
  const bodies = await Promise.all(answers.map((answer) => answer.json()));
  // The copies that lost the claim while it ran are told to retry (409),
  // not `duplicate`: the run they lost to had not finished.
  assertEquals(
    answers.map((answer) => answer.status).sort(),
    [202, 409, 409],
  );
  assertEquals(
    bodies.filter((body) => body.accepted === true).length,
    1,
    "one copy ran",
  );
  assertEquals(deliveries.records.size, 1);
  // Once it finished, a copy is a duplicate.
  const late = await send();
  assertEquals([late.status, (await late.json()).duplicate], [200, true]);
});

Deno.test("DB-SWP-F10-112: a claim whose run died is run again, not a duplicate", async () => {
  const deliveries = store();
  deliveries.records.set("evt_race", {
    record: "{}",
    state: "claimed",
    leaseUntil: Date.now() - 1,
    lease: "dead-run",
  });
  const answer = await sender(deliveries)();
  assertEquals(answer.status, 202);
  assertEquals((await answer.json()).accepted, true);
  assertEquals(deliveries.records.get("evt_race")?.state, "done");
});

type Value = string | number;
type Table = Map<string, Record<string, Value>>;

/**
 * A single-table SQL for the statements `Delivery` runs: INSERT OR
 * IGNORE, UPDATE ... SET ... WHERE, SELECT ... WHERE, DELETE [WHERE], with
 * conditions `col = ?`, `col = 'text'` and `col <= ?` joined by AND. It
 * evaluates the statement text as given, so a condition missing from
 * `webhook.ts`'s SQL is missing here too. The key is `id`.
 */
function fakeSql(table: Table) {
  const value = (token: string, args: Value[]): Value =>
    token === "?" ? args.shift()! : token.replace(/^'(.*)'$/, "$1");
  const where = (text: string | undefined, args: Value[]) => {
    const conditions = (text ?? "").split(/\s+AND\s+/i).filter((c) => c)
      .map((condition) => {
        const [, column, op, token] = /^(\w+)\s*(<=|=)\s*(\?|'[^']*')$/
          .exec(condition.trim())!;
        return { column, op, want: value(token, args) };
      });
    return (row: Record<string, Value>) =>
      conditions.every(({ column, op, want }) =>
        op === "=" ? row[column] === want : row[column] <= want
      );
  };
  return {
    exec(query: string, ...bindings: Value[]) {
      const args = [...bindings];
      const q = query.trim();
      let written = 0;
      let rows: Record<string, Value>[] = [];
      let m: RegExpExecArray | null;
      if (/^CREATE/i.test(q)) {
        // The table is the Map.
      } else if (
        (m = /^INSERT OR IGNORE INTO \w+ \(([^)]*)\) VALUES \(([^)]*)\)$/i
          .exec(q))
      ) {
        const columns = m[1].split(",").map((c) => c.trim());
        const values = m[2].split(",").map((t) => value(t.trim(), args));
        const row = Object.fromEntries(columns.map((c, i) => [c, values[i]]));
        if (!table.has(String(row.id))) {
          table.set(String(row.id), row);
          written = 1;
        }
      } else if ((m = /^UPDATE \w+ SET (.*?) WHERE (.*)$/i.exec(q))) {
        const sets = m[1].split(",").map((part) => {
          const [column, token] = part.split("=").map((t) => t.trim());
          return [column, value(token, args)] as const;
        });
        const match = where(m[2], args);
        for (const row of table.values()) {
          if (match(row)) {
            for (const [column, v] of sets) row[column] = v;
            written++;
          }
        }
      } else if ((m = /^SELECT (\w+) FROM \w+ WHERE (.*)$/i.exec(q))) {
        const column = m[1];
        const match = where(m[2], args);
        rows = [...table.values()].filter(match).map((row) => ({
          [column]: row[column],
        }));
      } else if ((m = /^DELETE FROM \w+(?: WHERE (.*))?$/i.exec(q))) {
        const match = where(m[1], args);
        for (const [key, row] of [...table]) {
          if (match(row)) {
            table.delete(key);
            written++;
          }
        }
      } else {
        throw new Error(`the fake SQL does not know: ${q}`);
      }
      return { rowsWritten: written, toArray: () => rows };
    },
  };
}

/** The `Delivery` Durable Object itself, over {@link fakeSql}. */
function delivery(): Delivery {
  const sql = fakeSql(new Map());
  const ctx = { storage: { sql, setAlarm: () => Promise.resolve() } };
  return new Delivery(ctx as never, {} as never);
}

// DB-REV-RTR-9: `finish` and `release` are fenced by the claimant's lease
// token, so a run that outlived its lease cannot undo or complete the run
// that took its claim over.
Deno.test("a stale run's release or finish does not touch the claim that took over", async () => {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    const object = delivery();
    assertEquals(await object.claim("evt", "{}", "lease-a"), "run");
    assertEquals(await object.claim("evt", "{}", "lease-x"), "running");
    // A's run outlives its lease; B takes the claim over.
    clock += 5 * 60 * 1000;
    assertEquals(await object.claim("evt", "{}", "lease-b"), "run");
    // A fails late: its release must not delete B's live claim.
    await object.release("evt", "lease-a");
    assertEquals(await object.claim("evt", "{}", "lease-c"), "running");
    // A finishes late: it cannot mark B's work done.
    assertEquals(await object.finish("evt", "lease-a"), false);
    assertEquals(await object.claim("evt", "{}", "lease-c"), "running");
    // B's own finish counts.
    assertEquals(await object.finish("evt", "lease-b"), true);
    assertEquals(await object.claim("evt", "{}", "lease-c"), "done");
    // And B's own release, on another delivery, frees it for a retry.
    assertEquals(await object.claim("evt2", "{}", "lease-d"), "run");
    await object.release("evt2", "lease-d");
    assertEquals(await object.claim("evt2", "{}", "lease-e"), "run");
  } finally {
    Date.now = realNow;
  }
});
