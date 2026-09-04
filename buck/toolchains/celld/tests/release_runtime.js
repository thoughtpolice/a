// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Platform behaviour that `types/celld.d.ts` encodes, checked against the
 * pinned binary; AGENTS.md names the upstream issue behind each fixed bug. Each scenario returns plain JSON; `runtime_test.py` pins
 * the values. The declarations follow these results, so a release that changes
 * one of them fails here before an application meets it.
 */
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

/** Captures a rejection as data, keeping unexpected successes visible. */
async function outcome(operation) {
  try {
    return { value: await operation() };
  } catch (error) {
    return { error: { name: error.name, message: error.message } };
  }
}

/** A child object started from `ctx.exports`, with no binding or migration. */
export class Child extends DurableObject {
  increment() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS hits (n INTEGER NOT NULL)",
    );
    this.ctx.storage.sql.exec("INSERT INTO hits (n) VALUES (1)");
    return this.ctx.storage.sql.exec("SELECT count(*) AS n FROM hits").one().n;
  }

  /** What the facet sees of its startup options. */
  identity() {
    const id = this.ctx.id;
    return {
      kind: typeof id,
      text: String(id),
      name: typeof id === "string" ? null : id.name ?? null,
      props: this.ctx.props === undefined ? "undefined" : this.ctx.props,
    };
  }
}

/** A named entrypoint, to show `ctx.exports` holds more than `default`. */
export class Named extends WorkerEntrypoint {
  ping() {
    return "pong";
  }
}

/** Bound, SQLite-backed root object for storage and facet scenarios. */
export class Root extends DurableObject {
  transactions() {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS t (v TEXT NOT NULL)");
    let callbackArguments = -1;
    this.ctx.storage.transactionSync((...args) => {
      callbackArguments = args.length;
      sql.exec("INSERT INTO t (v) VALUES ('outer')");
      try {
        // #226: a nested transaction through the root handle is a savepoint.
        this.ctx.storage.transactionSync(() => {
          sql.exec("INSERT INTO t (v) VALUES ('inner')");
          throw new Error("discard inner");
        });
      } catch {
        // The outer transaction continues without the inner write.
      }
    });
    const rows = sql.exec("SELECT v FROM t ORDER BY rowid").toArray();
    return { callbackArguments, rows: rows.map((row) => row.v) };
  }

  invalidText() {
    // X'FF' is not UTF-8; it decodes as U+FFFD instead of throwing.
    return this.ctx.storage.sql
      .exec("SELECT CAST(X'FF61' AS TEXT) AS v")
      .one().v;
  }

  async facet() {
    const exported = this.ctx.exports.Child;
    const stub = this.ctx.facets.get("child", () => ({ class: exported }));
    return [await stub.increment(), await stub.increment()];
  }

  /** Named facet IDs (#237), string IDs, and `ctx.exports.Child({ props })`. */
  async facetStartup() {
    const Child = this.ctx.exports.Child;
    const props = { tag: "startup" };
    const withProps = Child({ props });
    // The call copied the properties.
    props.tag = "mutated";
    const identity = (name, options) =>
      this.ctx.facets.get(name, () => ({ class: Child, ...options }))
        .identity();
    const thrown = (operation) => {
      try {
        operation();
        return null;
      } catch (error) {
        return error.name;
      }
    };
    return {
      inherited: await identity("inherited", {}),
      named: await identity("named", { id: this.env.ROOT.idFromName("child") }),
      string: await identity("string", { id: "literal" }),
      props: await this.ctx.facets.get("props", () => ({ class: withProps }))
        .identity(),
      noOptions: thrown(() => Child()),
      nullOptions: thrown(() => Child(null)),
      scalarProps: thrown(() => Child({ props: 5 })),
    };
  }

  /**
   * #233: a leaked `kv.list()` cursor blocked every later write once enough
   * writes forced a checkpoint. The iterator reads one entry per step. The
   * leak and the write are separate events, as the checkpoint follows a commit.
   */
  kvLeak() {
    const kv = this.ctx.storage.kv;
    for (const key of ["a", "b", "c"]) kv.put(`list/${key}`, key);
    for (const _ of kv.list({ prefix: "list/" })) break;
    // About 3 MiB: past the 1000-page checkpoint threshold.
    for (let i = 0; i < 200; i++) kv.put(`blob/${i}`, "x".repeat(16384));
  }

  kvPut(key, value) {
    try {
      this.ctx.storage.kv.put(key, value);
      return "ok";
    } catch (error) {
      return error.message;
    }
  }

  kvIterate() {
    const kv = this.ctx.storage.kv;
    // Each step resumes after the last key returned, so it sees later changes.
    const resumed = kv.list({ prefix: "list/" });
    const first = resumed.next().value[0];
    kv.put("list/b", "B");
    kv.delete("list/c");
    const rest = [...resumed].map(([key, value]) => `${key}=${value}`);
    // A new list invalidates the previous iterator.
    const stale = kv.list({ prefix: "list/" });
    stale.next();
    kv.list({ prefix: "blob/" });
    let invalidated = null;
    try {
      stale.next();
    } catch (error) {
      invalidated = error.message;
    }
    return { first, rest, invalidated };
  }
}

/** Minimal wasm module: magic and version, no sections. */
const EMPTY_WASM = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

/** Module scope that counts the requests one loaded Worker has served. */
const COUNTER = `let served = 0;
export default {
  fetch() {
    return new Response(String(++served));
  },
};`;

const MAIN = `import m from "./empty.wasm";
export default {
  fetch() {
    return new Response(String(m instanceof WebAssembly.Module));
  },
};`;

/** Loads a Dynamic Worker and returns its text response. */
async function load(env, code) {
  const worker = env.LOADER.load(code);
  try {
    const response = await worker.getEntrypoint().fetch("http://loaded/");
    return await response.text();
  } finally {
    worker.dispose();
  }
}

/**
 * A named load lives as long as some capability refers to it. Disposing
 * one stub releases it for every stub of that load and forgets the name, so the
 * next `get()` runs `getCode` again.
 */
async function loaderLifetime(env) {
  let loads = 0;
  const getCode = () => {
    loads += 1;
    return {
      mainModule: "main.js",
      compatibilityDate: "2026-08-20",
      modules: { "main.js": COUNTER },
    };
  };
  const served = async (stub) =>
    await (await stub.getEntrypoint().fetch("http://loaded/")).text();
  const first = env.LOADER.get("shared", getCode);
  const second = env.LOADER.get("shared", getCode);
  const counts = [await served(first), await served(second)];
  first.dispose();
  const stale = await outcome(() => served(second));
  const replacement = env.LOADER.get("shared", getCode);
  try {
    counts.push(await served(replacement));
  } finally {
    replacement.dispose();
  }
  return { loads, counts, stale: "error" in stale };
}

/** Signs and verifies with both spellings of Ed25519 and derives X25519 bits. */
async function curves() {
  const data = new TextEncoder().encode("celld");
  const ed = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  const signature = await crypto.subtle.sign("Ed25519", ed.privateKey, data);
  const raw = await crypto.subtle.exportKey("raw", ed.publicKey);
  const imported = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "NODE-ED25519", namedCurve: "NODE-ED25519" },
    true,
    ["verify"],
  );
  const a = await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ]);
  const b = await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ]);
  const ab = await crypto.subtle.deriveBits(
    { name: "X25519", public: b.publicKey },
    a.privateKey,
    256,
  );
  const ba = await crypto.subtle.deriveBits(
    { name: "X25519", public: a.publicKey },
    b.privateKey,
    256,
  );
  const hex = (bytes) =>
    [...new Uint8Array(bytes)].map((x) => x.toString(16).padStart(2, "0"))
      .join("");
  return {
    signatureBytes: signature.byteLength,
    rawPublicBytes: raw.byteLength,
    verified: await crypto.subtle.verify(
      "Ed25519",
      ed.publicKey,
      signature,
      data,
    ),
    verifiedAsNode: await crypto.subtle.verify(
      "NODE-ED25519",
      imported,
      signature,
      data,
    ),
    x25519Agrees: hex(ab) === hex(ba),
  };
}

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/loopback") {
      return new Response("loopback " + request.method);
    }
    const { scenario } = await request.json();
    const root = env.ROOT.getByName("release");
    let result;
    switch (scenario) {
      case "transactions":
        result = await root.transactions();
        break;
      case "invalid-text":
        result = await root.invalidText();
        break;
      case "facet":
        result = await outcome(() => root.facet());
        break;
      case "facet-startup":
        result = await outcome(() => root.facetStartup());
        break;
      case "kv-list": {
        const object = env.ROOT.getByName("kv-list");
        await object.kvLeak();
        const afterLeak = await object.kvPut("list/after", "after");
        result = { afterLeak, ...await object.kvIterate() };
        break;
      }
      case "loader-lifetime":
        result = await outcome(() => loaderLifetime(env));
        break;
      case "exports": {
        const response = await ctx.exports.default.fetch(
          "http://self/loopback",
          { method: "POST" },
        );
        result = {
          keys: Object.keys(ctx.exports).sort(),
          fetched: await response.text(),
          named: await ctx.exports.Named.ping(),
        };
        break;
      }
      case "loader": {
        const base = { mainModule: "main.js", compatibilityDate: "2026-08-20" };
        const modules = { "main.js": MAIN, "empty.wasm": { wasm: EMPTY_WASM } };
        const { compatibilityDate: _, ...undated } = base;
        result = {
          wrapped: await outcome(() => load(env, { ...base, modules })),
          undated: await outcome(() => load(env, { ...undated, modules })),
          bare: await outcome(() =>
            load(env, {
              ...base,
              modules: { ...modules, "empty.wasm": EMPTY_WASM },
            })
          ),
        };
        break;
      }
      case "curves":
        result = await outcome(curves);
        break;
      default:
        return new Response("unknown scenario", { status: 400 });
    }
    return Response.json(result);
  },
};
