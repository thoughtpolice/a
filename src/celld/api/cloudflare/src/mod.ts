// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The Cloudflare API from celld, imported as "@celld/api/cloudflare": the
 * transport the areas share, through an exe.dev HTTP proxy integration that
 * holds the API token, or straight to Cloudflare with one.
 *
 * ```ts
 * import { CloudflareClient } from "@celld/api/cloudflare";
 * import { DnsRecords, Zones } from "@celld/api/cloudflare/zones";
 *
 * const cf = new CloudflareClient(); // https://cloudflare.int.exe.xyz
 * const zone = await new Zones(cf).byName("example.com");
 * await new DnsRecords(cf, zone.id).create({
 *   type: "A",
 *   name: "www.example.com",
 *   content: "192.0.2.1",
 *   proxied: true,
 * });
 * ```
 *
 * Subpaths: "./zones" (zones, settings, DNS), "./cache" (purging, cache
 * settings and rules), "./tunnels" (Cloudflare Tunnel), "./turnstile"
 * (widgets and siteverify), "./investigate" (Intel lookups and URL
 * Scanner), "./testing" (`FakeCloudflare`), and the separate target
 * "@celld/api/cloudflare/reflection" (finding the integration through
 * exe.dev's reflection service).
 *
 * @module
 */

export {
  API_ORIGIN,
  API_PATH,
  CloudflareClient,
  type CloudflareClientOptions,
  type CloudflareEnv,
  DEFAULT_INTEGRATION,
  DEFAULT_MAX_ITEMS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_RETRY_POLICY,
  DEFAULT_TIMEOUT_MS,
  endpointOrigin,
  type Envelope,
  type ListOptions,
  type Method,
  type Page,
  type PageOptions,
  type Query,
  type QueryValue,
  type RequestOptions,
  type ResultInfo,
  type TokenStatus,
} from "./client.ts";
export {
  type ApiMessage,
  apiMessages,
  CloudflareError,
  type CloudflareErrorKind,
} from "./errors.ts";
export { cloudflareId, pathToken, uuid } from "./ids.ts";
