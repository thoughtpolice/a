<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/sec/webauthn

Passkeys for celld. It is a WebAuthn Level 3 relying party on WebCrypto,
with:

- a credential store in a Durable Object;
- `@celld/web/router` routes for sign-up, sign-in and managing passkeys;
- a browser client to call them;
- a software authenticator for tests.

It has no npm dependency.

```python
celld.library(
    name = "app",
    srcs = glob(["src/*.ts"]),
    deps = [
        "root//src/celld/web/router:router",
        "root//src/celld/sec/webauthn:webauthn",
    ],
)
```

| Import | What it has |
| --- | --- |
| `@celld/sec/webauthn` | `RelyingParty`, the CBOR, COSE, authenticator-data and client-data parsers, `PasskeyStore` and its records, `durablePasskeys` |
| `@celld/sec/webauthn/durable` | `PasskeyDirectory`, the Durable Object (the only module importing `cloudflare:workers`) |
| `@celld/sec/webauthn/router` | `passkeyRoutes` |
| `@celld/sec/webauthn/browser` | `passkeyClient` and the JSON conversions, for pages |
| `@celld/sec/webauthn/testing` | `VirtualAuthenticator`, `memoryPasskeyStore`, `p1363ToDer` |

It depends on `@celld/core`, `@celld/sec/jwt` (base64url), `@celld/web/router` and
`@celld/sec/ratelimit`.

## A quick tour

```typescript
import { durableLimiter, type RateLimitShardApi } from "@celld/sec/ratelimit";
import { router, session } from "@celld/web/router";
import { durablePasskeys, type PasskeyDirectoryApi, RelyingParty } from "@celld/sec/webauthn";
import { passkeyRoutes } from "@celld/sec/webauthn/router";
export { PasskeyDirectory } from "@celld/sec/webauthn/durable";
export { RateLimitShard } from "@celld/sec/ratelimit/durable";

interface Env {
  readonly PASSKEYS: DurableObjectNamespace<PasskeyDirectoryApi>;
  readonly RATE_LIMITS: DurableObjectNamespace<RateLimitShardApi>;
  readonly SESSION_SECRET: string;
}

function build(env: Env) {
  const keys = [{ id: "k1", secret: env.SESSION_SECRET }];
  const sessions = session({ keys });
  const rp = new RelyingParty({
    id: "example.com",
    origins: ["https://example.com"],
  });
  const app = router<Env>({ auth: sessions });
  app.mount("/passkeys", passkeyRoutes<Env>({
    rp,
    store: (env) => durablePasskeys(env.PASSKEYS, { rpId: rp.id }),
    sessions,
    ceremonyScope: "accounts",
    keys,
    signUp: true,
    limiter: durableLimiter(env.RATE_LIMITS, {
      name: "passkeys",
      policies: [{ name: "passkeys", limit: 60, window: "PT1M", burst: 30 }],
    }),
    // A session may add another passkey only soon after a passkey ceremony.
    // A password/OIDC app would stamp this claim after its own step-up flow.
    principal: (user) => ({
      ...user.principal,
      claims: { passkeyAuthenticatedAt: Date.now() },
    }),
    authorizeRegistration: (principal) => {
      const at = principal.claims.passkeyAuthenticatedAt;
      const age = typeof at === "number" ? Date.now() - at : Infinity;
      return age >= 0 && age <= rp.timeoutMs;
    },
  }));
  app.get("/me", (c) => c.json({ subject: c.principal.subject }));
  return app;
}
```

Bind both objects in the project:

```python
celld.project(..., bindings = {
    "PASSKEYS": "PasskeyDirectory",
    "RATE_LIMITS": "RateLimitShard",
})
```

On the page:

```typescript
import { passkeyClient } from "@celld/sec/webauthn/browser";

const passkeys = passkeyClient({ base: "/passkeys" });
await passkeys.signUp({ name: "ada@example.com" }); // a new account, signed in
await passkeys.signIn();                            // later, on any device
await passkeys.signIn({ conditional: true });       // or from the autofill of
// <input autocomplete="username webauthn">
```

The [`passkeys` example](examples/passkeys.ts) is this app with a page you
can try in a browser.

## The relying party

`new RelyingParty(options)` holds the policy. Its four methods keep no
state:

- `registrationOptions({ user, exclude?, hints?, attachment? })` and
  `authenticationOptions({ allow?, hints? })` return the options JSON for
  `navigator.credentials` and a fresh 32-byte challenge. The caller keeps the
  challenge until the response comes back.
- `verifyRegistration(response, { challenge })` runs §7.1 and returns the
  credential record to store.
- `verifyAuthentication(response, { challenge, credential, identified?,
  allowed? })` runs §7.2 and returns the counter and backup state to update.

| Option | Default | Meaning |
| --- | --- | --- |
| `id` | (required) | The RP ID, a lower-case domain. Every origin must be it or a subdomain of it. |
| `origins` | (required) | Allowed origins, exactly as browsers serialize them (`https://host[:port]`, or `http://localhost:port`). |
| `relatedOrigins` | none | Origins on other domains that share the RP ID ([§5.11](https://www.w3.org/TR/webauthn-3/#sctn-related-origins)). `relatedOriginsDocument()` gives the `/.well-known/webauthn` body to serve. |
| `topOrigins` | none | Pages that may embed a ceremony in a cross-origin frame, or `"any"`. |
| `algorithms` | `[-8, -7, -257]` | Offered in that order, as the spec recommends: EdDSA, ES256, RS256. Also available: ES384, ES512, PS256 and the fully-specified -9 and -19. |
| `userVerification` | `"required"` | Makes a passkey alone count as two factors. `"preferred"` asks for verification but does not require it. |
| `residentKey` | `"required"` | Registers discoverable credentials, which sign in without a user name. |
| `timeoutMs` | 300,000 | The ceremony timeout, and how long a challenge lives. |
| `counterRegression` | `"reject"` | What to do when a signature counter did not advance, a sign the authenticator may be cloned. `"accept"` allows the sign-in and flags it. Synced passkeys keep the counter at 0, which is never a regression. |

What gets checked, as the spec orders it:

- **Client data.** It is parsed as JSON, never compared against a template.
  Browsers add members, and Chromium sometimes adds one on purpose. The
  checks are:
  - the ceremony `type`;
  - the challenge;
  - the origin, by exact match;
  - `crossOrigin` and `topOrigin`, against `topOrigins`.
- **Authenticator data.** The RP ID hash is checked. UP is required
  (except for conditional creation). UV is required under the policy. BS
  without BE is refused, and so is a BE that changed since registration.
  Reserved flag bits are refused rather than silently assigned old meaning.
  An assertion must not carry an attested credential.
- **Keys.** The algorithm must be one that was offered. The key's type,
  curve and sizes must match that algorithm. EC points must be on their
  curve; this library checks that itself, because Deno 2.9's WebCrypto
  imports a JWK that is off its curve without complaint. RSA moduli must
  be at least 2048 bits.
- **Signatures.** ECDSA signatures are strict DER, converted to the
  `r || s` form WebCrypto verifies. The signed data is
  `authenticatorData || SHA-256(clientDataJSON)`.
- **Attestation.** Options always ask for `attestation: "none"`. `none` and
  packed self attestation are accepted. Formats with a certificate (packed
  x5c, `tpm`, `android-key`, `apple`, `fido-u2f`) are refused with
  `unsupported_attestation`. Verifying them needs X.509 chains, a trust
  store and revocation data, which consumer passkeys do not need. Browsers
  convert certificate formats to `none` when the relying party asks for
  `none`.
- **Credential IDs and user handles.** A credential ID is at most 1023
  bytes, and the response's `id` must equal its `rawId`. A discoverable
  sign-in must carry the user handle, and that handle must be the
  credential's.

Failures throw `WebAuthnError` with a stable `code`: `invalid_response`,
`wrong_ceremony`, `challenge_mismatch`, `challenge_expired`,
`origin_not_allowed`, `rp_id_mismatch`, `user_not_present`,
`user_not_verified`, `backup_flags`, `unsupported_algorithm`,
`unsupported_attestation`, `bad_signature`, `unknown_credential`,
`user_handle_mismatch`, `counter_regressed` and `credential_exists`. Log the
code. Tell the user only that the passkey was not accepted.

The CBOR decoder rejects anything outside the subset WebAuthn uses:

- indefinite lengths;
- tags, floats and `undefined`;
- duplicate map keys;
- integers past 2⁵³;
- invalid UTF-8;
- nesting deeper than 8;
- trailing bytes.

It does not insist on CTAP2's canonical key order, which the spec says
decoders SHOULD enforce. Nothing here re-encodes and compares, signatures
cover the bytes as sent, and relying-party libraries commonly accept
both orders. Refusing an authenticator's unsorted key would only lock its
user out.

## Accounts and storage

A `PasskeyStore` holds users and their credentials, and remembers each used
challenge until it would have expired.

- **A user** has a user handle (64 random bytes, never personal data), a
  name for authenticators to show, and a principal. A passkey created at
  sign-up gets a fresh ULID as its subject. A passkey a signed-in user adds
  keeps that user's principal, including the scheme and issuer (an API key,
  an OpenID Connect login). Signing in with it later issues a session with
  the same `principal.key`, so the passkey signs in to the same account.
- **A credential** is the record §4 recommends: the COSE public key as the
  authenticator wrote it, the counter, transports, backup flags,
  `uvInitialized`, the AAGUID, plus a user-given name and the time it was
  last used.
- **`register` and `authenticate`** atomically claim the challenge before the
  write that finishes the ceremony. A response is therefore attempted once,
  however many Workers see it; a refused or interrupted write deliberately
  leaves the challenge spent. The store itself atomically refuses an expired
  challenge; it does not rely on a route to check first. A sign-in updates the
  counter only if it still holds the value the verification read.
- **User verification trust.** `verifyAuthentication` reports both
  `authenticatorUserVerified` (the assertion's raw UV bit) and
  `userVerified` (true only when that bit is set and the credential's
  `uvInitialized` was already true). With a required-UV policy, an
  uninitialized credential is refused. To promote one, an application must
  pass `initializeUserVerification: { independentlyAuthorized: true }` to
  `authenticate` while recording a freshly verified assertion whose raw UV
  bit is true. The store makes that promotion atomic with the assertion;
  the independent factor must not be that assertion's UV gesture. Because a
  `"required"` RP correctly refuses an uninitialized credential, perform
  the promotion assertion with an otherwise-identical `"preferred"` policy
  after the independent factor succeeds, then return to the required policy.
- **`remove(handle, id, { keepLast: true })`** refuses to delete the user's
  only credential (`last`), deciding in the delete's own transaction, so
  removals at once cannot leave an account with none. It answers
  `removed`, `not_found` or `last`.

`durablePasskeys(env.PASSKEYS, { rpId, tenant? })` is the store over one
unambiguously named `PasskeyDirectory` object per relying party and,
optionally, tenant. The scope is required: two RPs sharing a namespace
cannot accidentally get the old global default object. Every rule that spans
records
(a credential ID is registered once, a principal has one user, a user has
at most 32 credentials, a challenge is used once) is one synchronous method
there. A ceremony is one or two calls. Writes do not wait for
`storage.sync()`, so a node lost before its writes reach the fleet's
storage forgets its last few sign-ins and registrations, and those users
register again.

This v2 scope deliberately does not reuse the former default object named
`passkeys`. Before deploying this change over an existing installation,
migrate that object's records into the new RP-scoped object or have users
re-register. Do not keep using one legacy object for multiple RP IDs or
tenants; its schema has no RP column and cannot safely separate them.

`DirectoryCore` implements those rules over `DirectoryTables`, a handful of
synchronous row operations. To keep passkeys in another database,
implement the tables.

## The routes

`passkeyRoutes(options)` returns a router to mount under a prefix. It
inherits the app's auth, which must accept the `sessions` scheme the routes
issue.

| Route | Who may call it | What it does |
| --- | --- | --- |
| `POST /signup/options`, `/signup/verify` | anyone, only when `signUp: true` | Creates an account whose only credential is a passkey, and signs it in. |
| `POST /login/options`, `/login/verify` | anyone | A discoverable sign-in, including from autofill. |
| `POST /register/options`, `/register/verify` | a signed-in user explicitly allowed by `authorizeRegistration` | Adds a passkey to the same account. |
| `GET /credentials` | a signed-in user | Lists the passkeys, with the RP ID and user handle the Signal API needs. |
| `PATCH /credentials/:id`, `DELETE /credentials/:id` | a signed-in user | Renames one, or deletes one. The last one cannot be deleted (409 `last_passkey`) unless `allowRemovingLast`. |

- **Challenges travel in scoped cookies.** `ceremonyScope` is required and
  must be a stable, cookie-safe security-domain name unique among passkey
  routers on an origin. Use a different value for every tenant/store boundary.
  Each challenge is in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie named
  `__Host-webauthn-{scope}-get` or `__Host-webauthn-{scope}-create`, so sibling
  routers and the two ceremony kinds do not overwrite or consume one another.
  The authenticated payload independently binds the exact scope and RP ID,
  and binds `/register` to the principal who started it.
- **Failures.** A malformed or stale ceremony answers 400. A passkey that
  did not verify answers 401 with its code and the message "the passkey was
  not accepted". `unknown_credential` tells the page to call
  `signalUnknownCredential`, which `passkeyClient` does.
- **Limits.** `limiter`, a `@celld/sec/ratelimit` limiter, is charged by
  address before the body is read on every public route. Bodies are capped
  at 64 KiB. Sign-up is off by default. Enabling it requires a limiter;
  `unsafeUnthrottledSignUp: true` is an explicit escape hatch for a trusted,
  non-Internet environment.
- **Principals.** `principal(user)` maps a user to the principal a sign-in
  issues, which is where scopes and roles belong. `newPrincipal(name)`
  chooses a new account's subject.
- **Enrollment authorization.** Adding a credential is denied by default.
  `authorizeRegistration(principal, context)` must return the literal
  boolean `true` at both the options and verification request. Require a
  recent independent authentication or a narrowly issued enrollment scope;
  merely having any inherited session is not sufficient.

Changing from a version without `ceremonyScope` changes the cookie names and
ceremony payload version. In-flight ceremonies fail closed and must be
restarted; stored credentials and users do not need migration. Deploy every
same-origin tenant with its final distinct scope before accepting ceremonies.

## The browser client

`passkeyClient({ base })` offers `signUp`, `signIn` (optionally
`conditional`, with an abort `signal`), `add`, `list`, `rename`, `remove`
and `autofillAvailable`. Every request is same-origin with the page's
cookies. A refusal throws `PasskeyError` with the server's `code`.

- **JSON conversion.** Options go through the browser's own
  `parseCreationOptionsFromJSON` where it exists (Chrome 129, Firefox 119,
  Safari 18.4), and through this module's conversions elsewhere. Responses
  likewise go through `toJSON()`.
- **The Signal API.** After a sign-in with a passkey the server no longer
  knows, the client calls `signalUnknownCredential`. `list({ signal: true
  })` calls `signalAllAcceptedCredentials`. Both are skipped where the
  browser lacks them (Firefox, for now).
- **Autofill.** A conditional sign-in can wait on the page longer than its
  challenge lives, so start it again before `timeoutMs` runs out.

## Testing

`VirtualAuthenticator` from `@celld/sec/webauthn/testing` is a software
authenticator with a client in front of it. `create(options)` and
`get(options)` return the JSON a browser would post, with real keys (ES256,
Ed25519 or RS256) and real signatures. Options and per-call overrides make
it misbehave on demand:

- another origin, RP ID, type or challenge;
- no UP, no UV, or inconsistent backup flags;
- a missing user handle;
- a chosen counter;
- a corrupted signature.

`memoryPasskeyStore()` runs the same `DirectoryCore` as the Durable Object,
over maps.

## What it does not do

- **Attestation certificates.** There is no packed x5c, `tpm`,
  `android-key`, `apple` or `fido-u2f`, and so no FIDO Metadata Service.
- **Ed448.** WebCrypto does not have it.
- **Extensions.** Only `credProps` is requested and read. PRF, largeBlob
  and appid are not supported.
- **Username-first sign-in with `allowCredentials`.** The routes run
  discoverable sign-ins only. `RelyingParty` supports it (`identified`,
  `allowed`), but faking `allowCredentials` for unknown user names, which
  that flow needs to avoid telling which accounts exist, is left to the
  application.
- **Account recovery.** When the last passkey is lost, the account is gone
  unless the application has another way in.

## Examples

[`examples/`](examples) holds the `passkeys` Worker, whose spec runs under
`celld dev` with the real `PasskeyDirectory` and a software authenticator
standing in for the browser.

## Tests

```sh
buck/bin/buck2 test root//src/celld/sec/webauthn/...
```

| Suite | What it covers |
| --- | --- |
| `vectors` | Every test vector of [WebAuthn Level 3 §16](https://www.w3.org/TR/webauthn-3/#sctn-test-vectors): registrations with `none` and self attestation, frames, the 1023-byte credential ID, and assertions for ES256, ES384, ES512, RS256 (3482 bits) and EdDSA. Certificate formats and Ed448 are refused as intended. |
| `cbor`, `cose` | The subset and its refusals, strict DER, keys and curves. |
| `rp` | Every refusal of both ceremonies, driven by the virtual authenticator. |
| `store` | The store's rules. |
| `router` | Full flows through the routes. |
| `browser` | The client against the routes. |
| `readme` | The examples on this page. |
