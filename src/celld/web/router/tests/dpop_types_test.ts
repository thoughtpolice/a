// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// DB-RTR-001, compile time: the proof is the scheme's business. A token
// verifier never sees it, so no verifier can stand in as the proof
// authority, and a DPoP scheme cannot silently omit replay protection.
// `deno check` fails if any line marked `@ts-expect-error` compiles.

import { assertEquals } from "@celld/core/assert";
import {
  dpop,
  type DpopNonceStrategy,
  type DpopOptions,
  jwtVerifier,
  type ReplayStore,
  type TokenRequest,
  type TokenVerifier,
  unsafeMemoryReplayStore,
} from "@celld/web/router";
import type { Equal } from "./fixture.ts";

const verify = jwtVerifier({
  keys: { keys: [] },
  issuer: "https://as.example.com",
  audience: "https://api.example.com",
  algorithms: ["ES256"],
});
const replay: ReplayStore = unsafeMemoryReplayStore();
const nonce: DpopNonceStrategy = {
  issue: () => Promise.resolve("n"),
  check: () => Promise.resolve(true),
};

// The token verifier gets the token and the request, never the proof.
const _noProof: Equal<
  "proof" extends keyof TokenRequest ? true : false,
  false
> = true;
// @ts-expect-error: TokenRequest has no proof to "check".
const _readProof = (request: TokenRequest) => request.proof;
// No option of DpopOptions takes the proof: only `verify` sees requests,
// and it is a plain TokenVerifier.
const _verifyIsPlain: Equal<DpopOptions["verify"], TokenVerifier> = true;

// Never called: each only has to fail to compile.
const _misuse = [
  // @ts-expect-error: a DPoP scheme needs a replay store or an unsafe opt-out.
  () => dpop({ verify }),
  // @ts-expect-error: a nonce is additional freshness, not replay protection.
  () => dpop({ verify, nonce }),
  // @ts-expect-error: safe and explicitly unsafe modes are mutually exclusive.
  () => dpop({ verify, replay, unsafeNoReplay: true }),
  // @ts-expect-error: the unsafe opt-out must be the literal true.
  () => dpop({ verify, unsafeNoReplay: false }),
  // @ts-expect-error: the old per-request nonce callback is gone.
  () => dpop({ verify, replay, nonce: () => "n" }),
  // @ts-expect-error: symmetric algorithms cannot prove possession.
  () => dpop({ verify, replay, algs: ["HS256"] }),
  // @ts-expect-error: publicUrl returns a URL.
  () => dpop({ verify, replay, publicUrl: () => "https://api.example.com" }),
];

// The composition the audit expected to be safe now is.
const schemes = [
  dpop({ verify, replay }),
  dpop({ verify, replay, nonce, algs: ["ES256", "PS256"] }),
  dpop({ verify, unsafeNoReplay: true, nonce }),
];

Deno.test("the type assertions above compiled", () => {
  assertEquals(schemes.map((scheme) => scheme.name), ["dpop", "dpop", "dpop"]);
  assertEquals(_misuse.length, 7);
});
