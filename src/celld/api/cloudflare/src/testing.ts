// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/api/cloudflare/testing`: a stand-in for the Cloudflare API, for
 * tests and examples of code that uses `@celld/api/cloudflare`.
 *
 * ```ts
 * const fake = new FakeCloudflare();
 * const zone = fake.addZone("example.com");
 * const cf = new CloudflareClient({ fetch: fake.fetch });
 * await new DnsRecords(cf, zone.id).create({ type: "A", name: "www", content: "192.0.2.1" });
 * fake.records(zone.id); // [{ name: "www.example.com", ... }]
 * ```
 *
 * It keeps state between calls and answers in the v4 envelope, with
 * Cloudflare's error codes for the mistakes it checks; every request is in
 * `calls`. `handle` serves it over HTTP (`Deno.serve(fake.handle)`), for an
 * example's upstream. It is a model, not a copy: what it checks is listed
 * on each area, and anything else it accepts.
 *
 * @module
 */

import type { FetchLike } from "@celld/http";
import type { ApiMessage } from "./errors.ts";
import { FakeCache } from "./fake_cache.ts";
import { FakeInvestigate } from "./fake_investigate.ts";
import { FakeTunnels } from "./fake_tunnels.ts";
import { FakeTurnstile } from "./fake_turnstile.ts";
import type { DnsRecord, Zone } from "./zones.ts";

export type { FakeCache, FakePurge } from "./fake_cache.ts";
export type { FakeInvestigate } from "./fake_investigate.ts";
export type { FakeTunnels } from "./fake_tunnels.ts";
export type { ChallengeInput, FakeTurnstile } from "./fake_turnstile.ts";

/** One request as the fake received it. */
export interface FakeRequest {
  readonly method: string;
  readonly host: string;
  /** The path, without `/client/v4` for API requests. */
  readonly path: string;
  readonly query: URLSearchParams;
  /** The JSON body, or the form fields of a form body, or null. */
  readonly body: unknown;
  readonly headers: Headers;
}

/** A failure to answer instead of the model's answer. */
export interface FakeFailure {
  readonly method?: string;
  /** The API path (without `/client/v4`), whole or as a pattern. */
  readonly path: string | RegExp;
  readonly status: number;
  /** The envelope's errors; none sends `html` or an empty envelope. */
  readonly errors?: readonly ApiMessage[];
  /** Seconds, as `Retry-After`. */
  readonly retryAfter?: number;
  /** Answer with an HTML page, as a proxy in the way would. */
  readonly html?: boolean;
  /** How many requests it answers (default 1). */
  readonly times?: number;
  /**
   * Apply the request first and then fail, as an answer lost on the way
   * back would.
   */
  readonly afterApplying?: boolean;
}

/** Options of a {@link FakeCloudflare}. */
export interface FakeCloudflareOptions {
  /**
   * The only bearer token accepted. Left out, requests need none, as
   * behind an exe.dev integration.
   */
  readonly token?: string;
  /** The account the fake's objects belong to. */
  readonly accountId?: string;
  /** Milliseconds since the epoch, for timestamps. */
  readonly now?: () => number;
}

/** What a route answers. */
export interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export type Handler = (
  request: FakeRequest,
  params: readonly string[],
) => Answer | Promise<Answer>;

interface Route {
  readonly method: string;
  /** An API route (under `/client/v4`), or another host's path. */
  readonly api: boolean;
  readonly pattern: RegExp;
  readonly handler: Handler;
}

const ID = "([0-9a-f]{32})";

/** Envelope helpers the areas' handlers share. */
export const answers = {
  ok(result: unknown, resultInfo?: Record<string, unknown>): Answer {
    return {
      status: 200,
      body: {
        success: true,
        errors: [],
        messages: [],
        result,
        ...(resultInfo === undefined ? {} : { result_info: resultInfo }),
      },
    };
  },
  error(status: number, code: number, message: string): Answer {
    return {
      status,
      body: {
        success: false,
        errors: [{ code, message }],
        messages: [],
        result: null,
      },
    };
  },
  raw(status: number, body: unknown, headers?: Record<string, string>): Answer {
    return { status, body, headers };
  },
};

/** A stateful model of the Cloudflare API. */
export class FakeCloudflare {
  readonly accountId: string;
  /** Every request, in order. */
  readonly calls: FakeRequest[] = [];
  /** Pass as a client's `fetch`. */
  readonly fetch: FetchLike;
  /** Serves the fake over HTTP. */
  readonly handle: (request: Request) => Promise<Response>;
  /** Envelope helpers, for routes a test adds. */
  readonly answers = answers;
  /** Widgets, visitors' tokens and siteverify. */
  readonly turnstile: FakeTurnstile;
  /** Tunnels, their configurations and connectors. */
  readonly tunnels: FakeTunnels;
  /** Purges, Cache Rules and the tiered cache switches. */
  readonly cache: FakeCache;
  /** Intel answers and URL Scanner scans. */
  readonly investigate: FakeInvestigate;

  readonly #token?: string;
  readonly #now: () => number;
  readonly #routes: Route[] = [];
  readonly #failures: (FakeFailure & { left: number })[] = [];
  readonly #zones = new Map<string, Zone>();
  readonly #records = new Map<string, Map<string, DnsRecord>>();
  readonly #settings = new Map<string, Map<string, unknown>>();
  #serial = 0;

  constructor(options: FakeCloudflareOptions = {}) {
    this.#token = options.token;
    this.#now = options.now ?? (() => Date.now());
    this.accountId = options.accountId ?? this.newId();
    this.handle = (request) => this.#handle(request);
    this.fetch = (input, init) => this.#handle(new Request(input, init));
    this.#zonesAndDns();
    this.turnstile = new FakeTurnstile(this);
    this.tunnels = new FakeTunnels(this);
    this.cache = new FakeCache(this);
    this.investigate = new FakeInvestigate(this);
  }

  /** The fake's clock, in milliseconds since the epoch. */
  nowMs(): number {
    return this.#now();
  }

  /** One page of `items`, as a list route answers. */
  paged(
    items: readonly unknown[],
    query: URLSearchParams,
    perPageDefault: number,
    perPageMax: number,
  ): Answer {
    return paged(items, query, perPageDefault, perPageMax);
  }

  /** A fresh 32-hex id: `cf` and a counter, so a fake's ids are the same every run. */
  newId(): string {
    this.#serial++;
    return `cf${this.#serial.toString(16).padStart(30, "0")}`;
  }

  /** The current time as Cloudflare writes it. */
  timestamp(): string {
    return new Date(this.#now()).toISOString();
  }

  /**
   * Adds an API route (`{id}` matches a 32-hex id); the areas use it, and
   * a test may add one the fake lacks.
   */
  route(method: string, pattern: string, handler: Handler): void {
    this.#routes.push({
      method,
      api: true,
      pattern: new RegExp(`^${pattern.replaceAll("{id}", ID)}$`),
      handler,
    });
  }

  /** Adds a route outside the v4 API (siteverify), matched on the path alone. */
  routeOther(method: string, pattern: string, handler: Handler): void {
    this.#routes.push({
      method,
      api: false,
      pattern: new RegExp(`^${pattern}$`),
      handler,
    });
  }

  /** Fails matching requests instead of answering them. */
  failNext(failure: FakeFailure): void {
    this.#failures.push({ ...failure, left: failure.times ?? 1 });
  }

  /** Adds an active zone to the fake's account. */
  addZone(name: string, fields: Partial<Zone> = {}): Zone {
    const zone: Zone = {
      id: this.newId(),
      name,
      status: "active",
      paused: false,
      type: "full",
      development_mode: 0,
      name_servers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
      original_name_servers: null,
      account: { id: this.accountId, name: "Fake account" },
      plan: { id: "0feeeeeeeeeeeeeeeeeeeeeeeeeeeeee", name: "Free Website" },
      created_on: this.timestamp(),
      modified_on: this.timestamp(),
      activated_on: this.timestamp(),
      ...fields,
    };
    this.#zones.set(zone.id, zone);
    this.#records.set(zone.id, new Map());
    this.#settings.set(zone.id, new Map(Object.entries(DEFAULT_SETTINGS)));
    return zone;
  }

  /** The zone's records, in creation order. */
  records(zoneId: string): DnsRecord[] {
    return [...(this.#records.get(zoneId)?.values() ?? [])];
  }

  /** A zone setting's current value. */
  setting(zoneId: string, settingId: string): unknown {
    return this.#settings.get(zoneId)?.get(settingId);
  }

  /** The zone, or undefined. */
  zone(zoneId: string): Zone | undefined {
    return this.#zones.get(zoneId);
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const api = url.pathname.startsWith("/client/v4/");
    const path = api ? url.pathname.slice("/client/v4".length) : url.pathname;
    const fake: FakeRequest = {
      method: request.method,
      host: url.host,
      path,
      query: url.searchParams,
      body: await bodyOf(request),
      headers: request.headers,
    };
    this.calls.push(fake);
    const failure = this.#failure(fake);
    if (failure !== undefined && !failure.afterApplying) {
      return respond(failureAnswer(failure));
    }
    if (api && this.#token !== undefined) {
      const given = request.headers.get("authorization");
      if (given === null) {
        // What Cloudflare answers a request with no credentials at all.
        return respond({
          status: 403,
          body: {
            success: false,
            errors: [
              { code: 9106, message: "Missing X-Auth-Email header" },
              { code: 9107, message: "Missing X-Auth-Key header" },
            ],
            messages: [],
            result: null,
          },
        });
      }
      if (given !== `Bearer ${this.#token}`) {
        return respond(
          path.endsWith("/tokens/verify")
            ? answers.error(401, 1000, "Invalid API Token")
            : answers.error(401, 10000, "Authentication error"),
        );
      }
    }
    let answer: Answer | undefined;
    for (const route of this.#routes) {
      if (route.method !== request.method || route.api !== api) continue;
      const match = route.pattern.exec(path);
      if (match === null) continue;
      try {
        answer = await route.handler(fake, match.slice(1));
      } catch (error) {
        answer = answers.error(
          500,
          10001,
          `fake: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      break;
    }
    answer ??= answers.error(400, 7000, "No route for that URI");
    if (failure !== undefined) return respond(failureAnswer(failure));
    return respond(answer);
  }

  #failure(request: FakeRequest): FakeFailure | undefined {
    const index = this.#failures.findIndex((failure) =>
      (failure.method === undefined || failure.method === request.method) &&
      (typeof failure.path === "string"
        ? failure.path === request.path
        : failure.path.test(request.path))
    );
    if (index === -1) return undefined;
    const failure = this.#failures[index];
    failure.left--;
    if (failure.left <= 0) this.#failures.splice(index, 1);
    return failure;
  }

  #zonesAndDns(): void {
    const { ok, error } = answers;
    const verified = () =>
      ok({
        id: "fa4e0000000000000000000000000000",
        status: "active",
        expires_on: "2027-01-01T00:00:00Z",
      });
    this.route("GET", "/user/tokens/verify", verified);
    this.route(
      "GET",
      "/accounts/{id}/tokens/verify",
      (_request, [id]) =>
        id === this.accountId
          ? verified()
          : error(403, 9109, "Unauthorized to access requested resource"),
    );
    this.route("GET", "/accounts", (request) =>
      paged(
        [{ id: this.accountId, name: "Fake account", type: "standard" }],
        request.query,
        20,
        50,
      ));
    this.route("GET", "/zones", (request) => {
      const name = request.query.get("name");
      const status = request.query.get("status");
      const account = request.query.get("account.id");
      const zones = [...this.#zones.values()].filter((zone) =>
        (name === null || zone.name === name) &&
        (status === null || zone.status === status) &&
        (account === null || zone.account.id === account)
      );
      return paged(zones, request.query, 20, 50);
    });
    this.route("GET", "/zones/{id}", (_request, [id]) => {
      const zone = this.#zones.get(id);
      return zone === undefined
        ? error(404, 1001, "Invalid zone identifier")
        : ok(zone);
    });
    this.route("POST", "/zones", (request) => {
      const body = request.body as {
        name?: string;
        account?: { id?: string };
        type?: string;
      };
      if (typeof body?.name !== "string") {
        return error(400, 1002, "Invalid or missing zone name");
      }
      if (body.account?.id !== this.accountId) {
        return error(403, 1068, "Permission denied to this account");
      }
      if ([...this.#zones.values()].some((zone) => zone.name === body.name)) {
        return error(400, 1061, `${body.name} already exists`);
      }
      return ok(
        this.addZone(body.name, {
          status: "pending",
          activated_on: null,
          type: body.type ?? "full",
        }),
      );
    });
    this.route("PATCH", "/zones/{id}", (request, [id]) => {
      const zone = this.#zones.get(id);
      if (zone === undefined) {
        return error(404, 1001, "Invalid zone identifier");
      }
      const edited = {
        ...zone,
        ...(request.body as Partial<Zone>),
        id: zone.id,
        modified_on: this.timestamp(),
      };
      this.#zones.set(id, edited);
      return ok(edited);
    });
    this.route("DELETE", "/zones/{id}", (_request, [id]) => {
      if (!this.#zones.delete(id)) {
        return error(404, 1001, "Invalid zone identifier");
      }
      this.#records.delete(id);
      this.#settings.delete(id);
      return ok({ id });
    });
    this.route(
      "PUT",
      "/zones/{id}/activation_check",
      (_request, [id]) =>
        this.#zones.has(id)
          ? ok({ id })
          : error(404, 1001, "Invalid zone identifier"),
    );

    this.route("GET", "/zones/{id}/settings/([a-z0-9_]+)", (_r, [id, key]) => {
      const settings = this.#settings.get(id);
      if (settings === undefined) {
        return error(404, 1001, "Invalid zone identifier");
      }
      if (!settings.has(key)) return error(400, 1003, `Invalid setting ${key}`);
      return ok(this.#settingOf(id, key));
    });
    this.route(
      "PATCH",
      "/zones/{id}/settings/([a-z0-9_]+)",
      (request, [id, key]) => {
        const settings = this.#settings.get(id);
        if (settings === undefined) {
          return error(404, 1001, "Invalid zone identifier");
        }
        if (!settings.has(key)) {
          return error(
            400,
            1003,
            `Invalid setting ${key}`,
          );
        }
        const value = (request.body as { value?: unknown })?.value;
        const allowed = SETTING_VALUES[key];
        if (value === undefined || (allowed && !allowed.includes(value))) {
          return error(400, 1007, `Invalid value for zone setting ${key}`);
        }
        settings.set(key, value);
        return ok(this.#settingOf(id, key));
      },
    );

    const records = (id: string) => this.#records.get(id);
    this.route("GET", "/zones/{id}/dns_records", (request, [id]) => {
      const zone = records(id);
      if (zone === undefined) {
        return error(404, 1001, "Invalid zone identifier");
      }
      const q = request.query;
      const matches = (field: string, value: string | undefined) => {
        const exact = q.get(`${field}.exact`) ?? q.get(field);
        const contains = q.get(`${field}.contains`);
        const starts = q.get(`${field}.startswith`);
        const ends = q.get(`${field}.endswith`);
        const text = (value ?? "").toLowerCase();
        return (exact === null || text === exact.toLowerCase()) &&
          (contains === null || text.includes(contains.toLowerCase())) &&
          (starts === null || text.startsWith(starts.toLowerCase())) &&
          (ends === null || text.endsWith(ends.toLowerCase()));
      };
      const tags = q.getAll("tag");
      const proxied = q.get("proxied");
      const list = [...zone.values()].filter((record) =>
        (q.get("type") === null || record.type === q.get("type")) &&
        matches("name", record.name) &&
        matches("content", record.content) &&
        matches("comment", record.comment ?? undefined) &&
        (proxied === null || String(record.proxied ?? false) === proxied) &&
        tags.every((tag) =>
          (record.tags ?? []).some((have) =>
            have === tag || have.startsWith(`${tag}:`)
          )
        )
      );
      return paged(list, q, 100, 5_000_000);
    });
    this.route("GET", "/zones/{id}/dns_records/export", (_request, [id]) => {
      const zone = this.#zones.get(id);
      if (zone === undefined) {
        return error(404, 1001, "Invalid zone identifier");
      }
      const lines = [`;; Domain: ${zone.name}.`, `$ORIGIN ${zone.name}.`];
      for (const record of records(id)!.values()) {
        const value = record.type === "MX"
          ? `${record.priority} ${record.content}.`
          : record.type === "TXT"
          ? JSON.stringify(record.content)
          : record.content;
        lines.push(
          `${record.name}.\t${
            record.ttl === 1 ? 300 : record.ttl
          }\tIN\t${record.type}\t${value}`,
        );
      }
      return {
        status: 200,
        body: lines.join("\n") + "\n",
        headers: { "content-type": "text/plain" },
      };
    });
    this.route("GET", "/zones/{id}/dns_records/{id}", (_request, [id, rid]) => {
      const record = records(id)?.get(rid);
      return record === undefined
        ? error(404, 81044, "Record does not exist.")
        : ok(record);
    });
    this.route("POST", "/zones/{id}/dns_records", (request, [id]) => {
      const zone = this.#zones.get(id);
      if (zone === undefined) {
        return error(404, 1001, "Invalid zone identifier");
      }
      const made = this.#dnsCreate(zone, request.body, null);
      return "error" in made ? made.error : ok(made.record);
    });
    for (const method of ["PUT", "PATCH"]) {
      this.route(
        method,
        "/zones/{id}/dns_records/{id}",
        (request, [id, rid]) => {
          const zone = this.#zones.get(id);
          const old = records(id)?.get(rid);
          if (zone === undefined || old === undefined) {
            return error(404, 81044, "Record does not exist.");
          }
          const input = method === "PATCH"
            ? { ...old, ...(request.body as object) }
            : request.body;
          const made = this.#dnsCreate(zone, input, old);
          return "error" in made ? made.error : ok(made.record);
        },
      );
    }
    this.route(
      "DELETE",
      "/zones/{id}/dns_records/{id}",
      (_request, [id, rid]) =>
        records(id)?.delete(rid)
          ? ok({ id: rid })
          : error(404, 81044, "Record does not exist."),
    );
    this.route("POST", "/zones/{id}/dns_records/batch", (request, [id]) => {
      const zone = this.#zones.get(id);
      const current = records(id);
      if (zone === undefined || current === undefined) {
        return error(404, 1001, "Invalid zone identifier");
      }
      const body = (request.body ?? {}) as {
        deletes?: { id: string }[];
        patches?: ({ id: string } & object)[];
        puts?: ({ id: string } & object)[];
        posts?: object[];
      };
      // All or nothing: work on a copy and keep it only when every step passes.
      const saved = new Map(current);
      const result: Record<string, DnsRecord[]> = {};
      const fail = (answer: Answer) => {
        this.#records.set(id, saved);
        return answer;
      };
      for (const { id: rid } of body.deletes ?? []) {
        const old = current.get(rid);
        if (old === undefined) {
          return fail(error(404, 81044, `Record ${rid} does not exist.`));
        }
        current.delete(rid);
        (result.deletes ??= []).push(old);
      }
      for (const kind of ["patches", "puts"] as const) {
        for (const item of body[kind] ?? []) {
          const old = current.get(item.id);
          if (old === undefined) {
            return fail(error(404, 81044, `Record ${item.id} does not exist.`));
          }
          const made = this.#dnsCreate(
            zone,
            kind === "patches" ? { ...old, ...item } : item,
            old,
          );
          if ("error" in made) return fail(made.error);
          (result[kind] ??= []).push(made.record);
        }
      }
      for (const item of body.posts ?? []) {
        const made = this.#dnsCreate(zone, item, null);
        if ("error" in made) return fail(made.error);
        (result.posts ??= []).push(made.record);
      }
      return ok(result);
    });
  }

  /**
   * Creates (or replaces `old` with) a record in `zone`, with the checks
   * Cloudflare makes: a name inside the zone, an identical record refused,
   * a CNAME alone at its name.
   */
  #dnsCreate(
    zone: Zone,
    input: unknown,
    old: DnsRecord | null,
  ): { record: DnsRecord } | { error: Answer } {
    const { error } = answers;
    const body = (input ?? {}) as Partial<DnsRecord>;
    if (typeof body.type !== "string") {
      return { error: error(400, 9000, "DNS record type is invalid.") };
    }
    if (typeof body.name !== "string" || body.name === "") {
      return { error: error(400, 9005, "DNS name is invalid.") };
    }
    const name = qualify(body.name, zone.name);
    if (name === null) {
      return {
        error: error(400, 9005, `${body.name} is not inside ${zone.name}.`),
      };
    }
    const zoneRecords = this.#records.get(zone.id)!;
    const others = [...zoneRecords.values()].filter((record) =>
      record.id !== old?.id && record.name === name
    );
    if (
      others.some((record) =>
        record.type === body.type && record.content === body.content &&
        JSON.stringify(record.data) === JSON.stringify(body.data)
      )
    ) {
      return {
        error: error(400, 81058, "An identical record already exists."),
      };
    }
    if (
      (body.type === "CNAME" && others.length > 0) ||
      others.some((record) => record.type === "CNAME")
    ) {
      return {
        error: error(
          400,
          81053,
          "An A, AAAA, or CNAME record with that host already exists.",
        ),
      };
    }
    const proxiable = ["A", "AAAA", "CNAME"].includes(body.type);
    if (body.proxied && !proxiable) {
      return {
        error: error(400, 9004, `A ${body.type} record cannot be proxied.`),
      };
    }
    const record: DnsRecord = {
      ...body,
      id: old?.id ?? this.newId(),
      name,
      type: body.type,
      ttl: body.ttl ?? 1,
      proxiable,
      proxied: body.proxied ?? false,
      comment: body.comment ?? null,
      tags: body.tags ?? [],
      created_on: old?.created_on ?? this.timestamp(),
      modified_on: this.timestamp(),
    };
    zoneRecords.set(record.id, record);
    return { record };
  }

  #settingOf(zoneId: string, key: string) {
    return {
      id: key,
      value: this.#settings.get(zoneId)!.get(key),
      editable: true,
      modified_on: this.timestamp(),
    };
  }
}

/** Cloudflare's defaults for the settings the fake knows. */
const DEFAULT_SETTINGS: Readonly<Record<string, unknown>> = {
  always_online: "on",
  always_use_https: "off",
  automatic_https_rewrites: "on",
  browser_cache_ttl: 14400,
  cache_level: "aggressive",
  edge_cache_ttl: 7200,
  origin_error_page_pass_thru: "off",
  development_mode: "off",
  min_tls_version: "1.0",
  sort_query_string_for_cache: "off",
  ssl: "flexible",
  tls_1_3: "on",
};

/** The values the fake accepts for a setting, where it checks. */
const SETTING_VALUES: Readonly<Record<string, readonly unknown[]>> = {
  always_online: ["on", "off"],
  always_use_https: ["on", "off"],
  automatic_https_rewrites: ["on", "off"],
  cache_level: ["basic", "simplified", "aggressive"],
  edge_cache_ttl: [
    30,
    60,
    300,
    1200,
    1800,
    3600,
    7200,
    10800,
    14400,
    18000,
    28800,
    43200,
    57600,
    72000,
    86400,
    172800,
    259200,
    345600,
    432000,
    518400,
    604800,
  ],
  origin_error_page_pass_thru: ["on", "off"],
  development_mode: ["on", "off"],
  min_tls_version: ["1.0", "1.1", "1.2", "1.3"],
  sort_query_string_for_cache: ["on", "off"],
  ssl: ["off", "flexible", "full", "strict"],
  tls_1_3: ["on", "off", "zrt"],
};

/**
 * `name` as a full name inside `zone`: `@` is the apex, and a name that
 * does not end in the zone is relative to it, as Cloudflare reads it.
 */
function qualify(name: string, zone: string): string | null {
  const lower = name.toLowerCase().replace(/\.$/, "");
  if (lower === "" || /[\s/]/.test(lower)) return null;
  if (lower === "@" || lower === zone) return zone;
  return lower.endsWith(`.${zone}`) ? lower : `${lower}.${zone}`;
}

/** One page of `items` as `page` and `per_page` ask. */
export function paged(
  items: readonly unknown[],
  query: URLSearchParams,
  perPageDefault: number,
  perPageMax: number,
): Answer {
  const page = Math.max(1, Number(query.get("page") ?? "1") || 1);
  const asked = Number(query.get("per_page") ?? perPageDefault) ||
    perPageDefault;
  const perPage = Math.min(Math.max(1, asked), perPageMax);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  return answers.ok(slice, {
    page,
    per_page: perPage,
    count: slice.length,
    total_count: items.length,
    total_pages: Math.max(1, Math.ceil(items.length / perPage)),
  });
}

async function bodyOf(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text === "") return null;
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function failureAnswer(failure: FakeFailure): Answer {
  const headers: Record<string, string> = {};
  if (failure.retryAfter !== undefined) {
    headers["retry-after"] = String(failure.retryAfter);
  }
  if (failure.html) {
    return {
      status: failure.status,
      body: `<html><body>${failure.status}</body></html>`,
      headers: { ...headers, "content-type": "text/html" },
    };
  }
  return {
    status: failure.status,
    body: {
      success: false,
      errors: failure.errors ?? [],
      messages: [],
      result: null,
    },
    headers,
  };
}

function respond(answer: Answer): Response {
  const headers = new Headers(answer.headers);
  headers.set("cf-ray", "0000000000000000-FAK");
  if (typeof answer.body === "string") {
    if (!headers.has("content-type")) headers.set("content-type", "text/plain");
    return new Response(answer.body, { status: answer.status, headers });
  }
  if (answer.body instanceof Uint8Array) {
    return new Response(answer.body as Uint8Array<ArrayBuffer>, {
      status: answer.status,
      headers,
    });
  }
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(answer.body), {
    status: answer.status,
    headers,
  });
}
