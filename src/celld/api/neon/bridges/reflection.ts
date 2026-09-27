// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/api/neon/reflection`: finding the VM's Neon integration through
 * exe.dev's reflection service instead of hard-coding its name.
 *
 * ```ts
 * const db = await neonFromReflection();
 * ```
 *
 * The integration is an HTTP proxy whose target is Neon's SQL endpoint and
 * whose injected header is `Neon-Connection-String`; reflection shows
 * neither, only the name, type, comment and a `help` line such as `curl
 * https://neon-serverless.int.exe.xyz/`. So with several HTTP proxies
 * attached, pass `name`; without it, the one named `neon-serverless` is
 * preferred, then one whose name or comment mentions Neon. The help line's
 * host is used when it names the integration (a team one lives under
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
  DEFAULT_INTEGRATION,
  NeonClient,
  type NeonClientOptions,
} from "@celld/api/neon";

/** How to discover. */
export interface NeonDiscoveryOptions extends VmHttpOptions {
  /** The integration, when several HTTP proxies are attached. */
  readonly name?: string;
  /** A reflection client to use instead of a new one. */
  readonly reflection?: Pick<ReflectionClient, "integrations">;
}

const HOST = /\bhttps?:\/\/([a-z0-9-]+)\.((?:int|team)\.exe\.xyz)\b/i;

/** The Neon integration among `integrations`, or null. */
export function chooseNeonIntegration(
  integrations: readonly AttachedIntegration[],
  name?: string,
): AttachedIntegration | null {
  const proxies = integrations.filter((item) => item.type === "http-proxy");
  if (name !== undefined) {
    return proxies.find((item) => item.name === name) ?? null;
  }
  return proxies.find((item) => item.name === DEFAULT_INTEGRATION) ??
    proxies.find((item) =>
      /\bneon\b|neon-/i.test(`${item.name} ${item.comment ?? ""}`)
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
 * @throws {Error} when no Neon integration is attached (or none by `name`).
 */
export async function neonFromReflection(
  options:
    & Omit<NeonClientOptions, "baseUrl" | "integration" | "connectionString">
    & {
      readonly discovery?: NeonDiscoveryOptions;
    } = {},
): Promise<NeonClient> {
  const { discovery, ...client } = options;
  const reflection = discovery?.reflection ?? new ReflectionClient(discovery);
  const found = chooseNeonIntegration(
    await reflection.integrations(),
    discovery?.name,
  );
  if (found === null) {
    throw new Error(
      discovery?.name === undefined
        ? "no Neon HTTP proxy integration is attached to this VM"
        : `no HTTP proxy integration named ${discovery.name} is attached to this VM`,
    );
  }
  return new NeonClient({
    ...client,
    baseUrl: integrationOrigin(found, discovery?.domain),
  });
}
