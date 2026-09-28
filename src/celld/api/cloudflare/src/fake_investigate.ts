// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The fake's Investigate: Intel answers a test sets (and plain defaults
 * for anything else), and URL Scanner scans that finish after a number of
 * polls. See `FakeCloudflare.investigate`.
 *
 * Intel answers in the envelope and counts its calls in `intelCalls`, as
 * the monthly quota would. URL Scanner answers as v2 does: bare objects,
 * a 404 with the scan's `task` while it runs, a 404 without one for a scan
 * that does not exist, and `{ message, status, errors }` for its errors.
 *
 * @module
 */

import type {
  AsnIntel,
  DomainIntel,
  IpIntel,
  PassiveDns,
  ScanResult,
  UrlIntel,
  Whois,
} from "./investigate.ts";
import type { Answer, FakeCloudflare } from "./testing.ts";

interface Scan {
  readonly uuid: string;
  readonly url: string;
  readonly visibility: "public" | "unlisted";
  readonly time: string;
  pollsLeft: number;
  result?: ScanResult;
  malicious: boolean;
}

const UUID = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
/** The eight bytes every PNG starts with, as a screenshot's stand-in. */
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

export class FakeInvestigate {
  readonly #fake: FakeCloudflare;
  readonly #domains = new Map<string, DomainIntel>();
  readonly #ips = new Map<string, IpIntel[]>();
  readonly #whois = new Map<string, Whois>();
  readonly #passive = new Map<string, PassiveDns>();
  readonly #asns = new Map<number, AsnIntel>();
  readonly #urls = new Map<string, UrlIntel>();
  readonly #scans = new Map<string, Scan>();
  #serial = 0;
  /** Intel requests answered, which a real account's monthly quota counts. */
  intelCalls = 0;
  /** How many result polls a new scan answers "still running" to. */
  scanPolls = 1;
  /** URLs whose scans come back malicious. */
  readonly maliciousUrls = new Set<string>();

  constructor(fake: FakeCloudflare) {
    this.#fake = fake;
    this.#intelRoutes();
    this.#scannerRoutes();
  }

  setDomain(intel: DomainIntel): void {
    this.#domains.set(intel.domain.toLowerCase(), intel);
  }

  setIp(ip: string, intel: IpIntel[]): void {
    this.#ips.set(ip, intel);
  }

  setWhois(whois: Whois): void {
    this.#whois.set(whois.domain.toLowerCase(), whois);
  }

  setPassiveDns(ip: string, records: PassiveDns): void {
    this.#passive.set(ip, records);
  }

  setAsn(intel: AsnIntel): void {
    this.#asns.set(intel.asn, intel);
  }

  setUrl(url: string, intel: UrlIntel): void {
    this.#urls.set(url, intel);
  }

  /** Every scan submitted, in order. */
  scans(): { uuid: string; url: string; visibility: string }[] {
    return [...this.#scans.values()].map(({ uuid, url, visibility }) => ({
      uuid,
      url,
      visibility,
    }));
  }

  #intelRoutes(): void {
    const fake = this.#fake;
    const { ok, error } = fake.answers;
    const base = `/accounts/${fake.accountId}/intel`;
    const counted = (answer: () => Answer) => () => {
      this.intelCalls++;
      return answer();
    };
    const domainOf = (domain: string): DomainIntel =>
      this.#domains.get(domain.toLowerCase()) ?? {
        domain,
        content_categories: [],
        risk_types: [],
        resolves_to_refs: [],
      };
    fake.route("GET", `${base}/domain`, (request) =>
      counted(() => {
        const domain = request.query.get("domain");
        return domain === null
          ? error(400, 10001, "domain is required")
          : ok(domainOf(domain));
      })());
    fake.route("GET", `${base}/domain/bulk`, (request) =>
      counted(() => {
        const domains = request.query.getAll("domain");
        return ok(
          domains.map((domain) => {
            const { resolves_to_refs: _refs, ...rest } = domainOf(domain);
            return rest;
          }),
          {
            page: 1,
            per_page: domains.length,
            count: domains.length,
            total_count: domains.length,
          },
        );
      })());
    fake.route(
      "GET",
      `${base}/domain-history`,
      (request) =>
        counted(() =>
          ok([{ domain: request.query.get("domain"), categorizations: [] }])
        )(),
    );
    fake.route("GET", `${base}/ip`, (request) =>
      counted(() => {
        const ip = request.query.get("ipv4") ?? request.query.get("ipv6");
        if (ip === null) return error(400, 10001, "ipv4 or ipv6 is required");
        return ok(this.#ips.get(ip) ?? [{ ip, risk_types: [] }]);
      })());
    fake.route("GET", `${base}/whois`, (request) =>
      counted(() => {
        const domain = request.query.get("domain") ?? "";
        return ok(
          this.#whois.get(domain.toLowerCase()) ?? { domain, found: false },
        );
      })());
    fake.route("GET", `${base}/dns`, (request) =>
      counted(() => {
        const ip = request.query.get("ipv4");
        if (ip === null) return error(400, 10001, "ipv4 is required");
        return ok(
          this.#passive.get(ip) ??
            { reverse_records: [], count: 0, page: 1, per_page: 20 },
        );
      })());
    fake.route(
      "GET",
      `${base}/asn/([0-9]+)`,
      (_request, [asn]) =>
        counted(() =>
          ok(this.#asns.get(Number(asn)) ?? { asn: Number(asn), country: "US" })
        )(),
    );
    fake.route(
      "GET",
      `${base}/asn/([0-9]+)/subnets`,
      (_request, [asn]) =>
        counted(() =>
          // Documented without the envelope.
          fake.answers.raw(200, {
            asn: Number(asn),
            subnets: this.#asns.has(Number(asn)) ? ["192.0.2.0/24"] : [],
            ip_count_total: this.#asns.has(Number(asn)) ? 256 : 0,
            count: 1,
            page: 1,
            per_page: 100,
          })
        )(),
    );
    fake.route("GET", `${base}/url`, (request) =>
      counted(() => {
        const url = request.query.get("url") ?? "";
        return ok(
          this.#urls.get(url) ?? {
            full_url: url,
            content_categories: [],
            risk_type: [],
          },
        );
      })());
  }

  #scannerRoutes(): void {
    const fake = this.#fake;
    const base = `/accounts/${fake.accountId}/urlscanner/v2`;
    const serviceError = (status: number, message: string, task?: object) =>
      fake.answers.raw(status, {
        message,
        status,
        errors: [{ title: message, detail: message, status }],
        ...(task === undefined ? {} : { task }),
      });
    const submit = (body: Record<string, unknown> | null) => {
      const url = body?.url;
      if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
        return null;
      }
      const uuid = this.#uuid();
      const visibility = body?.visibility === "Unlisted"
        ? "unlisted"
        : "public";
      this.#scans.set(uuid, {
        uuid,
        url,
        visibility,
        time: fake.timestamp(),
        pollsLeft: this.scanPolls,
        malicious: this.maliciousUrls.has(url),
      });
      return {
        uuid,
        api: `https://api.cloudflare.com/client/v4${base}/result/${uuid}`,
        result: `https://radar.cloudflare.com/scan/${uuid}`,
        url,
        visibility,
        message: "Submission successful",
      };
    };
    fake.route("POST", `${base}/scan`, (request) => {
      const made = submit(request.body as Record<string, unknown> | null);
      return made === null
        ? serviceError(400, "url must be an http(s) URL")
        : fake.answers.raw(200, made);
    });
    fake.route("POST", `${base}/bulk`, (request) => {
      const items = request.body;
      if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
        return serviceError(400, "bulk takes 1 to 100 scans");
      }
      const made = items.map((item) => submit(item));
      return made.includes(null)
        ? serviceError(400, "url must be an http(s) URL")
        : fake.answers.raw(200, made);
    });
    fake.route("GET", `${base}/result/${UUID}`, (_request, [uuid]) => {
      const scan = this.#scans.get(uuid);
      if (scan === undefined) return serviceError(404, "Scan not found");
      if (scan.pollsLeft > 0) {
        scan.pollsLeft--;
        return serviceError(404, "Scan is not finished yet.", {
          uuid,
          url: scan.url,
          status: "InProgress",
          time: scan.time,
          visibility: scan.visibility,
        });
      }
      scan.result ??= this.#resultOf(scan);
      return fake.answers.raw(200, scan.result);
    });
    fake.route("GET", `${base}/search`, (request) => {
      const q = request.query.get("q") ?? "";
      const domain = /page\.domain:"?([^"\s]+)"?/.exec(q)?.[1];
      const malicious = /verdicts\.malicious:true/.test(q);
      const size = Number(request.query.get("size") ?? "100");
      const results = [...this.#scans.values()]
        .filter((scan) => scan.pollsLeft === 0)
        .map((scan) => (scan.result ??= this.#resultOf(scan)))
        .filter((result) =>
          (domain === undefined || result.page?.domain === domain) &&
          (!malicious || result.verdicts?.overall?.malicious === true)
        )
        .slice(0, size)
        .map((result) => ({
          _id: result.task.uuid,
          result: `https://radar.cloudflare.com/scan/${result.task.uuid}`,
          task: result.task,
          page: result.page,
          verdicts: { malicious: result.verdicts?.overall?.malicious ?? false },
        }));
      return fake.answers.raw(200, { results });
    });
    const finished = (uuid: string, answer: () => Answer) => {
      const scan = this.#scans.get(uuid);
      if (scan === undefined || scan.pollsLeft > 0) {
        return serviceError(404, "Scan not found or not finished");
      }
      return answer();
    };
    fake.route(
      "GET",
      `${base}/screenshots/${UUID}\\.png`,
      (_request, [uuid]) =>
        finished(uuid, () => ({
          status: 200,
          body: PNG,
          headers: { "content-type": "image/png" },
        })),
    );
    fake.route(
      "GET",
      `${base}/har/${UUID}`,
      (_request, [uuid]) =>
        finished(uuid, () =>
          fake.answers.raw(200, {
            log: {
              version: "1.2",
              creator: { name: "fake" },
              pages: [],
              entries: [],
            },
          })),
    );
    fake.route(
      "GET",
      `${base}/dom/${UUID}`,
      (_request, [uuid]) =>
        finished(uuid, () => ({
          status: 200,
          body: "<html><body>fake</body></html>",
          headers: { "content-type": "text/plain" },
        })),
    );
  }

  #resultOf(scan: Scan): ScanResult {
    const url = new URL(scan.url);
    return {
      task: {
        uuid: scan.uuid,
        url: scan.url,
        domain: url.hostname,
        time: scan.time,
        visibility: scan.visibility,
        success: true,
      },
      page: {
        url: scan.url,
        domain: url.hostname,
        ip: "192.0.2.10",
        asn: "AS64496",
        country: "US",
        status: 200,
        title: "Fake page",
      },
      verdicts: {
        overall: {
          malicious: scan.malicious,
          categories: scan.malicious ? ["Phishing"] : [],
          tags: [],
          hasVerdicts: scan.malicious,
        },
      },
      stats: { requests: [], uniqCountries: 1 },
      lists: { domains: [url.hostname], ips: ["192.0.2.10"] },
      meta: { processors: {} },
      data: { requests: [], cookies: [], console: [] },
    };
  }

  #uuid(): string {
    this.#serial++;
    return `5ca40000-0000-4000-8000-${
      this.#serial.toString(16).padStart(12, "0")
    }`;
  }
}
