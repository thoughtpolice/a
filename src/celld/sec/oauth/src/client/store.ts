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
import { jsonSnapshot } from "@celld/core/bounds";
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

/**
 * Storage for client registrations and tokens.
 *
 * A store shared by several `OAuthSession`s (per-request sessions, or
 * several isolates over one Durable Object) should implement
 * {@link OAuthStore.lock}: refreshing a token and registering a client
 * are read-then-write sequences, and without a shared lock two sessions
 * can both refresh one refresh token (a rotating server then revokes the
 * whole family, and both sessions lose their tokens) or both register a
 * client (two client ids, tokens stored for one used with the other).
 * Without `lock`, a session serializes only its own refreshes.
 */
export interface OAuthStore {
  getClient(issuer: string): Promise<ClientInformation | undefined>;
  setClient(issuer: string, client: ClientInformation): Promise<void>;
  deleteClient(issuer: string): Promise<void>;
  getTokens(issuer: string, resource: string): Promise<TokenSet | undefined>;
  setTokens(issuer: string, resource: string, tokens: TokenSet): Promise<void>;
  deleteTokens(issuer: string, resource: string): Promise<void>;
  /**
   * Optional: runs `work` while holding the lock called `name`, shared by
   * every session using this store, and releases it when `work` settles.
   * Sessions take it around a token refresh (re-reading the tokens once
   * they hold it) and around dynamic client registration. A Durable
   * Object store can hold it in the object (with a lease, so a lost
   * holder does not block forever); {@link memoryOAuthStore} holds it in
   * memory, which serves sessions in one isolate.
   */
  lock?<T>(name: string, work: () => Promise<T>): Promise<T>;
}

/** Runs `work` under `name`, after every earlier holder of `name` settled. */
function memoryLock(): <T>(
  name: string,
  work: () => Promise<T>,
) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const before = tails.get(name) ?? Promise.resolve();
    const run = before.then(work, work);
    const tail = run.then(() => {}, () => {});
    tails.set(name, tail);
    try {
      return await run;
    } finally {
      if (tails.get(name) === tail) tails.delete(name);
    }
  };
}

/** An in-memory {@link OAuthStore}, with an in-memory lock and a fail-closed 10,000-record cap. */
export function memoryOAuthStore(): OAuthStore {
  const clients = new Map<string, ClientInformation>();
  const tokens = new Map<string, TokenSet>();
  const key = (issuer: string, resource: string) =>
    JSON.stringify([issuer, resource]);
  return {
    lock: memoryLock(),
    getClient: (issuer) => Promise.resolve(clients.get(issuer)),
    setClient(issuer, client) {
      if (!clients.has(issuer) && clients.size + tokens.size >= 10_000) {
        throw new RangeError("memory OAuth store is full");
      }
      clients.set(issuer, jsonSnapshot(client));
      return Promise.resolve();
    },
    deleteClient(issuer) {
      clients.delete(issuer);
      return Promise.resolve();
    },
    getTokens: (issuer, resource) =>
      Promise.resolve(tokens.get(key(issuer, resource))),
    setTokens(issuer, resource, value) {
      if (
        !tokens.has(key(issuer, resource)) &&
        clients.size + tokens.size >= 10_000
      ) throw new RangeError("memory OAuth store is full");
      tokens.set(key(issuer, resource), jsonSnapshot(value));
      return Promise.resolve();
    },
    deleteTokens(issuer, resource) {
      tokens.delete(key(issuer, resource));
      return Promise.resolve();
    },
  };
}
