// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Outbound HTTP under a policy, imported as "@celld/http/egress".
 *
 * ```ts
 * import { boundedFetch } from "@celld/http/egress";
 * import { bytes, millis } from "@celld/core/bounds";
 *
 * const get = boundedFetch({
 *   allow: (url) => url.hostname === "issuer.example",
 *   redirects: 0,
 *   timeoutMs: millis(5_000),
 *   maxBytes: bytes(64 * 1024),
 *   json: { maxDepth: 8, maxKeys: 64, maxItems: 100 },
 *   network: "public",
 * });
 * const metadata: unknown = await (await get(url)).json();
 * ```
 *
 * Before every request, the first and each redirect hop, the URL must have
 * no credentials and no fragment, must be `https:` (or `http:` to a
 * loopback IP literal, only with `allowCleartextLoopbackForDevelopment`),
 * must name a host the `network` mode allows, and `allow(url, hop)` must
 * return `true`. Redirects are followed by hand (`redirect: "manual"`), up
 * to `redirects` hops, without loops, and the first time a hop changes
 * origin every header but {@link CROSS_ORIGIN_HEADERS} is dropped for the
 * rest of the chain, since any other header may carry a credential
 * (`Authorization`, `Cookie`, `DPoP`, `X-API-Key`, ...). A redirect that
 * would send the request body to another origin than the first request's
 * (a 307 or 308, or a 301 or 302 after a method other than POST) is refused
 * unless the policy sets `unsafeResendBodyCrossOrigin`, since the body may
 * carry a credential too. Methods are normalized as `fetch` does (`post`
 * is `POST`). One deadline covers the
 * whole operation, body included, and aborts it; a caller's signal aborts
 * it too. The response has no raw body: `bytes()`, `text()` and `json()`
 * read at most `maxBytes` and parse JSON under limits, and `stream()`
 * passes at most `maxBytes` through as they arrive.
 *
 * **What the address policy can see.** `network` is enforced on the host
 * as written in the URL: IP literals (including IPv4-mapped, NAT64 and 6to4
 * IPv6 forms), `localhost` and the usual loopback aliases, and the names
 * reserved for local networks (`.local`, `.internal`, `.home.arpa`,
 * `.localdomain`), on the first request and on every redirect hop. A DNS name is resolved by the platform when `fetch`
 * connects, and this runtime (Workers, Deno) has no hook to inspect or pin
 * the address it resolves to. A name whose DNS points at a private address
 * therefore passes the check. Where that matters, restrict names with
 * `allow` (an allow list of known hosts) and rely on the platform's own
 * egress controls for resolved addresses.
 *
 * @module
 */

import {
  BoundsError,
  type ByteLimit,
  type DurationMs,
  MAX_JSON_DEPTH,
  nonNegativeMs,
  parseJsonBounded,
  readBounded,
  safeInt,
  strictRecord,
} from "@celld/core/bounds";
import { type IpAddress, parseCidr, parseIp } from "@celld/core/ip";
import { type FetchLike, globalFetch, rejectOnAbort } from "./runtime.ts";

/**
 * Which addresses a request may reach, judged on the URL's host:
 *
 * - `public`: public IP literals and DNS names other than loopback and
 *   local-network names (see {@link classifyHost});
 * - `loopback`: those plus loopback (`127.0.0.0/8`, `::1`, `localhost` and
 *   its aliases), for development and local sidecars;
 * - `any`: every host, including private and link-local ranges.
 *
 * The network never switches cleartext on: `http:` also needs
 * {@link EgressPolicy.allowCleartextLoopbackForDevelopment}.
 */
export type EgressNetwork = "public" | "loopback" | "any";

/** Limits for `json()`; see `@celld/core/bounds`'s `parseJsonBounded`. */
export interface EgressJsonLimits {
  readonly maxDepth: number;
  readonly maxKeys: number;
  readonly maxItems: number;
}

/**
 * A fetch allowance shared by every request of one operation (a discovery,
 * a chain resolution). Each attempt, redirect hops included, takes one;
 * none left is an error. The object is decremented in place, so give each
 * operation its own.
 */
export interface EgressBudget {
  fetches: number;
}

/** What {@link boundedFetch} allows. */
export interface EgressPolicy {
  /**
   * Called with a copy of each URL about to be fetched and its hop (0 for
   * the first request); anything but `true` refuses it.
   */
  readonly allow: (url: URL, hop: number) => boolean;
  /** The most redirects followed, up to 20; 0 refuses every redirect. */
  readonly redirects: number;
  /** The deadline for the whole operation, body included; at least 1 ms. */
  readonly timeoutMs: DurationMs;
  /** The most body bytes read. */
  readonly maxBytes: ByteLimit;
  /** Limits for `json()`; {@link DEFAULT_JSON_LIMITS} when absent. */
  readonly json?: EgressJsonLimits;
  /** Which hosts may be reached; see {@link EgressNetwork}. */
  readonly network: EgressNetwork;
  /**
   * Allows `http:` to a loopback IP literal (`127.0.0.0/8`, `[::1]`; never
   * a name such as `localhost`), for a fake server in development and
   * tests. Default false: every request is `https:`. It needs a `network`
   * that reaches loopback (`"loopback"` or `"any"`).
   */
  readonly allowCleartextLoopbackForDevelopment?: boolean;
  /** A fetch allowance to draw from; none when absent. */
  readonly budget?: EgressBudget;
  /**
   * Lets a redirect that keeps the request body (a 307 or 308, or a 301 or
   * 302 after a method other than POST) send that body to another origin.
   * Default false: such a redirect is refused (`redirect`) before the
   * target is fetched, since a body may carry a credential (a client
   * secret, an authorization code) meant for the first origin only.
   */
  readonly unsafeResendBodyCrossOrigin?: boolean;
}

/** The JSON limits used when a policy gives none. */
export const DEFAULT_JSON_LIMITS: EgressJsonLimits = Object.freeze({
  maxDepth: 32,
  maxKeys: 1000,
  maxItems: 10_000,
});

/** The largest `redirects` a policy may set. */
export const MAX_REDIRECTS = 20;

/**
 * Why a bounded fetch failed:
 *
 * - `url`: not a URL, or it has credentials or a fragment;
 * - `scheme`: not `https:`, and not `http:` to a loopback literal under
 *   `allowCleartextLoopbackForDevelopment`;
 * - `network`: the host is outside the policy's `network`;
 * - `denied`: `allow` did not return `true`;
 * - `redirect`: a redirect was refused (none allowed, too many, a loop, a
 *   bad `Location`, a streamed body that cannot be resent, a body that
 *   would go to another origin);
 * - `timeout`: the deadline passed;
 * - `aborted`: the caller's signal aborted (the reason is the `cause`), or
 *   `discard()` cancelled a stream being read;
 * - `budget`: the fetch budget ran out;
 * - `fetch`: `fetch` itself failed (the `cause`);
 * - `too_large`: the body passed `maxBytes`;
 * - `json`: the body is not JSON within the limits;
 * - `used`: the body was already read.
 */
export type EgressCode =
  | "url"
  | "scheme"
  | "network"
  | "denied"
  | "redirect"
  | "timeout"
  | "aborted"
  | "budget"
  | "fetch"
  | "too_large"
  | "json"
  | "used";

/** A refused or failed bounded fetch; `code` says why. */
export class EgressError extends Error {
  override name = "EgressError";
  readonly code: EgressCode;

  constructor(code: EgressCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

/** A response whose body can only be read under the policy's caps. */
export interface BoundedResponse {
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly headers: Headers;
  /** The URL that answered, after any redirects. */
  readonly url: string;
  /** Whether a redirect was followed. */
  readonly redirected: boolean;
  /** The body, at most `maxBytes`. */
  bytes(): Promise<Uint8Array<ArrayBuffer>>;
  /** The body as UTF-8, at most `maxBytes`. */
  text(): Promise<string>;
  /** The body as JSON under the policy's limits, as `unknown`. */
  json(): Promise<unknown>;
  /**
   * The body as a stream, for answers read as they arrive (server-sent
   * events). It errors with an {@link EgressError} once more than
   * `maxBytes` have passed through (`too_large`) or at the deadline
   * (`timeout`, `aborted`), cancelling the body either way; the deadline
   * ends when the stream is read to the end or cancelled.
   *
   * @throws {EgressError} (`used`) when the body was already read.
   */
  stream(): ReadableStream<Uint8Array>;
  /**
   * Cancels the body and ends the deadline. Call it when the body is not
   * read, or the deadline timer runs on until it fires. After `stream()`,
   * it cancels that stream: a pending or later read errors with an
   * {@link EgressError} (`aborted`), and the body is cancelled.
   */
  discard(): Promise<void>;
}

/** `fetch`'s signature, answering with a {@link BoundedResponse}. */
export type BoundedFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<BoundedResponse>;

// ----- host classification -----

/** How a URL host is classified for {@link EgressNetwork}. */
export type HostClass = "public" | "loopback" | "local" | "name";

const cidrs = (list: string[]) => list.map((text) => parseCidr(text)!);
const V4_LOOPBACK = cidrs(["127.0.0.0/8"]);
const V4_LOCAL = cidrs([
  "0.0.0.0/8", // "this network", including the unspecified address
  "10.0.0.0/8",
  "100.64.0.0/10", // shared address space (CGNAT)
  "169.254.0.0/16", // link-local, cloud metadata
  "172.16.0.0/12",
  "192.0.0.0/24", // IETF protocol assignments
  "192.0.2.0/24", // documentation
  "192.88.99.0/24", // 6to4 relay anycast
  "192.168.0.0/16",
  "198.18.0.0/15", // benchmarking
  "198.51.100.0/24", // documentation
  "203.0.113.0/24", // documentation
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved, including broadcast
]);
const V6_GLOBAL = parseCidr("2000::/3")!;
const V6_NAT64 = parseCidr("64:ff9b::/96")!;
const V6_6TO4 = parseCidr("2002::/16")!;
const V6_LOCAL = cidrs([
  "2001::/23", // IETF protocol assignments, including Teredo
  "2001:db8::/32", // documentation
  "3fff::/20", // documentation
]);

function classifyV4(address: IpAddress): Exclude<HostClass, "name"> {
  if (V4_LOOPBACK.some((block) => block.contains(address))) return "loopback";
  if (V4_LOCAL.some((block) => block.contains(address))) return "local";
  return "public";
}

function classifyIp(address: IpAddress): Exclude<HostClass, "name"> {
  if (address.version === 4) return classifyV4(address);
  const bytes = address.bytes;
  const mapped = address.toIpv4();
  if (mapped !== null) return classifyV4(mapped);
  // Forms that carry an IPv4 address reach it: judge it by that address.
  if (V6_NAT64.contains(address)) {
    return classifyV4(parseIp(bytes.subarray(12).join("."))!);
  }
  if (V6_6TO4.contains(address)) {
    return classifyV4(parseIp(bytes.subarray(2, 6).join("."))!);
  }
  if (bytes.subarray(0, 15).every((b) => b === 0) && bytes[15] === 1) {
    return "loopback";
  }
  // Only global unicast is public; that excludes ::, IPv4-compatible
  // addresses, ULA (fc00::/7), link-local (fe80::/10), site-local and
  // multicast (ff00::/8).
  if (!V6_GLOBAL.contains(address)) return "local";
  if (V6_LOCAL.some((block) => block.contains(address))) return "local";
  return "public";
}

/** Names that hosts files and resolvers map to a loopback address. */
const LOOPBACK_NAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "localhost4",
  "localhost4.localdomain4",
  "localhost6",
  "localhost6.localdomain6",
  "ip6-localhost",
  "ip6-loopback",
]);
/** Suffixes reserved or used for local networks, never the public DNS. */
const LOCAL_SUFFIXES = [".local", ".internal", ".home.arpa", ".localdomain"];

/**
 * Classifies a URL host (`URL.hostname`, brackets allowed): `loopback`,
 * `local` (private, link-local, multicast, unspecified, reserved and
 * documentation ranges) or `public` for an IP literal; `loopback` for
 * `localhost`, `*.localhost` and the loopback aliases of hosts files
 * (`localhost.localdomain`, `localhost6`, `ip6-localhost`, ...); `local` for
 * names under `.local`, `.internal`, `.home.arpa` and `.localdomain`; `name`
 * for any other DNS name, whose address is unknown until it is resolved.
 * Trailing dots are ignored. This is hardening, not a guarantee: any name
 * can resolve to a private address (see the module notes).
 */
export function classifyHost(hostname: string): HostClass {
  const host = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  const address = parseIp(host);
  if (address !== null) return classifyIp(address);
  const name = host.toLowerCase().replace(/\.+$/, "");
  if (LOOPBACK_NAMES.has(name) || name.endsWith(".localhost")) {
    return "loopback";
  }
  if (LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix))) return "local";
  return "name";
}

// ----- policy -----

interface Resolved {
  readonly allow: (url: URL, hop: number) => boolean;
  readonly redirects: number;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly json: EgressJsonLimits;
  readonly network: EgressNetwork;
  readonly cleartext: boolean;
  readonly budget: EgressBudget | undefined;
  readonly resendBodyCrossOrigin: boolean;
}

function resolvePolicy(policy: EgressPolicy): Resolved {
  strictRecord(policy as unknown, [
    "allow",
    "redirects",
    "timeoutMs",
    "maxBytes",
    "json",
    "network",
    "allowCleartextLoopbackForDevelopment",
    "budget",
    "unsafeResendBodyCrossOrigin",
  ], "egress policy");
  if (typeof policy?.allow !== "function") {
    throw new TypeError("egress policy: allow must be a function");
  }
  const network = policy.network;
  if (network !== "public" && network !== "loopback" && network !== "any") {
    throw new RangeError(
      `egress policy: network must be "public", "loopback" or "any", got ${
        String(network)
      }`,
    );
  }
  const cleartext = policy.allowCleartextLoopbackForDevelopment ?? false;
  if (typeof cleartext !== "boolean") {
    throw new TypeError(
      "egress policy: allowCleartextLoopbackForDevelopment must be a boolean",
    );
  }
  if (cleartext && network === "public") {
    throw new RangeError(
      'egress policy: allowCleartextLoopbackForDevelopment needs a network that reaches loopback ("loopback" or "any")',
    );
  }
  const resendBodyCrossOrigin = policy.unsafeResendBodyCrossOrigin ?? false;
  if (typeof resendBodyCrossOrigin !== "boolean") {
    throw new TypeError(
      "egress policy: unsafeResendBodyCrossOrigin must be a boolean",
    );
  }
  const json = policy.json ?? DEFAULT_JSON_LIMITS;
  strictRecord(
    json as unknown,
    ["maxDepth", "maxKeys", "maxItems"],
    "egress JSON limits",
  );
  const budget = policy.budget;
  if (budget !== undefined) {
    strictRecord(budget as unknown, ["fetches"], "egress budget");
    safeInt(budget?.fetches, { name: "budget.fetches", min: 0 });
  }
  return Object.freeze({
    allow: policy.allow,
    redirects: safeInt(policy.redirects, {
      name: "redirects",
      min: 0,
      max: MAX_REDIRECTS,
    }),
    timeoutMs: nonNegativeMs(policy.timeoutMs, { name: "timeoutMs", min: 1 }),
    maxBytes: safeInt(policy.maxBytes, { name: "maxBytes", min: 0 }),
    json: Object.freeze({
      maxDepth: safeInt(json.maxDepth, {
        name: "json.maxDepth",
        min: 0,
        max: MAX_JSON_DEPTH,
      }),
      maxKeys: safeInt(json.maxKeys, { name: "json.maxKeys", min: 0 }),
      maxItems: safeInt(json.maxItems, { name: "json.maxItems", min: 0 }),
    }),
    network,
    cleartext,
    budget,
    resendBodyCrossOrigin,
  });
}

function check(policy: Resolved, url: URL, hop: number): void {
  const where = hop === 0 ? "" : ` (redirect ${hop})`;
  if (url.username !== "" || url.password !== "") {
    throw new EgressError("url", `the URL has credentials${where}`);
  }
  // Any "#" in a serialized URL starts the fragment, even an empty one.
  if (url.href.includes("#")) {
    throw new EgressError("url", `the URL has a fragment${where}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new EgressError(
      "scheme",
      `${url.protocol} is not allowed${where}`,
    );
  }
  const host = url.hostname;
  const kind = classifyHost(host);
  if (url.protocol === "http:") {
    const literal = parseIp(host.replace(/^\[(.*)\]$/, "$1")) !== null;
    if (!(literal && kind === "loopback" && policy.cleartext)) {
      throw new EgressError(
        "scheme",
        `http: is allowed only to a loopback IP literal, and only with allowCleartextLoopbackForDevelopment; got ${host}${where}`,
      );
    }
  }
  const allowed = policy.network === "any" ||
    kind === "public" || kind === "name" ||
    (kind === "loopback" && policy.network === "loopback");
  if (!allowed) {
    throw new EgressError(
      "network",
      `${host} is a ${kind} address, outside the "${policy.network}" network${where}`,
    );
  }
  let verdict: unknown;
  try {
    verdict = policy.allow(new URL(url.href), hop);
  } catch (cause) {
    throw new EgressError("denied", `allow threw for ${url.origin}${where}`, {
      cause,
    });
  }
  if (verdict !== true) {
    throw new EgressError("denied", `allow refused ${url.origin}${where}`);
  }
}

// ----- requests -----

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/**
 * The request headers kept once a redirect changes origin; every other
 * header is dropped for the rest of the chain. The list is closed rather
 * than a list of known credentials because any header may carry one
 * (`Authorization`, `Cookie`, `DPoP`, `X-API-Key`, a vendor's own), and a
 * header left off it costs a redirect target nothing it needs. The body
 * headers stay only while the body does (a 307 or 308).
 */
export const CROSS_ORIGIN_HEADERS: readonly string[] = Object.freeze([
  "accept",
  "accept-language",
  "cache-control",
  "content-encoding",
  "content-language",
  "content-type",
  "pragma",
  "user-agent",
]);
const KEPT_CROSS_ORIGIN = new Set(CROSS_ORIGIN_HEADERS);
const BODY_HEADERS = [
  "content-type",
  "content-length",
  "content-encoding",
  "content-language",
  "content-location",
];

interface Outgoing {
  url: string;
  method: string;
  headers: Headers;
  body: BodyInit | null;
  signal: AbortSignal | null;
}

/** The methods `fetch` upper-cases, whatever their case as given. */
const NORMALIZED_METHODS = new Set([
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "POST",
  "PUT",
]);

function normalizeMethod(method: string): string {
  const upper = method.toUpperCase();
  return NORMALIZED_METHODS.has(upper) ? upper : method;
}

function outgoing(input: string | URL | Request, init: RequestInit): Outgoing {
  if (input instanceof Request) {
    return {
      url: input.url,
      method: normalizeMethod(init.method ?? input.method),
      headers: new Headers(init.headers ?? input.headers),
      body: init.body !== undefined ? init.body : input.body,
      signal: init.signal ?? input.signal,
    };
  }
  return {
    url: String(input),
    method: normalizeMethod(init.method ?? "GET"),
    headers: new Headers(init.headers),
    body: init.body ?? null,
    signal: init.signal ?? null,
  };
}

function cancelBody(response: Response): void {
  try {
    response.body?.cancel().catch(() => {});
  } catch {
    // Already locked or used; nothing to release.
  }
}

class Deadline {
  readonly controller = new AbortController();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #caller: AbortSignal | null;
  #onAbort = () => {
    this.controller.abort(
      new EgressError("aborted", "the caller aborted the request", {
        cause: this.#caller!.reason,
      }),
    );
  };

  constructor(timeoutMs: number, caller: AbortSignal | null) {
    this.#caller = caller;
    this.#timer = setTimeout(() => {
      this.controller.abort(
        new EgressError(
          "timeout",
          `no complete response within ${timeoutMs} ms`,
        ),
      );
    }, timeoutMs);
    if (caller?.aborted) this.#onAbort();
    else caller?.addEventListener("abort", this.#onAbort, { once: true });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  end(): void {
    clearTimeout(this.#timer);
    this.#caller?.removeEventListener("abort", this.#onAbort);
  }
}

class Bounded implements BoundedResponse {
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly headers: Headers;
  readonly url: string;
  readonly redirected: boolean;
  readonly #response: Response;
  readonly #deadline: Deadline;
  readonly #policy: Resolved;
  #used = false;
  /** Cancels the stream handed out by `stream()`, while it is live. */
  #abandon: (() => void) | null = null;

  constructor(
    response: Response,
    url: URL,
    redirected: boolean,
    deadline: Deadline,
    policy: Resolved,
  ) {
    this.status = response.status;
    this.statusText = response.statusText;
    this.ok = response.ok;
    this.headers = response.headers;
    this.url = url.href;
    this.redirected = redirected;
    this.#response = response;
    this.#deadline = deadline;
    this.#policy = policy;
  }

  async bytes(): Promise<Uint8Array<ArrayBuffer>> {
    if (this.#used) {
      throw new EgressError("used", "the body has already been read");
    }
    this.#used = true;
    try {
      return await readBounded(this.#response, {
        maxBytes: this.#policy.maxBytes,
        signal: this.#deadline.signal,
      });
    } catch (error) {
      if (error instanceof EgressError) throw error;
      if (error instanceof BoundsError && error.code === "too_large") {
        throw new EgressError(
          "too_large",
          `the body of ${this.url} is larger than ${this.#policy.maxBytes} bytes`,
          { cause: error },
        );
      }
      throw new EgressError("fetch", `reading the body of ${this.url} failed`, {
        cause: error,
      });
    } finally {
      this.#deadline.end();
    }
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(await this.bytes());
  }

  async json(): Promise<unknown> {
    const text = await this.text();
    try {
      return parseJsonBounded(text, this.#policy.json);
    } catch (cause) {
      throw new EgressError(
        "json",
        `the body of ${this.url} is not JSON within the limits: ${
          (cause as Error).message
        }`,
        { cause },
      );
    }
  }

  stream(): ReadableStream<Uint8Array> {
    if (this.#used) {
      throw new EgressError("used", "the body has already been read");
    }
    this.#used = true;
    const source = this.#response.body;
    const deadline = this.#deadline;
    const max = this.#policy.maxBytes;
    const url = this.url;
    if (source === null) {
      deadline.end();
      return new ReadableStream({ start: (c) => c.close() });
    }
    const reader = source.getReader();
    const signal = deadline.signal;
    let total = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      deadline.end();
    };
    const fail = (
      controller: ReadableStreamDefaultController<Uint8Array>,
      error: unknown,
    ) => {
      finish();
      reader.cancel(error).catch(() => {});
      controller.error(error);
    };
    let active: ReadableStreamDefaultController<Uint8Array> | null = null;
    const onAbort = () => {
      if (active !== null) fail(active, signal.reason);
    };
    this.#abandon = () => {
      if (settled || active === null) return;
      fail(
        active,
        new EgressError("aborted", `the body of ${url} was discarded`),
      );
    };
    return new ReadableStream<Uint8Array>({
      start(controller) {
        active = controller;
        if (signal.aborted) fail(controller, signal.reason);
        else signal.addEventListener("abort", onAbort, { once: true });
      },
      async pull(controller) {
        if (settled) return;
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (cause) {
          if (settled) return;
          fail(
            controller,
            signal.aborted ? signal.reason : new EgressError(
              "fetch",
              `reading the body of ${url} failed`,
              { cause },
            ),
          );
          return;
        }
        if (settled) return;
        if (chunk.done) {
          finish();
          controller.close();
          return;
        }
        total += chunk.value.length;
        if (total > max) {
          fail(
            controller,
            new EgressError(
              "too_large",
              `the body of ${url} is larger than ${max} bytes`,
            ),
          );
          return;
        }
        controller.enqueue(chunk.value);
      },
      cancel(reason) {
        finish();
        return reader.cancel(reason).catch(() => {});
      },
    }, { highWaterMark: 0 });
  }

  discard(): Promise<void> {
    if (!this.#used) {
      this.#used = true;
      cancelBody(this.#response);
    }
    // A live stream ends its own deadline when it is cancelled here.
    this.#abandon?.();
    this.#deadline.end();
    return Promise.resolve();
  }
}

function parseUrl(text: string, base?: URL): URL {
  try {
    return new URL(text, base);
  } catch (cause) {
    throw new EgressError(
      base === undefined ? "url" : "redirect",
      base === undefined ? "not a URL" : `the redirect Location is not a URL`,
      { cause },
    );
  }
}

/**
 * A `fetch` that enforces `policy`; see the module notes. `fetch` defaults
 * to the global one, looked up at call time.
 *
 * The policy is checked and copied here, except `budget`, which stays the
 * caller's object and is decremented in place. `init.redirect` is ignored:
 * every request is sent with `redirect: "manual"`.
 *
 * @throws {RangeError} or {@link BoundsError} for a bad policy, and
 * {@link TypeError} when `allow` is not a function.
 */
export function boundedFetch(
  policy: EgressPolicy,
  fetch: FetchLike = globalFetch,
): BoundedFetch {
  const resolved = resolvePolicy(policy);
  if (typeof fetch !== "function") {
    throw new TypeError("fetch must be a function");
  }
  return async (input, init = {}) => {
    const request = outgoing(input, init);
    const deadline = new Deadline(resolved.timeoutMs, request.signal);
    const { signal } = deadline;
    try {
      let url = parseUrl(request.url);
      const origin = url.origin;
      const visited = new Set<string>();
      for (let hop = 0;; hop++) {
        check(resolved, url, hop);
        visited.add(url.href);
        if (signal.aborted) throw signal.reason;
        const budget = resolved.budget;
        if (budget !== undefined) {
          if (!Number.isSafeInteger(budget.fetches) || budget.fetches < 1) {
            throw new EgressError("budget", "the fetch budget is spent");
          }
          budget.fetches--;
        }
        let response: Response;
        try {
          response = await rejectOnAbort(
            fetch(url.href, {
              method: request.method,
              headers: request.headers,
              body: request.body,
              redirect: "manual",
              signal,
            }).then((response) => {
              // Custom fetches may ignore abort. Never strand their late body.
              if (signal.aborted) cancelBody(response);
              return response;
            }),
            signal,
          );
        } catch (cause) {
          if (signal.aborted) throw signal.reason;
          throw new EgressError("fetch", `fetching ${url.origin} failed`, {
            cause,
          });
        }
        if (response.type === "opaqueredirect") {
          throw new EgressError(
            "redirect",
            `${url.origin} redirected and the platform hid the target`,
          );
        }
        const location = REDIRECTS.has(response.status)
          ? response.headers.get("location")
          : null;
        if (location === null) {
          return new Bounded(response, url, hop > 0, deadline, resolved);
        }
        cancelBody(response);
        if (resolved.redirects === 0) {
          throw new EgressError(
            "redirect",
            `${url.origin} redirected (${response.status}); redirects are refused`,
          );
        }
        if (hop >= resolved.redirects) {
          throw new EgressError(
            "redirect",
            `more than ${resolved.redirects} redirects`,
          );
        }
        const next = parseUrl(location, url);
        if (visited.has(next.href)) {
          throw new EgressError("redirect", `a redirect loop at ${next.href}`);
        }
        const status = response.status;
        if (
          (status === 303 && request.method !== "HEAD") ||
          ((status === 301 || status === 302) && request.method === "POST")
        ) {
          request.method = "GET";
          request.body = null;
          for (const name of BODY_HEADERS) request.headers.delete(name);
        } else if (request.body instanceof ReadableStream) {
          throw new EgressError(
            "redirect",
            `a ${status} redirect needs the request body again, and a stream cannot be resent`,
          );
        } else if (
          request.body !== null && next.origin !== origin &&
          !resolved.resendBodyCrossOrigin
        ) {
          throw new EgressError(
            "redirect",
            `a cross-origin redirect (${status}) from ${origin} to ${next.origin} would resend the request body`,
          );
        }
        if (next.origin !== url.origin) {
          for (const name of [...request.headers.keys()]) {
            if (!KEPT_CROSS_ORIGIN.has(name)) request.headers.delete(name);
          }
        }
        url = next;
      }
    } catch (error) {
      deadline.end();
      if (error instanceof EgressError) throw error;
      throw new EgressError("fetch", "the request failed", { cause: error });
    }
  };
}
