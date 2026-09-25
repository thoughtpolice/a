// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/api/openai/sandbox`: a `@celld/box/sandbox` sandbox as the workspace of
 * the coding tools, and Blue Team helpers that run analyzers inside one.
 *
 * ```ts
 * import { getSandbox } from "@celld/box/sandbox";
 * import { sandboxCodingTools } from "@celld/api/openai/sandbox";
 *
 * // One sandbox per authenticated caller: name it from the principal (a
 * // keyed hash of `principal.key`, as the `sandbox` example does), never
 * // from anything the request says, or one caller opens another's.
 * const box = getSandbox(env.SANDBOX, sandboxIdFor(principal));
 * const tools = new ToolRegistry(sandboxCodingTools(box));
 * await runAgent({ client: gpt, conversation, tools });
 *
 * const { disassembly, result } = await reverseEngineerFile(gpt, box, "upload/a.out");
 * const review = await reviewCheckout(gpt, box, "https://github.com/acme/api");
 * ```
 *
 * - {@link sandboxFileSystem} and {@link sandboxShellRunner} adapt a
 *   sandbox (a `SandboxClient` or a `SandboxCore`) to the coding tools'
 *   {@link FileSystem} (for reading) and {@link ShellRunner};
 *   {@link sandboxDirectoryView} is a read-only view of one directory that
 *   never follows a symbolic link, and {@link sandboxWriteFile} writes one
 *   file under the workspace lease.
 * - {@link sandboxApplyPatch} applies a Codex patch by staging every new
 *   file next to its target and then renaming each into place, and
 *   {@link sandboxCodingTools} is `codingTools` with that `apply_patch`.
 * - {@link disassemble} runs objdump, strings, readelf, nm or hexdump on a
 *   workspace file; {@link reverseEngineerFile} feeds the output to
 *   `reverseEngineer`.
 * - {@link reviewCheckout} clones a repository into the sandbox and runs
 *   `securityReview` over its regular text files, and hands back the
 *   checkout as a {@link sandboxDirectoryView}.
 *
 * Analyzers parse hostile input. Run untrusted binaries in a sandbox on
 * the `hostile` tier (`settings = { tier: "hostile" }`), declared with the
 * container runtime gVisor (`"runtime": "runsc"`): the tier refuses every
 * call unless the container really runs on gVisor, and a parser bug in
 * binutils then lands in gVisor's user-space kernel rather than the
 * host's. The default `trusted` tier under runc shares the host kernel.
 * See `@celld/box/sandbox`'s README.
 *
 * Cancellation reaches the sandbox. A tool call's `context.signal` goes
 * to `exec`/`execShell` as their `signal`, and `reviewCheckout`'s
 * `call.signal` to `gitCheckout`, so a timed-out or cancelled command or
 * clone is killed (its whole process group) before the call settles, and
 * the staged `apply_patch` checks it before every file it changes, so it
 * stops between two files with a {@link PartialPatchError}. The registry
 * reports the timeout only after that.
 *
 * Every write this module makes holds the sandbox's lease `workspace` (see
 * `@celld/box/sandbox`'s `acquireLease` and {@link withWorkspaceLease}) for as
 * long as it runs, and passes the lease's token as `lease` to every
 * mutating sandbox call: the registry's lanes serialize calls within one
 * isolate, and the lease serializes them across every Worker using the
 * sandbox. The sandbox enforces it: while the lease is held, a mutation
 * without its token is refused (`lease_held`), one naming a lease no
 * longer held is refused (`lease_lost`), and granting the lease stops the
 * mutating commands and file helpers in flight and awaits cleanup, including
 * all default-mutating background processes. A mutation whose lease may be
 * lost is aborted here too. `mutates: false` remains a trusted assertion.
 * Guest commands can tamper with their supervision files: mutually hostile
 * principals require separate sandbox identities/containers, not this lease.
 *
 * This is a target of its own, so `@celld/api/openai` does not depend on
 * `@celld/box/sandbox`.
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
  globMatcher,
  PartialPatchError,
  readOnly,
  readOnlyTools,
  requirePath,
  type SearchRequest,
  type SearchResult,
  type ShellRunner,
} from "@celld/api/openai/coding";
import { MAX_TIMER_MS, safeInt } from "@celld/core/bounds";
import {
  type ExecResult,
  type FileStat,
  type SandboxApi,
  SandboxError,
  type WriteFileOptions,
} from "@celld/box/sandbox";

export { PartialPatchError };

/**
 * What {@link sandboxFileSystem} uses: a `SandboxClient` or `SandboxCore`.
 * With `searchFiles`, `stat` and `exec`, the file system also searches
 * (`grep_files` regexes run as `grep -E` in the container). `writeFile`
 * and `deleteFile` are for {@link sandboxApplyPatch}, which holds the
 * lease; the file system itself never writes.
 */
export type SandboxFiles =
  & Pick<
    SandboxApi,
    "readFile" | "writeFile" | "deleteFile" | "exists" | "listFiles"
  >
  & Partial<Pick<SandboxApi, "searchFiles" | "stat" | "exec">>;

/** The sandbox's leases, which mutations hold across isolates. */
export type SandboxLeases = Pick<
  SandboxApi,
  "acquireLease" | "renewLease" | "releaseLease"
>;

/** What {@link sandboxShellRunner} uses. */
export type SandboxShell =
  & Pick<SandboxApi, "exec" | "execShell">
  & SandboxLeases;

/**
 * What {@link sandboxApplyPatch} uses; `remove` takes away the empty
 * directories a patch that stopped had created.
 */
export type SandboxPatcher =
  & SandboxFiles
  & Pick<SandboxApi, "renameFile" | "exec" | "remove">
  & SandboxLeases;

/** What {@link sandboxCodingTools} uses. */
export type SandboxWorkspace = SandboxPatcher & SandboxShell;

/**
 * What {@link sandboxDirectoryView} uses: `stat` (with `noFollow`) answers
 * `kind` and checks a search's directory.
 */
export type SandboxView = SandboxFiles & Pick<SandboxApi, "stat">;

/** What {@link reviewCheckout} uses. */
export type SandboxCheckout =
  & SandboxView
  & Pick<SandboxApi, "gitCheckout">
  & SandboxLeases;

/** What {@link sandboxWriteFile} uses. */
export type SandboxWriter = Pick<SandboxApi, "writeFile"> & SandboxLeases;

function code(error: unknown): string | null {
  return SandboxError.from(error)?.code ?? null;
}

// MARK: Leases

import {
  DEFAULT_MAX_HOLD_MS,
  LEASE_KILL_GRACE_MS,
  LEASE_TTL_MS,
  LEASE_WAIT_MS,
  withWorkspaceLease,
  WORKSPACE_LEASE,
  WorkspaceLeaseError,
  type WorkspaceLeaseOptions,
} from "@celld/box/sandbox";
export {
  DEFAULT_MAX_HOLD_MS,
  LEASE_KILL_GRACE_MS,
  LEASE_TTL_MS,
  LEASE_WAIT_MS,
  withWorkspaceLease,
  WORKSPACE_LEASE,
  WorkspaceLeaseError,
  type WorkspaceLeaseOptions,
};

/**
 * Writes one file into the workspace holding the workspace lease (see
 * {@link withWorkspaceLease}), as every writer of the workspace must: a
 * Worker's upload route uses it rather than `writeFile`, so the upload
 * never lands in the middle of a patch.
 *
 * @throws {WorkspaceLeaseError} when the lease could not be had in time.
 */
export async function sandboxWriteFile(
  sandbox: SandboxWriter,
  path: string,
  content: string | Uint8Array,
  options: Omit<WriteFileOptions, "lease"> & {
    readonly signal?: AbortSignal;
  } = {},
): Promise<void> {
  const { signal, ...write } = options;
  signal?.throwIfAborted();
  await withWorkspaceLease(sandbox, signal, async (fence, lease) => {
    fence.throwIfAborted();
    await sandbox.writeFile(path, content, { ...write, lease });
  });
}

/** The default {@link SandboxFileSystemOptions.maxEntries}. */
export const DEFAULT_MAX_LIST_ENTRIES = 20_000;

/** The most the sandbox's `listFiles` returns in one call. */
export const MAX_LIST_ENTRIES = 100_000;

/** Options for {@link sandboxFileSystem}. */
export interface SandboxFileSystemOptions {
  /**
   * The most entries (files and directories) one `list` reads; default
   * {@link DEFAULT_MAX_LIST_ENTRIES}, at most {@link MAX_LIST_ENTRIES}. A
   * directory with more is an error, never a partial list.
   */
  readonly maxEntries?: number;
}

/**
 * A listing the sandbox cut short at `maxEntries`. `list` throws it rather
 * than hand back part of a directory, which a tool (or a patch planner)
 * would take for all of it.
 */
export class TruncatedListingError extends Error {
  /** The workspace-relative directory; `""` is the root. */
  readonly directory: string;
  readonly maxEntries: number;

  constructor(directory: string, maxEntries: number) {
    super(
      `listing ${
        directory === "" ? "the workspace root" : directory
      } stopped at ${maxEntries} entries (maxEntries); list a smaller directory or raise maxEntries`,
    );
    this.name = "TruncatedListingError";
    this.directory = directory;
    this.maxEntries = maxEntries;
  }
}

/**
 * A listing read in pages that changed between two pages: the sandbox
 * refused the next page (`listing_changed`, its cursor names the last
 * entry of the page before), or two pages repeat an entry. `list` throws
 * it rather than answer a list that may miss or repeat files.
 */
export class ListingChangedError extends Error {
  /** The workspace-relative directory; `""` is the root. */
  readonly directory: string;

  constructor(directory: string, options?: ErrorOptions) {
    super(
      `${
        directory === "" ? "the workspace root" : directory
      } changed while it was being listed; list it again`,
      options,
    );
    this.name = "ListingChangedError";
    this.directory = directory;
  }
}

const refuseWrite = (path: string) =>
  Promise.reject(
    new Error(
      `the sandbox file system does not write (${path}): changes go through sandboxApplyPatch, sandboxShellRunner or sandboxWriteFile, which hold the workspace lease`,
    ),
  );

/**
 * The sandbox's workspace as a coding-tools file system, for reading:
 * `write` and `remove` are refused, because every change to the workspace
 * holds the sandbox's workspace lease (see {@link withWorkspaceLease}),
 * and a patch planned from reads and then written file by file (the
 * generic `apply_patch` of `codingTools`) cannot. Use
 * {@link sandboxCodingTools}, whose `apply_patch` is
 * {@link sandboxApplyPatch}, and {@link sandboxWriteFile}.
 *
 * Its `workspace` key is `sandbox` (as the shell runner's and the staged
 * `apply_patch`'s are). Paths are workspace-relative on both sides. `read`
 * answers null for missing, directory and non-UTF-8 paths (the tools work
 * on text); `list` is recursive and includes dotfiles, which agents need
 * (`.gitignore`), pages through the sandbox's listing cursor (checking its
 * signal between pages), and throws a {@link TruncatedListingError} for a
 * directory with more than `maxEntries` entries and a
 * {@link ListingChangedError} when the directory changed between pages.
 * With the sandbox's `searchFiles`, `stat` and `exec`, `search` runs a
 * `grep_files` regular expression as `grep -E` in the container, under
 * the call's signal and a deadline, over regular files only: it refuses a
 * directory reached through a symbolic link and never reads a link. Paths
 * outside the workspace still throw.
 *
 * @throws {RangeError} `maxEntries` is not an integer from 1 to
 * {@link MAX_LIST_ENTRIES}.
 */
export function sandboxFileSystem(
  sandbox: SandboxFiles,
  options: SandboxFileSystemOptions = {},
): FileSystem {
  const maxEntries = safeInt(options.maxEntries ?? DEFAULT_MAX_LIST_ENTRIES, {
    name: "maxEntries",
    min: 1,
    max: MAX_LIST_ENTRIES,
  });
  return {
    workspace: sandbox,
    read: (path, options) => readText(sandbox, path, options?.signal, false),
    write: (path) => refuseWrite(path),
    remove: (path) => refuseWrite(path),
    async kind(path) {
      const found = await sandbox.exists(path);
      if (!found.exists) return null;
      return found.kind === "dir" ? "dir" : "file";
    },
    list: (dir, options) =>
      listRegular(sandbox, dir, maxEntries, options?.signal, false),
    ...(sandbox.searchFiles === undefined || sandbox.stat === undefined ||
        sandbox.exec === undefined
      ? {}
      : {
        search: (request) =>
          searchSandbox(sandbox as SearchingSandbox, request),
      }),
  };
}

type SearchingSandbox = Pick<SandboxApi, "searchFiles" | "stat" | "exec">;

// A file's text, or null for what is not UTF-8 text in a regular file.
// With `noFollow`, a link at the path or on its way throws.
async function readText(
  sandbox: Pick<SandboxApi, "readFile">,
  path: string,
  signal: AbortSignal | undefined,
  noFollow: boolean,
): Promise<string | null> {
  signal?.throwIfAborted();
  try {
    const file = await sandbox.readFile(path, noFollow ? { noFollow } : {});
    return file.encoding === "utf-8" ? file.content : null;
  } catch (error) {
    const found = code(error);
    if (
      found === "not_found" || found === "is_directory" ||
      found === "not_text" || found === "not_regular"
    ) {
      return null;
    }
    if (found === "is_symlink") throw throughLink(requirePath(path), error);
    throw SandboxError.wrap(error);
  }
}

function throughLink(path: string, cause: unknown): Error {
  return new Error(
    `${
      path === "" ? "this directory" : path
    } is reached through a symbolic link, which is not followed`,
    { cause },
  );
}

// The regular files under `dir`, paged through the sandbox's anchored
// cursor: more than `maxEntries` entries (or a cut page without a cursor
// to go on from) is refused, never answered in part, and a directory that
// changed between pages (the sandbox's `listing_changed`, or a repeated
// entry) is a ListingChangedError. A link is an entry of its own kind, so
// it is neither listed nor descended through. With `noFollow`, `dir`
// itself must be reached without a link.
async function listRegular(
  sandbox: Pick<SandboxApi, "listFiles">,
  dir: string,
  maxEntries: number,
  signal: AbortSignal | undefined,
  noFollow: boolean,
): Promise<string[]> {
  try {
    const files: string[] = [];
    const seenPaths = new Set<string>();
    let seen = 0;
    let cursor: string | undefined;
    for (;;) {
      signal?.throwIfAborted();
      const listing = await sandbox.listFiles(dir, {
        recursive: true,
        includeHidden: true,
        limit: maxEntries - seen,
        sort: false,
        ...(noFollow ? { noFollow } : {}),
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen += listing.entries.length;
      for (const entry of listing.entries) {
        if (seenPaths.has(entry.path)) {
          throw new ListingChangedError(requirePath(dir));
        }
        seenPaths.add(entry.path);
        if (entry.kind === "file") files.push(entry.path);
      }
      if (!listing.truncated) return files.sort();
      // More are left: past the limit, or no way to reach them.
      if (
        seen >= maxEntries || listing.cursor === undefined ||
        listing.entries.length === 0
      ) {
        break;
      }
      cursor = listing.cursor;
    }
    throw new TruncatedListingError(requirePath(dir), maxEntries);
  } catch (error) {
    if (
      error instanceof TruncatedListingError ||
      error instanceof ListingChangedError ||
      (signal?.aborted && error === signal.reason)
    ) {
      throw error;
    }
    const found = code(error);
    if (found === "not_found") return [];
    if (found === "listing_changed") {
      throw new ListingChangedError(requirePath(dir), { cause: error });
    }
    if (found === "is_symlink") throw throughLink(requirePath(dir), error);
    throw SandboxError.wrap(error);
  }
}

/** The longest a `grep_files` search runs in the sandbox. */
export const SEARCH_TIMEOUT_MS = 30_000;
const SEARCH_OUTPUT_BYTES = 1024 * 1024;
/** The most matches the sandbox's `searchFiles` answers. */
const MAX_SEARCH_MATCHES = 100_000;

// Exits 0 when grep compiles the pattern. It is matched against one empty
// line: busybox's grep compiles a pattern only once it has a line to match,
// so a check over an empty file (as `searchFiles` makes) passes any
// pattern there, and the search then fails per file, silently.
const PATTERN_CHECK =
  'echo | grep -E -e "$1" > /dev/null 2>&1; [ $? -le 1 ] || exit 89';

// A `grep_files` regular expression through the sandbox's `searchFiles`,
// which enters the directory and walks it with `find -type f`, so grep
// reads regular files only and never a link. `searchFiles` follows links
// on the way to the directory (inside the workspace only), so the
// directory is first checked with `stat` and `noFollow`: a link on its
// way is refused. `searchFiles` takes no `noFollow`, so the check and the
// search are two sandbox calls. A directory that is not there has no
// matches. The pattern is checked first (PATTERN_CHECK), read-only and
// under the same deadline and signal.
async function searchSandbox(
  sandbox: SearchingSandbox,
  request: SearchRequest,
): Promise<SearchResult> {
  const dir = requirePath(request.dir);
  request.signal?.throwIfAborted();
  const checked = await sandbox.exec(
    ["sh", "-c", PATTERN_CHECK, "sh", request.pattern],
    {
      mutates: false,
      timeoutMs: SEARCH_TIMEOUT_MS,
      maxOutputBytes: 4096,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    },
  );
  if (checked.timedOut) {
    throw new Error(`the search ran out of time after ${SEARCH_TIMEOUT_MS} ms`);
  }
  if (checked.exitCode === 89) {
    throw new Error(
      "bad pattern: not a valid POSIX extended regular expression",
    );
  }
  if (!checked.success) {
    throw new Error(
      `the search failed: ${checked.stderr.trim().slice(-500)}`,
    );
  }
  if (dir !== "") {
    let kind;
    try {
      kind = (await sandbox.stat(dir, { noFollow: true })).kind;
    } catch (error) {
      const found = code(error);
      if (found === "not_found") return { matches: [], truncated: false };
      if (found === "is_symlink") throw throughLink(dir, error);
      throw SandboxError.wrap(error);
    }
    if (kind !== "dir") throw new Error(`${dir} is not a directory`);
  }
  try {
    return await sandbox.searchFiles(request.pattern, {
      path: dir,
      regex: true,
      maxMatches: Math.min(Math.max(1, request.limit), MAX_SEARCH_MATCHES),
      maxOutputBytes: SEARCH_OUTPUT_BYTES,
      timeoutMs: SEARCH_TIMEOUT_MS,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  } catch (error) {
    const refused = SandboxError.from(error);
    switch (refused?.code) {
      case "invalid":
        throw new Error(`bad pattern: ${refused.detail}`, { cause: error });
      case "not_found":
        return { matches: [], truncated: false };
      case "not_directory":
        throw new Error(`${dir} is not a directory`, { cause: error });
      case "is_symlink":
        throw throughLink(dir, error);
      case "timeout":
        throw new Error(
          `the search ran out of time after ${SEARCH_TIMEOUT_MS} ms`,
          { cause: error },
        );
    }
    throw SandboxError.wrap(error);
  }
}

/**
 * The sandbox as a coding-tools shell: a string runs with the sandbox's
 * shell, an argv list directly. Stdout and stderr come back interleaved,
 * and the command's `timeoutMs` is the sandbox's deadline. The command's
 * `signal` is the exec's: aborting it kills the command's process group,
 * and `run` rejects with the signal's reason only once the sandbox has.
 * The command holds the workspace lease for at most its `timeoutMs` plus
 * {@link LEASE_KILL_GRACE_MS}, by when the sandbox has stopped it.
 */
export function sandboxShellRunner(
  sandbox: SandboxShell,
  options: { readonly maxOutputBytes?: number } = {},
): ShellRunner {
  return {
    workspace: sandbox,
    async run(command) {
      if (command.signal.aborted) {
        throw command.signal.reason ?? new Error("the command was cancelled");
      }
      // A command may change the workspace: it runs holding the lease, and
      // a lost lease kills it like a cancellation.
      const timeoutMs = Math.max(1, Math.round(command.timeoutMs));
      const result = await withWorkspaceLease(
        sandbox,
        command.signal,
        async (signal, lease) => {
          const execOptions = {
            ...(command.workdir === null ? {} : { cwd: command.workdir }),
            timeoutMs,
            combineOutput: true,
            ...(options.maxOutputBytes === undefined
              ? {}
              : { maxOutputBytes: options.maxOutputBytes }),
            signal,
            lease,
          };
          try {
            return typeof command.command === "string"
              ? await sandbox.execShell(command.command, execOptions)
              : await sandbox.exec([...command.command], execOptions);
          } catch (error) {
            // `SandboxCore` rejects with `cancelled`, the client with the
            // reason; either way the command is dead by now.
            if (signal.aborted) throw signal.reason;
            throw error;
          }
        },
        {
          maxHoldMs: Math.min(timeoutMs + LEASE_KILL_GRACE_MS, MAX_TIMER_MS),
        },
      );
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
  signal: AbortSignal | undefined,
  lease?: string,
): Promise<(string | null)[]> {
  if (paths.length === 0) return [];
  const result = await sandbox.exec(["sh", "-c", MODES, "sh", ...paths], {
    timeoutMs: 30_000,
    ...(signal === undefined ? {} : { signal }),
    ...(lease === undefined ? {} : { lease }),
  });
  const lines = result.stdout.split("\n").slice(0, paths.length);
  if (!result.success || lines.length !== paths.length) {
    throw new Error(`could not read file modes: ${result.stderr.trim()}`);
  }
  return lines.map((line) => /^[0-7]{3,4}$/.test(line) ? line : null);
}

/**
 * Applies a Codex patch to the sandbox's workspace, holding the sandbox's
 * workspace lease throughout (see {@link withWorkspaceLease}), with a
 * narrow window for partial results:
 *
 * 1. the patch is parsed and planned against the workspace (as
 *    `applyPatch` does); a bad patch changes nothing;
 * 2. every new file is written to a temporary name beside its target
 *    (`dir/.name.patch-<hex>`), keeping the target's permissions; a
 *    failure here removes the temporary files and the directories staging
 *    created for them, and changes nothing;
 * 3. each temporary file is renamed over its target, then deleted files
 *    are removed.
 *
 * Each rename is atomic, but the patch as a whole is not: a failure (or
 * another writer) during step 3 leaves some files changed, reported as a
 * {@link PartialPatchError} naming which (directories created for files
 * that were not committed are removed again). A target that was a
 * symbolic link becomes a regular file.
 *
 * `signal` fences the patch: it is checked before every write, rename and
 * removal, and once it has aborted nothing in the workspace changes except
 * that the patch's own temporary files are deleted. An abort during steps
 * 1 and 2 rejects with the signal's reason and changes nothing; during
 * step 3 it is a {@link PartialPatchError} whose `cause` is the reason.
 *
 * @throws {ApplyPatchError} for a patch that does not parse or fit.
 */
export async function sandboxApplyPatch(
  sandbox: SandboxPatcher,
  patch: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<AppliedPatch> {
  options.signal?.throwIfAborted();
  // Planned from reads, then written: the whole of it holds the lease, so
  // no other writer's change lands between the reads and the writes.
  return await withWorkspaceLease(
    sandbox,
    options.signal,
    (signal, lease) => applyStaged(sandbox, patch, signal, lease),
  );
}

async function applyStaged(
  sandbox: SandboxPatcher,
  patch: string,
  signal: AbortSignal,
  lease: string,
): Promise<AppliedPatch> {
  const live = sandboxFileSystem(sandbox);
  // `applyPatch` plans everything before its first write, so recording the
  // writes and removals here yields the whole change or nothing.
  const planned = new Map<string, string | null>();
  const staging: FileSystem = {
    read: (path) => live.read(path, { signal }),
    kind: (path) => live.kind(path),
    list: (dir) => live.list(dir, { signal }),
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
  signal?.throwIfAborted();
  const modes = await modesOf(
    sandbox,
    writes.map(([path]) => path),
    signal,
    lease,
  );
  const created = await missingDirectories(
    sandbox,
    writes.map(([path]) => path),
    signal,
  );
  const staged: { path: string; temp: string }[] = [];
  // Temporary files, then the directories staging created that are empty
  // again, deepest first (`remove` refuses a directory that is not).
  const discard = async (temps: readonly string[]) => {
    for (const temp of temps) {
      await sandbox.deleteFile(temp, { lease }).catch(() => {});
    }
    for (const dir of created) {
      await sandbox.remove(dir, { lease }).catch(() => {});
    }
  };
  try {
    for (const [index, [path, content]] of writes.entries()) {
      signal?.throwIfAborted();
      const temp = tempName(path);
      staged.push({ path, temp });
      const mode = modes[index];
      await sandbox.writeFile(
        temp,
        content,
        mode === null ? { lease } : { mode, lease },
      );
    }
  } catch (error) {
    await discard(staged.map((entry) => entry.temp));
    throw error;
  }
  const committed: string[] = [];
  for (const [index, { path, temp }] of staged.entries()) {
    if (signal?.aborted) {
      await discard(staged.slice(index).map((entry) => entry.temp));
      throw new PartialPatchError(committed, [
        ...staged.slice(index).map((entry) => entry.path),
        ...removals,
      ], signal.reason);
    }
    try {
      await sandbox.renameFile(temp, path, { lease });
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
    if (signal?.aborted) {
      throw new PartialPatchError(
        committed,
        removals.slice(index),
        signal.reason,
      );
    }
    try {
      await sandbox.deleteFile(path, { lease });
    } catch (error) {
      if (code(error) === "not_found") continue;
      throw new PartialPatchError(committed, removals.slice(index), error);
    }
    committed.push(path);
  }
  return applied;
}

// The directories above `paths` that do not exist yet, deepest first:
// writing a staged file creates them.
async function missingDirectories(
  sandbox: Pick<SandboxApi, "exists">,
  paths: readonly string[],
  signal: AbortSignal,
): Promise<string[]> {
  const known = new Map<string, boolean>();
  for (const path of paths) {
    const parts = path.split("/").slice(0, -1);
    for (let end = 1; end <= parts.length; end++) {
      const dir = parts.slice(0, end).join("/");
      if (known.has(dir)) continue;
      if (known.get(parts.slice(0, end - 1).join("/")) === false) {
        known.set(dir, false);
        continue;
      }
      signal.throwIfAborted();
      known.set(dir, (await sandbox.exists(dir)).exists);
    }
  }
  return [...known].filter(([, exists]) => !exists).map(([dir]) => dir)
    .sort((a, b) => b.split("/").length - a.split("/").length);
}

/** `apply_patch` over the sandbox, applied with {@link sandboxApplyPatch}. */
export function sandboxApplyPatchTool(sandbox: SandboxPatcher): CustomTool {
  return customTool({
    mutates: true,
    workspace: sandbox,
    name: "apply_patch",
    description: APPLY_PATCH_DESCRIPTION,
    format: {
      type: "grammar",
      syntax: "lark",
      definition: APPLY_PATCH_GRAMMAR,
    },
    risk: "write",
    run: async (input, context) =>
      (await sandboxApplyPatch(sandbox, input, { signal: context.signal }))
        .summary,
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
    /** Passed to {@link sandboxFileSystem}. */
    readonly maxEntries?: number;
  } = {},
): Tool[] {
  const tools = readOnlyTools(sandboxFileSystem(
    sandbox,
    options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries },
  ));
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
  /** Aborting it kills the analyzer; the call rejects with its reason. */
  readonly signal?: AbortSignal;
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
  // It reads the file and writes nothing: declared read-only, it runs
  // while another caller holds the workspace lease.
  const result: ExecResult = await sandbox.exec(argv, {
    mutates: false,
    timeoutMs: options.timeoutMs ?? 60_000,
    maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
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
  const signal = options.signal ?? options.call?.signal;
  const disassembly = await disassemble(sandbox, path, {
    ...options,
    ...(signal === undefined ? {} : { signal }),
  });
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

/**
 * A read-only view of the workspace directory `dir`, with paths relative
 * to it, that never follows a symbolic link: a path any component of which
 * (from the workspace root down, `dir`'s own included) is a link is
 * refused (`read`, `list` and `search` throw, `kind` answers null), and
 * `list` and `search` show regular files only. A directory the view shows
 * is therefore the directory itself, not somewhere a link inside it points
 * (the sandbox confines links to the workspace, not to `dir`).
 *
 * `read`, `kind` and `list` are one sandbox call each, with `noFollow`:
 * the sandbox checks each step of the path where it landed and the file
 * it opened, so a link swapped in by a writer is refused by the read
 * itself. A regular-expression `search` checks its directory with `stat`
 * (`noFollow`) and then runs the sandbox's `searchFiles`, which reads
 * regular files only but follows links (inside the workspace) on the way
 * to the directory: a directory swapped for a link between the two calls
 * is searched, though never a file outside the workspace.
 */
export function sandboxDirectoryView(
  sandbox: SandboxView,
  dir: string,
  options: SandboxFileSystemOptions = {},
): FileSystem {
  const root = requirePath(dir);
  const maxEntries = safeInt(options.maxEntries ?? DEFAULT_MAX_LIST_ENTRIES, {
    name: "maxEntries",
    min: 1,
    max: MAX_LIST_ENTRIES,
  });
  const inside = (path: string) => {
    const relative = requirePath(path);
    return root === ""
      ? relative
      : relative === ""
      ? root
      : `${root}/${relative}`;
  };
  const outside = (path: string) =>
    root === "" ? path : path.slice(root.length + 1);
  // The view's own name for a path in an error.
  const shown = (error: unknown, path: string) =>
    error instanceof Error && code(error.cause) === "is_symlink"
      ? throughLink(requirePath(path), error.cause)
      : error;
  return readOnly({
    workspace: sandbox,
    async read(path, options) {
      try {
        return await readText(sandbox, inside(path), options?.signal, true);
      } catch (error) {
        throw shown(error, path);
      }
    },
    async kind(path) {
      let found: FileStat;
      try {
        found = await sandbox.stat(inside(path), { noFollow: true });
      } catch (error) {
        const refused = code(error);
        if (
          refused === "not_found" || refused === "is_symlink" ||
          refused === "not_directory" || refused === "invalid_path"
        ) {
          return null;
        }
        throw SandboxError.wrap(error);
      }
      return found.kind === "dir" ? "dir" : "file";
    },
    async list(path, options) {
      try {
        return (await listRegular(
          sandbox,
          inside(path),
          maxEntries,
          options?.signal,
          true,
        )).map(outside);
      } catch (error) {
        throw shown(error, path);
      }
    },
    write: (path) => refuseWrite(path),
    remove: (path) => refuseWrite(path),
    ...(sandbox.searchFiles === undefined || sandbox.exec === undefined ? {} : {
      search: async (request) => {
        let found;
        try {
          found = await searchSandbox(sandbox as SearchingSandbox, {
            ...request,
            dir: inside(request.dir),
          });
        } catch (error) {
          throw shown(error, request.dir);
        }
        return {
          ...found,
          matches: found.matches.map((match) => ({
            ...match,
            path: outside(match.path),
          })),
        };
      },
    }),
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
  /** Most files reviewed; default 200, from 1 to {@link MAX_REVIEW_FILES}. */
  readonly maxFiles?: number;
  /**
   * Files longer than this many characters are skipped; default 200,000,
   * from 1 to {@link MAX_REVIEW_FILE_CHARS}.
   */
  readonly maxFileChars?: number;
  /** Passed to {@link sandboxFileSystem}: a bigger checkout is refused. */
  readonly maxEntries?: number;
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
   * The checkout as a {@link sandboxDirectoryView}: read-only, paths
   * relative to it, symbolic links never followed. Hand
   * `readOnlyTools(fs)` to an agent to follow up on the findings.
   */
  readonly fs: FileSystem;
};

/** The largest {@link ReviewCheckoutOptions.maxFiles}. */
export const MAX_REVIEW_FILES = 10_000;
/** The largest {@link ReviewCheckoutOptions.maxFileChars}. */
export const MAX_REVIEW_FILE_CHARS = 10_000_000;

/**
 * Clones `url` into the sandbox with `gitCheckout` and runs
 * `securityReview` over its text files (binary and non-UTF-8 files are
 * skipped). Finding paths are relative to the checkout.
 *
 * The clone and the reading of the checkout hold the workspace lease (see
 * {@link withWorkspaceLease}); the model's review runs after it is given
 * back. Only regular files are reviewed: the repository's symbolic links
 * (which the sandbox confines to the workspace, not to the checkout) are
 * neither read nor followed, here or through the returned `fs`.
 *
 * @throws {Error} when the clone fails or leaves nothing to review.
 * @throws {RangeError} for a `maxFiles` or `maxFileChars` out of range.
 */
export async function reviewCheckout(
  client: GptClient,
  sandbox: SandboxCheckout,
  url: string,
  options: ReviewCheckoutOptions = {},
): Promise<CheckoutReview> {
  const maxFiles = safeInt(options.maxFiles ?? 200, {
    name: "maxFiles",
    min: 1,
    max: MAX_REVIEW_FILES,
  });
  const maxFileChars = safeInt(options.maxFileChars ?? 200_000, {
    name: "maxFileChars",
    min: 1,
    max: MAX_REVIEW_FILE_CHARS,
  });
  const include = (options.include ?? []).map(globMatcher);
  const exclude = (options.exclude ?? []).map(globMatcher);
  const directory = requirePath(
    options.targetDir ??
      url.replace(/\/+$/, "").split("/").pop()!.replace(/\.git$/, ""),
  );
  const listing = options.maxEntries === undefined
    ? {}
    : { maxEntries: options.maxEntries };
  const fs = sandboxDirectoryView(sandbox, directory, listing);
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_LIST_ENTRIES;
  const prefix = directory === "" ? "" : `${directory}/`;
  // File names come from the repository under review: no prototype, so a
  // file named `__proto__` is reviewed like any other.
  const files: Record<string, string> = Object.create(null);
  const skipped: string[] = [];
  let count = 0;
  await withWorkspaceLease(
    sandbox,
    options.call?.signal,
    async (signal, lease) => {
      // The sandbox's default checks the repository's links out as plain
      // files; `unsafeSymlinks` is never passed.
      const clone = await sandbox.gitCheckout(url, {
        signal,
        lease,
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
            clone.timedOut
              ? " (timed out)"
              : ` with exit code ${clone.exitCode}`
          }: ${clone.stderr.trim().slice(-2000)}`,
        );
      }
      // The checkout itself must not be a link; below it, the listing holds
      // regular files only and never descends through a link, and each read
      // refuses a link on its path (`noFollow`), so a link that appeared
      // after the listing is not read either.
      if (await fs.kind("") !== "dir") {
        throw new Error(`nothing to review in ${directory || "the checkout"}`);
      }
      const listed = await listRegular(
        sandbox,
        directory,
        maxEntries,
        signal,
        true,
      );
      for (const full of listed) {
        signal.throwIfAborted();
        const path = full.slice(prefix.length);
        if (path === ".git" || path.startsWith(".git/")) continue;
        if (include.length > 0 && !include.some((glob) => glob.test(path))) {
          continue;
        }
        if (exclude.some((glob) => glob.test(path))) continue;
        const text = await readText(sandbox, full, signal, true);
        if (text === null) continue;
        if (text.length > maxFileChars || count >= maxFiles) {
          skipped.push(path);
          continue;
        }
        files[path] = text;
        count++;
      }
    },
    {
      maxHoldMs: Math.min(
        (options.checkoutTimeoutMs ?? 0) + DEFAULT_MAX_HOLD_MS,
        MAX_TIMER_MS,
      ),
    },
  );
  if (count === 0) {
    throw new Error(`nothing to review in ${directory || "the checkout"}`);
  }
  const review = await securityReview(client, {
    files,
    ...(options.context === undefined ? {} : { context: options.context }),
  }, options);
  return { ...review, directory, files: Object.keys(files), skipped, fs };
}
