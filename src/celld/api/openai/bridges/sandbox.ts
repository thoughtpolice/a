// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/api/openai/sandbox`: a `@celld/sandbox` sandbox as the workspace of
 * the coding tools, and Blue Team helpers that run analyzers inside one.
 *
 * ```ts
 * import { getSandbox } from "@celld/sandbox";
 * import { sandboxCodingTools } from "@celld/api/openai/sandbox";
 *
 * const box = getSandbox(env.SANDBOX, conversationId);
 * const tools = new ToolRegistry(sandboxCodingTools(box));
 * await runAgent({ client: gpt, conversation, tools });
 *
 * const { disassembly, result } = await reverseEngineerFile(gpt, box, "upload/a.out");
 * const review = await reviewCheckout(gpt, box, "https://github.com/acme/api");
 * ```
 *
 * - {@link sandboxFileSystem} and {@link sandboxShellRunner} adapt a
 *   sandbox (a `SandboxClient` or a `SandboxCore`) to the coding tools'
 *   {@link FileSystem} and {@link ShellRunner}.
 * - {@link sandboxApplyPatch} applies a Codex patch by staging every new
 *   file next to its target and then renaming each into place, and
 *   {@link sandboxCodingTools} is `codingTools` with that `apply_patch`.
 * - {@link disassemble} runs objdump, strings, readelf, nm or hexdump on a
 *   workspace file; {@link reverseEngineerFile} feeds the output to
 *   `reverseEngineer`.
 * - {@link reviewCheckout} clones a repository into the sandbox and runs
 *   `securityReview` over its text files, read through a read-only view.
 *
 * Analyzers parse hostile input. Run untrusted binaries in a sandbox
 * whose container runtime is gVisor (`runsc`), not the default runc: a
 * parser bug in binutils then lands in gVisor's user-space kernel rather
 * than the host's. See `@celld/sandbox`'s README.
 *
 * This is a target of its own, so `@celld/api/openai` does not depend on
 * `@celld/sandbox`.
 *
 * @module
 */

import {
  type CustomTool,
  customTool,
  type GptClient,
  type Tool,
} from "@celld/api/openai";
import {
  type Analysis,
  type AnalysisOptions,
  type Finding,
  type ReNotes,
  reverseEngineer,
  type SecurityReview,
  securityReview,
} from "@celld/api/openai/blueteam";
import {
  type AppliedPatch,
  APPLY_PATCH_DESCRIPTION,
  APPLY_PATCH_GRAMMAR,
  applyPatch,
  execCommandTool,
  type FileSystem,
  globPattern,
  readOnly,
  readOnlyTools,
  requirePath,
  type ShellRunner,
} from "@celld/api/openai/coding";
import { type ExecResult, type SandboxApi, SandboxError } from "@celld/sandbox";

/** What {@link sandboxFileSystem} uses: a `SandboxClient` or `SandboxCore`. */
export type SandboxFiles = Pick<
  SandboxApi,
  "readFile" | "writeFile" | "deleteFile" | "exists" | "listFiles"
>;

/** What {@link sandboxShellRunner} uses. */
export type SandboxShell = Pick<SandboxApi, "exec" | "execShell">;

/** What {@link sandboxApplyPatch} uses. */
export type SandboxPatcher =
  & SandboxFiles
  & Pick<SandboxApi, "renameFile" | "exec">;

/** What {@link sandboxCodingTools} uses. */
export type SandboxWorkspace = SandboxPatcher & SandboxShell;

/** What {@link reviewCheckout} uses. */
export type SandboxCheckout = SandboxFiles & Pick<SandboxApi, "gitCheckout">;

function code(error: unknown): string | null {
  return SandboxError.from(error)?.code ?? null;
}

/**
 * The sandbox's workspace as a coding-tools file system. Paths are
 * workspace-relative on both sides. `read` answers null for missing,
 * directory and non-UTF-8 paths (the tools work on text); `list` is
 * recursive and includes dotfiles, which agents need (`.gitignore`).
 * Paths outside the workspace still throw.
 */
export function sandboxFileSystem(sandbox: SandboxFiles): FileSystem {
  return {
    async read(path) {
      try {
        const file = await sandbox.readFile(path);
        return file.encoding === "utf-8" ? file.content : null;
      } catch (error) {
        const found = code(error);
        if (
          found === "not_found" || found === "is_directory" ||
          found === "not_text"
        ) {
          return null;
        }
        throw SandboxError.wrap(error);
      }
    },
    async write(path, content) {
      await sandbox.writeFile(path, content);
    },
    async remove(path) {
      await sandbox.deleteFile(path);
    },
    async kind(path) {
      const found = await sandbox.exists(path);
      if (!found.exists) return null;
      return found.kind === "dir" ? "dir" : "file";
    },
    async list(dir) {
      try {
        const listing = await sandbox.listFiles(dir, {
          recursive: true,
          includeHidden: true,
          limit: 100_000,
        });
        return listing.entries
          .filter((entry) => entry.kind === "file")
          .map((entry) => entry.path)
          .sort();
      } catch (error) {
        if (code(error) === "not_found") return [];
        throw SandboxError.wrap(error);
      }
    },
  };
}

/**
 * The sandbox as a coding-tools shell: a string runs with the sandbox's
 * shell, an argv list directly. Stdout and stderr come back interleaved,
 * and the command's `timeoutMs` is the sandbox's deadline.
 */
export function sandboxShellRunner(
  sandbox: SandboxShell,
  options: { readonly maxOutputBytes?: number } = {},
): ShellRunner {
  return {
    async run(command) {
      if (command.signal.aborted) {
        throw command.signal.reason ?? new Error("the command was cancelled");
      }
      const execOptions = {
        ...(command.workdir === null ? {} : { cwd: command.workdir }),
        timeoutMs: Math.max(1, Math.round(command.timeoutMs)),
        combineOutput: true,
        ...(options.maxOutputBytes === undefined
          ? {}
          : { maxOutputBytes: options.maxOutputBytes }),
      };
      const result = typeof command.command === "string"
        ? await sandbox.execShell(command.command, execOptions)
        : await sandbox.exec([...command.command], execOptions);
      return {
        exitCode: result.exitCode,
        output: result.truncated
          ? `${result.stdout}\n…[output truncated]`
          : result.stdout,
        timedOut: result.timedOut,
      };
    },
  };
}

// MARK: apply_patch

/**
 * A patch that failed while its files were being renamed into place, so
 * some targets have their new content and the rest do not.
 */
export class PartialPatchError extends Error {
  /** Workspace paths that were replaced or removed. */
  readonly committed: readonly string[];
  /** Workspace paths that were not. */
  readonly pending: readonly string[];

  constructor(
    committed: readonly string[],
    pending: readonly string[],
    cause: unknown,
  ) {
    super(
      `the patch was only partly applied: ${committed.length} of ${
        committed.length + pending.length
      } files changed (${cause instanceof Error ? cause.message : cause})`,
      { cause },
    );
    this.name = "PartialPatchError";
    this.committed = committed;
    this.pending = pending;
  }
}

function tempName(path: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const tag = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const slash = path.lastIndexOf("/");
  const dir = slash < 0 ? "" : path.slice(0, slash + 1);
  return `${dir}.${path.slice(slash + 1)}.patch-${tag}`;
}

// Prints each existing regular file's octal mode, `-` for the rest.
const MODES = 'for p; do if [ -f "$p" ]; then stat -L -c %a -- "$p"; ' +
  "else echo -; fi; done";

async function modesOf(
  sandbox: Pick<SandboxApi, "exec">,
  paths: readonly string[],
): Promise<(string | null)[]> {
  if (paths.length === 0) return [];
  const result = await sandbox.exec(["sh", "-c", MODES, "sh", ...paths], {
    timeoutMs: 30_000,
  });
  const lines = result.stdout.split("\n").slice(0, paths.length);
  if (!result.success || lines.length !== paths.length) {
    throw new Error(`could not read file modes: ${result.stderr.trim()}`);
  }
  return lines.map((line) => /^[0-7]{3,4}$/.test(line) ? line : null);
}

/**
 * Applies a Codex patch to the sandbox's workspace with a narrow window
 * for partial results:
 *
 * 1. the patch is parsed and planned against the workspace (as
 *    `applyPatch` does); a bad patch changes nothing;
 * 2. every new file is written to a temporary name beside its target
 *    (`dir/.name.patch-<hex>`), keeping the target's permissions; a
 *    failure here removes the temporary files and changes nothing;
 * 3. each temporary file is renamed over its target, then deleted files
 *    are removed.
 *
 * Each rename is atomic, but the patch as a whole is not: a failure (or
 * another writer) during step 3 leaves some files changed, reported as a
 * {@link PartialPatchError} naming which. A target that was a symbolic link
 * becomes a regular file.
 *
 * @throws {ApplyPatchError} for a patch that does not parse or fit.
 */
export async function sandboxApplyPatch(
  sandbox: SandboxPatcher,
  patch: string,
): Promise<AppliedPatch> {
  const live = sandboxFileSystem(sandbox);
  // `applyPatch` plans everything before its first write, so recording the
  // writes and removals here yields the whole change or nothing.
  const planned = new Map<string, string | null>();
  const staging: FileSystem = {
    read: (path) => live.read(path),
    kind: (path) => live.kind(path),
    list: (dir) => live.list(dir),
    write(path, content) {
      planned.delete(path);
      planned.set(path, content);
      return Promise.resolve();
    },
    remove(path) {
      planned.delete(path);
      planned.set(path, null);
      return Promise.resolve();
    },
  };
  const applied = await applyPatch(staging, patch);
  const writes = [...planned].filter(
    (entry): entry is [string, string] => entry[1] !== null,
  );
  const removals = [...planned].filter(([, content]) => content === null)
    .map(([path]) => path);
  const modes = await modesOf(sandbox, writes.map(([path]) => path));
  const staged: { path: string; temp: string }[] = [];
  const discard = async (temps: readonly string[]) => {
    for (const temp of temps) {
      await sandbox.deleteFile(temp).catch(() => {});
    }
  };
  try {
    for (const [index, [path, content]] of writes.entries()) {
      const temp = tempName(path);
      staged.push({ path, temp });
      const mode = modes[index];
      await sandbox.writeFile(
        temp,
        content,
        mode === null ? {} : { mode },
      );
    }
  } catch (error) {
    await discard(staged.map((entry) => entry.temp));
    throw error;
  }
  const committed: string[] = [];
  for (const [index, { path, temp }] of staged.entries()) {
    try {
      await sandbox.renameFile(temp, path);
    } catch (error) {
      await discard(staged.slice(index).map((entry) => entry.temp));
      throw new PartialPatchError(committed, [
        ...staged.slice(index).map((entry) => entry.path),
        ...removals,
      ], error);
    }
    committed.push(path);
  }
  for (const [index, path] of removals.entries()) {
    try {
      await sandbox.deleteFile(path);
    } catch (error) {
      if (code(error) === "not_found") continue;
      throw new PartialPatchError(committed, removals.slice(index), error);
    }
    committed.push(path);
  }
  return applied;
}

/** `apply_patch` over the sandbox, applied with {@link sandboxApplyPatch}. */
export function sandboxApplyPatchTool(sandbox: SandboxPatcher): CustomTool {
  return customTool({
    name: "apply_patch",
    description: APPLY_PATCH_DESCRIPTION,
    format: {
      type: "grammar",
      syntax: "lark",
      definition: APPLY_PATCH_GRAMMAR,
    },
    risk: "write",
    run: async (input) => (await sandboxApplyPatch(sandbox, input)).summary,
  });
}

/**
 * `codingTools` over a sandbox: `read_file`, `list_dir` and `grep_files`,
 * then {@link sandboxApplyPatchTool} and `exec_command` unless `readOnly`.
 * `shell: false` leaves out `exec_command`.
 */
export function sandboxCodingTools(
  sandbox: SandboxWorkspace,
  options: {
    readonly readOnly?: boolean;
    readonly shell?: boolean;
    /** Passed to {@link sandboxShellRunner}. */
    readonly maxOutputBytes?: number;
  } = {},
): Tool[] {
  const tools = readOnlyTools(sandboxFileSystem(sandbox));
  if (options.readOnly) return tools;
  tools.push(sandboxApplyPatchTool(sandbox));
  if (options.shell !== false) {
    tools.push(
      execCommandTool(sandboxShellRunner(sandbox, {
        ...(options.maxOutputBytes === undefined
          ? {}
          : { maxOutputBytes: options.maxOutputBytes }),
      })),
    );
  }
  return tools;
}

// MARK: Blue Team

/**
 * The analyzers {@link disassemble} runs, with their default flags. The
 * file's path always follows `--`. GNU binutils and LLVM's tools take the
 * same flags; busybox has `strings` and `hexdump`.
 */
export const DISASSEMBLERS = {
  objdump: ["-d", "-C", "--no-show-raw-insn"],
  strings: ["-a", "-n", "6"],
  readelf: ["-a", "-W"],
  nm: ["-C"],
  hexdump: ["-C"],
} as const satisfies Record<string, readonly string[]>;

/** An analyzer {@link disassemble} knows. */
export type Disassembler = keyof typeof DISASSEMBLERS;

/** Options for {@link disassemble}. */
export interface DisassembleOptions {
  /** Default `objdump`. */
  readonly tool?: Disassembler;
  /** Replaces the tool's default flags from {@link DISASSEMBLERS}. */
  readonly args?: readonly string[];
  /** Default 60 s. */
  readonly timeoutMs?: number;
  /** Output kept; default 1 MiB, the sandbox's own default. */
  readonly maxOutputBytes?: number;
}

/** An analyzer's output. */
export interface Disassembly {
  readonly tool: Disassembler;
  readonly argv: readonly string[];
  /** Standard output. */
  readonly text: string;
  /** True when the output went over `maxOutputBytes` and was cut. */
  readonly truncated: boolean;
  readonly durationMs: number;
}

/**
 * Runs an analyzer on a workspace file with an argv list (no shell), a
 * deadline and an output cap.
 *
 * @throws {Error} when the path leaves the workspace, the tool is unknown,
 * or it times out or exits non-zero (with its stderr in the message).
 */
export async function disassemble(
  sandbox: Pick<SandboxApi, "exec">,
  path: string,
  options: DisassembleOptions = {},
): Promise<Disassembly> {
  const tool = options.tool ?? "objdump";
  if (!Object.hasOwn(DISASSEMBLERS, tool)) {
    throw new TypeError(`unknown analyzer: ${tool}`);
  }
  const target = requirePath(path);
  if (target === "") throw new TypeError("disassemble needs a file path");
  const argv = [tool, ...(options.args ?? DISASSEMBLERS[tool]), "--", target];
  const result: ExecResult = await sandbox.exec(argv, {
    timeoutMs: options.timeoutMs ?? 60_000,
    maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024,
  });
  if (result.timedOut) {
    throw new Error(`${tool} timed out after ${result.durationMs} ms`);
  }
  if (!result.success) {
    throw new Error(
      `${tool} failed with exit code ${result.exitCode}: ${
        result.stderr.trim().slice(-2000)
      }`,
    );
  }
  return {
    tool,
    argv,
    text: result.stdout,
    truncated: result.truncated,
    durationMs: result.durationMs,
  };
}

/**
 * {@link disassemble}, then `reverseEngineer` over the output (split at
 * function boundaries for objdump). `context` defaults to the file name
 * and tool, noting a truncated output.
 */
export async function reverseEngineerFile(
  client: GptClient,
  sandbox: Pick<SandboxApi, "exec">,
  path: string,
  options: DisassembleOptions & AnalysisOptions & {
    readonly context?: string;
  } = {},
): Promise<Analysis<ReNotes> & { readonly disassembly: Disassembly }> {
  const disassembly = await disassemble(sandbox, path, options);
  const context = options.context ??
    `${disassembly.tool} output for ${path}${
      disassembly.truncated ? " (cut short at the output limit)" : ""
    }`;
  const analysis = await reverseEngineer(client, {
    disassembly: disassembly.text,
    context,
  }, options);
  return { ...analysis, disassembly };
}

/** A read-only view of `dir` within `fs`, with paths relative to it. */
export function scopedFileSystem(fs: FileSystem, dir: string): FileSystem {
  const root = requirePath(dir);
  const inside = (path: string) => {
    const relative = requirePath(path);
    return root === ""
      ? relative
      : relative === ""
      ? root
      : `${root}/${relative}`;
  };
  const prefix = root === "" ? "" : `${root}/`;
  return readOnly({
    read: (path) => fs.read(inside(path)),
    kind: (path) => fs.kind(inside(path)),
    list: async (path) =>
      (await fs.list(inside(path))).map((file) => file.slice(prefix.length)),
    write: (path, content) => fs.write(inside(path), content),
    remove: (path) => fs.remove(inside(path)),
  });
}

/** Options for {@link reviewCheckout}. */
export interface ReviewCheckoutOptions extends AnalysisOptions {
  /** A branch or tag to clone. */
  readonly branch?: string;
  /** Shallow clone depth; default 1. */
  readonly depth?: number;
  /** Workspace-relative directory; default the repository's name. */
  readonly targetDir?: string;
  /** The clone's deadline; the sandbox's default otherwise. */
  readonly checkoutTimeoutMs?: number;
  /** Globs (`src/**`, `*.py`) a file must match one of; default all. */
  readonly include?: readonly string[];
  /** Globs to skip; `.git/` is always skipped. */
  readonly exclude?: readonly string[];
  /** Most files reviewed; default 200. */
  readonly maxFiles?: number;
  /** Files longer than this many characters are skipped; default 200,000. */
  readonly maxFileChars?: number;
  /** What the code is and what matters, for the prompt. */
  readonly context?: string;
}

/** What {@link reviewCheckout} found. */
export type CheckoutReview = Analysis<SecurityReview> & {
  readonly findings: Finding[];
  /** The workspace-relative checkout directory. */
  readonly directory: string;
  /** The files reviewed, relative to the checkout. */
  readonly files: readonly string[];
  /** Text files left out by `maxFiles` or `maxFileChars`. */
  readonly skipped: readonly string[];
  /**
   * The checkout, read-only, with paths relative to it: hand
   * `readOnlyTools(fs)` to an agent to follow up on the findings.
   */
  readonly fs: FileSystem;
};

/**
 * Clones `url` into the sandbox with `gitCheckout` and runs
 * `securityReview` over its text files, read through a read-only view of
 * the checkout (binary and non-UTF-8 files are skipped). Finding paths are
 * relative to the checkout.
 *
 * @throws {Error} when the clone fails or leaves nothing to review.
 */
export async function reviewCheckout(
  client: GptClient,
  sandbox: SandboxCheckout,
  url: string,
  options: ReviewCheckoutOptions = {},
): Promise<CheckoutReview> {
  const clone = await sandbox.gitCheckout(url, {
    ...(options.branch === undefined ? {} : { branch: options.branch }),
    ...(options.depth === undefined ? {} : { depth: options.depth }),
    ...(options.targetDir === undefined
      ? {}
      : { targetDir: options.targetDir }),
    ...(options.checkoutTimeoutMs === undefined
      ? {}
      : { timeoutMs: options.checkoutTimeoutMs }),
  });
  if (!clone.success) {
    throw new Error(
      `git clone of ${url} failed${
        clone.timedOut ? " (timed out)" : ` with exit code ${clone.exitCode}`
      }: ${clone.stderr.trim().slice(-2000)}`,
    );
  }
  const directory = requirePath(
    options.targetDir ??
      url.replace(/\/+$/, "").split("/").pop()!.replace(/\.git$/, ""),
  );
  const fs = scopedFileSystem(sandboxFileSystem(sandbox), directory);
  const include = (options.include ?? []).map(globPattern);
  const exclude = (options.exclude ?? []).map(globPattern);
  const maxFiles = options.maxFiles ?? 200;
  const maxFileChars = options.maxFileChars ?? 200_000;
  const files: Record<string, string> = {};
  const skipped: string[] = [];
  for (const path of await fs.list("")) {
    if (path === ".git" || path.startsWith(".git/")) continue;
    if (include.length > 0 && !include.some((glob) => glob.test(path))) {
      continue;
    }
    if (exclude.some((glob) => glob.test(path))) continue;
    const text = await fs.read(path);
    if (text === null) continue;
    if (text.length > maxFileChars || Object.keys(files).length >= maxFiles) {
      skipped.push(path);
      continue;
    }
    files[path] = text;
  }
  if (Object.keys(files).length === 0) {
    throw new Error(`nothing to review in ${directory || "the checkout"}`);
  }
  const review = await securityReview(client, {
    files,
    ...(options.context === undefined ? {} : { context: options.context }),
  }, options);
  return { ...review, directory, files: Object.keys(files), skipped, fs };
}
