// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Regressions for the Daybreak audit's JWT findings (DB-JWT-001 to 008 and
 * the `RemoteJwks` half of DB-NET-001). Each test names its finding.
 *
 * @module
 */

import { assert, assertEquals } from "@celld/core/assert";
import { bytes, millis } from "@celld/core/bounds";
import {
  createVerifier,
  decode,
  exportPublicJwk,
  generateKeyPair,
  generateSecret,
  importJwk,
  type Jwk,
  jwkFits,
  JwtError,
  localJwks,
  publicJwk,
  RemoteJwks,
  type RemoteJwksOptions,
  sign,
  toBase64Url,
  verify,
  type VerifyOptions,
} from "@celld/sec/jwt";
import { part, rejects } from "./fixture.ts";

const NOW = 1_790_000_000_000;
const now = () => NOW;
const secs = NOW / 1000;
const SECRET = new Uint8Array(32).fill(7);
const HS: VerifyOptions = { algorithms: ["HS256"], now };

/** Resolves with the outcome of `promise`, or "timeout" after `ms`. */
async function within<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ value: T } | { error: unknown } | "timeout"> {
  let timer: number | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([
      promise.then((value) => ({ value }), (error) => ({ error })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Asserts that `fn` throws (or rejects with) something other than a JwtError. */
async function throwsConfig(fn: () => unknown, what: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assert(
      error instanceof RangeError || error instanceof TypeError,
      `${what}: expected a RangeError or TypeError, got ${error}`,
    );
    return;
  }
  throw new Error(`${what}: expected a throw, got success`);
}

// ----- DB-JWT-001 -----

Deno.test("DB-JWT-001: publicJwk refuses an HMAC secret", async () => {
  const k = toBase64Url(generateSecret("HS256"));
  await rejects(() => publicJwk({ kty: "oct", k }), "secret_key");
  await rejects(
    () => publicJwk({ kty: "oct", k, alg: "HS256", kid: "s" }),
    "secret_key",
  );
});

Deno.test("DB-JWT-001: exportPublicJwk refuses a secret key", async () => {
  const key = await crypto.subtle.importKey(
    "raw",
    generateSecret("HS256"),
    { name: "HMAC", hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  await rejects(() => exportPublicJwk(key), "secret_key");
});

Deno.test("DB-JWT-001: no public output carries a member named k", async () => {
  const outputs: unknown[] = [];
  for (const alg of ["ES256", "RS256", "PS256", "EdDSA"] as const) {
    const pair = await generateKeyPair(alg, { extractable: true });
    outputs.push(pair.publicJwk);
    outputs.push(await exportPublicJwk(pair.privateKey));
    outputs.push(
      publicJwk(await crypto.subtle.exportKey("jwk", pair.privateKey) as Jwk),
    );
  }
  for (const output of outputs) {
    assert(!Object.hasOwn(output as object, "k"), JSON.stringify(output));
    assert(!Object.hasOwn(output as object, "d"), JSON.stringify(output));
  }
});

// ----- DB-JWT-002 -----

Deno.test("DB-JWT-002: a ten-year-future iat is refused, with or without maxTokenAge", async () => {
  const decade = 10 * 365 * 86_400;
  const token = await sign(
    { iat: secs + decade, exp: secs + decade + 300 },
    SECRET,
    { alg: "HS256" },
  );
  await rejects(() => verify(token, SECRET, HS), "not_yet_valid");
  await rejects(
    () => verify(token, SECRET, { ...HS, maxTokenAge: 600 }),
    "not_yet_valid",
  );
  // Within the tolerance it passes.
  const skewed = await sign({ iat: secs + 5 }, SECRET, { alg: "HS256" });
  await verify(skewed, SECRET, { ...HS, clockTolerance: 5 });
  await rejects(() => verify(skewed, SECRET, HS), "not_yet_valid");
});

// ----- DB-JWT-003 / DB-NET-001 -----

const JWKS_URL = "https://issuer.example/jwks";

Deno.test("DB-JWT-003: a refetch storm while the JWKS endpoint is down is bounded by backoff", async () => {
  const pair = await generateKeyPair("ES256", { kid: "k" });
  const token = await sign({}, pair.privateKey, { alg: "ES256", kid: "k" });
  let clock = 0;
  let fetches = 0;
  const jwks = new RemoteJwks(JWKS_URL, {
    fetch: () => {
      fetches++;
      return Promise.reject(new TypeError("down"));
    },
    now: () => clock,
    cooldownMs: 30_000,
  });
  // One verification every 100 ms for a minute.
  for (; clock < 60_000; clock += 100) {
    await rejects(
      () => verify(token, jwks, { algorithms: ["ES256"], now: clock }),
      "jwks",
    );
  }
  // Backoff 1, 2, 4, 8, 16 then the 30 s cooldown: attempts at
  // 0, 1, 3, 7, 15, 31 seconds.
  assert(fetches <= 7, `${fetches} fetches in a minute`);
  assert(fetches >= 5, `${fetches} fetches: it must keep trying`);
});

Deno.test("DB-JWT-003: a hung JWKS fetch does not block verification past the deadline", async () => {
  const pair = await generateKeyPair("ES256", { kid: "k" });
  const token = await sign({}, pair.privateKey, { alg: "ES256", kid: "k" });
  const jwks = new RemoteJwks(JWKS_URL, {
    // Never answers, and ignores the abort signal.
    fetch: () => new Promise<Response>(() => {}),
    egress: { timeoutMs: millis(100) },
  });
  const started = Date.now();
  const outcome = await within(
    Promise.all([
      verify(token, jwks, { algorithms: ["ES256"] }),
      verify(token, jwks, { algorithms: ["ES256"] }),
      jwks.refresh(),
    ]),
    3000,
  );
  assert(outcome !== "timeout", "verification hung on the JWKS fetch");
  assert("error" in outcome, "a hung fetch cannot succeed");
  const error = outcome.error;
  assert(
    error instanceof JwtError && error.code === "jwks",
    `expected a jwks error, got ${error}`,
  );
  assert(Date.now() - started < 2000, "failed at the deadline");
});

Deno.test("DB-JWT-003: during an outage known kids keep verifying, unknown kids fail", async () => {
  const pair = await generateKeyPair("ES256", { kid: "known" });
  const other = await generateKeyPair("ES256", { kid: "unknown" });
  let clock = 0;
  let up = true;
  let fetches = 0;
  const jwks = new RemoteJwks(JWKS_URL, {
    maxStaleMs: 3_600_000,
    fetch: () => {
      fetches++;
      return up
        ? Promise.resolve(Response.json({ keys: [pair.publicJwk] }))
        : Promise.reject(new TypeError("down"));
    },
    now: () => clock,
    maxAgeMs: 1000,
    cooldownMs: 1000,
  });
  const known = await sign({}, pair.privateKey, { alg: "ES256", kid: "known" });
  const unknown = await sign({}, other.privateKey, {
    alg: "ES256",
    kid: "unknown",
  });
  const options = { algorithms: ["ES256" as const] };
  await verify(known, jwks, options);
  up = false;
  clock = 5000;
  // The set is stale and the refresh fails: the last good set still serves.
  await verify(known, jwks, options);
  await rejects(() => verify(unknown, jwks, options), "jwks");
  assertEquals(fetches, 2, "one failed refresh, then backoff");
  up = true;
  clock = 7000;
  await verify(known, jwks, options);
  assertEquals(fetches, 3, "recovers after the backoff");
});

/** A body that never ends, counting the chunks pulled. */
function endless(state: { pulls: number }): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull(controller) {
      state.pulls++;
      controller.enqueue(new Uint8Array(1024).fill(0x20));
    },
  });
}

Deno.test("DB-NET-001: an endless JWKS body stops at the byte cap", async () => {
  const state = { pulls: 0 };
  const jwks = new RemoteJwks(JWKS_URL, {
    fetch: () => Promise.resolve(new Response(endless(state))),
    egress: { maxBytes: bytes(16 * 1024) },
  });
  const outcome = await within(jwks.refresh(), 3000);
  assert(outcome !== "timeout", "read the endless body");
  assert("error" in outcome, "cannot succeed");
  assert(
    outcome.error instanceof JwtError && outcome.error.code === "jwks",
    String(outcome.error),
  );
  assert(state.pulls <= 32, `${state.pulls} chunks pulled`);
});

Deno.test("DB-NET-001: a JWKS with too many keys is refused", async () => {
  const pair = await generateKeyPair("ES256");
  const keys = Array.from(
    { length: 200 },
    (_, i) => ({ ...pair.publicJwk, kid: `k${i}` }),
  );
  const jwks = new RemoteJwks(JWKS_URL, {
    fetch: () => Promise.resolve(Response.json({ keys })),
  });
  await rejects(() => jwks.refresh(), "jwks");
});

Deno.test("DB-NET-001: redirects are refused", async () => {
  const seen: (RequestRedirect | undefined)[] = [];
  const jwks = new RemoteJwks(JWKS_URL, {
    fetch: (_input, init) => {
      seen.push(init?.redirect);
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://169.254.169.254/latest/meta-data" },
        }),
      );
    },
  });
  await rejects(() => jwks.refresh(), "jwks");
  assertEquals(seen, ["manual"], "the platform never follows the redirect");
});

Deno.test("DB-NET-001: private and link-local JWKS hosts are refused", async () => {
  for (
    const url of [
      "https://169.254.169.254/jwks",
      "https://10.0.0.1/jwks",
      "https://[fd00::1]/jwks",
      "https://user:pass@issuer.example/jwks",
      "https://issuer.example/jwks#frag",
      "http://issuer.example/jwks",
    ]
  ) {
    await throwsConfig(() => new RemoteJwks(url), url);
  }
});

// ----- DB-JWT-004 -----

Deno.test("DB-JWT-004: non-finite clocks and tolerances are refused", async () => {
  const expired = await sign({ exp: secs - 3600 }, SECRET, { alg: "HS256" });
  await throwsConfig(
    () => verify(expired, SECRET, { ...HS, clockTolerance: NaN }),
    "clockTolerance NaN",
  );
  await throwsConfig(
    () => verify(expired, SECRET, { ...HS, clockTolerance: Infinity }),
    "clockTolerance Infinity",
  );
  await throwsConfig(
    () => verify(expired, SECRET, { ...HS, clockTolerance: -1 }),
    "clockTolerance negative",
  );
  await throwsConfig(
    () => verify(expired, SECRET, { algorithms: ["HS256"], now: NaN }),
    "now NaN",
  );
  await throwsConfig(
    () => verify(expired, SECRET, { algorithms: ["HS256"], now: () => NaN }),
    "now() NaN",
  );
  await throwsConfig(
    () =>
      verify(expired, SECRET, {
        algorithms: ["HS256"],
        now: new Date(Number.NaN),
      }),
    "now invalid Date",
  );
  const old = await sign({ iat: secs - 3600 }, SECRET, { alg: "HS256" });
  await throwsConfig(
    () => verify(old, SECRET, { ...HS, maxTokenAge: NaN }),
    "maxTokenAge NaN",
  );
  await throwsConfig(
    () => verify(old, SECRET, { ...HS, maxTokenAge: Infinity }),
    "maxTokenAge Infinity",
  );
});

Deno.test("DB-JWT-004: RemoteJwks refuses bad numbers at construction", async () => {
  for (
    const options of [
      { cooldownMs: NaN },
      { cooldownMs: -1 },
      { maxAgeMs: Infinity },
      { maxAgeMs: NaN },
      { maxKeys: 0 },
      { maxKeys: 1.5 },
    ]
  ) {
    await throwsConfig(
      () => new RemoteJwks(JWKS_URL, options as RemoteJwksOptions),
      JSON.stringify(options),
    );
  }
});

Deno.test("DB-JWT-004: signing offsets and clocks must be finite", async () => {
  for (
    const options of [
      { expiresIn: NaN },
      { expiresIn: Infinity },
      { notBefore: NaN },
      { now: NaN },
    ]
  ) {
    await throwsConfig(
      () => sign({}, SECRET, { alg: "HS256", ...options }),
      JSON.stringify(options),
    );
  }
});

// ----- DB-JWT-005 -----

Deno.test("DB-JWT-005: b64 is refused when signing", async () => {
  await rejects(
    () =>
      sign({}, SECRET, {
        alg: "HS256",
        header: { b64: false, crit: ["b64"] },
      }),
    "unsupported",
  );
  await rejects(
    () => sign({}, SECRET, { alg: "HS256", header: { b64: true } }),
    "unsupported",
  );
});

/** An HS256 token over `header` without going through `sign`'s checks. */
async function rawHs(
  header: Record<string, unknown>,
  claims: Record<string, unknown> = {},
): Promise<string> {
  const input = `${part({ alg: "HS256", ...header })}.${part(claims)}`;
  const key = await crypto.subtle.importKey(
    "raw",
    SECRET,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(input),
  );
  return `${input}.${toBase64Url(new Uint8Array(signature))}`;
}

Deno.test("DB-JWT-005: b64 is refused when verifying", async () => {
  const token = await rawHs({ b64: false, crit: ["b64"] });
  await rejects(
    () =>
      verify(token, SECRET, {
        ...HS,
        crit: { b64: () => {} },
      }),
    "unsupported",
  );
});

Deno.test("DB-JWT-005: duplicate, absent and registered crit names are refused", async () => {
  const options: VerifyOptions = {
    ...HS,
    crit: { ext: () => {}, alg: () => {}, kid: () => {} },
  };
  await verify(await rawHs({ crit: ["ext"], ext: 1 }), SECRET, options);
  for (
    const header of [
      { crit: ["ext", "ext"], ext: 1 },
      { crit: ["ext"] },
      { crit: ["alg"] },
      { crit: ["kid"], kid: "a" },
    ]
  ) {
    const token = await rawHs(header);
    await rejects(() => verify(token, SECRET, options), "crit");
  }
});

Deno.test("DB-JWT-005: crit names need a processor, which may refuse", async () => {
  const token = await rawHs({ crit: ["ext"], ext: 5 });
  await rejects(() => verify(token, SECRET, HS), "crit");
  let seen: unknown;
  await verify(token, SECRET, {
    ...HS,
    crit: {
      ext: (_header, value) => {
        seen = value;
      },
    },
  });
  assertEquals(seen, 5);
  await rejects(
    () =>
      verify(token, SECRET, {
        ...HS,
        crit: {
          ext: () => {
            throw new Error("ext must be 4");
          },
        },
      }),
    "crit",
  );
});

Deno.test("DB-JWT-005: sign validates crit like verify does", async () => {
  for (
    const header of [
      { crit: ["ext", "ext"], ext: 1 },
      { crit: ["ext"] },
      { crit: ["alg"] },
      { crit: [] },
    ]
  ) {
    await rejects(
      () => sign({}, SECRET, { alg: "HS256", header }),
      header.crit.length === 0 ? "malformed" : "crit",
    );
  }
});

// ----- DB-JWT-006 -----

Deno.test("DB-JWT-006: key_ops must allow verification", async () => {
  const pair = await generateKeyPair("ES256", { kid: "k" });
  const token = await sign({}, pair.privateKey, { alg: "ES256", kid: "k" });
  const options = { algorithms: ["ES256" as const] };
  const verifying = { ...pair.publicJwk, key_ops: ["verify"] };
  await verify(token, verifying, options);
  const imported = await importJwk(verifying, "ES256", "verify");
  assertEquals(imported.usages, ["verify"]);
  for (
    const key_ops of [
      ["encrypt"],
      ["sign"],
      [],
      ["verify", "verify"],
      "verify",
      [1],
    ]
  ) {
    const jwk = { ...pair.publicJwk, key_ops } as Jwk;
    await rejects(() => verify(token, jwk, options), "key_mismatch");
    await rejects(() => verify(token, { keys: [jwk] }, options), "no_key");
  }
  // key_ops that contradict use.
  const contradictory = {
    ...pair.publicJwk,
    use: "enc",
    key_ops: ["verify"],
  } as Jwk;
  await rejects(() => verify(token, contradictory, options), "key_mismatch");
  assert(
    !jwkFits({ kty: "EC", crv: "P-256", key_ops: ["encrypt"] }, "ES256"),
    "jwkFits",
  );
});

Deno.test("DB-JWT-006: key_ops carries through signing and publicJwk", async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const privateJwk = await crypto.subtle.exportKey(
    "jwk",
    pair.privateKey,
  ) as Jwk;
  assertEquals(privateJwk.key_ops, ["sign"]);
  // A signing key verifies as its public half.
  assertEquals(publicJwk(privateJwk).key_ops, ["verify"]);
  await sign({}, privateJwk, { alg: "ES256" });
  await rejects(
    () =>
      sign({}, { ...privateJwk, key_ops: ["verify"] }, {
        alg: "ES256",
      }),
    "key_mismatch",
  );
});

// ----- DB-JWT-007 -----

Deno.test("DB-JWT-007: a non-string kid is malformed", async () => {
  const token = await rawHs({ kid: 5 });
  const set = { keys: [{ kty: "oct", k: toBase64Url(SECRET), alg: "HS256" }] };
  await rejects(() => decode(token), "malformed");
  await rejects(() => verify(token, set, HS), "malformed");
  await rejects(
    () => localJwks(set).resolve({ alg: "HS256", kid: 5 as never }, "HS256"),
    "malformed",
  );
  await rejects(
    () => sign({}, SECRET, { alg: "HS256", header: { kid: 5 } }),
    "malformed",
  );
});

Deno.test("DB-JWT-007: recognized header fields are type-checked", async () => {
  for (
    const header of [
      { typ: 5 },
      { cty: [] },
      { jku: 1 },
      { x5u: {} },
      { x5t: 1 },
      { "x5t#S256": null },
      { x5c: "cert" },
      { x5c: [1] },
      { jwk: "key" },
      { jwk: [] },
    ]
  ) {
    const token = await rawHs(header);
    await rejects(() => decode(token), "malformed");
  }
});

Deno.test("DB-JWT-007: a duplicate kid is ambiguous", async () => {
  const first = await generateKeyPair("ES256", { kid: "same" });
  const second = await generateKeyPair("ES256", { kid: "same" });
  const token = await sign({}, second.privateKey, {
    alg: "ES256",
    kid: "same",
  });
  const set = { keys: [first.publicJwk, second.publicJwk] };
  await rejects(
    () => verify(token, set, { algorithms: ["ES256"] }),
    "ambiguous_key",
  );
  await rejects(
    () => verify(token, localJwks(set), { algorithms: ["ES256"] }),
    "ambiguous_key",
  );
});

Deno.test("DB-JWT-007: an alg-less RSA key cannot serve both RS256 and PS256", async () => {
  const rs = await generateKeyPair("RS256", { extractable: true });
  const jwk = await crypto.subtle.exportKey("jwk", rs.publicKey) as Jwk;
  const { alg: _alg, key_ops: _ops, ext: _ext, ...bare } = jwk;
  const privateJwk = await crypto.subtle.exportKey(
    "jwk",
    rs.privateKey,
  ) as Jwk;
  const { alg: _a, key_ops: _o, ext: _e, ...privateBare } = privateJwk;
  const both = { algorithms: ["RS256", "PS256"] as ("RS256" | "PS256")[] };
  const rsToken = await sign({}, privateBare, { alg: "RS256" });
  const psToken = await sign({}, privateBare, { alg: "PS256" });
  const forms: [string, () => Parameters<typeof verify>[1]][] = [
    ["jwk", () => bare],
    ["jwks", () => ({ keys: [bare] })],
    ["localJwks", () => localJwks({ keys: [bare] })],
  ];
  for (const [name, key] of forms) {
    const outcomes: string[] = [];
    for (const token of [rsToken, psToken]) {
      outcomes.push(
        await verify(token, key(), both).then(
          () => "ok",
          (error) => error.code,
        ),
      );
    }
    const accepted = outcomes.filter((outcome) => outcome === "ok").length;
    assert(accepted <= 1, `${name} served both schemes: ${outcomes}`);
  }
  // Given alone, the key is bound by the policy (a DPoP proof's jwk).
  await verify(psToken, bare, { algorithms: ["PS256"] });
  await verify(rsToken, bare, { algorithms: ["RS256"] });
  await rejects(() => verify(psToken, bare, both), "ambiguous_key");
  // In a set, it is RS* only.
  await verify(rsToken, { keys: [bare] }, both);
  await rejects(() => verify(psToken, { keys: [bare] }, both), "no_key");
});

Deno.test("DB-JWT-007: verify needs a nonempty algorithm list", async () => {
  const token = await sign({}, SECRET, { alg: "HS256" });
  await throwsConfig(
    () => verify(token, SECRET, { algorithms: [] }),
    "empty algorithms",
  );
  await throwsConfig(
    () => verify(token, SECRET, {} as VerifyOptions),
    "no algorithms",
  );
  await throwsConfig(
    () =>
      verify(token, SECRET, {
        algorithms: ["none"],
      } as unknown as VerifyOptions),
    "unknown algorithm",
  );
});

// ----- DB-JWT-008 -----

Deno.test("DB-JWT-008: oversized tokens are refused before decoding", async () => {
  const big = "A".repeat(70 * 1024);
  const header = part({ alg: "HS256" });
  await rejects(() => decode(`${header}.${big}.c2ln`), "too_large");
  await rejects(
    () => decode(`${part({ alg: "HS256", pad: "x".repeat(5000) })}.e30.c2ln`),
    "too_large",
  );
  await rejects(
    () => verify(`${header}.${big}.c2ln`, SECRET, HS),
    "too_large",
  );
  // A 10 MB string is refused on its length alone, quickly.
  const huge = "A".repeat(10 * 1024 * 1024);
  const started = performance.now();
  await rejects(() => decode(`${huge}.${huge}.${huge}`), "too_large");
  assert(performance.now() - started < 200, "refused on length");
  // Within the defaults a 6 KiB payload is fine.
  const fine = await sign({ blob: "x".repeat(5000) }, SECRET, { alg: "HS256" });
  await verify(fine, SECRET, HS);
});

// ----- WP-16 adversarial review (DB-REV-JWT-*) -----

// DB-REV-JWT-3: a fetched JWKS is public, so an `oct` key in it is a
// published secret; it verified HS256 tokens anyone could mint.
Deno.test("DB-REV-JWT-3: a remote JWKS never yields an HMAC key", async () => {
  const k = toBase64Url(SECRET);
  const token = await sign({ sub: "admin", iss: "i" }, SECRET, {
    alg: "HS256",
    kid: "h1",
  });
  for (
    const key of [
      { kty: "oct", k, kid: "h1" },
      { kty: "oct", k, kid: "h1", alg: "HS256" },
      // A member named k on any key marks it as a secret.
      { kty: "EC", crv: "P-256", k, kid: "h1" },
    ]
  ) {
    let fetches = 0;
    const remote = new RemoteJwks(JWKS_URL, {
      fetch: () => {
        fetches++;
        return Promise.resolve(Response.json({ keys: [key] }));
      },
      now,
    });
    await rejects(() => remote.refresh(), "jwks");
    // Asked for an HMAC key, the set is never consulted.
    const before = fetches;
    await rejects(
      () => remote.resolve({ alg: "HS256", kid: "h1" }, "HS256"),
      "key_mismatch",
    );
    assertEquals(fetches, before, "no fetch for an HMAC algorithm");
  }
  // A verifier that pairs a remote set with HS* is a configuration error.
  const remote = new RemoteJwks(JWKS_URL, {
    fetch: () => Promise.reject(new Error("unused")),
  });
  await throwsConfig(
    () =>
      createVerifier({
        keys: remote,
        algorithms: ["ES256", "HS256"],
        issuer: "i",
      }),
    "createVerifier with a RemoteJwks and HS256",
  );
  await throwsConfig(
    () => verify(token, remote, { algorithms: ["ES256", "HS256"], now }),
    "verify with a RemoteJwks and HS256",
  );
});

// DB-REV-JWT-6: presence was `claims[name] === undefined`, so names on
// Object.prototype always read as present.
Deno.test("DB-REV-JWT-6: requiredClaims ignores prototype names", async () => {
  const token = await sign({ sub: "a" }, SECRET, { alg: "HS256" });
  for (
    const name of [
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "__proto__",
    ]
  ) {
    await rejects(
      () => verify(token, SECRET, { ...HS, requiredClaims: [name] }),
      "missing_claim",
    );
  }
  await verify(token, SECRET, { ...HS, requiredClaims: ["sub"] });
});

// DB-REV-JWT-10: a NaN clock made every lookup a `jwks` error without a
// fetch, and a clock stepping backwards kept a set fresh past maxAgeMs.
Deno.test("DB-REV-JWT-10: RemoteJwks checks its clock", async () => {
  const pair = await generateKeyPair("ES256", { kid: "k" });
  const token = await sign({}, pair.privateKey, { alg: "ES256", kid: "k" });
  const serve = () =>
    Promise.resolve(Response.json({ keys: [pair.publicJwk] }));
  await throwsConfig(
    () => new RemoteJwks(JWKS_URL, { fetch: serve, now: () => NaN }),
    "a NaN clock at construction",
  );
  await throwsConfig(
    () =>
      new RemoteJwks(JWKS_URL, {
        fetch: serve,
        now: "soon" as unknown as () => number,
      }),
    "a clock that is not a function",
  );
  let clock = NOW;
  const broken = new RemoteJwks(JWKS_URL, { fetch: serve, now: () => clock });
  clock = NaN;
  await throwsConfig(
    () => verify(token, broken, { algorithms: ["ES256"], now }),
    "a clock that turns NaN",
  );
  // Backwards: the next lookup refetches instead of trusting the old set.
  clock = NOW;
  let fetches = 0;
  const jwks = new RemoteJwks(JWKS_URL, {
    fetch: () => {
      fetches++;
      return serve();
    },
    now: () => clock,
    maxAgeMs: 60_000,
    cooldownMs: 30_000,
  });
  await verify(token, jwks, { algorithms: ["ES256"], now });
  assertEquals(fetches, 1);
  clock = NOW - 3_600_000;
  await verify(token, jwks, { algorithms: ["ES256"], now });
  assertEquals(fetches, 2, "a clock that stepped back refetches");
  await verify(token, jwks, { algorithms: ["ES256"], now });
  assertEquals(fetches, 2, "then the new fetch time holds");
});

// Carry-over: checkUrl let `http:` through on `network` alone, and the
// egress fetch refused it later, as a runtime `jwks` error.
Deno.test("DB-REV-JWT carry-over: cleartext JWKS URLs are refused when configured", async () => {
  for (
    const egress of [
      { network: "loopback" as const },
      { network: "any" as const },
    ]
  ) {
    await throwsConfig(
      () => new RemoteJwks("http://127.0.0.1:8080/jwks", { egress }),
      `http: with ${JSON.stringify(egress)}`,
    );
  }
  await throwsConfig(
    () =>
      new RemoteJwks("http://localhost.localdomain/jwks", {
        allowLoopbackForDevelopment: true,
      }),
    "http: to a loopback name",
  );
  new RemoteJwks("http://127.0.0.1:8080/jwks", {
    egress: { network: "any", allowCleartextLoopbackForDevelopment: true },
  });
  new RemoteJwks("http://127.0.0.1:8080/jwks", {
    allowLoopbackForDevelopment: true,
  });
});
