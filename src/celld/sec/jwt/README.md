<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/sec/jwt

JSON Web Tokens for celld on WebCrypto. It decodes, signs and verifies
compact JWS tokens and fetches issuers' JWKS. It depends on
`@celld/core/bounds` (checked numbers and limits) and `@celld/http/egress` (the
bounded fetch behind `RemoteJwks`), uses no Node APIs and no `eval`, so it
runs in Workers-style isolates.

```python
celld.library(
    name = "api",
    srcs = glob(["src/*.ts"]),
    import_name = "@example/api",
    deps = ["root//src/celld/sec/jwt:jwt"],
)
```

```typescript
import {
  createVerifier,
  generateKeyPair,
  type JwtClaims,
  RemoteJwks,
  sign,
} from "@celld/sec/jwt";

const { privateKey, publicJwk } = await generateKeyPair("ES256", { kid: "k1" });
const token = await sign({ sub: "alice", aud: "api" }, privateKey, {
  alg: "ES256",
  kid: "k1",
  expiresIn: 300,
});

// Made once and reused: options checked, the key imported once.
const verifier = createVerifier({
  keys: publicJwk,
  algorithms: ["ES256"],
  audience: "api",
  requiredClaims: ["exp"],
});
const { payload } = await verifier.verify(token);

// An OAuth access token from an issuer that rotates its keys, refined to
// the caller's type instead of cast.
const accessTokens = createVerifier({
  keys: new RemoteJwks("https://auth.example.com/.well-known/jwks.json"),
  issuer: "https://auth.example.com",
  audience: "https://mcp.example.com/mcp",
  typ: "at+jwt",
  algorithms: ["RS256", "ES256"],
  clockTolerance: 30,
  requiredClaims: ["exp", "sub"],
  claims: (claims: JwtClaims) => {
    if (typeof claims.sub !== "string") throw new TypeError("no subject");
    return { sub: claims.sub, scope: String(claims.scope ?? "") };
  },
});
const { payload: caller } = await accessTokens.verify(accessToken);
```

Call `await verifier.ready()` before accepting traffic. It imports local keys,
loads a remote set when applicable, and runs the cached signing/verification
capability probe for every configured algorithm. `assertAlgorithmsSupported`
is the same probe for standalone signers. A failed runtime capability is a
cached `runtime_unsupported` configuration failure, not a bad credential; map
it to service unavailability. Construct a new verifier for each issuer,
audience, algorithm or key-policy generation. `Date`, JWKs, and policy arrays
are snapshotted; mutation after construction changes nothing.

## Algorithms and keys

HS256/384/512, RS256/384/512, PS256/384/512, ES256/384/512, and Ed25519
under both `EdDSA` (RFC 8037) and `Ed25519` (RFC 9864). `none` is never
accepted.

The runtime has the last word. celld cannot import an `oct` JWK
(pass HMAC secrets as bytes); its WebCrypto throws `NotSupportedError`
(see the toolchain's
[known runtime limitations](../../../../buck/toolchains/celld/README.md)).
Such a refusal is a `JwtError` with code `runtime_unsupported` and the
runtime's exception as its `cause`, from `verify`, `sign`, `verifyBytes`,
`signBytes` and `importJwk` alike, so it is never reported as
`bad_signature` or `key_mismatch`. It says the server cannot check the
token at all: answer it as a 500 and fix the configuration, rather than
telling the client its credential is bad.

A key is a `CryptoKey`, a JWK, or a `Uint8Array` HMAC secret.
`checkKey` holds every key to its algorithm. The WebCrypto algorithm,
hash and curve have to match, RSA keys need 2048 bits or more, HMAC secrets
need at least the hash's length, and the key has to allow the operation.
The classic confusion attack, where an RSA public key's bytes are used as an
HS256 secret, fails with `key_mismatch`. `sign` and `verify` pick up the
same rules.

A JWK's `key_ops`, when present, must be a non-empty list of distinct
strings that agrees with `use` (`sign`/`verify` with `sig`, neither with
`enc`) and allows the operation: `verify` for a public key, `sign` (or
`verify`) for a private one. WebCrypto gets `key_ops: [operation]`, so the
imported key carries the same restriction. An RSA JWK without `alg` fits
both RS* and PS* as a predicate (`jwkFits`), but is never used under both:
`verify` refuses it (`ambiguous_key`) when `algorithms` allows both
schemes, a key set serves it as RS* only, and `createVerifier` binds it to
one algorithm.

Helpers: `importKey`, `importJwk`, `jwkFits`, `publicJwk`,
`generateKeyPair`, `generateSecret`, `exportPublicJwk`, `jwkThumbprint`
(RFC 7638, a good `kid`), and the raw JWS steps `signBytes` and
`verifyBytes`. `publicJwk` and `exportPublicJwk` refuse symmetric keys
with `secret_key`: an HMAC secret has no public form, and nothing in this
library returns one as public material. `publicJwk` keeps an allowlist:
`kty`, the public members of RSA (`n`, `e`), EC (`crv`, `x`, `y`) and OKP
(`crv`, `x`) keys, and the metadata `kid`, `alg`, `use`, `key_ops`,
`x5c`, `x5t`, `x5t#S256` and `x5u`; every other member is dropped,
whatever its name, and any other `kty` (such as `AKP`, whose private key
is `priv`) is `key_mismatch`. It turns `key_ops` into the public
operations (`sign` becomes `verify`).

`sign` applies the header rules `decode` does (below), so it refuses
`b64` (`unsupported`) and a bad `crit`, and a non-finite `now`,
`expiresIn` or `notBefore` throws a `RangeError`.

## Verifying

`createVerifier(options)` is the API to use: it checks and copies the
options once, and returns a `JwtVerifier` whose `verify(token)` runs the
checks below. A single key (a `CryptoKey`, a JWK or an HMAC secret) is
imported once and bound to the one algorithm in `algorithms` it fits; it
is refused when it fits none (`key_mismatch`) or several (`ambiguous_key`,
say an HMAC secret with HS256 and HS512 both allowed), and a token under
another algorithm is `key_mismatch`. A JWKS is copied and its imports
cached; a `KeySet` such as `RemoteJwks` is used as it is. A token must
have `exp` (`missing_claim`) unless `maxTokenAge` is given, which bounds
its life through `iat`, or `requireExpiry: false` opts out: a token with
neither never expires.

`verify(token, key, options)` is the low-level form with the same checks,
except that `exp` is only required when asked for. It imports a JWK or
secret on every call; a JWKS object passed to it is read as it is at each
call, and its imports are cached by the keys' content, so a key replaced
in place is imported again, and no more imports are kept than the set has
keys.

Both take `algorithms`, a non-empty list with no default, and throw a
`TypeError` or `RangeError` for bad options: an empty or unknown
`algorithms`, a `NaN`, infinite or negative `clockTolerance` (at most a
day), `maxTokenAge`, `maxLifetime` or `now`, bad `limits`, or a
`RemoteJwks` with HS* in `algorithms`. Then, in order, a
`JwtError` whose `code` names the first failure:

1. It decodes (see [Decoding](#decoding)): `too_large`, `malformed`,
   `unsupported` for `b64`, or `crit` for a bad `crit` list.
2. `alg` is implemented (`unsupported_alg`) and in `algorithms`
   (`alg_not_allowed`).
3. Every name in `crit` has a processor in `options.crit`, a map from
   parameter name to `(header, value) => void`, and the processor does
   not throw (`crit`). `typ` is one of `options.typ` (`typ`); the
   comparison ignores case and an `application/` prefix.
4. The key fits (`key_mismatch`), a key set has exactly one
   (`no_key`, `ambiguous_key` when several share the `kid`, or `jwks`
   when the set could not be fetched), and the signature verifies
   (`bad_signature`). A signature WebCrypto rejects as malformed is
   `bad_signature` too; an algorithm the runtime cannot verify is
   `runtime_unsupported`.
5. The claims. `exp`, `nbf` and `iat` are checked whenever present, with
   `clockTolerance` seconds of slack: `expired`, `not_yet_valid` (also
   for any `iat` in the future, with or without `maxTokenAge`), and
   `too_old` past `maxTokenAge`. `maxLifetime` caps how far ahead `exp`
   may be (`invalid_claim`) and requires `exp`. Then `issuer`, `audience`
   and `subject`. `requiredClaims` makes claims mandatory
   (`missing_claim`); only the payload's own members count, so a name such
   as `constructor` is not present by inheritance. A registered claim of
   the wrong JSON type is `invalid_claim`. With `verify`, a token without
   `exp` never expires unless `requiredClaims` includes `"exp"`, which
   every example here does; `createVerifier` requires it by default.
6. `options.claims`, when given, turns the claims into the caller's type
   (a sieve schema's `parse`, say). It throwing is `invalid_claim` (a
   `JwtError` it throws passes through). Without it the payload is
   `JwtClaims`: nothing casts claims to a type they were not checked
   against.

A token that carries `aud` passes when `audience` is not set, as in jose.
Pass `audience` whenever tokens name one.

`jwks` means the server cannot get keys (answer 503), and
`runtime_unsupported` that it cannot check the token at all (answer 500);
neither says anything about the client's credential.

## Key sets

`verify` takes a JWKS object, `localJwks(jwks)`, or `new RemoteJwks(url)`.
A token with a `kid` gets the key with that `kid` that serves its `alg`,
and fails with `ambiguous_key` when several do. A token without one gets
the only key that serves, and fails when there are several, since guessing
would let the token choose its key. A non-string `kid` is `malformed`.

`RemoteJwks` fetches through `boundedFetch` (`@celld/http/egress`). The
default policy is `https:` only, no redirects (the request goes out with
`redirect: "manual"` and a 3xx is an error), a 5 second deadline over the
whole fetch including the body, 256 KiB of body read as a stream whatever
`Content-Length` says, and public hosts only: a URL naming a loopback,
private, link-local or other local address, or carrying credentials or a
fragment, is refused by the constructor (`TypeError`) and again by every
request. A set may hold at most `maxKeys` keys (64). `egress` overrides
parts of the policy (`timeoutMs`, `maxBytes`, `allow`, `network`, a
`budget`); `allowLoopbackForDevelopment` is the development override that
allows loopback hosts (`network: "loopback"` with
`allowCleartextLoopbackForDevelopment`), over `http:` only as an IP
literal such as `http://127.0.0.1:8080`; `localhost` still needs `https:`.
The constructor applies the egress rules to the URL, so an `http:` URL
without `allowCleartextLoopbackForDevelopment` (a `network` of its own is
not enough) is a `TypeError` there, not a `jwks` error at the first fetch.

A fetched set is public, so a symmetric key in it (`kty: "oct"`, or any
key with a `k`) is a secret anyone can read: the whole set is refused
(`jwks`), as it is for a private member (`d`, `p`, `q`, `dp`, `dq`, `qi`,
`oth`, `priv`) on any key. A set may also publish encryption keys (OpenID
Connect Discovery allows both in one `jwks_uri`): a key whose `use` is not
`sig`, whose `alg` is not a JWS algorithm (`ECDH-ES`, `RSA-OAEP-256`),
whose `key_ops` hold neither `sign` nor `verify`, or on a key-agreement
curve (X25519, X448) is skipped, as RFC 7517 section 5 says, and never
verifies anything; every other key is held to `validatePublicJwk`
(`publicVerificationKeys(keys)` is that step on its own). `RemoteJwks` never resolves an HMAC algorithm (`key_mismatch`),
and `verify` and `createVerifier` refuse a `RemoteJwks` with HS* in
`algorithms` (`TypeError`). `localJwks` is the caller's own configuration
and may hold HMAC secrets; never verify HS* against a set that came from
somewhere public.
The old name `allowInsecure` was removed, and passing it is a `TypeError`.
The policy sees hosts as written: DNS names are resolved by the platform,
which offers no hook to check the address (see the egress docs).

It caches the set for `maxAgeMs` (10 minutes). When a token names a `kid`
it does not have, it fetches again, at most once per `cooldownMs` (30
seconds) since the last attempt, so a stream of made-up `kid`s cannot
turn every request into a fetch. A failed fetch starts a backoff of one
second that doubles, up to `cooldownMs`, while fetches keep failing;
lookups meanwhile fail at once with the last error. Concurrent lookups
share one fetch, which ends at the deadline, so a hung endpoint holds no
caller past it. While refreshes fail, the last good set keeps serving the
keys it has only when explicit `maxStaleMs` is configured (default zero),
past the response's freshness lifetime; a token naming a
key it lacks fails with `jwks`, since the set could not be checked. `fetch`
and `now` can be injected; `refresh()` fetches now, ignoring the backoff.
`now` must be a function reading a finite time: otherwise the constructor,
or the lookup that reads it, throws a `RangeError` (a configuration error,
not `jwks`). A clock that steps back behind the last fetch makes the set's
age unknown, so it is refetched rather than trusted.

A response's `Cache-Control` can shorten the cache, never lengthen it.
`max-age` is reduced by `Age`; `Expires` is a bounded fallback when no
`max-age` exists. `no-store` retains no reusable set; `no-cache` and
`max-age=0` require revalidation for every subsequent lookup. They are not
overridden by the unknown-key cooldown. ETag/Last-Modified enable conditional
304 revalidation. `must-revalidate` forbids stale-on-error after expiry,
even when an operator opted into staleness. Invalid/conflicting freshness
directives fail toward immediate revalidation. Concurrent fetches coalesce.
An issuer should publish rotation keys before signing with them. Emergency
removal is observed after freshness expires (or explicit `refresh()`);
the maximum exposure is the bounded freshness plus any explicitly opted-in
stale duration. Immediate fleet-wide revocation needs operator invalidation.

`remote.resolve(header, algorithm, { signal })` and `remote.refresh({ signal })`
support independent waiter cancellation. Cancelling one caller cannot cancel
another's shared fetch; cancelling the final waiter aborts the network/body
operation and does not create outage backoff. All listeners are removed when
the waiter settles.

`localJwks(jwks)` copies the set it is given, so changing the object
afterwards changes nothing; make a new one to change keys. `jwks` and
`refresh()` on `RemoteJwks` return frozen sets. `verify(token, jwks)`
reads the JWKS object passed on each call as it is then.

`validatePublicJwk(value)` is the shared public verification-key boundary.
Only positive RSA (`n,e`), EC (`crv,x,y`) and OKP (`crv,x`) schemas and
`kty,kid,alg,use,key_ops` are accepted. Unknown extensions, `oct`, every
private/CRT member, `use` other than `sig`, and operations other than the
single `verify` operation are rejected without printing their values.
Accepted keys are deep-frozen. Private JWKs belong only in explicit local
signing/import APIs, never in discovery, DPoP proofs or federation metadata.

Public key sets are interoperable by default: omitted `alg` is constrained
by verifier policy and key type/curve/size; algorithm-less RSA is RS*, never
PSS. For explicit key intent use `localJwks(set, { algorithms: ["ES256"],
requireKeyAlgorithm: true })` or those options on `RemoteJwks`. Missing
`alg` then fails, and duplicate eligible `kid` matches always fail.

Safe `sign()` validates registered claims and protected headers, handles
critical extensions only through named processors, and enforces the same
default encoded limits as `decode`. It cannot inject `alg/kid/typ` through
the extension-header object. A matching verifier is still responsible for
issuer/audience/time policy. There is no public arbitrary-payload raw-JWS
escape hatch; adversarial test fixtures use isolated WebCrypto helpers.
RSA generation accepts only integral 2048..8192-bit, byte-aligned moduli;
there is no weak-key downgrade. Both standardized Ed25519 JOSE names are
explicit algorithm policies, not interchangeable strings at verification.

## Decoding

`decode(token, { limits })` returns the header, payload, signature and
signing input without verifying anything, and `tryDecode` returns null
instead of throwing. It enforces, before anything else is decoded:

- `limits`: `maxTokenBytes` (8 KiB), `maxHeaderBytes` (4 KiB) and
  `maxPayloadBytes` (64 KiB, reachable with a larger token cap), each up
  to 16 MiB; a token over one is `too_large`. `createVerifier` and
  `verify` take the same `limits`.
- base64url is canonical and unpadded, and its alphabet is checked before
  any bytes are allocated;
- the header and payload are JSON objects, parsed with depth and size
  caps, refusing duplicate keys and `__proto__`, `constructor` and
  `prototype` keys (`malformed`);
- the header's registered members have their JSON types (`alg`, `typ`,
  `cty`, `kid`, `jku`, `x5u`, `x5t`, `x5t#S256` strings, `x5c` a list of
  strings, `jwk` an object);
- `b64` (RFC 7797) is not implemented, so a header with it is
  `unsupported`;
- `crit` is a non-empty list of names (`malformed`), none repeated, each
  present in the header, and none a registered parameter (`crit`).

`isJwt(token, { alg })` is the structural test `@celld/sieve`'s `v.jwt()`
uses. The token must decode under the default limits, a `typ` must be
`JWT` or end in `+jwt`, and the signature can be empty only when `alg` is
`none`. `JWT_PATTERN` is the looser regex that JSON Schema gets.

## What this protects and what it does not

- A verified token is authentic and unexpired; it is not single-use.
  Nothing here tracks `jti`, so replay protection and revocation are the
  caller's (the `webhook` and `session` examples keep `jti`s).
- HS256/384/512 keys are shared secrets: every verifier holding one can
  also mint tokens. They suit a service's own sessions or a single
  partner, not trust among several parties; publish only asymmetric keys.
- Remote keys are fetched under the egress policy above, which judges
  hosts as written and cannot see DNS answers.
- An issuer publishes a new key before it signs with it, for at least the
  JWKS cache lifetime (see `examples/issuer.ts`); a verifier that caches a
  set longer than that meets a `kid` it does not know.

## Examples

[`examples/`](examples) has standalone Workers using this library, each
tested under `celld dev`, `gateway` against a fake authorization server
(`buck2 test root//src/celld/sec/jwt/examples/...`), and runnable with
`buck2 run root//src/celld/sec/jwt/examples:<name>-dev`.

## Tests

```sh
buck2 test root//src/celld/sec/jwt/...
```

Keys are generated in the tests with WebCrypto. `vectors_test.ts` checks
RFC 7515's HS256 and ES256 examples and RFC 8037's Ed25519 example,
including the byte-exact deterministic signatures. `regressions_test.ts`
holds the Daybreak audit's JWT regressions (secrets in public output,
future `iat`, JWKS refetch storms and hangs, non-finite options, `crit`
and `b64`, `key_ops`, key selection, size caps), and `verifier_test.ts`
covers `createVerifier`.
