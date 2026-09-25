// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Client authentication at an authorization server's endpoints (RFC 6749
 * section 2.3, OAuth 2.1 section 2.4): `none` for public clients,
 * `client_secret_basic`, `client_secret_post`, and `private_key_jwt`
 * (RFC 7523 section 2.2, signed with `@celld/jwt`).
 *
 * @module
 */

import { type JwsAlgorithm, type KeyLike, sign } from "@celld/jwt";
import { JWT_BEARER_ASSERTION } from "../constants.ts";
import { basicAuthorization, type Clock, randomToken } from "../util.ts";

/** How a client proves who it is. */
export type ClientAuthentication =
  | { readonly method: "none"; readonly clientId: string }
  | {
    readonly method: "client_secret_basic" | "client_secret_post";
    readonly clientId: string;
    readonly clientSecret: string;
  }
  | {
    readonly method: "private_key_jwt";
    readonly clientId: string;
    readonly privateKey: KeyLike;
    readonly alg: JwsAlgorithm;
    readonly kid?: string;
    /**
     * The assertion's `aud`: `issuer` (the default, as
     * draft-ietf-oauth-rfc7523bis requires, which stops an assertion made
     * for one server from being replayed at another), `endpoint` (the URL
     * it is sent to, for servers that still want RFC 7523's form), or an
     * explicit value.
     */
    readonly audience?: "issuer" | "endpoint" | { readonly value: string };
    /** Seconds the assertion is valid; default 60. */
    readonly lifetimeSec?: number;
  };

/** What an authenticated request adds: headers and body parameters. */
export interface AppliedAuthentication {
  readonly headers: Readonly<Record<string, string>>;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * The headers and parameters that authenticate `auth` to `endpoint` at
 * `issuer`. A `private_key_jwt` assertion is signed fresh each call, with
 * a random `jti`, so a retried request never repeats one.
 */
export async function applyClientAuthentication(
  auth: ClientAuthentication,
  issuer: string,
  endpoint: string,
  now: Clock,
): Promise<AppliedAuthentication> {
  switch (auth.method) {
    case "none":
      return { headers: {}, params: { client_id: auth.clientId } };
    case "client_secret_basic":
      return {
        headers: {
          authorization: basicAuthorization(auth.clientId, auth.clientSecret),
        },
        params: {},
      };
    case "client_secret_post":
      return {
        headers: {},
        params: { client_id: auth.clientId, client_secret: auth.clientSecret },
      };
    case "private_key_jwt": {
      const audience = auth.audience ?? "issuer";
      const aud = audience === "issuer"
        ? issuer
        : audience === "endpoint"
        ? endpoint
        : audience.value;
      const iat = Math.floor(now() / 1000);
      const assertion = await sign(
        {
          iss: auth.clientId,
          sub: auth.clientId,
          aud,
          iat,
          exp: iat + (auth.lifetimeSec ?? 60),
          jti: randomToken(16),
        },
        auth.privateKey,
        { alg: auth.alg, kid: auth.kid, typ: "JWT" },
      );
      return {
        headers: {},
        params: {
          client_id: auth.clientId,
          client_assertion_type: JWT_BEARER_ASSERTION,
          client_assertion: assertion,
        },
      };
    }
  }
}
