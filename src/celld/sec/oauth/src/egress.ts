// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The egress rules for what this library fetches from URLs other parties
 * name: discovery documents, a registered client's `jwks_uri`, Client ID
 * Metadata Documents and registration endpoints. Every such fetch goes
 * through `@celld/http/egress`'s `boundedFetch` under
 * {@link metadataEgressPolicy} (https, no redirects, 5 s, 64 KiB, public
 * addresses only), and {@link egressUrlProblem} refuses a URL outright
 * before anything is sent.
 *
 * @module
 */

import { bytes, millis, strictRecord } from "@celld/core/bounds";
import {
  type BoundedFetch,
  boundedFetch,
  classifyHost,
  type EgressPolicy,
} from "@celld/http/egress";
import { type FetchLike, JSON_RESPONSE_MAX_BYTES } from "./util.ts";

/** How a caller adjusts the egress policy of a fetch this library makes. */
export interface EgressOptions {
  /**
   * Merged over the default policy (https, no redirects, 5 s, 64 KiB,
   * public addresses only). See `@celld/http/egress`.
   */
  readonly egress?: Partial<EgressPolicy>;
  /**
   * Also allow `http:` to a loopback IP literal (`http://127.0.0.1:8080`),
   * for servers on this machine during development: the network becomes
   * `loopback`. Never set it in production. Default false.
   */
  readonly allowLoopbackForDevelopment?: boolean;
}

/** `value`'s own entries that are not `undefined`. */
export function definedEntries<T extends object>(value: T | undefined): T {
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(([, item]) => item !== undefined),
  ) as T;
}

/** The default policy for metadata and key fetches, adjusted by `options`. */
export function metadataEgressPolicy(
  options: EgressOptions = {},
  defaults: Partial<EgressPolicy> = {},
): EgressPolicy {
  if (
    options.allowLoopbackForDevelopment !== undefined &&
    typeof options.allowLoopbackForDevelopment !== "boolean"
  ) throw new TypeError("allowLoopbackForDevelopment must be a boolean");
  for (const override of [defaults, options.egress]) {
    if (override === undefined) continue;
    strictRecord(override as unknown, [
      "allow",
      "redirects",
      "timeoutMs",
      "maxBytes",
      "json",
      "network",
      "allowCleartextLoopbackForDevelopment",
      "budget",
      "unsafeResendBodyCrossOrigin",
    ], "OAuth egress policy");
  }
  const policy: EgressPolicy = {
    allow: () => true,
    timeoutMs: millis(5_000),
    maxBytes: bytes(64 * 1024),
    json: { maxDepth: 10, maxKeys: 256, maxItems: 1000 },
    network: options.allowLoopbackForDevelopment === true
      ? "loopback"
      : "public",
    allowCleartextLoopbackForDevelopment:
      options.allowLoopbackForDevelopment === true,
    ...definedEntries(defaults),
    ...definedEntries(options.egress),
    redirects: 0,
  };
  // Validate eagerly without sending anything. boundedFetch snapshots the
  // policy too, but constructors must not defer malformed options to first use.
  boundedFetch(policy);
  return Object.freeze({
    ...policy,
    ...(policy.json === undefined
      ? {}
      : { json: Object.freeze({ ...policy.json }) }),
    ...(policy.budget === undefined
      ? {}
      : { budget: Object.freeze({ ...policy.budget }) }),
  });
}

/**
 * The policy for requests that carry credentials to an authorization
 * server's endpoints (token, PAR, device, revocation, introspection): the
 * metadata rule (https, public addresses, `egress` and
 * `allowLoopbackForDevelopment` adjusting it) with a 10 s deadline and
 * 256 KiB answers, and never a redirect, whatever `egress` says, so a
 * form holding a secret, a code or a refresh token is never re-sent to
 * wherever a `Location` points.
 */
export function endpointEgressPolicy(
  options: EgressOptions = {},
): EgressPolicy {
  return {
    ...metadataEgressPolicy(options, {
      timeoutMs: millis(10_000),
      maxBytes: bytes(JSON_RESPONSE_MAX_BYTES),
      json: { maxDepth: 32, maxKeys: 1000, maxItems: 10_000 },
    }),
    redirects: 0,
  };
}

/** A bounded fetch under `policy`, calling `fetch` (looked up late). */
export function egressFetch(
  policy: EgressPolicy,
  fetch: FetchLike,
): BoundedFetch {
  return boundedFetch(policy, (input, init) => fetch(input, init));
}

/**
 * The part of an {@link EgressPolicy} that {@link egressUrlProblem}
 * reads: its `network`, and whether cleartext to a loopback IP literal is
 * allowed.
 */
export type EgressUrlPolicy = Pick<
  EgressPolicy,
  "network" | "allowCleartextLoopbackForDevelopment"
>;

/**
 * Why a URL cannot be fetched under `policy`, or null, by the rules
 * `boundedFetch` applies to it at fetch time: https (http only to a
 * loopback IP literal, and only with the policy's
 * `allowCleartextLoopbackForDevelopment` off the public network), no user
 * information or fragment, and a host inside the network (a private,
 * link-local or loopback address is refused under `public`). Host names
 * pass: what they resolve to cannot be seen on this runtime. A bare
 * `network` stands for a policy without cleartext: https only.
 */
export function egressUrlProblem(
  value: string | URL,
  policy: EgressPolicy["network"] | EgressUrlPolicy,
): string | null {
  const { network, allowCleartextLoopbackForDevelopment: cleartext } =
    typeof policy === "string"
      ? { network: policy, allowCleartextLoopbackForDevelopment: false }
      : policy;
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    return "is not an absolute URL";
  }
  if (url.username !== "" || url.password !== "") {
    return "must not carry user information";
  }
  if (String(value).includes("#")) return "must not have a fragment";
  const kind = classifyHost(url.hostname);
  if (url.protocol !== "https:") {
    const literal = !/^localhost$|\.localhost$/i.test(url.hostname);
    if (
      !(url.protocol === "http:" && network !== "public" &&
        cleartext === true && kind === "loopback" && literal)
    ) {
      return network === "public" || cleartext !== true
        ? "must use https"
        : "must use https (http only to a loopback IP literal)";
    }
  }
  if (
    !(network === "any" || kind === "public" || kind === "name" ||
      (kind === "loopback" && network === "loopback"))
  ) {
    return `names a ${kind} address`;
  }
  return null;
}
