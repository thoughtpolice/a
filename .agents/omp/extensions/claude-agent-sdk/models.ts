// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

/** The SDK determines availability; OMP's local catalog supplies model limits. */
export function buildModels(
  available: readonly ModelInfo[],
  catalog: readonly Model[],
): ProviderModelConfig[] {
  const references = new Map(catalog.map((model) => [model.id, model]));
  const models = new Map<string, ProviderModelConfig>();
  for (const info of available) {
    // "default" duplicates the account's recommended model, not another model.
    if (info.value === "default") continue;
    const resolved = info.resolvedModel ?? info.value;
    if (!resolved.startsWith("claude-")) continue;
    const id = resolved.replace(/\[1m\]$/, "");
    if (models.has(id)) continue;
    const reference = references.get(id);
    // Sonnet 4.6's 1M window requires Extra Usage even on Max. Opus 4.6 and
    // current Opus/Fable/Sonnet/Haiku generations get their full 1M on Max.
    const contextWindow = id === "claude-sonnet-4-6"
      ? 200_000
      : resolved.endsWith("[1m]")
      ? 1_000_000
      : Math.min(
        reference?.maxContextWindow ?? reference?.contextWindow ?? 200_000,
        1_000_000,
      );
    const thinking: ProviderModelConfig["thinking"] =
      info.supportsAdaptiveThinking
        ? {
          ...reference?.thinking,
          mode: "anthropic-adaptive",
          efforts: info.supportedEffortLevels ?? reference?.thinking?.efforts ??
            ["low", "medium", "high"],
        }
        : reference?.thinking;
    models.set(id, {
      id,
      name: `${info.displayName}${
        contextWindow === 1_000_000 ? " 1M" : ""
      } (Max SDK)`,
      reasoning: Boolean(
        info.supportsEffort || info.supportsAdaptiveThinking ||
          reference?.reasoning,
      ),
      ...(thinking
        ? {
          thinking: {
            ...thinking,
            ...(info.supportedEffortLevels
              ? { efforts: info.supportedEffortLevels }
              : {}),
          },
        }
        : {}),
      input: reference?.input ?? ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: reference?.maxTokens ?? 32_000,
    });
  }
  if (!models.size) {
    throw new Error(
      "Claude Agent SDK returned no concrete models for the signed-in Max account",
    );
  }
  return [...models.values()];
}
