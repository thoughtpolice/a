// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/core/assert";
import {
  generateKeyPair,
  type Jwk,
  localJwks,
  RemoteJwks,
  type RemoteJwksOptions,
  selectJwk,
  sign,
  verify,
} from "@celld/sec/jwt";
import { rejects } from "./fixture.ts";

const ES = { algorithms: ["ES256" as const] };

const URL_ = "https://issuer.example/jwks";

/** A fake JWKS endpoint: serves `keys`, counts requests. */
function server(keys: () => readonly Jwk[] | Response) {
  const state = { requests: 0, urls: [] as string[], accept: [] as string[] };
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    state.requests++;
    state.urls.push(String(input));
    state.accept.push(new Headers(init?.headers).get("accept") ?? "");
    const body = keys();
    return Promise.resolve(
      body instanceof Response ? body : Response.json({ keys: body }),
    );
  };
  return { state, fetch };
}

Deno.test("selectJwk", async () => {
  const a = (await generateKeyPair("ES256", { kid: "a" })).publicJwk;
  const b = (await generateKeyPair("ES256", { kid: "b" })).publicJwk;
  const r = (await generateKeyPair("RS256", { kid: "a" })).publicJwk;
  assertEquals(selectJwk({ keys: [a, b, r] }, "a", "ES256"), a);
  assertEquals(selectJwk({ keys: [a, b, r] }, "a", "RS256"), r);
  assertEquals(selectJwk({ keys: [a, b] }, "c", "ES256"), null);
  assertEquals(selectJwk({ keys: [a, r] }, undefined, "ES256"), a);
  assertEquals(selectJwk({ keys: [a, b] }, undefined, "ES256"), null);
});

Deno.test("fetches once, then serves from the cache", async () => {
  const pair = await generateKeyPair("ES256", { kid: "k1" });
  const { state, fetch } = server(() => [pair.publicJwk]);
  const jwks = new RemoteJwks(URL_, { fetch });
  assertEquals(jwks.jwks, null);
  const token = await sign({ sub: "a" }, pair.privateKey, {
    alg: "ES256",
    kid: "k1",
  });
  await Promise.all([
    verify(token, jwks, ES),
    verify(token, jwks, ES),
    verify(token, jwks, ES),
  ]);
  await verify(token, jwks, ES);
  assertEquals(state.requests, 1);
  assertEquals(state.urls, [URL_]);
  assertEquals(state.accept, ["application/json"]);
  assertEquals(jwks.jwks?.keys.length, 1);
});

Deno.test("an unknown kid refetches, within the cooldown only once", async () => {
  const old = await generateKeyPair("ES256", { kid: "old" });
  const fresh = await generateKeyPair("ES256", { kid: "new" });
  let keys = [old.publicJwk];
  let clock = 0;
  const { state, fetch } = server(() => keys);
  const jwks = new RemoteJwks(URL_, {
    fetch,
    now: () => clock,
    cooldownMs: 1000,
  });
  await verify(
    await sign({}, old.privateKey, { alg: "ES256", kid: "old" }),
    jwks,
    ES,
  );
  keys = [old.publicJwk, fresh.publicJwk];
  const rotated = await sign({}, fresh.privateKey, {
    alg: "ES256",
    kid: "new",
  });
  await rejects(() => verify(rotated, jwks, ES), "no_key");
  assertEquals(state.requests, 1);
  clock = 1000;
  await verify(rotated, jwks, ES);
  assertEquals(state.requests, 2);
  const bogus = await sign({}, fresh.privateKey, {
    alg: "ES256",
    kid: "bogus",
  });
  await rejects(() => verify(bogus, jwks, ES), "no_key");
  await rejects(() => verify(bogus, jwks, ES), "no_key");
  assertEquals(state.requests, 2);
});

Deno.test("the set expires after maxAgeMs", async () => {
  const pair = await generateKeyPair("EdDSA", { kid: "k" });
  let clock = 0;
  const { state, fetch } = server(() => [pair.publicJwk]);
  const jwks = new RemoteJwks(URL_, {
    fetch,
    now: () => clock,
    maxAgeMs: 5000,
  });
  const token = await sign({}, pair.privateKey, { alg: "EdDSA", kid: "k" });
  const ED = { algorithms: ["EdDSA" as const] };
  await verify(token, jwks, ED);
  clock = 4999;
  await verify(token, jwks, ED);
  assertEquals(state.requests, 1);
  clock = 5000;
  await verify(token, jwks, ED);
  assertEquals(state.requests, 2);
  await jwks.refresh();
  assertEquals(state.requests, 3);
});

Deno.test("bad responses are jwks errors", async () => {
  const pair = await generateKeyPair("ES256", { kid: "k" });
  const token = await sign({}, pair.privateKey, { alg: "ES256", kid: "k" });
  const bodies = [
    new Response("nope", { status: 500 }),
    new Response("not json"),
    Response.json({ keys: "x" }),
    Response.json({ keys: [1] }),
    Response.json([]),
  ];
  for (const body of bodies) {
    const { fetch } = server(() => body);
    await rejects(
      () => verify(token, new RemoteJwks(URL_, { fetch }), ES),
      "jwks",
    );
  }
  const failing = new RemoteJwks(URL_, {
    fetch: () => Promise.reject(new TypeError("network down")),
  });
  const error = await rejects(() => failing.refresh(), "jwks");
  assert(error.cause instanceof TypeError, "keeps the cause");
});

Deno.test("keys in the set must still fit", async () => {
  // An encryption key is never a verification key, even under the token's
  // kid: the set has no signing key for it.
  const pair = await generateKeyPair("ES256", { kid: "k" });
  const { fetch } = server(() => [{ ...pair.publicJwk, use: "enc" }]);
  const token = await sign({}, pair.privateKey, { alg: "ES256", kid: "k" });
  await rejects(
    () => verify(token, new RemoteJwks(URL_, { fetch }), ES),
    "no_key",
  );
});

// Review F12: one public encryption key refused the whole set, so adding
// one to an issuer's jwks_uri broke every login signed by its other keys.
Deno.test("public encryption keys in a set are skipped, not refused", async () => {
  const [sig, enc, x25519] = await Promise.all([
    generateKeyPair("ES256", { kid: "sig" }),
    generateKeyPair("ES256", { kid: "enc" }),
    generateKeyPair("Ed25519", { kid: "x" }),
  ]);
  const { alg: _alg, use: _use, key_ops: _ops, ...encryption } = enc.publicJwk;
  const token = await sign({ sub: "user" }, sig.privateKey, {
    alg: "ES256",
    kid: "sig",
  });
  const unrelated: Record<string, Jwk> = {
    "use enc": { ...encryption, kid: "enc", use: "enc" },
    "an encryption alg": { ...encryption, kid: "enc", alg: "ECDH-ES" },
    "use enc with an encryption alg": {
      ...encryption,
      kid: "enc",
      alg: "ECDH-ES",
      use: "enc",
    },
    "encryption key_ops": {
      ...encryption,
      kid: "enc",
      key_ops: ["deriveKey", "deriveBits"],
    },
    "an RSA-OAEP key": {
      ...(await generateKeyPair("RS256", { kid: "rsa" })).publicJwk,
      alg: "RSA-OAEP-256",
      use: "enc",
      key_ops: undefined,
    },
    "an X25519 key": { kty: "OKP", crv: "X25519", x: x25519.publicJwk.x },
    "an encryption key with unknown members": {
      ...encryption,
      kid: "enc",
      use: "enc",
      "x-extension": "anything",
    } as Jwk,
  };
  for (const [name, key] of Object.entries(unrelated)) {
    const { fetch } = server(
      () => [{ ...sig.publicJwk, use: "sig" }, JSON.parse(JSON.stringify(key))],
    );
    const jwks = new RemoteJwks(URL_, { fetch });
    const verified = await verify(token, jwks, ES);
    assertEquals(verified.payload.sub, "user", name);
    // The set it hands out holds the keys it verifies with.
    assertEquals(jwks.jwks?.keys.map((k) => k.kid), ["sig"], name);
  }
  // Nothing signed under the encryption key's kid verifies.
  const underEnc = await sign({ sub: "user" }, enc.privateKey, {
    alg: "ES256",
    kid: "enc",
  });
  const { fetch } = server(() => [
    { ...sig.publicJwk, use: "sig" },
    { ...encryption, kid: "enc", use: "enc" },
  ]);
  await rejects(
    () => verify(underEnc, new RemoteJwks(URL_, { fetch }), ES),
    "no_key",
  );
});

Deno.test("a set is still refused whole for secret or private material, whatever the key's use", async () => {
  const sig = await generateKeyPair("ES256", { kid: "sig" });
  const enc = await generateKeyPair("ES256", {
    kid: "enc",
    extractable: true,
  });
  const token = await sign({ sub: "user" }, sig.privateKey, {
    alg: "ES256",
    kid: "sig",
  });
  const { key_ops: _ops, ext: _ext, ...privateEncryption } = await crypto
    .subtle.exportKey("jwk", enc.privateKey) as Jwk;
  const refused: Record<string, Jwk> = {
    "an oct encryption key": {
      kty: "oct",
      k: "c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0",
      alg: "A256KW",
      use: "enc",
    },
    "a private encryption key": { ...privateEncryption, use: "enc" },
    "a private key with encryption key_ops": {
      ...privateEncryption,
      key_ops: ["deriveKey"],
    },
    "a k member on an encryption key": {
      ...enc.publicJwk,
      use: "enc",
      k: "AAAA",
    },
  };
  for (const [name, key] of Object.entries(refused)) {
    const { fetch } = server(() => [{ ...sig.publicJwk, use: "sig" }, key]);
    await rejects(
      () => verify(token, new RemoteJwks(URL_, { fetch }), ES),
      "jwks",
    ).catch((error) => {
      throw new Error(name, { cause: error });
    });
  }
  // A key that claims to sign is still validated strictly.
  const { fetch } = server(() => [
    { ...sig.publicJwk, use: "sig" },
    { ...enc.publicJwk, use: "sig", "x-extension": 1 } as Jwk,
  ]);
  await rejects(
    () => verify(token, new RemoteJwks(URL_, { fetch }), ES),
    "jwks",
  );
});

// The old version of this test accepted `http:` to any host with
// `allowInsecure` and loopback `http:` by default (DB-NET-001).
Deno.test("https only; loopback http only as the development override", () => {
  const refused = (url: string, options = {}) => {
    let thrown = false;
    try {
      new RemoteJwks(url, options);
    } catch (error) {
      thrown = error instanceof TypeError;
    }
    assert(thrown, `${url} ${JSON.stringify(options)} refused`);
  };
  refused("http://issuer.example/jwks");
  refused("http://127.0.0.1:8080/jwks");
  refused("https://127.0.0.1:8080/jwks");
  refused("http://localhost/jwks", { allowLoopbackForDevelopment: true });
  refused("http://issuer.example/jwks", { allowInsecure: true });
  refused("http://10.0.0.1/jwks", { allowLoopbackForDevelopment: true });
  new RemoteJwks("https://issuer.example/jwks");
  new RemoteJwks("https://203.0.113.9/jwks", { egress: { network: "any" } });
  for (const url of ["http://127.0.0.1:8080/jwks", "http://[::1]/jwks"]) {
    new RemoteJwks(url, { allowLoopbackForDevelopment: true });
  }
  new RemoteJwks("https://localhost/jwks", {
    allowLoopbackForDevelopment: true,
  });
});

Deno.test("custom headers", async () => {
  const pair = await generateKeyPair("ES256");
  const seen: string[] = [];
  const jwks = new RemoteJwks(URL_, {
    headers: { authorization: "Bearer t" },
    fetch: (_input, init) => {
      seen.push(new Headers(init?.headers).get("authorization") ?? "");
      return Promise.resolve(Response.json({ keys: [pair.publicJwk] }));
    },
  });
  await jwks.refresh();
  assertEquals(seen, ["Bearer t"]);
});

// The alias `allowInsecure` was removed once no caller used it; passing it
// is refused by name rather than silently ignored (DB-SWP-F16-13.3).
Deno.test("DB-SWP-F16-13.3: the removed allowInsecure option is refused", () => {
  for (const value of [true, false]) {
    let message = "";
    try {
      new RemoteJwks(
        "http://127.0.0.1:8080/jwks",
        { allowInsecure: value } as unknown as RemoteJwksOptions,
      );
    } catch (error) {
      assert(error instanceof TypeError, String(error));
      message = error.message;
    }
    assert(message.includes("allowInsecure"), message);
    assert(message.includes("allowLoopbackForDevelopment"), message);
  }
});

// A key set holds its own copy: the caller's object, and what `jwks` and
// `refresh()` hand out, cannot change the keys `resolve` trusts
// (DB-SWP-F15-13.1).
Deno.test("DB-SWP-F15-13.1: localJwks keeps a copy of the set", async () => {
  const good = await generateKeyPair("ES256", { kid: "good" });
  const evil = await generateKeyPair("ES256", { kid: "evil" });
  const jwks = { keys: [good.publicJwk] };
  const set = localJwks(jwks);
  jwks.keys.push(evil.publicJwk);
  jwks.keys[0] = { ...evil.publicJwk, kid: "good" };
  const forged = await sign({}, evil.privateKey, { alg: "ES256", kid: "evil" });
  await rejects(() => verify(forged, set, ES), "no_key");
  const spoofed = await sign({}, evil.privateKey, {
    alg: "ES256",
    kid: "good",
  });
  await rejects(() => verify(spoofed, set, ES), "bad_signature");
  const token = await sign({}, good.privateKey, { alg: "ES256", kid: "good" });
  await verify(token, set, ES);
});

Deno.test("DB-SWP-F15-13.1: RemoteJwks hands out frozen sets", async () => {
  const good = await generateKeyPair("ES256", { kid: "good" });
  const evil = await generateKeyPair("ES256", { kid: "evil" });
  const { fetch } = server(() => [good.publicJwk]);
  const set = new RemoteJwks(URL_, { fetch });
  const fetched = await set.refresh();
  const tamper = (jwks: { keys: Jwk[] } | null) => {
    try {
      jwks!.keys.push(evil.publicJwk);
    } catch (error) {
      assert(error instanceof TypeError, String(error));
    }
    try {
      (jwks!.keys[0] as { x?: string }).x = evil.publicJwk.x;
    } catch (error) {
      assert(error instanceof TypeError, String(error));
    }
  };
  tamper(fetched as { keys: Jwk[] });
  tamper(set.jwks as { keys: Jwk[] } | null);
  assertEquals(set.jwks?.keys.length, 1);
  assertEquals(set.jwks?.keys[0].x, good.publicJwk.x);
  const forged = await sign({}, evil.privateKey, { alg: "ES256", kid: "evil" });
  await rejects(() => verify(forged, set, ES), "no_key");
  const token = await sign({}, good.privateKey, { alg: "ES256", kid: "good" });
  await verify(token, set, ES);
});

// A response's `Cache-Control` can shorten the cache below `maxAgeMs`, but
// never below `cooldownMs`, so an issuer answering `no-store` cannot turn
// every lookup into a fetch (DB-SWP-F17-01).
Deno.test("DB-SWP-F17-01: Cache-Control max-age shortens the cache", async () => {
  const pair = await generateKeyPair("ES256", { kid: "k" });
  const token = await sign({}, pair.privateKey, { alg: "ES256", kid: "k" });
  for (
    const [header, lifetime] of [
      ["public, max-age=60", 60_000],
      ["max-age=0", 0],
      ["no-store", 0],
      ["no-cache", 0],
      ["max-age=99999", 600_000],
      ["max-age=junk", 0],
      [null, 600_000],
    ] as const
  ) {
    let clock = 0;
    const { state, fetch } = server(() => {
      const response = Response.json({ keys: [pair.publicJwk] });
      if (header !== null) response.headers.set("cache-control", header);
      return response;
    });
    const jwks = new RemoteJwks(URL_, { fetch, now: () => clock });
    await verify(token, jwks, ES);
    if (lifetime > 0) {
      clock = lifetime - 1;
      await verify(token, jwks, ES);
      assertEquals(state.requests, 1, `${header} before ${lifetime}`);
    }
    clock = lifetime;
    await verify(token, jwks, ES);
    assertEquals(state.requests, 2, `${header} at ${lifetime}`);
  }
});

// DB-REV-JWT-5: `verify(token, jwks)` cached imports by JWK object, so a key
// replaced in place kept verifying, and a set that kept growing kept every
// import.
Deno.test("a live JWKS sees a key replaced in place", async () => {
  const old = await generateKeyPair("ES256", { kid: "k" });
  const fresh = await generateKeyPair("ES256", { kid: "k" });
  const jwks = { keys: [{ ...old.publicJwk }] };
  const oldToken = await sign({}, old.privateKey, { alg: "ES256", kid: "k" });
  const newToken = await sign({}, fresh.privateKey, {
    alg: "ES256",
    kid: "k",
  });
  await verify(oldToken, jwks, ES);
  Object.assign(jwks.keys[0], fresh.publicJwk);
  await rejects(() => verify(oldToken, jwks, ES), "bad_signature");
  await verify(newToken, jwks, ES);
});

Deno.test("a live JWKS keeps at most one import per key", async () => {
  const jwks: { keys: Jwk[] } = { keys: [] };
  const subtle = crypto.subtle as unknown as Record<string, unknown>;
  const original = crypto.subtle.importKey;
  let imports = 0;
  subtle.importKey = (...args: unknown[]) => {
    imports++;
    return (original as (...a: unknown[]) => unknown).apply(
      crypto.subtle,
      args,
    );
  };
  try {
    const first = await generateKeyPair("ES256", { kid: "a" });
    const token = await sign({}, first.privateKey, { alg: "ES256", kid: "a" });
    jwks.keys.push(first.publicJwk);
    await verify(token, jwks, ES);
    await verify(token, jwks, ES);
    assertEquals(imports, 1, "the import is cached");
    // Churn: replace the one key many times; the old imports are dropped,
    // so the first key needs importing again when it comes back.
    for (let index = 0; index < 20; index++) {
      const other = await generateKeyPair("ES256", { kid: "a" });
      jwks.keys[0] = other.publicJwk;
      const t = await sign({}, other.privateKey, { alg: "ES256", kid: "a" });
      await verify(t, jwks, ES);
    }
    const before = imports;
    jwks.keys[0] = first.publicJwk;
    await verify(token, jwks, ES);
    assertEquals(imports, before + 1, "evicted imports are not kept");
  } finally {
    subtle.importKey = original;
  }
});
