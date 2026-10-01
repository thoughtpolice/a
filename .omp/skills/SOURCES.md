<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Claude workflow imports

Source: [Anthropic's official Claude plugins](https://github.com/anthropics/claude-plugins-official/tree/ab024cdc),
revision `ab024cdc`. Imports are modified OMP-native adaptations, not an installed
Claude plugin distribution. Each adapted package records its particular sources;
Apache-2.0 terms and upstream notices are preserved. The repository's Apache-2.0
license applies to repository-owned additions.

## Portable workflows

| Upstream plugin | Native destination and adaptation |
| --- | --- |
| `feature-dev` | `development`: evidence-based exploration, architecture handoff, implementation and runtime verification |
| `ralph-loop` | `development`: acceptance-driven iteration; no stop hook, unbounded prompt loop, or completion-promise protocol |
| `code-review` | `code-review`: changed-code review, independent validation, noise filtering and cited findings; no automatic PR posting |
| `pr-review-toolkit` | `code-review` facets and `code-simplifier`: comments, behavioral tests, failures/fallbacks, type invariants and focused simplification |
| `code-simplifier` | `code-simplifier`: behavior-preserving cleanup under repository conventions |
| `security-guidance` | `security-review`: licensed pattern catalog and an explicit native heuristic scan; no hooks, API calls or telemetry |
| `frontend-design` | `frontend-design`: intentional, accessible design and actual browser verification |
| `playground` | `playground`: all six offline interactive playground patterns |
| `project-artifact` | `project-artifact`: local standalone status artifacts, explicit evidence/freshness and refresh state; no Claude hosting or implicit publication |
| `session-report` | `session-insights`: real OMP journal metrics and offline reports, not Claude transcript assumptions |
| `receipts` | `session-insights`: successful-tool file activity, jj evidence, attribution/privacy caveats and safe HTML/CSV exports |
| `plugin-dev` | `omp-development`: actual OMP agents, custom tools, extensions, rules, settings and distribution; skill prose stays in `skill-creator` |
| `hookify` | `omp-development`: native rules/extension concepts; no Python rule engine or Claude event adapter |
| `claude-code-setup` | `omp-development`: read-only automation recommendations against real native capabilities |
| `claude-md-management` | `omp-development`: concise maintenance of supplied project context; no indiscriminate context-file discovery or hidden writes |
| `mcp-server-dev` | `mcp`: portable server, app and bundle design/security/deployment guidance; OMP client configuration is not a server/widget host |
| `skill-creator` | Existing `skill-creator`, extended with measured native benchmark aggregation; grading/comparison use native task/eval APIs, not Claude CLI loops |
| `code-modernization` | `modernization`: staged analysis/transformation and deterministic comparison, sharding, baseline/rule/uplift/proof/report helpers; no telemetry or proprietary runtime panel |
| `math-proof` | `mathematics`: solo/collaborative rigorous proof workflows and native round-ledger bookkeeping |
| `math-olympiad` | `mathematics`: interpretation, counterexamples, adversarial verification and self-contained presentation; no model-tier/performance claims or undeclared PDF compiler |
| `commit-commands` | `jj/commit-and-pr`: tested commits, source squashing, requested publication and recovery-first cleanup; no Git writes or forced worktree deletion |

The executable imports are Bun-compatible TypeScript invoked through native OMP
custom tools. They use scoped validated inputs and bounded local artifacts;
Python is not a new dependency. Buck2 owns typechecking, lint and behavioral tests.
No imported plugin is permitted to install hooks, modify settings, publish data,
start services, or execute an analyzed source tree merely by being discovered.

## Explicitly not imported

| Upstream plugin or pack | Reason |
| --- | --- |
| `claude-security` | Proprietary license restricts use to Anthropic products and prohibits use in developing a non-Anthropic product. No code, prompts, skill definitions, report specifications or derivative material imported. |
| `agent-sdk-dev` | Specifically Claude Agent SDK setup/verification; not a native OMP SDK capability. Native OMP authoring is covered independently in `omp-development`. |
| `mcp-tunnels` | Provider/runtime-specific tunnel setup, not a portable MCP implementation. Generic transport/auth/deployment concerns belong in `mcp`; no tunnel/account side effects imported. |
| `cwc-makers` | Cardputer/M5 hardware-specific onboarding and device helpers, not a general repository workflow. |
| `example-plugin` | Claude plugin demonstration/schema glue, not a useful standalone workflow; native authoring uses actual OMP formats instead. |
| `learning-output-style`, `explanatory-output-style` | Claude output-style/session hooks conflict with the host's explicit communication policy; no style injection imported. |
| `clangd-lsp`, `csharp-lsp`, `gopls-lsp`, `jdtls-lsp`, `kotlin-lsp`, `lua-lsp`, `php-lsp`, `pyright-lsp`, `ruby-lsp`, `rust-analyzer-lsp`, `swift-lsp`, `typescript-lsp` | Claude language-server registration packs. OMP already has its own LSP mechanism; these are neither generic skill workflows nor portable server installations. No claim that every server is configured. |
| External service packs | Account/provider-specific MCP and messaging connectors, not portable skill logic. Existing native MCP/API capabilities are used where configured; no credentials or vendor setup copied. |

Restricted document-skill materials are not part of this import source and are
not incorporated. A document-format implementation would require independent
compatible specifications/libraries, not a port of restricted source.

## Deliberate runtime cutover

Discarded glue includes `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}`, Claude-only
slash-command/agent/model fields, native build-system bypasses, forced agent waves,
Git automation, telemetry, transcript-format guesses, and automatic push/share
behavior. Fresh OMP sessions discover each direct skill root and its native tools;
resources remain confined to their package and are accessed through `skill://`.

A computed comparison or ledger verdict means only what its documented evidence
contract says. It is not a security certification, a mathematical proof checker,
a fabricated human signoff, or evidence that an unrun program passed.
