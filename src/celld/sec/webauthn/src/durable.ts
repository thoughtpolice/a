// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `PasskeyDirectory`, the Durable Object behind `durablePasskeys`, and the
 * only module here that imports `cloudflare:workers`.
 *
 * One named object holds a relying party's users, credentials and used
 * challenges in its SQLite, so every rule that spans them (a credential ID
 * is registered once, a principal has one user, a challenge is used once)
 * is one synchronous method: atomic, and never interleaved with another.
 * A ceremony is one or two calls to it. Writes do not wait for
 * `storage.sync()`; a node lost before its writes reach the fleet's storage
 * forgets the last few sign-ins' counters and challenges, and the last
 * registrations, which their users make again.
 *
 * Export it from the Worker and bind it:
 *
 * ```ts
 * export { PasskeyDirectory } from "@celld/sec/webauthn/durable";
 * ```
 *
 * ```python
 * celld.project(..., bindings = {"PASSKEYS": "PasskeyDirectory"})
 * ```
 *
 * @module
 */

import { DurableObject } from "cloudflare:workers";
import type { PasskeyDirectoryApi } from "./client.ts";
import {
  type AuthenticateResult,
  type Authentication,
  DirectoryCore,
  type DirectoryTables,
  type PasskeyCredential,
  type PasskeyUser,
  type RegisterResult,
  type Registration,
  type RemoveOptions,
  type RemoveResult,
} from "./store.ts";

export type { PasskeyDirectoryApi };

interface UserRow {
  handle: string;
  principal_key: string;
  principal: string;
  name: string;
  display_name: string;
  created_at: number;
  [column: string]: SqlStorageValue;
}

function toUser(row: UserRow): PasskeyUser {
  return {
    handle: row.handle,
    principalKey: row.principal_key,
    principal: JSON.parse(row.principal),
    name: row.name,
    displayName: row.display_name,
    createdAt: row.created_at,
  };
}

/** {@link DirectoryTables} in a Durable Object's SQLite. */
class SqlTables implements DirectoryTables {
  readonly #storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
    for (
      const statement of [
        "CREATE TABLE IF NOT EXISTS celld_passkey_users (handle TEXT PRIMARY KEY, principal_key TEXT NOT NULL UNIQUE, principal TEXT NOT NULL, name TEXT NOT NULL, display_name TEXT NOT NULL, created_at INTEGER NOT NULL)",
        "CREATE TABLE IF NOT EXISTS celld_passkey_credentials (id TEXT PRIMARY KEY, user_handle TEXT NOT NULL, created_at INTEGER NOT NULL, record TEXT NOT NULL)",
        "CREATE INDEX IF NOT EXISTS celld_passkey_credentials_user ON celld_passkey_credentials (user_handle, created_at)",
        "CREATE TABLE IF NOT EXISTS celld_passkey_challenges (challenge TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)",
        "CREATE INDEX IF NOT EXISTS celld_passkey_challenges_expiry ON celld_passkey_challenges (expires_at)",
      ]
    ) storage.sql.exec(statement).toArray();
  }

  #rows<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): T[] {
    return this.#storage.sql.exec<T>(query, ...bindings).toArray();
  }

  transaction<T>(fn: () => T): T {
    return this.#storage.transactionSync(fn);
  }

  getUser(handle: string): PasskeyUser | null {
    const [row] = this.#rows<UserRow>(
      "SELECT * FROM celld_passkey_users WHERE handle = ?",
      handle,
    );
    return row === undefined ? null : toUser(row);
  }

  getUserByPrincipal(principalKey: string): PasskeyUser | null {
    const [row] = this.#rows<UserRow>(
      "SELECT * FROM celld_passkey_users WHERE principal_key = ?",
      principalKey,
    );
    return row === undefined ? null : toUser(row);
  }

  putUser(user: PasskeyUser): void {
    this.#rows(
      "INSERT INTO celld_passkey_users (handle, principal_key, principal, name, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      user.handle,
      user.principalKey,
      JSON.stringify(user.principal),
      user.name,
      user.displayName,
      user.createdAt,
    );
  }

  getCredential(id: string): PasskeyCredential | null {
    const [row] = this.#rows<{ record: string }>(
      "SELECT record FROM celld_passkey_credentials WHERE id = ?",
      id,
    );
    return row === undefined ? null : JSON.parse(row.record);
  }

  listCredentials(userHandle: string): PasskeyCredential[] {
    return this.#rows<{ record: string }>(
      "SELECT record FROM celld_passkey_credentials WHERE user_handle = ? ORDER BY created_at, id",
      userHandle,
    ).map((row) => JSON.parse(row.record));
  }

  putCredential(credential: PasskeyCredential): void {
    this.#rows(
      "INSERT INTO celld_passkey_credentials (id, user_handle, created_at, record) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET record = excluded.record",
      credential.id,
      credential.userHandle,
      credential.createdAt,
      JSON.stringify(credential),
    );
  }

  deleteCredential(id: string): void {
    this.#rows("DELETE FROM celld_passkey_credentials WHERE id = ?", id);
  }

  useChallenge(challenge: string, expiresAt: number): boolean {
    const [row] = this.#rows<{ challenge: string }>(
      "INSERT INTO celld_passkey_challenges (challenge, expires_at) VALUES (?, ?) ON CONFLICT (challenge) DO NOTHING RETURNING challenge",
      challenge,
      expiresAt,
    );
    return row !== undefined;
  }

  sweepChallenges(now: number, max: number): void {
    this.#rows(
      "DELETE FROM celld_passkey_challenges WHERE challenge IN (SELECT challenge FROM celld_passkey_challenges WHERE expires_at <= ? LIMIT ?)",
      now,
      max,
    );
  }
}

/** A relying party's users, passkeys and used challenges. */
export class PasskeyDirectory extends DurableObject
  implements PasskeyDirectoryApi {
  readonly #core: DirectoryCore;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.#core = new DirectoryCore(new SqlTables(ctx.storage));
  }

  user(handle: string): PasskeyUser | null {
    return this.#core.user(handle);
  }

  userByPrincipal(principalKey: string): PasskeyUser | null {
    return this.#core.userByPrincipal(principalKey);
  }

  credential(id: string): PasskeyCredential | null {
    return this.#core.credential(id);
  }

  credentials(userHandle: string): PasskeyCredential[] {
    return this.#core.credentials(userHandle);
  }

  register(registration: Registration): RegisterResult {
    return this.#core.register(registration);
  }

  authenticate(authentication: Authentication): AuthenticateResult {
    return this.#core.authenticate(authentication);
  }

  rename(userHandle: string, id: string, name: string): boolean {
    return this.#core.rename(userHandle, id, name);
  }

  remove(
    userHandle: string,
    id: string,
    options?: RemoveOptions,
  ): RemoveResult {
    return this.#core.remove(userHandle, id, options);
  }
}
