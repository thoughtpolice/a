// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Helpers shared by the suites.
 *
 * @module
 */

import { assertEquals, show } from "@celld/core/assert";
import {
  generateKeyPair,
  type Jwk,
  jwkThumbprint,
  type JwsAlgorithm,
  signBytes,
  toBase64Url,
} from "@celld/sec/jwt";

/** Whether two types are identical, for `const _: true = ...` assertions. */
export type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;

/** Anything with the router's `fetch`. */
export interface Fetches {
  fetch(
    request: Request,
    env?: unknown,
    ctx?: ExecutionContext,
  ): Promise<Response>;
}

/** Options for {@link call}: the request's parts. */
export interface CallOptions {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly json?: unknown;
  readonly body?: BodyInit;
  readonly env?: unknown;
  readonly ctx?: ExecutionContext;
  /** Default `https://api.example.com`. */
  readonly origin?: string;
}

/** A response with its body read. */
export interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  /** The body as JSON, or undefined when it is not JSON. */
  readonly json: Record<string, unknown> | undefined;
}

/** Sends one request to `app` and reads the answer. */
export async function call(
  app: Fetches,
  path: string,
  options: CallOptions = {},
): Promise<Answer> {
  const headers = new Headers(options.headers);
  let body = options.body;
  if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
  }
  const method = options.method ?? (body === undefined ? "GET" : "POST");
  const request = new Request(
    (options.origin ?? "https://api.example.com") + path,
    {
      method,
      headers,
      body,
    },
  );
  const response = await app.fetch(request, options.env, options.ctx);
  const text = await response.text();
  let json: Record<string, unknown> | undefined;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
}

/** Asserts the status, with the body in the message when it is wrong. */
export function assertStatus(answer: Answer, status: number): void {
  assertEquals(answer.status, status, `status (body ${answer.text})`);
}

/** Asserts a header's exact value (null for absent). */
export function assertHeader(
  answer: Answer,
  name: string,
  value: string | null,
): void {
  assertEquals(answer.headers.get(name), value, `header ${name}`);
}

/** Asserts `value` is a subset match of `expected` (object keys only as listed). */
export function assertMatch(
  value: unknown,
  expected: Record<string, unknown>,
): void {
  const actual = value as Record<string, unknown> | undefined;
  for (const [key, want] of Object.entries(expected)) {
    assertEquals(actual?.[key], want, `${key} of ${show(value)}`);
  }
}

/** An `ExecutionContext` that records `waitUntil` promises. */
export function recordingContext(): ExecutionContext & {
  pending: Promise<unknown>[];
} {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
    passThroughOnException: () => {},
    abort: () => {},
    exports: {},
    props: undefined,
  };
}

/** A DPoP key pair for tests: the private key, its public JWK and thumbprint. */
export interface ProofKey {
  readonly alg: JwsAlgorithm;
  readonly privateKey: CryptoKey;
  readonly jwk: Jwk;
  readonly jkt: string;
}

/** A fresh DPoP key pair (ES256 unless told otherwise). */
export async function proofKey(alg: JwsAlgorithm = "ES256"): Promise<ProofKey> {
  const pair = await generateKeyPair(alg);
  const { alg: _alg, kid: _kid, ...jwk } = pair.publicJwk;
  return {
    alg,
    privateKey: pair.privateKey,
    jwk,
    jkt: await jwkThumbprint(jwk),
  };
}

/** base64url(SHA-256(token)): a proof's `ath`. */
export async function accessTokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return toBase64Url(new Uint8Array(digest));
}

/** What a test proof says; anything left out is what a good proof says. */
export interface ProofOptions {
  readonly method?: string;
  /** Default `https://api.example.com/things`. */
  readonly url?: string;
  /** The access token the proof's `ath` hashes; none when left out. */
  readonly token?: string;
  readonly nonce?: string;
  /** Epoch seconds; default now. */
  readonly iat?: number;
  /** Default a random one. */
  readonly jti?: string;
  /** Claims that replace the ones above (`undefined` removes one). */
  readonly claims?: Readonly<Record<string, unknown>>;
  /** Header members that replace the defaults (`typ`, `jwk`). */
  readonly header?: Readonly<Record<string, unknown>>;
  readonly typ?: string | null;
  /** Epoch milliseconds for the default `iat`; default `Date.now()`. */
  readonly now?: number;
}

/** A signed DPoP proof (RFC 9449 section 4.2) by `key`. */
export async function dpopProof(
  key: ProofKey,
  options: ProofOptions = {},
): Promise<string> {
  const claims: Record<string, unknown> = {
    jti: options.jti ?? crypto.randomUUID(),
    htm: options.method ?? "GET",
    htu: options.url ?? "https://api.example.com/things",
    iat: options.iat ??
      Math.floor((options.now ?? Date.now()) / 1000),
    ...(options.token === undefined
      ? {}
      : { ath: await accessTokenHash(options.token) }),
    ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
    ...options.claims,
  };
  for (const [name, value] of Object.entries(claims)) {
    if (value === undefined) delete claims[name];
  }
  // Deliberately low-level: these tests sign malformed JWT claims to exercise
  // verification. The public safe sign() correctly refuses those fixtures.
  const typ = options.typ === undefined ? "dpop+jwt" : options.typ;
  const header = {
    alg: key.alg,
    ...(typ === null ? {} : { typ }),
    jwk: key.jwk,
    ...options.header,
  };
  const input = `${toBase64Url(JSON.stringify(header))}.${
    toBase64Url(JSON.stringify(claims))
  }`;
  return `${input}.${
    toBase64Url(
      await signBytes(key.alg, key.privateKey, new TextEncoder().encode(input)),
    )
  }`;
}
