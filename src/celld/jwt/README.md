<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/jwt

JSON Web Tokens for celld on WebCrypto. It decodes, signs and verifies
compact JWS tokens and fetches issuers' JWKS. It has no dependencies,
uses no Node APIs and no `eval`, so it runs in Workers-style isolates.

```python
celld.library(
    name = "api",
    srcs = glob(["src/*.ts"]),
    import_name = "@example/api",
    deps = ["root//src/celld/jwt:jwt"],
)
```

```typescript
import { generateKeyPair, RemoteJwks, sign, verify } from "@celld/jwt";

const { privateKey, publicJwk } = await generateKeyPair("ES256", { kid: "k1" });
const token = await sign({ sub: "alice", aud: "api" }, privateKey, {
  alg: "ES256",
  kid: "k1",
  expiresIn: 300,
});

const { payload } = await verify(token, { keys: [publicJwk] }, {
  audience: "api",
  requiredClaims: ["exp"],
});

// An OAuth access token from an issuer that rotates its keys.
const issuer = new RemoteJwks("https://auth.example.com/.well-known/jwks.json");
await verify(accessToken, issuer, {
  issuer: "https://auth.example.com",
  audience: "https://mcp.example.com/mcp",
  typ: "at+jwt",
  algorithms: ["RS256", "ES256", "EdDSA"],
  clockTolerance: 30,
  requiredClaims: ["exp"],
});
```

## Algorithms and keys

HS256/384/512, RS256/384/512, PS256/384/512, ES256/384/512, and Ed25519
under both `EdDSA` (RFC 8037) and `Ed25519` (RFC 9864). `none` is never
accepted.

The runtime has the last word. celld 0.5.1 signs with Ed25519 but cannot
verify it, and cannot import an `oct` JWK (pass HMAC secrets as bytes);
its WebCrypto throws `NotSupportedError` (see the toolchain's
[known runtime limitations](../../../buck/toolchains/celld/README.md)).
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

Helpers: `importKey`, `importJwk`, `jwkFits`, `publicJwk`,
`generateKeyPair`, `generateSecret`, `exportPublicJwk`, `jwkThumbprint`
(RFC 7638, a good `kid`), and the raw JWS steps `signBytes` and
`verifyBytes`.

## Verifying

`verify(token, key, options)` checks things in this order and throws a
`JwtError` whose `code` names the first failure:

1. It decodes (`malformed`). Base64url must be canonical and unpadded, and
   the header and payload must be JSON objects.
2. `alg` is implemented (`unsupported_alg`) and in `algorithms`
   (`alg_not_allowed`).
3. Every `crit` name is in `options.crit` (`crit`), and `typ` is one of
   `options.typ` (`typ`). The `typ` comparison ignores case and an
   `application/` prefix.
4. The key fits (`key_mismatch`), a key set has one (`no_key`, or `jwks`
   when fetching failed), and the signature verifies (`bad_signature`).
   A signature WebCrypto rejects as malformed is `bad_signature` too;
   an algorithm the runtime cannot verify is `runtime_unsupported`.
5. The claims. `exp`, `nbf` and `iat` are checked whenever present, with
   `clockTolerance` seconds of slack (`expired`, `not_yet_valid`,
   `too_old` with `maxTokenAge`). Then `issuer`, `audience` and `subject`.
   `requiredClaims` makes claims mandatory (`missing_claim`), and a
   registered claim of the wrong JSON type is `invalid_claim`.

A token that carries `aud` passes when `audience` is not set, as in jose.
Pass `audience` whenever tokens name one.

## Key sets

`verify` takes a JWKS object, `localJwks(jwks)`, or `new RemoteJwks(url)`.
A token with a `kid` gets the key with that `kid` that fits its `alg`.
A token without one gets the only key that fits, and fails when there are
several, since guessing would let the token choose its key.

`RemoteJwks` caches the fetched set for `maxAgeMs` (10 minutes). When a
token names a `kid` it does not have, it fetches again, at most once per
`cooldownMs` (30 seconds), so a stream of made-up `kid`s cannot turn every
request into a fetch. Concurrent lookups share one fetch. `fetch` and `now`
can be injected. It takes `https:` URLs, plus `http:` for loopback hosts
or with `allowInsecure`.

## Decoding

`decode` returns the header, payload, signature and signing input without
verifying anything, and `tryDecode` returns null instead of throwing.
`isJwt(token, { alg })` is the structural test `@celld/sieve`'s `v.jwt()`
uses. The token must decode, a `typ` must be `JWT` or end in `+jwt`, and
the signature can be empty only when `alg` is `none`. `JWT_PATTERN` is the
looser regex that JSON Schema gets.

## Examples

[`examples/`](examples) has standalone Workers using this library, each
tested under `celld dev`, `gateway` against a fake authorization server
(`buck2 test root//src/celld/jwt/examples/...`), and runnable with
`buck2 run root//src/celld/jwt/examples:<name>-dev`.

## Tests

```sh
buck2 test root//src/celld/jwt/...
```

Keys are generated in the tests with WebCrypto. `vectors_test.ts` checks
RFC 7515's HS256 and ES256 examples and RFC 8037's Ed25519 example,
including the byte-exact deterministic signatures.
