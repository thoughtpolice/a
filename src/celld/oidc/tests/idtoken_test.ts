// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "@celld/assert";
import { generateSecret, type JwsAlgorithm, localJwks, sign } from "@celld/jwt";
import { tokenHash } from "@celld/oidc";
import { type IdTokenValidationOptions, validateIdToken } from "@celld/oidc/rp";
import { routeFetch } from "@celld/oauth/testing";
import { RemoteJwks } from "@celld/jwt";
import { clock, idToken, jwksOf, key, rejects, seconds } from "./fixture.ts";
import {
  A2_ID_TOKEN,
  A3_ACCESS_TOKEN,
  A3_ID_TOKEN,
  A4_CODE,
  A4_ID_TOKEN,
  A7_KEY,
  EXAMPLE,
} from "./vectors.ts";

const example: IdTokenValidationOptions = {
  issuer: EXAMPLE.issuer,
  clientId: EXAMPLE.clientId,
  keys: { keys: [A7_KEY] },
  nonce: EXAMPLE.nonce,
  now: () => EXAMPLE.at,
  maxIatAgeSec: 3600,
};

Deno.test("OIDC Core A.2: the example ID token validates with the A.7 key", async () => {
  const claims = await validateIdToken(A2_ID_TOKEN, example);
  assertEquals(claims.sub, EXAMPLE.subject);
  assertEquals(claims.name, "Jane Doe");
  assertEquals(claims.email, "janedoe@example.com");
});

Deno.test("OIDC Core A.3: at_hash binds the example access token", async () => {
  assertEquals(
    await tokenHash(A3_ACCESS_TOKEN, "RS256"),
    "77QmUPtjPfzWtF2AnpK9RQ",
  );
  const claims = await validateIdToken(A3_ID_TOKEN, {
    ...example,
    accessToken: A3_ACCESS_TOKEN,
    requireAtHash: true,
  });
  assertEquals(claims.at_hash, "77QmUPtjPfzWtF2AnpK9RQ");
  await rejects(
    () =>
      validateIdToken(A3_ID_TOKEN, {
        ...example,
        accessToken: `${A3_ACCESS_TOKEN}x`,
      }),
    { code: "at_hash" },
  );
});

Deno.test("OIDC Core A.4: c_hash binds the example code", async () => {
  assertEquals(await tokenHash(A4_CODE, "RS256"), "LDktKdoQak3Pk0cnXxCltA");
  await validateIdToken(A4_ID_TOKEN, { ...example, code: A4_CODE });
  await rejects(
    () => validateIdToken(A4_ID_TOKEN, { ...example, code: "another-code" }),
    { code: "c_hash" },
  );
});

Deno.test("OIDC Core examples: expired now, wrong client, wrong nonce", async () => {
  await rejects(
    () => validateIdToken(A2_ID_TOKEN, { ...example, now: () => Date.now() }),
    { code: "exp" },
  );
  await rejects(
    () => validateIdToken(A2_ID_TOKEN, { ...example, clientId: "someone" }),
    { code: "aud" },
  );
  await rejects(
    () => validateIdToken(A2_ID_TOKEN, { ...example, nonce: "other" }),
    { code: "nonce" },
  );
  await rejects(
    () => validateIdToken(A2_ID_TOKEN, { ...example, issuer: "https://evil" }),
    { code: "iss" },
  );
  await rejects(
    () => validateIdToken(A2_ID_TOKEN, { ...example, algorithms: ["ES256"] }),
    { code: "alg" },
  );
  const tampered = A2_ID_TOKEN.slice(0, -4) + "AAAA";
  await rejects(() => validateIdToken(tampered, example), {
    code: "signature",
  });
});

interface World {
  readonly now: () => number;
  readonly signer: Awaited<ReturnType<typeof key>>;
  readonly options: IdTokenValidationOptions;
  claims(extra?: Readonly<Record<string, unknown>>): Record<string, unknown>;
}

async function world(): Promise<World> {
  const time = clock();
  const signer = await key("op-1");
  const iat = seconds(time.now);
  return {
    now: time.now,
    signer,
    options: {
      issuer: "https://op.test",
      clientId: "app",
      keys: jwksOf(signer),
      nonce: "n-1",
      now: time.now,
    },
    claims: (extra = {}) => ({
      iss: "https://op.test",
      sub: "user-1",
      aud: "app",
      exp: iat + 300,
      iat,
      nonce: "n-1",
      ...extra,
    }),
  };
}

Deno.test("a well-formed ID token passes and returns its claims", async () => {
  const w = await world();
  const claims = await validateIdToken(
    await idToken(w.signer, w.claims({ auth_time: seconds(w.now) - 10 })),
    { ...w.options, maxAge: 60 },
  );
  assertEquals(claims.sub, "user-1");
});

Deno.test("a runtime that cannot verify is not a bad signature", async () => {
  const w = await world();
  const token = await idToken(w.signer, w.claims());
  // What celld 0.5.1's WebCrypto does for Ed25519.
  const original = crypto.subtle.verify;
  crypto.subtle.verify = () =>
    Promise.reject(
      new DOMException("unsupported verify algorithm", "NotSupportedError"),
    );
  try {
    await rejects(() => validateIdToken(token, w.options), {
      name: "JwtError",
      code: "runtime_unsupported",
    });
  } finally {
    crypto.subtle.verify = original;
  }
});

Deno.test("negatives: every refusal names its check", async () => {
  const w = await world();
  const now = seconds(w.now);
  const cases: [
    string,
    Record<string, unknown>,
    Partial<IdTokenValidationOptions>,
    string,
  ][] = [
    ["another issuer", { iss: "https://evil.test" }, {}, "iss"],
    ["another audience", { aud: "other" }, {}, "aud"],
    [
      "an untrusted extra audience",
      { aud: ["app", "other"], azp: "app" },
      {},
      "aud",
    ],
    ["several audiences without azp", { aud: ["app", "api"] }, {
      trustedAudiences: ["api"],
    }, "azp"],
    ["azp of another party", { azp: "other" }, {}, "azp"],
    ["expired", { exp: now - 60 }, {}, "exp"],
    ["issued in the future", { iat: now + 120, exp: now + 400 }, {}, "iat"],
    ["issued long ago", { iat: now - 3600, exp: now + 60 }, {}, "iat"],
    ["no nonce", { nonce: undefined }, {}, "nonce"],
    ["another nonce", { nonce: "n-2" }, {}, "nonce"],
    ["no auth_time with max_age", {}, { maxAge: 60 }, "auth_time"],
    [
      "auth_time older than max_age",
      { auth_time: now - 600 },
      { maxAge: 60 },
      "auth_time",
    ],
    ["auth_time in the future", { auth_time: now + 600 }, {}, "auth_time"],
    ["auth_time changed on refresh", { auth_time: now - 5 }, {
      authTime: now - 50,
      nonce: undefined,
    }, "auth_time"],
    [
      "a nonce on refresh",
      {},
      { nonce: undefined, forbidNonce: true },
      "nonce",
    ],
    [
      "acr not asked for",
      { acr: "urn:low" },
      { acrValues: ["urn:high"] },
      "acr",
    ],
    ["no acr at all", {}, { acrValues: ["urn:high"] }, "acr"],
    ["at_hash of another token", { at_hash: "AAAAAAAAAAAAAAAAAAAAAA" }, {
      accessToken: "token",
    }, "at_hash"],
    ["no at_hash when required", {}, {
      accessToken: "token",
      requireAtHash: true,
    }, "at_hash"],
    ["c_hash of another code", { c_hash: "AAAAAAAAAAAAAAAAAAAAAA" }, {
      code: "code",
    }, "c_hash"],
    ["another subject", {}, { subject: "user-2" }, "sub"],
    ["no sub", { sub: undefined }, {}, "claims"],
    ["no iat", { iat: undefined }, {}, "claims"],
    ["exp that is a string", { exp: "later" }, {}, "claims"],
  ];
  for (const [what, extra, options, code] of cases) {
    const claims = w.claims(extra);
    for (const [name, value] of Object.entries(extra)) {
      if (value === undefined) delete claims[name];
    }
    await rejects(
      async () =>
        await validateIdToken(await idToken(w.signer, claims), {
          ...w.options,
          ...options,
        }),
      { code },
    ).catch((error) => {
      throw new Error(`${what}: ${error.message}`);
    });
  }
});

Deno.test("negatives: algorithms, keys and structure", async () => {
  const w = await world();
  const claims = w.claims();
  const secret = generateSecret("HS256");
  const hmac = await sign(claims, secret, { alg: "HS256", kid: "op-1" });
  await rejects(
    () =>
      validateIdToken(hmac, { ...w.options, algorithms: ["HS256", "ES256"] }),
    { code: "alg" },
  );
  const [header, payload] = (await idToken(w.signer, claims)).split(".");
  const none = `${
    btoa(JSON.stringify({ alg: "none" })).replace(/=+$/, "")
  }.${payload}.`;
  await rejects(() => validateIdToken(none, w.options), { code: "alg" });
  await rejects(() => validateIdToken(`${header}.${payload}`, w.options), {
    code: "malformed",
  });
  const stranger = await key("op-1");
  await rejects(
    async () => validateIdToken(await idToken(stranger, claims), w.options),
    { code: "signature" },
  );
  const unknownKid = await key("unknown");
  await rejects(
    async () => validateIdToken(await idToken(unknownKid, claims), w.options),
    { code: "signature" },
  );
  const rsa = await key("op-rsa", "RS256");
  await rejects(
    async () =>
      validateIdToken(await idToken(rsa, claims), {
        ...w.options,
        keys: jwksOf(rsa),
        algorithms: ["ES256"] as JwsAlgorithm[],
      }),
    { code: "alg" },
  );
});

Deno.test("key rotation: an unknown kid refetches the provider's JWKS", async () => {
  const w = await world();
  const next = await key("op-2");
  let published = jwksOf(w.signer);
  let fetches = 0;
  const fetch = routeFetch({
    "https://op.test": () => {
      fetches++;
      return Response.json(published);
    },
  });
  const keys = new RemoteJwks("https://op.test/jwks", {
    fetch,
    now: w.now,
    cooldownMs: 0,
  });
  await validateIdToken(await idToken(w.signer, w.claims()), {
    ...w.options,
    keys,
  });
  assertEquals(fetches, 1);
  published = jwksOf(w.signer, next);
  await validateIdToken(await idToken(next, w.claims()), {
    ...w.options,
    keys,
  });
  assertEquals(fetches, 2);
  await validateIdToken(await idToken(w.signer, w.claims()), {
    ...w.options,
    keys,
  });
  assertEquals(fetches, 2, "a known kid needs no fetch");
});

Deno.test("an unreachable JWKS is keys, not signature", async () => {
  const w = await world();
  const keys = new RemoteJwks("https://op.test/jwks", {
    fetch: () => Promise.reject(new TypeError("offline")),
    now: w.now,
  });
  await rejects(
    async () =>
      validateIdToken(await idToken(w.signer, w.claims()), {
        ...w.options,
        keys,
      }),
    { code: "keys" },
  );
});

Deno.test("trusted extra audiences with azp pass", async () => {
  const w = await world();
  const claims = await validateIdToken(
    await idToken(w.signer, w.claims({ aud: ["app", "api"], azp: "app" })),
    {
      ...w.options,
      trustedAudiences: ["api"],
      keys: localJwks(jwksOf(w.signer)),
    },
  );
  assertEquals(claims.azp, "app");
});
