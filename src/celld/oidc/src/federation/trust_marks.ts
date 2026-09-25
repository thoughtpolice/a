// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Trust marks (OpenID Federation 1.0 section 7): issuing them, and
 * validating one (section 7.3) with its delegation (section 7.2.2)
 * against the trust anchor that vouches for its issuer.
 *
 * @module
 */

import type { Clock } from "@celld/oauth";
import type { SigningKey } from "@celld/oauth/server";
import { type Jwks, JwtError, localJwks, tryDecode, verify } from "@celld/jwt";
import { epochSeconds, isObject, rethrowRuntimeUnsupported } from "../util.ts";
import {
  type EntityStatement,
  FEDERATION_ALGORITHMS,
  FederationError,
  MEDIA_TYPES,
  signStatement,
} from "./statement.ts";

/** A trust mark that passed validation. */
export interface VerifiedTrustMark {
  readonly trustMarkType: string;
  readonly issuer: string;
  readonly subject: string;
  readonly issuedAt: number;
  readonly expiresAt?: number;
  /** The JWT, as the entity carried it. */
  readonly trustMark: string;
  readonly claims: Readonly<Record<string, unknown>>;
}

/** Signs a trust mark (section 7.1) about `subject` with the issuer's federation key. */
export async function issueTrustMark(
  key: SigningKey,
  options: {
    readonly issuer: string;
    readonly subject: string;
    readonly trustMarkType: string;
    /** Seconds; default no expiry. */
    readonly ttlSec?: number;
    /** A delegation JWT from the trust mark's owner. */
    readonly delegation?: string;
    readonly claims?: Readonly<Record<string, unknown>>;
    readonly now: Clock;
  },
): Promise<string> {
  const iat = epochSeconds(options.now);
  return await signStatement(
    {
      ...options.claims,
      iss: options.issuer,
      sub: options.subject,
      trust_mark_type: options.trustMarkType,
      iat,
      ...(options.ttlSec === undefined ? {} : { exp: iat + options.ttlSec }),
      ...(options.delegation === undefined
        ? {}
        : { delegation: options.delegation }),
    },
    key,
    MEDIA_TYPES.trustMark,
  );
}

/** Signs a trust mark delegation (section 7.2.1) from the type's owner to an issuer. */
export async function issueTrustMarkDelegation(
  key: SigningKey,
  options: {
    readonly owner: string;
    readonly issuer: string;
    readonly trustMarkType: string;
    readonly ttlSec?: number;
    readonly now: Clock;
  },
): Promise<string> {
  const iat = epochSeconds(options.now);
  return await signStatement(
    {
      iss: options.owner,
      sub: options.issuer,
      trust_mark_type: options.trustMarkType,
      iat,
      ...(options.ttlSec === undefined ? {} : { exp: iat + options.ttlSec }),
    },
    key,
    MEDIA_TYPES.trustMarkDelegation,
  );
}

async function verifyTyped(
  jwt: string,
  jwks: Jwks,
  typ: string,
  now: Clock,
  tolerance: number,
): Promise<Record<string, unknown>> {
  const decoded = tryDecode(jwt);
  if (decoded === null) {
    throw new FederationError("trust_mark", `the ${typ} is not a compact JWS`);
  }
  const header = String(decoded.header.typ ?? "").toLowerCase().replace(
    /^application\//,
    "",
  );
  if (header !== typ) {
    throw new FederationError("trust_mark", `the typ is not ${typ}`);
  }
  if (typeof decoded.header.kid !== "string" || decoded.header.kid === "") {
    throw new FederationError("trust_mark", `the ${typ} has no kid`);
  }
  try {
    const { payload } = await verify(jwt, localJwks(jwks), {
      algorithms: FEDERATION_ALGORITHMS,
      requiredClaims: ["iss", "sub", "iat", "trust_mark_type"],
      clockTolerance: tolerance,
      now,
    });
    if ((payload.iat as number) > now() / 1000 + tolerance) {
      throw new FederationError(
        "trust_mark",
        `the ${typ} was issued in the future`,
      );
    }
    return payload;
  } catch (cause) {
    if (cause instanceof FederationError) throw cause;
    rethrowRuntimeUnsupported(cause);
    throw new FederationError(
      "trust_mark",
      `the ${typ} does not verify: ${
        cause instanceof JwtError ? cause.message : cause
      }`,
      { cause },
    );
  }
}

/** What {@link verifyTrustMark} needs. */
export interface TrustMarkContext {
  /** The entity whose configuration carries the mark: the mark's `sub`. */
  readonly subject: string;
  /** The trust anchor's entity configuration (its `trust_mark_issuers` and `trust_mark_owners`). */
  readonly trustAnchor: EntityStatement;
  /** The trust anchor's keys, for marks it issues itself. */
  readonly trustAnchorJwks: Jwks;
  /**
   * The federation keys of an issuer, as vouched for through a trust
   * chain to the same trust anchor; null when it has none.
   */
  readonly issuerKeys: (issuer: string) => Promise<Jwks | null>;
  readonly now: Clock;
  readonly clockToleranceSec?: number;
}

/**
 * Validates a trust mark (section 7.3): `typ` `trust-mark+jwt`, an
 * accepted asymmetric `alg` and a `kid`; `sub` is the entity carrying it;
 * `iat` past and `exp` (if any) future; the issuer is accepted for the
 * type by the trust anchor's `trust_mark_issuers` (an empty list accepts
 * any issuer; the anchor may always issue its own) and its signature
 * verifies with the issuer's keys; and when the anchor names an owner
 * for the type in `trust_mark_owners`, a valid delegation from that owner
 * to the issuer.
 */
export async function verifyTrustMark(
  jwt: string,
  context: TrustMarkContext,
): Promise<VerifiedTrustMark> {
  const tolerance = context.clockToleranceSec ?? 30;
  const peek = tryDecode(jwt)?.payload;
  const issuer = peek?.iss;
  const type = peek?.trust_mark_type;
  if (typeof issuer !== "string" || typeof type !== "string") {
    throw new FederationError(
      "trust_mark",
      "the trust mark has no iss or type",
    );
  }
  const anchorId = context.trustAnchor.iss;
  if (issuer !== anchorId) {
    const accepted = context.trustAnchor.trust_mark_issuers?.[type];
    if (accepted === undefined) {
      throw new FederationError(
        "trust_mark",
        `the trust anchor accepts no issuer of ${type}`,
      );
    }
    if (accepted.length > 0 && !accepted.includes(issuer)) {
      throw new FederationError(
        "trust_mark",
        `${issuer} may not issue ${type}`,
      );
    }
  }
  const keys = issuer === anchorId
    ? context.trustAnchorJwks
    : await context.issuerKeys(issuer);
  if (keys === null) {
    throw new FederationError(
      "trust_mark",
      `${issuer} has no trust chain to the trust anchor`,
    );
  }
  const claims = await verifyTyped(
    jwt,
    keys,
    MEDIA_TYPES.trustMark,
    context.now,
    tolerance,
  );
  if (claims.sub !== context.subject) {
    throw new FederationError(
      "trust_mark",
      "the trust mark is about another entity",
    );
  }
  const owner = context.trustAnchor.trust_mark_owners?.[type];
  if (owner !== undefined) {
    if (typeof claims.delegation !== "string") {
      throw new FederationError(
        "trust_mark",
        `${type} has an owner, so the mark needs a delegation`,
      );
    }
    if (!isObject(owner) || !isObject(owner.jwks)) {
      throw new FederationError("trust_mark", "trust_mark_owners is malformed");
    }
    const delegation = await verifyTyped(
      claims.delegation,
      owner.jwks,
      MEDIA_TYPES.trustMarkDelegation,
      context.now,
      tolerance,
    );
    if (delegation.iss !== owner.sub) {
      throw new FederationError(
        "trust_mark",
        "the delegation is not from the owner",
      );
    }
    if (delegation.sub !== issuer) {
      throw new FederationError(
        "trust_mark",
        "the delegation is for another issuer",
      );
    }
    if (delegation.trust_mark_type !== type) {
      throw new FederationError(
        "trust_mark",
        "the delegation is for another type",
      );
    }
  }
  return {
    trustMarkType: type,
    issuer,
    subject: context.subject,
    issuedAt: claims.iat as number,
    ...(typeof claims.exp === "number" ? { expiresAt: claims.exp } : {}),
    trustMark: jwt,
    claims,
  };
}
