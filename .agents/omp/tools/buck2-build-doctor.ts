// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import type { Tool, ToolAPI } from "../lib/tool.ts";
import { lines, literal, result, run } from "../lib/tool.ts";

interface Params {
  targets?: string[];
  checkCache?: boolean;
  checkVisibility?: boolean;
  checkCycles?: boolean;
  allChecks?: boolean;
  showLogs?: boolean;
  diagnosticLog?: string;
}

interface Command {
  args: string[];
  code: number;
  stdout: string;
  stderr: string;
}

interface Issue {
  kind: string;
  message: string;
  command?: number;
  evidence?: string;
}

// Buck's command identities include a target label followed by configuration
// and action information. Keep cell names, including hyphenated cell names.
function targetsIn(text: string): string[] {
  return [
    ...new Set(
      text.match(
        /(?:[A-Za-z0-9_.-]+)?\/\/[^\s"'()\[\],:]*:[^\s"'()\[\],;]+/g,
      ) ?? [],
    ),
  ];
}

function fields(value: unknown, names: Record<string, true>): string[] {
  if (!value || typeof value !== "object") return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (Object.hasOwn(names, key) && typeof child === "string") {
      found.push(child);
    } else if (child && typeof child === "object") {
      found.push(...fields(child, names));
    }
  }
  return found;
}

const cyclePattern =
  /cycle detected|dependency cycle|circular dependency|cycle in (?:the )?(?:dependency|target) graph/i;

const patterns = [
  {
    kind: "visibility",
    pattern:
      /not visible|visibility (?:error|violation)|cannot depend on .*visibility/i,
    suggestion:
      "Inspect the provider visibility and the failing consumer; allow only the required consumer scope if access is intended.",
  },
  {
    kind: "cycle",
    pattern: cyclePattern,
    suggestion:
      "Read Buck's cycle trace and remove the cyclic edge or extract shared code; query the smallest implicated graph.",
  },
  {
    kind: "missing_dependency_or_source",
    pattern:
      /unresolved import|cannot find (?:crate|module|type|value)|no such file or directory/i,
    suggestion:
      "Distinguish a missing source/module, disabled feature, and missing declared dependency before changing BUILD metadata.",
  },
  {
    kind: "compilation",
    pattern: /rustc failed|(?:error: )?could not compile|compilation failed/i,
    suggestion:
      "Read the first compiler diagnostic and inspect the implicated source and declared inputs.",
  },
  {
    kind: "linking",
    pattern:
      /undefined reference|undefined symbol|ld returned|linker command failed/i,
    suggestion:
      "Locate the defining library and inspect declared dependencies, ABI, and linker inputs.",
  },
  {
    kind: "cache",
    pattern:
      /cache[^\n]*(?:error|failed|corrupt)|(?:error|failed|corrupt)[^\n]*cache/i,
    suggestion:
      "Inspect the reported cache transport or artifact error and cache configuration; preserve logs before considering state changes.",
  },
  {
    kind: "remote_execution",
    pattern: /remote execution failed|remote execution error/i,
    suggestion:
      "Inspect the execution platform, declared inputs, and reported remote-execution failure; this is not by itself evidence of cache corruption.",
  },
];

export default function (pi: ToolAPI): Tool<Params> {
  const t = pi.typebox.Type;
  return {
    name: "buck2_build_doctor",
    label: "Buck2 Build Doctor",
    description:
      "Read recent Buck2 failed actions and compiler stderr, inspect target existence and optional visibility/cache/dependency graph checks. Findings are evidence-backed observations, not a build verification; no builds or destructive fixes are run.",
    approval: "read",
    parameters: t.Object({
      targets: t.Optional(
        t.Array(t.String({ minLength: 1 }), {
          description:
            "Target labels or patterns to inspect; otherwise use labels in recent failed-action identities.",
        }),
      ),
      checkCache: t.Optional(
        t.Boolean({
          description: "Inspect cache configuration, not cache integrity.",
        }),
      ),
      checkVisibility: t.Optional(
        t.Boolean({
          description:
            "Report visibility metadata without treating private visibility as an error.",
        }),
      ),
      checkCycles: t.Optional(
        t.Boolean({
          description:
            "Load each target's transitive unconfigured graph; report Buck cycle errors or successful graph loads.",
        }),
      ),
      allChecks: t.Optional(
        t.Boolean({
          description:
            "Also inspect direct dependencies, visibility, cache configuration, and cycles.",
        }),
      ),
      showLogs: t.Optional(
        t.Boolean({
          description:
            "Include parsed failed-action records and supplied diagnostic text in log details.",
        }),
      ),
      diagnosticLog: t.Optional(
        t.String({
          description:
            "Actual reported compiler/Starlark/runner diagnostics unavailable from failed-action logs. Never pass a log path here.",
        }),
      ),
    }, { additionalProperties: false }),
    async execute(_id, params, _onUpdate, _ctx, signal) {
      const commands: Command[] = [];
      const issues: Issue[] = [];
      const suggestions = new Set<string>();
      const evidence: unknown[] = [];
      const analyze = (text: string, source: string, command?: number) => {
        for (const entry of patterns) {
          const matching = lines(text).filter((line) =>
            entry.pattern.test(line)
          );
          if (!matching.length) continue;
          issues.push({
            kind: entry.kind,
            message:
              `Diagnostic pattern observed in ${source}; inspect the original error before choosing a fix.`,
            command,
            evidence: matching.join("\n"),
          });
          suggestions.add(entry.suggestion);
        }
      };
      const execute = async (args: string[], purpose: string) => {
        const output = await run(pi, args, signal);
        const command = commands.push({
          args,
          code: output.code,
          stdout: output.stdout,
          stderr: output.stderr,
        }) - 1;
        if (output.code !== 0) {
          issues.push({
            kind: "diagnostic_command_failed",
            message:
              `${purpose} failed; the check is inconclusive, not successful.`,
            command,
            evidence: output.stderr || output.stdout,
          });
          analyze(output.stderr, purpose, command);
          analyze(output.stdout, purpose, command);
        }
        return { ...output, command };
      };
      const parseRecords = (
        text: string,
        command: number,
      ): unknown[] | undefined => {
        try {
          return lines(text).map((line) => JSON.parse(line));
        } catch (error) {
          issues.push({
            kind: "unsupported_log_format",
            message: `Cannot parse Buck's JSON-lines action log: ${
              String(error)
            }`,
            command,
          });
          return undefined;
        }
      };

      // Both log reads precede graph/config commands, so they refer to the same
      // recent invocation rather than one of this tool's own diagnostic queries.
      const failed = await execute(
        ["log", "what-failed", "--format", "json"],
        "Recent failed-action lookup",
      );
      const diagnostics = await execute([
        "log",
        "what-ran",
        "--failed",
        "--show-std-err",
        "--format",
        "json",
      ], "Failed-action stderr lookup");
      const failedRecords = failed.code === 0
        ? parseRecords(failed.stdout, failed.command)
        : undefined;
      const diagnosticRecords = diagnostics.code === 0
        ? parseRecords(diagnostics.stdout, diagnostics.command)
        : undefined;
      const identities = (failedRecords ?? []).flatMap((record) =>
        fields(record, { identity: true, target: true, target_label: true })
      );
      const failedTargets = [...new Set(identities.flatMap(targetsIn))];
      if (failedRecords?.length) {
        issues.push({
          kind: "recent_failed_actions",
          message:
            `${failedRecords.length} failed actions recorded in the recent invocation.`,
          command: failed.command,
        });
        if (!failedTargets.length) {
          evidence.push({
            check: "recent_failures",
            status: "unavailable_target_labels",
            command: failed.command,
            message:
              "Failed records contain no recognized target identities; pass targets explicitly.",
          });
        }
      }
      const diagnosticText = (diagnosticRecords ?? []).flatMap((record) =>
        fields(record, { std_err: true, stderr: true })
      );
      for (const text of diagnosticText) {
        analyze(text, "failed-action stderr", diagnostics.command);
      }
      if (params.diagnosticLog !== undefined) {
        analyze(params.diagnosticLog, "supplied diagnostic log");
      }
      const targets = [
        ...new Set(params.targets?.length ? params.targets : failedTargets),
      ];
      if (!targets.length) {
        evidence.push({
          check: "targets",
          status: "not_checked",
          message:
            "No target labels supplied or found in failed-action identities; no repository-wide scope is assumed.",
        });
        if (params.checkCycles || params.checkVisibility || params.allChecks) {
          issues.push({
            kind: "check_unavailable",
            message:
              "Target graph/visibility checks require an explicit target or a target identity from recent failed actions.",
          });
        }
      }
      for (const target of targets) {
        const existence = await execute(
          ["targets", target],
          `Target lookup for ${target}`,
        );
        const resolvedTargets = existence.code === 0
          ? lines(existence.stdout)
          : [];
        evidence.push({
          check: "target_exists",
          target,
          command: existence.command,
          status: existence.code === 0
            ? (resolvedTargets.length ? "resolved" : "no_matches")
            : "inconclusive",
          resolvedTargets,
        });
        if (existence.code === 0 && !resolvedTargets.length) {
          issues.push({
            kind: "target_no_matches",
            message: `Target lookup for ${target} returned no targets.`,
            command: existence.command,
          });
        }
        if (existence.code !== 0 || !resolvedTargets.length) continue;
        if (params.checkVisibility || params.allChecks) {
          const visibility = await execute([
            "uquery",
            literal(target),
            "--output-attribute",
            "^visibility$",
            "--json",
          ], `Visibility inspection for ${target}`);
          evidence.push({
            check: "visibility",
            target,
            command: visibility.command,
            status: visibility.code === 0 ? "observed" : "inconclusive",
            message:
              "Declared visibility is metadata; private visibility may be intentional and does not prove a consumer violation.",
          });
        }
        if (params.allChecks) {
          const dependencies = await execute([
            "uquery",
            `deps(${literal(target)}, 1)`,
          ], `Direct dependency inspection for ${target}`);
          const roots = new Set(resolvedTargets);
          evidence.push({
            check: "dependencies",
            target,
            command: dependencies.command,
            status: dependencies.code === 0 ? "observed" : "inconclusive",
            dependencies: dependencies.code === 0
              ? lines(dependencies.stdout).filter((label) => !roots.has(label))
              : undefined,
          });
        }
        if (params.checkCycles || params.allChecks) {
          const graph = await execute(
            ["uquery", `deps(${literal(target)})`],
            `Transitive graph loading for ${target}`,
          );
          const cycleReported = graph.code !== 0 &&
            cyclePattern.test(`${graph.stderr}\n${graph.stdout}`);
          evidence.push({
            check: "cycles",
            target,
            command: graph.command,
            status: graph.code === 0
              ? "no_cycle_reported"
              : cycleReported
              ? "cycle_reported"
              : "inconclusive",
            nodes: graph.code === 0 ? lines(graph.stdout).length : undefined,
            message: graph.code === 0
              ? "Buck successfully loaded the transitive unconfigured graph and reported no cycle. This does not verify a configured build; select branches are combined in uquery."
              : cycleReported
              ? "Buck reported a dependency cycle while loading this graph; see the diagnostic command output for the trace."
              : "Buck could not load the graph without an explicit cycle diagnostic; the cycle check is inconclusive.",
          });
        }
      }
      if (params.checkCache || params.allChecks) {
        const cache = await execute(
          ["audit", "config", "cache", "--json"],
          "Cache configuration inspection",
        );
        evidence.push({
          check: "cache",
          command: cache.command,
          status: cache.code === 0 ? "observed" : "inconclusive",
          message:
            "Cache configuration is not a cache-integrity or connectivity test; an empty cache section is not an error.",
        });
      }
      return result({
        targets,
        failedTargets,
        commands,
        evidence,
        issues,
        suggestions: [...suggestions],
        logs: {
          failedActions: {
            command: failed.command,
            status: failedRecords ? "read" : "unavailable",
            count: failedRecords?.length,
            records: params.showLogs ? failedRecords : undefined,
          },
          diagnostics: {
            command: diagnostics.command,
            status: diagnosticRecords ? "read" : "unavailable",
            stderrRecords: diagnosticText.length,
            records: params.showLogs ? diagnosticRecords : undefined,
          },
          provided: params.diagnosticLog !== undefined,
          diagnosticLog: params.showLogs ? params.diagnosticLog : undefined,
          limitation:
            "Action logs may be empty after parsing, target-loading, or analysis failures and do not contain every build diagnostic. Supply the original error via diagnosticLog when needed. No finding here proves a build succeeds.",
        },
      });
    },
  };
}
