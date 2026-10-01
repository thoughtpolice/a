---
name: omp-development
description: Create or audit OMP agents, custom tools, extensions, hooks, rules, settings recommendations, capability packages, and supplied project context. Use for native automation design, plugin migration, authoring validation, distribution, or context maintenance.
---

<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Modified from Anthropic claude-plugins-official ab024cdc, Apache-2.0: plugin-dev, hookify, claude-code-setup, claude-md-management. -->

# Author native OMP capabilities

Choose the smallest real surface; a Claude plugin is not a native OMP runtime.
Read [native contracts](references/contracts.md) before authoring executable code
or metadata, and [recommendations and context](references/maintenance.md) for
read-only setup analysis or instruction maintenance. Skill prose/evaluation belongs
to `skill://skill-creator`; MCP server/app/bundle design to `skill://mcp`.

## Discover the actual need

Use supplied context and the user's concrete request first. Inspect existing
capabilities and relevant implementation with specialized read/search tools;
do not search for AGENTS.md, CLAUDE.md, or other context files already supplied
by the host. Read only supplied or explicitly requested context paths.
Identify inputs, permissions, side effects, lifecycle, observable output and
failure cases. Ask only unresolved material design choices.

| Need | Native surface |
| --- | --- |
| Reusable prose workflow / explicit invocation | Direct `.omp/skills/<name>/SKILL.md` package |
| Specialized autonomous worker | `.omp/agents/<name>.md` |
| Model-callable deterministic computation | `.omp/tools/<name>.ts`, injected custom-tool factory |
| Commands, event interception, provider/rendering integration | Extension factory, `.omp/extensions/` |
| Advisory instructions / streaming reminder | `.omp/rules/*.{md,mdc}` / explicit sticky `.omp/RULES.md` |
| External protocol integration | `.omp/mcp.json`, independently implemented MCP server |
| Runtime preferences | Read registered settings; propose an overlay, never mutate user settings |

## Design and implement

Specify the success/failure contract before writing. Reuse local tool types,
filesystem guards and Buck2 rules. Keep Bun/TypeScript deterministic helpers;
no Python ports, dependency installs, Claude CLI wrappers or invented SDKs.
Do not add automatic hooks, change settings, commit, push, or publish as part of
recommendations. Implementation requests authorize only the requested project
capability; global configuration remains untouched.

Agent prompts name responsibilities, exclusions, inputs, process and an exact
output contract. Give invocation examples and near-misses without forcing a
model tier or fanout. Tools take bounded typed inputs and return structured
results, honor cancellation and separate read/write/exec approval. Extensions
register at load and act at runtime. Rules explain the detected issue, its
consequence and a concrete corrective action; they are not a security sandbox.

## Validate behavior and distribute

Read `xd://omp_validate` and call `omp_validate` with an explicit `kind` and
workspace `path`. It parses skill/agent/rule frontmatter using native Bun YAML,
MCP using strict UTF-8 JSON, and checks native semantics plus confined skill
resource links outside fenced/inline code examples. It is read-only, bounds diagnostics and input size, does not run code,
resolve secrets or connect MCP. Warnings are not behavior proof. It intentionally
does not validate arbitrary registered settings, extension source or model
availability: consult the actual runtime schema/docs for those.

After integration, run the specific capability in a fresh native session and
exercise one normal and one meaningful failure case. Use the repository Buck2
testing workflow, once after concurrent edits settle. Observe invocation,
permissions, results, cancellation and cleanup; do not rely on metadata alone.
For UI extensions observe the actual surface, not only a source fixture.

Prefer installed directories or a requested OMP extension package; validate all
resource links within each skill. Cross-package references use skill URIs.
A `.skill` ZIP is not an OMP-native install format. Make archives only on explicit
request with a real chosen consumer, allowlisted regular files, no symlinks,
confined extraction and output outside the source tree. No archive helper is
needed for native directory discovery. Preserve licenses/notices and state
compatibility, runtime dependencies, tested behavior and limitations.

## Sources and runtime truth

Portable authoring concepts are rewritten from the four Apache-2.0 plugins above,
pinned at `ab024cdc`; Claude manifests/hooks/settings/models are not carried over.
Agent SDK setup is excluded: OMP client extensibility is not a replacement for the
Claude Agent SDK. Runtime contracts: `omp://custom-tools.md`,
`omp://skills/authoring-extensions.md`, `omp://task-agent-discovery.md`,
`omp://rulebook-matching-pipeline.md`, `omp://settings.md`, `omp://skills.md`,
`omp://skills/authoring-marketplaces.md`. Consult these when version-sensitive.
