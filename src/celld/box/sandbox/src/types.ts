// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The sandbox API's data shapes. Everything here is structured-clone data,
 * so it crosses Durable Object RPC unchanged.
 *
 * @module
 */

import type { ContainerState } from "@celld/box/container";

/**
 * The workspace lease a mutating call holds: the `token` of the lease
 * `acquireLease("workspace")` answered. While that lease is held, a
 * mutating call without its token fails with `lease_held`; a call that
 * names a lease no longer held fails with `lease_lost`. Without the lease
 * held, a call without `lease` goes ahead.
 */
export interface LeaseOption {
  readonly lease?: string;
}

/** Options of `mkdir` and `remove`. */
export interface RecursiveOptions extends LeaseOption {
  readonly recursive?: boolean;
}

/** Options every command takes. */
export interface CommandOptions {
  /** Working directory, relative to the workspace (default its root). */
  readonly cwd?: string;
  /** Extra environment for this command; names must be identifiers. */
  readonly env?: Readonly<Record<string, string>>;
  /** Use the defaults of this session (see `createSession`). */
  readonly sessionId?: string;
}

/** Options for `exec`, `execShell` and `execStream`. */
export interface ExecOptions extends CommandOptions, LeaseOption {
  /** Kill the command after this long; default 30 s, capped by the class. */
  readonly timeoutMs?: number;
  /** Keep at most this many bytes of each output stream; default 1 MiB. */
  readonly maxOutputBytes?: number;
  /** Bytes or text for the command's stdin; default none (closed). */
  readonly stdin?: string | Uint8Array;
  /** Send stderr into stdout, interleaved as written (stderr is then ""). */
  readonly combineOutput?: boolean;
  /**
   * Whether the command may change the workspace; default true, so it is
   * held to the workspace lease (see {@link LeaseOption}) and stopped when
   * another caller takes that lease. `false` declares a command that only
   * reads: it runs whoever holds the lease. The sandbox cannot check the
   * declaration; a command declared `false` that writes defeats the lease.
   */
  readonly mutates?: boolean;
  /**
   * Aborting it kills the command (its whole process group) and the call
   * fails with `cancelled`. Over RPC the client turns it into a
   * `cancel(token)` call, since a signal cannot cross RPC.
   */
  readonly signal?: AbortSignal;
  /**
   * Names the command for `cancel(token)`; the client sets it for a
   * `signal`. 16-64 of `A-Z a-z 0-9 _ -`, and unguessable.
   */
  readonly cancelToken?: string;
}

/** Options of a streamed command: the plain-data part of {@link ExecOptions}. */
export type StreamExecOptions = Omit<ExecOptions, "signal" | "cancelToken">;

/** What a finished command did. */
export interface ExecResult {
  /** True when it exited with status 0. */
  readonly success: boolean;
  /** Its exit status; null when it was killed for running too long. */
  readonly exitCode: number | null;
  /** Standard output as UTF-8 (invalid bytes become U+FFFD). */
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** True when either stream went over `maxOutputBytes` and was cut. */
  readonly truncated: boolean;
  readonly durationMs: number;
}

/** A streamed command's events, in order: `start`, output, then `complete` or `error`. */
export type ExecEvent =
  | { readonly type: "start"; readonly pid: number }
  | { readonly type: "stdout"; readonly data: string }
  | { readonly type: "stderr"; readonly data: string }
  | {
    readonly type: "complete";
    readonly success: boolean;
    readonly exitCode: number | null;
    readonly timedOut: boolean;
    readonly truncated: boolean;
    readonly durationMs: number;
  }
  | { readonly type: "error"; readonly code: string; readonly message: string };

/** A background process's state. */
export type ProcessStatus =
  /** Still running. */
  | "running"
  /** Exited on its own; `exitCode` is its status. */
  | "exited"
  /** Ended by `killProcess`. */
  | "killed"
  /** Killed after its `timeoutMs`. */
  | "timed_out"
  /** The container stopped or restarted underneath it. */
  | "lost";

/**
 * Options for `startProcess`. The workspace lease (`lease`) is checked
 * when the process starts; default-mutating processes are killed and awaited
 * before another caller acquires the workspace lease.
 */
export interface ProcessOptions extends CommandOptions, LeaseOption {
  /** Defaults true: workspace handoff kills and awaits this process. False is a trusted assertion. */
  readonly mutates?: boolean;
  /** A label for listings. */
  readonly name?: string;
  /** Kill it after this long; default never. Rounded up to whole seconds. */
  readonly timeoutMs?: number;
}

/** A background process. */
export interface ProcessInfo {
  /** A ULID, so ids sort by start time. */
  readonly id: string;
  readonly name: string | null;
  /** The process id inside the container. */
  readonly pid: number;
  readonly command: readonly string[];
  /** Workspace-relative working directory. */
  readonly cwd: string;
  readonly status: ProcessStatus;
  readonly exitCode: number | null;
  /** RFC 3339 times. */
  readonly startedAt: string;
  readonly endedAt: string | null;
}

/** Options for `waitForLog`. */
export interface WaitForLogOptions {
  /** Give up after this long; default 30 s, capped by the class. */
  readonly timeoutMs?: number;
  /** Which output to search; default both. */
  readonly stream?: "stdout" | "stderr" | "both";
  /**
   * Treat the pattern as a POSIX extended regular expression (at most 256
   * bytes), matched by `grep -E` inside the container under the deadline.
   * Default false: the pattern is a literal string (at most 4 KiB).
   */
  readonly regex?: boolean;
}

/** Options for `listProcesses`. */
export interface ListProcessesOptions {
  /** The `cursor` of the previous page; default the first page. */
  readonly cursor?: string;
  /** At most this many processes; default 100, at most 1,000. */
  readonly limit?: number;
}

/** One page of processes, oldest first. */
export interface ProcessList {
  readonly processes: readonly ProcessInfo[];
  /** Pass it to get the next page; null after the last. */
  readonly cursor: string | null;
}

/** A process's output so far. */
export interface ProcessLogs {
  readonly stdout: string;
  readonly stderr: string;
  /** True when some output is missing: past the cap, or only a tail survived. */
  readonly truncated: boolean;
  readonly process: ProcessInfo;
}

/** A process log stream's events: output, then one `exit` when it has ended. */
export type ProcessEvent =
  | { readonly type: "stdout"; readonly data: string }
  | { readonly type: "stderr"; readonly data: string }
  | {
    readonly type: "exit";
    readonly status: ProcessStatus;
    readonly exitCode: number | null;
  }
  | { readonly type: "error"; readonly code: string; readonly message: string };

/** Every event a sandbox stream can carry. */
export type SandboxEvent = ExecEvent | ProcessEvent;

/**
 * Follow no symbolic link: a link at the path, or on the way to it from
 * the workspace, fails with `is_symlink` (checked where each step landed,
 * so a link swapped in meanwhile is caught). For a view of part of the
 * workspace scoped by path, which a link could otherwise lead out of.
 */
export interface NoFollowOptions {
  readonly noFollow?: boolean;
}

/** Options for `readFile`. */
export interface ReadFileOptions extends NoFollowOptions {
  /** `utf-8` (default; refuses invalid UTF-8) or `bytes`. */
  readonly encoding?: "utf-8" | "bytes";
  /** Refuse files bigger than this; default and cap from the class. */
  readonly maxBytes?: number;
}

/**
 * A file's contents, as text or bytes by the requested encoding. `size` is
 * the bytes returned. `truncated` is true when the file grew past the
 * limit while it was being read: `content` is then its first `maxBytes`
 * (for text, without a last character the cut split).
 */
export type ReadFileResult =
  | {
    readonly path: string;
    readonly size: number;
    readonly encoding: "utf-8";
    readonly content: string;
    readonly truncated: boolean;
  }
  | {
    readonly path: string;
    readonly size: number;
    readonly encoding: "bytes";
    readonly content: Uint8Array;
    readonly truncated: boolean;
  };

/** Options for `writeFile`. */
export interface WriteFileOptions extends LeaseOption {
  /** How to read string content: `utf-8` (default) or `base64`. */
  readonly encoding?: "utf-8" | "base64";
  /** Create missing parent directories; default true. */
  readonly createParents?: boolean;
  /** Octal permissions such as `"644"` or `"0755"`. */
  readonly mode?: string;
}

/** What is at a path. */
export type EntryKind = "file" | "dir" | "symlink" | "other";

/** One entry of a directory listing. */
export interface FileEntry {
  /** Workspace-relative path. */
  readonly path: string;
  /** Its last component. */
  readonly name: string;
  /** `symlink` for a link, whatever it points at. */
  readonly kind: EntryKind;
}

/** Options for `listFiles`; `noFollow` is about the directory's own path. */
export interface ListFilesOptions extends NoFollowOptions {
  /** Descend into subdirectories; default false. */
  readonly recursive?: boolean;
  /** Include dotfiles and descend into dot-directories; default false. */
  readonly includeHidden?: boolean;
  /** At most this many entries; default 10,000, at most 100,000. */
  readonly limit?: number;
  /** The `cursor` of the previous page (same path and options). */
  readonly cursor?: string;
  /** Sort each page by path; default true. */
  readonly sort?: boolean;
}

/**
 * One page of a directory listing: sorted by path unless `sort: false`,
 * in the walk's order across pages.
 */
export interface ListFilesResult {
  readonly entries: readonly FileEntry[];
  /** True when there are more entries than this page holds. */
  readonly truncated: boolean;
  /**
   * Set when `truncated`: pass it as `cursor` (with the same path and
   * options) for the next page. Opaque. It names the page's last entry:
   * when the directory changed so that the next page would skip or repeat
   * entries, that page fails with `listing_changed`.
   */
  readonly cursor?: string;
}

/** What `stat` reports; links are followed (inside the workspace only). */
export interface FileStat {
  readonly path: string;
  readonly kind: "file" | "dir" | "other";
  readonly symlink: boolean;
  readonly size: number;
  /** RFC 3339 modification time. */
  readonly modifiedAt: string;
}

/** What `exists` reports. */
export interface ExistsResult {
  readonly exists: boolean;
  readonly kind: "file" | "dir" | "other" | null;
}

/** Options for `gitCheckout`. */
export interface GitCheckoutOptions extends LeaseOption {
  /** A branch or tag. */
  readonly branch?: string;
  /** Shallow clone depth; default 1. */
  readonly depth?: number;
  /** Workspace-relative target; default the repository's name. */
  readonly targetDir?: string;
  readonly timeoutMs?: number;
  /**
   * Check symbolic links out as links. **Unsafe** for a view of the
   * checkout that is scoped by path: a committed link (`up -> ..`) leads
   * out of the checkout. By default (false) links are checked out as
   * plain files holding the link's text (`core.symlinks=false`).
   */
  readonly unsafeSymlinks?: boolean;
  /**
   * Aborting it kills the clone (its whole process group) and the call
   * fails with `cancelled`; over RPC the client turns it into a
   * `cancel(token)` call, as for `exec`. A clone stopped this way (or by
   * its deadline) leaves no directory behind.
   */
  readonly signal?: AbortSignal;
  /** Names the clone for `cancel(token)`; the client sets it for a `signal`. */
  readonly cancelToken?: string;
}

/** Options for `searchFiles`. */
export interface SearchFilesOptions {
  /** A directory, workspace-relative; default the workspace. */
  readonly path?: string;
  /**
   * A POSIX extended regular expression (at most 256 bytes), matched by
   * `grep -E` in the container; default false: a fixed string (at most
   * 4 KiB).
   */
  readonly regex?: boolean;
  readonly ignoreCase?: boolean;
  /** Search dotfiles and dot-directories too; default true. */
  readonly includeHidden?: boolean;
  /**
   * Refuse (`is_symlink`) when `path` or a directory on its way is a
   * symbolic link, as `noFollow` does for `readFile`; checked in the same
   * exec as the walk, so a directory swapped for a link is never searched.
   * Default false: a link inside the workspace is followed to the
   * directory. The walk below it never follows links either way.
   */
  readonly noFollow?: boolean;
  /** At most this many matching lines; default 1,000, at most 100,000. */
  readonly maxMatches?: number;
  /** The output kept; default and cap as for `exec`. */
  readonly maxOutputBytes?: number;
  /** Default 30 s, capped by the class; past it the call fails with `timeout`. */
  readonly timeoutMs?: number;
  /** Aborting it kills the search; see `ExecOptions.signal`. */
  readonly signal?: AbortSignal;
  readonly cancelToken?: string;
}

/** One line `searchFiles` found. */
export interface SearchMatch {
  /** Workspace-relative. */
  readonly path: string;
  /** From 1. */
  readonly line: number;
  readonly text: string;
}

/** What `searchFiles` found. */
export interface SearchResult {
  readonly matches: readonly SearchMatch[];
  /** True when there were more (past `maxMatches` or the output cap). */
  readonly truncated: boolean;
}

/** A port reachable through preview URLs. */
export interface ExposedPort {
  readonly port: number;
  readonly name: string | null;
  /**
   * The secret part of the preview host name: 26 base32 letters (130
   * bits), a bearer secret.
   */
  readonly token: string;
  /** RFC 3339: when the port was first exposed (audit). */
  readonly createdAt: string;
  /** RFC 3339: when `rotatePort` last replaced the token, or null. */
  readonly rotatedAt: string | null;
  /** RFC 3339: when the token stops working. */
  readonly expiresAt: string;
  /** Filled in by the client when it knows the host name. */
  readonly url?: string;
}

/** Options for `exposePort`. */
export interface ExposePortOptions {
  readonly name?: string;
  /**
   * How long the token lives, in ms; default the class's
   * `previewTokenTtlMs` (15 min), at most 30 days.
   */
  readonly ttlMs?: number;
}

/** Defaults a group of commands shares. */
export interface SessionInfo {
  readonly id: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/** Options for `createSession`. */
export interface SessionOptions {
  /** Default a ULID. An id that exists is refused with `exists`. */
  readonly id?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

/** What `updateSession` changes; each given field replaces the session's. */
export interface SessionUpdate {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

/** What a stream ticket opens; see `openStream`. */
export type StreamRequest =
  | {
    readonly kind: "exec";
    readonly argv: readonly string[];
    readonly options?: StreamExecOptions;
    /** The command's stdin is the body of the request redeeming the ticket. */
    readonly bodyStdin?: boolean;
  }
  | {
    readonly kind: "shell";
    readonly script: string;
    readonly options?: StreamExecOptions;
    readonly bodyStdin?: boolean;
  }
  | {
    readonly kind: "logs";
    readonly processId: string;
    /** Start from the beginning (default) or only new output. */
    readonly fromStart?: boolean;
  }
  | { readonly kind: "read"; readonly path: string }
  | {
    readonly kind: "write";
    readonly path: string;
    readonly options?: Omit<WriteFileOptions, "encoding">;
  };

/**
 * A lease on a name within one sandbox (see `SandboxApi.acquireLease`):
 * whoever holds its token until `expiresAt` holds the name.
 */
export interface Lease {
  readonly name: string;
  /** 26 base32 letters (130 bits); only the holder knows it. */
  readonly token: string;
  /** RFC 3339. */
  readonly expiresAt: string;
}

/** How long a lease lasts from now: `ttlMs`, default 30 s, at most 10 min. */
export interface LeaseOptions {
  readonly ttlMs?: number;
}

/** The sandbox's methods, as its Durable Object stub offers them. */
export interface SandboxApi {
  exec(argv: string[], options?: ExecOptions): Promise<ExecResult>;
  execShell(script: string, options?: ExecOptions): Promise<ExecResult>;
  /** Cancels the exec started with `cancelToken: token`; false if none runs. */
  cancel(token: string): Promise<boolean>;
  openStream(request: StreamRequest): Promise<string>;
  /** Revokes an unused ticket; safe to call repeatedly after cancellation. */
  cancelStream(ticket: string): Promise<boolean>;

  readFile(path: string, options?: ReadFileOptions): Promise<ReadFileResult>;
  writeFile(
    path: string,
    content: string | Uint8Array,
    options?: WriteFileOptions,
  ): Promise<void>;
  mkdir(path: string, options?: RecursiveOptions): Promise<void>;
  deleteFile(path: string, options?: LeaseOption): Promise<void>;
  remove(path: string, options?: RecursiveOptions): Promise<void>;
  renameFile(from: string, to: string, options?: LeaseOption): Promise<void>;
  moveFile(from: string, to: string, options?: LeaseOption): Promise<void>;
  exists(path: string, options?: NoFollowOptions): Promise<ExistsResult>;
  stat(path: string, options?: NoFollowOptions): Promise<FileStat>;
  listFiles(
    path?: string,
    options?: ListFilesOptions,
  ): Promise<ListFilesResult>;
  gitCheckout(url: string, options?: GitCheckoutOptions): Promise<ExecResult>;
  /**
   * Lines of the workspace's files that match `pattern`, found in the
   * container without following symbolic links.
   */
  searchFiles(
    pattern: string,
    options?: SearchFilesOptions,
  ): Promise<SearchResult>;

  startProcess(argv: string[], options?: ProcessOptions): Promise<ProcessInfo>;
  startShellProcess(
    script: string,
    options?: ProcessOptions,
  ): Promise<ProcessInfo>;
  listProcesses(options?: ListProcessesOptions): Promise<ProcessList>;
  getProcess(id: string): Promise<ProcessInfo>;
  /** Forgets a process that has ended: its record and its kept output. */
  deleteProcess(id: string): Promise<void>;
  killProcess(id: string, signal?: string): Promise<ProcessInfo>;
  killAllProcesses(signal?: string): Promise<ProcessInfo[]>;
  getProcessLogs(id: string): Promise<ProcessLogs>;
  waitForExit(
    id: string,
    options?: { timeoutMs?: number },
  ): Promise<ProcessInfo>;
  waitForLog(
    id: string,
    pattern: string,
    options?: WaitForLogOptions,
  ): Promise<{ matched: boolean; line: string | null; process: ProcessInfo }>;

  waitForPort(
    port: number,
    options?: { timeoutMs?: number; path?: string },
  ): Promise<void>;
  exposePort(port: number, options?: ExposePortOptions): Promise<ExposedPort>;
  /** Replaces the port's token; the old one stops working at once. */
  rotatePort(
    port: number,
    options: { expectedToken: string; ttlMs?: number },
  ): Promise<ExposedPort>;
  unexposePort(port: number): Promise<void>;
  getExposedPorts(): Promise<ExposedPort[]>;

  setEnvVars(
    env: Record<string, string | null>,
  ): Promise<Record<string, string>>;
  createSession(options?: SessionOptions): Promise<SessionInfo>;
  updateSession(id: string, patch?: SessionUpdate): Promise<SessionInfo>;
  deleteSession(id: string): Promise<void>;
  listSessions(): Promise<SessionInfo[]>;

  /**
   * Takes the lease on `name` for `ttlMs` unless someone holds it: the
   * lease, or null while it is held. The Durable Object is one instance
   * per sandbox, so this is a lock for every Worker isolate at once: use
   * it to keep read-modify-write sequences of several calls (a patch) from
   * interleaving. The lease `workspace` is enforced by the sandbox: see
   * {@link LeaseOption}.
   */
  acquireLease(name: string, options?: LeaseOptions): Promise<Lease | null>;
  /** Extends a lease the token still holds; null when it is lost. */
  renewLease(
    name: string,
    token: string,
    options?: LeaseOptions,
  ): Promise<Lease | null>;
  /** Gives a lease up; false when the token no longer holds it. */
  releaseLease(name: string, token: string): Promise<boolean>;

  getState(): ContainerState | Promise<ContainerState>;
  stop(signal?: number): Promise<void>;
  /**
   * Ends the sandbox: clears everything stored for it (environment,
   * sessions, ports and their tokens, tickets, process records) and
   * destroys the container.
   */
  destroy(): Promise<void>;
  /** Destroys the container only; the stored state stays. */
  destroyContainer(): Promise<void>;
}
