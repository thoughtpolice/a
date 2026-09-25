// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  durableRecordStore,
  durableReplayStore,
  OAuthRecords,
  RECORD_SQL,
  type RecordStoreApi,
} from "@celld/oauth/durable";
import { authorize, body, oauthError, post, redeem, world } from "./fixture.ts";

interface Row {
  value: string;
  version: number;
  expires_at: number | null;
}

/**
 * Durable Object storage for exactly the statements `OAuthRecords` runs,
 * with a transaction-free SQLite's semantics: each statement applies at
 * once. It counts `sync()` calls and keeps the alarm.
 */
class FakeStorage {
  readonly rows = new Map<string, Row>();
  alarm: number | null = null;
  syncs = 0;
  readonly statements: string[] = [];
  readonly sql = {
    exec: (query: string, ...binds: unknown[]) => {
      this.statements.push(query);
      const rows = this.#run(query, binds);
      return { toArray: () => rows, one: () => rows[0] };
    },
  };

  #run(query: string, binds: unknown[]): Record<string, unknown>[] {
    switch (query) {
      case RECORD_SQL.table:
      case RECORD_SQL.index:
        return [];
      case RECORD_SQL.select: {
        const row = this.rows.get(binds[0] as string);
        return row === undefined ? [] : [{ ...row }];
      }
      case RECORD_SQL.upsert:
        this.rows.set(binds[0] as string, {
          value: binds[1] as string,
          version: binds[2] as number,
          expires_at: binds[3] as number | null,
        });
        return [];
      case RECORD_SQL.remove:
        this.rows.delete(binds[0] as string);
        return [];
      case RECORD_SQL.purge:
        for (const [key, row] of this.rows) {
          if (
            row.expires_at !== null && row.expires_at <= (binds[0] as number)
          ) {
            this.rows.delete(key);
          }
        }
        return [];
      case RECORD_SQL.next: {
        const times = [...this.rows.values()]
          .map((row) => row.expires_at)
          .filter((at): at is number => at !== null);
        return [{ next: times.length === 0 ? null : Math.min(...times) }];
      }
      default:
        throw new Error(`unexpected statement ${query}`);
    }
  }

  sync(): Promise<void> {
    this.syncs++;
    return Promise.resolve();
  }

  getAlarm(): Promise<number | null> {
    return Promise.resolve(this.alarm);
  }

  setAlarm(at: number): Promise<void> {
    this.alarm = at;
    return Promise.resolve();
  }
}

function object(
  storage = new FakeStorage(),
): { records: OAuthRecords; storage: FakeStorage } {
  const records = new OAuthRecords(
    { storage } as unknown as DurableObjectState,
    {},
  );
  return { records, storage };
}

/** A namespace whose objects live in this process, one per name. */
function namespace(): {
  readonly ns: DurableObjectNamespace<RecordStoreApi>;
  readonly objects: Map<
    string,
    { records: OAuthRecords; storage: FakeStorage }
  >;
} {
  const objects = new Map<
    string,
    { records: OAuthRecords; storage: FakeStorage }
  >();
  const ns = {
    getByName(name: string) {
      let found = objects.get(name);
      if (found === undefined) {
        found = object();
        objects.set(name, found);
      }
      const records = found.records;
      // A stub answers every method asynchronously, after cloning.
      return new Proxy({}, {
        get: (_target, method: string) => async (...args: unknown[]) => {
          const result = await (records as unknown as Record<
            string,
            (...a: unknown[]) => unknown
          >)[method](
            ...structuredClone(args),
          );
          return structuredClone(result);
        },
      });
    },
  };
  return {
    ns: ns as unknown as DurableObjectNamespace<RecordStoreApi>,
    objects,
  };
}

Deno.test("OAuthRecords: versions, create, swap, and a sync before every answer", async () => {
  const { records, storage } = object();
  assertEquals(records.read("a"), null);
  assert(await records.create("a", { n: 1 }, null), "created");
  assert(!(await records.create("a", { n: 2 }, null)), "not twice");
  assertEquals(records.read("a"), {
    value: { n: 1 },
    version: 1,
    expiresAt: null,
  });
  assert(!(await records.swap("a", 2, { n: 3 }, null)), "a stale version");
  assert(await records.swap("a", 1, { n: 3 }, null), "the current version");
  assertEquals(records.read("a")?.version, 2);
  await records.write("a", { n: 4 }, null);
  assertEquals(records.read("a"), {
    value: { n: 4 },
    version: 3,
    expiresAt: null,
  });
  assert(await records.swap("a", 3, null, null), "a swap to null deletes");
  assertEquals(records.read("a"), null);
  await records.write("b", 1, null);
  await records.remove("b");
  assertEquals(records.read("b"), null);
  assertEquals(storage.syncs, 6);
});

Deno.test("OAuthRecords: expired records read as absent; the alarm sweeps them", async () => {
  const { records, storage } = object();
  const now = Date.now();
  await records.write("old", 1, now - 1);
  assertEquals(records.read("old"), null);
  assert(
    await records.create("old", 2, null),
    "an expired key can be created again",
  );
  await records.write("soon", 1, now + 1000);
  await records.write("later", 1, now + 3_600_000);
  assert(storage.alarm !== null, "an alarm is set");
  assert(storage.alarm! >= now + 60_000, "no sooner than a minute");
  storage.rows.get("soon")!.expires_at = now - 1;
  await records.alarm();
  assertEquals(storage.rows.has("soon"), false);
  assertEquals(storage.rows.has("later"), true);
  assertEquals(storage.alarm, now + 3_600_000);
  await records.remove("later");
  await records.alarm();
  assertEquals(
    storage.alarm,
    now + 3_600_000,
    "a sweep with nothing left schedules nothing new",
  );
});

Deno.test("durableRecordStore: keys spread over shards, each key on one object", async () => {
  const { ns, objects } = namespace();
  const store = durableRecordStore(ns, { shards: 4, name: "t" });
  for (let i = 0; i < 40; i++) await store.put(`k${i}`, i, null);
  assert(objects.size > 1 && objects.size <= 4, `used ${objects.size} objects`);
  for (const name of objects.keys()) assert(/^t:[0-3]$/.test(name), name);
  for (let i = 0; i < 40; i++) {
    assertEquals((await store.get(`k${i}`))?.value, i);
  }
  const record = (await store.get<number>("k1"))!;
  assert(await store.swap("k1", record.version, 100, null), "swap");
  assertEquals((await store.get("k1"))?.value, 100);
  await store.delete("k1");
  assertEquals(await store.get("k1"), null);
  const replay = durableReplayStore(ns, { shards: 4, name: "t" });
  assert(await replay.claim("jti-1", Date.now() + 60_000), "first");
  assert(!(await replay.claim("jti-1", Date.now() + 60_000)), "replayed");
  let threw = false;
  try {
    durableRecordStore(ns, { shards: 0 });
  } catch {
    threw = true;
  }
  assert(threw, "shards must be positive");
});

Deno.test("the authorization server over Durable Object storage", async () => {
  const { ns, objects } = namespace();
  const w = await world({ store: durableRecordStore(ns), now: Date.now });
  const authorized = await authorize(w, "public-app");
  const first = await body(await redeem(w, authorized));
  assert(typeof first.refresh_token === "string", "tokens");
  await oauthError(await redeem(w, authorized), 400, "invalid_grant");
  const token = w.server.endpoint("token");
  const refresh = (value: string) =>
    w.handle(
      post(token, {
        grant_type: "refresh_token",
        refresh_token: value,
        client_id: "public-app",
      }),
    );
  await oauthError(
    await refresh(first.refresh_token as string),
    400,
    "invalid_grant",
  );
  const fresh = await body(await redeem(w, await authorize(w, "public-app")));
  const rotated = await body(await refresh(fresh.refresh_token as string));
  await oauthError(
    await refresh(fresh.refresh_token as string),
    400,
    "invalid_grant",
  );
  await oauthError(
    await refresh(rotated.refresh_token as string),
    400,
    "invalid_grant",
  );
  const stored = [...objects.values()].flatMap((
    { storage },
  ) => [...storage.rows.values()]);
  const text = JSON.stringify(stored);
  assert(
    !text.includes(fresh.refresh_token as string),
    "refresh tokens are stored hashed",
  );
  assert(!text.includes(authorized.code!), "codes are stored hashed");
});
