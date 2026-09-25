// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link TrustChainResolver}: finding and validating trust chains from an
 * entity to a configured trust anchor (OpenID Federation 1.0 section 10),
 * then resolving the entity's metadata through the chain's policies and
 * constraints (sections 6.1.4 and 6.2) and validating its trust marks.
 *
 * ```ts
 * const resolver = new TrustChainResolver({
 *   trustAnchors: [{ entityId: "https://ta.example.org", jwks: TA_JWKS }],
 * });
 * const chain = await resolver.resolve("https://rp.example.com");
 * chain.metadata.openid_relying_party; // after policies
 * ```
 *
 * Discovery walks `authority_hints` upward, depth first, fetching each
 * superior's entity configuration and its subordinate statement about the
 * entity below from its `federation_fetch_endpoint`. An entity already on
 * the path is never visited again (cycles), a path longer than
 * `maxPathLength` intermediates is abandoned, and at most `maxFetches`
 * statements are fetched per resolution. Each candidate chain is then
 * validated by {@link TrustChainResolver.validate}, shortest first; the
 * first valid one wins.
 *
 * Validation (section 10.2) of `ES[0..i]`: each statement's claims, `iat`
 * and `exp`; `ES[0]` is an entity configuration signed by a key in its own
 * `jwks`; `ES[j].iss == ES[j+1].sub` and `ES[j]` verifies with a key in
 * `ES[j+1].jwks`; `ES[i]` is the trust anchor's configuration and verifies
 * with the anchor's configured keys; the immediate superior is in
 * `ES[0].authority_hints`. Then every subordinate statement's constraints,
 * the metadata of the immediate superior's statement, the allowed entity
 * types, and the merged policies (the anchor's first). The chain expires
 * at the earliest `exp`.
 *
 * Fetched statements are cached (in memory, or in a `RecordStore`) until
 * they expire or `cacheTtlSec` passes, and re-verified on every use;
 * resolved chains are cached in memory until they expire.
 *
 * @module
 */

import type { Clock, FetchLike } from "@celld/oauth";
import type { RecordStore } from "@celld/oauth/server";
import type { Jwks } from "@celld/jwt";
import {
  defaultClock,
  defaultFetch,
  epochSeconds,
  isMediaType,
  isObject,
} from "../util.ts";
import { applyMetadataPolicy, resolveMetadataPolicy } from "./policy.ts";
import {
  entityConfigurationUrl,
  type EntityMetadata,
  type EntityStatement,
  FederationError,
  isEntityId,
  MEDIA_TYPES,
  type MetadataPolicy,
  peekStatement,
  verifyStatement,
} from "./statement.ts";
import { type VerifiedTrustMark, verifyTrustMark } from "./trust_marks.ts";

/** A trust anchor: its entity identifier and federation keys, configured out of band. */
export interface TrustAnchor {
  readonly entityId: string;
  readonly jwks: Jwks;
}

/** Options for {@link TrustChainResolver}. */
export interface TrustChainResolverOptions {
  readonly trustAnchors: readonly TrustAnchor[];
  /** The most intermediates between an entity and its trust anchor; default 4. */
  readonly maxPathLength?: number;
  /** The most statements fetched for one resolution; default 64. */
  readonly maxFetches?: number;
  /** Seconds of clock skew for `iat` and `exp`; default 30. */
  readonly clockToleranceSec?: number;
  /** Where fetched statements are kept; default memory. */
  readonly cache?: RecordStore;
  /** The longest a fetched statement is reused, in seconds; default 3600. */
  readonly cacheTtlSec?: number;
  /** Validate the trust marks of resolved entities; default true. */
  readonly trustMarks?: boolean;
  readonly fetch?: FetchLike;
  readonly now?: Clock;
}

/** A valid trust chain and what it resolves to. */
export interface TrustChain {
  readonly subject: string;
  readonly trustAnchor: string;
  /** `ES[0..i]` as JWTs: the subject's configuration, subordinate statements, the anchor's configuration. */
  readonly statements: readonly string[];
  readonly claims: readonly EntityStatement[];
  /** The subject's metadata after the superior's metadata, allowed types and policies. */
  readonly metadata: EntityMetadata;
  /** The subject's federation keys, as its immediate superior vouches for them. */
  readonly jwks: Jwks;
  /** Epoch seconds: the earliest `exp` in the chain. */
  readonly expiresAt: number;
  /** The subject's trust marks that validated. */
  readonly trustMarks: readonly VerifiedTrustMark[];
  /** Trust marks that did not validate, with why. */
  readonly rejectedTrustMarks: readonly {
    readonly trustMarkType: string;
    readonly reason: string;
  }[];
}

/** What {@link TrustChainResolver.resolve} may be told. */
export interface ResolveOptions {
  /** Only chains to this trust anchor. */
  readonly trustAnchor?: string;
  /**
   * The subject's entity configuration as received (an explicit
   * registration request), used instead of fetching it.
   */
  readonly entityConfiguration?: string;
}

/** What one resolution may still fetch, and whether it reads the cache. */
interface Budget {
  left: number;
  readonly fresh: boolean;
  /** Statements taken from the cache so far. */
  cached: number;
}

interface Fetched {
  readonly jwt: string;
  readonly claims: EntityStatement;
}

function hostOf(entityId: string): string {
  return new URL(entityId).hostname.toLowerCase();
}

/** Whether `host` satisfies an RFC 5280 domain name constraint. */
export function hostMatches(host: string, constraint: string): boolean {
  const name = constraint.toLowerCase();
  return name.startsWith(".") ? host.endsWith(name) : host === name;
}

/** Finds, validates and resolves trust chains; see the module documentation. */
export class TrustChainResolver {
  readonly #options: TrustChainResolverOptions;
  readonly #anchors: ReadonlyMap<string, TrustAnchor>;
  readonly #fetch: FetchLike;
  readonly #now: Clock;
  readonly #memory = new Map<string, { jwt: string; until: number }>();
  readonly #chains = new Map<string, TrustChain>();

  constructor(options: TrustChainResolverOptions) {
    if (options.trustAnchors.length === 0) {
      throw new TypeError("a trust chain resolver needs a trust anchor");
    }
    for (const anchor of options.trustAnchors) {
      if (!isEntityId(anchor.entityId)) {
        throw new TypeError(`${anchor.entityId} is not an entity identifier`);
      }
    }
    this.#options = options;
    this.#anchors = new Map(
      options.trustAnchors.map((anchor) => [anchor.entityId, anchor]),
    );
    this.#fetch = options.fetch ?? defaultFetch;
    this.#now = options.now ?? defaultClock;
  }

  /** The configured trust anchors' identifiers. */
  get trustAnchors(): readonly string[] {
    return [...this.#anchors.keys()];
  }

  #verifyOptions() {
    return {
      now: this.#now,
      clockToleranceSec: this.#options.clockToleranceSec,
    };
  }

  async #cached(url: string): Promise<string | null> {
    const cache = this.#options.cache;
    if (cache !== undefined) {
      const stored = await cache.get<string>(`federation:${url}`);
      return stored?.value ?? null;
    }
    const hit = this.#memory.get(url);
    if (hit === undefined || hit.until <= this.#now()) {
      this.#memory.delete(url);
      return null;
    }
    return hit.jwt;
  }

  async #remember(url: string, jwt: string): Promise<void> {
    const exp = peekStatement(jwt)?.exp;
    const until = Math.min(
      typeof exp === "number" ? exp * 1000 : 0,
      this.#now() + (this.#options.cacheTtlSec ?? 3600) * 1000,
    );
    if (until <= this.#now()) return;
    const cache = this.#options.cache;
    if (cache !== undefined) {
      await cache.put(`federation:${url}`, jwt, until);
      return;
    }
    this.#memory.set(url, { jwt, until });
    if (this.#memory.size > 1000) {
      this.#memory.delete(this.#memory.keys().next().value!);
    }
  }

  async #get(url: string, budget: Budget): Promise<string> {
    const cached = budget.fresh ? null : await this.#cached(url);
    if (cached !== null) {
      budget.cached++;
      return cached;
    }
    if (budget.left-- <= 0) {
      throw new FederationError("fetch", "too many statements to fetch");
    }
    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: { accept: `application/${MEDIA_TYPES.entityStatement}` },
        redirect: "error",
      });
    } catch (cause) {
      throw new FederationError("fetch", `could not fetch ${url}`, { cause });
    }
    const text = await response.text();
    if (!response.ok) {
      throw new FederationError("fetch", `${url} answered ${response.status}`);
    }
    const type = response.headers.get("content-type") ?? "";
    if (!isMediaType(type, `application/${MEDIA_TYPES.entityStatement}`)) {
      throw new FederationError(
        "fetch",
        `${url} did not answer an entity statement`,
      );
    }
    await this.#remember(url, text.trim());
    return text.trim();
  }

  /**
   * An entity's configuration, fetched (or given) and verified with its
   * own keys: `iss` and `sub` are the entity. A trust anchor's must
   * verify with its configured keys.
   */
  async #configuration(
    entityId: string,
    budget: Budget,
    given?: string,
  ): Promise<Fetched> {
    const jwt = given ??
      await this.#get(entityConfigurationUrl(entityId), budget);
    const peek = peekStatement(jwt);
    if (!isObject(peek) || !isObject(peek.jwks)) {
      throw new FederationError(
        "malformed",
        `${entityId}'s configuration has no jwks`,
      );
    }
    const anchor = this.#anchors.get(entityId);
    const claims = await verifyStatement(
      jwt,
      anchor?.jwks ?? (peek.jwks as unknown as Jwks),
      this.#verifyOptions(),
    );
    if (claims.iss !== entityId || claims.sub !== entityId) {
      throw new FederationError(
        "chain",
        `the configuration at ${entityId} is not about ${entityId}`,
      );
    }
    return { jwt, claims };
  }

  async #subordinate(
    superior: Fetched,
    subject: string,
    budget: Budget,
  ): Promise<Fetched> {
    const endpoint = superior.claims.metadata?.federation_entity
      ?.federation_fetch_endpoint;
    if (typeof endpoint !== "string" || !isEntityId(endpoint.split("?")[0])) {
      throw new FederationError(
        "chain",
        `${superior.claims.iss} publishes no federation_fetch_endpoint`,
      );
    }
    const url = new URL(endpoint);
    url.searchParams.set("sub", subject);
    const jwt = await this.#get(url.href, budget);
    const claims = await verifyStatement(
      jwt,
      superior.claims.jwks!,
      this.#verifyOptions(),
    );
    if (claims.iss !== superior.claims.iss || claims.sub !== subject) {
      throw new FederationError(
        "chain",
        `${url} answered a statement about the wrong entity`,
      );
    }
    return { jwt, claims };
  }

  /** Every path of statements from `subject` (exclusive) up to a trust anchor's configuration. */
  async #climb(
    subject: Fetched,
    path: readonly string[],
    budget: Budget,
    anchor: string | undefined,
    problems: string[],
  ): Promise<string[][]> {
    const out: string[][] = [];
    const intermediates = path.length - 1;
    for (const hint of subject.claims.authority_hints ?? []) {
      if (path.includes(hint)) {
        problems.push(`${hint} is already on the path (a loop)`);
        continue;
      }
      const isAnchor = this.#anchors.has(hint) &&
        (anchor === undefined || hint === anchor);
      if (!isAnchor && intermediates >= (this.#options.maxPathLength ?? 4)) {
        problems.push(`the path through ${hint} is too long`);
        continue;
      }
      try {
        const superior = await this.#configuration(hint, budget);
        const statement = await this.#subordinate(
          superior,
          subject.claims.sub,
          budget,
        );
        if (isAnchor) {
          out.push([statement.jwt, superior.jwt]);
          continue;
        }
        for (
          const rest of await this.#climb(
            superior,
            [...path, hint],
            budget,
            anchor,
            problems,
          )
        ) {
          out.push([statement.jwt, ...rest]);
        }
      } catch (error) {
        if (!(error instanceof FederationError)) throw error;
        if (error.code === "fetch" && error.message.startsWith("too many")) {
          throw error;
        }
        problems.push(`${hint}: ${error.message}`);
      }
    }
    return out;
  }

  /**
   * The trust chain of `entityId` to a trust anchor, validated and
   * resolved; see the module documentation. Throws a
   * {@link FederationError} (`chain` when no path is valid, with the
   * reasons).
   */
  async resolve(
    entityId: string,
    options: ResolveOptions = {},
  ): Promise<TrustChain> {
    if (!isEntityId(entityId)) {
      throw new FederationError(
        "chain",
        `${entityId} is not an entity identifier`,
      );
    }
    const key = `${entityId}\n${options.trustAnchor ?? ""}`;
    if (options.entityConfiguration === undefined) {
      const hit = this.#chains.get(key);
      if (hit !== undefined && hit.expiresAt > epochSeconds(this.#now)) {
        return hit;
      }
      this.#chains.delete(key);
    }
    const first: Budget = {
      left: this.#options.maxFetches ?? 64,
      fresh: false,
      cached: 0,
    };
    try {
      return await this.#search(entityId, options, key, first);
    } catch (error) {
      // Cached statements can be stale in ways their expiry does not show
      // (a trust anchor's rotated keys); try once more from the source.
      if (!(error instanceof FederationError) || first.cached === 0) {
        throw error;
      }
      return await this.#search(entityId, options, key, {
        left: this.#options.maxFetches ?? 64,
        fresh: true,
        cached: 0,
      });
    }
  }

  async #search(
    entityId: string,
    options: ResolveOptions,
    key: string,
    budget: Budget,
  ): Promise<TrustChain> {
    const leaf = await this.#configuration(
      entityId,
      budget,
      options.entityConfiguration,
    );
    const problems: string[] = [];
    let candidates: string[][];
    if (
      this.#anchors.has(entityId) &&
      (options.trustAnchor === undefined || options.trustAnchor === entityId)
    ) {
      candidates = [[leaf.jwt]];
    } else {
      candidates = (await this.#climb(
        leaf,
        [entityId],
        budget,
        options.trustAnchor,
        problems,
      )).map((rest) => [leaf.jwt, ...rest]);
    }
    candidates.sort((a, b) => a.length - b.length);
    for (const candidate of candidates) {
      try {
        const chain = await this.validate(candidate);
        if (options.entityConfiguration === undefined) {
          this.#chains.set(key, chain);
          if (this.#chains.size > 1000) {
            this.#chains.delete(this.#chains.keys().next().value!);
          }
        }
        return chain;
      } catch (error) {
        if (!(error instanceof FederationError)) throw error;
        problems.push(error.message);
      }
    }
    throw new FederationError(
      "chain",
      `no valid trust chain from ${entityId} to ${
        options.trustAnchor ?? "a trust anchor"
      }${problems.length === 0 ? "" : ` (${problems.join("; ")})`}`,
    );
  }

  /**
   * Validates a trust chain given as JWTs `ES[0..i]` (a `trust_chain`
   * someone sent, or one {@link resolve} found) and resolves it; see the
   * module documentation.
   */
  async validate(statements: readonly string[]): Promise<TrustChain> {
    if (statements.length === 0) {
      throw new FederationError("chain", "the trust chain is empty");
    }
    const options = this.#verifyOptions();
    const last = statements.length - 1;
    const peeked = statements.map((jwt) => peekStatement(jwt));
    const anchorId = peeked[last]?.iss;
    const anchor = typeof anchorId === "string"
      ? this.#anchors.get(anchorId)
      : undefined;
    if (anchor === undefined || peeked[last]?.sub !== anchorId) {
      throw new FederationError(
        "chain",
        "the chain does not end at a configured trust anchor",
      );
    }
    if (Math.max(0, last - 2) > (this.#options.maxPathLength ?? 4)) {
      throw new FederationError("constraints", "the chain is too long");
    }
    const claims: EntityStatement[] = new Array(statements.length);
    claims[last] = await verifyStatement(
      statements[last],
      anchor.jwks,
      options,
    );
    for (let j = last - 1; j >= 0; j--) {
      const superior = claims[j + 1];
      const verified = await verifyStatement(
        statements[j],
        superior.jwks!,
        options,
      );
      if (verified.iss !== superior.sub) {
        throw new FederationError(
          "chain",
          `ES[${j}] is issued by ${verified.iss}, not ${superior.sub}`,
        );
      }
      claims[j] = verified;
    }
    const leaf = claims[0];
    if (leaf.iss !== leaf.sub) {
      throw new FederationError(
        "chain",
        "ES[0] is not an entity configuration",
      );
    }
    await verifyStatement(statements[0], leaf.jwks!, options);
    for (let j = 1; j < last; j++) {
      if (claims[j].iss === claims[j].sub) {
        throw new FederationError(
          "chain",
          `ES[${j}] is not a subordinate statement`,
        );
      }
      if (claims[j].sub !== claims[j - 1].iss) {
        throw new FederationError(
          "chain",
          `ES[${j}] is about the wrong entity`,
        );
      }
    }
    if (last >= 1 && !(leaf.authority_hints ?? []).includes(claims[1].iss)) {
      throw new FederationError(
        "chain",
        `${claims[1].iss} is not among ${leaf.sub}'s authority_hints`,
      );
    }
    const metadata = this.#resolveMetadata(claims);
    const expiresAt = Math.min(...claims.map((statement) => statement.exp));
    const jwks = last >= 1 ? claims[1].jwks! : anchor.jwks;
    const chain: TrustChain = {
      subject: leaf.sub,
      trustAnchor: anchor.entityId,
      statements: [...statements],
      claims,
      metadata,
      jwks,
      expiresAt,
      trustMarks: [],
      rejectedTrustMarks: [],
    };
    if (this.#options.trustMarks === false || leaf.trust_marks === undefined) {
      return chain;
    }
    return await this.#withTrustMarks(chain, claims[last], anchor);
  }

  #resolveMetadata(claims: readonly EntityStatement[]): EntityMetadata {
    const last = claims.length - 1;
    const leaf = claims[0];
    const metadata: Record<string, Record<string, unknown>> = structuredClone(
      (leaf.metadata ?? {}) as Record<string, Record<string, unknown>>,
    );
    if (last < 2) return metadata;
    const entities = claims.slice(0, last).map((statement) => statement.sub);
    const allowedLists: (readonly string[])[] = [];
    for (let j = 1; j < last; j++) {
      const constraints = claims[j].constraints;
      if (constraints === undefined) continue;
      const max = constraints.max_path_length;
      if (max !== undefined) {
        if (!Number.isInteger(max) || max < 0) {
          throw new FederationError(
            "constraints",
            "max_path_length is malformed",
          );
        }
        if (j - 1 > max) {
          throw new FederationError(
            "constraints",
            `${
              claims[j].iss
            } allows ${max} intermediates below it, and the chain has ${j - 1}`,
          );
        }
      }
      const naming = constraints.naming_constraints;
      if (naming !== undefined) {
        for (const entity of entities.slice(0, j)) {
          const host = hostOf(entity);
          if ((naming.excluded ?? []).some((name) => hostMatches(host, name))) {
            throw new FederationError(
              "constraints",
              `${entity} is excluded by ${claims[j].iss}'s naming constraints`,
            );
          }
          const permitted = naming.permitted ?? [];
          if (
            permitted.length > 0 &&
            !permitted.some((name) => hostMatches(host, name))
          ) {
            throw new FederationError(
              "constraints",
              `${entity} is outside ${claims[j].iss}'s naming constraints`,
            );
          }
        }
      }
      const types = constraints.allowed_entity_types;
      if (types !== undefined) {
        allowedLists.push(types);
      }
    }
    const superior = claims[1].metadata ?? {};
    for (const [type, parameters] of Object.entries(superior)) {
      if (metadata[type] === undefined) continue;
      Object.assign(metadata[type], structuredClone(parameters));
    }
    for (const type of Object.keys(metadata)) {
      if (
        type !== "federation_entity" &&
        !allowedLists.every((list) => list.includes(type))
      ) {
        delete metadata[type];
      }
    }
    const policies: MetadataPolicy[] = [];
    const critical = new Set<string>();
    for (let j = last - 1; j >= 1; j--) {
      for (const operator of claims[j].metadata_policy_crit ?? []) {
        critical.add(operator);
      }
    }
    for (let j = last - 1; j >= 1; j--) {
      const policy = claims[j].metadata_policy;
      if (policy !== undefined) policies.push(policy);
    }
    if (policies.length === 0) return metadata;
    return applyMetadataPolicy(
      metadata,
      resolveMetadataPolicy(policies, critical),
    );
  }

  async #withTrustMarks(
    chain: TrustChain,
    anchorConfiguration: EntityStatement,
    anchor: TrustAnchor,
    depth = 0,
  ): Promise<TrustChain> {
    const accepted: VerifiedTrustMark[] = [];
    const rejected: { trustMarkType: string; reason: string }[] = [];
    for (const entry of chain.claims[0].trust_marks ?? []) {
      try {
        const mark = await verifyTrustMark(entry.trust_mark, {
          subject: chain.subject,
          trustAnchor: anchorConfiguration,
          trustAnchorJwks: anchor.jwks,
          issuerKeys: async (issuer) => {
            if (depth > 2) return null;
            try {
              const issuerChain = await this.resolve(issuer, {
                trustAnchor: anchor.entityId,
              });
              return issuerChain.jwks;
            } catch {
              return null;
            }
          },
          now: this.#now,
          clockToleranceSec: this.#options.clockToleranceSec,
        });
        if (mark.trustMarkType !== entry.trust_mark_type) {
          throw new FederationError(
            "trust_mark",
            "trust_mark_type differs from the mark's own",
          );
        }
        accepted.push(mark);
      } catch (error) {
        if (!(error instanceof FederationError)) throw error;
        rejected.push({
          trustMarkType: entry.trust_mark_type,
          reason: error.message,
        });
      }
    }
    return { ...chain, trustMarks: accepted, rejectedTrustMarks: rejected };
  }
}
