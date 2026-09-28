<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/sec/webauthn examples

Standalone Workers using `@celld/sec/webauthn`; see [the convention](../../../examples/README.md).
The spec stands a software authenticator (`authenticator.ts`, around
`VirtualAuthenticator`) in for the browser: it calls the fake directly for
each `navigator.credentials` answer and posts that to the Worker, so every
signature in the spec is real.

| Example | What it shows |
| --- | --- |
| [`passkeys`](passkeys.ts) | passkey-only accounts over `passkeyRoutes` and a `PasskeyDirectory`: sign-up, discoverable sign-in (surviving a restart), a second passkey on a security key that counts signatures, renaming, deleting (never the last), and the refusals: a replayed registration, a forged signature, another origin, a passkey the server deleted, a cloned key's repeated counter, an oversized body. It also serves a page and its bundled client, to try in a browser at http://localhost:9876 |

The session secret the example uses (`SESSION_SECRET`) and its relying
party (`RP_ID`, `RP_ORIGINS`) live only in the spec's `vars`, which the
harness writes to `.dev.vars` for `celld dev`. The secret is public: never
deploy it. A deployment sets its own with `celld secret put`.
