// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/oidc/broker`: an OpenID Provider that federates to an upstream
 * provider, holding the upstream DPoP key itself and issuing its own
 * DPoP-bound tokens downstream ({@link UpstreamBroker}), and the token
 * exchange that keeps `cnf.jkt` bindings ({@link boundTokenExchange}).
 *
 * @module
 */

export {
  boundTokenExchange,
  type BoundTokenExchangeOptions,
  type BrokeredLogin,
  UpstreamBroker,
  type UpstreamBrokerOptions,
  type UpstreamRecord,
} from "./broker.ts";
