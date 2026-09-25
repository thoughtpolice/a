// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `createVerifier` (DB-JWT-007, DB-JWT-008): prepared options, keys
 * imported once and bound to one algorithm, and claims refinement.
 *
 * @module
 */

import { assert, assertEquals, assertThrows } from "@celld/core/assert";
import {
  createVerifier,
  generateKeyPair,
  generateSecret,
  type Jwk,
  type JwtClaims,
  JwtError,
  localJwks,
  sign,
  verify,
  type VerifyOptions,
} from "@celld/sec/jwt";
import { rejects } from "./fixture.ts";

const NOW = 1_790_000_000_000;
const now = () => NOW;
/**
 * An `exp` a day ahead of both the fixed and the real clock: `createVerifier`
 * requires one by default (DB-REV-JWT-7).
 */
const exp = Math.floor(Math.max(Date.now(), NOW) / 1000) + 86_400;

/** Counts `crypto.subtle.importKey` calls made while `fn` runs. */
async function countImports(fn: () => Promise<void>): Promise<number> {
  const subtle = crypto.subtle as unknown as Record<string, unknown>;
  const original = crypto.subtle.importKey;
  let calls = 0;
  subtle.importKey = (...args: unknown[]) => {
    calls++;
    return (original as (...a: unknown[]) => unknown).apply(
      crypto.subtle,
      args,
    );
  };
  try {
    await fn();
  } finally {
    subtle.importKey = original;
  }
  return calls;
}

Deno.test("a prepared verifier imports its key once", async () => {
  const pair = await generateKeyPair("ES256", { kid: "k" });
  const token = await sign({ sub: "a", exp }, pair.privateKey, {
    alg: "ES256",
    kid: "k",
  });
  const verifier = createVerifier({
    keys: pair.publicJwk,
    algorithms: ["ES256"],
    now,
  });
  const prepared = await countImports(async () => {
    for (let i = 0; i < 10; i++) await verifier.verify(token);
  });
  assertEquals(prepared, 1);
  const direct = await countImports(async () => {
    for (let i = 0; i < 10; i++) {
      await verify(token, pair.publicJwk, { algorithms: ["ES256"] });
    }
  });
  assertEquals(direct, 10, "the low-level verify imports every time");
  const secret = generateSecret("HS256");
  const hs = await sign({ exp }, secret, { alg: "HS256" });
  const hmac = createVerifier({ keys: secret, algorithms: ["HS256"] });
  assertEquals(
    await countImports(async () => {
      for (let i = 0; i < 5; i++) await hmac.verify(hs);
    }),
    1,
  );
});

Deno.test("a prepared verifier checks its options up front", () => {
  const secret = generateSecret("HS256");
  const bad: Partial<VerifyOptions>[] = [
    { algorithms: [] },
    { algorithms: ["HS256"], clockTolerance: NaN },
    { algorithms: ["HS256"], clockTolerance: Infinity },
    { algorithms: ["HS256"], clockTolerance: -1 },
    { algorithms: ["HS256"], maxTokenAge: NaN },
    { algorithms: ["HS256"], now: NaN },
    { algorithms: ["HS256"], limits: { maxTokenBytes: 0 } },
    { algorithms: ["HS256"], limits: { maxPayloadBytes: Infinity } },
  ];
  for (const options of bad) {
    let thrown: unknown;
    try {
      createVerifier({ keys: secret, ...options } as never);
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown instanceof RangeError || thrown instanceof TypeError,
      `${JSON.stringify(options)}: ${thrown}`,
    );
  }
});

Deno.test("the options are copied when the verifier is made", async () => {
  const secret = generateSecret("HS256");
  const algorithms: ("HS256" | "RS256")[] = ["HS256"];
  const issuer = ["https://a"];
  const verifier = createVerifier({ keys: secret, algorithms, issuer });
  algorithms[0] = "RS256";
  issuer[0] = "https://b";
  const token = await sign({ iss: "https://a", exp }, secret, { alg: "HS256" });
  await verifier.verify(token);
  secret.fill(0);
  await verifier.verify(token);
});

Deno.test("a single key is bound to one algorithm", async () => {
  const rsa = await generateKeyPair("RS256", { extractable: true });
  const { alg: _alg, ...bare } = rsa.publicJwk;
  const rs = await sign({ exp }, rsa.privateKey, { alg: "RS256" });
  // An alg-less RSA JWK fits RS256 and PS256: it must be narrowed.
  await rejects(
    () => createVerifier({ keys: bare, algorithms: ["RS256", "PS256"] }),
    "ambiguous_key",
  );
  const verifier = createVerifier({
    keys: bare,
    algorithms: ["RS256", "ES256"],
  });
  await verifier.verify(rs);
  const ec = await generateKeyPair("ES256");
  const es = await sign({ exp }, ec.privateKey, { alg: "ES256" });
  await rejects(() => verifier.verify(es), "key_mismatch");
  const pss = createVerifier({ keys: bare, algorithms: ["PS256"] });
  await rejects(() => pss.verify(rs), "alg_not_allowed");
  // A key that fits two hashes must be narrowed.
  const secret = generateSecret("HS512");
  await rejects(
    () => createVerifier({ keys: secret, algorithms: ["HS256", "HS512"] }),
    "ambiguous_key",
  );
  await rejects(
    () => createVerifier({ keys: bare, algorithms: ["RS256", "RS512"] }),
    "ambiguous_key",
  );
  await rejects(
    () => createVerifier({ keys: bare, algorithms: ["ES256"] }),
    "key_mismatch",
  );
  // With alg set, the JWK chooses.
  createVerifier({
    keys: { ...bare, alg: "RS512" } as Jwk,
    algorithms: ["RS256", "RS512"],
  });
});

Deno.test("key sets and JWKS work through a prepared verifier", async () => {
  const a = await generateKeyPair("ES256", { kid: "a" });
  const b = await generateKeyPair("ES256", { kid: "b" });
  const jwks = { keys: [a.publicJwk, b.publicJwk] };
  const tokenB = await sign({ exp }, b.privateKey, { alg: "ES256", kid: "b" });
  await createVerifier({ keys: jwks, algorithms: ["ES256"] }).verify(tokenB);
  await createVerifier({ keys: localJwks(jwks), algorithms: ["ES256"] })
    .verify(tokenB);
});

interface Session {
  readonly sub: string;
  readonly role: "admin" | "user";
}

function session(claims: JwtClaims): Session {
  if (typeof claims.sub !== "string") throw new TypeError("sub");
  if (claims.role !== "admin" && claims.role !== "user") {
    throw new TypeError("role");
  }
  return { sub: claims.sub, role: claims.role };
}

Deno.test("claims are refined, not cast", async () => {
  const secret = generateSecret("HS256");
  const good = await sign({ sub: "a", role: "admin", extra: 1, exp }, secret, {
    alg: "HS256",
  });
  const bad = await sign({ sub: "a", role: "root", exp }, secret, {
    alg: "HS256",
  });
  const verifier = createVerifier({
    keys: secret,
    algorithms: ["HS256"],
    claims: session,
  });
  const { payload } = await verifier.verify(good);
  assertEquals(payload, { sub: "a", role: "admin" });
  const error = await rejects(() => verifier.verify(bad), "invalid_claim");
  assert(error.cause instanceof TypeError, "keeps the cause");
  const direct = await verify(good, secret, {
    algorithms: ["HS256"],
    claims: session,
  });
  assertEquals(direct.payload.role, "admin");
  await rejects(
    () => verify(bad, secret, { algorithms: ["HS256"], claims: session }),
    "invalid_claim",
  );
  // A refinement may throw its own JwtError.
  await rejects(
    () =>
      verify(good, secret, {
        algorithms: ["HS256"],
        claims: () => {
          throw new JwtError("subject", "not this one");
        },
      }),
    "subject",
  );
});

Deno.test("limits are configurable", async () => {
  const secret = generateSecret("HS256");
  const token = await sign({ blob: "x".repeat(20_000), exp }, secret, {
    alg: "HS256",
    limits: { maxTokenBytes: 64 * 1024 },
  });
  await rejects(
    () => createVerifier({ keys: secret, algorithms: ["HS256"] }).verify(token),
    "too_large",
  );
  await createVerifier({
    keys: secret,
    algorithms: ["HS256"],
    limits: { maxTokenBytes: 64 * 1024 },
  }).verify(token);
  await rejects(
    () =>
      createVerifier({
        keys: secret,
        algorithms: ["HS256"],
        limits: { maxTokenBytes: 64 * 1024, maxPayloadBytes: 1024 },
      }).verify(token),
    "too_large",
  );
});

// DB-REV-JWT-7: createVerifier accepted tokens with no lifetime at all.
Deno.test("a token without exp is refused by default", async () => {
  const secret = generateSecret("HS256");
  const bare = await sign({ sub: "a" }, secret, { alg: "HS256" });
  const aged = await sign({ sub: "a", iat: NOW / 1000 - 10 }, secret, {
    alg: "HS256",
  });
  const lasting = await sign({ sub: "a", exp: NOW / 1000 + 60 }, secret, {
    alg: "HS256",
  });
  const base = { keys: secret, algorithms: ["HS256" as const], now };
  await rejects(() => createVerifier(base).verify(bare), "missing_claim");
  await rejects(() => createVerifier(base).verify(aged), "missing_claim");
  await createVerifier(base).verify(lasting);
  // maxTokenAge bounds the lifetime through iat instead.
  await createVerifier({ ...base, maxTokenAge: 60 }).verify(aged);
  await rejects(
    () => createVerifier({ ...base, maxTokenAge: 60 }).verify(bare),
    "missing_claim",
  );
  // The explicit opt-out.
  await createVerifier({ ...base, requireExpiry: false }).verify(bare);
  assertThrows(
    () => createVerifier({ ...base, requireExpiry: "no" as never }),
    TypeError,
  );
});

Deno.test("maxLifetime caps how far away exp may be", async () => {
  const secret = generateSecret("HS256");
  const token = (exp: number) =>
    sign({ exp: NOW / 1000 + exp }, secret, { alg: "HS256" });
  const verifier = createVerifier({
    keys: secret,
    algorithms: ["HS256"],
    now,
    maxLifetime: 3600,
  });
  await verifier.verify(await token(3600));
  await rejects(
    async () => verifier.verify(await token(3601)),
    "invalid_claim",
  );
  await rejects(
    async () => verifier.verify(await token(10 * 365 * 86_400)),
    "invalid_claim",
  );
  // It needs exp, even where the verifier would not.
  const bare = await sign({}, secret, { alg: "HS256" });
  await rejects(
    () => verify(bare, secret, { algorithms: ["HS256"], now, maxLifetime: 60 }),
    "missing_claim",
  );
  assertThrows(
    () =>
      createVerifier({
        keys: secret,
        algorithms: ["HS256"],
        maxLifetime: NaN,
      }),
    RangeError,
  );
});
