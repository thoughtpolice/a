// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The fake's cache: purges it records (it caches nothing), the Cache
 * Rules entrypoint, and the Tiered Cache and Cache Reserve switches. See
 * `FakeCloudflare.cache`.
 *
 * A purge must name one kind (everything, files, tags, hosts or
 * prefixes) with at most `purgeLimit` items. The Cache Rules entrypoint
 * answers 404 until one is set, as Cloudflare's does.
 *
 * @module
 */

import type { CacheRule, CacheRuleset } from "./cache.ts";
import type { FakeCloudflare } from "./testing.ts";

/** One purge request the fake accepted. */
export interface FakePurge {
  readonly zoneId: string;
  readonly id: string;
  readonly body: Readonly<Record<string, unknown>>;
}

const KINDS = ["purge_everything", "files", "tags", "hosts", "prefixes"];

export class FakeCache {
  readonly #fake: FakeCloudflare;
  /** Every purge, in order. */
  readonly purges: FakePurge[] = [];
  /** Items one purge may name: Cloudflare's 100 (500 URLs on Enterprise). */
  purgeLimit = 100;
  readonly #rulesets = new Map<string, CacheRuleset>();
  readonly #switches = new Map<string, "on" | "off">();

  constructor(fake: FakeCloudflare) {
    this.#fake = fake;
    this.#routes();
  }

  /** The zone's Cache Rules, or undefined before any are set. */
  rules(zoneId: string): readonly CacheRule[] | undefined {
    return this.#rulesets.get(zoneId)?.rules;
  }

  #routes(): void {
    const fake = this.#fake;
    const { ok, error } = fake.answers;
    const missing = () => error(404, 1001, "Invalid zone identifier");
    fake.route("POST", "/zones/{id}/purge_cache", (request, [zoneId]) => {
      if (fake.zone(zoneId) === undefined) return missing();
      const body = (request.body ?? {}) as Record<string, unknown>;
      const kinds = Object.keys(body).filter((key) => KINDS.includes(key));
      if (kinds.length !== 1 || Object.keys(body).length !== 1) {
        return error(
          400,
          1015,
          "Purge one of everything, files, tags, hosts or prefixes",
        );
      }
      const items = body[kinds[0]];
      if (kinds[0] === "purge_everything") {
        if (items !== true) {
          return error(400, 1015, "purge_everything must be true");
        }
      } else if (!Array.isArray(items) || items.length === 0) {
        return error(400, 1015, `${kinds[0]} must be a non-empty list`);
      } else if (items.length > this.purgeLimit) {
        return error(
          400,
          1134,
          `A purge may name at most ${this.purgeLimit} items`,
        );
      }
      const id = fake.newId();
      this.purges.push({ zoneId, id, body });
      return ok({ id });
    });

    const entrypoint =
      "/zones/{id}/rulesets/phases/http_request_cache_settings/entrypoint";
    fake.route("GET", entrypoint, (_request, [zoneId]) => {
      if (fake.zone(zoneId) === undefined) return missing();
      const ruleset = this.#rulesets.get(zoneId);
      return ruleset === undefined
        ? error(
          404,
          10003,
          "could not find entrypoint ruleset in the http_request_cache_settings phase",
        )
        : ok(ruleset);
    });
    fake.route("PUT", entrypoint, (request, [zoneId]) => {
      if (fake.zone(zoneId) === undefined) return missing();
      const rules = (request.body as { rules?: unknown } | null)?.rules;
      if (!Array.isArray(rules)) {
        return error(400, 20021, "rules must be a list");
      }
      for (const rule of rules as Record<string, unknown>[]) {
        if (rule?.action !== "set_cache_settings") {
          return error(
            400,
            20120,
            "a rule in the http_request_cache_settings phase must set cache settings",
          );
        }
        if (typeof rule.expression !== "string" || rule.expression === "") {
          return error(400, 20019, "a rule needs an expression");
        }
      }
      const previous = this.#rulesets.get(zoneId);
      const version = String(Number(previous?.version ?? "0") + 1);
      const ruleset: CacheRuleset = {
        id: previous?.id ?? fake.newId(),
        name: "default",
        kind: "zone",
        phase: "http_request_cache_settings",
        version,
        rules: (rules as Record<string, unknown>[]).map((rule) =>
          ({
            ...rule,
            id: typeof rule.id === "string" ? rule.id : fake.newId(),
            version,
            last_updated: fake.timestamp(),
          }) as unknown as CacheRule
        ),
        last_updated: fake.timestamp(),
      };
      this.#rulesets.set(zoneId, ruleset);
      return ok(ruleset);
    });

    fake.route(
      "POST",
      "/zones/{id}/rulesets/{id}/rules",
      (request, [zoneId, rulesetId]) => {
        const ruleset = this.#rulesets.get(zoneId);
        if (ruleset === undefined || ruleset.id !== rulesetId) {
          return error(404, 10003, "ruleset not found");
        }
        const rule = request.body as Record<string, unknown> | null;
        if (
          rule?.action !== "set_cache_settings" ||
          typeof rule.expression !== "string"
        ) {
          return error(
            400,
            20120,
            "a cache rule needs set_cache_settings and an expression",
          );
        }
        const version = String(Number(ruleset.version ?? "0") + 1);
        const updated: CacheRuleset = {
          ...ruleset,
          version,
          rules: [
            ...ruleset.rules,
            {
              ...rule,
              id: fake.newId(),
              version,
              last_updated: fake.timestamp(),
            } as unknown as CacheRule,
          ],
        };
        this.#rulesets.set(zoneId, updated);
        return ok(updated);
      },
    );
    fake.route(
      "DELETE",
      "/zones/{id}/rulesets/{id}/rules/{id}",
      (_request, [zoneId, rulesetId, ruleId]) => {
        const ruleset = this.#rulesets.get(zoneId);
        if (ruleset === undefined || ruleset.id !== rulesetId) {
          return error(404, 10003, "ruleset not found");
        }
        if (!ruleset.rules.some((rule) => rule.id === ruleId)) {
          return error(404, 10004, "rule not found");
        }
        const updated: CacheRuleset = {
          ...ruleset,
          version: String(Number(ruleset.version ?? "0") + 1),
          rules: ruleset.rules.filter((rule) => rule.id !== ruleId),
        };
        this.#rulesets.set(zoneId, updated);
        return ok(updated);
      },
    );

    const toggles: Record<string, string> = {
      tiered_caching: "/zones/{id}/argo/tiered_caching",
      tiered_cache_smart_topology_enable:
        "/zones/{id}/cache/tiered_cache_smart_topology_enable",
      cache_reserve: "/zones/{id}/cache/cache_reserve",
    };
    for (const [name, path] of Object.entries(toggles)) {
      const answer = (zoneId: string) =>
        ok({
          id: name,
          value: this.#switches.get(`${zoneId}/${name}`) ?? "off",
          editable: true,
          modified_on: fake.timestamp(),
        });
      fake.route(
        "GET",
        path,
        (_request, [zoneId]) =>
          fake.zone(zoneId) === undefined ? missing() : answer(zoneId),
      );
      fake.route("PATCH", path, (request, [zoneId]) => {
        if (fake.zone(zoneId) === undefined) return missing();
        const value = (request.body as { value?: unknown } | null)?.value;
        if (value !== "on" && value !== "off") {
          return error(400, 1007, `Invalid value for ${name}`);
        }
        this.#switches.set(`${zoneId}/${name}`, value);
        return answer(zoneId);
      });
    }
  }
}
