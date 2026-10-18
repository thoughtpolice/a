<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Adapted and modified from Anthropic claude-plugins-official ab024cdc, plugin-dev and hookify, Apache-2.0. -->

# Native contracts

## Agents

Project `.omp/agents/*.md`, user active profile's `agent/agents/*.md`.
YAML `name` and `description` plus Markdown system prompt. Native names are
case-sensitive; trimmed/lowercased `main` and `sub` are reserved. Project definitions
win over same-named user/bundled definitions. Avoid collisions unless intentional.

```yaml
name: api-reviewer
description: Review API boundary changes for input validation and compatibility.
tools: [read, find, grep, glob]
spawns: []
```

The body specifies evidence-backed findings, file locations and severity, or an
explicit no-findings result. `tools` accepts CSV or array; `yield` is auto-added.
`tools: []` therefore does not mean no tools. `spawns` accepts `*`, CSV or array;
omitting it while including `task` has a legacy unrestricted-spawn implication.
Use explicit least privilege. Depth/parent restrictions can still deny a spawn.
No YAML color requirement and no Claude `inherit`/Sonnet/Opus aliases.

Optional native fields: prioritized `model` selector string/CSV/list,
`thinking-level`/`thinking`, `output` (opaque schema, runtime validates it),
`blocking`, `autoloadSkills` (names inherited from parent), `read-summarize`,
`prewalk`, `advisor`. Leave model unspecified unless routing is required;
read role resolution rather than embedding tiers. The task item's schema can
override `output`. Unknown autoloaded skills are ignored; no per-task pinning
isolates a skill benchmark. Task `context`, `task`, `solutionSpace`, and optional
agent/schema specify the actual work, not frontmatter.

## Custom tools versus extensions

Read `omp://custom-tools.md` and `omp://skills/authoring-extensions.md`.
A custom tool module default-exports a factory taking injected `CustomToolAPI`;
return one tool or array (possibly promised). Modules under `.omp/tools` are
normally `.ts`/`.js`; immediate `index.ts` subdirectories are supported. Use local
structural types where available rather than installing a runtime SDK.

Custom-tool definition: unique `name`, `label`, `description`, `parameters`,
`execute(id, params, onUpdate, ctx, signal)`. Use `pi.typebox.Type`, not
`pi.typebox` as the schema builder. Do not put mutable array/object defaults into
the schema; choose fresh defaults inside execution. Results have `content`
and structured `details`. Declare `approval: read | write | exec`; don't disguise
process/network/write effects as a read tool. Pass abort signals to subprocesses,
check bounded loops, throw actionable failures, and guard UI with `hasUI`.

An **extension** default-exports a factory taking `ExtensionAPI`; it registers
with `registerTool`, `registerCommand`, `on`, etc. Its tool execution order is
**`(id, params, signal, onUpdate, ctx)`**, unlike custom tools. Do not copy one
signature into the other. Register at load; session-dependent calls must run in
handlers, commands or tools. Preferred policy event is `tool_call`; returning
`{block: true, reason}` denies, and handler exceptions fail closed. Result hooks
are not interchangeable with permission checks. Use managed context timers and
session cleanup; uncontained detached exceptions can crash the in-process host.
Neither extensions nor legacy JS/TS hook factories are isolated/sandboxed.

Use `registerCommand` for programmatic interactive commands; command context
supports `waitForIdle`, `newSession`, `switchSession`, `branch`, `navigateTree`,
`reload`, `compact`. Avoid built-in command/shortcut collisions. Reusable prompt
commands can instead use explicit `/skill:<name>` when enabled. Do not migrate
Claude command shell interpolation, allowed-tools strings or hook JSON into
native contracts without runtime evidence.

## Rules and policy interception

Read `omp://rulebook-matching-pipeline.md`. Rule identity is filename stem, not
Hookify's YAML name/event/action. `enabled: false` skips discovery.
Supported metadata: `description`, `globs`, `alwaysApply`, `condition`,
`astCondition`, `question`, `scope`, `agents`, `interruptMode`.
Kebab-case is normalized. Lists commonly accept string or YAML sequence.

- `description` exposes a rulebook entry; content is loaded via `rule://<name>`.
- `alwaysApply: true` injects content; sticky RULES is always-apply.
- `condition` JavaScript regex / `astCondition` structural pattern / `question`
  register TTSR; successful registration takes precedence over always-apply.
- `globs` are advisory for rulebook and path gates for TTSR, not auto-loading.
- `agents` filters agent names, including `main` and `sub` sentinels.
- `scope` selects `text`, `thinking`, `tool`/`toolcall`, or
  `tool:<name>(<glob>)`; default excludes thinking.
- `interruptMode`: never, prose-only, tool-only, always. Judged questions warn
  after a completed output and never interrupt it.

Hookify AND predicates (`contains`, equality, prefix/suffix, negation, regex)
can be implemented explicitly in a requested `tool_call` extension with typed
input checks. Do not pretend advisory TTSR rules enforce arbitrary multi-field
conditions or stop completion. Python regexes require semantic review before
JavaScript migration; test anchoring, escapes and near-matches. Strong security
boundaries must live in tool/server handlers, not regex prose reminders.

## Settings and distribution

Read registered schema via `omp config list --json` and specific nonsecret keys
with `omp config get <key> --json`; never read entire credential values.
Settings are YAML: global active profile, project cwd `.omp/config.yml`, repeatable
`--config` overlays, runtime overrides in increasing precedence. Arrays replace,
not concatenate. Settings discovery does not walk ancestor projects. Use an
explicit overlay to exercise recommendations; never `config set/reset` as part
of this workflow. Arbitrary plugin keys are not registered native settings.
For requested extension-specific state use a documented private schema/location,
validate actual YAML, separate secrets/state from shared instructions, bound reads
and atomic writes; don't resurrect `.claude/*.local.md` or regex YAML extraction.

Native extension package manifest: `package.json` with
`{"omp":{"extensions":["./src/main.ts"]}}` and actual entrypoints. Capability
folders may include `skills/`, `agents/`, `tools/`, `hooks/pre|post/`, `commands/`,
`rules/`, `prompts/`, `.mcp.json`. Include only used surfaces. Read
`omp://skills/authoring-marketplaces.md` before publishing; formats differ across
OMP extensions, marketplaces and portable Agent Plugins. Skills stay one level
under skills. Load an explicit package with `--extension` only after reviewing
executable content. `--no-extensions` plus explicit paths controls discovery,
not code privileges. Installation/publishing/updates require a separate request;
no automatic network install or settings mutation. Pin dependencies through the
repository Buck2 structure and test the resulting deployed package, not a template.
