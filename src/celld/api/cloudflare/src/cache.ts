// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/api/cloudflare/cache`: a zone's CDN cache: purging it, the
 * cache settings, Cache Rules, Tiered Cache and Cache Reserve.
 *
 * ```ts
 * const cache = new Cache(cf, zoneId);
 * await cache.purge({ files: ["https://example.com/app.js"] });
 * await cache.purge({ tags: ["product-42"] });
 * await cache.addRule({
 *   description: "cache the API's GETs for a minute",
 *   expression: 'http.host eq "api.example.com" and http.request.method eq "GET"',
 *   action_parameters: { cache: true, edge_ttl: { mode: "override_origin", default: 60 } },
 * });
 * ```
 *
 * A purge's 200 means Cloudflare took the request, not that the objects
 * are gone; `CF-Cache-Status` stops saying `HIT` once they are. A URL
 * purge misses objects cached by a Cache Rule that matches only `GET`
 * (add `http.request.method eq "PURGE"` to it).
 *
 * @module
 */

import type { CloudflareClient, RequestOptions } from "./client.ts";
import { CloudflareError } from "./errors.ts";
import { cloudflareId } from "./ids.ts";
import { zonePath, type ZoneSetting, ZoneSettings } from "./zones.ts";

type Call = Omit<RequestOptions, "body" | "query">;

/** A URL to purge, with the headers its cache key varies on. */
export interface PurgeFile {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** What to purge: one kind per request, as Cloudflare takes it. */
export type PurgeRequest =
  | { readonly everything: true }
  | { readonly files: readonly (string | PurgeFile)[] }
  | { readonly tags: readonly string[] }
  | { readonly hosts: readonly string[] }
  /** `example.com/assets/` without a scheme, query or fragment. */
  | { readonly prefixes: readonly string[] };

/** Options of {@link Cache}. */
export interface CacheOptions {
  /**
   * Items per purge request; longer lists go in several requests.
   * Default 100, what every plan takes (Enterprise takes 500 URLs).
   */
  readonly purgeBatchSize?: number;
}

/** The cache settings that are zone settings, with their values. */
export interface CacheSettingValues {
  /**
   * `aggressive` (the dashboard's Standard, the default), `basic` (No
   * Query String) or `simplified` (Ignore Query String).
   */
  readonly cache_level: "basic" | "simplified" | "aggressive";
  /** Seconds, up to a year; 0 respects the origin's headers. */
  readonly browser_cache_ttl: number;
  /** Seconds, from a fixed list (30, 60, 300, ... 604800); plans set a minimum. */
  readonly edge_cache_ttl: number;
  /** Bypasses the cache for three hours, then turns itself off. */
  readonly development_mode: "on" | "off";
  readonly always_online: "on" | "off";
  readonly sort_query_string_for_cache: "on" | "off";
  readonly origin_error_page_pass_thru: "on" | "off";
}

/** How long the edge keeps a response. */
export interface EdgeTtl {
  readonly mode: "respect_origin" | "override_origin" | "bypass_by_default";
  /** Seconds, with `override_origin`. */
  readonly default?: number;
  readonly status_code_ttl?: readonly {
    readonly status_code?: number;
    readonly status_code_range?: {
      readonly from?: number;
      readonly to?: number;
    };
    readonly value: number;
  }[];
}

/** What a Cache Rule sets (`set_cache_settings`). */
export interface CacheRuleParameters {
  /** Whether matching requests are eligible for caching at all. */
  readonly cache?: boolean;
  readonly edge_ttl?: EdgeTtl;
  readonly browser_ttl?: {
    readonly mode:
      | "respect_origin"
      | "override_origin"
      | "bypass_by_default"
      | "bypass";
    readonly default?: number;
  };
  readonly cache_key?: Readonly<Record<string, unknown>>;
  readonly serve_stale?: { readonly disable_stale_while_updating?: boolean };
  readonly respect_strong_etags?: boolean;
  readonly origin_error_page_passthru?: boolean;
  readonly cache_reserve?: {
    readonly eligible: boolean;
    readonly minimum_file_size?: number;
  };
  readonly [parameter: string]: unknown;
}

/** A Cache Rule to set. */
export interface CacheRuleInput {
  /** An existing rule's id, to keep its identity when replacing the list. */
  readonly id?: string;
  /** A stable name of your own for the rule. */
  readonly ref?: string;
  readonly description?: string;
  /** A Rules language expression over the request. */
  readonly expression: string;
  readonly action_parameters: CacheRuleParameters;
  readonly enabled?: boolean;
}

/** A Cache Rule as Cloudflare stores it. */
export interface CacheRule extends CacheRuleInput {
  readonly id: string;
  readonly action: "set_cache_settings";
  readonly version?: string;
  readonly last_updated?: string;
  readonly [field: string]: unknown;
}

/** The zone's Cache Rules phase entrypoint. */
export interface CacheRuleset {
  readonly id: string;
  readonly phase: "http_request_cache_settings";
  readonly rules: readonly CacheRule[];
  readonly version?: string;
  readonly [field: string]: unknown;
}

export const CACHE_RULES_PHASE = "http_request_cache_settings";
const DEFAULT_PURGE_BATCH = 100;
const MAX_BROWSER_TTL = 31_536_000;
const HOST =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9-]{2,63}$/;

/** One zone's cache. */
export class Cache {
  readonly #client: CloudflareClient;
  readonly zoneId: string;
  readonly #batch: number;
  readonly #settings: ZoneSettings;

  constructor(
    client: CloudflareClient,
    zoneId: string,
    options: CacheOptions = {},
  ) {
    this.#client = client;
    this.zoneId = cloudflareId(zoneId, "zoneId");
    const batch = options.purgeBatchSize ?? DEFAULT_PURGE_BATCH;
    if (!Number.isSafeInteger(batch) || batch < 1 || batch > 10_000) {
      throw new RangeError("purgeBatchSize must be an integer from 1 to 10000");
    }
    this.#batch = batch;
    this.#settings = new ZoneSettings(client, this.zoneId);
  }

  /**
   * Purges what `request` names, in as many requests as the batch size
   * needs; the ids Cloudflare gave the requests. Purging twice purges
   * once, so failed requests are retried; a rate-limited one (Free zones
   * may purge by tag, host or prefix 5 times a minute) waits as asked.
   */
  async purge(request: PurgeRequest, options?: Call): Promise<string[]> {
    const path = `${zonePath(this.zoneId)}/purge_cache`;
    const ids: string[] = [];
    const send = async (body: Record<string, unknown>) => {
      const result = await this.#client.result<{ id?: unknown } | null>(
        "POST",
        path,
        { ...options, body, idempotent: true },
      );
      if (typeof result?.id === "string") ids.push(result.id);
    };
    if ("everything" in request) {
      if (request.everything !== true) {
        throw new TypeError("everything must be true");
      }
      await send({ purge_everything: true });
      return ids;
    }
    const [kind, items] = purgeItems(request);
    for (let start = 0; start < items.length; start += this.#batch) {
      await send({ [kind]: items.slice(start, start + this.#batch) });
    }
    return ids;
  }

  /** A cache setting. */
  async setting<K extends keyof CacheSettingValues>(
    key: K,
    options?: Call,
  ): Promise<ZoneSetting<CacheSettingValues[K]>> {
    return await this.#settings.get<CacheSettingValues[K]>(key, options);
  }

  /** Changes a cache setting. */
  async set<K extends keyof CacheSettingValues>(
    key: K,
    value: CacheSettingValues[K],
    options?: Call,
  ): Promise<ZoneSetting<CacheSettingValues[K]>> {
    if (
      key === "browser_cache_ttl" &&
      (!Number.isSafeInteger(value) || (value as number) < 0 ||
        (value as number) > MAX_BROWSER_TTL)
    ) {
      throw new RangeError(
        `browser_cache_ttl must be whole seconds from 0 to ${MAX_BROWSER_TTL}`,
      );
    }
    return await this.#settings.set(key, value, options);
  }

  /** The zone's Cache Rules, in order; none when it has no entrypoint yet. */
  async rules(options?: Call): Promise<CacheRule[]> {
    return [...((await this.#ruleset(options))?.rules ?? [])];
  }

  /**
   * Replaces the zone's Cache Rules with `rules`, in order (a later rule
   * overrides an earlier one's settings where both match). This replaces
   * every rule of the phase, those other tools (Terraform, the dashboard)
   * made included; pass an existing rule's `id` to keep it. To change one
   * rule, use {@link addRule} and {@link deleteRule}.
   */
  async setRules(
    rules: readonly CacheRuleInput[],
    options?: Call,
  ): Promise<CacheRuleset> {
    const body = { rules: rules.map((rule, index) => ruleBody(rule, index)) };
    return checkRuleset(
      await this.#client.result("PUT", this.#entrypoint, { ...options, body }),
    );
  }

  /**
   * Adds one rule at the end, leaving the others alone; creates the
   * entrypoint when the zone has none. Returns the new rule.
   */
  async addRule(rule: CacheRuleInput, options?: Call): Promise<CacheRule> {
    const body = ruleBody(rule, 0);
    const current = await this.#ruleset(options);
    const ruleset = current === null
      ? checkRuleset(
        await this.#client.result("PUT", this.#entrypoint, {
          ...options,
          body: { rules: [body] },
        }),
      )
      : checkRuleset(
        await this.#client.result(
          "POST",
          `${zonePath(this.zoneId)}/rulesets/${
            cloudflareId(current.id, "ruleset id")
          }/rules`,
          { ...options, body },
        ),
      );
    const added = ruleset.rules[ruleset.rules.length - 1];
    if (added === undefined) {
      throw new CloudflareError(
        "response",
        "the ruleset came back without the rule",
      );
    }
    return added;
  }

  /** Removes one rule by id, leaving the others alone. */
  async deleteRule(ruleId: string, options?: Call): Promise<void> {
    const current = await this.#ruleset(options);
    if (current === null) {
      throw new CloudflareError("response", "the zone has no Cache Rules", {
        status: 404,
      });
    }
    await this.#client.result(
      "DELETE",
      `${zonePath(this.zoneId)}/rulesets/${
        cloudflareId(current.id, "ruleset id")
      }/rules/${cloudflareId(ruleId, "ruleId")}`,
      options,
    );
  }

  async #ruleset(options?: Call): Promise<CacheRuleset | null> {
    try {
      return checkRuleset(
        await this.#client.result("GET", this.#entrypoint, options),
      );
    } catch (error) {
      if (error instanceof CloudflareError && error.status === 404) return null;
      throw error;
    }
  }

  /** Tiered Cache: `on` sends cache misses through upper-tier data centers. */
  async tieredCaching(options?: Call): Promise<"on" | "off"> {
    return onOff(
      await this.#client.result(
        "GET",
        `${zonePath(this.zoneId)}/argo/tiered_caching`,
        options,
      ),
    );
  }

  async setTieredCaching(
    value: "on" | "off",
    options?: Call,
  ): Promise<"on" | "off"> {
    return onOff(
      await this.#client.result(
        "PATCH",
        `${zonePath(this.zoneId)}/argo/tiered_caching`,
        { ...options, body: { value: checkOnOff(value) }, idempotent: true },
      ),
    );
  }

  /** Smart Tiered Cache topology, which Cloudflare picks the upper tiers for. */
  async smartTopology(options?: Call): Promise<"on" | "off"> {
    return onOff(
      await this.#client.result(
        "GET",
        `${zonePath(this.zoneId)}/cache/tiered_cache_smart_topology_enable`,
        options,
      ),
    );
  }

  async setSmartTopology(
    value: "on" | "off",
    options?: Call,
  ): Promise<"on" | "off"> {
    return onOff(
      await this.#client.result(
        "PATCH",
        `${zonePath(this.zoneId)}/cache/tiered_cache_smart_topology_enable`,
        { ...options, body: { value: checkOnOff(value) }, idempotent: true },
      ),
    );
  }

  /** Cache Reserve: a persistent cache tier in R2 (a paid add-on). */
  async cacheReserve(options?: Call): Promise<"on" | "off"> {
    return onOff(
      await this.#client.result(
        "GET",
        `${zonePath(this.zoneId)}/cache/cache_reserve`,
        options,
      ),
    );
  }

  async setCacheReserve(
    value: "on" | "off",
    options?: Call,
  ): Promise<"on" | "off"> {
    return onOff(
      await this.#client.result(
        "PATCH",
        `${zonePath(this.zoneId)}/cache/cache_reserve`,
        { ...options, body: { value: checkOnOff(value) }, idempotent: true },
      ),
    );
  }

  get #entrypoint(): string {
    return `${
      zonePath(this.zoneId)
    }/rulesets/phases/${CACHE_RULES_PHASE}/entrypoint`;
  }
}

function purgeItems(request: PurgeRequest): [string, unknown[]] {
  const entries = Object.entries(request);
  if (entries.length !== 1) {
    throw new TypeError(
      "purge one kind at a time: everything, files, tags, hosts or prefixes",
    );
  }
  const [kind, items] = entries[0] as [string, unknown];
  if (!Array.isArray(items) || items.length === 0) {
    throw new TypeError(`${kind} must be a non-empty list`);
  }
  switch (kind) {
    case "files":
      return [kind, items.map((item, index) => purgeFile(item, index))];
    case "tags":
      return [
        kind,
        items.map((tag, index) => {
          if (
            typeof tag !== "string" || tag === "" || tag.length > 1024 ||
            /[\s,]/.test(tag)
          ) {
            throw new TypeError(
              `tags[${index}] must be 1 to 1024 characters without spaces or commas`,
            );
          }
          return tag;
        }),
      ];
    case "hosts":
      return [
        kind,
        items.map((host, index) => {
          if (typeof host !== "string" || !HOST.test(host)) {
            throw new TypeError(`hosts[${index}] must be a hostname`);
          }
          return host.toLowerCase();
        }),
      ];
    case "prefixes":
      return [
        kind,
        items.map((prefix, index) => {
          if (
            typeof prefix !== "string" || /^[a-z]+:\/\//i.test(prefix) ||
            /[?#]/.test(prefix) || !HOST.test(prefix.split("/")[0]) ||
            prefix.split("/").length - 1 > 31
          ) {
            throw new TypeError(
              `prefixes[${index}] must be a host and path without a scheme, query or fragment (31 slashes at most), such as example.com/assets/`,
            );
          }
          return prefix;
        }),
      ];
    default:
      throw new TypeError(`cannot purge by ${kind}`);
  }
}

function purgeFile(item: unknown, index: number): string | PurgeFile {
  const url = typeof item === "string" ? item : (item as PurgeFile)?.url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(`files[${index}] must be an absolute URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(`files[${index}] must be an http(s) URL`);
  }
  return typeof item === "string" ? url : {
    url,
    ...((item as PurgeFile).headers
      ? { headers: (item as PurgeFile).headers }
      : {}),
  };
}

function ruleBody(
  rule: CacheRuleInput,
  index: number,
): Record<string, unknown> {
  if (typeof rule?.expression !== "string" || rule.expression.trim() === "") {
    throw new TypeError(`rules[${index}].expression is empty`);
  }
  if (
    rule.action_parameters === null ||
    typeof rule.action_parameters !== "object"
  ) {
    throw new TypeError(`rules[${index}].action_parameters is missing`);
  }
  return {
    ...(rule.id === undefined ? {} : { id: cloudflareId(rule.id, "rule id") }),
    ...(rule.ref === undefined ? {} : { ref: rule.ref }),
    action: "set_cache_settings",
    expression: rule.expression,
    action_parameters: rule.action_parameters,
    ...(rule.description === undefined
      ? {}
      : { description: rule.description }),
    enabled: rule.enabled ?? true,
  };
}

function checkRuleset(value: unknown): CacheRuleset {
  if (
    value === null || typeof value !== "object" ||
    typeof (value as CacheRuleset).id !== "string" ||
    !Array.isArray((value as CacheRuleset).rules ?? [])
  ) {
    throw new CloudflareError("response", "a ruleset without an id and rules");
  }
  const ruleset = value as CacheRuleset;
  return { ...ruleset, rules: ruleset.rules ?? [] };
}

function onOff(value: unknown): "on" | "off" {
  const setting = (value as { value?: unknown } | null)?.value;
  if (setting !== "on" && setting !== "off") {
    throw new CloudflareError(
      "response",
      "a setting that is neither on nor off",
    );
  }
  return setting;
}

function checkOnOff(value: unknown): "on" | "off" {
  if (value !== "on" && value !== "off") {
    throw new TypeError(`value must be "on" or "off"`);
  }
  return value;
}
