// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/** Credentials together with the authority under which they were obtained. */
import { fromBase64Url, toBase64Url } from "@celld/sec/jwt";
import { OAuthError } from "../errors.ts";
import {
  isObject,
  isScopeToken,
  parseScope,
  randomToken,
  sha256,
  snapshot,
} from "../util.ts";
import { jsonSnapshot, strictRecord } from "@celld/core/bounds";
import { checkSecureUrl, isIssuer } from "../metadata.ts";
import { GRANT_TYPES } from "../constants.ts";
import type { TokenSet } from "./store.ts";

declare const authorizedGrant: unique symbol;
export interface GrantProvenance {
  readonly issuer: string;
  readonly clientId: string;
  /** Exact resource identifiers. An empty set grants no resource access. */
  readonly resources: readonly string[];
  readonly requestedScopes: readonly string[];
  readonly grantedScopes: readonly string[];
  readonly grantType: string;
  readonly generation: string;
  readonly acquiredAt: number;
  readonly dpopJkt?: string;
}

/** Immutable, runtime authenticated grant. Spreading/JSON-parsing it loses authority. */
export interface AuthorizedGrant extends TokenSet {
  readonly [authorizedGrant]: true;
  readonly provenance: GrantProvenance;
}

const grants = new WeakSet<object>();
const owners = new WeakMap<object, object>();
const OWNER_GENERATION_LIMIT = 4096;
interface GenerationState {
  readonly identity: Promise<string>;
  readonly refreshIdentity?: Promise<string>;
  retired: boolean;
  uncertain: boolean;
  refreshRemoved: boolean;
  pending?: {
    readonly policy: string;
    readonly promise: Promise<AuthorizedGrant>;
  };
}
const generations = new WeakMap<object, Map<string, GenerationState>>();
const reserved = new WeakMap<object, number>();
const states = new WeakMap<object, GenerationState>();
const identities = new WeakMap<object, Promise<boolean>>();

/** Internal bounded admission, before a request can consume remote authority. */
export function assertGrantCapacity(owner: object): void {
  if (
    (generations.get(owner)?.size ?? 0) + (reserved.get(owner) ?? 0) >=
      OWNER_GENERATION_LIMIT
  ) {
    throw new OAuthError(
      "token",
      "the client generation registry is full; create a new client lifecycle with a fresh persisted generation",
    );
  }
}

/** Internal reservation held through network/signing until the successor is minted. */
export function reserveGrantCapacity(owner: object): { release(): void } {
  assertGrantCapacity(owner);
  reserved.set(owner, (reserved.get(owner) ?? 0) + 1);
  let active = true;
  return {
    release() {
      if (active) {
        active = false;
        reserved.set(owner, reserved.get(owner)! - 1);
      }
    },
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort()
        .filter((key) => value[key] !== undefined).map((
          key,
        ) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function bindGeneration(grant: AuthorizedGrant, owner?: object): void {
  const { refresh_token: refresh, ...access } = grant;
  const identity = sha256(JSON.stringify(canonical(access)));
  const refreshIdentity = refresh === undefined ? undefined : sha256(refresh);
  let registry = owner === undefined ? undefined : generations.get(owner);
  if (owner !== undefined && registry === undefined) {
    registry = new Map();
    generations.set(owner, registry);
  }
  let state = registry?.get(grant.provenance.generation);
  if (state === undefined) {
    if (owner !== undefined) assertGrantCapacity(owner);
    state = {
      identity,
      ...(refreshIdentity === undefined ? {} : { refreshIdentity }),
      retired: false,
      uncertain: false,
      refreshRemoved: refresh === undefined,
    };
    registry?.set(grant.provenance.generation, state);
  }
  const bound = state;
  // Hashing is asynchronous on this runtime. Every credential-use boundary
  // awaits this check; only bounded digests/state survive, never token objects.
  const checked = Promise.all([
    identity,
    bound.identity,
    refreshIdentity,
    bound.refreshIdentity,
  ])
    .then(([actual, expected, actualRefresh, expectedRefresh]) => {
      if (
        actual !== expected ||
        (actualRefresh !== undefined && actualRefresh !== expectedRefresh)
      ) return false;
      if (actualRefresh === undefined) bound.refreshRemoved = true;
      return true;
    }, () => false);
  states.set(grant, bound);
  identities.set(grant, checked);
  grants.add(grant);
  if (owner !== undefined) owners.set(grant, owner);
}

/** Internal: checks immutable same-generation identity before using credentials. */
export async function assertGrantIdentity(
  grant: AuthorizedGrant,
): Promise<void> {
  if (await identities.get(grant) !== true) {
    throw new OAuthError(
      "token",
      "the restored grant changed its generation identity",
    );
  }
}

/** Internal shared singleflight slot, including independently decoded copies. */
export function grantRefreshState(grant: AuthorizedGrant): GenerationState {
  const state = states.get(grant);
  if (state === undefined) {
    throw new OAuthError("token", "the grant has no authenticated generation");
  }
  return state;
}
export interface GrantExpectation {
  /** Runtime client/session identity. Never serialized. */
  readonly owner?: object;
  readonly issuer: string;
  readonly clientId: string;
  readonly dpopJkt?: string;
  readonly resource?: string;
  readonly generation?: string;
}

/**
 * Synchronous brand/provenance/retirement check only. A trusted restored record
 * still needs OAuthClient.validateGrant before direct credential use: that
 * awaits its immutable generation-identity digest. Safe client APIs do this.
 */
export function assertAuthorizedGrant(
  value: unknown,
  expected: GrantExpectation,
): asserts value is AuthorizedGrant {
  const fail = () => {
    throw new OAuthError(
      "token",
      "the grant does not authorize this operation",
    );
  };
  if (
    !isObject(value) || !grants.has(value) ||
    states.get(value)?.retired === true
  ) fail();
  const p = (value as unknown as AuthorizedGrant).provenance;
  if (
    (expected.owner !== undefined &&
      owners.get(value as object) !== expected.owner) ||
    p.issuer !== expected.issuer || p.clientId !== expected.clientId ||
    p.dpopJkt !== expected.dpopJkt ||
    (expected.resource !== undefined &&
      !p.resources.includes(expected.resource)) ||
    (expected.generation !== undefined && p.generation !== expected.generation)
  ) fail();
}

/** Internal minting boundary; intentionally absent from the package exports. */
export function mintGrant(
  tokens: TokenSet,
  input: Omit<GrantProvenance, "generation" | "grantedScopes">,
  owner?: object,
): AuthorizedGrant {
  const grantedScopes = tokens.scope === undefined
    ? [...input.requestedScopes]
    : parseScope(tokens.scope);
  if (
    grantedScopes.length > 256 ||
    grantedScopes.some((scope) => scope.length > 256 || !isScopeToken(scope))
  ) throw new OAuthError("token", "the server granted malformed scope");
  if (grantedScopes.some((scope) => !input.requestedScopes.includes(scope))) {
    throw new OAuthError("token", "the server granted an unrequested scope");
  }
  const value = snapshot({
    ...tokens,
    provenance: { ...input, grantedScopes, generation: randomToken(16) },
  }) as unknown as AuthorizedGrant;
  bindGeneration(value, owner);
  return value;
}

/** Internal rotation boundary. */
export function retireGrant(grant: AuthorizedGrant): void {
  grantRefreshState(grant).retired = true;
}

/** Internal: mark a rotating refresh's ambiguous outcome without retiring a live access token. */
export function markRefreshUncertain(grant: AuthorizedGrant): void {
  grantRefreshState(grant).uncertain = true;
}

/** Internal: never retransmit a credential whose remote consumption is uncertain. */
export function assertRefreshable(grant: AuthorizedGrant): void {
  const state = grantRefreshState(grant);
  if (state.uncertain || state.refreshRemoved) {
    throw new OAuthError(
      "token",
      "the previous refresh outcome is uncertain; obtain a new authorization",
    );
  }
}

/**
 * Migration boundary for data read from an authenticated confidential store.
 * The caller attests integrity of the entire record, not just the token text.
 * Never call this on request/browser JSON; prefer GrantCodec for persistence.
 * Before directly using credentials, await OAuthClient.validateGrant; this
 * synchronous restoration establishes the brand, not the async identity proof.
 */
export function unsafeRestoreGrant(
  value: unknown,
  expected: GrantExpectation,
): AuthorizedGrant {
  strictRecord(expected as unknown, [
    "owner",
    "issuer",
    "clientId",
    "dpopJkt",
    "resource",
    "generation",
  ], "grant expectation");
  if (
    expected.owner !== undefined &&
    (typeof expected.owner !== "object" || expected.owner === null)
  ) {
    throw new TypeError("grant owner must be an object identity");
  }
  value = jsonSnapshot(value);
  strictRecord(value, [
    "access_token",
    "token_type",
    "expires_at",
    "refresh_token",
    "scope",
    "requested_scope",
    "issued_token_type",
    "id_token",
    "dpop_jkt",
    "provenance",
  ], "persisted grant");
  if (!isObject(value) || !isObject(value.provenance)) {
    throw new OAuthError("token", "the persisted grant has no provenance");
  }
  const p = value.provenance;
  strictRecord(p, [
    "issuer",
    "clientId",
    "resources",
    "requestedScopes",
    "grantedScopes",
    "grantType",
    "generation",
    "acquiredAt",
    "dpopJkt",
  ], "grant provenance");
  const scopes = (items: unknown) =>
    Array.isArray(items) && items.length <= 256 &&
    new Set(items).size === items.length && items.every((s) =>
      typeof s === "string" && s.length <= 256 && isScopeToken(s)
    );
  if (
    typeof value.access_token !== "string" || value.access_token.length === 0 ||
    value.access_token.length > 16_384 ||
    (value.token_type !== "Bearer" && value.token_type !== "DPoP") ||
    typeof p.generation !== "string" ||
    !/^[A-Za-z0-9_-]{22}$/.test(p.generation) ||
    typeof p.acquiredAt !== "number" || !Number.isFinite(p.acquiredAt) ||
    p.acquiredAt < 0 ||
    typeof p.issuer !== "string" || !isIssuer(p.issuer) ||
    typeof p.clientId !== "string" || p.clientId.length === 0 ||
    p.clientId.length > 4096 ||
    typeof p.grantType !== "string" ||
    !(Object.values(GRANT_TYPES) as string[]).includes(p.grantType) ||
    !Array.isArray(p.resources) || p.resources.length > 64 ||
    !p.resources.every((r) =>
      typeof r === "string" && r.length > 0 && r.length <= 4096
    ) ||
    !scopes(p.requestedScopes) || !scopes(p.grantedScopes) ||
    !Array.isArray(p.grantedScopes) ||
    !p.grantedScopes.every((s) => (p.requestedScopes as unknown[]).includes(s))
  ) throw new OAuthError("token", "the persisted grant has invalid provenance");
  for (const resource of p.resources as string[]) {
    checkSecureUrl(resource, "grant resource");
  }
  for (
    const name of [
      "refresh_token",
      "id_token",
      "scope",
      "requested_scope",
      "issued_token_type",
    ]
  ) {
    if (
      value[name] !== undefined &&
      (typeof value[name] !== "string" || value[name].length > 16_384)
    ) {
      throw new OAuthError(
        "token",
        "the persisted grant has an invalid credential field",
      );
    }
  }
  if (
    value.expires_at !== undefined &&
    (typeof value.expires_at !== "number" ||
      !Number.isFinite(value.expires_at) || value.expires_at < 0)
  ) throw new OAuthError("token", "the persisted grant has an invalid expiry");
  if (
    p.dpopJkt !== undefined &&
    (typeof p.dpopJkt !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(p.dpopJkt))
  ) {
    throw new OAuthError(
      "token",
      "the persisted grant has an invalid proof binding",
    );
  }
  if (
    value.token_type === "DPoP" &&
    (p.dpopJkt === undefined || p.dpopJkt !== value.dpop_jkt)
  ) throw new OAuthError("token", "the persisted grant lost its proof binding");
  if (
    value.scope !== undefined &&
    JSON.stringify(parseScope(value.scope as string)) !==
      JSON.stringify(p.grantedScopes)
  ) throw new OAuthError("token", "the persisted grant scopes disagree");
  if (
    p.issuer !== expected.issuer || p.clientId !== expected.clientId ||
    p.dpopJkt !== expected.dpopJkt ||
    (expected.resource !== undefined &&
      !(p.resources as unknown[]).includes(expected.resource)) ||
    (expected.generation !== undefined && p.generation !== expected.generation)
  ) {
    throw new OAuthError(
      "token",
      "the persisted grant belongs to another identity",
    );
  }
  const grant = jsonSnapshot(value) as unknown as AuthorizedGrant;
  bindGeneration(grant, expected.owner);
  assertAuthorizedGrant(grant, expected);
  return grant;
}

/**
 * Authenticated encrypted persistence. Keep this AES-GCM key confidential and
 * stable across restarts. The associated data binds format and expected identity.
 * Applications still need an atomic store lock for refresh across processes.
 */
export class GrantCodec {
  readonly #key: CryptoKey;
  readonly #expected: GrantExpectation;
  constructor(key: CryptoKey, expected: GrantExpectation) {
    if (
      key.type !== "secret" || key.algorithm.name !== "AES-GCM" ||
      !key.usages.includes("encrypt") || !key.usages.includes("decrypt")
    ) {
      throw new TypeError(
        "GrantCodec needs an AES-GCM encryption/decryption key",
      );
    }
    this.#key = key;
    strictRecord(expected, [
      "issuer",
      "clientId",
      "dpopJkt",
      "resource",
      "generation",
      "owner",
    ], "GrantCodec expectation");
    if (
      !isIssuer(expected.issuer) || typeof expected.clientId !== "string" ||
      expected.clientId.length === 0
    ) throw new TypeError("GrantCodec requires issuer and clientId");
    this.#expected = Object.freeze({ ...expected });
  }
  #aad(): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(
      JSON.stringify([
        "oauth-grant-v1",
        this.#expected.issuer,
        this.#expected.clientId,
        this.#expected.dpopJkt ?? null,
      ]),
    );
  }
  async seal(grant: AuthorizedGrant): Promise<string> {
    assertAuthorizedGrant(grant, this.#expected);
    await assertGrantIdentity(grant);
    assertAuthorizedGrant(grant, this.#expected);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    // Safe persistence cannot restore an uncertain rotating credential. This
    // does not invalidate older ciphertext: hosts must fence stored generations.
    const { refresh_token: refresh, ...access } = grant;
    const state = grantRefreshState(grant);
    const serializable = state.uncertain || state.refreshRemoved ? access : {
      ...access,
      ...(refresh === undefined ? {} : { refresh_token: refresh }),
    };
    const plaintext = new TextEncoder().encode(JSON.stringify(serializable));
    if (plaintext.length > 65_536) throw new TypeError("grant is too large");
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: this.#aad() },
      this.#key,
      plaintext,
    );
    return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(encrypted))}`;
  }
  async open(value: string, now = Date.now()): Promise<AuthorizedGrant> {
    try {
      if (value.length > 90_000) throw new Error();
      const [version, nonce, ciphertext, extra] = value.split(".");
      if (version !== "v1" || extra !== undefined) throw new Error();
      const iv = fromBase64Url(nonce);
      const ciphertextBytes = fromBase64Url(ciphertext);
      if (iv === null || iv.length !== 12 || ciphertextBytes === null) {
        throw new Error();
      }
      const decoded = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: this.#aad(),
        },
        this.#key,
        ciphertextBytes,
      );
      const parsed: unknown = JSON.parse(new TextDecoder().decode(decoded));
      if (!isObject(parsed) || !isObject(parsed.provenance)) throw new Error();
      const p = parsed.provenance;
      if (
        typeof parsed.access_token !== "string" ||
        parsed.access_token.length === 0 ||
        parsed.access_token.length > 16_384 ||
        (parsed.token_type !== "Bearer" && parsed.token_type !== "DPoP") ||
        typeof p.generation !== "string" ||
        !/^[A-Za-z0-9_-]{22}$/.test(p.generation) ||
        typeof p.acquiredAt !== "number" || !Number.isFinite(p.acquiredAt) ||
        p.acquiredAt > now ||
        !Array.isArray(p.resources) || p.resources.length > 64 ||
        !p.resources.every((v) =>
          typeof v === "string" && v.length > 0 && v.length <= 4096
        ) ||
        !Array.isArray(p.requestedScopes) || !Array.isArray(p.grantedScopes) ||
        !p.grantedScopes.every((scope) =>
          (p.requestedScopes as unknown[]).includes(scope)
        ) ||
        (parsed.expires_at !== undefined &&
          (typeof parsed.expires_at !== "number" ||
            !Number.isFinite(parsed.expires_at))) ||
        (parsed.expires_at !== undefined &&
          (parsed.expires_at as number) <= now &&
          parsed.refresh_token === undefined)
      ) throw new Error();
      const grant = unsafeRestoreGrant(parsed, this.#expected);
      await assertGrantIdentity(grant);
      assertAuthorizedGrant(grant, this.#expected);
      return grant;
    } catch {
      throw new OAuthError(
        "token",
        "the persisted grant is invalid or belongs to another client",
      );
    }
  }
}
