// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
// deno-lint-ignore-file require-await
// Async fetch stubs intentionally settle immediately for deterministic tests.
import { assert, assertEquals } from "@celld/core/assert";
import {
  createVerifier,
  decode,
  generateKeyPair,
  generateSecret,
  type Jwk,
  localJwks,
  REGISTERED_HEADER_PARAMETERS,
  RemoteJwks,
  sign,
  validatePublicJwk,
} from "@celld/sec/jwt";
import { rejects } from "./fixture.ts";

Deno.test("DB-JWT-001: every private member and nonverification operation fails the shared public boundary", async () => {
  for (const alg of ["RS256", "ES256", "EdDSA"] as const) {
    const { publicJwk } = await generateKeyPair(alg);
    assertEquals(validatePublicJwk(publicJwk), publicJwk);
    for (
      const name of [
        "d",
        "p",
        "q",
        "dp",
        "dq",
        "qi",
        "oth",
        "k",
        "unknown_secret",
      ]
    ) {
      const value = { ...publicJwk, [name]: [{ secret: "never include me" }] };
      const error = await rejects(() => validatePublicJwk(value), "jwks");
      assert(
        !error.message.includes("never include me"),
        "no key value in diagnostics",
      );
      const remote = new RemoteJwks("https://keys.test/jwks", {
        fetch: async () => Response.json({ keys: [value] }),
      });
      await rejects(() => remote.refresh(), "jwks");
    }
    for (
      const op of [
        "sign",
        "decrypt",
        "encrypt",
        "unwrapKey",
        "deriveKey",
        "deriveBits",
        "unknown",
      ]
    ) {
      await rejects(
        () => validatePublicJwk({ ...publicJwk, key_ops: [op] }),
        "jwks",
      );
    }
    const original = { ...publicJwk, key_ops: ["verify"] };
    const validated = validatePublicJwk(original);
    original.key_ops[0] = "sign";
    assertEquals(validated.key_ops, ["verify"]);
    assert(
      Object.isFrozen(validated) && Object.isFrozen(validated.key_ops),
      "deeply immutable public key",
    );
  }
});

Deno.test("DB-JWT-002: remote authority cannot be mutated through either URL", async () => {
  const url = new URL("https://original.test/jwks");
  const key = await generateKeyPair("ES256");
  const targets: string[] = [];
  const remote = new RemoteJwks(url, {
    fetch: async (input) => {
      targets.push(String(input));
      return Response.json({ keys: [key.publicJwk] });
    },
  });
  url.hostname = "attacker.test";
  remote.url.hostname = "attacker.test";
  await remote.refresh();
  assertEquals(targets, ["https://original.test/jwks"]);
  for (
    const invalid of [
      "https://keys.test/jwks?credential=secret-query#secret-fragment",
      "http://keys.test/jwks?credential=secret-query",
    ]
  ) {
    try {
      new RemoteJwks(invalid);
      throw new Error("accepted invalid JWKS URL");
    } catch (error) {
      assert(error instanceof TypeError, "URL rejected before fetching");
      assert(!error.message.includes("secret-"), "URL credentials redacted");
    }
  }
});

Deno.test("DB-JWT-003/011: cancellation releases one waiter, aborts an unobserved fetch and never poisons backoff", async () => {
  const key = await generateKeyPair("ES256", { kid: "one" });
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  const starting = new Promise<void>((resolve) => started = resolve);
  let calls = 0;
  const remote = new RemoteJwks("https://keys.test/jwks", {
    fetch: async () => {
      calls++;
      started();
      await gate;
      return Response.json({ keys: [key.publicJwk] });
    },
  });
  const controller = new AbortController();
  const first = remote.resolve({ alg: "ES256", kid: "one" }, "ES256", {
    signal: controller.signal,
  });
  const sibling = remote.resolve({ alg: "ES256", kid: "one" }, "ES256");
  await starting;
  controller.abort();
  await first.then(() => {
    throw new Error("cancelled waiter returned a key");
  }, (error) => assertEquals(error.name, "AbortError"));
  release();
  await sibling;
  assertEquals(calls, 1);
  let cancellations = 0;
  const alone = new RemoteJwks("https://keys.test/other", {
    now: () => 0,
    fetch: (_input, init) => {
      if (cancellations) {
        return Promise.resolve(Response.json({ keys: [key.publicJwk] }));
      }
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          cancellations++;
          reject(init.signal!.reason);
        }, { once: true });
      });
    },
  });
  const stop = new AbortController();
  const waiting = alone.resolve({ alg: "ES256" }, "ES256", {
    signal: stop.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  stop.abort();
  await waiting.then(() => {
    throw new Error("cancelled request succeeded");
  }, (error) => assertEquals(error.name, "AbortError"));
  assertEquals(cancellations, 1);
  await alone.resolve({ alg: "ES256" }, "ES256");
});

Deno.test("DB-JWT-003: no-store/no-cache/max-age=0 bypass freshness cooldown", async () => {
  const key = await generateKeyPair("ES256", { kid: "one" });
  for (
    const control of [
      "no-store",
      "no-cache",
      "max-age=0",
      "MAX-AGE=broken",
      "max-age=60,max-age=120",
      "max-age=60=invalid",
      "max-age = 0",
    ]
  ) {
    let calls = 0;
    const remote = new RemoteJwks("https://keys.test/jwks", {
      now: () => 0,
      fetch: async () => {
        calls++;
        return Response.json({ keys: [key.publicJwk] }, {
          headers: { "cache-control": control },
        });
      },
    });
    await remote.resolve({ alg: "ES256", kid: "one" }, "ES256");
    await remote.resolve({ alg: "ES256", kid: "one" }, "ES256");
    assertEquals(calls, 2, control);
    if (control === "no-store") assertEquals(remote.jwks, null);
  }
});

Deno.test("DB-JWT-003: Age, conditional revalidation, and must-revalidate prohibit stale trust", async () => {
  const key = await generateKeyPair("ES256", { kid: "one" });
  let now = 0, calls = 0;
  let down = false;
  const remote = new RemoteJwks("https://keys.test/jwks", {
    now: () => now,
    maxStaleMs: 3600000,
    fetch: async (_input, init) => {
      calls++;
      if (down) throw new Error("offline");
      if (calls > 1) {
        assertEquals(new Headers(init?.headers).get("if-none-match"), "v1");
        return new Response(null, {
          status: 304,
          headers: { "cache-control": "max-age=60, must-revalidate", age: "0" },
        });
      }
      return Response.json({ keys: [key.publicJwk] }, {
        headers: {
          "cache-control": "max-age=60, must-revalidate",
          age: "50",
          etag: "v1",
        },
      });
    },
  });
  await remote.resolve({ alg: "ES256", kid: "one" }, "ES256");
  now = 9999;
  await remote.resolve({ alg: "ES256", kid: "one" }, "ES256");
  assertEquals(calls, 1);
  now = 10000;
  await remote.resolve({ alg: "ES256", kid: "one" }, "ES256");
  assertEquals(calls, 2);
  now = 70000;
  down = true;
  await rejects(
    () => remote.resolve({ alg: "ES256", kid: "one" }, "ES256"),
    "jwks",
  );
});

Deno.test("DB-JWT-004: strict and interoperable algorithm policies are explicit", async () => {
  const { publicJwk } = await generateKeyPair("RS256");
  const { alg: _, ...bare } = publicJwk;
  await rejects(
    () => localJwks({ keys: [bare] }, { requireKeyAlgorithm: true }),
    "jwks",
  );
  const set = localJwks({ keys: [bare] }, { algorithms: ["RS256"] });
  await set.resolve({ alg: "RS256" }, "RS256");
  await rejects(
    () => set.resolve({ alg: "RS384" }, "RS384"),
    "alg_not_allowed",
  );
  await rejects(
    () => localJwks({ keys: [bare] }).resolve({ alg: "PS256" }, "PS256"),
    "no_key",
  );
});

Deno.test("DB-JWT-005/011: safe signing rejects invalid semantics, critical extensions and size", async () => {
  const key = generateSecret("HS256");
  for (
    const claims of [
      { exp: Infinity },
      { nbf: NaN },
      { aud: [] },
      { aud: ["a", "a"] },
      { jti: "" },
      { sub: 5 },
      { cnf: { jkt: false } },
    ]
  ) {
    await rejects(
      () => sign(claims as never, key, { alg: "HS256" }),
      "invalid_claim",
    );
  }
  await rejects(
    () => sign({}, key, { alg: "HS256", header: { alg: "none" } }),
    "malformed",
  );
  await rejects(
    () =>
      sign({}, key, {
        alg: "HS256",
        header: { crit: ["private"], private: true },
      }),
    "crit",
  );
  await rejects(
    () => sign({ blob: "🙂".repeat(5000) }, key, { alg: "HS256" }),
    "too_large",
  );
  const token = await sign({ aud: "api", iss: "issuer" }, key, {
    alg: "HS256",
    now: 1000,
    issuedAt: true,
    expiresIn: 30,
  });
  assertEquals(
    (await createVerifier({
      keys: key,
      algorithms: ["HS256"],
      issuer: "issuer",
      audience: "api",
      now: 1000,
    }).verify(token)).payload.aud,
    "api",
  );
});

Deno.test("DB-JWT-007/008/010: prepared policy freezes dates, nested keys, registries and imports at readiness", async () => {
  const key = await generateKeyPair("ES256");
  const jwk: Jwk = { ...key.publicJwk, key_ops: ["verify"] };
  const date = new Date(1000);
  const verifier = createVerifier({
    keys: jwk,
    algorithms: ["ES256"],
    now: date,
  });
  date.setTime(1000000);
  jwk.key_ops![0] = "sign";
  const token = await sign({ exp: 30 }, key.privateKey, { alg: "ES256" });
  await verifier.ready();
  await verifier.verify(token);
  assert(
    Object.isFrozen(REGISTERED_HEADER_PARAMETERS),
    "header registry frozen",
  );
});

Deno.test("DB-JWT-011: malformed compact and bounded JSON corpus never crashes or hangs", () => {
  let seed = 7;
  for (let i = 0; i < 2000; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const value = String.fromCharCode(seed % 256).repeat(seed % 100) +
      ".e30.AA";
    try {
      decode(value);
    } catch (error) {
      assert(error instanceof Error, "stable parser rejection");
    }
  }
});
