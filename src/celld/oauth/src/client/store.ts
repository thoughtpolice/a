// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Where a client keeps what it obtained. Everything is keyed by the
 * authorization server's issuer: a client registration from one server is
 * never offered to another. Tokens are further keyed by the resource they
 * were issued for, so a token is only ever sent to the resource it names.
 * Implementations must keep these secrets confidential (encrypted at rest,
 * never logged).
 *
 * @module
 */

/** A client identity at one authorization server. */
export interface ClientInformation {
  readonly client_id: string;
  readonly client_secret?: string;
  /** Epoch seconds; 0 or absent for never (RFC 7591). */
  readonly client_secret_expires_at?: number;
  /** `none`, `client_secret_basic`, `client_secret_post` or `private_key_jwt`. */
  readonly token_endpoint_auth_method?: string;
  /** RFC 7592's management token, when the server returned one. */
  readonly registration_access_token?: string;
  readonly registration_client_uri?: string;
  /** Where it came from. */
  readonly source?: "preregistered" | "metadata_document" | "dynamic";
}

/** Tokens for one resource from one authorization server. */
export interface TokenSet {
  readonly access_token: string;
  /** `Bearer` or `DPoP`. */
  readonly token_type: "Bearer" | "DPoP";
  /** Epoch milliseconds, when the server said. */
  readonly expires_at?: number;
  readonly refresh_token?: string;
  /** The granted scopes, when the server said. */
  readonly scope?: string;
  /** The scopes that were requested. */
  readonly requested_scope?: string;
  /** RFC 8693: what kind of token `access_token` is. */
  readonly issued_token_type?: string;
  /** OpenID Connect, passed through for a layer above to validate. */
  readonly id_token?: string;
  /** The thumbprint of the DPoP key the tokens are bound to. */
  readonly dpop_jkt?: string;
}

/** Storage for client registrations and tokens. */
export interface OAuthStore {
  getClient(issuer: string): Promise<ClientInformation | undefined>;
  setClient(issuer: string, client: ClientInformation): Promise<void>;
  deleteClient(issuer: string): Promise<void>;
  getTokens(issuer: string, resource: string): Promise<TokenSet | undefined>;
  setTokens(issuer: string, resource: string, tokens: TokenSet): Promise<void>;
  deleteTokens(issuer: string, resource: string): Promise<void>;
}

/** An in-memory {@link OAuthStore}. */
export function memoryOAuthStore(): OAuthStore {
  const clients = new Map<string, ClientInformation>();
  const tokens = new Map<string, TokenSet>();
  const key = (issuer: string, resource: string) =>
    JSON.stringify([issuer, resource]);
  return {
    getClient: (issuer) => Promise.resolve(clients.get(issuer)),
    setClient(issuer, client) {
      clients.set(issuer, client);
      return Promise.resolve();
    },
    deleteClient(issuer) {
      clients.delete(issuer);
      return Promise.resolve();
    },
    getTokens: (issuer, resource) =>
      Promise.resolve(tokens.get(key(issuer, resource))),
    setTokens(issuer, resource, value) {
      tokens.set(key(issuer, resource), value);
      return Promise.resolve();
    },
    deleteTokens(issuer, resource) {
      tokens.delete(key(issuer, resource));
      return Promise.resolve();
    },
  };
}
