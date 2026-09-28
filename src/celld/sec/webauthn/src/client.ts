// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link durablePasskeys}: a {@link PasskeyStore} over the
 * `PasskeyDirectory` Durable Object of `@celld/sec/webauthn/durable`.
 *
 * @module
 */

import type {
  AuthenticateResult,
  Authentication,
  PasskeyCredential,
  PasskeyStore,
  PasskeyUser,
  RegisterResult,
  Registration,
  RemoveOptions,
  RemoveResult,
} from "./store.ts";

/**
 * The RPC surface of `PasskeyDirectory`. Type its binding with it:
 * `PASSKEYS: DurableObjectNamespace<PasskeyDirectoryApi>`.
 */
export interface PasskeyDirectoryApi {
  user(handle: string): PasskeyUser | null;
  userByPrincipal(principalKey: string): PasskeyUser | null;
  credential(id: string): PasskeyCredential | null;
  credentials(userHandle: string): PasskeyCredential[];
  register(registration: Registration): RegisterResult;
  authenticate(authentication: Authentication): AuthenticateResult;
  rename(userHandle: string, id: string, name: string): boolean;
  remove(
    userHandle: string,
    id: string,
    options?: RemoveOptions,
  ): RemoveResult;
}

/** What {@link durablePasskeys} needs of a namespace binding. */
export interface DirectoryNamespace {
  getByName(name: string): {
    [K in keyof PasskeyDirectoryApi]: (
      ...args: Parameters<PasskeyDirectoryApi[K]>
    ) => Promise<ReturnType<PasskeyDirectoryApi[K]>>;
  };
}

/**
 * The security scope of one passkey directory. `rpId` is always required;
 * add `tenant` when multiple tenants under one RP ID must not share users,
 * credential IDs, or challenges.
 */
export interface DurablePasskeyScope {
  readonly rpId: string;
  readonly tenant?: string;
}

function scopePart(value: unknown, what: string, max: number): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > max ||
    // deno-lint-ignore no-control-regex
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(`${what} is 1 to ${max} characters without controls`);
  }
  return value;
}

/**
 * A {@link PasskeyStore} in a `PasskeyDirectory` object whose name is
 * derived without ambiguity from the required RP and optional tenant scope.
 * One scoped object is shared by the fleet. This v2 name intentionally does
 * not reuse the old unscoped `passkeys` object; migrate its records or have
 * users re-register before switching an existing deployment.
 */
export function durablePasskeys(
  namespace: DirectoryNamespace,
  options: DurablePasskeyScope,
): PasskeyStore {
  if (
    typeof namespace !== "object" || namespace === null ||
    typeof namespace.getByName !== "function"
  ) {
    throw new TypeError(
      "durablePasskeys takes the PasskeyDirectory namespace binding",
    );
  }
  if (typeof options !== "object" || options === null) {
    throw new TypeError("durablePasskeys needs an explicit RP scope");
  }
  if (
    Array.isArray(options) ||
    (
      Object.getPrototypeOf(options) !== Object.prototype &&
      Object.getPrototypeOf(options) !== null
    )
  ) {
    throw new TypeError("a passkey RP scope must be a plain object");
  }
  const scopeKeys = Reflect.ownKeys(options);
  const unknown = scopeKeys.find((key) => key !== "rpId" && key !== "tenant");
  if (unknown !== undefined) {
    throw new TypeError(
      `durablePasskeys scope has no option ${String(unknown)}`,
    );
  }
  if (!Object.hasOwn(options, "rpId")) {
    throw new TypeError("durablePasskeys scope needs rpId");
  }
  const rpId = scopePart(options.rpId, "rpId", 253);
  const tenant = !Object.hasOwn(options, "tenant") ||
      options.tenant === undefined
    ? null
    : scopePart(options.tenant, "tenant", 128);
  // JSON's length-prefixing/escaping makes this collision-free even when
  // a tenant contains punctuation used by an RP ID.
  const name = JSON.stringify(["celld-passkeys-v2", rpId, tenant]);
  const stub = () => namespace.getByName(name);
  return Object.freeze({
    user: (handle: string) => stub().user(handle),
    userByPrincipal: (key: string) => stub().userByPrincipal(key),
    credential: (id: string) => stub().credential(id),
    credentials: (handle: string) => stub().credentials(handle),
    register: (registration: Registration) => stub().register(registration),
    authenticate: (authentication: Authentication) =>
      stub().authenticate(authentication),
    rename: (handle: string, id: string, label: string) =>
      stub().rename(handle, id, label),
    remove: (handle: string, id: string, options?: RemoveOptions) =>
      stub().remove(handle, id, options),
  });
}
