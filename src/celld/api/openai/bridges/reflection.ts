// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/api/openai/reflection`: finding the VM's LLM integration through
 * exe.dev's reflection service, instead of hard-coding its name.
 *
 * ```ts
 * const gpt = await clientFromReflection({ model: "gpt-6-astra" });
 * ```
 *
 * Reflection lists the integrations attached to the VM with a `help` line
 * such as `curl https://llm.int.exe.xyz/v1/models`. The host in that line
 * says where the integration lives, including whether it is a team one
 * (`.team.exe.xyz`), so it is used when present; otherwise the name is
 * turned into the personal hostname. Reflection does not say which LLM
 * integration uses a ChatGPT subscription, so with several attached, pass
 * `name`; without it, one whose name or comment mentions ChatGPT or Codex
 * is preferred, then one named `llm`, then the first.
 *
 * @module
 */

import {
  type AttachedIntegration,
  ReflectionClient,
  type VmHttpOptions,
} from "@celld/api/exedev/vm";
import {
  GptClient,
  type GptClientOptions,
  integrationBaseUrl,
  type Route,
} from "@celld/api/openai";

/** A discovered integration. */
export interface DiscoveredIntegration {
  readonly name: string;
  readonly team: boolean;
  /** The API root to give `GptClient`. */
  readonly baseUrl: string;
  readonly integration: AttachedIntegration;
}

/** How to discover. */
export interface DiscoveryOptions extends VmHttpOptions {
  /** The integration to use, when several are attached. */
  readonly name?: string;
  /** Default `"openai"`. */
  readonly route?: Route;
  /** A reflection client to use instead of a new one. */
  readonly reflection?: Pick<ReflectionClient, "integrations">;
}

const HOST = /\bhttps?:\/\/([a-z0-9-]+)\.(int|team)\.exe\.xyz\b/i;

/** Picks the LLM integration to use from a reflection listing, or null. */
export function chooseLlmIntegration(
  integrations: readonly AttachedIntegration[],
  name?: string,
): AttachedIntegration | null {
  const llms = integrations.filter((item) => item.type === "llm");
  if (name !== undefined) {
    return llms.find((item) => item.name === name) ?? null;
  }
  return llms.find((item) =>
    /chatgpt|codex/i.test(`${item.name} ${item.comment ?? ""}`)
  ) ??
    llms.find((item) => item.name === "llm") ?? llms[0] ?? null;
}

/** Where an attached integration's API root is. */
export function describeIntegration(
  integration: AttachedIntegration,
  options: Pick<
    DiscoveryOptions,
    "route" | "scheme" | "domain" | "teamDomain"
  > = {},
): DiscoveredIntegration {
  const match = HOST.exec(integration.help ?? "");
  // Trust the help line's host only when it names this integration.
  const team = match !== null &&
    match[1].toLowerCase() === integration.name.toLowerCase() &&
    match[2].toLowerCase() === "team";
  return {
    name: integration.name,
    team,
    baseUrl: integrationBaseUrl(integration.name, {
      team,
      route: options.route,
      scheme: options.scheme,
      domain: options.domain,
      teamDomain: options.teamDomain,
    }),
    integration,
  };
}

/** The attached LLM integration to use, or null when there is none. */
export async function discoverLlmIntegration(
  options: DiscoveryOptions = {},
): Promise<DiscoveredIntegration | null> {
  const reflection = options.reflection ?? new ReflectionClient(options);
  const chosen = chooseLlmIntegration(
    await reflection.integrations(),
    options.name,
  );
  return chosen === null ? null : describeIntegration(chosen, options);
}

/**
 * A client for the discovered integration.
 *
 * @throws {Error} when no LLM integration is attached (or none by `name`).
 */
export async function clientFromReflection(
  options: GptClientOptions & { readonly discovery?: DiscoveryOptions } = {},
): Promise<GptClient> {
  const { discovery, ...client } = options;
  const found = await discoverLlmIntegration({
    route: client.route,
    ...discovery,
  });
  if (found === null) {
    throw new Error(
      discovery?.name === undefined
        ? "no LLM integration is attached to this VM"
        : `no LLM integration named ${discovery.name} is attached to this VM`,
    );
  }
  return new GptClient({ ...client, baseUrl: found.baseUrl });
}
