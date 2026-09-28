// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Where passkeys live: {@link PasskeyStore}, its records, and
 * {@link DirectoryCore}, the one implementation of its rules. The
 * `PasskeyDirectory` Durable Object in `@celld/sec/webauthn/durable` runs the
 * core over its SQLite; {@link MemoryTables} runs it over maps for tests.
 *
 * Finishing a ceremony atomically claims its challenge before attempting the
 * record write, so a response cannot be replayed however many Workers see it.
 * A refused or interrupted write deliberately leaves that challenge spent.
 *
 * @module
 */

import type { StoredCredential } from "./rp.ts";

/**
 * The principal a passkey signs in as. A passkey added by a signed-in user
 * keeps that user's principal (scheme, issuer and all), so signing in with
 * it later gives the same `principal.key`, the same account.
 */
export interface PasskeyPrincipal {
  readonly subject: string;
  readonly scheme?: string;
  readonly issuer?: string;
  readonly tenant?: string;
  readonly clientId?: string;
}

/** A user with passkeys. */
export interface PasskeyUser {
  /** The WebAuthn user handle, base64url of 64 random bytes. */
  readonly handle: string;
  readonly principal: PasskeyPrincipal;
  /** `principal`'s router key; one user per key. */
  readonly principalKey: string;
  /** The name authenticators show (an email, a login). */
  readonly name: string;
  readonly displayName: string;
  readonly createdAt: number;
}

/** A credential record (§4). */
export interface PasskeyCredential extends StoredCredential {
  readonly transports: readonly string[];
  readonly backupState: boolean;
  /** The authenticator model, as a UUID. */
  readonly aaguid: string;
  readonly attestationFormat: "none" | "packed";
  /** A label the user gave it. */
  readonly name: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
}

/** A challenge being used up: its value and when it would have expired. */
export interface ChallengeUse {
  /** The challenge, base64url. */
  readonly challenge: string;
  /** Epoch milliseconds; it is remembered as used until then. */
  readonly expiresAt: number;
}

/** What {@link PasskeyStore.register} stores. */
export interface Registration {
  readonly challenge: ChallengeUse;
  /** The user, created when their handle is new. */
  readonly user: PasskeyUser;
  readonly credential: PasskeyCredential;
}

/** Why a registration was not stored, if it was not. */
export type RegisterResult =
  | { readonly ok: true }
  | {
    readonly ok: false;
    readonly reason:
      | "challenge_used"
      | "credential_exists"
      | "principal_taken"
      | "too_many_credentials";
  };

/** What {@link PasskeyStore.authenticate} updates (§7.2 step 24). */
export interface Authentication {
  readonly challenge: ChallengeUse;
  readonly credentialId: string;
  /** The counter the verification read; a different one is a race lost. */
  readonly expectedSignCount: number;
  readonly signCount: number;
  readonly backupState: boolean;
  /** The raw UV bit from the verified assertion. */
  readonly authenticatorUserVerified: boolean;
  /**
   * Initialize UV trust while recording this assertion. Allowed only when
   * its raw UV bit is true and an independent factor authorized promotion.
   */
  readonly initializeUserVerification?: UserVerificationInitialization;
  readonly usedAt: number;
}

/** The signed-in user, or why the sign-in was not recorded. */
export type AuthenticateResult =
  | { readonly ok: true; readonly user: PasskeyUser }
  | {
    readonly ok: false;
    readonly reason: "challenge_used" | "unknown_credential" | "stale";
  };

/** Users, their passkeys, and used challenges. */
export interface PasskeyStore {
  user(handle: string): Promise<PasskeyUser | null>;
  userByPrincipal(principalKey: string): Promise<PasskeyUser | null>;
  credential(id: string): Promise<PasskeyCredential | null>;
  /** A user's credentials, oldest first. */
  credentials(userHandle: string): Promise<PasskeyCredential[]>;
  /**
   * Uses up the challenge and stores the credential (and the user, when
   * new), all or nothing but the challenge, which is used up either way.
   */
  register(registration: Registration): Promise<RegisterResult>;
  /** Uses up the challenge and records a sign-in, if the counter still matches. */
  authenticate(authentication: Authentication): Promise<AuthenticateResult>;
  /** Renames one of the user's credentials; false when it is not theirs. */
  rename(userHandle: string, id: string, name: string): Promise<boolean>;
  /**
   * Deletes one of the user's credentials. With `keepLast`, the user's only
   * credential is kept (`last`), decided in the same transaction as the
   * delete, so removals at once can never leave the user with none.
   */
  remove(
    userHandle: string,
    id: string,
    options?: RemoveOptions,
  ): Promise<RemoveResult>;
}

/** Options for {@link PasskeyStore.remove}. */
export interface RemoveOptions {
  /** Refuse to delete the user's last credential; default false. */
  readonly keepLast?: boolean;
}

/** Explicit acknowledgment required to initialize a credential's UV trust. */
export interface UserVerificationInitialization {
  /** Must mean a factor independent of the assertion's own UV gesture. */
  readonly independentlyAuthorized: true;
}

/**
 * What {@link PasskeyStore.remove} did: `removed`, `not_found` (the
 * credential is not the user's), or `last` (it is their only one, and
 * `keepLast` kept it).
 */
export type RemoveResult = "removed" | "not_found" | "last";

/** The most credentials one user may register. */
export const MAX_CREDENTIALS_PER_USER = 32;
/** The longest credential label, in characters. */
export const MAX_CREDENTIAL_NAME = 64;

/**
 * The rows a {@link DirectoryCore} reads and writes. Everything is
 * synchronous, and `transaction` makes a sequence of calls atomic.
 */
export interface DirectoryTables {
  transaction<T>(fn: () => T): T;
  getUser(handle: string): PasskeyUser | null;
  getUserByPrincipal(principalKey: string): PasskeyUser | null;
  putUser(user: PasskeyUser): void;
  getCredential(id: string): PasskeyCredential | null;
  listCredentials(userHandle: string): PasskeyCredential[];
  putCredential(credential: PasskeyCredential): void;
  deleteCredential(id: string): void;
  /** Records a challenge as used; false when it already was. */
  useChallenge(challenge: string, expiresAt: number): boolean;
  /** Forgets up to `max` challenges that expired by `now`. */
  sweepChallenges(now: number, max: number): void;
}

/** A {@link DirectoryTables} over maps, for tests. */
export class MemoryTables implements DirectoryTables {
  readonly users = new Map<string, PasskeyUser>();
  readonly credentials = new Map<string, PasskeyCredential>();
  readonly challenges = new Map<string, number>();

  transaction<T>(fn: () => T): T {
    const saved = [
      new Map(this.users),
      new Map(this.credentials),
      new Map(this.challenges),
    ] as const;
    try {
      return fn();
    } catch (error) {
      this.users.clear();
      saved[0].forEach((v, k) => this.users.set(k, v));
      this.credentials.clear();
      saved[1].forEach((v, k) => this.credentials.set(k, v));
      this.challenges.clear();
      saved[2].forEach((v, k) => this.challenges.set(k, v));
      throw error;
    }
  }

  getUser(handle: string): PasskeyUser | null {
    return this.users.get(handle) ?? null;
  }

  getUserByPrincipal(principalKey: string): PasskeyUser | null {
    for (const user of this.users.values()) {
      if (user.principalKey === principalKey) return user;
    }
    return null;
  }

  putUser(user: PasskeyUser): void {
    this.users.set(user.handle, structuredClone(user));
  }

  getCredential(id: string): PasskeyCredential | null {
    const found = this.credentials.get(id);
    return found === undefined ? null : structuredClone(found);
  }

  listCredentials(userHandle: string): PasskeyCredential[] {
    return [...this.credentials.values()]
      .filter((credential) => credential.userHandle === userHandle)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((credential) => structuredClone(credential));
  }

  putCredential(credential: PasskeyCredential): void {
    this.credentials.set(credential.id, structuredClone(credential));
  }

  deleteCredential(id: string): void {
    this.credentials.delete(id);
  }

  useChallenge(challenge: string, expiresAt: number): boolean {
    if (this.challenges.has(challenge)) return false;
    this.challenges.set(challenge, expiresAt);
    return true;
  }

  sweepChallenges(now: number, max: number): void {
    let left = max;
    for (const [challenge, expiresAt] of [...this.challenges]) {
      if (left === 0) return;
      if (expiresAt <= now) {
        this.challenges.delete(challenge);
        left--;
      }
    }
  }
}

/** Expired challenges each write forgets, so the table tracks live ones. */
const SWEEP = 16;

/** Checks a label: 1 to {@link MAX_CREDENTIAL_NAME} characters, no controls. */
export function checkCredentialName(name: unknown): string {
  if (
    typeof name !== "string" || name.trim() === "" ||
    name.length > MAX_CREDENTIAL_NAME ||
    // deno-lint-ignore no-control-regex
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new TypeError(
      `a passkey's name is 1 to ${MAX_CREDENTIAL_NAME} characters without control characters`,
    );
  }
  return name.trim();
}

/**
 * The store's rules over some {@link DirectoryTables}. Its methods are
 * synchronous; wrap them in promises to make a {@link PasskeyStore}
 * (`memoryPasskeyStore` in `@celld/sec/webauthn/testing` does).
 */
export class DirectoryCore {
  readonly #tables: DirectoryTables;
  readonly #now: () => number;

  constructor(tables: DirectoryTables, now: () => number = Date.now) {
    this.#tables = tables;
    this.#now = now;
  }

  user(handle: string): PasskeyUser | null {
    return this.#tables.getUser(handle);
  }

  userByPrincipal(principalKey: string): PasskeyUser | null {
    return this.#tables.getUserByPrincipal(principalKey);
  }

  credential(id: string): PasskeyCredential | null {
    return this.#tables.getCredential(id);
  }

  credentials(userHandle: string): PasskeyCredential[] {
    return this.#tables.listCredentials(userHandle);
  }

  #useChallenge(challenge: ChallengeUse): boolean {
    const tables = this.#tables;
    return tables.transaction(() => {
      const at = this.#now();
      tables.sweepChallenges(at, SWEEP);
      // Check expiry and claim the value under the same transaction. Merely
      // sweeping first used to let an already-expired value be inserted and
      // accepted again.
      return Number.isFinite(challenge.expiresAt) &&
        challenge.expiresAt > at &&
        tables.useChallenge(challenge.challenge, challenge.expiresAt);
    });
  }

  register(registration: Registration): RegisterResult {
    const { challenge, user, credential } = registration;
    const tables = this.#tables;
    // The challenge is used up in its own transaction, so a refused
    // registration cannot be retried with it.
    const fresh = this.#useChallenge(challenge);
    if (!fresh) return { ok: false, reason: "challenge_used" };
    return tables.transaction((): RegisterResult => {
      const existing = tables.getUser(user.handle);
      if (existing !== null) {
        if (existing.principalKey !== user.principalKey) {
          return { ok: false, reason: "principal_taken" };
        }
      } else if (tables.getUserByPrincipal(user.principalKey) !== null) {
        return { ok: false, reason: "principal_taken" };
      }
      if (tables.getCredential(credential.id) !== null) {
        return { ok: false, reason: "credential_exists" };
      }
      if (
        tables.listCredentials(user.handle).length >= MAX_CREDENTIALS_PER_USER
      ) {
        return { ok: false, reason: "too_many_credentials" };
      }
      if (existing === null) tables.putUser(user);
      tables.putCredential({ ...credential, userHandle: user.handle });
      return { ok: true };
    });
  }

  authenticate(authentication: Authentication): AuthenticateResult {
    const tables = this.#tables;
    if (typeof authentication.authenticatorUserVerified !== "boolean") {
      throw new TypeError(
        "authentication needs the verified assertion's UV bit",
      );
    }
    const initialization = authentication.initializeUserVerification;
    if (
      initialization !== undefined &&
      (
        typeof initialization !== "object" || initialization === null ||
        Array.isArray(initialization) ||
        (
          Object.getPrototypeOf(initialization) !== Object.prototype &&
          Object.getPrototypeOf(initialization) !== null
        ) ||
        !Object.hasOwn(initialization, "independentlyAuthorized") ||
        Reflect.ownKeys(initialization).length !== 1 ||
        authentication.authenticatorUserVerified !== true ||
        initialization.independentlyAuthorized !== true
      )
    ) {
      throw new TypeError(
        "UV initialization needs this assertion's UV and an independent authentication factor",
      );
    }
    const fresh = this.#useChallenge(authentication.challenge);
    if (!fresh) return { ok: false, reason: "challenge_used" };
    return tables.transaction((): AuthenticateResult => {
      const credential = tables.getCredential(authentication.credentialId);
      if (credential === null) {
        return { ok: false, reason: "unknown_credential" };
      }
      const user = tables.getUser(credential.userHandle);
      if (user === null) return { ok: false, reason: "unknown_credential" };
      if (credential.signCount !== authentication.expectedSignCount) {
        return { ok: false, reason: "stale" };
      }
      tables.putCredential({
        ...credential,
        signCount: authentication.signCount,
        backupState: authentication.backupState,
        uvInitialized: credential.uvInitialized ||
          initialization !== undefined,
        lastUsedAt: authentication.usedAt,
      });
      return { ok: true, user };
    });
  }

  rename(userHandle: string, id: string, name: string): boolean {
    const label = checkCredentialName(name);
    return this.#tables.transaction(() => {
      const credential = this.#tables.getCredential(id);
      if (credential === null || credential.userHandle !== userHandle) {
        return false;
      }
      this.#tables.putCredential({ ...credential, name: label });
      return true;
    });
  }

  remove(
    userHandle: string,
    id: string,
    options: RemoveOptions = {},
  ): RemoveResult {
    const keepLast = options?.keepLast === true;
    return this.#tables.transaction(() => {
      const credential = this.#tables.getCredential(id);
      if (credential === null || credential.userHandle !== userHandle) {
        return "not_found";
      }
      if (keepLast && this.#tables.listCredentials(userHandle).length === 1) {
        return "last";
      }
      this.#tables.deleteCredential(id);
      return "removed";
    });
  }
}
