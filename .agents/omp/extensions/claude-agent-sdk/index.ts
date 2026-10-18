// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getBundledModels } from "@oh-my-pi/pi-catalog";
import { buildModels } from "./models.ts";
import { discoverModels, runProvider } from "./provider.ts";

/**
 * Select concrete claude-agent-sdk/claude-* model IDs in modelRoles or /model.
 * Resolve this directory's pinned package.json dependencies before loading;
 * OMP supplies its own peer modules. No API key or OMP /login entry is needed.
 * Authentication is the SDK's existing Claude Code Max login. The optional
 * OMP_CLAUDE_EXECUTABLE environment variable selects an installed Claude binary
 * through the SDK's pathToClaudeCodeExecutable option, never a CLI wrapper.
 *
 * History is replayed as labeled context, not a native Claude session. Full
 * replay trades cache efficiency for correct OMP branch/compaction ownership.
 * Token counts are SDK-reported; zero costs are not an Extra Usage guarantee.
 * Discovery uses SDK supportedModels().resolvedModel without sending a prompt;
 * local catalog limits describe each model, including Max's 1M context windows.
 */
export default async function claudeAgentSdk(pi: ExtensionAPI) {
  // Seed the initial model picker from the SDK too: a dynamic-only provider
  // can resolve an exact selector before it appears in OMP's available roster.
  const models = buildModels(
    await discoverModels(),
    getBundledModels("anthropic"),
  );
  pi.registerProvider("claude-agent-sdk", {
    // Metadata only: the custom transport never sends an HTTP request here.
    baseUrl: "https://claude-agent-sdk.invalid/",
    apiKey: "sdk-managed-claude-max-login",
    api: "claude-agent-sdk",
    models,
    async fetchDynamicModels() {
      // SDK discovery owns availability; the bundled catalog only adds metadata.
      return buildModels(await discoverModels(), getBundledModels("anthropic"));
    },
    streamSimple(model, context, options) {
      const stream = new AssistantMessageEventStream();
      void runProvider(model, context, options, (event) => stream.push(event))
        .then(() => stream.end(), (error) => stream.fail(error));
      return stream;
    },
  });
}
