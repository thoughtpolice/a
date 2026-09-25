// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Helpers the suites share: an authorization server with a known set of
 * clients on a manual clock, and requests to it.
 *
 * @module
 */

import { assert, assertEquals } from "@celld/assert";
import { generateKeyPair, type Jwk } from "@celld/jwt";
import { basicAuthorization, pkcePair } from "@celld/oauth";
import type { DpopKey } from "@celld/oauth/dpop";
import type { ClientConfig } from "@celld/oauth/server";
import {
  type ManualClock,
  manualClock,
  type TestAuthorizationServer,
  testAuthorizationServer,
  type TestAuthorizationServerOptions,
} from "@celld/oauth/testing";

/**
 * Runs `work` with WebCrypto's `verify` refusing every algorithm the way
 * celld 0.5.1 refuses Ed25519: a `NotSupportedError` `DOMException`.
 */
export async function withUnsupportedVerify<T>(
  work: () => Promise<T>,
): Promise<T> {
  const original = crypto.subtle.verify;
  crypto.subtle.verify = () =>
    Promise.reject(
      new DOMException("unsupported verify algorithm", "NotSupportedError"),
    );
  try {
    return await work();
  } finally {
    crypto.subtle.verify = original;
  }
}

/** Runs `work` and checks that it throws an error with these fields. */
export async function rejects(
  work: () => Promise<unknown>,
  expected: Readonly<Record<string, unknown>>,
): Promise<Error> {
  try {
    await work();
  } catch (error) {
    assert(error instanceof Error, `expected an Error, got ${error}`);
    const record = error as unknown as Record<string, unknown>;
    for (const [name, value] of Object.entries(expected)) {
      assertEquals(record[name], value, `${name} of ${error.message}`);
    }
    return error;
  }
  throw new Error(`expected a rejection like ${JSON.stringify(expected)}`);
}

export const ISSUER = "https://as.test";
export const API = "https://api.test";
export const OTHER_API = "https://other.test";
export const SECRET = "web-app-secret-0123456789";
export const RS_SECRET = "api-secret-0123456789abcdef";

/** The fixture's world: the server, its clock, and a signing key for `jwt-app`. */
export interface World extends TestAuthorizationServer {
  readonly clock: ManualClock;
  readonly clientKey: { privateKey: CryptoKey; publicJwk: Jwk };
}

/**
 * A test server with these clients:
 *
 * - `public-app`: public, code and refresh, two redirect URIs (one a
 *   loopback IP literal);
 * - `web-app`: `client_secret_basic`, every grant;
 * - `post-app`: `client_secret_post`, code and client credentials;
 * - `jwt-app`: `private_key_jwt` with an ES256 key, client credentials;
 * - `api`: the resource server, for introspection;
 * - `bound-app`: public, `dpop_bound_access_tokens`.
 */
export async function world(
  options: Partial<TestAuthorizationServerOptions> = {},
  extraClients: readonly ClientConfig[] = [],
): Promise<World> {
  const clock = manualClock(Date.UTC(2026, 8, 25, 12));
  const clientKey = await generateKeyPair("ES256", { kid: "jwt-app-1" });
  const clients: ClientConfig[] = [
    {
      client_id: "public-app",
      redirect_uris: ["https://app.test/cb", "http://127.0.0.1/cb"],
    },
    {
      client_id: "web-app",
      client_secret: SECRET,
      redirect_uris: ["https://web.test/cb"],
      grant_types: [
        "authorization_code",
        "refresh_token",
        "client_credentials",
        "urn:ietf:params:oauth:grant-type:device_code",
        "urn:ietf:params:oauth:grant-type:token-exchange",
      ],
    },
    {
      client_id: "post-app",
      client_secret: SECRET,
      token_endpoint_auth_method: "client_secret_post",
      redirect_uris: ["https://post.test/cb"],
      grant_types: ["authorization_code", "client_credentials"],
    },
    {
      client_id: "jwt-app",
      jwks: { keys: [clientKey.publicJwk] },
      grant_types: ["client_credentials"],
    },
    { client_id: "api", client_secret: RS_SECRET, grant_types: [] },
    {
      client_id: "bound-app",
      redirect_uris: ["https://bound.test/cb"],
      dpop_bound_access_tokens: true,
    },
    ...extraClients,
  ];
  const as = await testAuthorizationServer({
    issuer: ISSUER,
    now: clock.now,
    clients,
    scopesSupported: ["read", "write", "admin", "offline_access"],
    resources: { allowed: [API, OTHER_API] },
    device: { verificationUri: `${ISSUER}/device` },
    ...options,
  });
  return { ...as, clock, clientKey };
}

/** A form POST to one of the server's endpoints. */
export function post(
  url: string,
  params: Readonly<Record<string, string | readonly string[]>>,
  headers: Readonly<Record<string, string>> = {},
): Request {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (typeof value === "string") body.append(name, value);
    else for (const item of value) body.append(name, item);
  }
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: body.toString(),
  });
}

/** The `web-app` client's Basic credentials. */
export const WEB_AUTH = {
  authorization: basicAuthorization("web-app", SECRET),
};

/** The `api` client's Basic credentials. */
export const RS_AUTH = { authorization: basicAuthorization("api", RS_SECRET) };

/** Each client's usual redirect URI. */
export const REDIRECTS: Readonly<Record<string, string>> = {
  "public-app": "https://app.test/cb",
  "web-app": "https://web.test/cb",
  "post-app": "https://post.test/cb",
  "bound-app": "https://bound.test/cb",
};

/** What {@link authorize} returns. */
export interface Authorized {
  readonly response: Response;
  readonly location: URL | null;
  readonly verifier: string;
  readonly code: string | null;
}

/**
 * Sends an authorization request for `clientId` with PKCE (unless
 * `params` overrides it) and reads the redirect.
 */
export async function authorize(
  w: World,
  clientId: string,
  params: Readonly<Record<string, string | readonly string[]>> = {},
): Promise<Authorized> {
  const pkce = await pkcePair();
  const url = new URL(w.server.endpoint("authorization"));
  const all: Record<string, string | readonly string[]> = {
    response_type: "code",
    client_id: clientId,
    ...(REDIRECTS[clientId] === undefined
      ? {}
      : { redirect_uri: REDIRECTS[clientId] }),
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state: "state-1",
    resource: API,
    scope: "read",
    ...params,
  };
  for (const [name, value] of Object.entries(all)) {
    if (typeof value === "string") url.searchParams.set(name, value);
    else for (const item of value) url.searchParams.append(name, item);
  }
  const response = await w.handle(new Request(url));
  const header = response.headers.get("location");
  const location = header === null ? null : new URL(header);
  return {
    response,
    location,
    verifier: pkce.verifier,
    code: location?.searchParams.get("code") ?? null,
  };
}

/** Redeems a code at the token endpoint. */
export async function redeem(
  w: World,
  authorized: Authorized,
  params: Readonly<Record<string, string | readonly string[]>> = {},
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return await w.handle(post(w.server.endpoint("token"), {
    grant_type: "authorization_code",
    code: authorized.code!,
    code_verifier: authorized.verifier,
    redirect_uri: "https://app.test/cb",
    client_id: "public-app",
    ...params,
  }, headers));
}

/** A token endpoint proof from `key`. */
export async function tokenProof(
  w: World,
  key: DpopKey,
  nonce?: string,
): Promise<Record<string, string>> {
  return {
    dpop: await key.proof({
      method: "POST",
      url: w.server.endpoint("token"),
      nonce,
      now: w.clock.now,
    }),
  };
}

/** A response's JSON body. */
export async function body(
  response: Response,
): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

/** Checks an OAuth error response. */
export async function oauthError(
  response: Response,
  status: number,
  error: string,
): Promise<Record<string, unknown>> {
  const json = await body(response);
  assertEquals(
    { status: response.status, error: json.error },
    { status, error },
    JSON.stringify(json),
  );
  return json;
}
