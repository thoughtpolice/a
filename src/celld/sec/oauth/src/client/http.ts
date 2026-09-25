// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Requests to an authorization server's endpoints: form bodies, client
 * authentication, DPoP proofs with the server's nonce (retrying once on
 * `use_dpop_nonce`, RFC 9449 section 8), and reading JSON answers and
 * error responses into {@link OAuthError}s.
 *
 * @module
 */

import { type BoundedResponse, EgressError } from "@celld/http/egress";

/** The longest token lifetime a response may state: ten years. */
const MAX_EXPIRES_IN_SEC = 10 * 365 * 86_400;
import { type DpopKey, DpopNonceCache } from "../dpop/key.ts";
import {
  egressFetch,
  type EgressOptions,
  egressUrlProblem,
  endpointEgressPolicy,
  metadataEgressPolicy,
} from "../egress.ts";
import { OAuthError } from "../errors.ts";
import type { TokenResponse } from "../metadata.ts";
import { type Clock, type FetchLike, isObject } from "../util.ts";
import {
  applyClientAuthentication,
  type ClientAuthentication,
} from "./auth.ts";
import type { TokenSet } from "./store.ts";

/** What every endpoint request needs. */
export interface EndpointContext {
  readonly issuer: string;
  readonly fetch: FetchLike;
  readonly now: Clock;
  readonly nonces: DpopNonceCache;
  readonly dpop?: DpopKey;
  readonly signal?: AbortSignal;
  /** Adjusts {@link endpointEgressPolicy}; required so no caller forgets it. */
  readonly egress: EgressOptions;
}

/** Form parameters; a list sends the parameter once per value. */
export type FormParams = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

/** An endpoint's answer. */
export interface EndpointResult {
  readonly status: number;
  readonly body: Record<string, unknown> | null;
  readonly headers: Headers;
}

function form(params: FormParams, extra: Readonly<Record<string, string>>) {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (typeof value === "string") body.append(name, value);
    else for (const item of value) body.append(name, item);
  }
  for (const [name, value] of Object.entries(extra)) body.set(name, value);
  return body;
}

/** Whether a response asks for a DPoP nonce (RFC 9449 section 8). */
export function wantsDpopNonce(result: EndpointResult): boolean {
  return result.status === 400 && result.body?.error === "use_dpop_nonce" &&
    result.headers.has("dpop-nonce");
}

/**
 * POSTs a form to `endpoint` with client authentication and, when
 * `dpop` is set and the context has a key, a DPoP proof. A
 * `use_dpop_nonce` answer is retried once with the new nonce. It goes
 * through `boundedFetch` under {@link endpointEgressPolicy}: a URL the
 * policy refuses is a `discovery` error before any credential is built, a
 * redirect or another refused answer a `token` error, network failures
 * `network` errors; every other answer is returned, its body read as a
 * JSON object when it is one (null otherwise).
 */
export async function postForm(
  endpoint: string,
  params: FormParams,
  auth: ClientAuthentication | null,
  context: EndpointContext,
  options: { readonly dpop?: boolean } = {},
): Promise<EndpointResult> {
  const policy = endpointEgressPolicy(context.egress);
  const problem = egressUrlProblem(endpoint, policy);
  if (problem !== null) {
    throw new OAuthError("discovery", `${endpoint} ${problem}`, {
      issuer: context.issuer,
    });
  }
  const send = egressFetch(policy, context.fetch);
  let result: EndpointResult | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const applied = auth === null
      ? { headers: {}, params: {} }
      : await applyClientAuthentication(
        auth,
        context.issuer,
        endpoint,
        context.now,
      );
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      ...applied.headers,
    };
    if (options.dpop && context.dpop !== undefined) {
      headers.dpop = await context.dpop.proof({
        method: "POST",
        url: endpoint,
        nonce: context.nonces.get(endpoint),
      });
    }
    let response: BoundedResponse;
    try {
      response = await send(endpoint, {
        method: "POST",
        headers,
        body: form(params, applied.params).toString(),
        signal: context.signal,
      });
    } catch (cause) {
      throw endpointError(endpoint, cause, context.issuer);
    }
    context.nonces.update(endpoint, response.headers);
    let body: unknown = null;
    try {
      body = await response.json();
    } catch (cause) {
      if (
        !(cause instanceof EgressError) ||
        (cause.code !== "json" && cause.code !== "too_large")
      ) {
        throw endpointError(endpoint, cause, context.issuer);
      }
    }
    result = {
      status: response.status,
      body: isObject(body) ? body : null,
      headers: response.headers,
    };
    if (
      !(options.dpop && context.dpop !== undefined && wantsDpopNonce(result))
    ) {
      break;
    }
  }
  return result!;
}

/**
 * Throws the {@link OAuthError} for a failed answer: `network` for 5xx,
 * otherwise `kind` with the server's `error` and description.
 */
export function failure(
  result: EndpointResult,
  what: string,
  issuer: string,
  kind: "token" | "registration" = "token",
): OAuthError {
  const body = result.body;
  const error = typeof body?.error === "string" ? body.error : null;
  const description = typeof body?.error_description === "string"
    ? body.error_description
    : null;
  return new OAuthError(
    result.status >= 500 ? "network" : kind,
    `${what} failed (${result.status})`,
    { status: result.status, error, description, issuer },
  );
}

/** Reads a successful answer's JSON object, or throws {@link failure}. */
export function expectJson(
  result: EndpointResult,
  what: string,
  issuer: string,
): Record<string, unknown> {
  if (result.status < 200 || result.status >= 300 || result.body === null) {
    throw failure(result, what, issuer);
  }
  return result.body;
}

/**
 * A token response as a {@link TokenSet}. `access_token` must be a
 * non-empty string, `token_type` `Bearer` or `DPoP` (either case), and a
 * `DPoP` type requires a proof to have been sent. When `dpopJkt` is set
 * (a proof was sent), a `Bearer` answer is refused unless
 * `allowBearer`: the server ignored the proof, and the client would
 * otherwise hold an unbound token it meant to have bound.
 */
export function parseTokenResponse(
  body: Record<string, unknown>,
  context: {
    readonly issuer: string;
    readonly now: Clock;
    readonly dpopJkt?: string;
    readonly allowBearer?: boolean;
  },
): TokenSet {
  const raw = body as Partial<TokenResponse>;
  if (raw.expires_in !== undefined && typeof raw.expires_in !== "number") {
    throw new OAuthError("token", "expires_in must be a number");
  }
  if (
    typeof raw.access_token !== "string" || raw.access_token === "" ||
    raw.access_token.length > 16_384
  ) {
    throw new OAuthError("token", "the token response has no access_token", {
      issuer: context.issuer,
    });
  }
  for (
    const key of [
      "refresh_token",
      "id_token",
      "scope",
      "issued_token_type",
    ] as const
  ) {
    if (
      raw[key] !== undefined &&
      (typeof raw[key] !== "string" || raw[key]!.length > 16_384)
    ) {
      throw new OAuthError(
        "token",
        "a token response field exceeds its limit or has an invalid type",
      );
    }
  }
  const type = typeof raw.token_type === "string"
    ? raw.token_type.toLowerCase()
    : "";
  if (type !== "bearer" && type !== "dpop") {
    throw new OAuthError(
      "token",
      `unsupported token_type ${JSON.stringify(raw.token_type)}`,
      { issuer: context.issuer },
    );
  }
  if (type === "dpop" && context.dpopJkt === undefined) {
    throw new OAuthError(
      "dpop",
      "the server issued a DPoP token for a request without a proof",
      { issuer: context.issuer },
    );
  }
  if (
    type === "bearer" && context.dpopJkt !== undefined && !context.allowBearer
  ) {
    throw new OAuthError(
      "dpop",
      "the server issued a Bearer token although the request carried a DPoP proof",
      { issuer: context.issuer },
    );
  }
  const tokens: { -readonly [K in keyof TokenSet]: TokenSet[K] } = {
    access_token: raw.access_token,
    token_type: type === "dpop" ? "DPoP" : "Bearer",
  };
  if (typeof raw.expires_in === "number") {
    // At most ten years: a larger (or `1e999`, which parses to Infinity)
    // lifetime would make the tokens look fresh forever.
    if (
      !Number.isSafeInteger(raw.expires_in) || raw.expires_in < 0 ||
      raw.expires_in > MAX_EXPIRES_IN_SEC
    ) {
      throw new OAuthError(
        "token",
        `expires_in ${
          JSON.stringify(raw.expires_in)
        } is not whole seconds up to ten years`,
        { issuer: context.issuer },
      );
    }
    tokens.expires_at = context.now() + raw.expires_in * 1000;
  }
  if (typeof raw.refresh_token === "string" && raw.refresh_token !== "") {
    tokens.refresh_token = raw.refresh_token;
  }
  if (typeof raw.scope === "string") tokens.scope = raw.scope;
  if (typeof raw.issued_token_type === "string") {
    tokens.issued_token_type = raw.issued_token_type;
  }
  if (typeof raw.id_token === "string") tokens.id_token = raw.id_token;
  if (type === "dpop") tokens.dpop_jkt = context.dpopJkt;
  return tokens;
}

/**
 * Reads a JSON document from `url` through `boundedFetch` under
 * {@link metadataEgressPolicy} as `egress` adjusts it (https, no
 * redirects, 5 s, 64 KiB, public addresses): null for a 4xx miss or a
 * non-object; throws `discovery` for a URL or answer the policy refuses
 * (a redirect, an oversized or malformed body), and `network` for network
 * errors and 5xx.
 */
export async function fetchJson(
  url: string,
  fetch: FetchLike,
  signal: AbortSignal | undefined,
  egress: EgressOptions = {},
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const policy = metadataEgressPolicy(egress);
  const problem = egressUrlProblem(url, policy);
  if (problem !== null) {
    throw new OAuthError("discovery", `${url} ${problem}`);
  }
  const get = egressFetch(policy, fetch);
  let response: BoundedResponse;
  try {
    response = await get(url, {
      headers: { accept: "application/json" },
      signal,
    });
  } catch (cause) {
    throw egressError(url, cause);
  }
  if (response.status >= 500) {
    await response.discard();
    throw new OAuthError("network", `${url} answered ${response.status}`, {
      status: response.status,
    });
  }
  if (!response.ok) {
    await response.discard();
    return { status: response.status, body: null };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    if (cause instanceof EgressError && cause.code === "json") {
      return { status: response.status, body: null };
    }
    throw egressError(url, cause);
  }
  return { status: response.status, body: isObject(body) ? body : null };
}

/**
 * A refused endpoint answer (a redirect, say) as a `token` error, a
 * network failure as `network`.
 */
function endpointError(
  endpoint: string,
  cause: unknown,
  issuer: string,
): OAuthError {
  if (
    cause instanceof EgressError &&
    cause.code !== "fetch" && cause.code !== "timeout" &&
    cause.code !== "aborted"
  ) {
    return new OAuthError(
      "token",
      `${endpoint} answered what the egress policy refuses: ${cause.message}`,
      { cause, issuer },
    );
  }
  return new OAuthError(
    "network",
    `could not reach ${endpoint}: ${(cause as Error)?.message ?? cause}`,
    { cause, issuer },
  );
}

/** An egress refusal as a `discovery` error, a network failure as `network`. */
function egressError(url: string, cause: unknown): OAuthError {
  if (
    cause instanceof EgressError &&
    cause.code !== "fetch" && cause.code !== "timeout" &&
    cause.code !== "aborted"
  ) {
    return new OAuthError(
      "discovery",
      `fetching ${url} was refused: ${cause.message}`,
      { cause },
    );
  }
  return new OAuthError(
    "network",
    `could not fetch ${url}: ${(cause as Error)?.message ?? cause}`,
    { cause },
  );
}
