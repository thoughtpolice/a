// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/oidc/federation`: OpenID Federation 1.0.
 *
 * - Entity statements: {@link signStatement}, {@link verifyStatement},
 *   and the claim types.
 * - {@link FederationEntity}: an entity's configuration and its fetch,
 *   list and resolve endpoints, as `(Request) => Response` handlers, and
 *   trust mark issuance.
 * - {@link TrustChainResolver}: trust chains from an entity to a
 *   configured anchor, with path length, expiry and loop protection,
 *   constraints, metadata policies and trust marks.
 * - Metadata policies: {@link resolveMetadataPolicy} and
 *   {@link applyMetadataPolicy}, every standard operator with its
 *   combination and merge rules.
 * - Registration: {@link federatedClients} (automatic, for the provider's
 *   `resolveClient`), {@link ExplicitRegistration} (the registration
 *   endpoint) and {@link federatedOidcClient} (the RP side).
 *
 * @module
 */

export {
  hostMatches,
  type ResolveOptions,
  type TrustAnchor,
  type TrustChain,
  TrustChainResolver,
  type TrustChainResolverOptions,
} from "./chain.ts";
export {
  FederationEntity,
  type FederationEntityOptions,
  type SubordinateConfig,
} from "./entity.ts";
export {
  applyMetadataPolicy,
  checkParameterPolicy,
  mergeParameterPolicy,
  type ParameterPolicy,
  POLICY_OPERATORS,
  type PolicyOperator,
  resolveMetadataPolicy,
} from "./policy.ts";
export {
  clientFromMetadata,
  ExplicitRegistration,
  type ExplicitRegistrationOptions,
  federatedClients,
  type FederatedClientsOptions,
  type FederatedOidcClient,
  federatedOidcClient,
  type FederatedOidcClientOptions,
} from "./registration.ts";
export {
  checkStatementClaims,
  type Constraints,
  ENTITY_TYPES,
  entityConfigurationUrl,
  type EntityMetadata,
  type EntityStatement,
  FEDERATION_ALGORITHMS,
  FederationError,
  type FederationErrorCode,
  federationJwks,
  isEntityId,
  MEDIA_TYPES,
  type MetadataPolicy,
  OPENID_FEDERATION_PATH,
  peekStatement,
  signStatement,
  type TrustMarkEntry,
  verifyStatement,
  type VerifyStatementOptions,
} from "./statement.ts";
export {
  issueTrustMark,
  issueTrustMarkDelegation,
  type TrustMarkContext,
  type VerifiedTrustMark,
  verifyTrustMark,
} from "./trust_marks.ts";
