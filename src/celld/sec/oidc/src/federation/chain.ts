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
 * the path is never visited again (cycles), and a path longer than
 * `maxPathLength` intermediates is abandoned. Each candidate chain is then
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
 * at the earliest `exp` of its statements and of the trust marks it
 * accepted (their delegations, and the trust chains that made their
 * issuers issuers), so nothing derived from it (a cached chain, a resolve
 * response) carries a mark past its expiry or its issuer's authority. A
 * rejected mark shortens nothing.
 *
 * One call of {@link TrustChainResolver.resolve} is one resolution: the
 * entity's chain, and the chains of its trust mark issuers (whose keys
 * the marks are checked with), share one budget of `maxFetches` fetches
 * and `maxNodes` statements (cached ones count as nodes), so neither a
 * wide graph nor the cache can make it unbounded. Trust mark issuers are
 * resolved for their keys only (their own marks are not validated), at
 * most {@link MAX_TRUST_MARK_DEPTH} levels down; an issuer whose chain
 * needs the entity being resolved (a self-issued mark, or an A <-> B
 * cycle) is refused as `cycle`, and two marks by one issuer share its one
 * resolution. A spent budget fails the whole resolution with `budget`.
 * Within one resolution a URL is fetched at most once (a second superior
 * naming the same `federation_fetch_endpoint` reuses the answer or the
 * failure), and across resolutions each origin gets at most `fetchRate`
 * fetches per window (default 120 a minute), so nothing that makes the
 * resolver fetch (an unknown client id, a public resolve request) can
 * aim it at one host faster than that.
 *
 * Every fetch goes through `@celld/http/egress`'s `boundedFetch`: https
 * (http only to a loopback IP literal with `allowLoopbackForDevelopment`),
 * no redirects, a deadline (5 seconds), at most 256 KiB read as a stream,
 * and no private, link-local or loopback address; `egress` adjusts it.
 *
 * Fetched statements are cached (in memory, or in a `RecordStore`) until
 * they expire or `cacheTtlSec` passes, and re-verified on every use;
 * resolved chains are cached in memory until they expire, and a chain
 * with a trust mark rejected for a reason that may pass (its issuer's
 * chain could not be fetched) for at most {@link TRANSIENT_RETRY_SEC}.
 * A cached chain never returns a trust mark that has since expired.
 *
 * @module
 */

import {
  type Clock,
  type EgressOptions,
  type EgressUrlPolicy,
  egressUrlProblem,
  type FetchLike,
  metadataEgressPolicy,
} from "@celld/sec/oauth";
import type { RecordStore } from "@celld/sec/oauth/server";
import type { Jwks } from "@celld/sec/jwt";
import { bytes, jsonSnapshot, millis, safeInt } from "@celld/core/bounds";
import {
  type BoundedFetch,
  boundedFetch,
  EgressError,
  type EgressPolicy,
} from "@celld/http/egress";
import {
  defaultClock,
  defaultFetch,
  epochSeconds,
  isMediaType,
  isObject,
  snapshotOptions,
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

/** The largest statement read, in bytes. */
export const STATEMENT_MAX_BYTES = 256 * 1024;

/** How deep trust mark issuers' chains are resolved: the entity's marks' issuers only. */
export const MAX_TRUST_MARK_DEPTH = 1;

/**
 * Seconds a chain is reused when one of its trust marks was rejected
 * because its issuer could not be resolved (a failure that may pass).
 */
export const TRANSIENT_RETRY_SEC = 60;

/** Options for {@link TrustChainResolver}. */
export interface TrustChainResolverOptions extends EgressOptions {
  readonly trustAnchors: readonly TrustAnchor[];
  /** The most intermediates between an entity and its trust anchor; default 4. */
  readonly maxPathLength?: number;
  /** The most statements fetched for one resolution, trust mark issuers included; default 64. */
  readonly maxFetches?: number;
  /** The most statements (fetched or cached) and chains one resolution handles; default 256. */
  readonly maxNodes?: number;
  /**
   * The most fetches to one origin per window, across resolutions;
   * default 120 per 60 seconds. Past it, a fetch to that origin fails
   * (`fetch`) until the window ends.
   */
  readonly fetchRate?: {
    readonly perOrigin: number;
    readonly windowSec: number;
    /** All origins combined; default 512 per window. */
    readonly global?: number;
  };
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
  /**
   * Epoch seconds: the earliest `exp` in the chain and of its accepted
   * trust marks, their delegations, and their issuers' own trust chains.
   */
  readonly expiresAt: number;
  /** The subject's trust marks that validated. */
  readonly trustMarks: readonly VerifiedTrustMark[];
  /** Trust marks that did not validate, with why. */
  readonly rejectedTrustMarks: readonly {
    readonly trustMarkType: string;
    readonly reason: string;
    /** The {@link FederationError} code: `cycle`, `depth`, `trust_mark`, ... */
    readonly code: string;
  }[];
}

/**
 * What one resolution may still spend. The object is decremented in
 * place, so a caller that gives one (the resolve endpoint, per request)
 * bounds everything resolved with it.
 */
export interface FederationBudget {
  /** Network fetches left. */
  fetches: number;
  /** Statements (fetched or cached) and chains left. */
  nodes: number;
}

/** What {@link TrustChainResolver.resolve} may be told. */
export interface ResolveOptions {
  /** Cancels this resolution and all of its credential-free network reads. */
  readonly signal?: AbortSignal;
  /** Only chains to this trust anchor. */
  readonly trustAnchor?: string;
  /**
   * The subject's entity configuration as received (an explicit
   * registration request), used instead of fetching it.
   */
  readonly entityConfiguration?: string;
  /**
   * The budget to spend, shared with whatever else the caller resolves
   * with it; default a fresh one of `maxFetches` and `maxNodes`.
   */
  readonly budget?: FederationBudget;
}

/** One resolution: its budget, its fetch, the chains it has resolved or is resolving, and the URLs it fetched. */
interface Resolution {
  readonly signal?: AbortSignal;
  readonly budget: FederationBudget;
  readonly get: BoundedFetch;
  readonly chains: Map<string, Promise<TrustChain>>;
  readonly fetched: Map<string, Promise<string>>;
}

/** Where a resolution is: how deep in trust mark issuers, and whose chains need this one. */
interface Frame {
  readonly depth: number;
  readonly ancestry: readonly string[];
}

/** One attempt at a chain: whether it reads the cache, and how many cached statements it used. */
interface Pass {
  readonly fresh: boolean;
  cached: number;
}

interface Fetched {
  readonly jwt: string;
  readonly claims: EntityStatement;
}

function hostOf(entityId: string): string {
  const host = new URL(entityId).hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || /^[\d.]+$/.test(host)) {
    throw new FederationError(
      "constraints",
      "DNS naming constraints require a DNS entity name",
    );
  }
  return host;
}

/** Whether `host` satisfies an RFC 5280 domain name constraint. */
export function hostMatches(host: string, constraint: string): boolean {
  const name = constraint.toLowerCase().replace(/\.$/, "");
  host = host.toLowerCase().replace(/\.$/, "");
  return name.startsWith(".")
    ? host.endsWith(name) && host.length > name.length
    : host === name;
}

/** Whether `error` ends the whole resolution rather than one path or mark. */
function fatal(error: FederationError): boolean {
  return error.code === "budget";
}

/** Finds, validates and resolves trust chains; see the module documentation. */
export class TrustChainResolver {
  readonly #options: TrustChainResolverOptions;
  readonly #anchors: ReadonlyMap<string, TrustAnchor>;
  readonly #fetch: FetchLike;
  readonly #now: Clock;
  readonly #policy: EgressPolicy;
  readonly #memory = new Map<string, { jwt: string; until: number }>();
  /** Fetches per origin in the current window. */
  readonly #rates = new Map<string, { start: number; count: number }>();
  #globalRate = { start: 0, count: 0 };
  readonly #chains = new Map<string, { chain: TrustChain; until: number }>();
  /** Chains with a trust mark rejected for a reason that may pass. */
  readonly #transient = new WeakSet<TrustChain>();

  /** Throws `TypeError` without a trust anchor or with a bad one, `RangeError` for bad limits. */
  constructor(input: TrustChainResolverOptions) {
    // Read once: the anchors' keys and the limits are copied, so pushing a
    // key into a caller's anchor JWKS afterwards trusts nothing new.
    const options = snapshotOptions(input);
    if (options.trustAnchors.length === 0 || options.trustAnchors.length > 32) {
      throw new TypeError("a trust chain resolver needs 1..32 trust anchors");
    }
    for (const anchor of options.trustAnchors) {
      if (!isEntityId(anchor.entityId)) {
        throw new TypeError(`${anchor.entityId} is not an entity identifier`);
      }
    }
    safeInt(options.maxFetches ?? 64, {
      name: "maxFetches",
      min: 1,
      max: 1024,
    });
    safeInt(options.maxNodes ?? 256, { name: "maxNodes", min: 1, max: 4096 });
    safeInt(options.maxPathLength ?? 4, {
      name: "maxPathLength",
      min: 0,
      max: 32,
    });
    safeInt(options.fetchRate?.global ?? 512, {
      name: "fetchRate.global",
      min: 1,
      max: 100000,
    });
    safeInt(options.cacheTtlSec ?? 3600, {
      name: "cacheTtlSec",
      min: 0,
      max: 3600,
    });
    if (options.fetchRate !== undefined) {
      safeInt(options.fetchRate.perOrigin, {
        name: "fetchRate.perOrigin",
        min: 1,
      });
      safeInt(options.fetchRate.windowSec, {
        name: "fetchRate.windowSec",
        min: 1,
      });
    }
    this.#options = options;
    this.#anchors = new Map(
      options.trustAnchors.map((anchor) => [anchor.entityId, anchor]),
    );
    this.#fetch = options.fetch ?? defaultFetch;
    this.#now = options.now ?? defaultClock;
    this.#policy = metadataEgressPolicy(options, {
      timeoutMs: millis(5_000),
      maxBytes: bytes(STATEMENT_MAX_BYTES),
    });
  }

  /** The configured trust anchors' identifiers. */
  get trustAnchors(): readonly string[] {
    return [...this.#anchors.keys()];
  }

  /** The network class of the egress policy, for callers that check entity ids up front. */
  get network(): EgressPolicy["network"] {
    return this.#policy.network;
  }

  /** The egress policy's URL rules, for `egressUrlProblem` up front. */
  get urlPolicy(): EgressUrlPolicy {
    const { network, allowCleartextLoopbackForDevelopment } = this.#policy;
    return { network, allowCleartextLoopbackForDevelopment };
  }

  /** A budget of `maxFetches` fetches and `maxNodes` nodes. */
  budget(): FederationBudget {
    return {
      fetches: this.#options.maxFetches ?? 64,
      nodes: this.#options.maxNodes ?? 256,
    };
  }

  #resolution(
    budget: FederationBudget = this.budget(),
    signal?: AbortSignal,
  ): Resolution {
    safeInt(budget.fetches, { name: "budget.fetches", min: 0, max: 1024 });
    safeInt(budget.nodes, { name: "budget.nodes", min: 0, max: 4096 });
    return {
      budget,
      signal,
      get: boundedFetch(
        this.#policy,
        (input, init) => this.#fetch(input, init),
      ),
      chains: new Map(),
      fetched: new Map(),
    };
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

  /** Charges one node to the resolution; throws `budget` when none are left. */
  #charge(context: Resolution): void {
    if (!(context.budget.nodes >= 1)) {
      throw new FederationError("budget", "the resolution's budget is spent");
    }
    context.budget.nodes--;
  }

  /** Counts one fetch to `url`'s origin; throws `fetch` past `fetchRate`. */
  #spend(url: string): void {
    const origin = new URL(url).origin;
    const rate = this.#options.fetchRate ?? { perOrigin: 120, windowSec: 60 };
    const now = this.#now();
    if (
      now < this.#globalRate.start ||
      now - this.#globalRate.start >= rate.windowSec * 1000
    ) this.#globalRate = { start: now, count: 0 };
    if (this.#globalRate.count >= (rate.global ?? 512)) {
      throw new FederationError(
        "fetch",
        "global federation fetch budget exhausted",
      );
    }
    let entry = this.#rates.get(origin);
    if (entry === undefined || now - entry.start >= rate.windowSec * 1000) {
      this.#rates.delete(origin);
      entry = { start: now, count: 0 };
      this.#rates.set(origin, entry);
      if (this.#rates.size > 1000) {
        this.#rates.delete(this.#rates.keys().next().value!);
      }
    }
    if (entry.count >= rate.perOrigin) {
      throw new FederationError(
        "fetch",
        `${origin} was fetched ${rate.perOrigin} times in ${rate.windowSec} seconds; try later`,
      );
    }
    entry.count++;
    this.#globalRate.count++;
  }

  async #get(url: string, context: Resolution, pass: Pass): Promise<string> {
    this.#charge(context);
    const cached = pass.fresh ? null : await this.#cached(url);
    if (cached !== null) {
      pass.cached++;
      return cached;
    }
    const problem = egressUrlProblem(url, this.#policy);
    if (problem !== null) {
      throw new FederationError("fetch", `${url} ${problem}`);
    }
    // Once per resolution: the answer, or the failure, is reused.
    let work = context.fetched.get(url);
    if (work === undefined) {
      work = this.#fetch1(url, context);
      context.fetched.set(url, work);
    }
    return await work;
  }

  async #fetch1(url: string, context: Resolution): Promise<string> {
    if (context.signal?.aborted) {
      throw new FederationError("fetch", "federation resolution was cancelled");
    }
    if (context.budget.fetches < 1) {
      throw new FederationError("budget", "too many statements to fetch");
    }
    context.budget.fetches--;
    this.#spend(url);
    let text: string;
    let status: number;
    let type: string;
    try {
      const response = await context.get(url, {
        headers: { accept: `application/${MEDIA_TYPES.entityStatement}` },
        signal: context.signal,
      });
      status = response.status;
      type = response.headers.get("content-type") ?? "";
      text = await response.text();
    } catch (cause) {
      if (cause instanceof EgressError && cause.code === "budget") {
        throw new FederationError("budget", "too many statements to fetch", {
          cause,
        });
      }
      throw new FederationError(
        "fetch",
        `could not fetch ${url}: ${(cause as Error)?.message ?? cause}`,
        { cause },
      );
    }
    if (status < 200 || status >= 300) {
      throw new FederationError("fetch", `${url} answered ${status}`);
    }
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
    context: Resolution,
    pass: Pass,
    given?: string,
  ): Promise<Fetched> {
    const jwt = given ??
      await this.#get(entityConfigurationUrl(entityId), context, pass);
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
    context: Resolution,
    pass: Pass,
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
    const jwt = await this.#get(url.href, context, pass);
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
    context: Resolution,
    pass: Pass,
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
        const superior = await this.#configuration(hint, context, pass);
        const statement = await this.#subordinate(
          superior,
          subject.claims.sub,
          context,
          pass,
        );
        if (isAnchor) {
          out.push([statement.jwt, superior.jwt]);
          continue;
        }
        for (
          const rest of await this.#climb(
            superior,
            [...path, hint],
            context,
            pass,
            anchor,
            problems,
          )
        ) {
          out.push([statement.jwt, ...rest]);
        }
      } catch (error) {
        if (!(error instanceof FederationError) || fatal(error)) throw error;
        problems.push(`${hint}: ${error.message}`);
      }
    }
    return out;
  }

  /**
   * The trust chain of `entityId` to a trust anchor, validated and
   * resolved; see the module documentation. Throws a
   * {@link FederationError}: `chain` when no path is valid (with the
   * reasons), `budget` when the resolution's budget is spent.
   */
  async resolve(
    entityId: string,
    options: ResolveOptions = {},
  ): Promise<TrustChain> {
    return await this.#resolveIn(
      this.#resolution(options.budget, options.signal),
      entityId,
      options,
      { depth: 0, ancestry: [] },
      this.#options.trustMarks !== false,
    );
  }

  async #resolveIn(
    context: Resolution,
    entityId: string,
    options: ResolveOptions,
    frame: Frame,
    marks: boolean,
  ): Promise<TrustChain> {
    if (context.signal?.aborted) {
      throw new FederationError("fetch", "federation resolution was cancelled");
    }
    if (!isEntityId(entityId)) {
      throw new FederationError(
        "chain",
        `${entityId} is not an entity identifier`,
      );
    }
    if (frame.ancestry.includes(entityId)) {
      throw new FederationError(
        "cycle",
        `resolving ${entityId} needs ${entityId} itself (${
          [...frame.ancestry, entityId].join(" -> ")
        })`,
      );
    }
    if (frame.depth > MAX_TRUST_MARK_DEPTH) {
      throw new FederationError(
        "depth",
        `trust mark issuers nest deeper than ${MAX_TRUST_MARK_DEPTH}`,
      );
    }
    this.#charge(context);
    const key = `${entityId}\n${options.trustAnchor ?? ""}`;
    if (options.entityConfiguration === undefined) {
      const hit = this.#chains.get(key);
      const now = epochSeconds(this.#now);
      if (hit !== undefined && hit.until > now) {
        // Never a mark past its expiry, whatever the entry's lifetime.
        const live = hit.chain.trustMarks.filter((mark) =>
          mark.expiresAt === undefined || mark.expiresAt > now
        );
        return live.length === hit.chain.trustMarks.length
          ? hit.chain
          : jsonSnapshot({ ...hit.chain, trustMarks: live }, {
            maxBytes: 2 * 1024 * 1024,
            maxItems: 32768,
          });
      }
      if (hit !== undefined) this.#chains.delete(key);
      const running = context.chains.get(`${key}\n${marks}`);
      if (running !== undefined) return await running;
    }
    const work = this.#searchTwice(context, entityId, options, frame, marks);
    if (options.entityConfiguration === undefined) {
      context.chains.set(`${key}\n${marks}`, work);
    }
    const resolved = await work;
    const chain = jsonSnapshot(resolved, {
      maxBytes: 2 * 1024 * 1024,
      maxItems: 32768,
    });
    // Only a chain whose own trust marks were validated is kept past the
    // resolution; an issuer's chain resolved for its keys stays in it.
    if (options.entityConfiguration === undefined && marks) {
      this.#chains.set(key, {
        chain,
        until: Math.min(
          chain.expiresAt,
          epochSeconds(this.#now) + (this.#options.cacheTtlSec ?? 3600),
          this.#transient.has(resolved)
            ? epochSeconds(this.#now) + TRANSIENT_RETRY_SEC
            : Infinity,
        ),
      });
      if (this.#chains.size > 1000) {
        this.#chains.delete(this.#chains.keys().next().value!);
      }
    }
    return chain;
  }

  async #searchTwice(
    context: Resolution,
    entityId: string,
    options: ResolveOptions,
    frame: Frame,
    marks: boolean,
  ): Promise<TrustChain> {
    const first: Pass = { fresh: false, cached: 0 };
    try {
      return await this.#search(
        context,
        entityId,
        options,
        frame,
        marks,
        first,
      );
    } catch (error) {
      // Cached statements can be stale in ways their expiry does not show
      // (a trust anchor's rotated keys); try once more from the source,
      // within the same budget.
      if (
        !(error instanceof FederationError) || fatal(error) ||
        first.cached === 0
      ) {
        throw error;
      }
      return await this.#search(context, entityId, options, frame, marks, {
        fresh: true,
        cached: 0,
      });
    }
  }

  async #search(
    context: Resolution,
    entityId: string,
    options: ResolveOptions,
    frame: Frame,
    marks: boolean,
    pass: Pass,
  ): Promise<TrustChain> {
    const leaf = await this.#configuration(
      entityId,
      context,
      pass,
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
        context,
        pass,
        options.trustAnchor,
        problems,
      )).map((rest) => [leaf.jwt, ...rest]);
    }
    candidates.sort((a, b) => a.length - b.length);
    const inner: Frame = {
      depth: frame.depth,
      ancestry: [...frame.ancestry, entityId],
    };
    for (const candidate of candidates) {
      try {
        return await this.#validate(candidate, context, inner, marks);
      } catch (error) {
        if (!(error instanceof FederationError) || fatal(error)) throw error;
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
   * module documentation. Its trust marks' issuers are resolved within
   * one fresh budget.
   */
  async validate(statements: readonly string[]): Promise<TrustChain> {
    const subject = peekStatement(statements[0] ?? "")?.sub;
    return await this.#validate(
      statements,
      this.#resolution(),
      { depth: 0, ancestry: typeof subject === "string" ? [subject] : [] },
      this.#options.trustMarks !== false,
    );
  }

  async #validate(
    statements: readonly string[],
    context: Resolution,
    frame: Frame,
    marks: boolean,
  ): Promise<TrustChain> {
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
    if (!marks || leaf.trust_marks === undefined) {
      return jsonSnapshot(chain, {
        maxBytes: 2 * 1024 * 1024,
        maxItems: 32768,
      });
    }
    return await this.#withTrustMarks(
      chain,
      claims[last],
      anchor,
      context,
      frame,
    );
  }

  #resolveMetadata(claims: readonly EntityStatement[]): EntityMetadata {
    const last = claims.length - 1;
    const leaf = claims[0];
    const metadata: Record<string, Record<string, unknown>> = structuredClone(
      (leaf.metadata ?? {}) as Record<string, Record<string, unknown>>,
    );
    if (last < 2) return metadata;
    const entities = claims.slice(1, last).map((statement) => statement.sub);
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
        for (const entity of new Set([leaf.sub, ...entities.slice(0, j)])) {
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

  /**
   * The chain with its subject's trust marks checked. Each issuer's keys
   * come from its own chain to the same anchor, resolved within this
   * resolution (same budget, one resolution per issuer, its own marks not
   * checked); an issuer whose chain would need the subject (a self-issued
   * mark, a cycle) is `cycle`, one deeper than
   * {@link MAX_TRUST_MARK_DEPTH} is `depth`. A spent budget ends the
   * whole resolution.
   */
  async #withTrustMarks(
    chain: TrustChain,
    anchorConfiguration: EntityStatement,
    anchor: TrustAnchor,
    context: Resolution,
    frame: Frame,
  ): Promise<TrustChain> {
    const accepted: VerifiedTrustMark[] = [];
    const rejected: { trustMarkType: string; reason: string; code: string }[] =
      [];
    const ancestry = frame.ancestry.includes(chain.subject)
      ? frame.ancestry
      : [...frame.ancestry, chain.subject];
    let transient = false;
    let expiresAt = chain.expiresAt;
    for (const entry of chain.claims[0].trust_marks ?? []) {
      // When the issuer's own chain expires, so does the authority it gave
      // the mark (section 7.3): an accepted mark lives no longer.
      let issuerExpiresAt: number | undefined;
      try {
        const mark = await verifyTrustMark(entry.trust_mark, {
          subject: chain.subject,
          trustAnchor: anchorConfiguration,
          trustAnchorJwks: anchor.jwks,
          issuerKeys: async (issuer) => {
            try {
              const issuerChain = await this.#resolveIn(
                context,
                issuer,
                { trustAnchor: anchor.entityId },
                { depth: frame.depth + 1, ancestry },
                false,
              );
              // The statements' own expiry: a cached issuer chain's
              // `expiresAt` may also count the issuer's own marks.
              issuerExpiresAt = Math.min(
                ...issuerChain.claims.map((statement) => statement.exp),
              );
              return issuerChain.jwks;
            } catch (error) {
              if (!(error instanceof FederationError)) throw error;
              if (
                fatal(error) || error.code === "cycle" ||
                error.code === "depth"
              ) {
                throw error;
              }
              transient = true;
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
        const delegation = mark.claims.delegation;
        const delegationExp = typeof delegation === "string"
          ? peekStatement(delegation)?.exp
          : undefined;
        for (const exp of [mark.expiresAt, delegationExp, issuerExpiresAt]) {
          if (typeof exp === "number") expiresAt = Math.min(expiresAt, exp);
        }
      } catch (error) {
        if (!(error instanceof FederationError) || fatal(error)) throw error;
        rejected.push({
          trustMarkType: entry.trust_mark_type,
          reason: error.message,
          code: error.code,
        });
      }
    }
    const out: TrustChain = {
      ...chain,
      expiresAt,
      trustMarks: accepted,
      rejectedTrustMarks: rejected,
    };
    const frozen = jsonSnapshot(out, {
      maxBytes: 2 * 1024 * 1024,
      maxItems: 32768,
    });
    if (transient) this.#transient.add(frozen);
    return frozen;
  }
}
