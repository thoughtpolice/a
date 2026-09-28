// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/api/cloudflare/zones`: zones, their settings, and DNS records.
 *
 * ```ts
 * const zones = new Zones(cf);
 * const zone = await zones.byName("example.com");
 * const dns = new DnsRecords(cf, zone.id);
 * await dns.upsert({ type: "TXT", name: "_verify.example.com", content: "token" });
 * ```
 *
 * Objects come back as Cloudflare sends them (snake_case, and fields this
 * module does not name are kept), with the fields named here checked.
 *
 * @module
 */

import { parseIpv4, parseIpv6 } from "@celld/core/ip";
import type {
  CloudflareClient,
  ListOptions,
  PageOptions,
  Query,
  RequestOptions,
} from "./client.ts";
import { CloudflareError } from "./errors.ts";
import { cloudflareId, pathToken } from "./ids.ts";

type Call = Omit<RequestOptions, "body" | "query">;

export type ZoneStatus =
  | "initializing"
  | "pending"
  | "active"
  | "moved"
  | "deleted"
  | "deactivated";

export type ZoneType = "full" | "partial" | "secondary" | "internal";

/** A zone, as Cloudflare describes it. */
export interface Zone {
  readonly id: string;
  readonly name: string;
  readonly status: ZoneStatus | string;
  readonly paused: boolean;
  readonly type: ZoneType | string;
  readonly development_mode?: number;
  readonly name_servers: readonly string[];
  readonly original_name_servers?: readonly string[] | null;
  readonly account: { readonly id: string; readonly name?: string };
  readonly plan?: { readonly id?: string; readonly name?: string };
  readonly created_on?: string;
  readonly modified_on?: string;
  readonly activated_on?: string | null;
  readonly [field: string]: unknown;
}

/** Which zones {@link Zones.list} returns. */
export interface ZoneFilter {
  /** The exact domain name. */
  readonly name?: string;
  readonly status?: ZoneStatus;
  readonly accountId?: string;
  readonly accountName?: string;
  readonly order?: "name" | "status" | "account.id" | "account.name";
  readonly direction?: "asc" | "desc";
  readonly match?: "any" | "all";
}

/** A new zone. */
export interface ZoneInput {
  /** The domain, such as `example.com`. */
  readonly name: string;
  readonly account: { readonly id: string };
  /** Default `full`: Cloudflare is the authoritative DNS. */
  readonly type?: ZoneType;
}

/** What {@link Zones.edit} may change: one field per call, as Cloudflare takes it. */
export type ZoneEdit =
  /** DNS only: Cloudflare stops proxying the zone. */
  | { readonly paused: boolean }
  /** Business and Enterprise. */
  | { readonly vanity_name_servers: readonly string[] }
  /** Enterprise, or where Cloudflare enabled it. */
  | { readonly type: ZoneType };

/** Zones of the token's accounts. */
export class Zones {
  readonly #client: CloudflareClient;

  constructor(client: CloudflareClient) {
    this.#client = client;
  }

  /** Every matching zone (see {@link CloudflareClient.list} for the cap). */
  async list(filter: ZoneFilter = {}, options?: ListOptions): Promise<Zone[]> {
    const zones = await this.#client.list<Zone>(
      "/zones",
      zoneQuery(filter),
      options,
    );
    return zones.map(checkZone);
  }

  /** The matching zones a page at a time. */
  async *pages(
    filter: ZoneFilter = {},
    options?: PageOptions,
  ): AsyncGenerator<Zone[]> {
    for await (
      const page of this.#client.pages<Zone>(
        "/zones",
        zoneQuery(filter),
        options,
      )
    ) {
      yield page.map(checkZone);
    }
  }

  async get(zoneId: string, options?: Call): Promise<Zone> {
    return checkZone(
      await this.#client.result<Zone>("GET", zonePath(zoneId), options),
    );
  }

  /**
   * The zone named `name` (one of the token's accounts' when `accountId`
   * is left out).
   *
   * @throws {CloudflareError} `kind: "response"`, `status` 404, when there
   *   is none; a {@link RangeError} when several accounts have one.
   */
  async byName(
    name: string,
    options: Call & { readonly accountId?: string } = {},
  ): Promise<Zone> {
    const { accountId, ...call } = options;
    const zones = await this.list(
      { name: domainName(name, "name"), accountId },
      { ...call, maxItems: 50 },
    );
    const exact = zones.filter((zone) =>
      zone.name.toLowerCase() === name.toLowerCase()
    );
    if (exact.length === 0) {
      throw new CloudflareError("response", `no zone is named ${name}`, {
        status: 404,
      });
    }
    if (exact.length > 1) {
      throw new RangeError(
        `${exact.length} zones are named ${name}; pass accountId`,
      );
    }
    return exact[0];
  }

  /** Adds a zone; it is `pending` until its name servers point at Cloudflare. */
  async create(input: ZoneInput, options?: Call): Promise<Zone> {
    const body = {
      name: domainName(input.name, "name"),
      account: { id: cloudflareId(input.account?.id, "account.id") },
      ...(input.type === undefined ? {} : { type: input.type }),
    };
    return checkZone(
      await this.#client.result<Zone>("POST", "/zones", { ...options, body }),
    );
  }

  async edit(zoneId: string, edit: ZoneEdit, options?: Call): Promise<Zone> {
    if (
      edit === null || typeof edit !== "object" ||
      Object.keys(edit).length !== 1
    ) {
      throw new TypeError(
        "edit changes one field per call: paused, vanity_name_servers or type",
      );
    }
    return checkZone(
      await this.#client.result<Zone>("PATCH", zonePath(zoneId), {
        ...options,
        body: edit,
      }),
    );
  }

  /** Deletes a zone and everything in it. */
  async delete(zoneId: string, options?: Call): Promise<void> {
    await this.#client.result<unknown>("DELETE", zonePath(zoneId), options);
  }

  /** Asks Cloudflare to check a pending zone's name servers again. */
  async activationCheck(
    zoneId: string,
    options?: Call,
  ): Promise<{ id: string }> {
    return await this.#client.result<{ id: string }>(
      "PUT",
      `${zonePath(zoneId)}/activation_check`,
      options,
    );
  }
}

/** One zone setting. */
export interface ZoneSetting<V = unknown> {
  readonly id: string;
  readonly value: V;
  readonly editable?: boolean;
  readonly modified_on?: string | null;
  readonly [field: string]: unknown;
}

/**
 * A zone's settings (`ssl`, `min_tls_version`, `always_use_https`, and the
 * cache ones `./cache` names), by id.
 */
export class ZoneSettings {
  readonly #client: CloudflareClient;
  readonly zoneId: string;

  constructor(client: CloudflareClient, zoneId: string) {
    this.#client = client;
    this.zoneId = cloudflareId(zoneId, "zoneId");
  }

  async get<V = unknown>(
    settingId: string,
    options?: Call,
  ): Promise<ZoneSetting<V>> {
    return checkSetting<V>(
      await this.#client.result("GET", this.#path(settingId), options),
      settingId,
    );
  }

  async set<V>(
    settingId: string,
    value: V,
    options?: Call,
  ): Promise<ZoneSetting<V>> {
    return checkSetting<V>(
      await this.#client.result("PATCH", this.#path(settingId), {
        ...options,
        body: { value },
        // Setting a value twice leaves it set.
        idempotent: true,
      }),
      settingId,
    );
  }

  #path(settingId: string): string {
    return `${zonePath(this.zoneId)}/settings/${
      pathToken(settingId, "settingId")
    }`;
  }
}

export type DnsRecordType =
  | "A"
  | "AAAA"
  | "CAA"
  | "CERT"
  | "CNAME"
  | "DNSKEY"
  | "DS"
  | "HTTPS"
  | "LOC"
  | "MX"
  | "NAPTR"
  | "NS"
  | "OPENPGPKEY"
  | "PTR"
  | "SMIMEA"
  | "SRV"
  | "SSHFP"
  | "SVCB"
  | "TLSA"
  | "TXT"
  | "URI";

/** A DNS record, as Cloudflare describes it. */
export interface DnsRecord {
  readonly id: string;
  readonly name: string;
  readonly type: DnsRecordType | string;
  /** The value, for types written as one string. */
  readonly content?: string;
  /** The value's parts, for types that have them (SRV, CAA, ...). */
  readonly data?: Readonly<Record<string, unknown>>;
  readonly priority?: number;
  readonly proxiable?: boolean;
  readonly proxied?: boolean;
  /** Seconds; 1 means automatic. */
  readonly ttl: number;
  readonly comment?: string | null;
  readonly tags?: readonly string[];
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly created_on?: string;
  readonly modified_on?: string;
  readonly [field: string]: unknown;
}

/** A record to create or overwrite. */
export interface DnsRecordInput {
  readonly type: DnsRecordType;
  /** The full name (`www.example.com`), or `@` for the zone apex. */
  readonly name: string;
  /** The value, for types written as one string (A, AAAA, CNAME, TXT, MX, NS, PTR, OPENPGPKEY). */
  readonly content?: string;
  /** The value's parts, for SRV, CAA, CERT, DS, LOC, ... */
  readonly data?: Readonly<Record<string, unknown>>;
  /** MX, URI (and SRV outside `data`) only. */
  readonly priority?: number;
  /** A, AAAA and CNAME only: serve through Cloudflare's proxy. */
  readonly proxied?: boolean;
  /**
   * Seconds, 60 to 86400 (30 on Enterprise), or 1 for automatic (the
   * default, and the only value a proxied record has).
   */
  readonly ttl?: number;
  /** One line; 100 characters on the Free plan, 500 on others. */
  readonly comment?: string;
  /** `name:value` tags, at most 20 (not on the Free plan). */
  readonly tags?: readonly string[];
  readonly settings?: Readonly<Record<string, unknown>>;
}

/** A string match on a field: exact by default. */
export type TextMatch =
  | string
  | {
    readonly exact?: string;
    readonly contains?: string;
    readonly startswith?: string;
    readonly endswith?: string;
  };

/** Which records {@link DnsRecords.list} returns. */
export interface DnsFilter {
  readonly type?: DnsRecordType;
  readonly name?: TextMatch;
  readonly content?: TextMatch;
  readonly comment?: TextMatch;
  /** Tags records must carry: `name` (present) or `name:value` (exact). */
  readonly tag?: string | readonly string[];
  /** Whether a record needs `all` of `tag` (the default) or `any`. */
  readonly tagMatch?: "any" | "all";
  readonly proxied?: boolean;
  /** Free text over names and contents. */
  readonly search?: string;
  readonly match?: "any" | "all";
  readonly order?: "type" | "name" | "content" | "ttl" | "proxied";
  readonly direction?: "asc" | "desc";
}

/** The changes {@link DnsRecords.batch} applies, in this order. */
export interface DnsBatch {
  readonly deletes?: readonly { readonly id: string }[];
  readonly patches?: readonly (Partial<DnsRecordInput> & {
    readonly id: string;
  })[];
  readonly puts?: readonly (DnsRecordInput & { readonly id: string })[];
  readonly posts?: readonly DnsRecordInput[];
}

/** What a batch did, by operation. */
export interface DnsBatchResult {
  readonly deletes?: readonly DnsRecord[];
  readonly patches?: readonly DnsRecord[];
  readonly puts?: readonly DnsRecord[];
  readonly posts?: readonly DnsRecord[];
}

const PROXIABLE = new Set(["A", "AAAA", "CNAME"]);
const WITH_DATA = new Set([
  "CAA",
  "CERT",
  "DNSKEY",
  "DS",
  "HTTPS",
  "LOC",
  "NAPTR",
  "SMIMEA",
  "SRV",
  "SSHFP",
  "SVCB",
  "TLSA",
  "URI",
]);
const WITH_PRIORITY = new Set(["MX", "URI"]);
const MAX_BATCH = 3500;
const TAG = /^[A-Za-z0-9_-]{1,32}(?::[^\r\n]{0,100})?$/;

/** The DNS records of one zone. */
export class DnsRecords {
  readonly #client: CloudflareClient;
  readonly zoneId: string;

  constructor(client: CloudflareClient, zoneId: string) {
    this.#client = client;
    this.zoneId = cloudflareId(zoneId, "zoneId");
  }

  get #base(): string {
    return `${zonePath(this.zoneId)}/dns_records`;
  }

  async list(
    filter: DnsFilter = {},
    options?: ListOptions,
  ): Promise<DnsRecord[]> {
    const records = await this.#client.list<DnsRecord>(
      this.#base,
      dnsQuery(filter),
      options,
    );
    return records.map(checkRecord);
  }

  async *pages(
    filter: DnsFilter = {},
    options?: PageOptions,
  ): AsyncGenerator<DnsRecord[]> {
    for await (
      const page of this.#client.pages<DnsRecord>(
        this.#base,
        dnsQuery(filter),
        options,
      )
    ) {
      yield page.map(checkRecord);
    }
  }

  async get(recordId: string, options?: Call): Promise<DnsRecord> {
    return checkRecord(
      await this.#client.result("GET", this.#record(recordId), options),
    );
  }

  /**
   * Adds a record. It is not retried: Cloudflare refuses an identical
   * second record, but a lost answer can still leave one behind.
   */
  async create(input: DnsRecordInput, options?: Call): Promise<DnsRecord> {
    return checkRecord(
      await this.#client.result("POST", this.#base, {
        ...options,
        body: recordBody(input),
      }),
    );
  }

  /** Replaces a record whole. */
  async overwrite(
    recordId: string,
    input: DnsRecordInput,
    options?: Call,
  ): Promise<DnsRecord> {
    return checkRecord(
      await this.#client.result("PUT", this.#record(recordId), {
        ...options,
        body: recordBody(input),
      }),
    );
  }

  /**
   * Changes the given fields of a record. Not its type: Cloudflare refuses
   * that; delete and recreate the record in one {@link batch}.
   */
  async edit(
    recordId: string,
    patch: Partial<DnsRecordInput>,
    options?: Call,
  ): Promise<DnsRecord> {
    return checkRecord(
      await this.#client.result("PATCH", this.#record(recordId), {
        ...options,
        body: patchBody(patch),
      }),
    );
  }

  async delete(recordId: string, options?: Call): Promise<{ id: string }> {
    return await this.#client.result<{ id: string }>(
      "DELETE",
      this.#record(recordId),
      options,
    );
  }

  /**
   * Applies deletes, then patches, then puts, then posts, as one change:
   * Cloudflare applies all of them or none (though the edge picks them up
   * one record at a time). Changing a record's type is a delete and a post
   * in one batch: Cloudflare no longer changes a type in place.
   */
  async batch(batch: DnsBatch, options?: Call): Promise<DnsBatchResult> {
    const body: Record<string, unknown> = {};
    if (batch.deletes?.length) {
      body.deletes = batch.deletes.map((item) => ({
        id: cloudflareId(item.id, "deletes[].id"),
      }));
    }
    if (batch.patches?.length) {
      body.patches = batch.patches.map(({ id, ...patch }) => ({
        id: cloudflareId(id, "patches[].id"),
        ...patchBody(patch),
      }));
    }
    if (batch.puts?.length) {
      body.puts = batch.puts.map(({ id, ...input }) => ({
        id: cloudflareId(id, "puts[].id"),
        ...recordBody(input),
      }));
    }
    if (batch.posts?.length) body.posts = batch.posts.map(recordBody);
    if (Object.keys(body).length === 0) return {};
    const size = Object.values(body).reduce(
      (sum: number, items) => sum + (items as unknown[]).length,
      0,
    );
    if (size > MAX_BATCH) {
      throw new RangeError(
        `a batch holds at most ${MAX_BATCH} changes (200 on the Free plan), got ${size}`,
      );
    }
    const result = await this.#client.result<DnsBatchResult>(
      "POST",
      `${this.#base}/batch`,
      { ...options, body },
    );
    const checked: Record<string, readonly DnsRecord[]> = {};
    for (const key of ["deletes", "patches", "puts", "posts"] as const) {
      const list = result?.[key];
      if (Array.isArray(list)) checked[key] = list.map(checkRecord);
    }
    return checked;
  }

  /** The zone's records as a BIND zone file. */
  async export(options?: Call): Promise<string> {
    return await this.#client.text("GET", `${this.#base}/export`, options);
  }

  /** The records named exactly `name`, of `type` when given. */
  async find(
    name: string,
    type?: DnsRecordType,
    options?: Call,
  ): Promise<DnsRecord[]> {
    return await this.list({ name: { exact: name }, type }, {
      ...options,
      maxItems: 1000,
    });
  }

  /**
   * Makes `input` the one record of its name and type: overwrites the
   * existing one, or creates it when there is none.
   *
   * @throws {RangeError} when several records have that name and type
   *   (round-robin A records, several TXT values), which one call cannot
   *   tell apart; use `batch` for those.
   */
  async upsert(
    input: DnsRecordInput,
    options?: Call,
  ): Promise<{ record: DnsRecord; created: boolean }> {
    recordBody(input);
    const existing = await this.find(input.name, input.type, options);
    if (existing.length > 1) {
      throw new RangeError(
        `${existing.length} ${input.type} records are named ${input.name}; upsert changes exactly one`,
      );
    }
    if (existing.length === 1) {
      return {
        record: await this.overwrite(existing[0].id, input, options),
        created: false,
      };
    }
    return { record: await this.create(input, options), created: true };
  }

  #record(recordId: string): string {
    return `${this.#base}/${cloudflareId(recordId, "recordId")}`;
  }
}

/** `/zones/<id>`. */
export function zonePath(zoneId: string): string {
  return `/zones/${cloudflareId(zoneId, "zoneId")}`;
}

function zoneQuery(filter: ZoneFilter): Query {
  return {
    name: filter.name,
    status: filter.status,
    "account.id": filter.accountId === undefined
      ? undefined
      : cloudflareId(filter.accountId, "accountId"),
    "account.name": filter.accountName,
    order: filter.order,
    direction: filter.direction,
    match: filter.match,
  };
}

function dnsQuery(filter: DnsFilter): Query {
  const query: Record<string, string | boolean | readonly string[]> = {};
  for (const key of ["name", "content", "comment"] as const) {
    const match = filter[key];
    if (match === undefined) continue;
    if (typeof match === "string") {
      query[`${key}.exact`] = match;
      continue;
    }
    for (
      const mode of ["exact", "contains", "startswith", "endswith"] as const
    ) {
      const value = match[mode];
      if (value !== undefined) query[`${key}.${mode}`] = value;
    }
  }
  if (filter.type !== undefined) query.type = filter.type;
  if (filter.tag !== undefined) {
    query.tag = typeof filter.tag === "string" ? [filter.tag] : filter.tag;
  }
  if (filter.tagMatch !== undefined) query.tag_match = filter.tagMatch;
  if (filter.proxied !== undefined) query.proxied = filter.proxied;
  if (filter.search !== undefined) query.search = filter.search;
  if (filter.match !== undefined) query.match = filter.match;
  if (filter.order !== undefined) query.order = filter.order;
  if (filter.direction !== undefined) query.direction = filter.direction;
  return query;
}

/**
 * The body for a new or replaced record, checked: the value in the form
 * its type takes, `proxied` only where Cloudflare proxies, a TTL it
 * accepts.
 *
 * @throws {TypeError} or {RangeError} naming the field.
 */
export function recordBody(input: DnsRecordInput): Record<string, unknown> {
  if (input === null || typeof input !== "object") {
    throw new TypeError("a DNS record must be an object");
  }
  const type = input.type;
  if (typeof type !== "string" || !/^[A-Z]{1,10}$/.test(type)) {
    throw new TypeError(`type ${JSON.stringify(type)} is not a record type`);
  }
  const name = recordName(input.name);
  const body: Record<string, unknown> = { type, name };
  if (WITH_DATA.has(type)) {
    if (input.data === undefined && input.content === undefined) {
      throw new TypeError(`a ${type} record needs data (or content)`);
    }
  } else if (typeof input.content !== "string" || input.content === "") {
    throw new TypeError(`a ${type} record needs content`);
  }
  if (input.content !== undefined) {
    body.content = recordContent(type, input.content);
  }
  if (input.data !== undefined) {
    if (input.data === null || typeof input.data !== "object") {
      throw new TypeError("data must be an object");
    }
    if (
      type === "SRV" &&
      ["service", "proto", "name"].some((key) => key in input.data!)
    ) {
      throw new TypeError(
        "an SRV record's service, proto and name go in its name (_sip._tcp.example.com), not its data",
      );
    }
    body.data = input.data;
  }
  if (
    type === "CNAME" && typeof input.content === "string" &&
    input.content.toLowerCase().replace(/\.$/, "") ===
      name.toLowerCase().replace(/\.$/, "")
  ) {
    throw new TypeError("a CNAME cannot point at its own name");
  }
  if (input.priority !== undefined) {
    if (!WITH_PRIORITY.has(type)) {
      throw new TypeError(`a ${type} record has no priority`);
    }
    body.priority = integer(input.priority, "priority", 0, 65535);
  } else if (type === "MX") {
    throw new TypeError("an MX record needs a priority");
  }
  Object.assign(body, commonFields(type, input));
  return body;
}

function patchBody(patch: Partial<DnsRecordInput>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const type = patch.type;
  if (type !== undefined) body.type = type;
  if (patch.name !== undefined) body.name = recordName(patch.name);
  if (patch.content !== undefined) {
    body.content = type === undefined
      ? patch.content
      : recordContent(type, patch.content);
  }
  if (patch.data !== undefined) body.data = patch.data;
  if (patch.priority !== undefined) {
    body.priority = integer(patch.priority, "priority", 0, 65535);
  }
  Object.assign(body, commonFields(type, patch));
  return body;
}

function commonFields(
  type: string | undefined,
  input: Partial<DnsRecordInput>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.proxied !== undefined) {
    if (typeof input.proxied !== "boolean") {
      throw new TypeError("proxied must be a boolean");
    }
    if (input.proxied && type !== undefined && !PROXIABLE.has(type)) {
      throw new TypeError(`a ${type} record cannot be proxied`);
    }
    body.proxied = input.proxied;
  }
  if (input.ttl !== undefined) {
    const ttl = integer(input.ttl, "ttl", 1, 86400);
    if (ttl !== 1 && ttl < 30) {
      throw new RangeError("ttl must be 1 (automatic) or 30 to 86400 seconds");
    }
    body.ttl = ttl;
  }
  if (input.comment !== undefined) {
    if (
      typeof input.comment !== "string" || input.comment.length > 500 ||
      /[\r\n]/.test(input.comment)
    ) {
      throw new TypeError(
        "comment must be one line of at most 500 characters",
      );
    }
    body.comment = input.comment;
  }
  if (input.tags !== undefined) {
    if (
      !Array.isArray(input.tags) || input.tags.length > 20 ||
      !input.tags.every((tag) => typeof tag === "string" && TAG.test(tag))
    ) {
      throw new TypeError(
        "tags must be at most 20 name:value strings, names of letters, digits, _ and - (32 at most), values of 100 characters at most",
      );
    }
    body.tags = [...input.tags];
  }
  if (input.settings !== undefined) body.settings = input.settings;
  return body;
}

function recordContent(type: string, content: string): string {
  if (typeof content !== "string") {
    throw new TypeError("content must be a string");
  }
  if (type === "A" && parseIpv4(content) === null) {
    throw new TypeError(`an A record's content must be an IPv4 address`);
  }
  if (type === "AAAA" && parseIpv6(content) === null) {
    throw new TypeError(`an AAAA record's content must be an IPv6 address`);
  }
  if (type === "TXT" && content.length > 4096) {
    throw new RangeError("a TXT record's content is at most 4096 characters");
  }
  return content;
}

function recordName(name: unknown): string {
  if (typeof name !== "string" || name === "" || name.length > 255) {
    throw new TypeError("name must be a DNS name of at most 255 characters");
  }
  if (/[\s/\\]/.test(name)) {
    throw new TypeError(`${JSON.stringify(name)} is not a DNS name`);
  }
  return name;
}

function domainName(name: unknown, field: string): string {
  if (
    typeof name !== "string" || name.length > 253 ||
    !/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9-]{2,63}$/
      .test(name)
  ) {
    throw new TypeError(`${field} must be a domain name`);
  }
  return name;
}

function integer(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  if (
    !Number.isSafeInteger(value) || (value as number) < min ||
    (value as number) > max
  ) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function checkZone(value: unknown): Zone {
  if (
    value === null || typeof value !== "object" ||
    typeof (value as Zone).id !== "string" ||
    typeof (value as Zone).name !== "string"
  ) {
    throw new CloudflareError("response", "a zone without an id and a name");
  }
  return value as Zone;
}

function checkRecord(value: unknown): DnsRecord {
  if (
    value === null || typeof value !== "object" ||
    typeof (value as DnsRecord).id !== "string" ||
    typeof (value as DnsRecord).name !== "string" ||
    typeof (value as DnsRecord).type !== "string"
  ) {
    throw new CloudflareError(
      "response",
      "a DNS record without an id, a name and a type",
    );
  }
  return value as DnsRecord;
}

function checkSetting<V>(value: unknown, settingId: string): ZoneSetting<V> {
  if (
    value === null || typeof value !== "object" ||
    typeof (value as ZoneSetting).id !== "string" ||
    !("value" in (value as object))
  ) {
    throw new CloudflareError(
      "response",
      `the ${settingId} setting came back without an id and a value`,
    );
  }
  return value as ZoneSetting<V>;
}
