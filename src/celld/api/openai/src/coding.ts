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
 *   `codex-rs/core/assets/tools/apply_patch.lark`), applied all or nothing
 *   unless the call is cancelled between two files (or the file system
 *   refuses a write), which stops it with a `PartialPatchError`.
 * - {@link execCommandTool}: Codex's `exec_command` (the current shell tool,
 *   `shell_type: shell_command` in its catalog) and {@link legacyShellTool}
 *   (the older `shell` with an argv list). Both run through a
 *   {@link ShellRunner} you provide: nothing here executes anything on the
 *   host.
 * - {@link readOnlyTools}: `read_file`, `list_dir` and `grep_files`, the
 *   only ones declared `mutates: false`. The others mutate their
 *   workspace, so the registry runs them one at a time per workspace.
 *
 * @module
 */

import { nonNegativeMs } from "@celld/core/bounds";
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

/** The workspace key of tools over `fs` (see `ToolSpecBase.workspace`). */
export function workspaceOf(fs: FileSystem): object {
  return fs.workspace ?? fs;
}

/**
 * `apply_patch` over `fs`; its output is Codex's success summary. It
 * mutates `options.workspace`, by default `fs.workspace ?? fs`.
 */
export function applyPatchTool(
  fs: FileSystem,
  options: { readonly workspace?: object } = {},
): CustomTool {
  return customTool({
    mutates: true,
    workspace: options.workspace ?? workspaceOf(fs),
    name: "apply_patch",
    description: APPLY_PATCH_DESCRIPTION,
    format: {
      type: "grammar",
      syntax: "lark",
      definition: APPLY_PATCH_GRAMMAR,
    },
    risk: "write",
    run: async (input, context) =>
      (await applyPatch(fs, input, { signal: context.signal })).summary,
  });
}

/** A command for a {@link ShellRunner}. */
export interface ShellCommand {
  /** A shell line (`exec_command`) or an argv list (`shell`). */
  readonly command: string | readonly string[];
  /** Workspace-relative working directory, or null for the root. */
  readonly workdir: string | null;
  readonly timeoutMs: number;
  /**
   * Fires when the tool call times out or is cancelled. The runner must
   * then stop the command, and its `run` must not settle until the
   * command has stopped (rejecting with the signal's reason), because the
   * registry reports the timeout only once it does.
   */
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
  /**
   * What its commands can change, for the registry's mutation lanes; the
   * same object as the workspace's file system's. Default: the runner.
   */
  readonly workspace?: object;
}

/** Options of the shell tools. */
export interface ShellToolOptions {
  /**
   * The longest timeout the model may ask for: from 1 ms to
   * {@link MAX_SHELL_TIMEOUT_MS}. The tool's own timeout is this plus 5 s.
   */
  readonly maxTimeoutMs?: number;
  /** The workspace key; default `runner.workspace ?? runner`. */
  readonly workspace?: object;
}

/**
 * The largest {@link ShellToolOptions.maxTimeoutMs}: the tool's timeout
 * (this plus 5 s) must still fit a runtime timer, and no sandbox runs a
 * command for more than a day.
 */
export const MAX_SHELL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// The tool's timeout leaves the runner 5 s past the command's own.
const SHELL_TIMEOUT_SLACK_MS = 5_000;

function shellCap(options: ShellToolOptions, fallback: number): number {
  return nonNegativeMs(options.maxTimeoutMs ?? fallback, {
    name: "maxTimeoutMs",
    min: 1,
    max: MAX_SHELL_TIMEOUT_MS,
  });
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
 *
 * @throws {RangeError} `maxTimeoutMs` out of range (see
 * {@link ShellToolOptions}).
 */
export function execCommandTool(
  runner: ShellRunner,
  options: ShellToolOptions = {},
): Tool {
  const cap = shellCap(options, 30_000);
  return functionTool({
    mutates: true,
    workspace: options.workspace ?? runner.workspace ?? runner,
    name: "exec_command",
    description: "Runs a command, returning its output and exit code.",
    strict: false,
    risk: "exec",
    timeoutMs: cap + SHELL_TIMEOUT_SLACK_MS,
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
 *
 * @throws {RangeError} `maxTimeoutMs` out of range (see
 * {@link ShellToolOptions}).
 */
export function legacyShellTool(
  runner: ShellRunner,
  options: ShellToolOptions = {},
): Tool {
  const cap = shellCap(options, 120_000);
  return functionTool({
    mutates: true,
    workspace: options.workspace ?? runner.workspace ?? runner,
    name: "shell",
    description: "Runs a shell command and returns its output.",
    strict: false,
    risk: "exec",
    timeoutMs: cap + SHELL_TIMEOUT_SLACK_MS,
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
    mutates: false,
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
    run: async ({ path, offset, limit }, context) => {
      const text = await fs.read(path, { signal: context.signal });
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
    mutates: false,
    description: "Lists the files under a workspace directory.",
    risk: "read",
    parameters: v.strictObject({
      path: v.string().describe(
        "Workspace-relative directory; null for the root.",
      ).nullable(),
      depth: v.int().min(1).describe("Levels to descend; null for all.")
        .nullable(),
    }),
    run: async ({ path, depth }, context) => {
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
      for (const file of await fs.list(dir, { signal: context.signal })) {
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

/** A compiled glob; see {@link globMatcher}. */
export interface GlobMatcher {
  /** The glob it was made from. */
  readonly glob: string;
  /** Whether `path` (or a path ending in `/` then it) matches. */
  test(path: string): boolean;
}

/** The longest glob {@link globMatcher} takes. */
export const MAX_GLOB_LENGTH = 1024;

type GlobToken = "*" | "**" | "?" | string;

/**
 * A simple glob as a matcher: `*` is any run of characters but `/`, `**`
 * any run at all (`**` followed by `/` also matches nothing), `?` one
 * character but `/`, and everything else itself. It matches a whole path
 * or the end of one after a `/` (`*.ts` matches `src/a.ts`).
 *
 * Globs come from models and callers, so they are never turned into a
 * regular expression: matching is a table over (glob position, path
 * position), linear in the path for each glob token.
 *
 * @throws {RangeError} for a glob over {@link MAX_GLOB_LENGTH} characters.
 */
export function globMatcher(glob: string): GlobMatcher {
  if (glob.length > MAX_GLOB_LENGTH) {
    throw new RangeError(
      `a glob has at most ${MAX_GLOB_LENGTH} characters, got ${glob.length}`,
    );
  }
  const tokens: GlobToken[] = [];
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      index++;
      // `**/` also matches no directory at all.
      if (glob[index + 1] === "/") {
        index++;
        tokens.push("**/");
      } else {
        tokens.push("**");
      }
    } else if (char === "*" || char === "?") {
      tokens.push(char);
    } else {
      tokens.push(char);
    }
  }
  // A glob matches the whole path or its end after a `/`: that is the glob
  // behind an implicit `**/`.
  const all: GlobToken[] = ["**/", ...tokens];
  // One pass per token over the path, from the right: `next[p]` says the
  // tokens after this one match `path[p..]`. O(tokens × path length).
  const matches = (path: string): boolean => {
    const n = path.length;
    let next = new Uint8Array(n + 1);
    next[n] = 1;
    for (let t = all.length - 1; t >= 0; t--) {
      const token = all[t];
      const here = new Uint8Array(n + 1);
      if (token === "*" || token === "**") {
        for (let p = n; p >= 0; p--) {
          here[p] = next[p] === 1 ||
              (p < n && (token === "**" || path[p] !== "/") &&
                here[p + 1] === 1)
            ? 1
            : 0;
        }
      } else if (token === "**/") {
        // Nothing, or anything that ends in a `/`.
        let slash = false;
        for (let p = n; p >= 0; p--) {
          if (p < n && path[p] === "/" && next[p + 1] === 1) slash = true;
          here[p] = next[p] === 1 || slash ? 1 : 0;
        }
      } else if (token === "?") {
        for (let p = 0; p < n; p++) {
          here[p] = path[p] !== "/" && next[p + 1] === 1 ? 1 : 0;
        }
      } else {
        for (let p = 0; p < n; p++) {
          here[p] = path[p] === token && next[p + 1] === 1 ? 1 : 0;
        }
      }
      next = here;
    }
    return next[0] === 1;
  };
  return Object.freeze({ glob, test: matches });
}

/** The longest `grep_files` regular expression, in UTF-8 bytes. */
export const MAX_GREP_REGEX_BYTES = 256;

/**
 * `grep_files`: lines containing a text, as `path:line: text`. The pattern
 * is literal unless `regex` is true; a regular expression runs only where
 * a deadline can stop it (the file system's `search`, such as a sandbox's
 * `grep -E`), never in this isolate, and is refused over a file system
 * without one.
 */
export function grepFilesTool(fs: FileSystem): Tool {
  return functionTool({
    name: "grep_files",
    mutates: false,
    description:
      "Searches workspace files for lines containing a text, or matching a POSIX extended regular expression.",
    risk: "read",
    parameters: v.strictObject({
      pattern: v.string().min(1).describe(
        "The text to find, matched literally unless regex is true.",
      ),
      regex: v.boolean().describe(
        "true: pattern is a POSIX extended regular expression (at most 256 bytes); null for literal text.",
      ).nullable(),
      path: v.string().describe("Directory to search; null for the root.")
        .nullable(),
      include: v.string().describe(
        "A glob that file paths must match, such as *.ts; null for all.",
      ).nullable(),
      limit: v.int().min(1).describe("Most matches to return; null for 200.")
        .nullable(),
    }),
    run: async ({ pattern, regex, path, include, limit }, context) => {
      const filter = include === null ? null : globMatcher(include);
      const max = limit ?? 200;
      const dir = path ?? "";
      const lines: string[] = [];
      let cut = false;
      if (regex === true) {
        if (fs.search === undefined) {
          throw new Error(
            "this workspace cannot run regular expressions; search for literal text (regex: null)",
          );
        }
        if (
          new TextEncoder().encode(pattern).byteLength > MAX_GREP_REGEX_BYTES
        ) {
          throw new Error(
            `a regular expression has at most ${MAX_GREP_REGEX_BYTES} bytes`,
          );
        }
        // Filtered by glob here, so ask for more than `max` when filtering.
        const found = await fs.search({
          pattern,
          dir,
          limit: filter === null ? max : Math.max(max, 10_000),
          signal: context.signal,
        });
        for (const match of found.matches) {
          if (filter !== null && !filter.test(match.path)) continue;
          lines.push(`${match.path}:${match.line}: ${match.text}`);
          if (lines.length >= max) {
            cut = true;
            break;
          }
        }
        cut ||= found.truncated && filter === null;
      } else {
        // Read-only, so nothing fences a stopped scan: it stops itself,
        // between files and inside the file system's own calls.
        const signal = context.signal;
        search: for (const file of await fs.list(dir, { signal })) {
          signal.throwIfAborted();
          if (filter !== null && !filter.test(file)) continue;
          const text = await fs.read(file, { signal });
          if (text === null) continue;
          const split = text.split(/\r?\n/);
          for (let index = 0; index < split.length; index++) {
            if (split[index].includes(pattern)) {
              lines.push(`${file}:${index + 1}: ${split[index]}`);
              if (lines.length >= max) {
                cut = true;
                break search;
              }
            }
          }
        }
      }
      if (lines.length === 0) return "(no matches)";
      return cut
        ? `${lines.join("\n")}\n(stopped at ${max} matches)`
        : lines.join("\n");
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
 * everything that changes files or runs commands. The shell runs in the
 * same workspace as `fs`, so `apply_patch` and `exec_command` share one
 * mutation lane (`workspace`, default `fs.workspace ?? fs`).
 */
export function codingTools(options: {
  readonly fs: FileSystem;
  readonly shell?: ShellRunner;
  readonly readOnly?: boolean;
  readonly workspace?: object;
}): Tool[] {
  const tools = readOnlyTools(options.fs);
  if (options.readOnly) return tools;
  const workspace = options.workspace ?? workspaceOf(options.fs);
  tools.push(applyPatchTool(options.fs, { workspace }));
  if (options.shell !== undefined) {
    tools.push(execCommandTool(options.shell, { workspace }));
  }
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
