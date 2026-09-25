// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/api/openai/coding`: the tools Codex models are trained to use, over a
 * workspace you supply.
 *
 * ```ts
 * const fs = new MemoryFileSystem({ "src/app.ts": source });
 * const tools = new ToolRegistry(codingTools({ fs }));
 * const result = await runAgent({
 *   client: gpt,
 *   conversation: new Conversation({ instructions: CODING_INSTRUCTIONS }).user(task),
 *   tools,
 * });
 * fs.snapshot(); // the edited files
 * ```
 *
 * - {@link applyPatchTool}: Codex's `apply_patch`, a custom tool whose
 *   input is constrained by Codex's Lark grammar (copied verbatim from
 *   `codex-rs/core/assets/tools/apply_patch.lark`), applied all or nothing.
 * - {@link execCommandTool}: Codex's `exec_command` (the current shell tool,
 *   `shell_type: shell_command` in its catalog) and {@link legacyShellTool}
 *   (the older `shell` with an argv list). Both run through a
 *   {@link ShellRunner} you provide: nothing here executes anything on the
 *   host.
 * - {@link readOnlyTools}: `read_file`, `list_dir` and `grep_files`.
 *
 * @module
 */

import { v } from "@celld/sieve";
import { applyPatch } from "./apply_patch.ts";
import { type FileSystem, normalizePath } from "./fs.ts";
import {
  type CustomTool,
  customTool,
  functionTool,
  type Tool,
} from "./tools.ts";

export * from "./apply_patch.ts";
export * from "./fs.ts";

/** Codex's grammar for `apply_patch`, verbatim. */
export const APPLY_PATCH_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;

/** Codex's description of the tool, verbatim. */
export const APPLY_PATCH_DESCRIPTION =
  "The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.";

/** `apply_patch` over `fs`; its output is Codex's success summary. */
export function applyPatchTool(fs: FileSystem): CustomTool {
  return customTool({
    name: "apply_patch",
    description: APPLY_PATCH_DESCRIPTION,
    format: {
      type: "grammar",
      syntax: "lark",
      definition: APPLY_PATCH_GRAMMAR,
    },
    risk: "write",
    run: async (input) => (await applyPatch(fs, input)).summary,
  });
}

/** A command for a {@link ShellRunner}. */
export interface ShellCommand {
  /** A shell line (`exec_command`) or an argv list (`shell`). */
  readonly command: string | readonly string[];
  /** Workspace-relative working directory, or null for the root. */
  readonly workdir: string | null;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

/** What a command did. */
export interface ShellResult {
  /** Null when it was killed or never exited. */
  readonly exitCode: number | null;
  /** Standard output and error, interleaved as the runner saw them. */
  readonly output: string;
  readonly timedOut?: boolean;
}

/**
 * Runs commands somewhere: an exe.dev VM through `@celld/api/exedev`'s
 * `runOnVm`, a container, a test double. The tools never run anything on
 * the host themselves.
 */
export interface ShellRunner {
  run(command: ShellCommand): Promise<ShellResult>;
}

function formatExec(result: ShellResult, seconds: number): string {
  const lines = [
    result.exitCode === null
      ? result.timedOut ? "Process timed out" : "Process did not exit"
      : `Exit code: ${result.exitCode}`,
    `Wall time: ${seconds.toFixed(1)} seconds`,
    "Output:",
    result.output,
  ];
  return lines.join("\n");
}

function workdirOf(workdir: string | undefined | null): string | null {
  if (workdir === undefined || workdir === null || workdir === "") return null;
  const normalized = normalizePath(workdir);
  if (!normalized.ok) throw new Error(normalized.message);
  return normalized.path === "" ? null : normalized.path;
}

/**
 * Codex's `exec_command` parameters (`cmd`, `workdir`, `yield_time_ms`,
 * `max_output_tokens`, `shell`, `login`, `tty`), without its sandbox and
 * approval parameters, which belong to Codex's own harness. The runner
 * gets `yield_time_ms` (default 10 s, capped at 30 s, as Codex describes
 * it) as its timeout. Output is cut to about `max_output_tokens` * 4
 * characters (default 10,000 tokens).
 */
export function execCommandTool(
  runner: ShellRunner,
  options: { readonly maxTimeoutMs?: number } = {},
): Tool {
  const cap = options.maxTimeoutMs ?? 30_000;
  return functionTool({
    name: "exec_command",
    description: "Runs a command, returning its output and exit code.",
    strict: false,
    risk: "exec",
    timeoutMs: cap + 5_000,
    parameters: v.strictObject({
      cmd: v.string().describe("Shell command to execute."),
      workdir: v.string().describe(
        "Working directory for the command. Defaults to the turn cwd.",
      ).optional(),
      tty: v.boolean().describe(
        "True allocates a PTY for the command; false or omitted uses plain pipes.",
      ).optional(),
      yield_time_ms: v.number().describe(
        "Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms.",
      ).optional(),
      max_output_tokens: v.number().describe(
        "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.",
      ).optional(),
      shell: v.string().describe(
        "Shell binary to launch. Defaults to the user's default shell.",
      ).optional(),
      login: v.boolean().describe(
        "True runs the shell with -l/-i semantics; false disables them. Defaults to true.",
      ).optional(),
    }),
    run: async (args, context) => {
      const timeoutMs = Math.min(
        Math.max(args.yield_time_ms ?? 10_000, 250),
        cap,
      );
      const started = Date.now();
      const result = await runner.run({
        command: args.cmd,
        workdir: workdirOf(args.workdir),
        timeoutMs,
        signal: context.signal,
      });
      const budget = Math.max(1, Math.trunc(args.max_output_tokens ?? 10_000)) *
        4;
      const output = result.output.length > budget
        ? `${result.output.slice(0, budget)}\n…[output truncated]`
        : result.output;
      return formatExec({ ...result, output }, (Date.now() - started) / 1000);
    },
  });
}

/**
 * The earlier Codex `shell` tool: an argv list, a working directory and a
 * timeout. Some models and prompts still expect it.
 */
export function legacyShellTool(
  runner: ShellRunner,
  options: { readonly maxTimeoutMs?: number } = {},
): Tool {
  const cap = options.maxTimeoutMs ?? 120_000;
  return functionTool({
    name: "shell",
    description: "Runs a shell command and returns its output.",
    strict: false,
    risk: "exec",
    timeoutMs: cap + 5_000,
    parameters: v.strictObject({
      command: v.array(v.string()).describe("The command to execute"),
      workdir: v.string().describe(
        "The working directory to execute the command in",
      ).optional(),
      timeout_ms: v.number().describe(
        "The timeout for the command in milliseconds",
      ).optional(),
    }),
    run: async (args, context) => {
      if (args.command.length === 0) {
        throw new Error("command must not be empty");
      }
      const started = Date.now();
      const result = await runner.run({
        command: args.command,
        workdir: workdirOf(args.workdir),
        timeoutMs: Math.min(Math.max(args.timeout_ms ?? 10_000, 1), cap),
        signal: context.signal,
      });
      return formatExec(result, (Date.now() - started) / 1000);
    },
  });
}

/** `read_file`: numbered lines of a file, from `offset` (1-based) for `limit`. */
export function readFileTool(fs: FileSystem): Tool {
  return functionTool({
    name: "read_file",
    description:
      "Reads a text file from the workspace and returns its lines, numbered from 1.",
    risk: "read",
    parameters: v.strictObject({
      path: v.string().describe("Workspace-relative path of the file."),
      offset: v.int().min(1).describe(
        "First line to return (1-based); null for 1.",
      ).nullable(),
      limit: v.int().min(1).describe("Lines to return; null for 2000.")
        .nullable(),
    }),
    run: async ({ path, offset, limit }) => {
      const text = await fs.read(path);
      if (text === null) {
        throw new Error(
          await fs.kind(path) === "dir"
            ? `${path} is a directory`
            : `no such file: ${path}`,
        );
      }
      const lines = text.split(/\r?\n/);
      if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
      const first = (offset ?? 1) - 1;
      const shown = lines.slice(first, first + (limit ?? 2000));
      if (shown.length === 0) return `(${path} has ${lines.length} lines)`;
      const body = shown.map((line, index) => `${first + index + 1}: ${line}`)
        .join("\n");
      const rest = lines.length - (first + shown.length);
      return rest > 0 ? `${body}\n(${rest} more lines)` : body;
    },
  });
}

/** `list_dir`: the files under a directory, up to `depth` levels. */
export function listDirTool(fs: FileSystem): Tool {
  return functionTool({
    name: "list_dir",
    description: "Lists the files under a workspace directory.",
    risk: "read",
    parameters: v.strictObject({
      path: v.string().describe(
        "Workspace-relative directory; null for the root.",
      ).nullable(),
      depth: v.int().min(1).describe("Levels to descend; null for all.")
        .nullable(),
    }),
    run: async ({ path, depth }) => {
      const dir = path ?? "";
      const kind = await fs.kind(dir);
      if (kind !== "dir") {
        throw new Error(
          kind === "file" ? `${dir} is a file` : `no such directory: ${dir}`,
        );
      }
      const prefix = normalizePath(dir);
      const base = prefix.ok && prefix.path !== "" ? `${prefix.path}/` : "";
      const entries = new Set<string>();
      for (const file of await fs.list(dir)) {
        const parts = file.slice(base.length).split("/");
        entries.add(
          depth !== null && parts.length > depth
            ? `${parts.slice(0, depth).join("/")}/`
            : parts.join("/"),
        );
      }
      return [...entries].sort().join("\n") || "(empty)";
    },
  });
}

/** Converts a simple glob (`*`, `**`, `?`) to an anchored pattern. */
export function globPattern(glob: string): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      source += ".*";
      index++;
      if (glob[index + 1] === "/") index++;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`(^|/)${source}$`);
}

/** `grep_files`: lines matching a regular expression, as `path:line: text`. */
export function grepFilesTool(fs: FileSystem): Tool {
  return functionTool({
    name: "grep_files",
    description:
      "Searches workspace files for lines matching a regular expression.",
    risk: "read",
    parameters: v.strictObject({
      pattern: v.string().describe("A JavaScript regular expression."),
      path: v.string().describe("Directory to search; null for the root.")
        .nullable(),
      include: v.string().describe(
        "A glob that file paths must match, such as *.ts; null for all.",
      ).nullable(),
      limit: v.int().min(1).describe("Most matches to return; null for 200.")
        .nullable(),
    }),
    run: async ({ pattern, path, include, limit }) => {
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, "u");
      } catch (error) {
        throw new Error(
          `bad pattern: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      const filter = include === null ? null : globPattern(include);
      const max = limit ?? 200;
      const matches: string[] = [];
      for (const file of await fs.list(path ?? "")) {
        if (filter !== null && !filter.test(file)) continue;
        const text = await fs.read(file);
        if (text === null) continue;
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
          if (regex.test(lines[index])) {
            matches.push(`${file}:${index + 1}: ${lines[index]}`);
            if (matches.length >= max) {
              return `${matches.join("\n")}\n(stopped at ${max} matches)`;
            }
          }
        }
      }
      return matches.length === 0 ? "(no matches)" : matches.join("\n");
    },
  });
}

/** `read_file`, `list_dir` and `grep_files` over `fs`. */
export function readOnlyTools(fs: FileSystem): Tool[] {
  return [readFileTool(fs), listDirTool(fs), grepFilesTool(fs)];
}

/**
 * The usual set: read-only tools and `apply_patch` over `fs`, plus
 * `exec_command` when a runner is given. `readOnly: true` leaves out
 * everything that changes files or runs commands.
 */
export function codingTools(options: {
  readonly fs: FileSystem;
  readonly shell?: ShellRunner;
  readonly readOnly?: boolean;
}): Tool[] {
  const tools = readOnlyTools(options.fs);
  if (options.readOnly) return tools;
  tools.push(applyPatchTool(options.fs));
  if (options.shell !== undefined) tools.push(execCommandTool(options.shell));
  return tools;
}

/**
 * Default instructions for a coding agent: short, and meant to be replaced
 * or extended with the task's own conventions.
 */
export const CODING_INSTRUCTIONS = [
  "You are a coding agent working in a repository through tools.",
  "Read the relevant code before changing it. Make the smallest correct change.",
  "Edit files with apply_patch. Paths are relative to the workspace root; never use absolute paths.",
  "Keep existing style and conventions. Do not revert changes you did not make.",
  "When you are done, reply with a short summary of what you changed and anything left undone.",
].join("\n");
