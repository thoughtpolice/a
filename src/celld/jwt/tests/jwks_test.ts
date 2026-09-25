// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  generateKeyPair,
  type Jwk,
  RemoteJwks,
  selectJwk,
  sign,
  verify,
} from "@celld/jwt";
import { rejects } from "./fixture.ts";

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
    verify(token, jwks),
    verify(token, jwks),
    verify(token, jwks),
  ]);
  await verify(token, jwks);
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
  );
  keys = [old.publicJwk, fresh.publicJwk];
  const rotated = await sign({}, fresh.privateKey, {
    alg: "ES256",
    kid: "new",
  });
  await rejects(() => verify(rotated, jwks), "no_key");
  assertEquals(state.requests, 1);
  clock = 1000;
  await verify(rotated, jwks);
  assertEquals(state.requests, 2);
  const bogus = await sign({}, fresh.privateKey, {
    alg: "ES256",
    kid: "bogus",
  });
  await rejects(() => verify(bogus, jwks), "no_key");
  await rejects(() => verify(bogus, jwks), "no_key");
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
  await verify(token, jwks);
  clock = 4999;
  await verify(token, jwks);
  assertEquals(state.requests, 1);
  clock = 5000;
  await verify(token, jwks);
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
    await rejects(() => verify(token, new RemoteJwks(URL_, { fetch })), "jwks");
  }
  const failing = new RemoteJwks(URL_, {
    fetch: () => Promise.reject(new TypeError("network down")),
  });
  const error = await rejects(() => failing.refresh(), "jwks");
  assert(error.cause instanceof TypeError, "keeps the cause");
});

Deno.test("keys in the set must still fit", async () => {
  const pair = await generateKeyPair("ES256", { kid: "k" });
  const { fetch } = server(() => [{ ...pair.publicJwk, use: "enc" }]);
  const token = await sign({}, pair.privateKey, { alg: "ES256", kid: "k" });
  await rejects(() => verify(token, new RemoteJwks(URL_, { fetch })), "no_key");
});

Deno.test("https only, but loopback and opt-in http", () => {
  let thrown = false;
  try {
    new RemoteJwks("http://issuer.example/jwks");
  } catch (error) {
    thrown = error instanceof TypeError;
  }
  assert(thrown, "http refused");
  new RemoteJwks("http://127.0.0.1:8080/jwks");
  new RemoteJwks("http://localhost/jwks");
  new RemoteJwks("http://[::1]/jwks");
  new RemoteJwks("http://issuer.example/jwks", { allowInsecure: true });
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
