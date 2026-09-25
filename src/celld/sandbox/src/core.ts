// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link SandboxCore}: the sandbox's behaviour, independent of the Durable
 * Object around it. It runs on a `ContainerController` (for the container
 * and its lifecycle) and a synchronous KV store (for environment, sessions,
 * process records, exposed ports and stream tickets), so tests can drive it
 * with `@celld/container/testing`'s fakes and real host processes.
 *
 * Every command goes through celld's native exec: no agent runs in the
 * container. Files and background processes use the constant scripts of
 * `scripts.ts` with arguments as positional parameters.
 *
 * @module
 */

import {
  type ContainerController,
  type ContainerState,
  type Duration,
  durationMs,
  type NativeContainer,
  type SyncKv,
} from "@celld/container";
import { monotonicFactory } from "@celld/ulid";
import { SandboxError } from "./errors.ts";
import { concat, type RawResult, runRaw } from "./exec.ts";
import { checkDirectory, workspaceEntry, workspacePath } from "./paths.ts";
import * as schema from "./schemas.ts";
import { parse } from "./schemas.ts";
import {
  EXIT_CODES,
  KILL,
  LIST,
  MKDIR,
  MKDIRS,
  POLL,
  READ,
  REMOVE,
  RENAME,
  SETUP,
  SPAWN,
  STAT,
  WRITE,
} from "./scripts.ts";
import { eventStream, SSE_HEADERS } from "./sse.ts";
import type {
  EntryKind,
  ExecEvent,
  ExecOptions,
  ExecResult,
  ExistsResult,
  ExposedPort,
  ExposePortOptions,
  FileEntry,
  FileStat,
  GitCheckoutOptions,
  ListFilesOptions,
  ListFilesResult,
  ProcessEvent,
  ProcessInfo,
  ProcessLogs,
  ProcessOptions,
  ProcessStatus,
  ReadFileOptions,
  ReadFileResult,
  SandboxApi,
  SandboxEvent,
  SessionInfo,
  SessionOptions,
  StreamRequest,
  WriteFileOptions,
} from "./types.ts";

/** How a sandbox is set up; every field has a default. */
export interface SandboxSettings {
  /** The directory file paths are rooted in; default `/workspace`. */
  readonly workspace?: string;
  /** Where process logs live in the container; default `/tmp/.celld-sandbox`. */
  readonly stateDir?: string;
  /**
   * The user every command and file operation runs as; default
   * `"1000:1000"`. `null` keeps the image's user.
   */
  readonly user?: string | null;
  /** The user that creates the workspace; default `"0"`. `null`: the image's. */
  readonly setupUser?: string | null;
  /** The environment every command starts from (before `setEnvVars`). */
  readonly baseEnv?: Readonly<Record<string, string>>;
  /**
   * Start every command from an empty environment (`env -i`) plus the
   * sandbox's own, so nothing of the container's start environment leaks
   * in; default true. Needs an `env` binary (`envCommand`).
   */
  readonly cleanEnv?: boolean;
  /** Default `/usr/bin/env`. */
  readonly envCommand?: string;
  /** The shell `execShell` runs; default `["/bin/sh", "-c"]`. */
  readonly shell?: readonly string[];
  /** Default command deadline; default `"30s"`. */
  readonly execTimeout?: Duration;
  /** The longest deadline a caller may ask for; default `"10m"`. */
  readonly maxExecTimeout?: Duration;
  /** Default output cap per stream; default 1 MiB. */
  readonly maxOutputBytes?: number;
  /** The largest output cap a caller may ask for; default 16 MiB. */
  readonly outputLimitBytes?: number;
  /** The largest file `readFile` and `writeFile` move; default 32 MiB. */
  readonly maxFileBytes?: number;
  /** The largest file a stream ticket moves; default 1 GiB. */
  readonly maxStreamFileBytes?: number;
  /** Background processes running at once; default 32. */
  readonly maxProcesses?: number;
  /** Bytes of each process stream kept in the container; default 16 MiB. */
  readonly processLogBytes?: number;
  /** Bytes of each stream's tail kept in storage after exit; default 64 KiB. */
  readonly keptLogBytes?: number;
  /** How often log streams poll; default `"250ms"`. */
  readonly logPollInterval?: Duration;
  /** The longest a log stream stays open; default `"15m"`. */
  readonly maxStream?: Duration;
}

/** {@link SandboxSettings} with defaults applied. */
export interface ResolvedSettings {
  readonly workspace: string;
  readonly stateDir: string;
  readonly user: string | undefined;
  readonly setupUser: string | undefined;
  readonly baseEnv: Readonly<Record<string, string>>;
  readonly cleanEnv: boolean;
  readonly envCommand: string;
  readonly shell: readonly string[];
  readonly execTimeoutMs: number;
  readonly maxExecTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly outputLimitBytes: number;
  readonly maxFileBytes: number;
  readonly maxStreamFileBytes: number;
  readonly maxProcesses: number;
  readonly processLogBytes: number;
  readonly keptLogBytes: number;
  readonly logPollMs: number;
  readonly maxStreamMs: number;
}

const MiB = 1024 * 1024;

function positive(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new SandboxError("invalid", `${what} must be a positive integer`);
  }
  return value;
}

/** Applies the defaults and checks the settings. */
export function resolveSettings(
  settings: SandboxSettings = {},
): ResolvedSettings {
  const workspace = checkDirectory(
    settings.workspace ?? "/workspace",
    "workspace",
  );
  const baseEnv = settings.baseEnv ?? {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: workspace,
    LANG: "C.UTF-8",
  };
  parse(schema.Env, baseEnv, "baseEnv");
  const shell = settings.shell ?? ["/bin/sh", "-c"];
  if (shell.length === 0 || shell[0] === "") {
    throw new SandboxError("invalid", "shell must name a program");
  }
  return {
    workspace,
    stateDir: checkDirectory(
      settings.stateDir ?? "/tmp/.celld-sandbox",
      "stateDir",
    ),
    user: settings.user === null ? undefined : settings.user ?? "1000:1000",
    setupUser: settings.setupUser === null
      ? undefined
      : settings.setupUser ?? "0",
    baseEnv: { ...baseEnv },
    cleanEnv: settings.cleanEnv ?? true,
    envCommand: settings.envCommand ?? "/usr/bin/env",
    shell: [...shell],
    execTimeoutMs: durationMs(settings.execTimeout ?? "30s"),
    maxExecTimeoutMs: durationMs(settings.maxExecTimeout ?? "10m"),
    maxOutputBytes: positive(settings.maxOutputBytes ?? MiB, "maxOutputBytes"),
    outputLimitBytes: positive(
      settings.outputLimitBytes ?? 16 * MiB,
      "outputLimitBytes",
    ),
    maxFileBytes: positive(settings.maxFileBytes ?? 32 * MiB, "maxFileBytes"),
    maxStreamFileBytes: positive(
      settings.maxStreamFileBytes ?? 1024 * MiB,
      "maxStreamFileBytes",
    ),
    maxProcesses: positive(settings.maxProcesses ?? 32, "maxProcesses"),
    processLogBytes: positive(
      settings.processLogBytes ?? 16 * MiB,
      "processLogBytes",
    ),
    keptLogBytes: positive(settings.keptLogBytes ?? 64 * 1024, "keptLogBytes"),
    logPollMs: durationMs(settings.logPollInterval ?? "250ms"),
    maxStreamMs: durationMs(settings.maxStream ?? "15m"),
  };
}

const KEYS = {
  env: "celld.sandbox/env",
  prepared: "celld.sandbox/prepared",
  ports: "celld.sandbox/ports",
  process: "celld.sandbox/process/",
  session: "celld.sandbox/session/",
  ticket: "celld.sandbox/ticket/",
};

const TICKET_MS = 60_000;
const NOT_YET = /no such container|is not running|not running/i;
const SCRIPT_OUTPUT = 16 * MiB;
const LOG_CHUNK = 64 * 1024;

interface ProcessRecord {
  id: string;
  name: string | null;
  pid: number;
  command: string[];
  cwd: string;
  status: ProcessStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  generation: number;
  killRequested: boolean;
  tail: { stdout: Uint8Array; stderr: Uint8Array; truncated: boolean } | null;
}

interface TicketRecord {
  request: StreamRequest;
  expires: number;
}

interface PollResult {
  exit: number | null;
  timedOut: boolean;
  sizeOut: number;
  sizeErr: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

const encoder = new TextEncoder();
const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** `length` random characters of a 32-letter lowercase alphabet. */
export function randomToken(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((byte) => TOKEN_ALPHABET[byte % 32]).join("");
}

/** Compares two strings in time independent of where they differ. */
export function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function textResult(raw: RawResult): ExecResult {
  return {
    success: raw.exitCode === 0,
    exitCode: raw.exitCode,
    stdout: decode(raw.stdout),
    stderr: decode(raw.stderr),
    timedOut: raw.timedOut,
    truncated: raw.truncated,
    durationMs: raw.durationMs,
  };
}

function base64Bytes(text: string): Uint8Array {
  try {
    const binary = atob(text);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    throw new SandboxError("invalid", "content is not valid base64");
  }
}

// Runs a synchronous body so that a throw becomes a rejection.
function settle<T>(body: () => T): Promise<T> {
  try {
    return Promise.resolve(body());
  } catch (error) {
    return Promise.reject(error);
  }
}

/** See the module documentation. */
export class SandboxCore implements SandboxApi {
  readonly #controller: ContainerController;
  readonly #kv: SyncKv;
  readonly #s: ResolvedSettings;
  readonly #ids: () => string;
  #preparing: Promise<void> | null = null;

  constructor(
    controller: ContainerController,
    kv: SyncKv,
    settings: SandboxSettings = {},
    ids: () => string = monotonicFactory(),
  ) {
    this.#controller = controller;
    this.#kv = kv;
    this.#s = resolveSettings(settings);
    this.#ids = ids;
  }

  /** The settings with defaults applied. */
  get settings(): ResolvedSettings {
    return this.#s;
  }

  get #native(): NativeContainer {
    return this.#controller.native;
  }

  // MARK: Lifecycle

  /** Starts the container if needed and prepares the workspace once per start. */
  async ready(): Promise<void> {
    await this.#controller.ensureRunning();
    const generation = this.#controller.generation;
    if (this.#kv.get<number>(KEYS.prepared) === generation) return;
    this.#preparing ??= this.#prepare(generation).finally(() => {
      this.#preparing = null;
    });
    await this.#preparing;
  }

  async #prepare(generation: number): Promise<void> {
    const s = this.#s;
    // celld reports a container running as soon as its start is accepted,
    // a moment before the engine can exec in it: retry that window.
    const deadline = Date.now() + this.#controller.options.startTimeoutMs;
    for (;;) {
      try {
        await this.#script(SETUP, [s.user ?? "-", s.workspace], {
          user: s.setupUser,
        });
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!NOT_YET.test(message) || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await this.#script(MKDIRS, [`${s.stateDir}/proc`]);
    for (const record of this.#records()) {
      if (record.status === "running" && record.generation !== generation) {
        this.#finish(record, "lost", null);
      }
    }
    this.#kv.put(KEYS.prepared, generation);
  }

  getState(): ContainerState {
    return this.#controller.state();
  }

  async stop(signal = 15): Promise<void> {
    await this.#controller.stop("stop", signal);
  }

  async destroy(): Promise<void> {
    await this.#controller.destroy();
  }

  // MARK: Commands

  #session(id: string | undefined): SessionInfo | null {
    if (id === undefined) return null;
    const session = this.#kv.get<SessionInfo>(KEYS.session + id);
    if (session === undefined) {
      throw new SandboxError("no_such_session", `no session ${id}`);
    }
    return session;
  }

  #env(
    call: Readonly<Record<string, string>> | undefined,
    session: SessionInfo | null,
  ): Record<string, string> {
    return {
      ...this.#s.baseEnv,
      ...(this.#kv.get<Record<string, string>>(KEYS.env) ?? {}),
      ...(session?.env ?? {}),
      ...(call ?? {}),
    };
  }

  // The argv and engine env for a command: `env -i NAME=value... argv` in
  // clean mode, so only the sandbox's variables reach it.
  #command(
    argv: readonly string[],
    env: Record<string, string>,
  ): { argv: string[]; env: Record<string, string> | undefined } {
    if (!this.#s.cleanEnv) return { argv: [...argv], env };
    if (argv[0].includes("=") || argv[0].startsWith("-")) {
      throw new SandboxError(
        "invalid",
        "the command name must not contain = or start with -",
      );
    }
    const assignments = Object.entries(env).map(([name, value]) =>
      `${name}=${value}`
    );
    return {
      argv: [this.#s.envCommand, "-i", ...assignments, ...argv],
      env: undefined,
    };
  }

  #cwd(cwd: string | undefined, session: SessionInfo | null): string {
    const base = session === null ? "" : session.cwd;
    if (cwd === undefined) {
      return workspacePath(this.#s.workspace, base).absolute;
    }
    const joined = cwd.startsWith("/") || base === "" ? cwd : `${base}/${cwd}`;
    return workspacePath(this.#s.workspace, joined).absolute;
  }

  // Runs one of the constant scripts as the sandbox user and maps its own
  // exit statuses to errors.
  async #script(
    script: string,
    args: readonly string[],
    options: {
      stdin?: Uint8Array | ReadableStream<Uint8Array>;
      maxOutputBytes?: number;
      user?: string;
      onChunk?: (
        stream: "stdout" | "stderr",
        bytes: Uint8Array,
      ) => void | Promise<void>;
      timeoutMs?: number;
    } = {},
  ): Promise<RawResult> {
    const s = this.#s;
    const command = this.#command(
      [s.shell[0], "-c", script, "celld-sandbox", ...args],
      { ...s.baseEnv },
    );
    const raw = await runRaw(this.#native, command.argv, {
      env: command.env,
      user: "user" in options ? options.user : s.user,
      stdin: options.stdin,
      timeoutMs: options.timeoutMs ?? s.maxExecTimeoutMs,
      maxOutputBytes: options.maxOutputBytes ?? SCRIPT_OUTPUT,
      onChunk: options.onChunk,
    });
    if (raw.timedOut) {
      throw new SandboxError(
        "timeout",
        "a sandbox helper command ran out of time",
      );
    }
    if (raw.exitCode !== 0) {
      const detail = decode(raw.stderr).trim() ||
        decode(raw.stdout).trim().slice(0, 500) ||
        `exit status ${raw.exitCode}`;
      const code = EXIT_CODES[raw.exitCode ?? -1];
      throw new SandboxError(
        (code ?? "command_failed") as ConstructorParameters<
          typeof SandboxError
        >[0],
        detail,
      );
    }
    return raw;
  }

  async #exec(
    argv: readonly string[],
    options: schema.ExecOptionsValue,
    emit?: (event: ExecEvent) => Promise<void>,
  ): Promise<ExecResult> {
    await this.ready();
    return await this.#controller.busy(() => this.#run(argv, options, emit));
  }

  async #run(
    argv: readonly string[],
    options: schema.ExecOptionsValue,
    emit?: (event: ExecEvent) => Promise<void>,
  ): Promise<ExecResult> {
    const s = this.#s;
    const session = this.#session(options.sessionId);
    const cwd = this.#cwd(options.cwd, session);
    const command = this.#command(argv, this.#env(options.env, session));
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    const raw = await runRaw(this.#native, command.argv, {
      cwd,
      env: command.env,
      user: s.user,
      stdin: typeof options.stdin === "string"
        ? encoder.encode(options.stdin)
        : options.stdin,
      timeoutMs: Math.min(
        options.timeoutMs ?? s.execTimeoutMs,
        s.maxExecTimeoutMs,
      ),
      maxOutputBytes: Math.min(
        options.maxOutputBytes ?? s.maxOutputBytes,
        s.outputLimitBytes,
      ),
      combine: options.combineOutput,
      ...(emit === undefined ? {} : {
        onStart: (pid: number) => emit({ type: "start", pid }),
        onChunk: async (stream: "stdout" | "stderr", bytes: Uint8Array) => {
          const data = decoders[stream].decode(bytes, { stream: true });
          if (data !== "") await emit({ type: stream, data });
        },
      }),
    });
    const result = textResult(raw);
    if (emit !== undefined) {
      for (const stream of ["stdout", "stderr"] as const) {
        const rest = decoders[stream].decode();
        if (rest !== "") await emit({ type: stream, data: rest });
      }
      await emit({
        type: "complete",
        success: result.success,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        truncated: result.truncated,
        durationMs: result.durationMs,
      });
    }
    return result;
  }

  /** Runs `argv` (no shell) and returns its output. */
  async exec(argv: string[], options: ExecOptions = {}): Promise<ExecResult> {
    return await this.#exec(
      parse(schema.Argv, argv, "argv"),
      parse(schema.ExecOptions, options, "options"),
    );
  }

  /** Runs `script` with the configured shell (`sh -c` by default). */
  async execShell(
    script: string,
    options: ExecOptions = {},
  ): Promise<ExecResult> {
    return await this.#exec(
      [...this.#s.shell, parse(schema.Script, script, "script")],
      parse(schema.ExecOptions, options, "options"),
    );
  }

  /**
   * Clones an https repository into the workspace with `git` (which the
   * image must have, with Internet egress enabled).
   */
  async gitCheckout(
    url: string,
    options: GitCheckoutOptions = {},
  ): Promise<ExecResult> {
    const repository = parse(schema.GitUrl, url, "url");
    const o = parse(schema.GitCheckoutOptions, options, "options");
    const name = repository.replace(/\/+$/, "").split("/").pop()!.replace(
      /\.git$/,
      "",
    );
    const target = workspaceEntry(this.#s.workspace, o.targetDir ?? name);
    return await this.#exec([
      "git",
      "clone",
      "--depth",
      String(o.depth ?? 1),
      ...(o.branch === undefined ? [] : ["--branch", o.branch]),
      "--",
      repository,
      target.absolute,
    ], {
      env: { GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: o.timeoutMs ?? Math.min(300_000, this.#s.maxExecTimeoutMs),
    });
  }

  // MARK: Files

  /** A file's contents: UTF-8 text (the default) or bytes. */
  async readFile(
    path: string,
    options: ReadFileOptions = {},
  ): Promise<ReadFileResult> {
    const target = workspacePath(this.#s.workspace, path);
    const o = parse(schema.ReadFileOptions, options, "options");
    const max = Math.min(
      o.maxBytes ?? this.#s.maxFileBytes,
      this.#s.maxFileBytes,
    );
    await this.ready();
    let raw: RawResult;
    try {
      raw = await this.#script(READ, [
        this.#s.workspace,
        target.absolute,
        String(max),
      ], { maxOutputBytes: max + 1 });
    } catch (error) {
      if (error instanceof SandboxError && error.code === "too_large") {
        throw new SandboxError(
          "too_large",
          `${target.relative} has ${error.detail} bytes, more than ${max}`,
        );
      }
      throw error;
    }
    await this.#controller.touch();
    const bytes = raw.stdout;
    if (o.encoding === "bytes") {
      return {
        path: target.relative,
        size: bytes.byteLength,
        encoding: "bytes",
        content: bytes,
      };
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new SandboxError(
        "not_text",
        `${target.relative} is not UTF-8 text; read it with encoding "bytes"`,
      );
    }
    return {
      path: target.relative,
      size: bytes.byteLength,
      encoding: "utf-8",
      content,
    };
  }

  /** Writes a file atomically, creating parent directories unless told not to. */
  async writeFile(
    path: string,
    content: string | Uint8Array,
    options: WriteFileOptions = {},
  ): Promise<void> {
    const target = workspaceEntry(this.#s.workspace, path);
    const o = parse(schema.WriteFileOptions, options, "options");
    const value = parse(schema.Content, content, "content");
    const bytes = typeof value !== "string"
      ? value
      : o.encoding === "base64"
      ? base64Bytes(value)
      : encoder.encode(value);
    if (bytes.byteLength > this.#s.maxFileBytes) {
      throw new SandboxError(
        "too_large",
        `${bytes.byteLength} bytes is more than ${this.#s.maxFileBytes}`,
      );
    }
    await this.ready();
    await this.#script(WRITE, [
      this.#s.workspace,
      target.absolute,
      o.createParents === false ? "0" : "1",
      o.mode ?? "-",
      String(this.#s.maxFileBytes),
    ], { stdin: bytes });
    await this.#controller.touch();
  }

  /** Creates a directory; `recursive` also creates parents and accepts an existing one. */
  async mkdir(
    path: string,
    options: { recursive?: boolean } = {},
  ): Promise<void> {
    const target = workspaceEntry(this.#s.workspace, path);
    const o = parse(schema.Recursive, options, "options");
    await this.ready();
    await this.#script(MKDIR, [
      this.#s.workspace,
      target.absolute,
      o.recursive ? "1" : "0",
    ]);
  }

  /** Removes a file or symbolic link (never a directory). */
  async deleteFile(path: string): Promise<void> {
    const target = workspaceEntry(this.#s.workspace, path);
    await this.ready();
    await this.#script(REMOVE, [this.#s.workspace, target.absolute, "file"]);
  }

  /** Removes a file, an empty directory, or with `recursive` a whole tree. */
  async remove(
    path: string,
    options: { recursive?: boolean } = {},
  ): Promise<void> {
    const target = workspaceEntry(this.#s.workspace, path);
    const o = parse(schema.Recursive, options, "options");
    await this.ready();
    await this.#script(REMOVE, [
      this.#s.workspace,
      target.absolute,
      o.recursive ? "tree" : "empty",
    ]);
  }

  /** Renames or moves a file or directory; an existing file at `to` is replaced. */
  async renameFile(from: string, to: string): Promise<void> {
    const source = workspaceEntry(this.#s.workspace, from);
    const target = workspaceEntry(this.#s.workspace, to);
    await this.ready();
    await this.#script(RENAME, [
      this.#s.workspace,
      source.absolute,
      target.absolute,
    ]);
  }

  /** The same as {@link renameFile}. */
  async moveFile(from: string, to: string): Promise<void> {
    await this.renameFile(from, to);
  }

  /** Kind, size and modification time; symbolic links are followed. */
  async stat(path: string): Promise<FileStat> {
    const target = workspacePath(this.#s.workspace, path);
    await this.ready();
    const raw = await this.#script(STAT, [this.#s.workspace, target.absolute]);
    const [kind, link, size, mtime] = decode(raw.stdout).trim().split(" ");
    return {
      path: target.relative,
      kind: kind as FileStat["kind"],
      symlink: link === "1",
      size: Number(size),
      modifiedAt: Temporal.Instant.fromEpochMilliseconds(Number(mtime) * 1000)
        .toString(),
    };
  }

  /** Whether something is at `path`. Paths outside the workspace still throw. */
  async exists(path: string): Promise<ExistsResult> {
    try {
      const found = await this.stat(path);
      return { exists: true, kind: found.kind };
    } catch (error) {
      if (
        error instanceof SandboxError &&
        (error.code === "not_found" || error.code === "invalid_path")
      ) {
        return { exists: false, kind: null };
      }
      throw error;
    }
  }

  /** A directory's entries (default the workspace root), sorted by path. */
  async listFiles(
    path = "",
    options: ListFilesOptions = {},
  ): Promise<ListFilesResult> {
    const target = workspacePath(this.#s.workspace, path);
    const o = parse(schema.ListFilesOptions, options, "options");
    const limit = o.limit ?? 10_000;
    await this.ready();
    const raw = await this.#script(LIST, [
      this.#s.workspace,
      target.absolute,
      o.recursive ? "1" : "0",
      o.includeHidden ? "1" : "0",
    ]);
    const records = decode(raw.stdout).split("\0");
    if (raw.truncated || records[records.length - 1] !== "") records.pop();
    const kinds: Record<string, EntryKind> = {
      d: "dir",
      f: "file",
      l: "symlink",
    };
    let kind: EntryKind = "other";
    const entries: FileEntry[] = [];
    for (const record of records) {
      if (record in kinds) {
        kind = kinds[record];
        continue;
      }
      if (!record.startsWith("./")) continue;
      const rest = record.slice(2);
      const relative = target.relative === ""
        ? rest
        : `${target.relative}/${rest}`;
      entries.push({ path: relative, name: rest.split("/").pop()!, kind });
    }
    entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return {
      entries: entries.slice(0, limit),
      truncated: raw.truncated || entries.length > limit,
    };
  }

  // MARK: Processes

  *#records(): Generator<ProcessRecord> {
    for (
      const [, record] of this.#kv.list<ProcessRecord>({ prefix: KEYS.process })
    ) {
      yield record;
    }
  }

  #record(id: string): ProcessRecord {
    const key = parse(schema.Id, id, "process id");
    const record = this.#kv.get<ProcessRecord>(KEYS.process + key);
    if (record === undefined) {
      throw new SandboxError("no_such_process", `no process ${id}`);
    }
    return record;
  }

  #info(record: ProcessRecord): ProcessInfo {
    return {
      id: record.id,
      name: record.name,
      pid: record.pid,
      command: record.command,
      cwd: record.cwd,
      status: record.status,
      exitCode: record.exitCode,
      startedAt: new Date(record.startedAt).toISOString(),
      endedAt: record.endedAt === null
        ? null
        : new Date(record.endedAt).toISOString(),
    };
  }

  #directory(id: string): string {
    return `${this.#s.stateDir}/proc/${id}`;
  }

  #finish(
    record: ProcessRecord,
    status: ProcessStatus,
    exitCode: number | null,
    tail: ProcessRecord["tail"] = record.tail,
  ): ProcessRecord {
    const done: ProcessRecord = {
      ...record,
      status,
      exitCode,
      endedAt: Date.now(),
      tail,
    };
    this.#kv.put(KEYS.process + record.id, done);
    return done;
  }

  async #poll(
    record: ProcessRecord,
    offsetOut: number,
    offsetErr: number,
    max: number,
  ): Promise<PollResult | null> {
    const raw = await this.#script(POLL, [
      this.#directory(record.id),
      String(offsetOut),
      String(offsetErr),
      String(max),
    ], { maxOutputBytes: 2 * max + 256 });
    const bytes = raw.stdout;
    const newline = bytes.indexOf(10);
    const header = decode(
      bytes.subarray(0, newline < 0 ? bytes.length : newline),
    );
    if (header === "missing") return null;
    const [exit, timedOut, sizeOut, sizeErr] = header.split(" ");
    const nOut = Math.max(0, Math.min(Number(sizeOut) - offsetOut, max));
    const nErr = Math.max(0, Math.min(Number(sizeErr) - offsetErr, max));
    const body = bytes.subarray(newline + 1);
    return {
      exit: exit === "-" ? null : Number(exit),
      timedOut: timedOut === "1",
      sizeOut: Number(sizeOut),
      sizeErr: Number(sizeErr),
      stdout: body.subarray(0, nOut),
      stderr: body.subarray(nOut, nOut + nErr),
    };
  }

  // Brings a running record up to date: exited, killed, timed out or lost.
  async #refresh(record: ProcessRecord): Promise<ProcessRecord> {
    if (record.status !== "running") return record;
    const native = this.#controller.native;
    if (record.generation !== this.#controller.generation || !native.running) {
      return this.#finish(record, "lost", null);
    }
    const header = await this.#poll(record, 0, 0, 0);
    if (header === null) return this.#finish(record, "lost", null);
    if (header.exit === null) return record;
    const kept = this.#s.keptLogBytes;
    const tail = await this.#poll(
      record,
      Math.max(0, header.sizeOut - kept),
      Math.max(0, header.sizeErr - kept),
      kept,
    );
    const status: ProcessStatus = header.timedOut
      ? "timed_out"
      : record.killRequested
      ? "killed"
      : "exited";
    return this.#finish(
      record,
      status,
      header.exit,
      tail === null ? null : {
        stdout: tail.stdout,
        stderr: tail.stderr,
        truncated: header.sizeOut > kept || header.sizeErr > kept ||
          header.sizeOut >= this.#s.processLogBytes ||
          header.sizeErr >= this.#s.processLogBytes,
      },
    );
  }

  async #start(
    argv: readonly string[],
    options: schema.ProcessOptionsValue,
  ): Promise<ProcessInfo> {
    await this.ready();
    let running = 0;
    for (const record of this.#records()) {
      if (
        record.status === "running" &&
        (await this.#refresh(record)).status === "running"
      ) {
        running += 1;
      }
    }
    if (running >= this.#s.maxProcesses) {
      throw new SandboxError(
        "too_many_processes",
        `${running} processes are running, the limit is ${this.#s.maxProcesses}`,
      );
    }
    const session = this.#session(options.sessionId);
    const cwd = this.#cwd(options.cwd, session);
    const command = this.#command(argv, this.#env(options.env, session));
    const id = this.#ids();
    const seconds = options.timeoutMs === undefined
      ? 0
      : Math.ceil(options.timeoutMs / 1000);
    const s = this.#s;
    // SPAWN is not wrapped again: the command itself carries `env -i`.
    const raw = await runRaw(this.#native, [
      s.shell[0],
      "-c",
      SPAWN,
      "celld-sandbox",
      this.#directory(id),
      String(s.processLogBytes),
      String(seconds),
      cwd,
      ...command.argv,
    ], {
      env: command.env,
      user: s.user,
      timeoutMs: 30_000,
      maxOutputBytes: 4096,
    });
    if (raw.exitCode !== 0) {
      const code = EXIT_CODES[raw.exitCode ?? -1];
      throw new SandboxError(
        (code ?? "command_failed") as ConstructorParameters<
          typeof SandboxError
        >[0],
        decode(raw.stderr).trim() || "the process did not start",
      );
    }
    const record: ProcessRecord = {
      id,
      name: options.name ?? null,
      pid: Number(decode(raw.stdout).trim()),
      command: [...argv],
      cwd: workspacePath(s.workspace, cwd).relative,
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      generation: this.#controller.generation,
      killRequested: false,
      tail: null,
    };
    this.#kv.put(KEYS.process + id, record);
    await this.#controller.touch();
    return this.#info(record);
  }

  /** Starts `argv` in the background, detached from this request. */
  async startProcess(
    argv: string[],
    options: ProcessOptions = {},
  ): Promise<ProcessInfo> {
    return await this.#start(
      parse(schema.Argv, argv, "argv"),
      parse(schema.ProcessOptions, options, "options"),
    );
  }

  /** Starts `script` with the configured shell in the background. */
  async startShellProcess(
    script: string,
    options: ProcessOptions = {},
  ): Promise<ProcessInfo> {
    return await this.#start(
      [...this.#s.shell, parse(schema.Script, script, "script")],
      parse(schema.ProcessOptions, options, "options"),
    );
  }

  // Refreshing needs the container; a stopped one means lost processes
  // without starting it just to look.
  async #refreshed(record: ProcessRecord): Promise<ProcessRecord> {
    if (!this.#controller.native.running) {
      return record.status === "running"
        ? this.#finish(record, "lost", null)
        : record;
    }
    // Looking at processes counts as using the sandbox.
    await this.#controller.touch();
    return record.status === "running" ? await this.#refresh(record) : record;
  }

  /** Every process this sandbox started, oldest first. */
  async listProcesses(): Promise<ProcessInfo[]> {
    const out: ProcessInfo[] = [];
    for (const record of [...this.#records()]) {
      out.push(this.#info(await this.#refreshed(record)));
    }
    return out;
  }

  async getProcess(id: string): Promise<ProcessInfo> {
    return this.#info(await this.#refreshed(this.#record(id)));
  }

  /** Sends `signal` (default TERM) to the process's group and waits up to 1 s. */
  async killProcess(id: string, signal = "TERM"): Promise<ProcessInfo> {
    const name = parse(schema.Signal, signal, "signal");
    let record = await this.#refreshed(this.#record(id));
    if (record.status !== "running") return this.#info(record);
    record = { ...record, killRequested: true };
    this.#kv.put(KEYS.process + record.id, record);
    try {
      await this.#script(KILL, [String(record.pid), name]);
    } catch {
      // It may have exited already; the refresh below tells.
    }
    for (let i = 0; i < 20; i++) {
      record = await this.#refresh(record);
      if (record.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return this.#info(record);
  }

  async killAllProcesses(signal = "TERM"): Promise<ProcessInfo[]> {
    parse(schema.Signal, signal, "signal");
    const out: ProcessInfo[] = [];
    for (const record of [...this.#records()]) {
      out.push(
        record.status === "running"
          ? await this.killProcess(record.id, signal)
          : this.#info(record),
      );
    }
    return out;
  }

  /** The output so far (up to the output cap), or the kept tail once the container is gone. */
  async getProcessLogs(id: string): Promise<ProcessLogs> {
    let record = await this.#refreshed(this.#record(id));
    const live = record.generation === this.#controller.generation &&
      this.#controller.native.running;
    if (live) {
      const cap = this.#s.outputLimitBytes;
      const polled = await this.#poll(record, 0, 0, cap);
      if (polled !== null) {
        record = await this.#refresh(record);
        return {
          stdout: decode(polled.stdout),
          stderr: decode(polled.stderr),
          truncated: polled.sizeOut > cap || polled.sizeErr > cap ||
            polled.sizeOut >= this.#s.processLogBytes ||
            polled.sizeErr >= this.#s.processLogBytes,
          process: this.#info(record),
        };
      }
    }
    return {
      stdout: decode(record.tail?.stdout ?? new Uint8Array()),
      stderr: decode(record.tail?.stderr ?? new Uint8Array()),
      truncated: record.tail === null ? true : record.tail.truncated,
      process: this.#info(record),
    };
  }

  /** Waits for the process to end, up to `timeoutMs` (default 30 s). */
  async waitForExit(
    id: string,
    options: { timeoutMs?: number } = {},
  ): Promise<ProcessInfo> {
    const o = parse(schema.WaitOptions, options, "options");
    const deadline = Date.now() +
      Math.min(o.timeoutMs ?? 30_000, this.#s.maxExecTimeoutMs);
    return await this.#controller.busy(async () => {
      let record = await this.#refreshed(this.#record(id));
      while (record.status === "running" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, this.#s.logPollMs));
        record = await this.#refreshed(record);
      }
      return this.#info(record);
    });
  }

  /**
   * Waits until the process's output matches `pattern` (a regular
   * expression), up to `timeoutMs` (default 30 s): for a server's "listening"
   * line, say. Answers `matched: false` when it ends or time runs out.
   */
  async waitForLog(
    id: string,
    pattern: string,
    options: { timeoutMs?: number; stream?: "stdout" | "stderr" | "both" } = {},
  ): Promise<{ matched: boolean; line: string | null; process: ProcessInfo }> {
    const o = parse(schema.WaitForLogOptions, options, "options");
    let regex: RegExp;
    try {
      regex = new RegExp(parse(schema.Script, pattern, "pattern"));
    } catch (error) {
      if (error instanceof SandboxError) throw error;
      throw new SandboxError("invalid", `pattern: ${(error as Error).message}`);
    }
    const which = o.stream ?? "both";
    const deadline = Date.now() +
      Math.min(o.timeoutMs ?? 30_000, this.#s.maxExecTimeoutMs);
    return await this.#controller.busy(() =>
      this.#waitForLog(id, regex, which, deadline)
    );
  }

  async #waitForLog(
    id: string,
    regex: RegExp,
    which: "stdout" | "stderr" | "both",
    deadline: number,
  ): Promise<{ matched: boolean; line: string | null; process: ProcessInfo }> {
    let record = this.#record(id);
    const texts = { stdout: "", stderr: "" };
    const offsets = { stdout: 0, stderr: 0 };
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    for (;;) {
      record = await this.#refreshed(record);
      const polled = record.generation === this.#controller.generation &&
          this.#controller.native.running
        ? await this.#poll(record, offsets.stdout, offsets.stderr, LOG_CHUNK)
        : null;
      if (polled !== null) {
        for (const stream of ["stdout", "stderr"] as const) {
          const chunk = polled[stream];
          offsets[stream] += chunk.byteLength;
          texts[stream] = (texts[stream] +
            decoders[stream].decode(chunk, { stream: true })).slice(-LOG_CHUNK);
          if (which !== "both" && which !== stream) continue;
          const lines = texts[stream].split("\n");
          const line = lines.find((text) => regex.test(text));
          if (line !== undefined) {
            return { matched: true, line, process: this.#info(record) };
          }
        }
        if (polled.stdout.byteLength > 0 || polled.stderr.byteLength > 0) {
          continue;
        }
      }
      if (record.status !== "running" || Date.now() >= deadline) {
        return { matched: false, line: null, process: this.#info(record) };
      }
      await new Promise((resolve) => setTimeout(resolve, this.#s.logPollMs));
    }
  }

  async #followLogs(
    id: string,
    fromStart: boolean,
    emit: (event: ProcessEvent) => Promise<void>,
  ): Promise<void> {
    let record = this.#record(id);
    const offsets = { stdout: 0, stderr: 0 };
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    const deadline = Date.now() + this.#s.maxStreamMs;
    let first = true;
    for (;;) {
      const live = record.generation === this.#controller.generation &&
        this.#controller.native.running;
      const polled = live
        ? await this.#poll(record, offsets.stdout, offsets.stderr, LOG_CHUNK)
        : null;
      if (polled === null) {
        record = await this.#refreshed(record);
        if (first && fromStart && record.tail !== null) {
          for (const stream of ["stdout", "stderr"] as const) {
            const data = decode(record.tail[stream]);
            if (data !== "") await emit({ type: stream, data });
          }
        }
        await emit({
          type: "exit",
          status: record.status,
          exitCode: record.exitCode,
        });
        return;
      }
      if (first && !fromStart) {
        offsets.stdout = polled.sizeOut;
        offsets.stderr = polled.sizeErr;
        first = false;
        continue;
      }
      first = false;
      let moved = false;
      for (const stream of ["stdout", "stderr"] as const) {
        const chunk = polled[stream];
        if (chunk.byteLength === 0) continue;
        moved = true;
        offsets[stream] += chunk.byteLength;
        const data = decoders[stream].decode(chunk, { stream: true });
        if (data !== "") await emit({ type: stream, data });
      }
      if (moved) continue;
      if (polled.exit !== null) {
        record = await this.#refresh(record);
        await emit({
          type: "exit",
          status: record.status,
          exitCode: record.exitCode,
        });
        return;
      }
      if (Date.now() >= deadline) {
        await emit({
          type: "error",
          code: "timeout",
          message: "the log stream reached its time limit; open another",
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, this.#s.logPollMs));
    }
  }

  // MARK: Ports

  /**
   * Waits until `port` in the container accepts a TCP connection (or
   * answers `path` over HTTP): for a server a background process starts.
   */
  async waitForPort(
    port: number,
    options: { timeoutMs?: number; path?: string } = {},
  ): Promise<void> {
    const number = parse(schema.Port, port, "port");
    const o = parse(schema.WaitForPortOptions, options, "options");
    await this.ready();
    await this.#controller.busy(() =>
      this.#controller.waitForPort(number, {
        timeoutMs: Math.min(o.timeoutMs ?? 30_000, this.#s.maxExecTimeoutMs),
        ...(o.path === undefined ? {} : { path: o.path }),
      })
    );
  }

  #ports(): Record<string, ExposedPort> {
    return this.#kv.get<Record<string, ExposedPort>>(KEYS.ports) ?? {};
  }

  /**
   * Makes `port` reachable through preview requests carrying a fresh
   * token (see `proxyToSandbox`). Exposing it again keeps its token.
   */
  exposePort(
    port: number,
    options: ExposePortOptions = {},
  ): Promise<ExposedPort> {
    return settle(() => {
      const number = parse(schema.Port, port, "port");
      const o = parse(schema.ExposePortOptions, options, "options");
      const ports = this.#ports();
      const existing = ports[number];
      const exposed: ExposedPort = {
        port: number,
        name: o.name ?? existing?.name ?? null,
        token: existing?.token ?? randomToken(16),
      };
      ports[number] = exposed;
      this.#kv.put(KEYS.ports, ports);
      return exposed;
    });
  }

  unexposePort(port: number): Promise<void> {
    return settle(() => {
      const number = parse(schema.Port, port, "port");
      const ports = this.#ports();
      if (!(number in ports)) {
        throw new SandboxError(
          "port_not_exposed",
          `port ${number} is not exposed`,
        );
      }
      delete ports[number];
      this.#kv.put(KEYS.ports, ports);
    });
  }

  getExposedPorts(): Promise<ExposedPort[]> {
    return settle(() =>
      Object.values(this.#ports()).sort((a, b) => a.port - b.port)
    );
  }

  /** Forwards `request` to an exposed port whose token matches. */
  async previewFetch(
    port: number,
    token: string,
    request: Request,
  ): Promise<Response> {
    const exposed = this.#ports()[port];
    if (exposed === undefined || !sameToken(exposed.token, token)) {
      return new Response("not found", { status: 404 });
    }
    await this.ready();
    return await this.#controller.fetch(request, undefined, port);
  }

  // MARK: Environment and sessions

  /** Merges sandbox-wide variables into every later command; `null` removes one. */
  setEnvVars(
    env: Record<string, string | null>,
  ): Promise<Record<string, string>> {
    return settle(() => {
      const update = parse(schema.EnvUpdate, env, "env");
      const current = this.#kv.get<Record<string, string>>(KEYS.env) ?? {};
      for (const [name, value] of Object.entries(update)) {
        if (value === null) delete current[name];
        else current[name] = value;
      }
      parse(schema.Env, current, "env");
      this.#kv.put(KEYS.env, current);
      return { ...current };
    });
  }

  /** A named set of defaults (working directory, environment) for commands. */
  createSession(options: SessionOptions = {}): Promise<SessionInfo> {
    return settle(() => {
      const o = parse(schema.SessionOptions, options, "options");
      const session: SessionInfo = {
        id: o.id ?? this.#ids(),
        cwd: workspacePath(this.#s.workspace, o.cwd ?? "").relative,
        env: { ...(o.env ?? {}) },
      };
      this.#kv.put(KEYS.session + session.id, session);
      return session;
    });
  }

  deleteSession(id: string): Promise<void> {
    return settle(() => {
      const key = parse(schema.Id, id, "session id");
      if (!this.#kv.delete(KEYS.session + key)) {
        throw new SandboxError("no_such_session", `no session ${id}`);
      }
      return;
    });
  }

  listSessions(): Promise<SessionInfo[]> {
    return settle(() =>
      [...this.#kv.list<SessionInfo>({ prefix: KEYS.session })].map((
        [, value],
      ) => value)
    );
  }

  // MARK: Streams

  /**
   * A one-time ticket (valid for 60 s) for a streamed operation: a command's
   * events, a process's logs, or a file's bytes in either direction. Redeem
   * it with {@link stream} through the object's `fetch`, which is the only
   * way celld carries a stream out of a Durable Object.
   */
  openStream(request: StreamRequest): Promise<string> {
    return settle(() => {
      const checked = parse(
        schema.StreamRequest,
        request,
        "request",
      ) as StreamRequest;
      const ticket = randomToken(32);
      this.#kv.put<TicketRecord>(KEYS.ticket + ticket, {
        request: checked,
        expires: Date.now() + TICKET_MS,
      });
      for (
        const [key, value] of [
          ...this.#kv.list<TicketRecord>({ prefix: KEYS.ticket }),
        ]
      ) {
        if (value.expires < Date.now()) this.#kv.delete(key);
      }
      return ticket;
    });
  }

  /** Redeems a ticket from {@link openStream}; `body` feeds a `write`. */
  async stream(
    ticket: string,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<Response> {
    const key = KEYS.ticket + ticket;
    const found = /^[a-z2-7]{32}$/.test(ticket)
      ? this.#kv.get<TicketRecord>(key)
      : undefined;
    if (found !== undefined) this.#kv.delete(key);
    if (found === undefined || found.expires < Date.now()) {
      throw new SandboxError(
        "bad_ticket",
        "the stream ticket is unknown, used or expired",
      );
    }
    const request = found.request;
    const failure = (error: unknown) => {
      const known = SandboxError.from(error);
      return {
        code: known?.code ?? "internal",
        message: known?.detail ??
          (error instanceof Error ? error.message : String(error)),
      };
    };
    switch (request.kind) {
      case "exec":
      case "shell": {
        const argv = request.kind === "exec"
          ? request.argv
          : [...this.#s.shell, request.script];
        const options = request.options ?? {};
        await this.ready();
        return new Response(
          eventStream(
            (emit) =>
              this.#exec(argv, options as schema.ExecOptionsValue, emit).then(
                () => {},
              ),
            failure,
          ),
          { headers: SSE_HEADERS },
        );
      }
      case "logs": {
        this.#record(request.processId);
        return new Response(
          eventStream(
            (emit) =>
              this.#controller.busy(() =>
                this.#followLogs(
                  request.processId,
                  request.fromStart ?? true,
                  emit as (event: SandboxEvent) => Promise<void>,
                )
              ),
            failure,
          ),
          { headers: SSE_HEADERS },
        );
      }
      case "read":
        return await this.#readStream(request.path);
      case "write":
        return await this.#writeStream(
          request.path,
          request.options ?? {},
          body,
        );
    }
  }

  async #readStream(path: string): Promise<Response> {
    const found = await this.stat(path);
    if (found.kind !== "file") {
      throw new SandboxError(
        "not_regular",
        `${found.path} is not a regular file`,
      );
    }
    const target = workspacePath(this.#s.workspace, path);
    const max = this.#s.maxStreamFileBytes;
    const { readable, writable } = new TransformStream<
      Uint8Array,
      Uint8Array
    >();
    const writer = writable.getWriter();
    this.#controller.busy(() =>
      this.#script(READ, [this.#s.workspace, target.absolute, String(max)], {
        maxOutputBytes: max,
        onChunk: async (stream, bytes) => {
          if (stream === "stdout") await writer.write(bytes);
        },
      })
    ).then(
      () => writer.close(),
      (error) => writer.abort(error),
    ).catch(() => {});
    return new Response(readable, {
      headers: {
        "content-type": "application/octet-stream",
        "x-celld-sandbox-size": String(found.size),
      },
    });
  }

  async #writeStream(
    path: string,
    options: { createParents?: boolean; mode?: string },
    body: ReadableStream<Uint8Array> | null,
  ): Promise<Response> {
    const target = workspaceEntry(this.#s.workspace, path);
    await this.ready();
    await this.#controller.busy(() =>
      this.#script(WRITE, [
        this.#s.workspace,
        target.absolute,
        options.createParents === false ? "0" : "1",
        options.mode ?? "-",
        String(this.#s.maxStreamFileBytes),
      ], { stdin: body ?? new Uint8Array() })
    );
    const found = await this.stat(path);
    return Response.json({ path: found.path, size: found.size });
  }
}

/** Bytes of a whole stream, for tests and small bodies. */
export async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return concat(chunks);
}
