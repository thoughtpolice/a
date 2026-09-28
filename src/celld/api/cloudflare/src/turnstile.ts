// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/api/cloudflare/turnstile`: Turnstile widgets, and checking the
 * tokens they hand out.
 *
 * ```ts
 * const verdict = await verifyTurnstile({
 *   secret: env.TURNSTILE_SECRET,
 *   token: form.get("cf-turnstile-response"),
 *   remoteip: request.headers.get("cf-connecting-ip") ?? undefined,
 *   expectedHostname: "example.com",
 *   expectedAction: "signup",
 * });
 * if (!verdict.success) return new Response("challenge failed", { status: 403 });
 * ```
 *
 * `verifyTurnstile` calls siteverify, which is not the v4 API: it lives on
 * `challenges.cloudflare.com`, takes the widget's secret (not an API
 * token) in the body, and answers without the envelope. A header-injecting
 * exe.dev integration cannot hold that secret, so it is a Worker secret.
 *
 * Managing widgets needs a user API token with `Account > Turnstile >
 * Edit`: Cloudflare does not accept account-owned tokens (`cfat_...`) for
 * Turnstile.
 *
 * @module
 */

import { BoundsError, readBounded } from "@celld/core/bounds";
import {
  backoffDelay,
  defaultRuntime,
  type FetchLike,
  globalFetch,
  type HttpRetryPolicy,
  mayRetry,
  rejectOnAbort,
  resolveRetryPolicy,
  type RetryFailure,
  type RetryOptions,
  type Runtime,
} from "@celld/http";
import type {
  CloudflareClient,
  ListOptions,
  RequestOptions,
} from "./client.ts";
import { CloudflareError } from "./errors.ts";
import { cloudflareId, pathToken } from "./ids.ts";

type Call = Omit<RequestOptions, "body" | "query">;

export const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** The longest token Turnstile issues. */
export const MAX_TOKEN_LENGTH = 2048;

/** How long a token is valid after its challenge. */
export const TOKEN_LIFETIME_MS = 300_000;

/**
 * Cloudflare's documented test keys, which work on any hostname
 * (including localhost). A test secret accepts only the dummy token
 * `XXXX.DUMMY.TOKEN.XXXX` that the test sitekeys issue.
 */
export const TEST_KEYS = Object.freeze({
  sitekeys: Object.freeze({
    alwaysPasses: "1x00000000000000000000AA",
    alwaysBlocks: "2x00000000000000000000AB",
    invisiblePasses: "1x00000000000000000000BB",
    invisibleBlocks: "2x00000000000000000000BB",
    forcesInteractive: "3x00000000000000000000FF",
  }),
  secrets: Object.freeze({
    alwaysPasses: "1x0000000000000000000000000000000AA",
    alwaysFails: "2x0000000000000000000000000000000AA",
    alreadySpent: "3x0000000000000000000000000000000AA",
  }),
  dummyToken: "XXXX.DUMMY.TOKEN.XXXX",
});

/** Siteverify's error codes, and the ones `verifyTurnstile` adds. */
export type TurnstileErrorCode =
  | "missing-input-secret"
  | "invalid-input-secret"
  | "missing-input-response"
  | "invalid-input-response"
  | "bad-request"
  | "timeout-or-duplicate"
  | "internal-error"
  /** Added: the token was issued for another hostname. */
  | "hostname-mismatch"
  /** Added: the token was issued for another action. */
  | "action-mismatch"
  /** Added: the challenge was solved longer ago than `maxAgeMs`. */
  | "challenge-too-old"
  | string;

/** What siteverify said about a token, after the caller's checks. */
export interface TurnstileVerdict {
  /** Siteverify accepted it and it passed every check asked for. */
  readonly success: boolean;
  readonly errorCodes: readonly TurnstileErrorCode[];
  /** Where the challenge was solved. */
  readonly hostname?: string;
  /** When, as siteverify wrote it (ISO 8601). */
  readonly challengeTs?: string;
  readonly action?: string;
  readonly cdata?: string;
  /** The visitor's ephemeral id, on plans that have it. */
  readonly ephemeralId?: string;
  /** Siteverify answered for one of the documented test secrets. */
  readonly testingKey?: boolean;
  /** Siteverify's answer as sent. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** Options of {@link verifyTurnstile}. */
export interface TurnstileVerifyOptions {
  /** The widget's secret key. */
  readonly secret: string;
  /** The form's `cf-turnstile-response`; null or empty fails without a request. */
  readonly token: string | null | undefined;
  /** The visitor's IP address (`CF-Connecting-IP`), which siteverify checks. */
  readonly remoteip?: string;
  /**
   * Sent as `idempotency_key`: siteverify answers a repeated key with its
   * first answer, so a verification whose answer was lost can be asked
   * again. Default: a fresh UUID per call.
   */
  readonly idempotencyKey?: string;
  /** The hostname (or hostnames) the widget must have run on. */
  readonly expectedHostname?: string | readonly string[];
  /** The widget's `action` the token must carry. */
  readonly expectedAction?: string;
  /** Refuse a challenge solved longer ago than this; default the token lifetime. */
  readonly maxAgeMs?: number;
  /** Siteverify's URL, for a fake; `https:` unless loopback is allowed. */
  readonly siteverifyUrl?: string;
  readonly allowLoopbackForDevelopment?: boolean;
  readonly signal?: AbortSignal;
  /** Per attempt; default 10 s. */
  readonly timeoutMs?: number;
  readonly retry?: RetryOptions;
  readonly fetch?: FetchLike;
  readonly runtime?: Runtime;
}

const VERIFY_RETRY: HttpRetryPolicy = Object.freeze({
  maxRetries: 2,
  backoffInitialMs: 200,
  backoffMaxMs: 2_000,
  backoffJitter: 0.5,
  respectRetryAfter: true,
  maxRetryAfterMs: 5_000,
  budgetMs: 20_000,
  statuses: Object.freeze([429, 500, 502, 503, 504]),
  retryConnectionErrors: true,
  retryTimeouts: true,
});
const MAX_VERIFY_BYTES = 64 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * Checks a Turnstile token with siteverify, and against the hostname,
 * action and age asked for. A token siteverify refuses is a verdict with
 * `success: false`, not an error.
 *
 * @throws {CloudflareError} when siteverify cannot be asked (the network,
 *   a timeout, a 5xx after retries): the caller decides whether that
 *   fails closed.
 */
export async function verifyTurnstile(
  options: TurnstileVerifyOptions,
): Promise<TurnstileVerdict> {
  const token = options.token ?? "";
  if (typeof options.secret !== "string" || options.secret === "") {
    return refused("missing-input-secret");
  }
  if (token === "") return refused("missing-input-response");
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) {
    return refused("invalid-input-response");
  }
  const url = siteverifyUrl(options);
  const runtime = options.runtime ?? defaultRuntime;
  const policy = resolveRetryPolicy(options.retry, VERIFY_RETRY);
  const form = new URLSearchParams({
    secret: options.secret,
    response: token,
    idempotency_key: options.idempotencyKey ?? crypto.randomUUID(),
  });
  if (options.remoteip !== undefined && options.remoteip !== "") {
    form.set("remoteip", options.remoteip);
  }
  const body = form.toString();
  const started = runtime.now();
  for (let retry = 0;; retry++) {
    const outcome = await attempt(url, body, options, runtime);
    if ("raw" in outcome) {
      return judge(outcome.raw, options, runtime.now());
    }
    const delay = backoffDelay(policy, retry, runtime.random());
    const inBudget = policy.budgetMs === null ||
      runtime.now() + delay - started < policy.budgetMs;
    // The idempotency key makes a second ask answer as the first did.
    if (
      retry >= policy.maxRetries || !inBudget ||
      !mayRetry(policy, outcome.failure, { idempotent: true })
    ) throw outcome.error;
    await runtime.sleep(delay, options.signal);
  }
}

async function attempt(
  url: string,
  body: string,
  options: TurnstileVerifyOptions,
  runtime: Runtime,
): Promise<
  | { raw: Record<string, unknown> }
  | { failure: RetryFailure; error: CloudflareError }
> {
  const outer = options.signal;
  outer?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const onAbort = () => controller.abort(outer!.reason);
  outer?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const cancel = runtime.setTimer(timeoutMs, () => {
    timedOut = true;
    controller.abort(new DOMException("siteverify timed out", "TimeoutError"));
  });
  const signal = controller.signal;
  try {
    let response: Response;
    try {
      response = await rejectOnAbort(
        (options.fetch ?? globalFetch)(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
          signal,
        }),
        signal,
      );
    } catch (error) {
      if (outer?.aborted) throw outer.reason;
      return {
        failure: timedOut ? { kind: "timeout" } : { kind: "connection" },
        error: new CloudflareError(
          timedOut ? "timeout" : "network",
          timedOut
            ? `siteverify did not answer within ${timeoutMs} ms`
            : `siteverify could not be reached: ${
              error instanceof Error ? error.message : String(error)
            }`,
          { cause: error },
        ),
      };
    }
    let bytes: Uint8Array;
    try {
      bytes = await rejectOnAbort(
        readBounded(response, { maxBytes: MAX_VERIFY_BYTES, signal }),
        signal,
      );
    } catch (error) {
      if (outer?.aborted) throw outer.reason;
      return {
        failure: error instanceof BoundsError
          ? { kind: "status", status: response.status }
          : { kind: "body" },
        error: new CloudflareError(
          error instanceof BoundsError ? "too-large" : "network",
          `siteverify's answer could not be read`,
          { status: response.status, cause: error },
        ),
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      parsed = undefined;
    }
    const record = parsed !== null && typeof parsed === "object" &&
        !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
    if (record !== undefined && typeof record.success === "boolean") {
      return { raw: record };
    }
    return {
      failure: { kind: "status", status: response.status },
      error: new CloudflareError(
        response.ok ? "response" : "http",
        `siteverify answered ${response.status} without a verdict`,
        { status: response.status },
      ),
    };
  } finally {
    cancel();
    outer?.removeEventListener("abort", onAbort);
  }
}

function judge(
  raw: Record<string, unknown>,
  options: TurnstileVerifyOptions,
  now: number,
): TurnstileVerdict {
  const codes = Array.isArray(raw["error-codes"])
    ? (raw["error-codes"] as unknown[]).filter((code): code is string =>
      typeof code === "string"
    )
    : [];
  const text = (key: string) =>
    typeof raw[key] === "string" ? raw[key] as string : undefined;
  const metadata = raw.metadata as {
    ephemeral_id?: unknown;
    result_with_testing_key?: unknown;
  } | undefined;
  const verdict = {
    hostname: text("hostname"),
    challengeTs: text("challenge_ts"),
    action: text("action"),
    cdata: text("cdata"),
    ephemeralId: typeof metadata?.ephemeral_id === "string"
      ? metadata.ephemeral_id
      : undefined,
    testingKey: metadata?.result_with_testing_key === true ? true : undefined,
    raw: Object.freeze({ ...raw }),
  };
  let success = raw.success === true;
  if (success) {
    const expected = options.expectedHostname;
    const hostnames = expected === undefined
      ? null
      : typeof expected === "string"
      ? [expected]
      : expected;
    if (
      hostnames !== null &&
      !hostnames.some((host) =>
        host.toLowerCase() === verdict.hostname?.toLowerCase()
      )
    ) {
      codes.push("hostname-mismatch");
    }
    if (
      options.expectedAction !== undefined &&
      verdict.action !== options.expectedAction
    ) {
      codes.push("action-mismatch");
    }
    const solved = verdict.challengeTs === undefined
      ? NaN
      : Date.parse(verdict.challengeTs);
    const maxAge = options.maxAgeMs ?? TOKEN_LIFETIME_MS;
    if (!Number.isFinite(solved) || now - solved > maxAge) {
      codes.push("challenge-too-old");
    }
    success = codes.length === 0;
  } else if (codes.length === 0) {
    codes.push("invalid-input-response");
  }
  return Object.freeze({
    success,
    errorCodes: Object.freeze(codes),
    ...Object.fromEntries(
      Object.entries(verdict).filter(([, value]) => value !== undefined),
    ),
  }) as TurnstileVerdict;
}

function refused(code: TurnstileErrorCode): TurnstileVerdict {
  return Object.freeze({
    success: false,
    errorCodes: Object.freeze([code]),
    raw: Object.freeze({}),
  });
}

function siteverifyUrl(options: TurnstileVerifyOptions): string {
  const text = options.siteverifyUrl ?? SITEVERIFY_URL;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new TypeError("siteverifyUrl is not a URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError(
      "siteverifyUrl must not carry credentials, a query or a fragment",
    );
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && options.allowLoopbackForDevelopment &&
      LOOPBACK.has(url.hostname))
  ) {
    throw new TypeError(
      "siteverifyUrl must be https (http only to loopback with allowLoopbackForDevelopment)",
    );
  }
  return url.href;
}

export type WidgetMode = "managed" | "non-interactive" | "invisible";

export type ClearanceLevel =
  | "no_clearance"
  | "jschallenge"
  | "managed"
  | "interactive";

/** A Turnstile widget. `secret` is only in answers that carry it. */
export interface Widget {
  readonly sitekey: string;
  readonly name: string;
  readonly domains: readonly string[];
  readonly mode: WidgetMode | string;
  readonly secret?: string;
  readonly bot_fight_mode?: boolean;
  readonly clearance_level?: ClearanceLevel | string;
  readonly ephemeral_id?: boolean;
  readonly offlabel?: boolean;
  readonly region?: "world" | "china" | string;
  readonly created_on?: string;
  readonly modified_on?: string;
  readonly [field: string]: unknown;
}

/**
 * A new widget, or a widget's new settings (an update replaces them all).
 * `bot_fight_mode`, `offlabel` and `ephemeral_id` are Enterprise features;
 * `region` cannot change after creation.
 */
export interface WidgetInput {
  readonly name: string;
  /** Hostnames or IPs the widget may run on, subdomains included: 10 on the Free plan, 200 on Enterprise. */
  readonly domains: readonly string[];
  readonly mode: WidgetMode;
  readonly bot_fight_mode?: boolean;
  readonly clearance_level?: ClearanceLevel;
  readonly ephemeral_id?: boolean;
  readonly offlabel?: boolean;
  readonly region?: "world" | "china";
}

/** Which widgets {@link TurnstileWidgets.list} returns. */
export interface WidgetFilter {
  /** Widgets whose name contains this, ignoring case. */
  readonly name?: string;
  readonly sitekey?: string;
  readonly order?: "id" | "sitekey" | "name" | "created_on" | "modified_on";
  readonly direction?: "asc" | "desc";
}

const MODES = new Set(["managed", "non-interactive", "invisible"]);
const MAX_DOMAINS = 200;

/** An account's Turnstile widgets. */
export class TurnstileWidgets {
  readonly #client: CloudflareClient;
  readonly accountId: string;

  constructor(client: CloudflareClient, accountId: string) {
    this.#client = client;
    this.accountId = cloudflareId(accountId, "accountId");
  }

  get #base(): string {
    return `/accounts/${this.accountId}/challenges/widgets`;
  }

  /** The account's widgets, without their secrets. */
  async list(
    filter: WidgetFilter = {},
    options?: ListOptions,
  ): Promise<Widget[]> {
    if (filter.name !== undefined && filter.sitekey !== undefined) {
      throw new TypeError("filter by name or by sitekey, not both");
    }
    const query = {
      filter: filter.name !== undefined
        ? `name:${filter.name}`
        : filter.sitekey !== undefined
        ? `sitekey:${pathToken(filter.sitekey, "sitekey")}`
        : undefined,
      order: filter.order,
      direction: filter.direction,
    };
    return (await this.#client.list<Widget>(this.#base, query, options)).map(
      checkWidget,
    );
  }

  /** A widget, with its secret. */
  async get(sitekey: string, options?: Call): Promise<Widget> {
    return checkWidget(
      await this.#client.result("GET", this.#widget(sitekey), options),
    );
  }

  /** Creates a widget; the answer carries its secret. */
  async create(input: WidgetInput, options?: Call): Promise<Widget> {
    return checkWidget(
      await this.#client.result("POST", this.#base, {
        ...options,
        body: widgetBody(input),
      }),
    );
  }

  /** Replaces a widget's settings. */
  async update(
    sitekey: string,
    input: WidgetInput,
    options?: Call,
  ): Promise<Widget> {
    return checkWidget(
      await this.#client.result("PUT", this.#widget(sitekey), {
        ...options,
        body: widgetBody(input),
      }),
    );
  }

  async delete(sitekey: string, options?: Call): Promise<Widget> {
    return checkWidget(
      await this.#client.result("DELETE", this.#widget(sitekey), options),
    );
  }

  /**
   * A new secret. The old one keeps working for two hours, so deployed
   * Workers can move over, unless `invalidateImmediately`; a widget cannot
   * be rotated again within those two hours.
   */
  async rotateSecret(
    sitekey: string,
    options: Call & { readonly invalidateImmediately?: boolean } = {},
  ): Promise<Widget> {
    const { invalidateImmediately = false, ...call } = options;
    return checkWidget(
      await this.#client.result(
        "POST",
        `${this.#widget(sitekey)}/rotate_secret`,
        { ...call, body: { invalidate_immediately: invalidateImmediately } },
      ),
    );
  }

  #widget(sitekey: string): string {
    return `${this.#base}/${pathToken(sitekey, "sitekey")}`;
  }
}

function widgetBody(input: WidgetInput): Record<string, unknown> {
  if (
    typeof input.name !== "string" || input.name === "" ||
    input.name.length > 254
  ) {
    throw new TypeError("name must be 1 to 254 characters");
  }
  if (
    !Array.isArray(input.domains) || input.domains.length === 0 ||
    input.domains.length > MAX_DOMAINS ||
    !input.domains.every((domain) =>
      typeof domain === "string" && /^[A-Za-z0-9.:-]{1,253}$/.test(domain)
    )
  ) {
    throw new TypeError(
      `domains must be 1 to ${MAX_DOMAINS} hostnames or IP addresses`,
    );
  }
  if (!MODES.has(input.mode)) {
    throw new TypeError(
      "mode must be managed, non-interactive or invisible",
    );
  }
  return { ...input, domains: [...input.domains] };
}

function checkWidget(value: unknown): Widget {
  if (
    value === null || typeof value !== "object" ||
    typeof (value as Widget).sitekey !== "string"
  ) {
    throw new CloudflareError("response", "a widget without a sitekey");
  }
  return value as Widget;
}
