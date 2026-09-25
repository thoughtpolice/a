// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenID Connect client registration through federation (OpenID
 * Federation 1.0 section 12), both sides.
 *
 * Provider side:
 *
 * - {@link federatedClients}: automatic registration. It is a
 *   `resolveClient` for the authorization server: a client id that is an
 *   entity identifier resolves to the RP's trust chain, and its
 *   `openid_relying_party` metadata (after the federation's policies)
 *   becomes the client. Such a client authenticates with
 *   `private_key_jwt` using the keys in that metadata, so its requests go
 *   through PAR or a signed request object, as section 12.1.1 requires,
 *   and it must use DPoP when the resolved metadata says
 *   `dpop_bound_access_tokens`.
 * - {@link ExplicitRegistration}: the `federation_registration_endpoint`
 *   (section 12.2). The RP posts its entity configuration; the provider
 *   validates it through a trust chain, stores the client until the chain
 *   expires, and answers an `explicit-registration-response+jwt`.
 *
 * Relying party side:
 *
 * - {@link federatedOidcClient}: resolves the provider's trust chain (its
 *   `openid_provider` metadata after policies, used instead of
 *   discovery) and its own (to learn what the federation's policies make
 *   of its own metadata, such as `dpop_bound_access_tokens`), and builds
 *   an `OidcClient` that uses its entity identifier as `client_id` and
 *   `private_key_jwt`, and DPoP when either side's resolved metadata asks
 *   for it.
 *
 * @module
 */

import { type Clock, type FetchLike, OAuthError } from "@celld/oauth";
import { checkDpopAlgorithm, type DpopKey } from "@celld/oauth/dpop";
import {
  type ClientConfig,
  type RecordStore,
  registeredClient,
  type SigningKey,
  validateClientMetadata,
} from "@celld/oauth/server";
import type { JwsAlgorithm } from "@celld/jwt";
import {
  checkOpenIdProviderMetadata,
  type OpenIdProviderMetadata,
} from "../metadata.ts";
import { OidcClient } from "../rp/client.ts";
import {
  defaultClock,
  epochSeconds,
  isMediaType,
  jsonResponse,
} from "../util.ts";
import type { TrustChain, TrustChainResolver } from "./chain.ts";
import type { FederationEntity } from "./entity.ts";
import {
  ENTITY_TYPES,
  FederationError,
  isEntityId,
  MEDIA_TYPES,
  peekStatement,
} from "./statement.ts";

const CLIENT_GRANTS = [
  "authorization_code",
  "refresh_token",
  "client_credentials",
  "urn:ietf:params:oauth:grant-type:device_code",
  "urn:ietf:params:oauth:grant-type:token-exchange",
];

/**
 * A client record from an RP's resolved metadata: `client_id` is its
 * entity identifier, and it must authenticate with `private_key_jwt`
 * using the keys in the metadata (`jwks` or `jwks_uri`). Null when the
 * metadata cannot be a client (another authentication method, no keys,
 * bad redirect URIs).
 */
export function clientFromMetadata(
  entityId: string,
  metadata: Readonly<Record<string, unknown>>,
): ClientConfig | null {
  const method = metadata.token_endpoint_auth_method ?? "private_key_jwt";
  if (method !== "private_key_jwt") return null;
  let checked;
  try {
    checked = validateClientMetadata(
      { ...metadata, token_endpoint_auth_method: "private_key_jwt" },
      { authMethods: ["private_key_jwt"], grantTypes: CLIENT_GRANTS },
    );
  } catch {
    return null;
  }
  const {
    client_secret: _secret,
    client_secret_expires_at: _expires,
    client_id: _id,
    ...rest
  } = checked as Record<string, unknown>;
  return {
    ...(rest as ClientConfig),
    client_id: entityId,
    token_endpoint_auth_method: "private_key_jwt",
    source: "resolved",
  };
}

/** Options for {@link federatedClients}. */
export interface FederatedClientsOptions {
  readonly resolver: TrustChainResolver;
  /** Only chains to this trust anchor. */
  readonly trustAnchor?: string;
  /** Default `openid_relying_party`. */
  readonly entityType?: string;
  /** Refuse RPs whose metadata does not list `automatic` in `client_registration_types`; default true. */
  readonly requireAutomatic?: boolean;
  /** Seconds a resolved client is reused (never past its chain); default 300. */
  readonly cacheSec?: number;
  /** Told why an entity identifier did not resolve, for logs. */
  readonly onError?: (clientId: string, error: FederationError) => void;
  readonly now?: Clock;
}

/**
 * A `resolveClient` hook for automatic registration; see the module
 * documentation. A client id that is not an entity identifier is left to
 * the server's other client sources.
 */
export function federatedClients(
  options: FederatedClientsOptions,
): (clientId: string) => Promise<ClientConfig | null> {
  const now = options.now ?? defaultClock;
  const cache = new Map<
    string,
    { until: number; client: ClientConfig | null }
  >();
  return async (clientId) => {
    if (!isEntityId(clientId)) return null;
    const hit = cache.get(clientId);
    if (hit !== undefined && hit.until > now()) return hit.client;
    let client: ClientConfig | null = null;
    let until = now() + 60_000;
    try {
      const chain = await options.resolver.resolve(clientId, {
        trustAnchor: options.trustAnchor,
      });
      const metadata =
        chain.metadata[options.entityType ?? ENTITY_TYPES.openidRelyingParty];
      const types = metadata?.client_registration_types;
      const automatic = !(options.requireAutomatic ?? true) ||
        (Array.isArray(types) && types.includes("automatic"));
      if (metadata !== undefined && automatic) {
        client = clientFromMetadata(clientId, metadata);
      }
      until = Math.min(
        chain.expiresAt * 1000,
        now() + (options.cacheSec ?? 300) * 1000,
      );
    } catch (error) {
      if (!(error instanceof FederationError)) throw error;
      options.onError?.(clientId, error);
    }
    cache.set(clientId, { until, client });
    if (cache.size > 1000) cache.delete(cache.keys().next().value!);
    return client;
  };
}

/** Options for {@link ExplicitRegistration}. */
export interface ExplicitRegistrationOptions {
  readonly resolver: TrustChainResolver;
  /** The provider's federation entity, which signs the responses. */
  readonly entity: FederationEntity;
  /** The provider's store: registered clients go in as `client:<id>`, where the authorization server looks. */
  readonly store: RecordStore;
  /** Default `openid_relying_party`. */
  readonly entityType?: string;
  /** Seconds a registration lasts at most (never past its chain); default 86400. */
  readonly maxLifetimeSec?: number;
  readonly now?: Clock;
}

/** The explicit registration endpoint; see the module documentation. */
export class ExplicitRegistration {
  readonly #options: ExplicitRegistrationOptions;
  readonly #now: Clock;

  constructor(options: ExplicitRegistrationOptions) {
    this.#options = options;
    this.#now = options.now ?? defaultClock;
  }

  /**
   * Handles a registration request: `POST` with an
   * `application/entity-statement+jwt` body (the RP's entity
   * configuration, `aud` this provider). The chain is resolved from the
   * posted configuration, which must verify with the keys its superior
   * vouches for; the registered client is stored until the chain expires.
   * Errors are JSON (`invalid_request`, `invalid_trust_chain`,
   * `invalid_client_metadata`).
   */
  async handle(request: Request): Promise<Response> {
    const refuse = (status: number, error: string, description: string) =>
      jsonResponse(status, { error, error_description: description });
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }
    const type = request.headers.get("content-type") ?? "";
    if (!isMediaType(type, `application/${MEDIA_TYPES.entityStatement}`)) {
      return refuse(
        415,
        "invalid_request",
        "the body must be application/entity-statement+jwt",
      );
    }
    const jwt = (await request.text()).trim();
    const peek = peekStatement(jwt);
    const opId = this.#options.entity.entityId;
    if (
      peek === null || typeof peek.iss !== "string" || peek.iss !== peek.sub
    ) {
      return refuse(
        400,
        "invalid_request",
        "the body is not an entity configuration",
      );
    }
    if (peek.aud !== opId) {
      return refuse(
        400,
        "invalid_request",
        "the request's aud is not this provider",
      );
    }
    const rpId = peek.iss;
    let chain: TrustChain;
    try {
      chain = await this.#options.resolver.resolve(rpId, {
        entityConfiguration: jwt,
      });
    } catch (error) {
      if (!(error instanceof FederationError)) throw error;
      return refuse(400, "invalid_trust_chain", error.message);
    }
    const metadata = chain
      .metadata[this.#options.entityType ?? ENTITY_TYPES.openidRelyingParty];
    const config = metadata === undefined
      ? null
      : clientFromMetadata(rpId, metadata);
    if (config === null) {
      return refuse(
        400,
        "invalid_client_metadata",
        "the resolved metadata is not a private_key_jwt client",
      );
    }
    const exp = Math.min(
      chain.expiresAt,
      epochSeconds(this.#now) + (this.#options.maxLifetimeSec ?? 86400),
    );
    await this.#options.store.put(
      `client:${rpId}`,
      registeredClient(config),
      exp * 1000,
    );
    const response = await this.#options.entity.sign(
      {
        sub: rpId,
        aud: rpId,
        metadata: {
          [this.#options.entityType ?? ENTITY_TYPES.openidRelyingParty]: {
            ...config,
            source: undefined,
          },
        },
        trust_anchor: chain.trustAnchor,
        authority_hints: [chain.claims[1]?.iss ?? chain.trustAnchor],
      },
      MEDIA_TYPES.explicitRegistrationResponse,
      Math.max(1, exp - epochSeconds(this.#now)),
    );
    return new Response(response, {
      status: 200,
      headers: {
        "content-type":
          `application/${MEDIA_TYPES.explicitRegistrationResponse}`,
        "cache-control": "no-store",
      },
    });
  }
}

/** Options for {@link federatedOidcClient}. */
export interface FederatedOidcClientOptions {
  readonly resolver: TrustChainResolver;
  /** The provider's entity identifier. */
  readonly provider: string;
  /** This relying party's entity identifier: its `client_id`. */
  readonly relyingParty: string;
  /** The key in this RP's `openid_relying_party` `jwks` that signs client assertions. */
  readonly key: SigningKey;
  readonly redirectUri: string;
  /** Needed when either side's resolved metadata requires DPoP. */
  readonly dpop?: DpopKey;
  readonly trustAnchor?: string;
  readonly fetch?: FetchLike;
  readonly now?: Clock;
}

/** A relying party's client for a provider it found through the federation. */
export interface FederatedOidcClient {
  readonly client: OidcClient;
  /** The provider's metadata after the federation's policies. */
  readonly provider: OpenIdProviderMetadata;
  readonly providerChain: TrustChain;
  /** This RP's own chain, whose resolved metadata the provider will use. */
  readonly selfChain: TrustChain;
  /** Whether tokens are DPoP-bound. */
  readonly dpop: boolean;
}

/**
 * Builds the relying party's client for automatic registration; see the
 * module documentation. Both chains must lead to the same trust anchor.
 * DPoP is used when this RP's resolved metadata says
 * `dpop_bound_access_tokens` (the key is then required) or a key is
 * given; its algorithm must be one the provider's resolved
 * `dpop_signing_alg_values_supported` allows. The provider must have a
 * PAR endpoint, which carries the `private_key_jwt` that proves the RP's
 * keys.
 */
export async function federatedOidcClient(
  options: FederatedOidcClientOptions,
): Promise<FederatedOidcClient> {
  const providerChain = await options.resolver.resolve(options.provider, {
    trustAnchor: options.trustAnchor,
  });
  const selfChain = await options.resolver.resolve(options.relyingParty, {
    trustAnchor: providerChain.trustAnchor,
  });
  const raw = providerChain.metadata[ENTITY_TYPES.openidProvider];
  if (raw === undefined) {
    throw new OAuthError(
      "discovery",
      `${options.provider} has no openid_provider metadata in the federation`,
    );
  }
  const issuer = typeof raw.issuer === "string" ? raw.issuer : options.provider;
  const checked = checkOpenIdProviderMetadata(raw, issuer);
  if (typeof checked === "string") {
    throw new OAuthError(
      "discovery",
      `the resolved provider metadata is unusable: ${checked}`,
      { issuer },
    );
  }
  if (checked.pushed_authorization_request_endpoint === undefined) {
    throw new OAuthError(
      "unsupported",
      `${issuer} has no PAR endpoint for automatic registration`,
      { issuer },
    );
  }
  const self = selfChain.metadata[ENTITY_TYPES.openidRelyingParty] ?? {};
  const required = self.dpop_bound_access_tokens === true;
  if (required && options.dpop === undefined) {
    throw new OAuthError(
      "dpop",
      "the federation requires DPoP-bound tokens for this RP, and it has no DPoP key",
    );
  }
  if (options.dpop !== undefined) {
    const supported = checked.dpop_signing_alg_values_supported;
    if (supported === undefined) {
      if (required) {
        throw new OAuthError("dpop", `${issuer} does not support DPoP`, {
          issuer,
        });
      }
    } else {
      checkDpopAlgorithm(options.dpop, supported, issuer);
    }
  }
  const useDpop = options.dpop !== undefined &&
    checked.dpop_signing_alg_values_supported !== undefined;
  const alg = self.id_token_signed_response_alg;
  const client = new OidcClient({
    issuer,
    metadata: checked,
    client: {
      method: "private_key_jwt",
      clientId: options.relyingParty,
      privateKey: options.key.privateKey,
      alg: options.key.alg,
      kid: options.key.kid,
    },
    redirectUri: options.redirectUri,
    ...(useDpop ? { dpop: options.dpop } : {}),
    par: "always",
    ...(typeof alg === "string"
      ? { idTokenAlgorithms: [alg as JwsAlgorithm] }
      : {}),
    fetch: options.fetch,
    now: options.now,
  });
  return {
    client,
    provider: checked,
    providerChain,
    selfChain,
    dpop: useDpop,
  };
}
