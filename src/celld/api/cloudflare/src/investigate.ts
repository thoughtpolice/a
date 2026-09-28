// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/api/cloudflare/investigate`: what Security Center's Investigate
 * uses: the Intel lookups (domains, IPs, WHOIS, passive DNS, ASNs) and
 * URL Scanner.
 *
 * ```ts
 * const intel = new Intel(cf, accountId);
 * const domain = await intel.domain("example.com");
 * domain.risk_types; // [{ id: 131, name: "Phishing", ... }]
 *
 * const scanner = new UrlScanner(cf, accountId);
 * const scan = await scanner.submit({ url: "https://example.com/login" });
 * const result = await scanner.wait(scan.uuid);
 * result.verdicts?.overall?.malicious;
 * ```
 *
 * Intel answers in the v4 envelope, and needs `Account > Intel > Read`.
 * Its calls count against a monthly quota (100 on the Free, Pro and
 * Business plans; 2,500 on Enterprise) shared with the dashboard's
 * Investigate, so cache what you look up.
 *
 * URL Scanner's v2 API answers with bare objects (its own errors are
 * `{ message, status, errors }`), needs `Account > URL Scanner > Edit`, and
 * reports a scan still running as a 404 carrying the scan's `task`, which
 * {@link UrlScanner.result} turns into `null`. Scans here are `Unlisted`
 * unless asked otherwise, so a private URL is never published by default;
 * the Free plan cannot make unlisted scans, so pass `visibility: "Public"`
 * there.
 *
 * @module
 */

import { parseIp } from "@celld/core/ip";
import type { CloudflareClient, Query, RequestOptions } from "./client.ts";
import { CloudflareError } from "./errors.ts";
import { cloudflareId, uuid } from "./ids.ts";

type Call = Omit<RequestOptions, "body" | "query">;

/** A category or risk type, as Intel names them. */
export interface IntelCategory {
  readonly id: number;
  readonly name: string;
  readonly super_category_id?: number;
  readonly [field: string]: unknown;
}

/** What Intel knows about a domain. */
export interface DomainIntel {
  readonly domain: string;
  readonly content_categories?: readonly IntelCategory[];
  readonly inherited_content_categories?: readonly IntelCategory[];
  readonly risk_types?: readonly IntelCategory[];
  readonly inherited_risk_types?: readonly IntelCategory[];
  readonly inherited_from?: string;
  readonly popularity_rank?: number;
  readonly risk_score?: number;
  readonly application?: { readonly id?: number; readonly name?: string };
  readonly additional_information?: {
    readonly suspected_malware_family?: string;
  };
  readonly resolves_to_refs?: readonly {
    readonly id?: string;
    readonly value?: string;
  }[];
  readonly [field: string]: unknown;
}

/** A domain's categorizations over time. */
export interface DomainHistory {
  readonly domain: string;
  readonly categorizations?: readonly {
    readonly categories?: readonly IntelCategory[];
    readonly start?: string;
    readonly end?: string;
  }[];
  readonly [field: string]: unknown;
}

/** What Intel knows about an address. */
export interface IpIntel {
  readonly ip: string;
  readonly belongs_to_ref?: {
    readonly id?: string;
    readonly value?: number | string;
    readonly type?: string;
    readonly country?: string;
    readonly description?: string;
  };
  readonly risk_types?: readonly IntelCategory[];
  readonly [field: string]: unknown;
}

/** A domain's registration. */
export interface Whois {
  readonly domain: string;
  readonly found?: boolean;
  readonly registrar?: string;
  readonly created_date?: string;
  readonly updated_date?: string;
  readonly expiration_date?: string;
  readonly nameservers?: readonly string[];
  readonly registrant?: string;
  readonly registrant_org?: string;
  readonly registrant_country?: string;
  readonly [field: string]: unknown;
}

/** Hostnames seen resolving to an address (passive DNS). */
export interface PassiveDns {
  readonly reverse_records?: readonly {
    readonly hostname: string;
    readonly first_seen?: string;
    readonly last_seen?: string;
  }[];
  readonly count?: number;
  readonly page?: number;
  readonly per_page?: number;
  readonly [field: string]: unknown;
}

/** An autonomous system. */
export interface AsnIntel {
  readonly asn: number;
  readonly description?: string;
  readonly country?: string;
  readonly type?: string;
  readonly domain_count?: number;
  readonly top_domains?: readonly string[];
  readonly [field: string]: unknown;
}

/** What Intel knows about a URL. */
export interface UrlIntel {
  readonly full_url?: string;
  readonly hostname?: string;
  readonly url_path?: string;
  readonly content_categories?: readonly IntelCategory[];
  readonly risk_type?: readonly IntelCategory[];
  readonly [field: string]: unknown;
}

/** An autonomous system's announced prefixes. */
export interface AsnSubnets {
  readonly asn: number;
  readonly subnets: readonly string[];
  readonly ip_count_total?: number;
  readonly count?: number;
  readonly page?: number;
  readonly per_page?: number;
  readonly [field: string]: unknown;
}

const DOMAIN =
  /^(?=.{1,253}$)(?:[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9-]{2,63}$/;
/** Cloudflare documents no limit; this keeps the URL a sane length. */
const MAX_BULK = 100;

/** Intel lookups for an account. */
export class Intel {
  readonly #client: CloudflareClient;
  readonly accountId: string;

  constructor(client: CloudflareClient, accountId: string) {
    this.#client = client;
    this.accountId = cloudflareId(accountId, "accountId");
  }

  get #base(): string {
    return `/accounts/${this.accountId}/intel`;
  }

  /** Categories, risk types and popularity for a domain. */
  async domain(
    domain: string,
    options: Call & {
      readonly skipDns?: boolean;
      readonly skipRanking?: boolean;
    } = {},
  ): Promise<DomainIntel> {
    const { skipDns, skipRanking, ...call } = options;
    return await this.#get<DomainIntel>("/domain", {
      domain: checkDomain(domain),
      skip_dns: skipDns,
      skip_ranking: skipRanking,
    }, call);
  }

  /** {@link domain} for several at once, without `resolves_to_refs`. */
  async domains(
    domains: readonly string[],
    options: Call & { readonly includeRanking?: boolean } = {},
  ): Promise<DomainIntel[]> {
    if (domains.length === 0 || domains.length > MAX_BULK) {
      throw new RangeError(`domains takes 1 to ${MAX_BULK} domains`);
    }
    const { includeRanking, ...call } = options;
    const result = await this.#get<unknown>("/domain/bulk", {
      domain: domains.map(checkDomain),
      include_ranking: includeRanking,
    }, call);
    return list<DomainIntel>(result, "domain/bulk");
  }

  /** Categories and risk types for a URL. */
  async url(url: string, options?: Call): Promise<UrlIntel> {
    return await this.#get<UrlIntel>("/url", { url: httpUrl(url) }, options);
  }

  /** How a domain has been categorized over time. */
  async domainHistory(
    domain: string,
    options?: Call,
  ): Promise<DomainHistory[]> {
    return list<DomainHistory>(
      await this.#get<unknown>("/domain-history", {
        domain: checkDomain(domain),
      }, options),
      "domain-history",
    );
  }

  /** What Intel knows about an IPv4 or IPv6 address. */
  async ip(address: string, options?: Call): Promise<IpIntel[]> {
    const ip = parseIp(address);
    if (ip === null) throw new TypeError(`${address} is not an IP address`);
    return list<IpIntel>(
      await this.#get<unknown>("/ip", {
        [ip.version === 4 ? "ipv4" : "ipv6"]: ip.toString(),
      }, options),
      "ip",
    );
  }

  /** A domain's WHOIS registration. */
  async whois(domain: string, options?: Call): Promise<Whois> {
    return await this.#get<Whois>("/whois", {
      domain: checkDomain(domain),
    }, options);
  }

  /**
   * Hostnames seen resolving to an IPv4 address, between `start` and `end`
   * (`YYYY-MM-DD`; the last 30 days by default). Its paging is in the
   * answer, not in `result_info`.
   */
  async passiveDns(
    address: string,
    options: Call & {
      readonly start?: string;
      readonly end?: string;
      readonly page?: number;
      readonly perPage?: number;
    } = {},
  ): Promise<PassiveDns> {
    const ip = parseIp(address);
    if (ip === null || ip.version !== 4) {
      throw new TypeError(`passive DNS takes an IPv4 address, got ${address}`);
    }
    const { start, end, page, perPage, ...call } = options;
    for (const [name, date] of [["start", start], ["end", end]] as const) {
      if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new TypeError(`${name} must be YYYY-MM-DD`);
      }
    }
    return await this.#get<PassiveDns>("/dns", {
      ipv4: ip.toString(),
      start,
      end,
      page,
      per_page: perPage,
    }, call);
  }

  /** An autonomous system's owner, country and top domains. */
  async asn(asn: number, options?: Call): Promise<AsnIntel> {
    const number = checkAsn(asn);
    const result = await this.#get<unknown>(`/asn/${number}`, {}, options);
    // The schema says a bare number where the docs show an object.
    if (typeof result === "number") return { asn: result };
    if (result === null || typeof result !== "object") {
      throw new CloudflareError(
        "response",
        `intel/asn/${number} answered no ASN`,
      );
    }
    return result as AsnIntel;
  }

  /** The prefixes an autonomous system announces. */
  async asnSubnets(asn: number, options?: Call): Promise<AsnSubnets> {
    const path = `${this.#base}/asn/${checkAsn(asn)}/subnets`;
    // Documented without the envelope; take either.
    const value = await this.#client.json("GET", path, options) as
      | Record<string, unknown>
      | null;
    const result = value !== null && typeof value === "object" &&
        typeof value.success === "boolean"
      ? value.result
      : value;
    if (
      result === null || typeof result !== "object" ||
      !Array.isArray((result as AsnSubnets).subnets)
    ) {
      throw new CloudflareError("response", "asn subnets answered no subnets");
    }
    return result as AsnSubnets;
  }

  async #get<T>(path: string, query: Query, options?: Call): Promise<T> {
    return await this.#client.result<T>("GET", `${this.#base}${path}`, {
      ...options,
      query,
    });
  }
}

/** Who may see a scan: anyone (`Public`), or only its account (`Unlisted`). */
export type ScanVisibility = "Public" | "Unlisted";

/** A URL to scan. */
export interface ScanInput {
  readonly url: string;
  /** Default `Unlisted`, so a private URL is not published. */
  readonly visibility?: ScanVisibility;
  readonly screenshotsResolutions?:
    readonly ("desktop" | "mobile" | "tablet")[];
  readonly customagent?: string;
  readonly referer?: string;
  readonly customHeaders?: Readonly<Record<string, string>>;
  /** The country to scan from (ISO 3166-1 alpha-2); Enterprise. */
  readonly country?: string;
  /** Also check the page's readiness for AI agents. */
  readonly agentReadiness?: boolean;
}

/** A submitted scan. */
export interface ScanSubmission {
  readonly uuid: string;
  readonly url: string;
  readonly visibility?: string;
  /** Where the result will be (the API's and the Radar page's). */
  readonly api?: string;
  readonly result?: string;
  readonly message?: string;
  readonly [field: string]: unknown;
}

/** A finished scan (the fields most callers read; the rest are kept). */
export interface ScanResult {
  readonly task: {
    readonly uuid: string;
    readonly url?: string;
    readonly success?: boolean;
    readonly status?: string;
    readonly time?: string;
    readonly visibility?: string;
    readonly [field: string]: unknown;
  };
  readonly page?: {
    readonly url?: string;
    readonly domain?: string;
    readonly ip?: string;
    readonly asn?: string;
    readonly country?: string;
    readonly status?: number | string;
    readonly title?: string;
    readonly [field: string]: unknown;
  };
  readonly verdicts?: {
    readonly overall?: {
      readonly malicious?: boolean;
      readonly categories?: readonly unknown[];
      readonly [field: string]: unknown;
    };
    readonly [field: string]: unknown;
  };
  readonly stats?: Readonly<Record<string, unknown>>;
  readonly lists?: Readonly<Record<string, unknown>>;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly [field: string]: unknown;
}

/** One hit of {@link UrlScanner.search}. */
export interface ScanSearchHit {
  readonly _id?: string;
  readonly task?: ScanResult["task"];
  readonly page?: ScanResult["page"];
  readonly verdicts?: ScanResult["verdicts"];
  readonly result?: string;
  readonly [field: string]: unknown;
}

/** How long {@link UrlScanner.wait} polls. */
export interface WaitOptions extends Call {
  /** Default 10 s between polls (Cloudflare asks for 10 to 30). */
  readonly intervalMs?: number;
  /** Default 3 minutes in all. */
  readonly deadlineMs?: number;
}

/** URL Scanner for an account. */
export class UrlScanner {
  readonly #client: CloudflareClient;
  readonly accountId: string;

  constructor(client: CloudflareClient, accountId: string) {
    this.#client = client;
    this.accountId = cloudflareId(accountId, "accountId");
  }

  get #base(): string {
    return `/accounts/${this.accountId}/urlscanner/v2`;
  }

  /**
   * Submits a URL; the scan runs for a while (see {@link wait}). A host
   * scanned very recently is refused with 409.
   */
  async submit(input: ScanInput, options?: Call): Promise<ScanSubmission> {
    return checkSubmission(
      await this.#client.json("POST", `${this.#base}/scan`, {
        ...options,
        body: scanBody(input),
      }),
    );
  }

  /** Submits up to 100 URLs; one submission each, in order. */
  async submitMany(
    inputs: readonly ScanInput[],
    options?: Call,
  ): Promise<ScanSubmission[]> {
    if (inputs.length === 0 || inputs.length > 100) {
      throw new RangeError("submitMany takes 1 to 100 URLs");
    }
    const result = await this.#client.json("POST", `${this.#base}/bulk`, {
      ...options,
      body: inputs.map(scanBody),
    });
    if (!Array.isArray(result)) {
      throw new CloudflareError("response", "a bulk scan answered no list");
    }
    return result.map(checkSubmission);
  }

  /**
   * A scan's result, or null while it is queued or running. A finished
   * scan that failed is a result too: see `task.success`.
   *
   * @throws {CloudflareError} with `status` 404 for a scan that does not
   *   exist (its 404 carries no `task`).
   */
  async result(scanId: string, options?: Call): Promise<ScanResult | null> {
    try {
      const result = await this.#client.json(
        "GET",
        `${this.#base}/result/${uuid(scanId, "scanId")}`,
        options,
      );
      if (
        result === null || typeof result !== "object" ||
        typeof (result as ScanResult).task?.uuid !== "string"
      ) {
        throw new CloudflareError("response", "a scan result without a task");
      }
      return result as ScanResult;
    } catch (error) {
      const running = error instanceof CloudflareError &&
        error.status === 404 &&
        typeof (error.body as { task?: { uuid?: unknown } } | undefined)?.task
            ?.uuid === "string";
      if (running) return null;
      throw error;
    }
  }

  /**
   * Polls until the scan finishes.
   *
   * @throws {CloudflareError} `kind: "timeout"` past `deadlineMs`.
   */
  async wait(scanId: string, options: WaitOptions = {}): Promise<ScanResult> {
    const { intervalMs = 10_000, deadlineMs = 180_000, ...call } = options;
    const runtime = this.#client.runtime;
    const started = runtime.now();
    for (;;) {
      const result = await this.result(scanId, call);
      if (result !== null) return result;
      if (runtime.now() + intervalMs - started > deadlineMs) {
        throw new CloudflareError(
          "timeout",
          `scan ${scanId} did not finish within ${deadlineMs} ms`,
        );
      }
      await runtime.sleep(intervalMs, call.signal);
    }
  }

  /**
   * Past scans matching an Elasticsearch-style query, such as
   * `page.domain:example.com AND verdicts.malicious:true`.
   */
  async search(
    q: string,
    options: Call & { readonly size?: number } = {},
  ): Promise<ScanSearchHit[]> {
    const { size, ...call } = options;
    const result = await this.#client.json("GET", `${this.#base}/search`, {
      ...call,
      query: { q, size },
    });
    const hits = (result as { results?: unknown } | null)?.results;
    if (!Array.isArray(hits)) {
      throw new CloudflareError(
        "response",
        "a scan search answered no results",
      );
    }
    return hits as ScanSearchHit[];
  }

  /** A scan's screenshot, as PNG bytes. */
  async screenshot(
    scanId: string,
    options: Call & {
      readonly resolution?: "desktop" | "mobile" | "tablet";
    } = {},
  ): Promise<Uint8Array> {
    const { resolution, ...call } = options;
    return await this.#client.bytes(
      "GET",
      `${this.#base}/screenshots/${uuid(scanId, "scanId")}.png`,
      { ...call, query: { resolution } },
    );
  }

  /** A scan's HTTP archive. */
  async har(scanId: string, options?: Call): Promise<unknown> {
    return await this.#client.json(
      "GET",
      `${this.#base}/har/${uuid(scanId, "scanId")}`,
      options,
    );
  }

  /** The page's DOM as the scanner rendered it. */
  async dom(scanId: string, options?: Call): Promise<string> {
    return await this.#client.text(
      "GET",
      `${this.#base}/dom/${uuid(scanId, "scanId")}`,
      options,
    );
  }
}

function httpUrl(text: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new TypeError("url must be an absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("url must be http or https");
  }
  return text;
}

function scanBody(input: ScanInput): Record<string, unknown> {
  httpUrl(input?.url);
  if (
    input.visibility !== undefined && input.visibility !== "Public" &&
    input.visibility !== "Unlisted"
  ) {
    throw new TypeError("visibility must be Public or Unlisted");
  }
  if (input.country !== undefined && !/^[A-Z]{2}$/.test(input.country)) {
    throw new TypeError("country must be two upper-case letters");
  }
  return { ...input, visibility: input.visibility ?? "Unlisted" };
}

function checkSubmission(value: unknown): ScanSubmission {
  if (
    value === null || typeof value !== "object" ||
    typeof (value as ScanSubmission).uuid !== "string"
  ) {
    throw new CloudflareError("response", "a scan submission without a uuid");
  }
  return value as ScanSubmission;
}

function checkDomain(domain: string): string {
  if (typeof domain !== "string" || !DOMAIN.test(domain)) {
    throw new TypeError(`${JSON.stringify(domain)} is not a domain name`);
  }
  return domain.toLowerCase();
}

function checkAsn(asn: number): number {
  if (!Number.isSafeInteger(asn) || asn < 1 || asn > 4_294_967_295) {
    throw new RangeError("asn must be an AS number from 1 to 4294967295");
  }
  return asn;
}

function list<T>(value: unknown, what: string): T[] {
  if (!Array.isArray(value)) {
    throw new CloudflareError("response", `intel/${what} answered no list`);
  }
  return value as T[];
}
