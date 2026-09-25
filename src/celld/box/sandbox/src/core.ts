// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link SandboxCore}: the sandbox's behaviour, independent of the Durable
 * Object around it. It runs on a `ContainerController` (for the container
 * and its lifecycle) and a synchronous KV store (for environment, sessions,
 * process records, exposed ports and stream tickets), so tests can drive it
 * with `@celld/box/container/testing`'s fakes and real host processes.
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
} from "@celld/box/container";
import {
  readBounded,
  safeInt,
  strictRecord as checkRecord,
  utf8Length,
} from "@celld/core/bounds";
import { classifyHost } from "@celld/http/egress";
import { monotonicFactory } from "@celld/core/ulid";
import { errorStatus, SandboxError } from "./errors.ts";
import { type RawResult, runRaw } from "./exec.ts";
import { checkDirectory, workspaceEntry, workspacePath } from "./paths.ts";
import * as schema from "./schemas.ts";
import { parse } from "./schemas.ts";
import {
  EXIT_CODES,
  GITCLONE,
  GITUNDO,
  KILL,
  KILLRUN,
  LIST,
  LOGGREP,
  MKDIR,
  MKDIRS,
  POLL,
  READ,
  READSTREAM,
  REGEXCHECK,
  REMOVE,
  REMOVE_DIR,
  RENAME,
  RUN,
  RUN_UNRECORDED,
  RUN_UNRECORDED_MESSAGE,
  RUNTIME,
  SEARCH,
  SETUP,
  SPAWN,
  SPAWNUNDO,
  STAT,
  SWEEP,
  WRITE,
  WRITEUNDO,
} from "./scripts.ts";
import { boundedStream, eventStream, SSE_HEADERS } from "./sse.ts";
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
  Lease,
  LeaseOption,
  LeaseOptions,
  ListFilesOptions,
  ListFilesResult,
  ListProcessesOptions,
  NoFollowOptions,
  ProcessEvent,
  ProcessInfo,
  ProcessList,
  ProcessLogs,
  ProcessOptions,
  ProcessStatus,
  ReadFileOptions,
  ReadFileResult,
  RecursiveOptions,
  SandboxApi,
  SandboxEvent,
  SearchFilesOptions,
  SearchMatch,
  SearchResult,
  SessionInfo,
  SessionOptions,
  SessionUpdate,
  StreamRequest,
  WaitForLogOptions,
  WriteFileOptions,
} from "./types.ts";

/**
 * Who the sandbox runs code for; see the README's "Threat tiers".
 *
 * - `trusted`: code you would run yourself (your agent's own
 *   tools, your tests). Limits are for convenience; cancellation kills the
 *   command's process group, which a determined process can leave.
 * - `hostile`: code that may attack the sandbox. Refuses to run unless the
 *   container runs on gVisor (`runsc`), and adds the escape sweep.
 */
export type SandboxTier = "trusted" | "hostile";

/** How a sandbox is set up. Threat intent must be selected explicitly. */
export interface SandboxSettings {
  /** Required in types and at runtime: `trusted` or `hostile`. */
  readonly tier: SandboxTier;
  /**
   * After every command, kill processes that left their command's session
   * (daemons, double forks with `setsid`); if any survive, destroy the
   * container. Default: on for `hostile`, off for `trusted`. It reads the
   * container's whole /proc, so it is for real containers only: never turn
   * it on over a host (`@celld/box/sandbox/testing`).
   */
  readonly sweepEscapes?: boolean;
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
  /**
   * The environment every command starts from (before `setEnvVars`); at
   * most `maxEnvBytes`, like every other layer.
   */
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
  /**
   * Commands running at once, foreground and background together (the
   * sandbox's own file and log helpers do not count); default 32.
   */
  readonly maxProcesses?: number;
  /** Bytes of each process stream kept in the container; default 16 MiB. */
  readonly processLogBytes?: number;
  /** Bytes of each stream's tail kept in storage after exit; default 64 KiB. */
  readonly keptLogBytes?: number;
  /**
   * Bytes of a command's argv in total (each argument plus its NUL);
   * default 256 KiB. With `maxEnvBytes` at most 1 MiB, which with the
   * wrapper around every command (its script and `PATH`, at most 128 KiB)
   * stays below Linux's ARG_MAX (2 MiB with the usual 8 MiB stack).
   */
  readonly maxArgvBytes?: number;
  /**
   * Bytes of a command's environment in total (each `NAME=value` plus its
   * NUL), for every layer and for the merged result; default 256 KiB.
   */
  readonly maxEnvBytes?: number;
  /** Bytes of a command's stdin; default 8 MiB. */
  readonly maxStdinBytes?: number;
  /** Bytes a stream ticket may store (its whole request); default 1 MiB. */
  readonly maxTicketBytes?: number;
  /** Finished process records kept, newest first; default 200. */
  readonly maxFinishedRecords?: number;
  /** How long a finished process record is kept, in ms; default 24 h. */
  readonly recordTtlMs?: number;
  /** Sessions at once; default 64. */
  readonly maxSessions?: number;
  /** Stream tickets opened and not yet redeemed or expired; default 32. */
  readonly maxOpenTickets?: number;
  /**
   * How long a preview token lives unless `exposePort` says otherwise, in
   * ms; default 15 min, at most 30 days.
   */
  readonly previewTokenTtlMs?: number;
  /** How often log streams poll; default `"250ms"`. */
  readonly logPollInterval?: Duration;
  /** The longest a log stream stays open; default `"15m"`. */
  readonly maxStream?: Duration;
}

/** {@link SandboxSettings} with defaults applied. */
export interface ResolvedSettings {
  readonly tier: SandboxTier;
  readonly sweepEscapes: boolean;
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
  readonly maxArgvBytes: number;
  readonly maxEnvBytes: number;
  readonly maxStdinBytes: number;
  readonly maxTicketBytes: number;
  readonly maxFileBytes: number;
  readonly maxStreamFileBytes: number;
  readonly maxProcesses: number;
  readonly processLogBytes: number;
  readonly keptLogBytes: number;
  readonly maxFinishedRecords: number;
  readonly recordTtlMs: number;
  readonly maxSessions: number;
  readonly maxOpenTickets: number;
  readonly previewTokenTtlMs: number;
  readonly logPollMs: number;
  readonly maxStreamMs: number;
}

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const DAY = 86_400_000;

/**
 * The range of every numeric setting (inclusive). A setting outside its
 * range is `invalid` when the sandbox is built; see the README's
 * "Settings and units".
 */
export const SETTING_LIMITS = {
  maxOutputBytes: { min: 1, max: 256 * MiB },
  outputLimitBytes: { min: 1, max: 256 * MiB },
  maxFileBytes: { min: 1, max: 256 * MiB },
  maxStreamFileBytes: { min: 1, max: 16 * GiB },
  maxProcesses: { min: 1, max: 1024 },
  processLogBytes: { min: 1, max: GiB },
  keptLogBytes: { min: 1, max: MiB },
  maxArgvBytes: { min: 1, max: MiB },
  maxEnvBytes: { min: 1, max: MiB },
  maxStdinBytes: { min: 1, max: 256 * MiB },
  maxTicketBytes: { min: 1, max: 16 * MiB },
  maxFinishedRecords: { min: 1, max: 10_000 },
  recordTtlMs: { min: 1, max: 30 * DAY },
  maxSessions: { min: 1, max: 4096 },
  maxOpenTickets: { min: 1, max: 4096 },
  previewTokenTtlMs: { min: 1, max: 30 * DAY },
  /** `execTimeout` and `maxExecTimeout`, in ms. */
  execTimeoutMs: { min: 1, max: 6 * 3_600_000 },
  /** `logPollInterval`, in ms. */
  logPollMs: { min: 10, max: 60_000 },
  /** `maxStream`, in ms. */
  maxStreamMs: { min: 1_000, max: DAY },
} as const;

for (const limit of Object.values(SETTING_LIMITS)) Object.freeze(limit);
Object.freeze(SETTING_LIMITS);

type Limited = keyof typeof SETTING_LIMITS;

// A numeric setting (or its default), checked against its range.
function limited(value: number | undefined, fallback: number, name: Limited) {
  try {
    return safeInt(value ?? fallback, { name, ...SETTING_LIMITS[name] });
  } catch (error) {
    throw new SandboxError("invalid", (error as Error).message);
  }
}

// A duration setting (a string with a unit), checked after conversion.
function timing(
  value: Duration | undefined,
  fallback: Duration,
  name: string,
  range: Limited,
): number {
  try {
    return durationMs(value ?? fallback, { name, ...SETTING_LIMITS[range] });
  } catch (error) {
    throw new SandboxError("invalid", (error as Error).message);
  }
}

/** Applies the defaults and checks the settings. */
export function resolveSettings(
  settings: SandboxSettings,
): ResolvedSettings {
  strictRecord(settings, [
    "tier",
    "sweepEscapes",
    "workspace",
    "stateDir",
    "user",
    "setupUser",
    "baseEnv",
    "cleanEnv",
    "envCommand",
    "shell",
    "execTimeout",
    "maxExecTimeout",
    "maxOutputBytes",
    "outputLimitBytes",
    "maxFileBytes",
    "maxStreamFileBytes",
    "maxProcesses",
    "processLogBytes",
    "keptLogBytes",
    "maxArgvBytes",
    "maxEnvBytes",
    "maxStdinBytes",
    "maxTicketBytes",
    "maxFinishedRecords",
    "recordTtlMs",
    "maxSessions",
    "maxOpenTickets",
    "previewTokenTtlMs",
    "logPollInterval",
    "maxStream",
  ], "settings");
  for (const [name, value] of Object.entries(settings)) {
    if (value === null && name !== "user" && name !== "setupUser") {
      throw new SandboxError("invalid", `${name} must not be null`);
    }
  }
  for (const name of ["cleanEnv", "sweepEscapes"] as const) {
    if (settings[name] !== undefined && typeof settings[name] !== "boolean") {
      throw new SandboxError("invalid", `${name} must be a boolean`);
    }
  }
  for (const name of ["user", "setupUser"] as const) {
    const value = settings[name];
    if (
      value !== undefined && value !== null &&
      (typeof value !== "string" ||
        !/^[0-9]{1,10}(?::[0-9]{1,10})?$/.test(value) ||
        value.split(":").some((part) => Number(part) > 4294967294))
    ) {
      throw new SandboxError(
        "invalid",
        `${name} must be a numeric uid[:gid] or null`,
      );
    }
  }
  const workspace = checkDirectory(
    settings.workspace ?? "/workspace",
    "workspace",
  );
  const stateDir = checkDirectory(
    settings.stateDir ?? "/tmp/.celld-sandbox",
    "stateDir",
  );
  const inside = (path: string, root: string) =>
    path === root || path.startsWith(`${root}/`);
  if (inside(stateDir, workspace) || inside(workspace, stateDir)) {
    throw new SandboxError(
      "invalid",
      "workspace and stateDir must be disjoint directories",
    );
  }
  // HOME is outside the workspace, so nothing the file API writes (a
  // `.gitconfig`, a `.profile`) is read by the tools commands run.
  const baseEnv = settings.baseEnv ?? {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: `${stateDir}/home`,
    LANG: "C.UTF-8",
  };
  strictRecord(baseEnv, undefined, "baseEnv");
  parse(schema.Env, baseEnv, "baseEnv");
  const shell = settings.shell ?? ["/bin/sh", "-c"];
  if (Array.isArray(shell)) {
    const descriptors = Object.getOwnPropertyDescriptors(shell);
    if (
      Object.getPrototypeOf(shell) !== Array.prototype ||
      Reflect.ownKeys(descriptors).some((name) =>
        typeof name !== "string" ||
        (name !== "length" &&
          (!/^(0|[1-9][0-9]*)$/.test(name) || !("value" in descriptors[name])))
      ) || Object.keys(descriptors).length !== shell.length + 1
    ) {
      throw new SandboxError(
        "invalid",
        "shell must be a dense plain array without accessors or extra properties",
      );
    }
  }
  if (
    !Array.isArray(shell) || shell.length === 0 ||
    shell.some((arg) => typeof arg !== "string" || /[\0\r\n]/.test(arg)) ||
    !shell[0].startsWith("/")
  ) {
    throw new SandboxError("invalid", "shell must name a program");
  }
  const maxArgvBytes = limited(
    settings.maxArgvBytes,
    256 * 1024,
    "maxArgvBytes",
  );
  const maxEnvBytes = limited(settings.maxEnvBytes, 256 * 1024, "maxEnvBytes");
  if (maxArgvBytes + maxEnvBytes > MiB) {
    throw new SandboxError(
      "invalid",
      "maxArgvBytes and maxEnvBytes may add up to at most 1 MiB (below ARG_MAX)",
    );
  }
  // baseEnv is a layer of every command's environment, so it is held to
  // the same cap; the wrappers repeat only its PATH.
  const baseBytes = envBytes(baseEnv);
  if (baseBytes > maxEnvBytes) {
    throw new SandboxError(
      "invalid",
      `baseEnv has ${baseBytes} bytes, more than maxEnvBytes (${maxEnvBytes})`,
    );
  }
  const tier = settings.tier;
  if (tier !== "trusted" && tier !== "hostile") {
    throw new SandboxError("invalid", 'tier must be "trusted" or "hostile"');
  }
  const envCommand = checkDirectory(
    settings.envCommand ?? "/usr/bin/env",
    "envCommand",
  );
  if (settings.cleanEnv !== false) {
    if (
      baseEnv.HOME === undefined ||
      inside(checkDirectory(baseEnv.HOME, "HOME"), workspace)
    ) {
      throw new SandboxError(
        "invalid",
        "clean environments need HOME outside the workspace",
      );
    }
    for (const path of (baseEnv.PATH ?? "").split(":")) {
      const canonical = checkDirectory(path, "PATH entry");
      if (
        !path || inside(canonical, workspace) || inside(canonical, stateDir) ||
        (tier === "hostile" &&
          ![
            "/usr/local/sbin",
            "/usr/local/bin",
            "/usr/sbin",
            "/usr/bin",
            "/sbin",
            "/bin",
          ].includes(canonical))
      ) {
        throw new SandboxError(
          "invalid",
          "PATH entries must be absolute and outside workspace/stateDir",
        );
      }
    }
    for (const path of [shell[0], envCommand]) {
      const canonical = checkDirectory(path, "helper path");
      if (inside(canonical, workspace) || inside(canonical, stateDir)) {
        throw new SandboxError(
          "invalid",
          "helper binaries must be outside workspace/stateDir",
        );
      }
    }
  }
  if (
    tier === "hostile" &&
    (settings.cleanEnv === false || settings.sweepEscapes === false ||
      settings.user === null ||
      /^(?:0+)(?::|$)/.test(settings.user ?? "1000") ||
      shell[0] !== "/bin/sh" || shell.length !== 2 || shell[1] !== "-c" ||
      envCommand !== "/usr/bin/env")
  ) {
    throw new SandboxError(
      "invalid",
      "hostile settings require cleanEnv, sweepEscapes, a non-root uid, and pinned /bin/sh and /usr/bin/env helpers",
    );
  }
  if (
    settings.sweepEscapes !== undefined &&
    typeof settings.sweepEscapes !== "boolean"
  ) {
    throw new SandboxError("invalid", "sweepEscapes must be a boolean");
  }
  const maxExecTimeoutMs = timing(
    settings.maxExecTimeout,
    "10m",
    "maxExecTimeout",
    "execTimeoutMs",
  );
  // The default deadline is 30 s, or the longest allowed when that is less.
  const execTimeoutMs = settings.execTimeout === undefined
    ? Math.min(30_000, maxExecTimeoutMs)
    : timing(settings.execTimeout, "30s", "execTimeout", "execTimeoutMs");
  if (execTimeoutMs > maxExecTimeoutMs) {
    throw new SandboxError(
      "invalid",
      "execTimeout must not be longer than maxExecTimeout",
    );
  }
  const outputLimitBytes = limited(
    settings.outputLimitBytes,
    16 * MiB,
    "outputLimitBytes",
  );
  const maxOutputBytes = limited(
    settings.maxOutputBytes,
    MiB,
    "maxOutputBytes",
  );
  if (maxOutputBytes > outputLimitBytes) {
    throw new SandboxError(
      "invalid",
      "maxOutputBytes must not be more than outputLimitBytes",
    );
  }
  return Object.freeze({
    tier,
    sweepEscapes: settings.sweepEscapes ?? tier === "hostile",
    workspace,
    stateDir,
    user: settings.user === null ? undefined : settings.user ?? "1000:1000",
    setupUser: settings.setupUser === null
      ? undefined
      : settings.setupUser ?? "0",
    baseEnv: Object.freeze({ ...baseEnv }),
    cleanEnv: settings.cleanEnv ?? true,
    envCommand,
    shell: Object.freeze([...shell]),
    execTimeoutMs,
    maxExecTimeoutMs,
    maxOutputBytes,
    maxArgvBytes,
    maxEnvBytes,
    maxStdinBytes: limited(settings.maxStdinBytes, 8 * MiB, "maxStdinBytes"),
    maxTicketBytes: limited(settings.maxTicketBytes, MiB, "maxTicketBytes"),
    outputLimitBytes,
    maxFileBytes: limited(settings.maxFileBytes, 32 * MiB, "maxFileBytes"),
    maxStreamFileBytes: limited(
      settings.maxStreamFileBytes,
      GiB,
      "maxStreamFileBytes",
    ),
    maxProcesses: limited(settings.maxProcesses, 32, "maxProcesses"),
    processLogBytes: limited(
      settings.processLogBytes,
      16 * MiB,
      "processLogBytes",
    ),
    keptLogBytes: limited(settings.keptLogBytes, 64 * 1024, "keptLogBytes"),
    maxFinishedRecords: limited(
      settings.maxFinishedRecords,
      200,
      "maxFinishedRecords",
    ),
    recordTtlMs: limited(settings.recordTtlMs, DAY, "recordTtlMs"),
    maxSessions: limited(settings.maxSessions, 64, "maxSessions"),
    maxOpenTickets: limited(settings.maxOpenTickets, 32, "maxOpenTickets"),
    previewTokenTtlMs: limited(
      settings.previewTokenTtlMs,
      15 * 60_000,
      "previewTokenTtlMs",
    ),
    logPollMs: timing(
      settings.logPollInterval,
      "250ms",
      "logPollInterval",
      "logPollMs",
    ),
    maxStreamMs: timing(settings.maxStream, "15m", "maxStream", "maxStreamMs"),
  });
}

/** Rejects accessors and inherited configuration before reading any field. */
export function strictRecord(
  value: unknown,
  keys: readonly string[] | undefined,
  name: string,
): void {
  try {
    checkRecord(
      value,
      keys ??
        (typeof value === "object" && value !== null ? Object.keys(value) : []),
      name,
    );
  } catch {
    throw new SandboxError(
      "invalid",
      `${name} must be a plain object with known data fields`,
    );
  }
}

const KEYS = {
  env: "celld.sandbox/env",
  prepared: "celld.sandbox/prepared",
  ports: "celld.sandbox/ports",
  process: "celld.sandbox/process/",
  /** The ids of the records whose status is `running`. */
  running: "celld.sandbox/running",
  /** `[id, endedAt]` of the finished records, in the order they ended. */
  finished: "celld.sandbox/finished",
  session: "celld.sandbox/session/",
  ticket: "celld.sandbox/ticket/",
  lease: "celld.sandbox/lease/",
};

/** The most leases held at once in one sandbox. */
export const MAX_LEASES = 64;
/**
 * The lease the sandbox enforces: while someone holds it, every mutating
 * call must name it (`lease: token`) or fails with `lease_held`. See
 * {@link SandboxCore.acquireLease}.
 */
export const WORKSPACE_LEASE = "workspace";
/** The most ports with a live preview token at once in one sandbox. */
export const MAX_EXPOSED_PORTS = 64;
/** The default cap of {@link readAll}: 16 MiB. */
export const READ_ALL_MAX_BYTES = 16 * 1024 * 1024;
/** A lease's lifetime unless `ttlMs` says otherwise. */
export const DEFAULT_LEASE_TTL_MS = 30_000;

interface LeaseRecord {
  token: string;
  expires: number;
}

// An operation in flight, so `destroy()` and a new holder of the workspace
// lease can stop it: `mutating` ones are fenced by the lease, all of them
// by `destroy()`.
interface InFlight {
  readonly mutating: boolean;
  readonly lease: string | undefined;
  readonly stop: AbortController;
  readonly done: Promise<void>;
  readonly finish: () => void;
}

const TICKET_MS = 60_000;
// The message of a stream's 5xx `error` event (see `stream`).
const STREAM_FAILED = "the sandbox could not complete the request";
const NOT_YET = /no such container|is not running|not running/i;
const SCRIPT_OUTPUT = 16 * MiB;
const LOG_CHUNK = 64 * 1024;
// Bytes of a streamed file read held for its reader.
const READ_QUEUE = 1024 * 1024;

interface ProcessRecord {
  id: string;
  name: string | null;
  pid: number;
  /** The session its supervisor stays in (see SWEEP); 0 when unknown. */
  sid?: number;
  /** Start times (clock ticks) of `pid` and `sid`, 0 when unknown. */
  pidStart?: number;
  sidStart?: number;
  command: string[];
  cwd: string;
  status: ProcessStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  generation: number;
  killRequested: boolean;
  mutates?: boolean;
  lease?: string;
  tail: {
    stdout: Uint8Array;
    stderr: Uint8Array;
    truncated: boolean;
    /** The streams' full sizes when the tail was taken. */
    sizeOut?: number;
    sizeErr?: number;
  } | null;
}

interface TicketRecord {
  request: StreamRequest;
  expires: number;
}

// An exposed port as stored: times are Unix milliseconds. A record
// without `expiresAt` predates expiry (and had an 80-bit token): it is
// treated as expired.
interface PortRecord {
  rotatedFrom?: string;
  port: number;
  name: string | null;
  token: string;
  createdAt: number;
  rotatedAt: number | null;
  expiresAt: number;
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

/** The longest token {@link randomToken} makes. */
export const MAX_TOKEN_LENGTH = 256;

/**
 * `length` random characters of a 32-letter lowercase alphabet (base32,
 * 5 bits each, unbiased because 32 divides 256): 26 of them carry 130
 * bits. `length` must be an integer from 1 to {@link MAX_TOKEN_LENGTH}.
 *
 * @throws {RangeError} for any other length.
 */
export function randomToken(length: number): string {
  if (
    !Number.isInteger(length) || length < 1 || length > MAX_TOKEN_LENGTH
  ) {
    throw new RangeError(
      `a token length must be an integer from 1 to ${MAX_TOKEN_LENGTH}, got ${length}`,
    );
  }
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((byte) => TOKEN_ALPHABET[byte % 32]).join("");
}

/** Characters of a preview token: 26 base32 letters, 130 bits. */
export const PREVIEW_TOKEN_LENGTH = 26;

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

// Bytes of an argv as the kernel counts them: each argument and its NUL.
function argvBytes(argv: readonly string[]): number {
  let total = 0;
  for (const arg of argv) total += utf8Length(arg) + 1;
  return total;
}

// Bytes of an environment as `env -i` arguments: `NAME=value` and a NUL.
function envBytes(env: Readonly<Record<string, string>>): number {
  let total = 0;
  for (const [name, value] of Object.entries(env)) {
    total += utf8Length(name) + utf8Length(value) + 2;
  }
  return total;
}

// A generous estimate of what a checked request costs to store.
function storedBytes(value: unknown): number {
  if (typeof value === "string") return utf8Length(value) + 2;
  if (value instanceof Uint8Array) return value.byteLength;
  if (Array.isArray(value)) {
    return value.reduce((sum: number, item) => sum + storedBytes(item), 2);
  }
  if (value !== null && typeof value === "object") {
    let total = 2;
    for (const [key, item] of Object.entries(value)) {
      total += utf8Length(key) + 3 + storedBytes(item);
    }
    return total;
  }
  return 8;
}

// `body`, erroring (and calling `over`) once more than `max` bytes pass.
function capped(
  body: ReadableStream<Uint8Array>,
  max: number,
  over: () => void,
): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) {
          over();
          controller.error(new SandboxError("too_large", "stdin is too large"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

// One signal that aborts when any of `signals` does.
function anySignal(
  signals: readonly (AbortSignal | undefined)[],
): AbortSignal | undefined {
  const present = signals.filter((signal) => signal !== undefined);
  if (present.length <= 1) return present[0];
  return AbortSignal.any(present);
}

const PRE_CANCELLED = 64;

// A listing cursor: `SKIP`, or `SKIP.ANCHOR` where ANCHOR is the base64url
// of `COUNT\nLINE`, the last entry's run of LIST lines (see listFiles).
function makeCursor(
  skip: number,
  anchor: { path: string; count: number } | undefined,
): string {
  if (anchor === undefined) return String(skip);
  const bytes = encoder.encode(`${anchor.count}\n${anchor.path}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/, "");
  return `${skip}.${encoded}`;
}

function readCursor(
  cursor: string | undefined,
): { skip: number; anchor: { count: number; line: string } | null } {
  if (cursor === undefined) return { skip: 0, anchor: null };
  const [head, tail] = cursor.split(".");
  const skip = Number(head);
  if (tail === undefined) return { skip, anchor: null };
  let text: string;
  try {
    const binary = atob(tail.replaceAll("-", "+").replaceAll("_", "/"));
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (char) => char.charCodeAt(0)),
    );
  } catch {
    throw new SandboxError("invalid", "cursor: not a cursor from listFiles");
  }
  const newline = text.indexOf("\n");
  const count = Number(text.slice(0, newline));
  if (
    newline < 0 || !Number.isInteger(count) || count < 1 || count > 4 ||
    count > skip
  ) {
    throw new SandboxError("invalid", "cursor: not a cursor from listFiles");
  }
  return { skip, anchor: { count, line: text.slice(newline + 1) } };
}

// Runs a synchronous body so that a throw becomes a rejection.
function settle<T>(body: () => T): Promise<Awaited<T>> {
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
  #preparing: { generation: number; promise: Promise<void> } | null = null;
  // Operations in flight that destroy() or a new workspace lease stops.
  readonly #inflight = new Set<InFlight>();
  #handoff = false;
  #unavailable = false;
  // Execs in flight by cancel token, and tokens cancelled before their
  // exec arrived (with when they are forgotten).
  readonly #cancels = new Map<string, AbortController>();
  readonly #preCancelled = new Map<string, number>();
  // Slots taken by commands being started or run in the foreground; the
  // running background processes are the running index.
  #reserved = 0;
  // Incremented by every `destroy()`: work that began before it may not
  // write the state the destroy wiped.
  #epoch = 0;

  constructor(
    controller: ContainerController,
    kv: SyncKv,
    settings: SandboxSettings,
    ids: () => string = monotonicFactory(),
  ) {
    this.#controller = controller;
    this.#kv = kv;
    this.#s = resolveSettings(settings);
    this.#ids = ids;
    // Expired tickets and records are purged on the object's alarm.
    controller.addWakeSource(() => this.#nextExpiry());
  }

  /** The settings with defaults applied. */
  get settings(): ResolvedSettings {
    return this.#s;
  }

  get #native(): NativeContainer {
    return this.#controller.native;
  }

  // MARK: Lifecycle

  /**
   * Starts the container if needed and prepares the workspace once per
   * start. A call that was waiting here when `destroy()` ran fails with
   * `cancelled` instead of going on in the next container generation.
   */
  async ready(): Promise<void> {
    if (this.#unavailable) {
      throw new SandboxError(
        "not_running",
        "the sandbox requires destroy after failed containment",
      );
    }
    const epoch = this.#epoch;
    for (;;) {
      await this.#controller.ensureRunning();
      this.#sameEpoch(epoch);
      const generation = this.#controller.generation;
      if (this.#kv.get<number>(KEYS.prepared) === generation) return;
      let current = this.#preparing;
      if (current !== null && current.generation !== generation) {
        // A preparation of an earlier container: it proves nothing here.
        await current.promise.catch(() => {});
        this.#sameEpoch(epoch);
        continue;
      }
      if (current === null) {
        const entry = {
          generation,
          promise: this.#controller.busy(() => this.#prepare(generation)),
        };
        const clear = () => {
          if (this.#preparing === entry) this.#preparing = null;
        };
        entry.promise.then(clear, clear);
        this.#preparing = current = entry;
      }
      try {
        await current.promise;
      } catch (error) {
        this.#sameEpoch(epoch);
        // The container was replaced while it was prepared: prepare the
        // new one.
        if (this.#controller.generation !== generation) continue;
        throw error;
      }
      this.#sameEpoch(epoch);
    }
  }

  #sameEpoch(epoch: number): void {
    if (this.#epoch !== epoch) {
      throw new SandboxError(
        "cancelled",
        "the sandbox was destroyed while this call waited for it",
      );
    }
  }

  async #prepare(generation: number): Promise<void> {
    const s = this.#s;
    const epoch = this.#epoch;
    // Nothing of an earlier generation, or of a sandbox destroy() ended,
    // is carried on into the container that replaced it.
    const current = () => {
      this.#sameEpoch(epoch);
      if (this.#controller.generation !== generation) {
        throw new SandboxError(
          "not_running",
          "the container was replaced while it was being prepared",
        );
      }
    };
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
        current();
        const message = error instanceof Error ? error.message : String(error);
        if (!NOT_YET.test(message) || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
        current();
      }
    }
    current();
    if (s.tier === "hostile") {
      try {
        await this.#checkRuntime();
      } catch (error) {
        await this.#controller.destroy();
        throw error;
      }
    }
    // MKDIRS also refuses an image without `setsid` (unsupported_image).
    await this.#script(MKDIRS, [
      `${s.stateDir}/proc`,
      `${s.stateDir}/run`,
      `${s.stateDir}/home`,
    ]);
    current();
    for (const id of this.#runningIds()) {
      const record = this.#kv.get<ProcessRecord>(KEYS.process + id);
      if (record === undefined) continue;
      if (record.status === "running" && record.generation !== generation) {
        this.#finish(record, "lost", null);
      }
    }
    this.#kv.put(KEYS.prepared, generation);
  }

  // The hostile tier runs only on gVisor; any other runtime is refused
  // before a single command of the caller's runs.
  async #checkRuntime(): Promise<void> {
    const raw = await this.#script(RUNTIME, [], { timeoutMs: 10_000 });
    if (decode(raw.stdout).trim() !== "gvisor") {
      throw new SandboxError(
        "unsafe_runtime",
        'tier "hostile" could not verify gVisor: declare the container with "runtime": "runsc" (and install runsc on every node that serves it); check that the trusted image provides /bin/dmesg, /bin/head and /bin/grep and permits the sandbox user to read the gVisor kernel log',
      );
    }
  }

  getState(): ContainerState {
    return this.#controller.state();
  }

  async stop(signal = 15): Promise<void> {
    await this.#controller.stop("stop", signal);
  }

  /**
   * Destroys the sandbox: forgets everything the object stores for it
   * (environment, sessions, exposed ports and their preview tokens, stream
   * tickets, process records and their indexes) and then destroys the
   * container. The state goes first, in one synchronous step, so from the
   * moment this is called no old token or ticket is honoured, and nothing
   * of the old sandbox reaches the next container generation. To stop the
   * container and keep the state, use {@link destroyContainer}.
   */
  async destroy(): Promise<void> {
    this.#forget();
    await this.#controller.destroy();
    this.#unavailable = false;
  }

  /**
   * Destroys the container only (SIGKILL). Environment, sessions, exposed
   * ports with their tokens, tickets and process records stay, so the next
   * call starts a new container generation with them: an exposed port's
   * token still reaches it. Use {@link destroy} to end the sandbox.
   */
  async destroyContainer(): Promise<void> {
    await this.#controller.destroy();
  }

  // Deletes every key of the sandbox's own, synchronously (no await, so
  // no other event sees half of it), and every in-memory token, and stops
  // every operation in flight.
  #forget(): void {
    const keys = [
      ...this.#kv.list({ prefix: "celld.sandbox/" }),
    ].map(([key]) => key);
    for (const key of keys) this.#kv.delete(key);
    this.#epoch += 1;
    const destroyed = new SandboxError(
      "cancelled",
      "the sandbox was destroyed",
    );
    for (const running of this.#cancels.values()) running.abort(destroyed);
    this.#cancels.clear();
    this.#preCancelled.clear();
    for (const operation of this.#inflight) operation.stop.abort(destroyed);
    this.#inflight.clear();
  }

  // MARK: The workspace lease

  // Refuses a mutation while another caller holds the workspace lease, or
  // when the lease it names is no longer held. Synchronous, so the check
  // and the registration that follows it are one step.
  #checkLease(lease: string | undefined): void {
    if (this.#unavailable) {
      throw new SandboxError(
        "not_running",
        "the sandbox requires destroy after failed containment",
      );
    }
    if (this.#handoff) {
      throw new SandboxError(
        lease === undefined ? "lease_held" : "lease_lost",
        "workspace lease handoff is pending",
      );
    }
    const held = this.#kv.get<LeaseRecord>(KEYS.lease + WORKSPACE_LEASE);
    const live = held !== undefined && held.expires > Date.now();
    if (lease === undefined) {
      if (!live) return;
      throw new SandboxError(
        "lease_held",
        `another caller holds the "${WORKSPACE_LEASE}" lease; pass its token as \`lease\`, or wait for it`,
      );
    }
    if (live && sameToken(held.token, lease)) return;
    // A token that is not the live one names a lease this caller lost,
    // whether or not another caller holds it now.
    throw new SandboxError(
      "lease_lost",
      live
        ? `the "${WORKSPACE_LEASE}" lease this call names is no longer held; another caller holds it now`
        : `the "${WORKSPACE_LEASE}" lease this call names has expired or was released`,
    );
  }

  // Registers an operation; a mutating one is checked against the
  // workspace lease first. Call `#end` when it is over.
  #begin(lease: string | undefined, mutating: boolean): InFlight {
    if (lease !== undefined) parse(schema.LeaseToken, lease, "lease");
    if (mutating) this.#checkLease(lease);
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const operation: InFlight = {
      mutating,
      lease,
      stop: new AbortController(),
      done,
      finish,
    };
    this.#inflight.add(operation);
    return operation;
  }

  #end(operation: InFlight): void {
    this.#inflight.delete(operation);
    operation.finish();
  }

  // A new holder of the workspace lease: every mutation in flight started
  // under no lease or an older one, and is stopped.
  #fenceMutations(): void {
    for (const operation of this.#inflight) {
      if (!operation.mutating) continue;
      operation.stop.abort(
        operation.lease === undefined
          ? new SandboxError(
            "lease_held",
            `another caller took the "${WORKSPACE_LEASE}" lease while this ran`,
          )
          : new SandboxError(
            "lease_lost",
            `the "${WORKSPACE_LEASE}" lease expired and another caller took it while this ran`,
          ),
      );
    }
  }

  // File helpers (including slow recursive operations) remain registered
  // until their process group, input and temporary-file cleanup have ended.
  async #mutate<T>(
    lease: string | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const operation = this.#begin(lease, true);
    try {
      await this.ready();
      operation.stop.signal.throwIfAborted();
      const result = await work(operation.stop.signal);
      operation.stop.signal.throwIfAborted();
      return result;
    } finally {
      this.#end(operation);
    }
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

  #checkArgv(argv: readonly string[]): void {
    const bytes = argvBytes(argv);
    if (bytes > this.#s.maxArgvBytes) {
      throw new SandboxError(
        "too_large",
        `the command's arguments have ${bytes} bytes, more than ${this.#s.maxArgvBytes}`,
      );
    }
  }

  #checkEnv(
    env: Readonly<Record<string, string>> | undefined,
    what: string,
  ): void {
    if (env === undefined) return;
    const bytes = envBytes(env);
    if (bytes > this.#s.maxEnvBytes) {
      throw new SandboxError(
        "too_large",
        `${what} has ${bytes} bytes, more than ${this.#s.maxEnvBytes}`,
      );
    }
  }

  #checkStdin(stdin: string | Uint8Array | undefined): void {
    if (stdin === undefined) return;
    const bytes = typeof stdin === "string"
      ? utf8Length(stdin)
      : stdin.byteLength;
    if (bytes > this.#s.maxStdinBytes) {
      throw new SandboxError(
        "too_large",
        `stdin has ${bytes} bytes, more than ${this.#s.maxStdinBytes}`,
      );
    }
  }

  // Everything an exec's own arguments can make too large, before any of
  // it is encoded, stored or run.
  #checkExec(argv: readonly string[], options: schema.ExecOptionsValue): void {
    this.#checkArgv(argv);
    this.#checkEnv(options.env, "the command's environment");
    this.#checkStdin(options.stdin);
  }

  // The argv and engine env for a command: `env -i NAME=value... argv` in
  // clean mode, so only the sandbox's variables reach it. The merged
  // environment and the argv are checked against their caps here, so no
  // path reaches the engine with more than Linux takes.
  #command(
    argv: readonly string[],
    env: Record<string, string>,
    internal = false,
  ): { argv: string[]; env: Record<string, string> | undefined } {
    // The sandbox's own wrappers and helpers carry a checked command or
    // short arguments of their own.
    if (!internal) {
      this.#checkArgv(argv);
      this.#checkEnv(env, "the merged environment");
    }
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
      collect?: boolean;
      signal?: AbortSignal;
      /** Exit statuses besides 0 that are answers, not failures. */
      accept?: readonly number[];
    } = {},
  ): Promise<RawResult> {
    const s = this.#s;
    const writeNonce = script === WRITE ? randomToken(20) : undefined;
    const actualArgs = writeNonce === undefined ? args : [...args, writeNonce];
    const command = this.#command(
      [s.shell[0], "-c", script, "celld-sandbox", ...actualArgs],
      { ...s.baseEnv },
      true,
    );
    const file = options.signal === undefined
      ? undefined
      : `${s.stateDir}/run/${randomToken(20)}`;
    const argv = file === undefined ? command.argv : [
      s.shell[0],
      "-c",
      RUN,
      "celld-sandbox",
      file,
      options.stdin === undefined ? "0" : "1",
      s.shell[0],
      ...command.argv,
    ];
    let raw: RawResult;
    let interrupted = true;
    try {
      raw = await runRaw(this.#native, argv, {
        env: command.env,
        user: "user" in options ? options.user : s.user,
        stdin: options.stdin,
        timeoutMs: options.timeoutMs ?? s.maxExecTimeoutMs,
        maxOutputBytes: options.maxOutputBytes ?? SCRIPT_OUTPUT,
        onChunk: options.onChunk,
        collect: options.collect,
        signal: options.signal,
        ...(file === undefined ? {} : {
          kill: () =>
            this.#script(KILLRUN, [file], { timeoutMs: 5_000 }).then(
              () => {},
            ),
          contain: () => this.#contain(),
        }),
      });
      interrupted = raw.cancelled || raw.timedOut;
    } finally {
      // Normal helper exits (including guard rejection) ran their EXIT trap.
      // Only interrupted transport needs an independent cleanup process.
      if (writeNonce !== undefined && interrupted) {
        await this.#script(WRITEUNDO, [args[0], args[1], writeNonce], {
          timeoutMs: 5_000,
        }).catch(async (error) => {
          await this.#contain();
          throw error;
        });
      }
    }
    if (raw.cancelled) {
      // A fence (destroy(), the workspace lease) says why.
      throw options.signal?.reason instanceof SandboxError
        ? options.signal.reason
        : new SandboxError("cancelled", "the operation was cancelled");
    }
    if (raw.timedOut) {
      throw new SandboxError(
        "timeout",
        "a sandbox helper command ran out of time",
      );
    }
    if (
      raw.exitCode !== 0 && !(options.accept ?? []).includes(raw.exitCode ?? -1)
    ) {
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

  // Every foreground command. `extra.operation` is an operation the
  // caller registered already (a stream redeemed before it runs); without
  // one, the command registers its own here, in the same synchronous step
  // as its lease check. `mutating` defaults to `options.mutates`.
  async #exec(
    argv: readonly string[],
    options: schema.ExecOptionsValue,
    extra: {
      emit?: (event: ExecEvent) => Promise<void>;
      signal?: AbortSignal;
      stdinStream?: ReadableStream<Uint8Array>;
      exactEnv?: Record<string, string>;
      operation?: InFlight;
      mutating?: boolean;
    } = {},
  ): Promise<ExecResult> {
    let operation = extra.operation;
    let cancelled: string | undefined;
    try {
      this.#checkExec(argv, options);
      const token = options.cancelToken;
      if (token !== undefined) {
        if (this.#cancels.has(token)) {
          throw new SandboxError("invalid", "that cancel token is in use");
        }
        if (this.#preCancelled.delete(token)) {
          throw new SandboxError("cancelled", "the command was cancelled");
        }
      }
      operation ??= this.#begin(
        options.lease,
        extra.mutating ?? options.mutates !== false,
      );
      let cancel: AbortController | undefined;
      if (token !== undefined) {
        cancel = new AbortController();
        this.#cancels.set(token, cancel);
        cancelled = token;
      }
      const merged = anySignal([
        options.signal as AbortSignal | undefined,
        cancel?.signal,
        extra.signal,
        operation.stop.signal,
      ]);
      if (merged?.aborted) {
        throw merged.reason instanceof SandboxError
          ? merged.reason
          : new SandboxError("cancelled", "the command was cancelled");
      }
      await this.ready();
      return await this.#controller.busy(() =>
        this.#run(
          argv,
          options,
          extra.emit,
          merged,
          extra.stdinStream,
          extra.exactEnv,
        )
      );
    } finally {
      if (cancelled !== undefined) this.#cancels.delete(cancelled);
      if (operation !== undefined) this.#end(operation);
    }
  }

  async #run(
    argv: readonly string[],
    options: schema.ExecOptionsValue,
    emit?: (event: ExecEvent) => Promise<void>,
    signal?: AbortSignal,
    stdinStream?: ReadableStream<Uint8Array>,
    exactEnv?: Record<string, string>,
  ): Promise<ExecResult> {
    const s = this.#s;
    const session = this.#session(options.sessionId);
    const cwd = this.#cwd(options.cwd, session);
    const command = this.#command(
      argv,
      exactEnv ?? this.#env(options.env, session),
    );
    const release = await this.#acquire();
    // The command runs under RUN, in its own process group, which the
    // deadline, a cancellation and its own exit kill as a whole. RUN itself
    // needs only PATH: the base environment is not sent twice (see
    // maxArgvBytes).
    const file = `${s.stateDir}/run/${randomToken(20)}`;
    const wrapped = this.#command(
      [
        s.shell[0],
        "-c",
        RUN,
        "celld-sandbox",
        file,
        options.stdin === undefined && stdinStream === undefined ? "0" : "1",
        s.shell[0],
        ...command.argv,
      ],
      command.env ??
        (s.baseEnv.PATH === undefined ? {} : { PATH: s.baseEnv.PATH }),
      true,
    );
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    let raw: RawResult;
    try {
      raw = await runRaw(this.#native, wrapped.argv, {
        cwd,
        env: wrapped.env,
        user: s.user,
        stdin: stdinStream ??
          (typeof options.stdin === "string"
            ? encoder.encode(options.stdin)
            : options.stdin),
        timeoutMs: this.#timeout(options.timeoutMs),
        maxOutputBytes: Math.min(
          options.maxOutputBytes ?? s.maxOutputBytes,
          s.outputLimitBytes,
        ),
        combine: options.combineOutput,
        signal,
        kill: async () => {
          await this.#script(KILLRUN, [file], { timeoutMs: 5_000 });
        },
        contain: () => this.#contain(),
        ...(emit === undefined ? {} : {
          onStart: (pid: number) => emit({ type: "start", pid }),
          onChunk: async (stream: "stdout" | "stderr", bytes: Uint8Array) => {
            const data = decoders[stream].decode(bytes, { stream: true });
            if (data !== "") await emit({ type: stream, data });
          },
        }),
      });
    } finally {
      release();
      await this.#sweep();
    }
    if (raw.cancelled) {
      // A limit that ended the run says so; anything else is a cancellation.
      throw signal?.reason instanceof SandboxError
        ? signal.reason
        : new SandboxError("cancelled", "the command was cancelled");
    }
    if (
      raw.exitCode === RUN_UNRECORDED &&
      decode(options.combineOutput ? raw.stdout : raw.stderr).includes(
        RUN_UNRECORDED_MESSAGE,
      )
    ) {
      throw new SandboxError(
        "command_failed",
        "the command's process group could not be recorded (is the state directory writable, and does the image have setsid?); it did not run",
      );
    }
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

  // MARK: Process slots

  // The ids of running background records, from their index (built once
  // from the records for storage written before the index existed).
  #runningIds(): string[] {
    let ids = this.#kv.get<string[]>(KEYS.running);
    if (ids === undefined) {
      ids = [];
      for (
        const [, record] of this.#kv.list<ProcessRecord>({
          prefix: KEYS.process,
        })
      ) {
        if (record.status === "running") ids.push(record.id);
      }
      this.#kv.put(KEYS.running, ids);
    }
    return ids;
  }

  #tryReserve(): boolean {
    if (this.#reserved + this.#runningIds().length >= this.#s.maxProcesses) {
      return false;
    }
    this.#reserved += 1;
    return true;
  }

  // Takes a slot for one command, atomically (the check and the count
  // happen in one synchronous step); answers the function that gives it
  // back. At the limit, running records are refreshed once, since some may
  // have ended unnoticed.
  async #acquire(): Promise<() => void> {
    if (!this.#tryReserve()) {
      for (const id of [...this.#runningIds()]) {
        const record = this.#kv.get<ProcessRecord>(KEYS.process + id);
        if (record === undefined) {
          this.#unindex(id);
        } else {
          await this.#refreshed(record);
        }
      }
      if (!this.#tryReserve()) {
        const running = this.#runningIds().length;
        throw new SandboxError(
          "too_many_processes",
          `${
            this.#reserved + running
          } commands are running (${running} in the background), the limit is ${this.#s.maxProcesses}`,
        );
      }
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#reserved -= 1;
    };
  }

  #unindex(id: string): void {
    const ids = this.#runningIds();
    const at = ids.indexOf(id);
    if (at < 0) return;
    ids.splice(at, 1);
    this.#kv.put(KEYS.running, ids);
  }

  // With `sweepEscapes`: kills what left its command's session, and
  // destroys the container when something survives that.
  async #sweep(): Promise<void> {
    if (!this.#s.sweepEscapes || !this.#controller.native.running) return;
    // Each running record's sessions, with the start time of the process
    // that owns the id: a pid used again by another process does not
    // match (see SWEEP), so a stale record allows nothing new.
    const sessions: string[] = [];
    for (const id of this.#runningIds()) {
      const record = this.#kv.get<ProcessRecord>(KEYS.process + id);
      if (record === undefined) continue;
      sessions.push(`${record.pid}:${record.pidStart ?? 0}`);
      if (record.sid) sessions.push(`${record.sid}:${record.sidStart ?? 0}`);
    }
    const s = this.#s;
    const command = this.#command(
      [s.shell[0], "-c", SWEEP, "celld-sandbox", "/proc", ...sessions],
      { ...s.baseEnv },
      true,
    );
    let survived = false;
    try {
      const raw = await runRaw(this.#native, command.argv, {
        env: command.env,
        user: s.user,
        timeoutMs: 10_000,
        maxOutputBytes: 64 * 1024,
      });
      survived = raw.exitCode !== 0;
    } catch {
      survived = true;
    }
    if (survived) await this.#controller.destroy();
  }

  // A command was ended early but its group kill was not confirmed (the
  // kill failed, or hung past its bound): its processes may still run.
  // Destroying the container is the one kill that cannot miss, so it
  // happens before the call reports the command stopped.
  async #contain(): Promise<void> {
    try {
      await this.#controller.destroy();
    } catch (error) {
      this.#unavailable = true;
      throw new SandboxError(
        "command_failed",
        `the command could not be stopped: its process group kill was not confirmed and destroying the container failed (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
  }

  #timeout(requested: number | undefined): number {
    return Math.min(
      requested ?? this.#s.execTimeoutMs,
      this.#s.maxExecTimeoutMs,
    );
  }

  /**
   * Cancels the exec that was started with `cancelToken: token`, killing
   * its process group; that call then fails with `cancelled`. Answers false
   * when no such exec runs; the token is then remembered for a minute, so
   * an exec that arrives after its own cancellation fails at once.
   */
  cancel(token: string): Promise<boolean> {
    return settle(() => {
      const key = parse(schema.CancelToken, token, "token");
      const running = this.#cancels.get(key);
      if (running !== undefined) {
        running.abort(new SandboxError("cancelled", "cancelled"));
        return true;
      }
      const now = Date.now();
      for (const [old, expires] of this.#preCancelled) {
        if (expires < now) this.#preCancelled.delete(old);
      }
      if (this.#preCancelled.size >= PRE_CANCELLED) {
        const oldest = this.#preCancelled.keys().next().value!;
        this.#preCancelled.delete(oldest);
      }
      this.#preCancelled.set(key, now + 60_000);
      return false;
    });
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
   * Clones an https repository of a public host into a new directory of
   * the workspace with `git` (which the image must have, with Internet
   * egress enabled).
   *
   * The target (default the repository's name) must not exist: it is
   * created here, entered, and cloned into, so neither an existing
   * directory nor a symbolic link can redirect the clone. Git runs with
   * the base environment only (not `setEnvVars` or session variables),
   * reads no system or global configuration, and runs no hooks, credential
   * helpers or filters and no transport but https; it does not follow
   * redirects. Symbolic links in the repository are checked out as plain
   * files holding the link's text, so no path of the checkout leads out of
   * it (`unsafeSymlinks: true` checks them out as links). A clone that
   * fails, runs out of time or is cancelled leaves no directory behind.
   * It is a mutation: while another caller holds the workspace lease it
   * needs `lease`.
   */
  async gitCheckout(
    url: string,
    options: GitCheckoutOptions = {},
  ): Promise<ExecResult> {
    const repository = parse(schema.GitUrl, url, "url");
    const parsed = new URL(repository);
    const host = classifyHost(parsed.hostname);
    if (
      parsed.protocol !== "https:" || parsed.username !== "" ||
      parsed.password !== "" || (host !== "public" && host !== "name")
    ) {
      throw new SandboxError(
        "invalid",
        "url: must be an https URL of a public host",
      );
    }
    const o = parse(schema.GitCheckoutOptions, options, "options");
    const name = repository.replace(/\/+$/, "").split("/").pop()!.replace(
      /\.git$/,
      "",
    );
    const target = workspaceEntry(this.#s.workspace, o.targetDir ?? name);
    const s = this.#s;
    const claim = `${s.stateDir}/run/clone-${randomToken(20)}`;
    // Only a clone that ran and was stopped leaves its claim behind; the
    // directory it names goes, whatever else is at the target stays.
    const undo = () =>
      this.#script(GITUNDO, [s.workspace, target.absolute, claim], {
        timeoutMs: 60_000,
      }).then(() => {}, () => {});
    let result: ExecResult;
    try {
      result = await this.#exec(
        [
          s.shell[0],
          "-c",
          GITCLONE,
          "celld-sandbox",
          s.workspace,
          target.absolute,
          repository,
          String(o.depth ?? 1),
          o.branch ?? "",
          o.unsafeSymlinks === true ? "1" : "0",
          claim,
        ],
        {
          timeoutMs: o.timeoutMs ?? Math.min(300_000, s.maxExecTimeoutMs),
          ...(o.signal === undefined ? {} : { signal: o.signal }),
          ...(o.cancelToken === undefined
            ? {}
            : { cancelToken: o.cancelToken }),
          ...(o.lease === undefined ? {} : { lease: o.lease }),
        },
        {
          exactEnv: {
            ...s.baseEnv,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
            GIT_ALLOW_PROTOCOL: "https",
            GIT_PROTOCOL_FROM_USER: "0",
          },
          mutating: true,
        },
      );
    } catch (error) {
      const known = SandboxError.from(error);
      if (known === null || !["invalid", "lease_held"].includes(known.code)) {
        await undo();
      }
      throw error;
    }
    if (result.timedOut) await undo();
    const code = result.exitCode !== null && result.exitCode >= 90
      ? EXIT_CODES[result.exitCode]
      : undefined;
    if (code !== undefined) {
      throw new SandboxError(
        code as ConstructorParameters<typeof SandboxError>[0],
        result.stderr.trim() || code,
      );
    }
    return result;
  }

  /**
   * The lines of the regular files under `path` (a directory, default the
   * workspace) that contain `pattern`: a fixed string, or with `regex` a
   * POSIX extended regular expression of at most 256 bytes. It runs in the
   * container (`find . -type f` and `grep`), under the call's deadline, as
   * a command does; the directory is checked like every path, and the walk
   * never follows a symbolic link, to a file or into a directory, so it
   * reads nothing outside the workspace however the tree is linked.
   * Hidden entries are searched unless `includeHidden: false`. At most
   * `maxMatches` lines come back (`truncated` says there were more). With
   * `noFollow` no component of `path` may be a symbolic link either
   * (`is_symlink`), checked in the same exec as the walk.
   *
   * It only reads, so it runs while another caller holds the workspace
   * lease. A path that holds `:<digits>:` is split at the first such run.
   */
  async searchFiles(
    pattern: string,
    options: SearchFilesOptions = {},
  ): Promise<SearchResult> {
    const o = parse(schema.SearchFilesOptions, options, "options");
    const text = o.regex
      ? parse(schema.RegexPattern, pattern, "pattern")
      : parse(schema.LiteralPattern, pattern, "pattern");
    const target = workspacePath(this.#s.workspace, o.path ?? "");
    const limit = o.maxMatches ?? 1000;
    const timeoutMs = this.#timeout(o.timeoutMs ?? 30_000);
    const s = this.#s;
    if (o.regex) {
      await this.ready();
      await this.#checkRegex(
        text,
        Math.min(timeoutMs, 30_000),
        o.signal as AbortSignal | undefined,
      );
    }
    const result = await this.#exec(
      [
        s.shell[0],
        "-c",
        SEARCH,
        "celld-sandbox",
        s.workspace,
        target.absolute,
        o.regex ? "regex" : "fixed",
        o.includeHidden === false ? "0" : "1",
        o.ignoreCase ? "1" : "0",
        text,
        ...(o.noFollow ? ["1", target.relative] : []),
      ],
      {
        timeoutMs,
        ...(o.maxOutputBytes === undefined
          ? {}
          : { maxOutputBytes: o.maxOutputBytes }),
        ...(o.signal === undefined ? {} : { signal: o.signal }),
        ...(o.cancelToken === undefined ? {} : { cancelToken: o.cancelToken }),
      },
      { exactEnv: { ...s.baseEnv }, mutating: false },
    );
    if (result.timedOut) {
      throw new SandboxError(
        "timeout",
        `the search ran out of time after ${timeoutMs} ms`,
      );
    }
    // From 87 up the script's own verdict (89: a pattern grep cannot
    // compile); `find` itself exits 0 or 1.
    const code = result.exitCode !== null && result.exitCode >= 87
      ? EXIT_CODES[result.exitCode]
      : undefined;
    if (code !== undefined) {
      throw new SandboxError(
        code as ConstructorParameters<typeof SandboxError>[0],
        result.stderr.trim() || code,
      );
    }
    const lines = result.stdout.split("\n");
    // The last piece is "" or, past the output cap, part of a line.
    lines.pop();
    const matches: SearchMatch[] = [];
    for (const line of lines) {
      const found = /:(\d+):/.exec(line);
      if (found === null || !line.startsWith("./")) continue;
      if (matches.length >= limit) return { matches, truncated: true };
      const rest = line.slice(2, found.index);
      matches.push({
        path: target.relative === "" ? rest : `${target.relative}/${rest}`,
        line: Number(found[1]),
        text: line.slice(found.index + found[0].length),
      });
    }
    return { matches, truncated: result.truncated };
  }

  // Refuses a regular expression grep cannot compile (`invalid`); the
  // check is its own exec'd grep over one line (busybox compiles only when
  // it has a line), killed at `timeoutMs` (`timeout`).
  async #checkRegex(
    pattern: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const raw = await this.#script(REGEXCHECK, [pattern], {
      timeoutMs,
      maxOutputBytes: 4096,
      accept: [1, 2],
      ...(signal === undefined ? {} : { signal }),
    });
    if (raw.exitCode === 2) {
      throw new SandboxError(
        "invalid",
        "pattern: not a valid POSIX extended regular expression",
      );
    }
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
        ...(o.noFollow ? ["1", target.relative] : []),
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
    // One bounded read of the file that was checked: more than `max` bytes
    // means it grew after the size check, and the content is cut at `max`.
    const truncated = raw.truncated || raw.stdout.byteLength > max;
    const bytes = truncated ? raw.stdout.subarray(0, max) : raw.stdout;
    if (o.encoding === "bytes") {
      return {
        path: target.relative,
        size: bytes.byteLength,
        encoding: "bytes",
        content: bytes,
        truncated,
      };
    }
    let content: string;
    try {
      // A cut may split the last character; `stream` leaves that part out.
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
        stream: truncated,
      });
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
      truncated,
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
    const max = this.#s.maxFileBytes;
    // Sized before anything is decoded or copied: base64 by the most it
    // can decode to, text by its UTF-8 length.
    const encoded = typeof value !== "string"
      ? value.byteLength
      : o.encoding === "base64"
      ? Math.floor(value.length / 4) * 3 + (value.length % 4)
      : utf8Length(value);
    if (encoded > max + (o.encoding === "base64" ? 2 : 0)) {
      throw new SandboxError(
        "too_large",
        `the content has more than ${max} bytes`,
      );
    }
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
    await this.#mutate(o.lease, (signal) =>
      this.#script(WRITE, [
        this.#s.workspace,
        target.absolute,
        o.createParents === false ? "0" : "1",
        o.mode ?? "-",
        String(this.#s.maxFileBytes),
      ], { stdin: bytes, signal }));
    await this.#controller.touch();
  }

  /** Creates a directory; `recursive` also creates parents and accepts an existing one. */
  async mkdir(path: string, options: RecursiveOptions = {}): Promise<void> {
    const target = workspaceEntry(this.#s.workspace, path);
    const o = parse(schema.Recursive, options, "options");
    await this.#mutate(o.lease, (signal) =>
      this.#script(MKDIR, [
        this.#s.workspace,
        target.absolute,
        o.recursive ? "1" : "0",
      ], { signal }));
  }

  /** Removes a file or symbolic link (never a directory). */
  async deleteFile(path: string, options: LeaseOption = {}): Promise<void> {
    const target = workspaceEntry(this.#s.workspace, path);
    const o = parse(schema.Leased, options, "options");
    await this.#mutate(
      o.lease,
      (signal) =>
        this.#script(REMOVE, [this.#s.workspace, target.absolute, "file"], {
          signal,
        }),
    );
  }

  /** Removes a file, an empty directory, or with `recursive` a whole tree. */
  async remove(path: string, options: RecursiveOptions = {}): Promise<void> {
    const target = workspaceEntry(this.#s.workspace, path);
    const o = parse(schema.Recursive, options, "options");
    await this.#mutate(o.lease, (signal) =>
      this.#script(REMOVE, [
        this.#s.workspace,
        target.absolute,
        o.recursive ? "tree" : "empty",
      ], { signal }));
  }

  /** Renames or moves a file or directory; an existing file at `to` is replaced. */
  async renameFile(
    from: string,
    to: string,
    options: LeaseOption = {},
  ): Promise<void> {
    const source = workspaceEntry(this.#s.workspace, from);
    const target = workspaceEntry(this.#s.workspace, to);
    const o = parse(schema.Leased, options, "options");
    await this.#mutate(o.lease, (signal) =>
      this.#script(RENAME, [
        this.#s.workspace,
        source.absolute,
        target.absolute,
      ], { signal }));
  }

  /** The same as {@link renameFile}. */
  async moveFile(
    from: string,
    to: string,
    options: LeaseOption = {},
  ): Promise<void> {
    await this.renameFile(from, to, options);
  }

  /**
   * Kind, size and modification time; symbolic links are followed (inside
   * the workspace), unless `noFollow`: then a link at the path or on its
   * way is `is_symlink`.
   */
  async stat(path: string, options: NoFollowOptions = {}): Promise<FileStat> {
    const target = workspacePath(this.#s.workspace, path);
    const o = parse(schema.NoFollow, options, "options");
    await this.ready();
    const raw = await this.#script(STAT, [
      this.#s.workspace,
      target.absolute,
      ...(o.noFollow ? ["1", target.relative] : []),
    ]);
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

  /**
   * Whether something is at `path`. Paths outside the workspace still
   * throw, and so does a link with `noFollow` (`is_symlink`).
   */
  async exists(
    path: string,
    options: NoFollowOptions = {},
  ): Promise<ExistsResult> {
    try {
      const found = await this.stat(path, options);
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

  /**
   * A directory's entries (default the workspace root), at most `limit`
   * (default 10,000) of them, in one bounded walk: the walk stops once it
   * has found more than `limit`, so a small limit costs little on a big
   * tree. `truncated` says there are more, and `cursor` (then set) asks
   * for them: pass it back with the same path and options. Pages follow
   * the walk's order; each page is sorted by path unless `sort: false`.
   * The cursor names the last entry of its page, and the next page starts
   * only where that entry still ends the walk so far: when the directory
   * changed so that entries would be skipped or repeated, the next page is
   * `listing_changed` (start again). With `noFollow`, a link at the path or
   * on its way is `is_symlink`.
   */
  async listFiles(
    path = "",
    options: ListFilesOptions = {},
  ): Promise<ListFilesResult> {
    const target = workspacePath(this.#s.workspace, path);
    const o = parse(schema.ListFilesOptions, options, "options");
    const limit = o.limit ?? 10_000;
    const { skip, anchor } = readCursor(o.cursor);
    // An entry is 1 to 4 lines (see LIST): this many lines hold at least
    // limit + 1 whole entries whenever there are that many. The anchor's
    // own lines come first, to check that the walk has not moved.
    const lead = anchor?.count ?? 0;
    const lines = 4 * (limit + 1) + 3;
    await this.ready();
    const raw = await this.#script(LIST, [
      this.#s.workspace,
      target.absolute,
      o.recursive ? "1" : "0",
      o.includeHidden ? "1" : "0",
      String(skip - lead),
      String(lines + lead),
      ...(o.noFollow ? ["1", target.relative] : []),
    ]);
    // Every line ends in a newline, so the last piece is "" (or, past the
    // output cap, part of a line): either way it goes.
    let text = decode(raw.stdout).split("\n");
    text.pop();
    // A cut output (by `head`, or by the output cap) may end inside an
    // entry's run: that last run is dropped and read again on the next page.
    const cut = raw.truncated || text.length >= lines + lead;
    if (anchor !== null) {
      const moved = text.length < lead ||
        text.slice(0, lead).some((line) => line !== anchor.line) ||
        text[lead] === anchor.line;
      if (moved) {
        throw new SandboxError(
          "listing_changed",
          `${
            target.relative || "the workspace"
          } changed between pages of the listing; list it again from the start`,
        );
      }
      text = text.slice(lead);
    }
    const runs: { path: string; count: number }[] = [];
    for (const line of text) {
      const last = runs[runs.length - 1];
      if (last !== undefined && last.path === line) last.count += 1;
      else runs.push({ path: line, count: 1 });
    }
    if (cut && runs.length > 0) runs.pop();
    const kinds: EntryKind[] = ["file", "dir", "symlink", "other"];
    const entries: FileEntry[] = [];
    let used = 0;
    const page = runs.slice(0, limit);
    for (const run of page) {
      used += run.count;
      if (!run.path.startsWith("./")) continue;
      const rest = run.path.slice(2).replaceAll("\0", "\n");
      const relative = target.relative === ""
        ? rest
        : `${target.relative}/${rest}`;
      entries.push({
        path: relative,
        name: rest.split("/").pop()!,
        kind: kinds[Math.min(run.count, 4) - 1],
      });
    }
    const truncated = cut || runs.length > limit;
    if (o.sort !== false) {
      entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    }
    if (!truncated) return { entries, truncated };
    const end = page[page.length - 1] ?? (anchor === null ? undefined : {
      path: anchor.line,
      count: anchor.count,
    });
    return {
      entries,
      truncated,
      cursor: makeCursor(skip + used, end),
    };
  }

  // MARK: Processes

  // `[id, endedAt]` of every finished record, oldest first (built once
  // from the records for storage written before the index existed).
  #finishedIndex(): [string, number][] {
    let index = this.#kv.get<[string, number][]>(KEYS.finished);
    if (index === undefined) {
      index = [];
      for (
        const [, record] of this.#kv.list<ProcessRecord>({
          prefix: KEYS.process,
        })
      ) {
        if (record.status !== "running") {
          index.push([record.id, record.endedAt ?? record.startedAt]);
        }
      }
      index.sort((a, b) => a[1] - b[1]);
      this.#kv.put(KEYS.finished, index);
    }
    return index;
  }

  // Deletes finished records past the ring's size or their TTL.
  #purgeRecords(now: number): void {
    const index = this.#finishedIndex();
    let drop = Math.max(0, index.length - this.#s.maxFinishedRecords);
    while (
      drop < index.length && index[drop][1] + this.#s.recordTtlMs <= now
    ) {
      drop += 1;
    }
    if (drop === 0) return;
    for (const [id] of index.slice(0, drop)) {
      this.#kv.delete(KEYS.process + id);
    }
    this.#kv.put(KEYS.finished, index.slice(drop));
  }

  // Deletes tickets past their time; answers how many are left.
  #purgeTickets(now: number): number {
    let left = 0;
    for (
      const [key, value] of [
        ...this.#kv.list<TicketRecord>({ prefix: KEYS.ticket }),
      ]
    ) {
      if (value.expires <= now) this.#kv.delete(key);
      else left += 1;
    }
    return left;
  }

  // When the next ticket, record or preview token expires, for the alarm.
  #nextExpiry(): number | null {
    let next: number | null = null;
    const index = this.#kv.get<[string, number][]>(KEYS.finished) ?? [];
    if (index.length > 0) next = index[0][1] + this.#s.recordTtlMs;
    for (const record of Object.values(this.#ports())) {
      const at = record.expiresAt ?? 0;
      if (next === null || at < next) next = at;
    }
    for (
      const [, value] of this.#kv.list<TicketRecord>({ prefix: KEYS.ticket })
    ) {
      if (next === null || value.expires < next) next = value.expires;
    }
    return next;
  }

  // Revokes preview tokens past their expiry (the port is unexposed).
  #purgePorts(now: number): void {
    const ports = this.#ports();
    let changed = false;
    for (const [key, record] of Object.entries(ports)) {
      if (!((record.expiresAt ?? 0) > now)) {
        delete ports[key];
        changed = true;
      }
    }
    if (changed) this.#kv.put(KEYS.ports, ports);
  }

  /**
   * Purges expired stream tickets, finished process records and preview
   * tokens. The
   * `Sandbox` object calls it from `alarm()`; the alarm is set whenever a
   * ticket or record is written, and kept when the container stops.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    this.#purgeTickets(now);
    this.#purgeRecords(now);
    this.#purgePorts(now);
    const next = this.#nextExpiry();
    if (next !== null) await this.#controller.wakeBy(next);
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
    // A concurrent refresh may have finished it already.
    const stored = this.#kv.get<ProcessRecord>(KEYS.process + record.id);
    if (stored === undefined || stored.status !== "running") {
      return stored ?? record;
    }
    const now = Date.now();
    // From the stored record, not the caller's copy: a kill requested
    // since that copy was read still counts.
    const done: ProcessRecord = {
      ...stored,
      status: status === "exited" && stored.killRequested ? "killed" : status,
      exitCode,
      endedAt: now,
      tail,
    };
    // The index first: built lazily from the stored records, it would
    // already hold this one once it is written, and hold it twice.
    const index = this.#finishedIndex();
    this.#kv.put(KEYS.process + record.id, done);
    this.#unindex(record.id);
    this.#kv.put(KEYS.finished, [...index, [record.id, now]]);
    this.#purgeRecords(now);
    this.#controller.wakeBy(now + this.#s.recordTtlMs).catch(() => {});
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
    // The state files belong to the commands' own user (see POLL): a
    // header that is not exactly what POLL writes counts as a lost process.
    const match = /^(-|\d{1,3}) ([01]) (\d{1,15}) (\d{1,15})$/.exec(header);
    if (newline < 0 || match === null || Number(match[1]) > 255) return null;
    const [, exit, timedOut, sizeOut, sizeErr] = match;
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
    const done = this.#finish(
      record,
      status,
      header.exit,
      tail === null ? null : {
        stdout: tail.stdout,
        stderr: tail.stderr,
        truncated: header.sizeOut > kept || header.sizeErr > kept ||
          header.sizeOut >= this.#s.processLogBytes ||
          header.sizeErr >= this.#s.processLogBytes,
        sizeOut: header.sizeOut,
        sizeErr: header.sizeErr,
      },
    );
    // The tail is kept; the files in the container are not needed any more.
    await this.#script(REMOVE_DIR, [this.#directory(record.id)]).catch(
      () => {},
    );
    return done;
  }

  async #start(
    argv: readonly string[],
    options: schema.ProcessOptionsValue,
  ): Promise<ProcessInfo> {
    this.#checkArgv(argv);
    this.#checkEnv(options.env, "the command's environment");
    const epoch = this.#epoch;
    // Registration covers startup; the stored mutation classification covers
    // its lifetime after startup, including subsequent workspace handoff.
    const operation = this.#begin(options.lease, options.mutates !== false);
    try {
      await this.ready();
      operation.stop.signal.throwIfAborted();
      const result = await this.#spawn(argv, options, epoch);
      operation.stop.signal.throwIfAborted();
      return result;
    } finally {
      this.#end(operation);
    }
  }

  async #spawn(
    argv: readonly string[],
    options: schema.ProcessOptionsValue,
    epoch: number,
  ): Promise<ProcessInfo> {
    const session = this.#session(options.sessionId);
    const cwd = this.#cwd(options.cwd, session);
    const command = this.#command(argv, this.#env(options.env, session));
    const release = await this.#acquire();
    const s = this.#s;
    const id = this.#ids();
    const directory = this.#directory(id);
    let recorded = false;
    try {
      const seconds = options.timeoutMs === undefined
        ? 0
        : Math.ceil(options.timeoutMs / 1000);
      // SPAWN is not wrapped again: the command itself carries `env -i`.
      const raw = await runRaw(this.#native, [
        s.shell[0],
        "-c",
        SPAWN,
        "celld-sandbox",
        directory,
        String(s.processLogBytes),
        String(seconds),
        cwd,
        s.shell[0],
        ...command.argv,
      ], {
        env: command.env,
        user: s.user,
        timeoutMs: 30_000,
        maxOutputBytes: 4096,
      });
      if (raw.exitCode !== 0) {
        const code = raw.timedOut ? undefined : EXIT_CODES[raw.exitCode ?? -1];
        throw new SandboxError(
          (code ?? "command_failed") as ConstructorParameters<
            typeof SandboxError
          >[0],
          decode(raw.stderr).trim() || "the process did not start",
        );
      }
      if (this.#epoch !== epoch) {
        // destroy() ran while this start was on its way: its record would
        // outlive the wipe. The container goes with the destroy.
        throw new SandboxError(
          "cancelled",
          "the sandbox was destroyed while the process was starting",
        );
      }
      // `PID PIDSTART SID SIDSTART`; `PID SID` (an earlier SPAWN, which
      // fakes may still answer) leaves the start times unknown (0).
      const numbers = decode(raw.stdout).trim().split(" ").map(Number);
      const [pid, pidStart, sid, sidStart] = numbers.length === 2
        ? [numbers[0], 0, numbers[1], 0]
        : numbers;
      if (
        (numbers.length !== 2 && numbers.length !== 4) ||
        !numbers.every((n) => Number.isSafeInteger(n))
      ) {
        throw new SandboxError(
          "command_failed",
          "the process start reported no pid",
        );
      }
      const record: ProcessRecord = {
        id,
        name: options.name ?? null,
        pid,
        sid,
        pidStart,
        sidStart,
        command: [...argv],
        cwd: workspacePath(s.workspace, cwd).relative,
        status: "running",
        exitCode: null,
        startedAt: Date.now(),
        endedAt: null,
        generation: this.#controller.generation,
        killRequested: false,
        mutates: options.mutates !== false,
        lease: options.lease,
        tail: null,
      };
      // The record, the index and the slot change in one synchronous step.
      this.#kv.put(KEYS.process + id, record);
      this.#kv.put(KEYS.running, [...this.#runningIds(), id]);
      recorded = true;
      release();
      await this.#controller.touch();
      return this.#info(record);
    } finally {
      release();
      // A start that failed after its command may have begun (SPAWN gave
      // up waiting, its deadline, an answer that did not parse): whatever
      // it started is killed and its directory removed, so nothing runs
      // that no record counts.
      if (!recorded && this.#epoch === epoch) {
        await this.#script(SPAWNUNDO, [directory], { timeoutMs: 10_000 })
          .catch(() => {});
      }
    }
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

  /**
   * The processes this sandbox knows (the running ones and the newest
   * finished ones, see `maxFinishedRecords`), oldest first, a page at a
   * time.
   */
  async listProcesses(
    options: ListProcessesOptions = {},
  ): Promise<ProcessList> {
    const o = parse(schema.ListProcessesOptions, options, "options");
    const limit = o.limit ?? 100;
    const page = [
      ...this.#kv.list<ProcessRecord>({
        prefix: KEYS.process,
        ...(o.cursor === undefined
          ? {}
          : { startAfter: KEYS.process + o.cursor }),
        limit: limit + 1,
      }),
    ].map(([, record]) => record);
    const more = page.length > limit;
    const processes: ProcessInfo[] = [];
    for (const record of page.slice(0, limit)) {
      processes.push(this.#info(await this.#refreshed(record)));
    }
    return {
      processes,
      cursor: more ? processes[processes.length - 1].id : null,
    };
  }

  async getProcess(id: string): Promise<ProcessInfo> {
    return this.#info(await this.#refreshed(this.#record(id)));
  }

  /** Sends `signal` (default TERM) to the process's group and waits up to 1 s. */
  async killProcess(id: string, signal = "TERM"): Promise<ProcessInfo> {
    const name = parse(schema.Signal, signal, "signal");
    let record = await this.#refreshed(this.#record(id));
    if (record.status !== "running") return this.#info(record);
    // The refresh awaited the container: another call may have finished
    // (or deleted) the record meanwhile, so the flag goes on what is
    // stored now, never on the copy read before.
    const stored = this.#kv.get<ProcessRecord>(KEYS.process + record.id);
    if (stored === undefined) {
      throw new SandboxError("no_such_process", `no process ${id}`);
    }
    if (stored.status !== "running") return this.#info(stored);
    record = { ...stored, killRequested: true };
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
    if (record.status !== "running") await this.#sweep();
    return this.#info(record);
  }

  /** Kills every running process; answers what became of each. */
  async killAllProcesses(signal = "TERM"): Promise<ProcessInfo[]> {
    parse(schema.Signal, signal, "signal");
    const out: ProcessInfo[] = [];
    for (const id of [...this.#runningIds()]) {
      out.push(await this.killProcess(id, signal));
    }
    return out;
  }

  /**
   * Forgets a process that has ended: its record, its kept output and
   * whatever of it is left in the container. A running one is refused.
   */
  async deleteProcess(id: string): Promise<void> {
    const record = await this.#refreshed(this.#record(id));
    if (record.status === "running") {
      throw new SandboxError(
        "invalid",
        `process ${record.id} is running; kill it first`,
      );
    }
    this.#kv.delete(KEYS.process + record.id);
    this.#kv.put(
      KEYS.finished,
      this.#finishedIndex().filter(([done]) => done !== record.id),
    );
    if (
      record.generation === this.#controller.generation &&
      this.#controller.native.running
    ) {
      await this.#script(REMOVE_DIR, [this.#directory(record.id)]).catch(
        () => {},
      );
    }
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
   * Waits until a line of the process's output contains `pattern`, up to
   * `timeoutMs` (default 30 s): for a server's "listening" line, say.
   * Answers `matched: false` when it ends or time runs out.
   *
   * The pattern is a literal string unless `regex` is set; then it is a
   * POSIX extended regular expression of at most 256 bytes, matched by
   * `grep -E` inside the container under the same deadline, never in the
   * object, so a pattern that backtracks forever costs the container time
   * and nothing else.
   */
  async waitForLog(
    id: string,
    pattern: string,
    options: WaitForLogOptions = {},
  ): Promise<{ matched: boolean; line: string | null; process: ProcessInfo }> {
    const o = parse(schema.WaitForLogOptions, options, "options");
    const text = o.regex
      ? parse(schema.RegexPattern, pattern, "pattern")
      : parse(schema.LiteralPattern, pattern, "pattern");
    const which = o.stream ?? "both";
    const deadline = Date.now() +
      Math.min(o.timeoutMs ?? 30_000, this.#s.maxExecTimeoutMs);
    return await this.#controller.busy(() =>
      o.regex
        ? this.#waitForRegex(id, text, which, deadline)
        : this.#waitForText(id, text, which, deadline)
    );
  }

  async #waitForText(
    id: string,
    pattern: string,
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
          const line = texts[stream].split("\n").find((text) =>
            text.includes(pattern)
          );
          if (line !== undefined) {
            return { matched: true, line, process: this.#info(record) };
          }
        }
        if (polled.stdout.byteLength > 0 || polled.stderr.byteLength > 0) {
          continue;
        }
      } else if (record.tail !== null) {
        for (const stream of ["stdout", "stderr"] as const) {
          if (which !== "both" && which !== stream) continue;
          const line = decode(record.tail[stream]).split("\n").find((text) =>
            text.includes(pattern)
          );
          if (line !== undefined) {
            return { matched: true, line, process: this.#info(record) };
          }
        }
      }
      if (record.status !== "running" || Date.now() >= deadline) {
        return { matched: false, line: null, process: this.#info(record) };
      }
      await new Promise((resolve) => setTimeout(resolve, this.#s.logPollMs));
    }
  }

  async #waitForRegex(
    id: string,
    pattern: string,
    which: "stdout" | "stderr" | "both",
    deadline: number,
  ): Promise<{ matched: boolean; line: string | null; process: ProcessInfo }> {
    let record = this.#record(id);
    const streams = (["stdout", "stderr"] as const).filter((stream) =>
      which === "both" || which === stream
    );
    let searched = "";
    let checked = false;
    for (;;) {
      record = await this.#refreshed(record);
      const live = record.generation === this.#controller.generation &&
        this.#controller.native.running;
      const left = deadline - Date.now();
      if (live && left > 0) {
        if (!checked) {
          // Once, before the first search: grep compiles the pattern in
          // its own exec'd process, which the deadline kills.
          try {
            await this.#checkRegex(pattern, left);
          } catch (error) {
            if (SandboxError.from(error)?.code === "timeout") break;
            throw error;
          }
          checked = true;
        }
        const header = await this.#poll(record, 0, 0, 0);
        const files = header === null
          ? null
          : streams.map((stream) => `${this.#directory(record.id)}/${stream}`);
        const sizes = header === null
          ? "tail"
          : `${header.sizeOut} ${header.sizeErr}`;
        // Search again only when there is something new to search.
        if (sizes !== searched) {
          searched = sizes;
          const line = await this.#grep(
            pattern,
            files,
            files === null ? record : null,
            streams,
            deadline,
          );
          if (line === "timeout") break;
          if (line !== null) {
            return { matched: true, line, process: this.#info(record) };
          }
        }
      }
      if (record.status !== "running" || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, this.#s.logPollMs));
    }
    return { matched: false, line: null, process: this.#info(record) };
  }

  // The first line matching `pattern` in `files`, or in the stored tail of
  // `record` (through stdin) when the files are gone; "timeout" when the
  // deadline passed first.
  async #grep(
    pattern: string,
    files: string[] | null,
    record: ProcessRecord | null,
    streams: readonly ("stdout" | "stderr")[],
    deadline: number,
  ): Promise<string | null | "timeout"> {
    const inputs: { args: string[]; stdin?: Uint8Array }[] = files !== null
      ? [{ args: files }]
      : record?.tail
      ? streams.map((stream) => ({
        args: ["-"],
        stdin: record.tail![stream],
      }))
      : [];
    for (const input of inputs) {
      const left = deadline - Date.now();
      if (left <= 0) return "timeout";
      let raw: RawResult;
      try {
        raw = await this.#script(LOGGREP, [pattern, ...input.args], {
          timeoutMs: left,
          maxOutputBytes: LOG_CHUNK,
          accept: [1, 2],
          ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
        });
      } catch (error) {
        if (error instanceof SandboxError && error.code === "timeout") {
          return "timeout";
        }
        throw error;
      }
      // One line per file that matched, in the files' order: the first.
      const out = decode(raw.stdout);
      if (out !== "") return out.split("\n")[0];
    }
    return null;
  }

  async #followLogs(
    id: string,
    fromStart: boolean,
    emit: (event: ProcessEvent) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    let record = this.#record(id);
    const offsets = { stdout: 0, stderr: 0 };
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    const deadline = Date.now() + this.#s.maxStreamMs;
    let first = true;
    for (;;) {
      // The reader left: stop polling now, not at the next output.
      if (signal.aborted) return;
      const live = record.generation === this.#controller.generation &&
        this.#controller.native.running;
      const polled = live
        ? await this.#poll(record, offsets.stdout, offsets.stderr, LOG_CHUNK)
        : null;
      if (polled === null) {
        record = await this.#refreshed(record);
        const tail = record.tail;
        if (tail !== null && (fromStart || !first)) {
          // The files are gone once the tail is kept: send what of the
          // tail this stream has not sent yet.
          const sizes = { stdout: tail.sizeOut, stderr: tail.sizeErr };
          for (const stream of ["stdout", "stderr"] as const) {
            const bytes = tail[stream];
            const size = sizes[stream] ?? bytes.byteLength;
            const from = first
              ? 0
              : Math.max(0, offsets[stream] - (size - bytes.byteLength));
            const data = decoders[stream].decode(bytes.subarray(from));
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
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, this.#s.logPollMs);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve(undefined);
        }, { once: true });
      });
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

  #ports(): Record<string, PortRecord> {
    return this.#kv.get<Record<string, PortRecord>>(KEYS.ports) ?? {};
  }

  #exposed(record: PortRecord): ExposedPort {
    return {
      port: record.port,
      name: record.name,
      token: record.token,
      createdAt: new Date(record.createdAt).toISOString(),
      rotatedAt: record.rotatedAt === null
        ? null
        : new Date(record.rotatedAt).toISOString(),
      expiresAt: new Date(record.expiresAt ?? 0).toISOString(),
    };
  }

  #live(record: PortRecord | undefined, now: number): boolean {
    return record !== undefined && (record.expiresAt ?? 0) > now;
  }

  /**
   * Makes `port` reachable through preview requests carrying its token
   * (see `proxyToSandbox`): 26 random base32 letters (130 bits), valid for
   * `ttlMs` (default `previewTokenTtlMs`, 15 min). Exposing it again keeps
   * an unexpired token and its expiry (and may rename it); an expired one
   * is replaced. {@link rotatePort} replaces a token early,
   * {@link unexposePort} revokes it, and {@link destroy} revokes them all.
   * At most {@link MAX_EXPOSED_PORTS} ports hold a live token at once; a
   * new one past that fails with `too_many_ports` (expired tokens do not
   * count, and are dropped here).
   */
  async exposePort(
    port: number,
    options: ExposePortOptions = {},
  ): Promise<ExposedPort> {
    {
      const number = parse(schema.Port, port, "port");
      const o = parse(schema.ExposePortOptions, options, "options");
      const ttl = o.ttlMs ?? this.#s.previewTokenTtlMs;
      const now = Date.now();
      const ports = this.#ports();
      for (const [key, held] of Object.entries(ports)) {
        if (!this.#live(held, now)) delete ports[key];
      }
      const existing = ports[number];
      if (
        existing === undefined &&
        Object.keys(ports).length >= MAX_EXPOSED_PORTS
      ) {
        throw new SandboxError(
          "too_many_ports",
          `${MAX_EXPOSED_PORTS} ports are exposed already; unexpose one first`,
        );
      }
      const record: PortRecord = existing !== undefined &&
          this.#live(existing, now)
        ? {
          ...existing,
          name: o.name ?? existing.name,
        }
        : {
          port: number,
          name: o.name ?? existing?.name ?? null,
          token: randomToken(PREVIEW_TOKEN_LENGTH),
          createdAt: now,
          rotatedAt: null,
          expiresAt: now + ttl,
        };
      ports[number] = record;
      this.#kv.put(KEYS.ports, ports);
      await this.#controller.wakeBy(record.expiresAt);
      return this.#exposed(record);
    }
  }

  /**
   * Replaces the token of an exposed port with a new one (and a new
   * expiry, `ttlMs` or the default): the old token stops working at once.
   * `rotatedAt` records when.
   */
  async rotatePort(
    port: number,
    options: { expectedToken: string; ttlMs?: number },
  ): Promise<ExposedPort> {
    {
      const number = parse(schema.Port, port, "port");
      const o = parse(schema.RotatePortOptions, options, "options");
      const now = Date.now();
      const ports = this.#ports();
      const existing = ports[number];
      if (existing === undefined) {
        throw new SandboxError(
          "port_not_exposed",
          `port ${number} is not exposed`,
        );
      }
      if (existing.rotatedFrom === o.expectedToken) {
        return this.#exposed(existing);
      }
      if (!sameToken(existing.token, o.expectedToken)) {
        throw new SandboxError(
          "invalid",
          "preview rotation conflicts with a newer generation; read getExposedPorts to reconcile",
        );
      }
      const record: PortRecord = {
        rotatedFrom: existing.token,
        port: number,
        name: existing.name,
        token: randomToken(PREVIEW_TOKEN_LENGTH),
        createdAt: existing.createdAt ?? now,
        rotatedAt: now,
        expiresAt: now + (o.ttlMs ?? this.#s.previewTokenTtlMs),
      };
      ports[number] = record;
      this.#kv.put(KEYS.ports, ports);
      await this.#controller.wakeBy(record.expiresAt);
      return this.#exposed(record);
    }
  }

  /** Revokes a port's token: preview requests to it are 404s from now on. */
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

  /** The exposed ports with unexpired tokens. */
  getExposedPorts(): Promise<ExposedPort[]> {
    return settle(() => {
      const now = Date.now();
      return Object.values(this.#ports())
        .filter((record) => this.#live(record, now))
        .sort((a, b) => a.port - b.port)
        .map((record) => this.#exposed(record));
    });
  }

  /**
   * Forwards `request` to an exposed port whose token matches and has not
   * expired; anything else is a 404 that never starts the container. The
   * token and the container generation are checked again once the port's
   * route is resolved, with no await between that check and the dispatch,
   * so a request that was waiting when `destroy()` ran is a 404 too: it
   * never reaches the next container generation.
   */
  async previewFetch(
    port: number,
    token: string,
    request: Request,
  ): Promise<Response> {
    const valid = () => {
      if (typeof token !== "string" || !/^[a-z2-7]{26}$/.test(token)) {
        return false;
      }
      const exposed = Number.isInteger(port) ? this.#ports()[port] : undefined;
      return exposed !== undefined && this.#live(exposed, Date.now()) &&
        sameToken(exposed.token, token);
    };
    const missing = () => new Response("not found", { status: 404 });
    if (!valid()) return missing();
    const epoch = this.#epoch;
    try {
      await this.ready();
    } catch (error) {
      if (this.#epoch !== epoch) return missing();
      throw error;
    }
    if (this.#epoch !== epoch || !valid()) return missing();
    const url = new URL(request.url);
    url.host = "sandbox.internal";
    url.protocol = "http:";
    const headers = new Headers(request.headers);
    for (const name of [...headers.keys()]) {
      if (
        name === "host" || name === "forwarded" || name === "referer" ||
        name === "origin" || name.startsWith("x-forwarded-") ||
        name === "x-original-host" || name === "x-celld-sandbox-preview"
      ) headers.delete(name);
    }
    const forwarded = new Request(url, new Request(request, { headers }));
    const route = await this.#controller.tcpPort(port);
    // Resolving the route awaits the controller (its alarm, a restart, a
    // readiness probe), and a destroy() and the next start may run
    // meanwhile: check again, then dispatch without yielding.
    if (this.#epoch !== epoch || !valid()) return missing();
    const response = await route.fetch(forwarded);
    const output = new Headers(response.headers);
    output.set("referrer-policy", "no-referrer");
    output.set("cache-control", "private, no-store");
    output.set("pragma", "no-cache");
    output.set("expires", "0");
    output.delete("set-cookie");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: output,
    });
  }

  // MARK: Environment and sessions

  /** Merges sandbox-wide variables into every later command; `null` removes one. */
  setEnvVars(
    env: Record<string, string | null>,
  ): Promise<Record<string, string>> {
    return settle(() => {
      const update = parse(schema.EnvUpdate, env, "env");
      // No prototype: `__proto__` is a shell identifier like any other.
      const current: Record<string, string> = Object.assign(
        Object.create(null),
        this.#kv.get<Record<string, string>>(KEYS.env) ?? {},
      );
      for (const [name, value] of Object.entries(update)) {
        if (value === null) delete current[name];
        else current[name] = value;
      }
      parse(schema.Env, current, "env");
      this.#checkEnv(current, "the sandbox environment");
      this.#kv.put(KEYS.env, current);
      return { ...current };
    });
  }

  /**
   * A named set of defaults (working directory, environment) for commands.
   * An id that exists is refused with `exists` (use {@link updateSession}
   * to change a session), so every session counts against `maxSessions`.
   */
  createSession(options: SessionOptions = {}): Promise<SessionInfo> {
    return settle(() => {
      const o = parse(schema.SessionOptions, options, "options");
      this.#checkEnv(o.env, "the session's environment");
      const id = o.id ?? this.#ids();
      if (this.#kv.get(KEYS.session + id) !== undefined) {
        throw new SandboxError("exists", `session ${id} exists`);
      }
      const known = [...this.#kv.list({ prefix: KEYS.session })].length;
      if (known >= this.#s.maxSessions) {
        throw new SandboxError(
          "too_many_sessions",
          `${known} sessions exist, the limit is ${this.#s.maxSessions}`,
        );
      }
      const session: SessionInfo = {
        id,
        cwd: workspacePath(this.#s.workspace, o.cwd ?? "").relative,
        env: { ...(o.env ?? {}) },
      };
      this.#kv.put(KEYS.session + session.id, session);
      return session;
    });
  }

  /**
   * Changes an existing session: `cwd` and `env` replace the session's own
   * when given (`env` as a whole, not merged).
   */
  updateSession(id: string, patch: SessionUpdate = {}): Promise<SessionInfo> {
    return settle(() => {
      const key = parse(schema.Id, id, "session id");
      const o = parse(schema.SessionUpdate, patch, "patch");
      const current = this.#kv.get<SessionInfo>(KEYS.session + key);
      if (current === undefined) {
        throw new SandboxError("no_such_session", `no session ${id}`);
      }
      this.#checkEnv(o.env, "the session's environment");
      const session: SessionInfo = {
        id: key,
        cwd: o.cwd === undefined
          ? current.cwd
          : workspacePath(this.#s.workspace, o.cwd).relative,
        env: o.env === undefined ? current.env : { ...o.env },
      };
      this.#kv.put(KEYS.session + key, session);
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

  // MARK: Leases

  #lease(name: string, record: LeaseRecord): Lease {
    return {
      name,
      token: record.token,
      expiresAt: new Date(record.expires).toISOString(),
    };
  }

  /**
   * Takes the lease on `name` (an id: 1-64 of `A-Z a-z 0-9 _ -`) for
   * `ttlMs` (default 30 s, at most 10 min) unless an unexpired one is
   * held: the new lease, or null. A pending workspace handoff excludes other
   * acquirers and mutations until displaced work is confirmed stopped; only
   * then is the new token installed and its TTL started. At most
   * {@link MAX_LEASES} live leases (`too_many_leases`); `destroy()` drops
   * them all.
   *
   * The lease {@link WORKSPACE_LEASE} is enforced here, not only honoured
   * by callers. While it is held, every mutating call (`writeFile`,
   * `writeFileStream`, `mkdir`, `deleteFile`, `remove`, `renameFile`,
   * `moveFile`, `gitCheckout`, `startProcess`, and `exec`, `execShell` and
   * their streams unless `mutates: false`) must pass its token as `lease`,
   * or fails with `lease_held`; a call that names a lease no longer held
   * fails with `lease_lost`. Taking it stops every mutating command still
   * running without it (under no lease, or one that expired), which then
   * fails with `lease_held` or `lease_lost`. Other names are only
   * honoured by the callers that use them.
   */
  acquireLease(
    name: string,
    options: LeaseOptions = {},
  ): Promise<Lease | null> {
    return settle(async () => {
      const key = parse(schema.Id, name, "lease name");
      const o = parse(schema.LeaseOptions, options, "options");
      const now = Date.now();
      const held = this.#kv.get<LeaseRecord>(KEYS.lease + key);
      if (key === WORKSPACE_LEASE && this.#handoff) return null;
      if (this.#unavailable) {
        throw new SandboxError(
          "not_running",
          "the sandbox requires destroy after failed containment",
        );
      }
      if (held !== undefined && held.expires > now) return null;
      let live = 0;
      for (
        const [stored, value] of [
          ...this.#kv.list<LeaseRecord>({ prefix: KEYS.lease }),
        ]
      ) {
        if (value.expires <= now) this.#kv.delete(stored);
        else live += 1;
      }
      if (live >= MAX_LEASES) {
        throw new SandboxError(
          "too_many_leases",
          `${live} leases are held, the limit is ${MAX_LEASES}`,
        );
      }
      if (key === WORKSPACE_LEASE) {
        this.#handoff = true;
        const epoch = this.#epoch;
        const deadline = Date.now() + 15_000;
        try {
          const displaced = [...this.#inflight].filter((operation) =>
            operation.mutating
          );
          this.#fenceMutations();
          let timer: ReturnType<typeof setTimeout> | undefined;
          const completed = await Promise.race([
            Promise.all(displaced.map((operation) => operation.done)).then(() =>
              true
            ),
            new Promise<false>((resolve) => {
              timer = setTimeout(() => resolve(false), 15_000);
            }),
          ]).finally(() => clearTimeout(timer));
          if (!completed) {
            await this.#contain();
            throw new SandboxError(
              "not_running",
              "workspace handoff required container containment; retry after cleanup",
            );
          }
          const stopping = [...this.#runningIds()].map(async (id) => {
            const process = this.#kv.get<ProcessRecord>(KEYS.process + id);
            if (process === undefined || process.mutates === false) return;
            await this.killProcess(id, "KILL");
            const ended = await this.waitForExit(id, { timeoutMs: 5_000 });
            if (ended.status === "running") {
              throw new SandboxError(
                "not_running",
                "a mutating background process survived workspace handoff",
              );
            }
          });
          let stopTimer: ReturnType<typeof setTimeout> | undefined;
          const stopped = await Promise.race([
            Promise.all(stopping).then(() => true),
            new Promise<false>((resolve) => {
              stopTimer = setTimeout(
                () => resolve(false),
                Math.max(0, deadline - Date.now()),
              );
            }),
          ]).finally(() => clearTimeout(stopTimer));
          if (!stopped) {
            throw new SandboxError(
              "not_running",
              "background process cleanup exceeded workspace handoff grace",
            );
          }
          this.#sameEpoch(epoch);
        } catch (error) {
          this.#unavailable = true;
          try {
            await this.#contain();
          } catch { /* Remain unavailable until explicit destroy succeeds. */ }
          throw error;
        } finally {
          this.#handoff = false;
        }
      }
      const record: LeaseRecord = {
        token: randomToken(PREVIEW_TOKEN_LENGTH),
        expires: Date.now() + (o.ttlMs ?? DEFAULT_LEASE_TTL_MS),
      };
      this.#kv.put(KEYS.lease + key, record);
      // The workspace has a new holder: mutations still running under no
      // lease, or under the one that expired, are stopped now.
      return this.#lease(key, record);
    });
  }

  /**
   * Extends the lease on `name` to `ttlMs` from now while `token` holds
   * it: the renewed lease, or null when it expired or was taken.
   */
  renewLease(
    name: string,
    token: string,
    options: LeaseOptions = {},
  ): Promise<Lease | null> {
    return settle(() => {
      const key = parse(schema.Id, name, "lease name");
      const secret = parse(schema.LeaseToken, token, "token");
      const o = parse(schema.LeaseOptions, options, "options");
      const now = Date.now();
      const held = this.#kv.get<LeaseRecord>(KEYS.lease + key);
      if (
        held === undefined || held.expires <= now ||
        !sameToken(held.token, secret)
      ) {
        return null;
      }
      const record = {
        ...held,
        expires: now + (o.ttlMs ?? DEFAULT_LEASE_TTL_MS),
      };
      this.#kv.put(KEYS.lease + key, record);
      return this.#lease(key, record);
    });
  }

  /** Gives up the lease `token` holds on `name`; false if it holds none. */
  releaseLease(name: string, token: string): Promise<boolean> {
    return settle(() => {
      const key = parse(schema.Id, name, "lease name");
      const secret = parse(schema.LeaseToken, token, "token");
      const held = this.#kv.get<LeaseRecord>(KEYS.lease + key);
      if (held === undefined || !sameToken(held.token, secret)) return false;
      this.#kv.delete(KEYS.lease + key);
      return true;
    });
  }

  // MARK: Streams

  /**
   * A one-time ticket (valid for 60 s) for a streamed operation: a command's
   * events, a process's logs, or a file's bytes in either direction. Redeem
   * it with {@link stream} through the object's `fetch`, which is the only
   * way celld carries a stream out of a Durable Object.
   */
  async openStream(request: StreamRequest): Promise<string> {
    const checked = parse(
      schema.StreamRequest,
      request,
      "request",
    ) as StreamRequest;
    if (checked.kind === "exec" || checked.kind === "shell") {
      this.#checkExec(
        checked.kind === "exec"
          ? checked.argv
          : [...this.#s.shell, checked.script],
        (checked.options ?? {}) as schema.ExecOptionsValue,
      );
      // Refused now rather than when redeemed; it is checked again then.
      if (checked.options?.mutates !== false) {
        this.#checkLease(checked.options?.lease);
      }
    } else if (checked.kind === "write") {
      this.#checkLease(checked.options?.lease);
    }
    const size = storedBytes(checked);
    if (size > this.#s.maxTicketBytes) {
      throw new SandboxError(
        "too_large",
        `the stream request has ${size} bytes to store, more than ${this.#s.maxTicketBytes}; send large stdin as the request body (bodyStdin)`,
      );
    }
    const now = Date.now();
    const open = this.#purgeTickets(now);
    if (open >= this.#s.maxOpenTickets) {
      throw new SandboxError(
        "too_many_streams",
        `${open} stream tickets are open, the limit is ${this.#s.maxOpenTickets}; redeem them or wait a minute`,
      );
    }
    const ticket = randomToken(32);
    const expires = now + TICKET_MS;
    this.#kv.put<TicketRecord>(KEYS.ticket + ticket, {
      request: checked,
      expires,
    });
    await this.#controller.wakeBy(expires);
    return ticket;
  }

  /** Revokes an unused stream ticket. */
  cancelStream(ticket: string): Promise<boolean> {
    return settle(() => {
      if (typeof ticket !== "string" || !/^[a-z2-7]{32}$/.test(ticket)) {
        throw new SandboxError("bad_ticket", "invalid ticket");
      }
      return this.#kv.delete(KEYS.ticket + ticket);
    });
  }

  /** Redeems a ticket from {@link openStream}; `body` feeds a `write`. */
  async stream(
    ticket: string,
    body: ReadableStream<Uint8Array> | null,
    requestSignal?: AbortSignal,
  ): Promise<Response> {
    const key = KEYS.ticket + ticket;
    const found = /^[a-z2-7]{32}$/.test(ticket)
      ? this.#kv.get<TicketRecord>(key)
      : undefined;
    if (found !== undefined) this.#kv.delete(key);
    if (requestSignal?.aborted) {
      await body?.cancel(requestSignal.reason).catch(() => {});
      requestSignal.throwIfAborted();
    }
    if (found === undefined || found.expires < Date.now()) {
      throw new SandboxError(
        "bad_ticket",
        "the stream ticket is unknown, used or expired",
      );
    }
    const request = found.request;
    // Streams go to browsers: a 4xx error keeps its detail (it describes
    // the caller's own request), a 5xx one or an unknown error is its
    // code and a fixed text, as `errorResponse` answers them.
    const failure = (error: unknown) => {
      const known = SandboxError.from(error);
      if (known === null) {
        return { code: "internal", message: STREAM_FAILED };
      }
      return {
        code: known.code,
        message: errorStatus(known.code) < 500 ? known.detail : STREAM_FAILED,
      };
    };
    switch (request.kind) {
      case "exec":
      case "shell": {
        const argv = request.kind === "exec"
          ? request.argv
          : [...this.#s.shell, request.script];
        const options = request.options ?? {};
        // Registered as the ticket is redeemed: destroy() or a new holder
        // of the workspace lease stops it, even before it starts.
        const operation = this.#begin(
          options.lease,
          options.mutates !== false,
        );
        try {
          await this.ready();
        } catch (error) {
          this.#end(operation);
          throw error;
        }
        // With bodyStdin the request body is stdin, streamed and capped.
        const over = new AbortController();
        const stdin = request.bodyStdin
          ? capped(
            body ?? new ReadableStream({ start: (c) => c.close() }),
            this.#s.maxStdinBytes,
            () =>
              over.abort(
                new SandboxError(
                  "too_large",
                  `stdin is more than ${this.#s.maxStdinBytes} bytes`,
                ),
              ),
          )
          : undefined;
        return new Response(
          eventStream(
            (emit, signal) =>
              this.#exec(argv, options as schema.ExecOptionsValue, {
                emit,
                signal: anySignal([signal, over.signal, requestSignal]),
                ...(stdin === undefined ? {} : { stdinStream: stdin }),
                operation,
              }).then(() => {}),
            failure,
            // A reader that takes nothing for the command's whole deadline
            // is gone; the command is killed at that deadline anyway.
            { stallMs: this.#timeout(options.timeoutMs) },
          ),
          { headers: SSE_HEADERS },
        );
      }
      case "logs": {
        this.#record(request.processId);
        return new Response(
          eventStream(
            (emit, signal) =>
              this.#controller.busy(() =>
                this.#followLogs(
                  request.processId,
                  request.fromStart ?? true,
                  emit as (event: SandboxEvent) => Promise<void>,
                  anySignal([signal, requestSignal])!,
                )
              ),
            failure,
            { stallMs: this.#s.execTimeoutMs },
          ),
          { headers: SSE_HEADERS },
        );
      }
      case "read":
        return await this.#readStream(request.path, requestSignal);
      case "write":
        return await this.#writeStream(
          request.path,
          request.options ?? {},
          body,
          this.#begin(request.options?.lease, true),
          requestSignal,
        );
    }
  }

  // The file's bytes as they are read, announced with the size of the file
  // READSTREAM opened (its first stderr line): the header describes the
  // bytes sent, not an earlier look at the path. A path that is missing, a
  // directory, not regular or outside the workspace fails here, before any
  // response exists.
  async #readStream(
    path: string,
    requestSignal?: AbortSignal,
  ): Promise<Response> {
    const target = workspacePath(this.#s.workspace, path);
    const max = this.#s.maxStreamFileBytes;
    await this.ready();
    requestSignal?.throwIfAborted();
    let announce!: (size: number) => void;
    let fail!: (error: unknown) => void;
    const size = new Promise<number>((resolve, reject) => {
      announce = resolve;
      fail = reject;
    });
    let line = "";
    const errors = new TextDecoder();
    // Nothing is collected: each chunk goes from the command's stdout to
    // the reader's queue (at most READ_QUEUE bytes), and waits there.
    const body = boundedStream(
      (push, signal) =>
        this.#controller.busy(async () => {
          try {
            await this.#script(READSTREAM, [
              this.#s.workspace,
              target.absolute,
              String(max),
            ], {
              maxOutputBytes: max,
              collect: false,
              signal: anySignal([signal, requestSignal]),
              onChunk: async (stream, bytes) => {
                if (stream === "stdout") {
                  await push(bytes);
                  return;
                }
                if (line.endsWith("\n")) return;
                line += errors.decode(bytes, { stream: true });
                const end = line.indexOf("\n");
                if (end < 0) return;
                // Anything else is an error message; the exit status
                // says which error.
                const found = /^\d{1,15}$/.exec(line.slice(0, end));
                if (found !== null) announce(Number(found[0]));
                line = line.slice(0, end + 1);
              },
            });
          } catch (error) {
            // A directory is "not a regular file" here, as it always was.
            fail(
              SandboxError.from(error)?.code === "is_directory"
                ? new SandboxError(
                  "not_regular",
                  `${target.relative} is not a regular file`,
                )
                : error,
            );
            throw error;
          }
          fail(new SandboxError("command_failed", "no file size"));
        }),
      { highWaterMark: READ_QUEUE, stallMs: this.#s.maxExecTimeoutMs },
    );
    let bytes: number;
    try {
      bytes = await size;
    } catch (error) {
      await body.cancel(error).catch(() => {});
      throw error;
    }
    return new Response(body, {
      headers: {
        "content-type": "application/octet-stream",
        "x-celld-sandbox-size": String(bytes),
      },
    });
  }

  // Registered until the upload helper, input cancellation and temporary-file
  // cleanup finish; the lease cannot move to another writer before that.
  async #writeStream(
    path: string,
    options: { createParents?: boolean; mode?: string },
    body: ReadableStream<Uint8Array> | null,
    operation: InFlight,
    requestSignal?: AbortSignal,
  ): Promise<Response> {
    let raw: RawResult;
    try {
      const target = workspaceEntry(this.#s.workspace, path);
      await this.ready();
      raw = await this.#controller.busy(() => {
        operation.stop.signal.throwIfAborted();
        return this.#script(WRITE, [
          this.#s.workspace,
          target.absolute,
          options.createParents === false ? "0" : "1",
          options.mode ?? "-",
          String(this.#s.maxStreamFileBytes),
        ], {
          stdin: body ?? new Uint8Array(),
          signal: anySignal([operation.stop.signal, requestSignal]),
        });
      });
      operation.stop.signal.throwIfAborted();
    } finally {
      if (body !== null && !body.locked) body.cancel().catch(() => {});
      this.#end(operation);
    }
    const target = workspaceEntry(this.#s.workspace, path);
    // WRITE reports what it wrote; a later look at the path could see
    // another writer's file.
    const size = Number(decode(raw.stdout).trim());
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new SandboxError("command_failed", "the write reported no size");
    }
    return Response.json({ path: target.relative, size });
  }
}

/**
 * Bytes of a whole stream, for tests and small bodies, up to `maxBytes`
 * (default {@link READ_ALL_MAX_BYTES}, 16 MiB). Past the cap the stream is
 * cancelled and it throws a `BoundsError` (`too_large`, a `RangeError`).
 */
export async function readAll(
  stream: ReadableStream<Uint8Array>,
  options: { readonly maxBytes?: number } = {},
): Promise<Uint8Array> {
  return await readBounded(stream, {
    maxBytes: options.maxBytes ?? READ_ALL_MAX_BYTES,
  });
}
