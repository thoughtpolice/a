// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import { decode, isJwt, JWT_PATTERN, tryDecode } from "@celld/jwt";
import { part, rejects, unsigned } from "./fixture.ts";

Deno.test("decodes without verifying", () => {
  const token = unsigned({ alg: "HS256", typ: "JWT", kid: "a" }, {
    sub: "alice",
    aud: ["x", "y"],
    exp: 1,
  });
  const jwt = decode(token);
  assertEquals(jwt.header, { alg: "HS256", typ: "JWT", kid: "a" });
  assertEquals(jwt.payload, { sub: "alice", aud: ["x", "y"], exp: 1 });
  assertEquals(new TextDecoder().decode(jwt.signature), "sig");
  assertEquals(
    new TextDecoder().decode(jwt.signingInput),
    token.slice(0, token.lastIndexOf(".")),
  );
});

Deno.test("malformed tokens", async () => {
  const header = part({ alg: "HS256" });
  const payload = part({ sub: "a" });
  for (
    const token of [
      "",
      "a.b",
      "a.b.c.d",
      `${header}.${payload}`,
      `${header}.${payload}.sig.x`,
      `x.${payload}.c2ln`,
      `${header}.x.c2ln`,
      `${part([1])}.${payload}.c2ln`,
      `${part({ typ: "JWT" })}.${payload}.c2ln`,
      `${part({ alg: 1 })}.${payload}.c2ln`,
      `${header}.${part("claims")}.c2ln`,
      `${header}.${part(null)}.c2ln`,
      `${header}.${payload}.c2ln=`,
      `${header}.${payload}.c2l+`,
      `${part({ alg: "HS256", crit: [] })}.${payload}.c2ln`,
      `${part({ alg: "HS256", crit: "b64" })}.${payload}.c2ln`,
      `${header}._w.c2ln`,
    ]
  ) {
    await rejects(() => decode(token), "malformed");
    assertEquals(tryDecode(token), null, token);
    assert(!isJwt(token), token);
  }
});

Deno.test("isJwt is structural, like zod's", () => {
  const good = unsigned({ alg: "RS256", typ: "JWT" }, { sub: "a" });
  assert(isJwt(good), "good");
  assert(isJwt(good, { alg: "RS256" }), "alg");
  assert(!isJwt(good, { alg: "HS256" }), "other alg");
  assert(isJwt(unsigned({ alg: "RS256" }, {})), "no typ");
  assert(
    isJwt(unsigned({ alg: "RS256", typ: "at+jwt" }, {})),
    "explicit typing",
  );
  assert(isJwt(unsigned({ alg: "RS256", typ: "jwt" }, {})), "any case");
  assert(!isJwt(unsigned({ alg: "RS256", typ: "JWE" }, {})), "other typ");
  assert(!isJwt(unsigned({ alg: "RS256", typ: 5 }, {})), "typ type");
  assert(!isJwt(unsigned({ alg: "RS256" }, {}, "")), "empty signature");
  assert(isJwt(unsigned({ alg: "none" }, {}, "")), "unsecured");
});

Deno.test("JWT_PATTERN matches the shape", () => {
  const pattern = new RegExp(JWT_PATTERN);
  assert(pattern.test(unsigned({ alg: "HS256" }, {})), "token");
  assert(pattern.test(unsigned({ alg: "none" }, {}, "")), "unsecured");
  assert(!pattern.test("a.b"), "two parts");
  assert(!pattern.test("a+.b.c"), "alphabet");
});
