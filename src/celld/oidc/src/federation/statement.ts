// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Entity statements (OpenID Federation 1.0 section 3): their claims,
 * signing them, and verifying one against a key set with the checks of
 * section 3.2 that need no other statement. {@link FederationError} is
 * every federation failure.
 *
 * @module
 */

import type { Clock } from "@celld/oauth";
import { secureUrlProblem } from "@celld/oauth";
import type { SigningKey } from "@celld/oauth/server";
import {
  type Jwks,
  type JwsAlgorithm,
  JwtError,
  localJwks,
  sign,
  tryDecode,
  verify,
} from "@celld/jwt";
import { isObject, isStringArray, rethrowRuntimeUnsupported } from "../util.ts";

/** The media types and `typ`s of section 15. */
export const MEDIA_TYPES = {
  entityStatement: "entity-statement+jwt",
  trustMark: "trust-mark+jwt",
  trustMarkDelegation: "trust-mark-delegation+jwt",
  resolveResponse: "resolve-response+jwt",
  explicitRegistrationResponse: "explicit-registration-response+jwt",
  trustChain: "trust-chain+json",
} as const;

/** The well-known path of an entity configuration, appended to the entity identifier. */
export const OPENID_FEDERATION_PATH = "/.well-known/openid-federation";

/** The entity types of section 5.1. */
export const ENTITY_TYPES = {
  federationEntity: "federation_entity",
  openidRelyingParty: "openid_relying_party",
  openidProvider: "openid_provider",
  oauthAuthorizationServer: "oauth_authorization_server",
  oauthClient: "oauth_client",
  oauthResource: "oauth_resource",
} as const;

/** Metadata by entity type, each a JSON object of parameters. */
export type EntityMetadata = Readonly<
  Record<string, Readonly<Record<string, unknown>>>
>;

/** A metadata policy (section 6.1.2): entity type, then parameter, then operators. */
export type MetadataPolicy = Readonly<
  Record<string, Readonly<Record<string, Readonly<Record<string, unknown>>>>>
>;

/** The constraints of section 6.2. */
export interface Constraints {
  readonly max_path_length?: number;
  readonly naming_constraints?: {
    readonly permitted?: readonly string[];
    readonly excluded?: readonly string[];
  };
  readonly allowed_entity_types?: readonly string[];
  readonly [name: string]: unknown;
}

/** A trust mark as an entity configuration carries it (section 3.1.2). */
export interface TrustMarkEntry {
  readonly trust_mark_type: string;
  readonly trust_mark: string;
}

/** The claims of an entity statement. */
export interface EntityStatement {
  readonly iss: string;
  readonly sub: string;
  readonly iat: number;
  readonly exp: number;
  readonly jwks?: Jwks;
  readonly metadata?: EntityMetadata;
  readonly metadata_policy?: MetadataPolicy;
  readonly metadata_policy_crit?: readonly string[];
  readonly constraints?: Constraints;
  readonly crit?: readonly string[];
  readonly authority_hints?: readonly string[];
  readonly trust_anchor_hints?: readonly string[];
  readonly trust_marks?: readonly TrustMarkEntry[];
  readonly trust_mark_issuers?: Readonly<Record<string, readonly string[]>>;
  readonly trust_mark_owners?: Readonly<
    Record<string, { readonly sub: string; readonly jwks: Jwks }>
  >;
  readonly source_endpoint?: string;
  /** Explicit registration requests and responses only. */
  readonly aud?: string;
  /** Explicit registration responses only. */
  readonly trust_anchor?: string;
  readonly [claim: string]: unknown;
}

/** What went wrong in federation processing. */
export type FederationErrorCode =
  /** A statement is not a well-formed JWS or has malformed claims. */
  | "malformed"
  /** The `typ` is not the one required. */
  | "typ"
  /** No key of the right set verifies it, or `kid` is missing or unknown. */
  | "signature"
  /** Outside its `iat`/`exp` window. */
  | "expired"
  /** A statement could not be fetched. */
  | "fetch"
  /** No valid trust chain, or one that breaks section 10.2's rules. */
  | "chain"
  /** The metadata policy is malformed, conflicts, or the metadata does not comply. */
  | "policy"
  /** A constraint of section 6.2 is violated. */
  | "constraints"
  /** A trust mark is invalid. */
  | "trust_mark";

/** A federation failure. */
export class FederationError extends Error {
  override name = "FederationError";
  readonly code: FederationErrorCode;

  constructor(
    code: FederationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.code = code;
  }
}

/** The asymmetric algorithms accepted on federation JWTs. */
export const FEDERATION_ALGORITHMS: readonly JwsAlgorithm[] = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
];

/** Whether `id` is an entity identifier: an https URL (http on loopback) with a host, no query, fragment or user. */
export function isEntityId(id: unknown): id is string {
  if (typeof id !== "string" || secureUrlProblem(id) !== null) return false;
  const url = new URL(id);
  return url.search === "" && url.host !== "";
}

/** Where `entityId`'s entity configuration is published (section 9). */
export function entityConfigurationUrl(entityId: string): string {
  return `${entityId.replace(/\/+$/, "")}${OPENID_FEDERATION_PATH}`;
}

/** The public JWKS of federation keys: every key with its `kid`, `alg` and `use`. */
export function federationJwks(keys: readonly SigningKey[]): Jwks {
  return {
    keys: keys.map((key) => ({
      ...key.publicJwk,
      kid: key.kid,
      alg: key.alg,
      use: "sig",
    })),
  };
}

/** Signs statement claims with `key` as a `typ` JWT (default an entity statement), `kid` in the header. */
export async function signStatement(
  claims: Readonly<Record<string, unknown>>,
  key: SigningKey,
  typ: string = MEDIA_TYPES.entityStatement,
  header: Readonly<Record<string, unknown>> = {},
): Promise<string> {
  return await sign(claims, key.privateKey, {
    alg: key.alg,
    kid: key.kid,
    typ,
    header,
  });
}

function mediaType(typ: unknown): string {
  return typeof typ === "string"
    ? typ.toLowerCase().replace(/^application\//, "")
    : "";
}

function checkJwks(value: unknown, where: string): Jwks {
  if (!isObject(value) || !Array.isArray(value.keys)) {
    throw new FederationError("malformed", `${where} must be a JWK Set`);
  }
  const kids = new Set<string>();
  for (const key of value.keys) {
    if (!isObject(key) || typeof key.kid !== "string" || key.kid === "") {
      throw new FederationError("malformed", `${where} has a key without kid`);
    }
    if (kids.has(key.kid)) {
      throw new FederationError("malformed", `${where} repeats kid ${key.kid}`);
    }
    kids.add(key.kid);
  }
  return value as unknown as Jwks;
}

/**
 * The structural checks of section 3.2 on decoded claims: types of the
 * registered claims, `authority_hints` and `trust_anchor_hints` only in
 * entity configurations (and never empty), `metadata_policy` and
 * `metadata_policy_crit` only in subordinate statements, no null metadata
 * values, and no `crit` names (this implementation understands no
 * extension claims).
 */
export function checkStatementClaims(
  claims: Record<string, unknown>,
  options: {
    readonly requireJwks?: boolean;
    /** Explicit registration responses carry `authority_hints` about their subject. */
    readonly registrationResponse?: boolean;
  } = {},
): EntityStatement {
  const bad = (message: string) => new FederationError("malformed", message);
  for (const name of ["iss", "sub"]) {
    if (!isEntityId(claims[name])) {
      throw bad(`${name} is not an entity identifier`);
    }
  }
  for (const name of ["iat", "exp"]) {
    if (typeof claims[name] !== "number") throw bad(`${name} must be a number`);
  }
  const configuration = claims.iss === claims.sub;
  if (claims.jwks !== undefined || (options.requireJwks ?? true)) {
    checkJwks(claims.jwks, "jwks");
  }
  for (const name of ["authority_hints", "trust_anchor_hints"]) {
    const value = claims[name];
    if (value === undefined) continue;
    if (!configuration && !options.registrationResponse) {
      throw bad(`${name} is only for entity configurations`);
    }
    if (
      !isStringArray(value) || value.length === 0 || !value.every(isEntityId)
    ) {
      throw bad(`${name} must be a non-empty list of entity identifiers`);
    }
  }
  for (
    const name of ["metadata_policy", "metadata_policy_crit", "constraints"]
  ) {
    if (claims[name] !== undefined && configuration) {
      throw bad(`${name} is only for subordinate statements`);
    }
  }
  if (claims.metadata !== undefined) {
    if (!isObject(claims.metadata)) throw bad("metadata must be an object");
    for (const [type, parameters] of Object.entries(claims.metadata)) {
      if (!isObject(parameters)) {
        throw bad(`metadata.${type} must be an object`);
      }
      for (const [name, value] of Object.entries(parameters)) {
        if (value === null) throw bad(`metadata.${type}.${name} is null`);
      }
    }
  }
  if (
    claims.metadata_policy !== undefined && !isObject(claims.metadata_policy)
  ) {
    throw bad("metadata_policy must be an object");
  }
  if (claims.metadata_policy_crit !== undefined) {
    const crit = claims.metadata_policy_crit;
    if (!isStringArray(crit) || crit.length === 0) {
      throw bad("metadata_policy_crit must be a non-empty list");
    }
  }
  if (claims.constraints !== undefined && !isObject(claims.constraints)) {
    throw bad("constraints must be an object");
  }
  if (claims.crit !== undefined) {
    if (!isStringArray(claims.crit)) throw bad("crit must be a list");
    if (claims.crit.length > 0) {
      throw new FederationError(
        "malformed",
        `critical claims are not understood: ${claims.crit.join(", ")}`,
      );
    }
  }
  if (claims.trust_marks !== undefined) {
    const marks = claims.trust_marks;
    if (
      !Array.isArray(marks) ||
      !marks.every((mark) =>
        isObject(mark) && typeof mark.trust_mark_type === "string" &&
        typeof mark.trust_mark === "string"
      )
    ) {
      throw bad("trust_marks must be a list of {trust_mark_type, trust_mark}");
    }
  }
  return claims as EntityStatement;
}

/** What {@link verifyStatement} checks beyond the signature. */
export interface VerifyStatementOptions {
  /** The `typ` required; default `entity-statement+jwt`. */
  readonly typ?: string;
  /** Default true; false for explicit registration responses. */
  readonly requireJwks?: boolean;
  /** Seconds of clock skew for `iat` and `exp`; default 30. */
  readonly clockToleranceSec?: number;
  readonly now: Clock;
}

/**
 * Verifies an entity statement with `jwks` (the issuer's federation keys,
 * however they were obtained) and returns its claims: `typ`, an
 * asymmetric `alg`, a `kid` that names a key in `jwks`, the signature,
 * `iat` not in the future and `exp` not past, then
 * {@link checkStatementClaims}.
 */
export async function verifyStatement(
  jwt: string,
  jwks: Jwks,
  options: VerifyStatementOptions,
): Promise<EntityStatement> {
  const decoded = tryDecode(jwt);
  if (decoded === null) {
    throw new FederationError(
      "malformed",
      "the statement is not a compact JWS",
    );
  }
  const typ = options.typ ?? MEDIA_TYPES.entityStatement;
  if (mediaType(decoded.header.typ) !== typ) {
    throw new FederationError(
      "typ",
      `the statement's typ is ${
        JSON.stringify(decoded.header.typ)
      }, not ${typ}`,
    );
  }
  const kid = decoded.header.kid;
  if (typeof kid !== "string" || kid === "") {
    throw new FederationError("signature", "the statement has no kid");
  }
  if (!jwks.keys.some((key) => key.kid === kid)) {
    throw new FederationError("signature", `no key with kid ${kid}`);
  }
  const tolerance = options.clockToleranceSec ?? 30;
  let claims: Record<string, unknown>;
  try {
    ({ payload: claims } = await verify(jwt, localJwks(jwks), {
      algorithms: FEDERATION_ALGORITHMS,
      requiredClaims: ["iss", "sub", "iat", "exp"],
      clockTolerance: tolerance,
      now: options.now,
    }));
  } catch (cause) {
    rethrowRuntimeUnsupported(cause);
    if (cause instanceof JwtError) {
      const expired = cause.code === "expired" ||
        cause.code === "not_yet_valid";
      throw new FederationError(
        expired ? "expired" : cause.code === "missing_claim" ||
            cause.code === "invalid_claim" || cause.code === "malformed"
          ? "malformed"
          : "signature",
        `the statement is refused: ${cause.message}`,
        { cause },
      );
    }
    throw cause;
  }
  if ((claims.iat as number) > options.now() / 1000 + tolerance) {
    throw new FederationError(
      "expired",
      "the statement was issued in the future",
    );
  }
  return checkStatementClaims(claims, {
    requireJwks: options.requireJwks,
    registrationResponse: typ === MEDIA_TYPES.explicitRegistrationResponse,
  });
}

/** The claims of a statement without verifying it, or null for one that does not decode. */
export function peekStatement(jwt: string): Record<string, unknown> | null {
  return tryDecode(jwt)?.payload ?? null;
}
