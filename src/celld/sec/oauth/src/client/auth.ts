// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Client authentication at an authorization server's endpoints (RFC 6749
 * section 2.3, OAuth 2.1 section 2.4): `none` for public clients,
 * `client_secret_basic`, `client_secret_post`, and `private_key_jwt`
 * (RFC 7523 section 2.2, signed with `@celld/sec/jwt`).
 *
 * @module
 */

import { jsonSnapshot, safeInt, strictRecord } from "@celld/core/bounds";
import { checkKey, jwkFits, type KeyLike, sign } from "@celld/sec/jwt";
import { JWT_BEARER_ASSERTION } from "../constants.ts";
import { type DpopAlgorithm, isDpopAlgorithm } from "../dpop/key.ts";
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
    readonly alg: DpopAlgorithm;
    readonly kid?: string;
    /**
     * The assertion's `aud`: `issuer` (the default, as
     * draft-ietf-oauth-rfc7523bis requires, which stops an assertion made
     * for one server from being replayed at another), `endpoint` (the URL
     * it is sent to, for servers that still want RFC 7523's form), or an
     * explicit value.
     */
    readonly audience?: "issuer" | "endpoint" | { readonly value: string };
    /**
     * Seconds the assertion is valid, 1 to 300; default 60. Anything else
     * is a `RangeError` when the client is made.
     */
    readonly lifetimeSec?: number;
  };

/**
 * Checks what a {@link ClientAuthentication} holds that is not a string:
 * a `private_key_jwt` `lifetimeSec` must be whole seconds, 1 to 300 (an
 * assertion is a bearer credential, so it stays short). Throws
 * `RangeError`. `OAuthClient` calls it when it is made.
 */
export function checkClientAuthentication(auth: ClientAuthentication): void {
  // Inspect descriptors before reading the discriminator: a getter must never
  // execute merely because this is a trusted-looking configuration object.
  strictRecord(auth as unknown, [
    "method",
    "clientId",
    "privateKey",
    "alg",
    "kid",
    "audience",
    "lifetimeSec",
    "clientSecret",
  ], "client authentication");
  strictRecord(auth, [
    "method",
    "clientId",
    ...(auth.method === "private_key_jwt"
      ? ["privateKey", "alg", "kid", "audience", "lifetimeSec"]
      : auth.method === "none"
      ? []
      : ["clientSecret"]),
  ], "client authentication");
  if (
    typeof auth.clientId !== "string" || auth.clientId.length === 0 ||
    auth.clientId.length > 4096
  ) throw new TypeError("clientId must be a bounded nonempty string");
  if (
    !["none", "client_secret_basic", "client_secret_post", "private_key_jwt"]
      .includes(auth.method)
  ) throw new TypeError("unknown client authentication method");
  if (
    (auth.method === "client_secret_basic" ||
      auth.method === "client_secret_post") &&
    (typeof auth.clientSecret !== "string" || auth.clientSecret.length === 0 ||
      auth.clientSecret.length > 4096)
  ) throw new TypeError("clientSecret must be a bounded nonempty string");
  if (auth.method === "private_key_jwt") {
    if (!isDpopAlgorithm(auth.alg)) {
      throw new TypeError("private_key_jwt requires an asymmetric algorithm");
    }
    if (
      auth.audience !== undefined && auth.audience !== "issuer" &&
      auth.audience !== "endpoint"
    ) {
      strictRecord(auth.audience, ["value"], "assertion audience");
      if (
        typeof auth.audience.value !== "string" ||
        auth.audience.value.length === 0 || auth.audience.value.length > 4096
      ) {
        throw new TypeError(
          "assertion audience must be a bounded nonempty string",
        );
      }
    }
    if (
      auth.kid !== undefined &&
      (typeof auth.kid !== "string" || auth.kid.length === 0 ||
        auth.kid.length > 1024)
    ) throw new TypeError("assertion kid must be a bounded nonempty string");
    if (typeof auth.privateKey !== "object" || auth.privateKey === null) {
      throw new TypeError("private_key_jwt needs a private key");
    }
    if (auth.privateKey instanceof CryptoKey) {
      checkKey(auth.privateKey, auth.alg, "sign");
    } else {
      const key = jsonSnapshot(auth.privateKey);
      if (
        key instanceof Uint8Array || !jwkFits(key, auth.alg, "sign") ||
        typeof key.d !== "string" || key.d.length === 0
      ) {
        throw new TypeError(
          "private_key_jwt key must be a matching private signing key",
        );
      }
    }
    assertionLifetime(auth);
  }
}

function assertionLifetime(
  auth: { readonly lifetimeSec?: number },
): number {
  return safeInt(auth.lifetimeSec ?? 60, {
    name: "client.lifetimeSec",
    min: 1,
    max: 300,
  });
}

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
  checkClientAuthentication(auth);
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
          exp: iat + assertionLifetime(auth),
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
