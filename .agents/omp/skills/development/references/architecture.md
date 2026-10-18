<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Exploration and architecture handoff

## Exploration

Return only evidence needed to change the feature safely:

- Entry points and current contract, with exact file/line citations.
- The call/data flow through transformations, ownership, persistent state, and
  output. Distinguish what was read from inference.
- Failure, cancellation, and concurrency paths that can change visible behavior.
- Existing implementations worth reusing, including their actual dependencies.
- Consumers and meaningful verification targets. Attached tests are not
  necessarily dependency edges; inspect their `tests` metadata.
- Remaining questions that cannot be answered from code/config/history.

A compact diagram is useful for a real state machine or flow. Do not substitute a
list of filenames for tracing behavior, or read an entire subsystem when a narrow
path answers the question.

## Implementation blueprint

State the decision first, then the reason and risk. Include:

| Contract | Required detail |
| --- | --- |
| Behavior | Consumer-visible acceptance and explicit non-goals |
| API/state | Exact symbols, fields, ownership/lifetime, validation and transitions |
| Reuse | Existing pattern and cited implementation, not an invented abstraction |
| Integration | Every affected caller, test, configuration, and doc |
| Slices | File ownership, shared interfaces, true prerequisites, integration owner |
| Verification | Actual run/scenario and a failure that would invalidate the design |

Run LSP references before changing exported contracts. In compiled code, identify
avoidable allocations, copies, repeated computation, and changes to asymptotic
behavior. Describe storage/schema/compatibility tradeoffs before changing them.
Do not add migrations, retries, telemetry, or validation beyond the request merely
because a blueprint has a space for them.

## Independent design/review prompts

Use only when the slice warrants delegation. Supply the relevant file map and
contract rather than asking an agent to rediscover the repository:

- **Design:** “Given this current flow and acceptance, choose the smallest design
  that reuses its patterns. Return changed interfaces, callers, risks, and exact
  verification. Distinguish evidence from assumptions; do not edit shared files.”
- **Review:** “Trace this changed path and its callers. Report confirmed defects
  introduced by the change, their visible consequence, location, and minimal fix.
  Check the stated acceptance; do not turn stylistic preferences into blockers.”

## Source

Modified adaptation of Anthropic's Apache-2.0
[code explorer](https://github.com/anthropics/claude-plugins-official/blob/ab024cdc/plugins/feature-dev/agents/code-explorer.md)
and [code architect](https://github.com/anthropics/claude-plugins-official/blob/ab024cdc/plugins/feature-dev/agents/code-architect.md).
