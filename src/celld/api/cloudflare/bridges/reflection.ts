// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/api/cloudflare/reflection`: finding the VM's Cloudflare
 * integration through exe.dev's reflection service instead of hard-coding
 * its name.
 *
 * ```ts
 * const cf = await cloudflareFromReflection();
 * ```
 *
 * The integration is an HTTP proxy whose target is
 * `https://api.cloudflare.com` and whose injected header is
 * `Authorization: Bearer <token>`; reflection shows neither, only the name,
 * type, comment and a `help` line such as `curl
 * https://cloudflare.int.exe.xyz/`. So with several HTTP proxies attached,
 * pass `name`; without it, the one named `cloudflare` is preferred, then
 * one whose name or comment mentions Cloudflare. The help line's host is
 * used when it names the integration (a team one lives under
 * `team.exe.xyz`).
 *
 * @module
 */

import {
  type AttachedIntegration,
  ReflectionClient,
  type VmHttpOptions,
} from "@celld/api/exedev/vm";
import {
  CloudflareClient,
  type CloudflareClientOptions,
  DEFAULT_INTEGRATION,
} from "@celld/api/cloudflare";

/** How to discover. */
export interface CloudflareDiscoveryOptions extends VmHttpOptions {
  /** The integration, when several HTTP proxies are attached. */
  readonly name?: string;
  /** A reflection client to use instead of a new one. */
  readonly reflection?: Pick<ReflectionClient, "integrations">;
}

const HOST = /\bhttps?:\/\/([a-z0-9-]+)\.((?:int|team)\.exe\.xyz)\b/i;

/** The Cloudflare integration among `integrations`, or null. */
export function chooseCloudflareIntegration(
  integrations: readonly AttachedIntegration[],
  name?: string,
): AttachedIntegration | null {
  const proxies = integrations.filter((item) => item.type === "http-proxy");
  if (name !== undefined) {
    return proxies.find((item) => item.name === name) ?? null;
  }
  return proxies.find((item) => item.name === DEFAULT_INTEGRATION) ??
    proxies.find((item) =>
      /\bcloudflare\b|\bcf-/i.test(`${item.name} ${item.comment ?? ""}`)
    ) ?? null;
}

/** The integration's origin: its help line's host when that names it. */
export function integrationOrigin(
  integration: AttachedIntegration,
  domain = "int.exe.xyz",
): string {
  const match = HOST.exec(integration.help ?? "");
  if (
    match !== null && match[1].toLowerCase() === integration.name.toLowerCase()
  ) {
    return `https://${integration.name}.${match[2].toLowerCase()}`;
  }
  return `https://${integration.name}.${domain}`;
}

/**
 * A client for the discovered integration.
 *
 * @throws {Error} when no Cloudflare integration is attached (or none by
 *   `name`).
 */
export async function cloudflareFromReflection(
  options:
    & Omit<CloudflareClientOptions, "baseUrl" | "integration" | "token">
    & { readonly discovery?: CloudflareDiscoveryOptions } = {},
): Promise<CloudflareClient> {
  const { discovery, ...client } = options;
  const reflection = discovery?.reflection ?? new ReflectionClient(discovery);
  const found = chooseCloudflareIntegration(
    await reflection.integrations(),
    discovery?.name,
  );
  if (found === null) {
    throw new Error(
      discovery?.name === undefined
        ? "no Cloudflare HTTP proxy integration is attached to this VM"
        : `no HTTP proxy integration named ${discovery.name} is attached to this VM`,
    );
  }
  return new CloudflareClient({
    ...client,
    baseUrl: integrationOrigin(found, discovery?.domain),
  });
}
