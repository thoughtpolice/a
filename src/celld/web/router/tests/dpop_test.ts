// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// DB-RTR-001: the `dpop` scheme verifies the proof itself (RFC 9449
// section 4.3 and 7.1), so the token verifier is a plain access-token check
// and `jwtVerifier` is a correct one.

import { assert, assertEquals, assertThrows } from "@celld/core/assert";
import {
  generateSecret,
  JwtError,
  sign,
  signBytes,
  toBase64Url,
} from "@celld/sec/jwt";
import {
  AuthError,
  dpop,
  type DpopNonceStrategy,
  type DpopOptions,
  jwtVerifier,
  type ReplayStore,
  router,
  RouterError,
  type TokenRequest,
  unsafeMemoryReplayStore,
} from "@celld/web/router";
import {
  assertHeader,
  assertMatch,
  assertStatus,
  call,
  dpopProof,
  type ProofKey,
  proofKey,
  type ProofOptions,
} from "./fixture.ts";

const NOW = Date.UTC(2026, 8, 25, 12);
const clock = { now: NOW };
const now = () => clock.now;
const iat = () => Math.floor(clock.now / 1000);
const URL_ = "https://api.example.com/things";

const key = await proofKey();
const other = await proofKey();

/** Tokens and the thumbprints they are bound to. */
const BOUND: Record<string, string> = {
  "bound": key.jkt,
  "bound-other": other.jkt,
};

interface AppOptions {
  readonly replay?: ReplayStore;
  readonly nonce?: DpopNonceStrategy;
  readonly unsafeNoReplay?: true;
  readonly publicUrl?: DpopOptions["publicUrl"];
  readonly algs?: DpopOptions["algs"];
}

function app(options: AppOptions = {}) {
  const seen: TokenRequest[] = [];
  const verify = (request: TokenRequest) => {
    seen.push(request);
    const jkt = BOUND[request.token];
    if (jkt !== undefined) {
      return { subject: "ada", scopes: ["read"], cnf: { jkt } };
    }
    if (request.token === "unbound") return { subject: "ada" };
    return null;
  };
  const base = {
    verify,
    now,
    ...(options.publicUrl === undefined
      ? {}
      : { publicUrl: options.publicUrl }),
    ...(options.algs === undefined ? {} : { algs: options.algs }),
  };
  const scheme = options.unsafeNoReplay === true
    ? dpop({
      ...base,
      unsafeNoReplay: true,
      ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
    })
    : dpop({
      ...base,
      replay: options.replay ?? unsafeMemoryReplayStore({ now }),
      ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
    });
  const api = router({ auth: scheme });
  api.get("/things", (c) =>
    c.json({
      jkt: c.principal.cnf?.jkt ?? null,
      tokenType: c.principal.tokenType ?? null,
      scheme: c.principal.scheme,
    }));
  api.post("/things", (c) => c.text("made"));
  return { api, seen };
}

async function send(
  api: ReturnType<typeof app>["api"],
  token: string,
  proof: string | null,
  options: { method?: string; url?: string } = {},
) {
  const url = new URL(options.url ?? URL_);
  return await call(api, url.pathname + url.search, {
    method: options.method ?? "GET",
    origin: url.origin,
    headers: {
      authorization: `DPoP ${token}`,
      ...(proof === null ? {} : { dpop: proof }),
    },
  });
}

function proof(
  options: ProofOptions = {},
  by: ProofKey = key,
): Promise<string> {
  return dpopProof(by, { token: "bound", now: clock.now, ...options });
}

function assertProofRefused(
  answer: Awaited<ReturnType<typeof send>>,
  description: string,
  code = "invalid_dpop_proof",
): void {
  assertStatus(answer, 401);
  const challenge = answer.headers.get("www-authenticate") ?? "";
  assert(
    challenge.includes(`error="${code}"`) &&
      challenge.includes(`error_description="${description}"`),
    `challenge ${challenge} should say ${code}: ${description}`,
  );
}

Deno.test("a good proof for a bound token passes; the principal is a DPoP one", async () => {
  const { api, seen } = app();
  const answer = await send(api, "bound", await proof());
  assertStatus(answer, 200);
  assertEquals(answer.json, {
    jkt: key.jkt,
    tokenType: "DPoP",
    scheme: "dpop",
  });
  assertEquals(seen.length, 1);
  assertEquals(seen[0].scheme, "DPoP");
  assertEquals(seen[0].token, "bound");
  assert(!("proof" in seen[0]), "the token verifier gets no proof");
});

Deno.test("jwtVerifier composes with dpop, and a fake proof is refused (the audit's probe)", async () => {
  const secret = generateSecret("HS256");
  const verify = jwtVerifier({
    keys: secret,
    issuer: "https://as.example.com",
    audience: "https://api.example.com",
    algorithms: ["HS256"],
    now,
  });
  const api = router({
    auth: dpop({ verify, replay: unsafeMemoryReplayStore({ now }), now }),
  });
  api.get("/things", (c) => c.json({ jkt: c.principal.cnf?.jkt }));
  const token = await sign(
    {
      sub: "ada",
      iss: "https://as.example.com",
      aud: "https://api.example.com",
      cnf: { jkt: key.jkt },
    },
    secret,
    { alg: "HS256", typ: "at+jwt", expiresIn: 300, now },
  );
  assertHeader(
    await send(api, token, "a.b.c"),
    "www-authenticate",
    `DPoP algs="ES256 RS256 PS256", error="invalid_dpop_proof", error_description="the DPoP proof is not a JWT"`,
  );
  // A well-formed JWS that is not a signed proof.
  assertProofRefused(
    await send(api, token, "eyJhbGciOiJFUzI1NiJ9.eyJodG0iOiJHRVQifQ.c2ln"),
    "the DPoP proof's typ is not dpop+jwt",
  );
  const good = await send(
    api,
    token,
    await dpopProof(key, { token, now: NOW }),
  );
  assertStatus(good, 200);
  assertEquals(good.json, { jkt: key.jkt });

  const wrongType = await sign(
    {
      sub: "ada",
      iss: "https://as.example.com",
      aud: "https://api.example.com",
      cnf: { jkt: key.jkt },
    },
    secret,
    { alg: "HS256", typ: "JWT", expiresIn: 300, now },
  );
  assertHeader(
    await send(
      api,
      wrongType,
      await dpopProof(key, { token: wrongType, now: NOW }),
    ),
    "www-authenticate",
    `DPoP algs="ES256 RS256 PS256", error="invalid_token", error_description="the access token has the wrong type"`,
  );
});

Deno.test("a proof by another key than the token's cnf.jkt is refused", async () => {
  const { api } = app();
  assertProofRefused(
    await send(api, "bound", await proof({}, other)),
    "the DPoP proof's key is not the one the token is bound to",
  );
  // The other key's own token passes with its own proof.
  assertStatus(
    await send(
      api,
      "bound-other",
      await proof({ token: "bound-other" }, other),
    ),
    200,
  );
});

Deno.test("an unbound token is refused even with a good proof", async () => {
  const { api } = app();
  const answer = await send(api, "unbound", await proof({ token: "unbound" }));
  assertStatus(answer, 401);
  assertHeader(
    answer,
    "www-authenticate",
    'DPoP algs="ES256 RS256 PS256", error="invalid_token", error_description="the access token is not DPoP-bound"',
  );
});

Deno.test("htu must be the request URL, ignoring query and fragment", async () => {
  const { api } = app();
  for (
    const url of [
      "https://api.example.com/other",
      "https://evil.example.com/things",
      "http://api.example.com/things",
      "https://api.example.com:8443/things",
      "not a url",
    ]
  ) {
    assertProofRefused(
      await send(api, "bound", await proof({ url })),
      "htu does not match the request URL",
    );
  }
  assertProofRefused(
    await send(api, "bound", await proof({ claims: { htu: 7 } })),
    "htu does not match the request URL",
  );
  // Normalization: default port, case of scheme and host, query ignored.
  for (
    const url of [
      "HTTPS://API.EXAMPLE.COM:443/things",
      "https://api.example.com/things?x=1#f",
    ]
  ) {
    assertStatus(await send(api, "bound", await proof({ url })), 200);
  }
  assertStatus(
    await send(api, "bound", await proof(), { url: `${URL_}?page=2` }),
    200,
  );
});

Deno.test("htu is checked against publicUrl behind a proxy", async () => {
  const external = new URL("https://public.example.com/api/things");
  const { api } = app({
    publicUrl: (c) =>
      new URL(`https://public.example.com/api${c.url.pathname}`),
  });
  assertStatus(
    await send(api, "bound", await proof({ url: external.href })),
    200,
  );
  assertProofRefused(
    await send(api, "bound", await proof({ url: URL_ })),
    "htu does not match the request URL",
  );
});

Deno.test("htm must be the request method", async () => {
  const { api } = app();
  assertProofRefused(
    await send(api, "bound", await proof({ method: "GET" }), {
      method: "POST",
    }),
    "htm is not POST",
  );
  assertProofRefused(
    await send(api, "bound", await proof({ method: "get" })),
    "htm is not GET",
  );
  assertStatus(
    await send(api, "bound", await proof({ method: "POST" }), {
      method: "POST",
    }),
    200,
  );
});

Deno.test("ath must hash the access token", async () => {
  const { api } = app();
  assertProofRefused(
    await send(api, "bound", await proof({ token: "another-token" })),
    "ath does not match the access token",
  );
  assertProofRefused(
    await send(api, "bound", await proof({ claims: { ath: undefined } })),
    "the DPoP proof has no ath",
  );
});

Deno.test("iat must be recent and not in the future", async () => {
  const { api } = app();
  assertProofRefused(
    await send(api, "bound", await proof({ iat: iat() - 120 })),
    "the DPoP proof is too old",
  );
  assertProofRefused(
    await send(api, "bound", await proof({ iat: iat() + 60 })),
    "the DPoP proof is from the future",
  );
  assertProofRefused(
    await send(api, "bound", await proof({ claims: { iat: "now" } })),
    "the DPoP proof's claims are malformed",
  );
  // Within the window and the tolerance.
  assertStatus(await send(api, "bound", await proof({ iat: iat() - 50 })), 200);
  assertStatus(await send(api, "bound", await proof({ iat: iat() + 3 })), 200);
});

Deno.test("a jti is accepted once", async () => {
  const { api } = app();
  const once = await proof();
  assertStatus(await send(api, "bound", once), 200);
  assertProofRefused(
    await send(api, "bound", once),
    "the DPoP proof has been used before",
  );
  // A fresh proof with the same jti is a replay too.
  const jti = "fixed-jti";
  assertStatus(await send(api, "bound", await proof({ jti })), 200);
  assertProofRefused(
    await send(api, "bound", await proof({ jti })),
    "the DPoP proof has been used before",
  );
  // A proof refused for another reason does not use up its jti.
  const spare = "spare-jti";
  assertProofRefused(
    await send(api, "bound-other", await proof({ jti: spare })),
    "ath does not match the access token",
  );
  assertStatus(await send(api, "bound", await proof({ jti: spare })), 200);
});

// DB-REV-RTR-1: the age check and the replay record agree on the last
// millisecond. A proof is accepted while `now <= (iat + maxAge + tol) *
// 1000`, and the store holds its jti while `now <= expiresAt`, so a
// replay at exactly that millisecond is refused as used, and one a
// millisecond later as too old.
Deno.test("a replay at the exact last millisecond of the window is refused", async () => {
  const start = clock.now;
  try {
    const { api } = app();
    const issued = iat();
    const once = await proof({ iat: issued });
    assertStatus(await send(api, "bound", once), 200);
    clock.now = issued * 1000 + 30_000;
    assertProofRefused(
      await send(api, "bound", once),
      "the DPoP proof has been used before",
    );
    clock.now = (issued + 60 + 5) * 1000;
    assertProofRefused(
      await send(api, "bound", once),
      "the DPoP proof has been used before",
    );
    clock.now = (issued + 60 + 5) * 1000 + 1;
    assertProofRefused(
      await send(api, "bound", once),
      "the DPoP proof is too old",
    );
  } finally {
    clock.now = start;
  }
});

Deno.test("a store that drops entries at expiresAt still refuses the last-millisecond replay", async () => {
  const start = clock.now;
  const held = new Map<string, number>();
  // The pre-contract convention (live while now < expiresAt).
  const strict: ReplayStore = {
    claim(key, expiresAt) {
      const until = held.get(key);
      if (until !== undefined && clock.now < until) {
        return Promise.resolve(false);
      }
      held.set(key, expiresAt);
      return Promise.resolve(true);
    },
  };
  try {
    const { api } = app({ replay: strict });
    const issued = iat();
    const once = await proof({ iat: issued });
    assertStatus(await send(api, "bound", once), 200);
    clock.now = (issued + 65) * 1000;
    assertProofRefused(
      await send(api, "bound", once),
      "the DPoP proof has been used before",
    );
  } finally {
    clock.now = start;
  }
});

Deno.test("ReplayStore contract: an entry is live while now <= expiresAt", async () => {
  const time = { now: 1_000 };
  const store = unsafeMemoryReplayStore({ now: () => time.now });
  assertEquals(await store.claim("k", 5_000), true);
  time.now = 5_000;
  assertEquals(await store.claim("k", 9_000), false, "live at expiresAt");
  time.now = 5_001;
  assertEquals(await store.claim("k", 9_000), true, "gone after it");
});

Deno.test("jti must be a short non-empty string", async () => {
  const { api } = app();
  const cases: [unknown, string][] = [
    [undefined, "the DPoP proof has no jti"],
    ["", "the DPoP proof's claims are malformed"],
    [7, "the DPoP proof's claims are malformed"],
    ["x".repeat(257), "the DPoP proof's jti is not valid"],
  ];
  for (const [jti, description] of cases) {
    assertProofRefused(
      await send(api, "bound", await proof({ claims: { jti } })),
      description,
    );
  }
});

Deno.test("the nonce strategy: a missing or stale nonce is use_dpop_nonce with a fresh one", async () => {
  let issued = 0;
  const nonce: DpopNonceStrategy = {
    issue: () => Promise.resolve(`n-${++issued}`),
    check: (value) => Promise.resolve(value === `n-${issued}`),
  };
  const { api, seen } = app({ nonce });
  const missing = await send(api, "bound", await proof());
  assertProofRefused(missing, "the DPoP proof needs a nonce", "use_dpop_nonce");
  const first = missing.headers.get("dpop-nonce");
  assertEquals(first, "n-1");
  const stale = await send(api, "bound", await proof({ nonce: "n-0" }));
  assertProofRefused(
    stale,
    "the DPoP proof's nonce is stale",
    "use_dpop_nonce",
  );
  const fresh = stale.headers.get("dpop-nonce")!;
  assertEquals(seen.length, 0, "the token is not checked before the nonce");
  const ok = await send(api, "bound", await proof({ nonce: fresh }));
  assertStatus(ok, 200);
  // Every answer to a DPoP request carries the next nonce.
  assertEquals(ok.headers.get("dpop-nonce"), `n-${issued}`);
});

Deno.test("a nonce does not stop an exact replay; a replay store does", async () => {
  const nonce: DpopNonceStrategy = {
    issue: () => Promise.resolve("current-nonce"),
    check: (value) => Promise.resolve(value === "current-nonce"),
  };
  const exact = await proof({ nonce: "current-nonce" });

  const unsafe = app({ nonce, unsafeNoReplay: true }).api;
  assertStatus(await send(unsafe, "bound", exact), 200);
  // The name is intentional: a captured proof remains reusable.
  assertStatus(await send(unsafe, "bound", exact), 200);

  const safe = app({ nonce }).api;
  assertStatus(await send(safe, "bound", exact), 200);
  assertProofRefused(
    await send(safe, "bound", exact),
    "the DPoP proof has been used before",
  );
});

Deno.test("the proof key must be a public asymmetric JWK that signed the proof", async () => {
  const { api } = app();
  const cases: [Record<string, unknown>, string][] = [
    [{ jwk: undefined }, "the DPoP proof has no jwk"],
    [
      { jwk: { ...key.jwk, d: "private" } },
      "the DPoP proof's jwk is not a public key",
    ],
    [
      { jwk: { kty: "oct", k: "c2VjcmV0" } },
      "the DPoP proof's jwk is not a public key",
    ],
    [{ jwk: other.jwk }, "the DPoP proof's signature does not verify"],
  ];
  for (const [header, description] of cases) {
    assertProofRefused(
      await send(api, "bound", await proof({ header })),
      description,
    );
  }
  // sign() refuses a non-object jwk itself now, so build that proof by hand;
  // decode refuses it too, before the scheme's own jwk check can run.
  const encode = (value: unknown) => toBase64Url(JSON.stringify(value));
  const signingInput = `${
    encode({ alg: key.alg, typ: "dpop+jwt", jwk: "key" })
  }.${encode({ jti: "raw", htm: "GET", htu: URL_, iat: iat() })}`;
  const raw = `${signingInput}.${
    toBase64Url(
      await signBytes(
        key.alg,
        key.privateKey,
        new TextEncoder().encode(signingInput),
      ),
    )
  }`;
  assertProofRefused(
    await send(api, "bound", raw),
    "the DPoP proof is not a JWT",
  );
  // A symmetric proof: signed with an HMAC key named in an oct jwk.
  const secret = generateSecret("HS256");
  const hmac = await sign(
    {
      jti: "h",
      htm: "GET",
      htu: URL_,
      iat: iat(),
    },
    secret,
    {
      alg: "HS256",
      typ: "dpop+jwt",
      header: { jwk: { kty: "oct", k: "c2VjcmV0" } },
    },
  );
  assertProofRefused(
    await send(api, "bound", hmac),
    "the DPoP proof's alg HS256 is not accepted",
  );
});

Deno.test("typ must be dpop+jwt and alg an accepted asymmetric one", async () => {
  const { api } = app();
  assertProofRefused(
    await send(api, "bound", await proof({ typ: "JWT" })),
    "the DPoP proof's typ is not dpop+jwt",
  );
  assertProofRefused(
    await send(api, "bound", await proof({ typ: null })),
    "the DPoP proof's typ is not dpop+jwt",
  );
  const es384 = await proofKey("ES384");
  const narrow = app({ algs: ["ES256"] });
  assertProofRefused(
    await send(narrow.api, "bound", await proof({}, es384)),
    "the DPoP proof's alg ES384 is not accepted",
  );
  const none = `${
    btoa(JSON.stringify({ alg: "none", typ: "dpop+jwt", jwk: key.jwk }))
      .replace(/=+$/, "")
  }.${btoa("{}").replace(/=+$/, "")}.`;
  assertProofRefused(
    await send(api, "bound", none),
    "the DPoP proof is malformed",
  );
});

Deno.test("missing, repeated, oversized and malformed proofs are refused before the token is checked", async () => {
  const { api, seen } = app();
  const good = await proof();
  const cases: [string | null, string][] = [
    [null, "the request has no DPoP proof"],
    [`${good}, ${good}`, "the DPoP proof is malformed"],
    ["not-a-jwt", "the DPoP proof is malformed"],
    [`${good}${"A".repeat(9000)}`, "the DPoP proof is too long"],
  ];
  for (const [value, description] of cases) {
    assertProofRefused(await send(api, "bound", value), description);
  }
  assertEquals(seen.length, 0);
});

Deno.test("a verifier's refusal and headers still reach the answer", async () => {
  const replay = unsafeMemoryReplayStore({ now });
  const api = router({
    auth: dpop({
      verify: ({ token }) =>
        token === "stale"
          ? new AuthError("invalid_token", "the token was revoked")
          : {
            subject: "ada",
            cnf: { jkt: key.jkt },
            headers: { "x-one": "1" },
          },
      replay,
      now,
    }),
  });
  api.get("/things", (c) => c.text("ok"));
  const refused = await send(api, "stale", await proof({ token: "stale" }));
  assertStatus(refused, 401);
  assertMatch(refused.json, { error: "invalid_token" });
  const ok = await send(api, "bound", await proof());
  assertStatus(ok, 200);
  assertHeader(ok, "x-one", "1");
});

// DB-RTR-009: unsupported cryptography is readiness/availability, never token validity.
Deno.test("an accepted alg the runtime lacks is consistently unavailable, never invalid_token", async () => {
  const ed = await proofKey("Ed25519");
  const edProof = () => dpopProof(ed, { token: "bound-ed", now: clock.now });
  BOUND["bound-ed"] = ed.jkt;
  const subtle = crypto.subtle;
  const verify = subtle.verify;
  // This runtime has Ed25519; make it act like one without.
  subtle.verify = function (algorithm, ...rest) {
    const name = typeof algorithm === "string" ? algorithm : algorithm.name;
    if (name === "Ed25519") {
      return Promise.reject(
        new DOMException("no Ed25519", "NotSupportedError"),
      );
    }
    return verify.call(subtle, algorithm, ...rest);
  } as typeof subtle.verify;
  try {
    const reported: unknown[] = [];
    const scheme = dpop({
      verify: (request) => {
        const jkt = BOUND[request.token];
        return jkt === undefined ? null : { subject: "ada", cnf: { jkt } };
      },
      now,
      algs: ["ES256", "Ed25519"],
      replay: unsafeMemoryReplayStore({ now }),
    });
    const api = router({
      auth: scheme,
      onError: (error) => void reported.push(error),
    });
    api.get("/things", (c) => c.text(c.principal.subject));
    let readinessError: unknown;
    try {
      await api.ready();
    } catch (error) {
      readinessError = error;
    }
    assert(
      readinessError instanceof JwtError &&
        readinessError.code === "runtime_unsupported",
      "unsupported crypto fails readiness before any request",
    );
    assertEquals(reported.length, 0);
    assertStatus(await send(api, "bound-ed", await edProof()), 503);
    assertEquals(reported.length, 1);
    for (let i = 0; i < 3; i++) {
      const response = await send(api, "bound-ed", await edProof());
      assertStatus(response, 503);
      assertEquals(response.headers.get("www-authenticate"), null);
    }
    assertEquals(
      reported.length,
      4,
      "availability errors stay visible to the operator",
    );
    assertStatus(await send(api, "bound", await proof()), 200);
  } finally {
    subtle.verify = verify;
    delete BOUND["bound-ed"];
  }
});

Deno.test("a dpop scheme needs replay or an explicit unsafe opt-out, and sane settings", () => {
  const verify = () => null;
  const replay = unsafeMemoryReplayStore();
  const nonce: DpopNonceStrategy = {
    issue: () => Promise.resolve("n"),
    check: () => Promise.resolve(true),
  };
  // deno-lint-ignore no-explicit-any
  const loose = (options: unknown) => dpop(options as any);
  assertThrows(
    () => loose({ verify }),
    RouterError,
    "replay store or unsafeNoReplay",
  );
  assertThrows(
    () => loose({ verify, nonce }),
    RouterError,
    "replay store or unsafeNoReplay",
  );
  assertThrows(
    () => loose({ verify, replay, unsafeNoReplay: true }),
    RouterError,
    "not both",
  );
  for (const unsafeNoReplay of [false, "yes", 1]) {
    assertThrows(
      () => loose({ verify, unsafeNoReplay }),
      RouterError,
      "literal true",
    );
  }
  assertThrows(() => loose({ replay }), RouterError, "verify");
  assertThrows(
    () => loose({ verify, replay: {} }),
    RouterError,
    "atomic replay store",
  );
  assertThrows(
    () => loose({ verify, nonce: () => "n" }),
    RouterError,
    "nonce strategy",
  );
  assertThrows(() => loose({ verify, replay, algs: [] }), RouterError, "algs");
  assertThrows(
    () => loose({ verify, replay, algs: ["HS256"] }),
    RouterError,
    "HS256",
  );
  assertThrows(
    () => loose({ verify, replay, algs: ["none"] }),
    RouterError,
    "none",
  );
  for (const maxAgeSec of [Number.NaN, -1, 0, Infinity, 1.5, 100_000]) {
    assertThrows(() => loose({ verify, replay, maxAgeSec }), RangeError);
  }
  for (const clockToleranceSec of [Number.NaN, -1, Infinity, 100_000]) {
    assertThrows(
      () => loose({ verify, replay, clockToleranceSec }),
      RangeError,
    );
  }
  dpop({ verify, replay });
  dpop({ verify, replay, nonce });
  dpop({ verify, unsafeNoReplay: true });
  dpop({ verify, unsafeNoReplay: true, nonce });
});

Deno.test("unsafeMemoryReplayStore is bounded and fails closed when full", async () => {
  const time = { now: 1_000 };
  const store = unsafeMemoryReplayStore({ maxEntries: 2, now: () => time.now });
  assertEquals(await store.claim("a", 5_000), true);
  assertEquals(await store.claim("a", 5_000), false);
  assertEquals(await store.claim("b", 5_000), true);
  // Full of live entries: a new key is refused rather than evicting one
  // that could then be replayed.
  assertEquals(await store.claim("c", 5_000), false);
  time.now = 6_000;
  assertEquals(await store.claim("c", 9_000), true);
  assertEquals(await store.claim("a", 9_000), true);
  assertThrows(() => unsafeMemoryReplayStore({ maxEntries: 0 }), RangeError);
});
