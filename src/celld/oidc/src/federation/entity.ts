// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link FederationEntity}: an entity's federation endpoints as
 * framework-agnostic `(Request) => Promise<Response>` handlers.
 *
 * ```ts
 * const anchor = new FederationEntity({
 *   entityId: "https://ta.example.org",
 *   keys: [federationKey],
 *   metadata: { federation_entity: { organization_name: "Example Federation" } },
 *   subordinates: {
 *     "https://op.example.com": { jwks: OP_FEDERATION_JWKS, metadataPolicy: { ... } },
 *   },
 *   trustMarkIssuers: { "https://ta.example.org/marks/certified": [] },
 * });
 * export default { fetch: async (r) => await anchor.handle(r) ?? notFound() };
 * ```
 *
 * - the entity configuration at `/.well-known/openid-federation` (section
 *   9), signed with the first key, publishing every key;
 * - with subordinates, the fetch endpoint (section 8.1, `?sub=`) and the
 *   list endpoint (section 8.2), whose URLs join the configuration's
 *   `federation_entity` metadata;
 * - with a `resolver`, the resolve endpoint (section 8.3), answering
 *   `resolve-response+jwt` with the subject's resolved metadata, its valid
 *   trust marks and the chain;
 * - {@link FederationEntity.issueTrustMark} for trust mark issuers.
 *
 * Statements are signed on request, so key rotation and configuration
 * changes take effect at once; they live `ttlSec` (a day by default).
 * Fetch errors are JSON with section 8.9's codes (`not_found`,
 * `invalid_request`).
 *
 * @module
 */

import type { Clock } from "@celld/oauth";
import type { SigningKey } from "@celld/oauth/server";
import type { Jwks } from "@celld/jwt";
import { defaultClock, epochSeconds, jsonResponse } from "../util.ts";
import type { TrustChainResolver } from "./chain.ts";
import {
  type Constraints,
  entityConfigurationUrl,
  type EntityMetadata,
  FederationError,
  federationJwks,
  isEntityId,
  MEDIA_TYPES,
  type MetadataPolicy,
  signStatement,
  type TrustMarkEntry,
} from "./statement.ts";
import { issueTrustMark } from "./trust_marks.ts";

/** What a superior says about one immediate subordinate. */
export interface SubordinateConfig {
  /** The subordinate's federation keys, which this statement vouches for. */
  readonly jwks: Jwks;
  /** Metadata that overrides the subordinate's own (it only). */
  readonly metadata?: EntityMetadata;
  /** Policy for the subordinate and everything below it. */
  readonly metadataPolicy?: MetadataPolicy;
  readonly metadataPolicyCrit?: readonly string[];
  readonly constraints?: Constraints;
  /** Its entity types, for the list endpoint's `entity_type` filter. */
  readonly entityTypes?: readonly string[];
  /** Whether it has subordinates itself, for the list endpoint's `intermediate` filter. */
  readonly intermediate?: boolean;
}

/** Options for {@link FederationEntity}. */
export interface FederationEntityOptions {
  readonly entityId: string;
  /** Federation keys (not the keys of other protocols); the first signs, all are published. */
  readonly keys: readonly SigningKey[];
  /** Metadata by entity type. `federation_entity` gets the endpoint URLs added. */
  readonly metadata?:
    | EntityMetadata
    | (() => EntityMetadata | Promise<EntityMetadata>);
  /** Immediate superiors; absent for a trust anchor. */
  readonly authorityHints?: readonly string[];
  readonly trustAnchorHints?: readonly string[];
  /** Trust marks about this entity. */
  readonly trustMarks?:
    | readonly TrustMarkEntry[]
    | (() => Promise<readonly TrustMarkEntry[]>);
  /** A trust anchor's accepted trust mark issuers, by type. */
  readonly trustMarkIssuers?: Readonly<Record<string, readonly string[]>>;
  /** A trust anchor's trust mark owners, by type. */
  readonly trustMarkOwners?: Readonly<
    Record<string, { readonly sub: string; readonly jwks: Jwks }>
  >;
  /** Immediate subordinates, by entity identifier (or a lookup with a list). */
  readonly subordinates?:
    | Readonly<Record<string, SubordinateConfig>>
    | {
      readonly get: (entityId: string) => Promise<SubordinateConfig | null>;
      readonly list: () => Promise<readonly string[]>;
    };
  /** Enables the resolve endpoint. */
  readonly resolver?: TrustChainResolver;
  /** Seconds statements live; default 86400. */
  readonly ttlSec?: number;
  /** Endpoint paths, appended to the entity identifier. */
  readonly paths?: {
    readonly fetch?: string;
    readonly list?: string;
    readonly resolve?: string;
  };
  readonly now?: Clock;
}

function entityStatementResponse(jwt: string, type: string): Response {
  return new Response(jwt, {
    status: 200,
    headers: {
      "content-type": `application/${type}`,
      "cache-control": "max-age=300",
    },
  });
}

function federationError(
  status: number,
  error: string,
  description: string,
): Response {
  return jsonResponse(status, { error, error_description: description });
}

/** One entity's federation endpoints; see the module documentation. */
export class FederationEntity {
  readonly entityId: string;
  readonly #options: FederationEntityOptions;
  readonly #now: Clock;
  readonly #base: string;

  /** Throws `TypeError` for a bad entity identifier or no keys. */
  constructor(options: FederationEntityOptions) {
    if (!isEntityId(options.entityId)) {
      throw new TypeError(`${options.entityId} is not an entity identifier`);
    }
    if (options.keys.length === 0) {
      throw new TypeError("a federation entity needs a signing key");
    }
    this.entityId = options.entityId;
    this.#options = options;
    this.#now = options.now ?? defaultClock;
    this.#base = options.entityId.replace(/\/+$/, "");
  }

  /** The public federation keys. */
  get jwks(): Jwks {
    return federationJwks(this.#options.keys);
  }

  /** The URL of an endpoint. */
  endpoint(name: "fetch" | "list" | "resolve"): string {
    const defaults = {
      fetch: "/federation_fetch",
      list: "/federation_list",
      resolve: "/federation_resolve",
    };
    return `${this.#base}${this.#options.paths?.[name] ?? defaults[name]}`;
  }

  /** The URL of the entity configuration. */
  get configurationUrl(): string {
    return entityConfigurationUrl(this.entityId);
  }

  async #metadata(): Promise<EntityMetadata> {
    const metadata = typeof this.#options.metadata === "function"
      ? await this.#options.metadata()
      : this.#options.metadata ?? {};
    const federation: Record<string, unknown> = {
      ...metadata.federation_entity,
    };
    if (this.#options.subordinates !== undefined) {
      federation.federation_fetch_endpoint = this.endpoint("fetch");
      federation.federation_list_endpoint = this.endpoint("list");
    }
    if (this.#options.resolver !== undefined) {
      federation.federation_resolve_endpoint = this.endpoint("resolve");
    }
    return Object.keys(federation).length === 0 &&
        !("federation_entity" in metadata)
      ? metadata
      : { ...metadata, federation_entity: federation };
  }

  /** Signs `claims` as this entity, with `iat` and `exp` added. */
  async sign(
    claims: Readonly<Record<string, unknown>>,
    typ: string = MEDIA_TYPES.entityStatement,
    ttlSec: number = this.#options.ttlSec ?? 86400,
  ): Promise<string> {
    const iat = epochSeconds(this.#now);
    return await signStatement(
      { ...claims, iss: this.entityId, iat, exp: iat + ttlSec },
      this.#options.keys[0],
      typ,
    );
  }

  /** The signed entity configuration. */
  async entityConfiguration(): Promise<string> {
    const options = this.#options;
    const marks = typeof options.trustMarks === "function"
      ? await options.trustMarks()
      : options.trustMarks;
    return await this.sign({
      sub: this.entityId,
      jwks: this.jwks,
      metadata: await this.#metadata(),
      ...(options.authorityHints === undefined
        ? {}
        : { authority_hints: [...options.authorityHints] }),
      ...(options.trustAnchorHints === undefined
        ? {}
        : { trust_anchor_hints: [...options.trustAnchorHints] }),
      ...(marks === undefined || marks.length === 0
        ? {}
        : { trust_marks: [...marks] }),
      ...(options.trustMarkIssuers === undefined
        ? {}
        : { trust_mark_issuers: options.trustMarkIssuers }),
      ...(options.trustMarkOwners === undefined
        ? {}
        : { trust_mark_owners: options.trustMarkOwners }),
    });
  }

  async #subordinateConfig(
    entityId: string,
  ): Promise<SubordinateConfig | null> {
    const subordinates = this.#options.subordinates;
    if (subordinates === undefined) return null;
    if (
      typeof subordinates.get === "function" &&
      typeof subordinates.list === "function"
    ) {
      return await (subordinates as {
        get: (id: string) => Promise<SubordinateConfig | null>;
      })
        .get(entityId);
    }
    const table = subordinates as Readonly<Record<string, SubordinateConfig>>;
    return Object.hasOwn(table, entityId) ? table[entityId] : null;
  }

  async #subordinateIds(): Promise<readonly string[]> {
    const subordinates = this.#options.subordinates;
    if (subordinates === undefined) return [];
    if (
      typeof subordinates.get === "function" &&
      typeof subordinates.list === "function"
    ) {
      return await (subordinates as { list: () => Promise<readonly string[]> })
        .list();
    }
    return Object.keys(subordinates);
  }

  /** The signed subordinate statement about `entityId`, or null for an entity that is not an immediate subordinate. */
  async subordinateStatement(entityId: string): Promise<string | null> {
    const config = await this.#subordinateConfig(entityId);
    if (config === null) return null;
    return await this.sign({
      sub: entityId,
      jwks: config.jwks,
      ...(config.metadata === undefined ? {} : { metadata: config.metadata }),
      ...(config.metadataPolicy === undefined
        ? {}
        : { metadata_policy: config.metadataPolicy }),
      ...(config.metadataPolicyCrit === undefined
        ? {}
        : { metadata_policy_crit: [...config.metadataPolicyCrit] }),
      ...(config.constraints === undefined
        ? {}
        : { constraints: config.constraints }),
      source_endpoint: this.endpoint("fetch"),
    });
  }

  /** Signs a trust mark about `subject` as this entity. */
  async issueTrustMark(
    subject: string,
    trustMarkType: string,
    options: {
      readonly ttlSec?: number;
      readonly delegation?: string;
      readonly claims?: Readonly<Record<string, unknown>>;
    } = {},
  ): Promise<string> {
    return await issueTrustMark(this.#options.keys[0], {
      issuer: this.entityId,
      subject,
      trustMarkType,
      now: this.#now,
      ...options,
    });
  }

  /**
   * Routes a request to the configuration, fetch, list or resolve
   * endpoint; null for any other path.
   */
  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const path = url.pathname;
    const is = (target: string) => path === new URL(target).pathname;
    if (
      !is(this.configurationUrl) && !is(this.endpoint("fetch")) &&
      !is(this.endpoint("list")) && !is(this.endpoint("resolve"))
    ) {
      return null;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { allow: "GET" } });
    }
    if (is(this.configurationUrl)) {
      return entityStatementResponse(
        await this.entityConfiguration(),
        MEDIA_TYPES.entityStatement,
      );
    }
    if (
      this.#options.subordinates !== undefined && is(this.endpoint("fetch"))
    ) {
      return await this.#fetchEndpoint(url);
    }
    if (this.#options.subordinates !== undefined && is(this.endpoint("list"))) {
      return await this.#listEndpoint(url);
    }
    if (this.#options.resolver !== undefined && is(this.endpoint("resolve"))) {
      return await this.#resolveEndpoint(url);
    }
    return null;
  }

  async #fetchEndpoint(url: URL): Promise<Response> {
    const subs = url.searchParams.getAll("sub");
    if (subs.length !== 1) {
      return federationError(400, "invalid_request", "one sub is required");
    }
    if (subs[0] === this.entityId) {
      return federationError(
        400,
        "invalid_request",
        "ask the entity configuration endpoint about the issuer itself",
      );
    }
    const statement = await this.subordinateStatement(subs[0]);
    if (statement === null) {
      return federationError(404, "not_found", "not an immediate subordinate");
    }
    return entityStatementResponse(statement, MEDIA_TYPES.entityStatement);
  }

  async #listEndpoint(url: URL): Promise<Response> {
    const type = url.searchParams.get("entity_type");
    const intermediate = url.searchParams.get("intermediate");
    const out: string[] = [];
    for (const id of await this.#subordinateIds()) {
      const config = await this.#subordinateConfig(id);
      if (config === null) continue;
      if (type !== null && !(config.entityTypes ?? []).includes(type)) continue;
      if (intermediate === "true" && !config.intermediate) continue;
      if (intermediate === "false" && config.intermediate) continue;
      out.push(id);
    }
    return jsonResponse(200, out, { "cache-control": "max-age=300" });
  }

  async #resolveEndpoint(url: URL): Promise<Response> {
    const sub = url.searchParams.get("sub");
    const anchors = url.searchParams.getAll("trust_anchor");
    if (sub === null || anchors.length === 0) {
      return federationError(
        400,
        "invalid_request",
        "sub and trust_anchor are required",
      );
    }
    const types = url.searchParams.getAll("entity_type");
    const problems: string[] = [];
    for (const anchor of anchors) {
      try {
        const chain = await this.#options.resolver!.resolve(sub, {
          trustAnchor: anchor,
        });
        const metadata = types.length === 0
          ? chain.metadata
          : Object.fromEntries(
            Object.entries(chain.metadata).filter(([type]) =>
              types.includes(type)
            ),
          );
        const ttl = Math.max(1, chain.expiresAt - epochSeconds(this.#now));
        const jwt = await this.sign(
          {
            sub,
            metadata,
            trust_marks: chain.trustMarks.map((mark) => ({
              trust_mark_type: mark.trustMarkType,
              trust_mark: mark.trustMark,
            })),
            trust_chain: [...chain.statements],
          },
          MEDIA_TYPES.resolveResponse,
          ttl,
        );
        return entityStatementResponse(jwt, MEDIA_TYPES.resolveResponse);
      } catch (error) {
        if (!(error instanceof FederationError)) throw error;
        problems.push(error.message);
      }
    }
    return federationError(404, "invalid_trust_chain", problems.join("; "));
  }
}
