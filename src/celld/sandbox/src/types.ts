// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The sandbox API's data shapes. Everything here is structured-clone data,
 * so it crosses Durable Object RPC unchanged.
 *
 * @module
 */

import type { ContainerState } from "@celld/container";

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
export interface ExecOptions extends CommandOptions {
  /** Kill the command after this long; default 30 s, capped by the class. */
  readonly timeoutMs?: number;
  /** Keep at most this many bytes of each output stream; default 1 MiB. */
  readonly maxOutputBytes?: number;
  /** Bytes or text for the command's stdin; default none (closed). */
  readonly stdin?: string | Uint8Array;
  /** Send stderr into stdout, interleaved as written (stderr is then ""). */
  readonly combineOutput?: boolean;
}

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

/** Options for `startProcess`. */
export interface ProcessOptions extends CommandOptions {
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

/** Options for `readFile`. */
export interface ReadFileOptions {
  /** `utf-8` (default; refuses invalid UTF-8) or `bytes`. */
  readonly encoding?: "utf-8" | "bytes";
  /** Refuse files bigger than this; default and cap from the class. */
  readonly maxBytes?: number;
}

/** A file's contents, as text or bytes by the requested encoding. */
export type ReadFileResult =
  | {
    readonly path: string;
    readonly size: number;
    readonly encoding: "utf-8";
    readonly content: string;
  }
  | {
    readonly path: string;
    readonly size: number;
    readonly encoding: "bytes";
    readonly content: Uint8Array;
  };

/** Options for `writeFile`. */
export interface WriteFileOptions {
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

/** Options for `listFiles`. */
export interface ListFilesOptions {
  /** Descend into subdirectories; default false. */
  readonly recursive?: boolean;
  /** Include dotfiles and descend into dot-directories; default false. */
  readonly includeHidden?: boolean;
  /** At most this many entries; default 10,000. */
  readonly limit?: number;
}

/** A directory listing, sorted by path. */
export interface ListFilesResult {
  readonly entries: readonly FileEntry[];
  /** True when `limit` cut it short. */
  readonly truncated: boolean;
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
export interface GitCheckoutOptions {
  /** A branch or tag. */
  readonly branch?: string;
  /** Shallow clone depth; default 1. */
  readonly depth?: number;
  /** Workspace-relative target; default the repository's name. */
  readonly targetDir?: string;
  readonly timeoutMs?: number;
}

/** A port reachable through preview URLs. */
export interface ExposedPort {
  readonly port: number;
  readonly name: string | null;
  /** The secret part of the preview host name. */
  readonly token: string;
  /** Filled in by the client when it knows the host name. */
  readonly url?: string;
}

/** Options for `exposePort`. */
export interface ExposePortOptions {
  readonly name?: string;
}

/** Defaults a group of commands shares. */
export interface SessionInfo {
  readonly id: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/** Options for `createSession`. */
export interface SessionOptions {
  /** Default a ULID. */
  readonly id?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

/** What a stream ticket opens; see `openStream`. */
export type StreamRequest =
  | {
    readonly kind: "exec";
    readonly argv: readonly string[];
    readonly options?: ExecOptions;
  }
  | {
    readonly kind: "shell";
    readonly script: string;
    readonly options?: ExecOptions;
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

/** The sandbox's methods, as its Durable Object stub offers them. */
export interface SandboxApi {
  exec(argv: string[], options?: ExecOptions): Promise<ExecResult>;
  execShell(script: string, options?: ExecOptions): Promise<ExecResult>;
  openStream(request: StreamRequest): Promise<string>;

  readFile(path: string, options?: ReadFileOptions): Promise<ReadFileResult>;
  writeFile(
    path: string,
    content: string | Uint8Array,
    options?: WriteFileOptions,
  ): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  deleteFile(path: string): Promise<void>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  renameFile(from: string, to: string): Promise<void>;
  moveFile(from: string, to: string): Promise<void>;
  exists(path: string): Promise<ExistsResult>;
  stat(path: string): Promise<FileStat>;
  listFiles(
    path?: string,
    options?: ListFilesOptions,
  ): Promise<ListFilesResult>;
  gitCheckout(url: string, options?: GitCheckoutOptions): Promise<ExecResult>;

  startProcess(argv: string[], options?: ProcessOptions): Promise<ProcessInfo>;
  startShellProcess(
    script: string,
    options?: ProcessOptions,
  ): Promise<ProcessInfo>;
  listProcesses(): Promise<ProcessInfo[]>;
  getProcess(id: string): Promise<ProcessInfo>;
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
    options?: { timeoutMs?: number; stream?: "stdout" | "stderr" | "both" },
  ): Promise<{ matched: boolean; line: string | null; process: ProcessInfo }>;

  waitForPort(
    port: number,
    options?: { timeoutMs?: number; path?: string },
  ): Promise<void>;
  exposePort(port: number, options?: ExposePortOptions): Promise<ExposedPort>;
  unexposePort(port: number): Promise<void>;
  getExposedPorts(): Promise<ExposedPort[]>;

  setEnvVars(
    env: Record<string, string | null>,
  ): Promise<Record<string, string>>;
  createSession(options?: SessionOptions): Promise<SessionInfo>;
  deleteSession(id: string): Promise<void>;
  listSessions(): Promise<SessionInfo[]>;

  getState(): ContainerState | Promise<ContainerState>;
  stop(signal?: number): Promise<void>;
  destroy(): Promise<void>;
}
